import { and, eq, inArray, sql } from 'drizzle-orm';

import type { Database, Transaction } from '../../db/client.js';
import { assignments, crew, missions, positions, users } from '../../db/schema.js';
import type { Identity } from '../auth.js';
import { findCrew } from '../crew.js';
import { AppError, forbidden, notFound } from '../errors.js';
import { page } from '../pagination.js';
import type { PageInput } from '../pagination.js';
import { missionPhase } from '../time.js';
import { checkEligibility, loadCandidates, lockCrew } from './matching.js';
import {
  assignmentFields, currentStates, whereAssignment, checkDraft, checkEdit, checkTimeline, checkVersion,
  requirePlanner, findMission, readAssignments, readPositions, readMissionView,
} from './shared.js';
import { assignmentSnapshot, finishChange, recordChange } from './changes.js';
import type { Assignment } from './shared.js';

export type Proposal = { positionId: string; crewId: string };

export async function listAssignments(db: Database, user: Identity, input: PageInput & { mine?: boolean | undefined }) {
  return assignmentPage(db, user, input, input.mine ?? false);
}

export async function getAssignment(db: Database, user: Identity, id: string) {
  return db.transaction(async (tx) => {
    const { userId: _, ...assignment } = await findAssignment(tx, user, id);
    const mission = await findMission(tx, user, assignment.missionId);

    const position = (await readPositions(tx, user, mission.id)).find((p) => p.id === assignment.positionId)!;
    return { ...assignment, version: mission.version, mission: {
      id: mission.id, title: mission.title, brief: mission.brief, start: mission.start, end: mission.end, state: mission.state, phase: missionPhase(mission),
    }, position };
  }, { isolationLevel: 'repeatable read', accessMode: 'read only' });
}

export async function crewHistory(db: Database, user: Identity, id: string, input: PageInput) {
  return db.transaction(async (tx) => {
    const profile = await findCrew(tx, user, id);
    return { crewId: profile.id, ...await assignmentPage(tx, user, input, false, profile.id) };
  }, { isolationLevel: 'repeatable read', accessMode: 'read only' });
}

// PUT replaces the current roster with these explicit pairs, including an intentionally partial roster.
export async function proposeCrew(db: Database, user: Identity, id: string, version: number, proposals: Proposal[]) {
  return db.transaction(async (tx) => {
    const mission = await findMission(tx, user, id, true);
    requirePlanner(user, mission);

    const allPositions = await readPositions(tx, user, id);
    if (proposals.some((p) => !allPositions.some((position) => position.id === p.positionId))) throw notFound();

    await lockCrew(tx, user, proposals.map((p) => p.crewId));

    checkEdit(user, mission, version);
    await checkTimeline(tx, mission.start, mission.end);

    const candidates = await loadCandidates(tx, user, mission, proposals.map((p) => p.crewId));
    for (const p of proposals) {
      const position = allPositions.find((position) => position.id === p.positionId)!;
      if (position.removedAt) throw new AppError(409, 'POSITION_REMOVED', 'This position was removed.', 'Use current positions from mc missions show.');
      checkEligibility(candidates.find((c) => c.crewId === p.crewId)!, position);
    }

    const current = (await readAssignments(tx, user, id)).filter((a) => currentStates.some((state) => state === a.state));
    const replaced = current.filter((a) => !proposals.some((p) => p.positionId === a.positionId && p.crewId === a.crewId));
    const added = proposals.filter((p) => !current.some((a) => a.positionId === p.positionId && a.crewId === p.crewId));
    if (!replaced.length && !added.length) return readMissionView(tx, user, mission);

    // Withdraw all replacements first so both unique indexes allow roster swaps.
    const after: Assignment[] = [];
    if (replaced.length) after.push(...await tx.update(assignments).set({ state: 'withdrawn' })
      .where(and(eq(assignments.tenantId, user.tenantId), eq(assignments.missionId, id), inArray(assignments.id, replaced.map((a) => a.id))))
      .returning(assignmentFields));
    if (added.length) after.push(...await tx.insert(assignments).values(added.map((p) => ({ ...p, tenantId: user.tenantId, missionId: id })))
      .returning(assignmentFields));

    return finishChange(tx, user, mission, { kind: 'proposals_updated', payload: {} }, {
      assignments: {
        before: replaced.map((a) => assignmentSnapshot(mission, allPositions.find((p) => p.id === a.positionId)!, a)), after,
      },
    });
  });
}

