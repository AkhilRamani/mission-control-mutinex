import { and, eq, exists, inArray, sql } from 'drizzle-orm';

import type { Database, Transaction } from '../../db/client.js';
import { assignments, crew, missions, positions, positionSkills, skills } from '../../db/schema.js';
import type { Identity } from '../auth.js';
import { AppError, forbidden, notFound } from '../errors.js';
import { missionPhase } from '../time.js';

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

export function missionSummary(user: Identity, mission: Mission, now = new Date()) {
  const { ownerId, ...publicFields } = mission;
  return { ...publicFields, phase: missionPhase(mission, now), ...(user.role === 'crew' ? {} : { ownerId }) };
}

export async function readMissionView(tx: Transaction, user: Identity, mission: Mission) {
  const visiblePositions = await readPositions(tx, user, mission.id);
  const attempts = await readAssignments(tx, user, mission.id);
  return { ...missionSummary(user, mission), positions: visiblePositions, assignments: attempts };
}
