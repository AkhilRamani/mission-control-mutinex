import { and, eq, exists, inArray, sql } from 'drizzle-orm';
import type { Database, Transaction } from '../../db/client.js';
import { assignments, crew, missionEvents, missions, positions, positionSkills, skills } from '../../db/schema.js';
import type { Identity } from '../auth.js';
import { AppError, forbidden, notFound } from '../errors.js';

export const currentStates = ['proposed', 'accepted', 'confirmed'] as const;
export const missionFields = {
  id: missions.id, ownerId: missions.ownerId, title: missions.title, brief: missions.brief,
  start: missions.start, end: missions.end, state: missions.state, version: missions.version, createdAt: missions.createdAt,
};
export const assignmentFields = {
  id: assignments.id, missionId: assignments.missionId, positionId: assignments.positionId,
  crewId: assignments.crewId, state: assignments.state, respondedAt: assignments.respondedAt,
  bookedStart: assignments.bookedStart, bookedEnd: assignments.bookedEnd,
};
export const positionFields = { id: positions.id, ordinal: positions.ordinal, label: positions.label, removedAt: positions.removedAt };
export type Mission = Omit<typeof missions.$inferSelect, 'tenantId'>;
export type Assignment = Omit<typeof assignments.$inferSelect, 'tenantId'>;
export type Position = Awaited<ReturnType<typeof readPositions>>[number];
export const whereMission = (user: Identity, id: string) => and(eq(missions.tenantId, user.tenantId), eq(missions.id, id));
export const wherePosition = (user: Identity, missionId: string, id: string) =>
  and(eq(positions.tenantId, user.tenantId), eq(positions.missionId, missionId), eq(positions.id, id));
export const whereAssignment = (user: Identity, missionId: string, id: string) =>
  and(eq(assignments.tenantId, user.tenantId), eq(assignments.missionId, missionId), eq(assignments.id, id));

