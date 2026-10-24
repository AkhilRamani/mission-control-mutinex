import { eq } from 'drizzle-orm';

import type { Transaction } from './client.js';
import { assignments, availability, crew, crewSkills, missionEvents, missions, positions, positionSkills, users } from './schema.js';
import { hashPassword } from '../domain/password.js';
import { assignmentSnapshot, planSnapshot, positionSnapshot } from '../domain/missions/changes.js';
import type { Assignment, Position } from '../domain/missions/shared.js';
import type { AssignmentSnapshot, MissionEvent } from '../domain/missions/changes.js';

const day = 86_400_000;

// Stable resource IDs; times are relative to the UTC date supplied to seedDatabase.
const id = (org: 1 | 2, group: number, n: number) => `${org}0000000-0000-4000-800${group}-${String(n).padStart(12, '0')}`;

type Outcome = 'draft' | 'submitted' | 'approved' | 'completed' | 'cancelled' | 'rejected';
type DemoMission = {
  org: 1 | 2; number: number; title: string; days: number; outcome: Outcome;
  hours?: [number, number]; expert?: boolean; pilotOnly?: boolean; crew?: (number | null)[]; responses?: ('accepted' | 'declined' | null)[];
};

export async function seedMissions(tx: Transaction, now: Date, password: string) {
  const anchor = new Date(now);
  anchor.setUTCHours(0, 0, 0, 0);
  const window = { start: new Date(+anchor - 7 * day), end: new Date(+anchor + 35 * day) };
  await tx.update(availability).set(window);

  // Jules is available but underqualified; Lee is qualified but has no availability.
  for (const [n, username, displayName, level] of [[6, 'jules', 'Jules', 1], [7, 'lee', 'Lee', 4]] as const) {
    await tx.insert(users).values({ id: id(1, 1, n), tenantId: id(1, 0, 1), username, displayName,
      role: 'crew', passwordHash: await hashPassword(password) });
    await tx.insert(crew).values({ id: id(1, 3, n), tenantId: id(1, 0, 1), userId: id(1, 1, n), biography: 'Demo crew profile.' });
    await tx.insert(crewSkills).values({ tenantId: id(1, 0, 1), crewId: id(1, 3, n), skillId: id(1, 2, 1), proficiency: level });
    if (username === 'jules') await tx.insert(availability).values({ id: id(1, 4, n), tenantId: id(1, 0, 1), crewId: id(1, 3, n), ...window });
  }

  const examples: DemoMission[] = [
    { org: 1, number: 1, title: 'Supply flight', days: 4, outcome: 'draft', crew: [] },
    { org: 1, number: 2, title: 'Awaiting review', days: 2, outcome: 'submitted' },
    { org: 1, number: 3, title: 'Scheduled supply flight', days: 2, outcome: 'approved' },
    { org: 1, number: 4, title: 'Active patrol', days: 0, hours: [0, 24], outcome: 'approved' },
    { org: 1, number: 5, title: 'Awaiting completion', days: -1, outcome: 'approved' },
    { org: 1, number: 6, title: 'Completed training', days: -3, outcome: 'completed', pilotOnly: true, crew: [5] },
    { org: 1, number: 7, title: 'Cancelled survey', days: -2, outcome: 'cancelled' },
    { org: 1, number: 8, title: 'Consent pending', days: 5, outcome: 'draft', responses: ['accepted', null] },
    { org: 1, number: 9, title: 'Declined survey', days: 6, outcome: 'draft', responses: ['declined', null] },
    { org: 1, number: 10, title: 'Partial rescue', days: 7, outcome: 'draft', expert: true, crew: [5, null], responses: ['accepted', null] },
    { org: 1, number: 11, title: 'Rejected plan', days: 8, outcome: 'rejected' },
    { org: 1, number: 12, title: 'Adjacent return flight', days: 2, hours: [17, 21], outcome: 'approved', pilotOnly: true, crew: [5] },
    { org: 2, number: 1, title: 'Supply flight', days: 4, outcome: 'draft' },
    { org: 2, number: 2, title: 'Awaiting review', days: 2, outcome: 'submitted' },
  ];
  for (const example of examples) await seedMission(tx, anchor, example);
}

