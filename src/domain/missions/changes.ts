import { and, eq, inArray } from 'drizzle-orm';
import type { Transaction } from '../../db/client.js';
import { assignments, missionEvents, missions } from '../../db/schema.js';
import type { Identity } from '../auth.js';
import { assignmentFields, missionFields, missionSummary, readAssignments, readPositions, whereMission } from './shared.js';
import type { Assignment, Mission, Position } from './shared.js';

// Snapshots, consent invalidation and event writes share the caller's mission transaction.
export function planSnapshot(plan: Pick<Mission, 'title' | 'brief' | 'start' | 'end'>) {
  return { title: plan.title, brief: plan.brief, start: plan.start.toISOString(), end: plan.end.toISOString() };
}
export function positionSnapshot(position: Position) {
  return { ...position, removedAt: position.removedAt?.toISOString() ?? null };
}
export function assignmentSnapshot(mission: Mission, position: Position, assignment: Assignment) {
  return { id: assignment.id, missionId: assignment.missionId, positionId: assignment.positionId,
    crewId: assignment.crewId, state: assignment.state, respondedAt: assignment.respondedAt?.toISOString() ?? null,
    bookedStart: assignment.bookedStart?.toISOString() ?? null, bookedEnd: assignment.bookedEnd?.toISOString() ?? null,
    plan: { ...planSnapshot(mission), position: positionSnapshot(position) } };
}
export type AssignmentSnapshot = ReturnType<typeof assignmentSnapshot>;
export type AssignmentChange = { before: AssignmentSnapshot | null; after: AssignmentSnapshot };
export type ChangedAssignments = { before: AssignmentSnapshot[]; after: Assignment[] };
type PlanSnapshot = ReturnType<typeof planSnapshot>;
type PositionSnapshot = ReturnType<typeof positionSnapshot>;
export type MissionEvent = (
  | { kind: 'mission_created'; payload: { plan: PlanSnapshot } }
  | { kind: 'mission_updated'; payload: { before: PlanSnapshot; after: PlanSnapshot } }
  | { kind: 'position_added'; payload: { position: PositionSnapshot } }
  | { kind: 'position_updated' | 'position_removed'; payload: { before: PositionSnapshot; after: PositionSnapshot } }
  | { kind: 'proposals_updated' | 'mission_submitted' | 'mission_approved' | 'mission_completed' }
  | { kind: 'assignment_responded'; payload: { action: 'accept' | 'decline' | 'retract' } }
  | { kind: 'mission_withdrawn' | 'mission_rejected' | 'mission_cancelled'; payload: { reason: string } }
) & { payload: { assignmentChanges?: AssignmentChange[] } };
type MissionPatch = Partial<Pick<Mission, 'title' | 'brief' | 'start' | 'end' | 'state'>>;

export async function recordEvent(tx: Transaction, user: Identity, id: string, version: number, event: MissionEvent) {
  await tx.insert(missionEvents).values({ tenantId: user.tenantId, missionId: id, missionVersion: version, actorId: user.id, ...event });
}
// Mission lock is held by the caller. One version and event cover the whole operation.
export async function recordChange(tx: Transaction, user: Identity, mission: Mission, event: MissionEvent, patch: MissionPatch = {}) {
  const [updated] = await tx.update(missions).set({ ...patch, version: mission.version + 1 })
    .where(whereMission(user, mission.id)).returning(missionFields);
  await recordEvent(tx, user, mission.id, updated!.version, event);
  return updated!;
}

// Plan, roster and lifecycle changes return a full view. Consent responses record directly.
export async function finishChange(tx: Transaction, user: Identity, mission: Mission, event: MissionEvent,
  options: { patch?: MissionPatch; assignments?: ChangedAssignments } = {}) {
  const visiblePositions = await readPositions(tx, user, mission.id);
  const changes = options.assignments;
  if (changes?.after.length) {
    // Position edits already happened; merge the pending mission patch for after-snapshots.
    event.payload.assignmentChanges = changes.after.map((a): AssignmentChange => ({
      before: changes.before.find((b) => b.id === a.id) ?? null,
      after: assignmentSnapshot({ ...mission, ...options.patch }, visiblePositions.find((p) => p.id === a.positionId)!, a),
    }));
  }
  const updated = await recordChange(tx, user, mission, event, options.patch);
  return { ...missionSummary(user, updated), positions: visiblePositions, assignments: await readAssignments(tx, user, mission.id) };
}
// Keep proposed attempts in the event too: the plan they were offered has changed.
export async function resetConsent(tx: Transaction, user: Identity, mission: Mission, positionId?: string, withdraw = false): Promise<ChangedAssignments> {
  const rows = await tx.select(assignmentFields).from(assignments).where(and(eq(assignments.tenantId, user.tenantId),
    eq(assignments.missionId, mission.id), inArray(assignments.state, ['proposed', 'accepted']),
    positionId ? eq(assignments.positionId, positionId) : undefined));
  if (!rows.length) return { before: [], after: [] };
  const allPositions = await readPositions(tx, user, mission.id);
  const after = await tx.update(assignments).set(withdraw ? { state: 'withdrawn' } : { state: 'proposed', respondedAt: null })
    .where(and(eq(assignments.tenantId, user.tenantId), eq(assignments.missionId, mission.id), inArray(assignments.id, rows.map((a) => a.id))))
    .returning(assignmentFields);
  return { before: rows.map((a) => assignmentSnapshot(mission, allPositions.find((p) => p.id === a.positionId)!, a)), after };
}