export async function removeProposal(db: Database, user: Identity, id: string, assignmentId: string, version: number) {
  return db.transaction(async (tx) => {
    const mission = await findMission(tx, user, id, true);
    const assignment = await findAssignment(tx, user, assignmentId);
    if (assignment.missionId !== id) throw notFound();

    checkEdit(user, mission, version);
    if (!['proposed', 'accepted'].includes(assignment.state)) throw finalAssignment();

    const position = (await readPositions(tx, user, id)).find((p) => p.id === assignment.positionId)!;

    const [after] = await tx.update(assignments).set({ state: 'withdrawn' }).where(whereAssignment(user, id, assignmentId)).returning(assignmentFields);

    return finishChange(tx, user, mission, { kind: 'proposals_updated', payload: {} }, {
      assignments: { before: [assignmentSnapshot(mission, position, assignment)], after: [after!] },
    });
  });
}

// Find visibility before taking the mission lock; re-read after it for stale/concurrent responses.
export async function respondToAssignment(db: Database, user: Identity, id: string, version: number, action: 'accept' | 'decline' | 'retract') {
  return db.transaction(async (tx) => {
    const visible = await findAssignment(tx, user, id);
    const mission = await findMission(tx, user, visible.missionId, true);
    const assignment = await findAssignment(tx, user, id);
    if (assignment.userId !== user.id) throw forbidden();

    checkVersion(mission, version);
    checkDraft(mission);
    if (assignment.state !== (action === 'retract' ? 'accepted' : 'proposed')) throw finalAssignment();

    const position = (await readPositions(tx, user, mission.id)).find((p) => p.id === assignment.positionId)!;
    if (action === 'accept') {
      await lockCrew(tx, user, [assignment.crewId]);
      await checkTimeline(tx, mission.start, mission.end);
      const [candidate] = await loadCandidates(tx, user, mission, [assignment.crewId]);
      checkEligibility(candidate!, position);
    }

    const [after] = await tx.update(assignments).set({
      state: action === 'accept' ? 'accepted' : action === 'decline' ? 'declined' : 'proposed',
      respondedAt: action === 'retract' ? null : sql`clock_timestamp()`,
    }).where(whereAssignment(user, mission.id, id)).returning(assignmentFields);

    const updated = await recordChange(tx, user, mission, {
      kind: 'assignment_responded',
      payload: { action, assignmentChanges: [{
        before: assignmentSnapshot(mission, position, assignment), after: assignmentSnapshot(mission, position, after!),
      }] },
    });

    return { ...after!, version: updated.version };
  });
}

// Private validation and scoped reads
function finalAssignment() {
  return new AppError(409, 'ASSIGNMENT_STATE', 'This assignment cannot make that transition.',
    'Refresh assignments and mission version. Declined or withdrawn attempts need a new proposal; submitted plans must be withdrawn first.');
}

function visibleAssignments(user: Identity, mine: boolean) {
  return and(eq(assignments.tenantId, user.tenantId), user.role === 'crew' || mine ? eq(crew.userId, user.id) : undefined);
}

async function findAssignment(db: Database | Transaction, user: Identity, id: string) {
  const [assignment] = await db.select({ ...assignmentFields, userId: crew.userId }).from(assignments)
    .innerJoin(crew, and(eq(crew.tenantId, assignments.tenantId), eq(crew.id, assignments.crewId)))
    .where(and(visibleAssignments(user, false), eq(assignments.id, id)));
  if (!assignment) throw notFound();
  return assignment;
}

async function assignmentPage(db: Database | Transaction, user: Identity, input: PageInput, mine: boolean, crewId?: string) {
  const rows = await db.select({ ...assignmentFields, version: missions.version, title: missions.title,
    start: missions.start, end: missions.end, missionState: missions.state, label: positions.label, displayName: users.displayName,
  }).from(assignments)
    .innerJoin(crew, and(eq(crew.tenantId, assignments.tenantId), eq(crew.id, assignments.crewId)))
    .innerJoin(users, and(eq(users.tenantId, crew.tenantId), eq(users.id, crew.userId)))
    .innerJoin(missions, and(eq(missions.tenantId, assignments.tenantId), eq(missions.id, assignments.missionId)))
    .innerJoin(positions, and(eq(positions.tenantId, assignments.tenantId), eq(positions.missionId, assignments.missionId), eq(positions.id, assignments.positionId)))
    .where(and(visibleAssignments(user, mine), crewId ? eq(assignments.crewId, crewId) : undefined))
    .orderBy(missions.createdAt, missions.id, positions.ordinal, assignments.id).limit(input.limit + 1).offset(input.offset);

  const now = new Date();
  return page(rows.map((row) => ({ ...row, phase: missionPhase({ ...row, state: row.missionState }, now) })), input);
}