// Historical fixtures are inserted directly: the live API correctly refuses past approvals.
// Each example records the same plan/consent snapshots and contiguous versions as live operations.
async function seedMission(tx: Transaction, anchor: Date, spec: DemoMission) {
  const tenantId = id(spec.org, 0, 1), ownerId = id(spec.org, 1, spec.org === 1 ? 3 : 2);
  const [startHour, endHour] = spec.hours ?? [9, 17];
  const start = new Date(+anchor + spec.days * day + startHour * 3_600_000);
  const end = new Date(+anchor + spec.days * day + endHour * 3_600_000);
  let eventTime = Math.min(+anchor, +start) - day;

  const [row] = await tx.insert(missions).values({ id: id(spec.org, 5, spec.number), tenantId, ownerId,
    title: spec.title, brief: 'Seeded demonstration. Review the plan and history before making changes.', start, end,
    createdAt: new Date(eventTime) }).returning();
  const mission = row!;
  let version = 0;
  const slots: Position[] = [];
  let roster: Assignment[] = [];

  async function event(kind: MissionEvent['kind'], payload: Record<string, unknown>, actorId = ownerId) {
    await tx.insert(missionEvents).values({ id: id(spec.org, 8, spec.number * 100 + ++version),
      tenantId, missionId: mission.id, missionVersion: version, actorId, kind, payload, occurredAt: new Date(eventTime++) });
  }

  const snapshots = () => roster.map((a) => assignmentSnapshot(mission, slots.find((p) => p.id === a.positionId)!, a));
  const changes = (before: AssignmentSnapshot[]) => ({ assignmentChanges: snapshots().map((after) => ({
    before: before.find((a) => a.id === after.id) ?? null, after,
  })) });

  await event('mission_created', { plan: planSnapshot(mission) });
  const labels = spec.org === 2 ? ['Field pilot'] : spec.pilotOnly ? ['Pilot'] : ['Pilot', spec.expert ? 'Expert medic' : 'Medic'];
  for (const [i, label] of labels.entries()) {
    const [slot] = await tx.insert(positions).values({ id: id(spec.org, 6, spec.number * 10 + i), tenantId,
      missionId: mission.id, ordinal: i + 1, label }).returning();
    const skillNumbers = spec.org === 2 ? [1, 2] : [i + 1];
    const requirements = skillNumbers.map((n) => ({ skillId: id(spec.org, 2, n),
      name: n === 1 ? 'piloting' : spec.org === 1 ? 'medical' : 'survival', minProficiency: spec.expert && n === 2 ? 5 : 3 }));
    await tx.insert(positionSkills).values(requirements.map(({ skillId, minProficiency }) => ({
      tenantId, missionId: mission.id, positionId: slot!.id, skillId, minProficiency,
    })));
    slots.push({ id: slot!.id, ordinal: slot!.ordinal, label, removedAt: null, requirements });
    await event('position_added', { position: positionSnapshot(slots.at(-1)!) });
  }

  const crewNumbers = spec.crew ?? (spec.org === 1 ? [5, 4] : [3]);

  for (const [i, slot] of slots.entries()) {
    const crewNumber = crewNumbers[i];
    if (!crewNumber) continue;
    const [attempt] = await tx.insert(assignments).values({ id: id(spec.org, 7, spec.number * 10 + i),
      tenantId, missionId: mission.id, positionId: slot.id, crewId: id(spec.org, 3, crewNumber) }).returning();
    roster.push(attempt!);
  }

  if (roster.length) await event('proposals_updated', changes([]));

  for (const [i, slot] of slots.entries()) {
    const response = spec.responses?.[i] ?? (spec.outcome === 'draft' ? null : 'accepted');
    const attempt = roster.find((a) => a.positionId === slot.id);
    if (!response || !attempt) continue;
    const before = snapshots();
    const [updated] = await tx.update(assignments).set({ state: response, respondedAt: new Date(eventTime) })
      .where(eq(assignments.id, attempt.id)).returning();
    roster = roster.map((a) => a.id === attempt.id ? updated! : a);
    // An individual response event contains only the responding assignment.
    await event('assignment_responded', { action: response === 'accepted' ? 'accept' : 'decline',
      assignmentChanges: changes(before).assignmentChanges.filter((c) => c.after.id === attempt.id) }, id(spec.org, 1, crewNumbers[i]!));
  }

  if (spec.outcome !== 'draft') {
    mission.state = 'submitted';
    await event('mission_submitted', changes(snapshots()));
  }

  if (['approved', 'completed', 'cancelled'].includes(spec.outcome)) {
    const before = snapshots();
    roster = await tx.update(assignments).set({ state: 'confirmed', bookedStart: start, bookedEnd: end })
      .where(eq(assignments.missionId, mission.id)).returning();
    mission.state = 'approved';
    await event('mission_approved', changes(before), id(spec.org, 1, 1));
  }

  if (spec.outcome === 'rejected' || spec.outcome === 'cancelled') {
    const before = snapshots(), cancelled = spec.outcome === 'cancelled';
    roster = await tx.update(assignments).set(cancelled ? { state: 'released', bookedStart: null, bookedEnd: null }
      : { state: 'proposed', respondedAt: null }).where(eq(assignments.missionId, mission.id)).returning();
    mission.state = cancelled ? 'cancelled' : 'draft';
    if (cancelled) eventTime = +end + 60_000; // Demonstrate late cancellation and full booking release.
    await event(cancelled ? 'mission_cancelled' : 'mission_rejected', {
      reason: cancelled ? 'Survey aborted; recorded after its scheduled end.' : 'Revise the plan and obtain fresh consent.', ...changes(before),
    }, id(spec.org, 1, 1));
  }

  if (spec.outcome === 'completed') {
    mission.state = 'completed';
    eventTime = +end + 60_000;
    await event('mission_completed', changes(snapshots()));
  }

  await tx.update(missions).set({ state: mission.state, version }).where(eq(missions.id, mission.id));
}