// Every attempt, including terminal ones, grants only its owner the restricted mission view.
export function visibleMission(db: Database | Transaction, user: Identity) {
  return and(eq(missions.tenantId, user.tenantId), user.role === 'crew' ? exists(
    db.select({ id: assignments.id }).from(assignments)
      .innerJoin(crew, and(eq(crew.tenantId, assignments.tenantId), eq(crew.id, assignments.crewId)))
      .where(and(eq(assignments.tenantId, user.tenantId), eq(assignments.missionId, missions.id), eq(crew.userId, user.id))),
  ) : undefined);
}
export async function findMission(db: Database | Transaction, user: Identity, id: string, lock = false) {
  const query = db.select(missionFields).from(missions).where(and(visibleMission(db, user), eq(missions.id, id)));
  const [mission] = await (lock ? query.for('update', { of: missions }) : query);
  if (!mission) throw notFound();
  return mission;
}
export function checkVersion(mission: Mission, version: number) {
  if (version !== mission.version) throw new AppError(409, 'STALE_VERSION', 'The mission has changed.',
    'Run mc missions show, review the plan and retry with its version.');
}
export function checkDraft(mission: Mission) {
  if (mission.state !== 'draft') throw new AppError(409, 'MISSION_FROZEN', 'Only draft missions can be edited.',
    'Withdraw a submitted plan; approved plans require cancellation and replacement.');
}
export function requirePlanner(user: Identity, mission: Mission) {
  if (user.role === 'crew' || (user.role !== 'director' && user.id !== mission.ownerId)) throw forbidden();
}
export function checkEdit(user: Identity, mission: Mission, version: number) {
  requirePlanner(user, mission);
  checkVersion(mission, version);
  checkDraft(mission);
}
export async function checkTimeline(tx: Transaction, start: Date, end: Date) {
  if (!(start < end)) throw new AppError(400, 'INVALID_INTERVAL', 'Mission end must be after start.',
    'Provide a positive interval using timestamps with timezone offsets.');
  const result = await tx.execute<{ future: boolean }>(sql`SELECT ${start.toISOString()}::timestamptz > clock_timestamp() AS future`);
  if (!result.rows[0]!.future) throw new AppError(409, 'START_NOT_FUTURE', 'The mission must start in the future.',
    'Choose a future start and end; reschedule elapsed drafts before staffing.');
}
export async function readPositions(tx: Transaction, user: Identity, missionId: string) {
  const ownPosition = user.role === 'crew' ? exists(tx.select({ id: assignments.id }).from(assignments)
    .innerJoin(crew, and(eq(crew.tenantId, assignments.tenantId), eq(crew.id, assignments.crewId)))
    .where(and(eq(assignments.tenantId, user.tenantId), eq(assignments.missionId, missionId),
      eq(assignments.positionId, positions.id), eq(crew.userId, user.id)))) : undefined;
  const rows = await tx.select(positionFields)
    .from(positions).where(and(eq(positions.tenantId, user.tenantId), eq(positions.missionId, missionId), ownPosition)).orderBy(positions.ordinal);
  const requirements = await tx.select({ positionId: positionSkills.positionId, skillId: skills.id,
    name: skills.name, minProficiency: positionSkills.minProficiency }).from(positionSkills)
    .innerJoin(skills, and(eq(skills.tenantId, positionSkills.tenantId), eq(skills.id, positionSkills.skillId)))
    .where(and(eq(positionSkills.tenantId, user.tenantId), eq(positionSkills.missionId, missionId),
      user.role === 'crew' ? inArray(positionSkills.positionId, rows.map((p) => p.id)) : undefined)).orderBy(skills.id);
  const grouped = new Map<string, Omit<(typeof requirements)[number], 'positionId'>[]>();
  for (const { positionId, ...requirement } of requirements) {
    const group = grouped.get(positionId) ?? [];
    group.push(requirement);
    grouped.set(positionId, group);
  }
  return rows.map((position) => ({ ...position, requirements: grouped.get(position.id) ?? [] }));
}
export async function readAssignments(tx: Transaction, user: Identity, missionId: string) {
  return tx.select(assignmentFields).from(assignments)
    .innerJoin(crew, and(eq(crew.tenantId, assignments.tenantId), eq(crew.id, assignments.crewId)))
    .where(and(eq(assignments.tenantId, user.tenantId), eq(assignments.missionId, missionId),
      user.role === 'crew' ? eq(crew.userId, user.id) : undefined)).orderBy(assignments.id);
}
export function missionSummary(user: Identity, mission: Mission) {
  const { ownerId, ...publicFields } = mission;
  return { ...publicFields, ...(user.role === 'crew' ? {} : { ownerId }) };
}
export async function readMissionView(tx: Transaction, user: Identity, mission: Mission) {
  const visiblePositions = await readPositions(tx, user, mission.id);
  const attempts = await readAssignments(tx, user, mission.id);
  return { ...missionSummary(user, mission), positions: visiblePositions, assignments: attempts };
}
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
type Event = (
  | { kind: 'mission_created'; payload: { plan: PlanSnapshot } }
  | { kind: 'mission_updated'; payload: { before: PlanSnapshot; after: PlanSnapshot } }
  | { kind: 'position_added'; payload: { position: PositionSnapshot } }
  | { kind: 'position_updated' | 'position_removed'; payload: { before: PositionSnapshot; after: PositionSnapshot } }
  | { kind: 'proposals_updated'; payload: { assignmentChanges?: AssignmentChange[] } }
  | { kind: 'assignment_responded'; payload: { action: 'accept' | 'decline' | 'retract' } }
) & { payload: { assignmentChanges?: AssignmentChange[] } };
type PlanPatch = Partial<Pick<Mission, 'title' | 'brief' | 'start' | 'end'>>;

export async function recordEvent(tx: Transaction, user: Identity, id: string, version: number, event: Event) {
  await tx.insert(missionEvents).values({ tenantId: user.tenantId, missionId: id, missionVersion: version, actorId: user.id, ...event });
}
// Mission lock is held by the caller. One version and event cover the whole operation.
export async function recordChange(tx: Transaction, user: Identity, mission: Mission, event: Event, plan: PlanPatch = {}) {
  const [updated] = await tx.update(missions).set({ ...plan, version: mission.version + 1 })
    .where(whereMission(user, mission.id)).returning(missionFields);
  await recordEvent(tx, user, mission.id, updated!.version, event);
  return updated!;
}

// Draft edits and proposals return a full view. A response records its event directly.
export async function finishChange(tx: Transaction, user: Identity, mission: Mission, event: Event,
  options: { plan?: PlanPatch; assignments?: ChangedAssignments } = {}) {
  const visiblePositions = await readPositions(tx, user, mission.id);
  const changes = options.assignments;
  if (changes?.after.length) {
    // Position edits already happened in this transaction; merge the pending plan for after-snapshots.
    event.payload.assignmentChanges = changes.after.map((a): AssignmentChange => ({
      before: changes.before.find((b) => b.id === a.id) ?? null,
      after: assignmentSnapshot({ ...mission, ...options.plan }, visiblePositions.find((p) => p.id === a.positionId)!, a),
    }));
  }
  const updated = await recordChange(tx, user, mission, event, options.plan);
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
