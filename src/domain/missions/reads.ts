import { and, eq, ilike, or, sql } from 'drizzle-orm';
import type { Database } from '../../db/client.js';
import { missionEvents, missions } from '../../db/schema.js';
import type { Identity } from '../auth.js';
import { findCrew } from '../crew.js';
import { page, searchPattern } from '../pagination.js';
import type { PageInput } from '../pagination.js';
import { findMission, missionFields, missionSummary, visibleMission, readMissionView } from './shared.js';
import type { AssignmentChange, AssignmentSnapshot, Mission } from './shared.js';

export async function getMission(db: Database, user: Identity, id: string) {
  return db.transaction(async (tx) => readMissionView(tx, user, await findMission(tx, user, id)),
    { isolationLevel: 'repeatable read', accessMode: 'read only' });
}
export async function listMissions(db: Database, user: Identity, input: PageInput & { state?: Mission['state'] | undefined }) {
  const pattern = input.q ? searchPattern(input.q) : undefined;
  const rows = await db.select(missionFields).from(missions).where(and(visibleMission(db, user),
    input.state ? eq(missions.state, input.state) : undefined,
    pattern ? or(ilike(missions.title, pattern), ilike(missions.brief, pattern)) : undefined,
  )).orderBy(missions.createdAt, missions.id).limit(input.limit + 1).offset(input.offset);
  const now = new Date();
  return page(rows.map((m) => missionSummary(user, m, now)), input);
}

// Explicitly rebuild own snapshots. Never expose raw event payloads to Crew.
function ownSnapshot(s: AssignmentSnapshot) {
  return { id: s.id, missionId: s.missionId, positionId: s.positionId, crewId: s.crewId, state: s.state,
    respondedAt: s.respondedAt, bookedStart: s.bookedStart, bookedEnd: s.bookedEnd,
    plan: { title: s.plan.title, brief: s.plan.brief, start: s.plan.start, end: s.plan.end,
      position: { id: s.plan.position.id, label: s.plan.position.label, ordinal: s.plan.position.ordinal,
        removedAt: s.plan.position.removedAt, requirements: s.plan.position.requirements.map((r) => ({
          skillId: r.skillId, name: r.name, minProficiency: r.minProficiency,
        })) } } };
}
export async function missionHistory(db: Database, user: Identity, id: string, input: PageInput) {
  return db.transaction(async (tx) => {
    const mission = await findMission(tx, user, id);
    const profile = user.role === 'crew' ? await findCrew(tx, user, 'me') : undefined;
    const rows = await tx.select({ id: missionEvents.id, missionVersion: missionEvents.missionVersion,
      actorId: missionEvents.actorId, kind: missionEvents.kind, occurredAt: missionEvents.occurredAt, payload: missionEvents.payload,
    }).from(missionEvents).where(and(eq(missionEvents.tenantId, user.tenantId), eq(missionEvents.missionId, id),
      profile ? sql`EXISTS (SELECT 1 FROM jsonb_array_elements(${missionEvents.payload}->'assignmentChanges') AS change
        WHERE change->'after'->>'crewId' = ${profile.id})` : undefined,
    )).orderBy(missionEvents.missionVersion).limit(input.limit + 1).offset(input.offset);
    const items = rows.map((event) => {
      if (!profile) return event;
      const changes = (event.payload.assignmentChanges as AssignmentChange[]).filter((c) => c.after.crewId === profile.id);
      return { id: event.id, missionVersion: event.missionVersion, kind: event.kind, occurredAt: event.occurredAt,
        payload: { assignmentChanges: changes.map((c) => ({
          before: c.before?.crewId === profile.id ? ownSnapshot(c.before) : null, after: ownSnapshot(c.after),
        })) } };
    });
    return { missionId: id, version: mission.version, ...page(items, input) };
  }, { isolationLevel: 'repeatable read', accessMode: 'read only' });
}
