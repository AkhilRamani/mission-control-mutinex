import { and, eq, ilike, inArray, or, sql } from 'drizzle-orm';
import type { Database, Transaction } from '../../db/client.js';
import { missionEvents, missions, positions, positionSkills, skills } from '../../db/schema.js';
import type { Identity } from '../auth.js';
import { AppError, forbidden, notFound } from '../errors.js';
import { page, searchPattern } from '../pagination.js';
import type { PageInput } from '../pagination.js';

type Mission = typeof missions.$inferSelect;
type MissionSummary = Omit<Mission, 'tenantId'>;
export type RequirementInput = { skillId: string; minProficiency: number };
export type PlanInput = { title: string; brief: string; start: Date; end: Date };
type PlanPatch = { [K in keyof PlanInput]?: PlanInput[K] | undefined };
type MissionListInput = PageInput & { state?: Mission['state'] | undefined };
type PositionInput = { label: string; requirements: RequirementInput[] };
type PositionPatch = { [K in keyof PositionInput]?: PositionInput[K] | undefined };

const missionFields = {
  id: missions.id, ownerId: missions.ownerId, title: missions.title, brief: missions.brief,
  start: missions.start, end: missions.end, state: missions.state,
  version: missions.version, createdAt: missions.createdAt,
};
const positionFields = { id: positions.id, ordinal: positions.ordinal, label: positions.label, removedAt: positions.removedAt };
const whereMission = (user: Identity, id: string) =>
  and(eq(missions.tenantId, user.tenantId), eq(missions.id, id));
const wherePosition = (user: Identity, missionId: string, id: string) =>
  and(eq(positions.tenantId, user.tenantId), eq(positions.missionId, missionId), eq(positions.id, id));

// Reads

export async function getMission(db: Database, user: Identity, id: string) {
  // Version, positions and requirements must describe the same snapshot.
  return db.transaction(async (tx) => {
    const mission = await findMission(tx, user, id);
    return withPositions(tx, user, mission);
  }, { isolationLevel: 'repeatable read', accessMode: 'read only' });
}

export async function listMissions(db: Database, user: Identity, input: MissionListInput) {
  if (user.role === 'crew') return page([], input);
  const pattern = input.q ? searchPattern(input.q) : undefined;
  const rows = await db.select(missionFields).from(missions)
    .where(and(
      eq(missions.tenantId, user.tenantId),
      input.state ? eq(missions.state, input.state) : undefined,
      pattern ? or(ilike(missions.title, pattern), ilike(missions.brief, pattern)) : undefined,
    ))
    .orderBy(missions.createdAt, missions.id).limit(input.limit + 1).offset(input.offset);
  return page(rows, input);
}

export async function missionHistory(db: Database, user: Identity, id: string, input: PageInput) {
  return db.transaction(async (tx) => {
    const mission = await findMission(tx, user, id);
    const rows = await tx.select({
      id: missionEvents.id, missionVersion: missionEvents.missionVersion, actorId: missionEvents.actorId,
      kind: missionEvents.kind, occurredAt: missionEvents.occurredAt, payload: missionEvents.payload,
    }).from(missionEvents)
      .where(and(eq(missionEvents.tenantId, user.tenantId), eq(missionEvents.missionId, id)))
      .orderBy(missionEvents.missionVersion).limit(input.limit + 1).offset(input.offset);
    return { missionId: id, version: mission.version, ...page(rows, input) };
  }, { isolationLevel: 'repeatable read', accessMode: 'read only' });
}

// Draft changes

export async function createMission(db: Database, user: Identity, input: PlanInput) {
  if (user.role === 'crew') throw forbidden();
  return db.transaction(async (tx) => {
    await checkTimeline(tx, input.start, input.end);
    const [mission] = await tx.insert(missions)
      .values({ ...input, tenantId: user.tenantId, ownerId: user.id }).returning(missionFields);
    await recordEvent(tx, user, mission!.id, 1, { kind: 'mission_created', payload: { plan: planSnapshot(input) } });
    return { ...mission!, positions: [] };
  });
}

export async function updateMission(db: Database, user: Identity, id: string, version: number, input: PlanPatch) {
  return db.transaction(async (tx) => {
    const mission = await findMission(tx, user, id, true);
    checkEdit(user, mission, version);

    const next = {
      title: input.title ?? mission.title, brief: input.brief ?? mission.brief,
      start: input.start ?? mission.start, end: input.end ?? mission.end,
    };
    const timeChanged = +next.start !== +mission.start || +next.end !== +mission.end;
    if (!timeChanged && next.title === mission.title && next.brief === mission.brief) {
      return withPositions(tx, user, mission);
    }
    if (timeChanged) await checkTimeline(tx, next.start, next.end);

    return finishChange(tx, user, mission, {
      kind: 'mission_updated', payload: { before: planSnapshot(mission), after: planSnapshot(next) },
    }, next);
  });
}

export async function addPosition(db: Database, user: Identity, id: string, version: number, input: PositionInput) {
  return db.transaction(async (tx) => {
    const mission = await findMission(tx, user, id, true);
    checkEdit(user, mission, version);

    const requirements = await resolveRequirements(tx, user, input.requirements);
    const [last] = await tx.select({ ordinal: sql<number>`coalesce(max(${positions.ordinal}), 0)` }).from(positions)
      .where(and(eq(positions.tenantId, user.tenantId), eq(positions.missionId, id)));
    const [position] = await tx.insert(positions).values({
      tenantId: user.tenantId, missionId: id, ordinal: last!.ordinal + 1, label: input.label,
    }).returning(positionFields);
    await writeRequirements(tx, user, id, position!.id, requirements);

    return finishChange(tx, user, mission, {
      kind: 'position_added', payload: { position: positionSnapshot({ ...position!, requirements }) },
    });
  });
}

export async function updatePosition(db: Database, user: Identity, id: string, positionId: string, version: number,
  input: PositionPatch) {
  return db.transaction(async (tx) => {
    const mission = await findMission(tx, user, id, true);
    const position = (await readPositions(tx, user, id)).find((p) => p.id === positionId);
    if (!position) throw notFound();
    checkEdit(user, mission, version);
    if (position.removedAt) {
      throw new AppError(409, 'POSITION_REMOVED', 'This position was removed.',
        'Add a new position using the current mission version.');
    }

    const requirements = input.requirements ? await resolveRequirements(tx, user, input.requirements) : position.requirements;
    const next = { ...position, label: input.label ?? position.label, requirements };
    // Both sets are ordered by skill UUID; names can change without changing requirements.
    const requirementsChanged = requirements.length !== position.requirements.length || requirements.some((r, i) =>
      r.skillId !== position.requirements[i]?.skillId || r.minProficiency !== position.requirements[i]?.minProficiency);
    if (next.label === position.label && !requirementsChanged) return withPositions(tx, user, mission);

    await tx.update(positions).set({ label: next.label }).where(wherePosition(user, id, positionId));
    if (requirementsChanged) {
      await tx.delete(positionSkills).where(and(
        eq(positionSkills.tenantId, user.tenantId),
        eq(positionSkills.missionId, id), eq(positionSkills.positionId, positionId),
      ));
      await writeRequirements(tx, user, id, positionId, requirements);
    }

    return finishChange(tx, user, mission, {
      kind: 'position_updated', payload: { before: positionSnapshot(position), after: positionSnapshot(next) },
    });
  });
}

export async function removePosition(db: Database, user: Identity, id: string, positionId: string, version: number) {
  return db.transaction(async (tx) => {
    const mission = await findMission(tx, user, id, true);
    const position = (await readPositions(tx, user, id)).find((p) => p.id === positionId);
    if (!position) throw notFound();
    checkEdit(user, mission, version);
    if (position.removedAt) {
      throw new AppError(409, 'POSITION_REMOVED', 'This position was removed.',
        'Add a new position using the current mission version.');
    }

    const [removed] = await tx.update(positions).set({ removedAt: sql`clock_timestamp()` })
      .where(wherePosition(user, id, positionId)).returning(positionFields);

    return finishChange(tx, user, mission, {
      kind: 'position_removed',
      payload: {
        before: positionSnapshot(position),
        after: positionSnapshot({ ...removed!, requirements: position.requirements }),
      },
    });
  });
}

// Private query, validation and history helpers

async function findMission(db: Database | Transaction, user: Identity, id: string, lock = false) {
  // Assignment-based Crew visibility is introduced with assignments in step 4.
  if (user.role === 'crew') throw notFound();
  const query = db.select(missionFields).from(missions).where(whereMission(user, id));
  const [mission] = await (lock ? query.for('update') : query);
  if (!mission) throw notFound();
  return mission;
}

function checkEdit(user: Identity, mission: MissionSummary, version: number) {
  if (user.role !== 'director' && user.id !== mission.ownerId) throw forbidden();
  if (version !== mission.version) {
    throw new AppError(409, 'STALE_VERSION', 'The mission has changed.',
      'Run mc missions show, review the plan and retry with its version.');
  }
  if (mission.state !== 'draft') {
    throw new AppError(409, 'MISSION_FROZEN', 'Only draft missions can be edited.',
      'Withdraw a submitted plan; approved plans require cancellation and replacement.');
  }
}

async function checkTimeline(tx: Transaction, start: Date, end: Date) {
  if (!(start < end)) {
    throw new AppError(400, 'INVALID_INTERVAL', 'Mission end must be after start.',
      'Provide a positive interval using timestamps with timezone offsets.');
  }
  // Database wall clock, sampled after acquiring the mission lock, not transaction-start now().
  const result = await tx.execute<{ future: boolean }>(
    sql`SELECT ${start.toISOString()}::timestamptz > clock_timestamp() AS future`,
  );
  if (!result.rows[0]!.future) {
    throw new AppError(409, 'START_NOT_FUTURE', 'The mission must start in the future.',
      'Choose a future start and end; reschedule elapsed drafts before staffing.');
  }
}

async function readPositions(tx: Transaction, user: Identity, missionId: string) {
  const rows = await tx.select(positionFields).from(positions)
    .where(and(eq(positions.tenantId, user.tenantId), eq(positions.missionId, missionId)))
    .orderBy(positions.ordinal);
  const requirements = await tx.select({
    positionId: positionSkills.positionId, skillId: skills.id,
    name: skills.name, minProficiency: positionSkills.minProficiency,
  }).from(positionSkills)
    .innerJoin(skills, and(eq(skills.tenantId, positionSkills.tenantId), eq(skills.id, positionSkills.skillId)))
    .where(and(eq(positionSkills.tenantId, user.tenantId), eq(positionSkills.missionId, missionId)))
    .orderBy(skills.id);

  const grouped = new Map<string, Omit<(typeof requirements)[number], 'positionId'>[]>();
  for (const { positionId, ...requirement } of requirements) {
    const group = grouped.get(positionId) ?? [];
    group.push(requirement);
    grouped.set(positionId, group);
  }
  return rows.map((position) => ({ ...position, requirements: grouped.get(position.id) ?? [] }));
}

async function withPositions(tx: Transaction, user: Identity, mission: MissionSummary) {
  return { ...mission, positions: await readPositions(tx, user, mission.id) };
}

function planSnapshot(plan: PlanInput) {
  return { title: plan.title, brief: plan.brief, start: plan.start.toISOString(), end: plan.end.toISOString() };
}

function positionSnapshot(position: Awaited<ReturnType<typeof readPositions>>[number]) {
  return { ...position, removedAt: position.removedAt?.toISOString() ?? null };
}

type PlanningEvent =
  | { kind: 'mission_created'; payload: { plan: ReturnType<typeof planSnapshot> } }
  | { kind: 'mission_updated'; payload: { before: ReturnType<typeof planSnapshot>; after: ReturnType<typeof planSnapshot> } }
  | { kind: 'position_added'; payload: { position: ReturnType<typeof positionSnapshot> } }
  | { kind: 'position_updated' | 'position_removed'; payload: { before: ReturnType<typeof positionSnapshot>; after: ReturnType<typeof positionSnapshot> } };

async function recordEvent(tx: Transaction, user: Identity, id: string, version: number, event: PlanningEvent) {
  await tx.insert(missionEvents).values({
    tenantId: user.tenantId, missionId: id, missionVersion: version, actorId: user.id, ...event,
  });
}

// The caller holds the mission lock. Plan, version and event share its transaction.
async function finishChange(tx: Transaction, user: Identity, mission: MissionSummary, event: PlanningEvent, plan: PlanPatch = {}) {
  const version = mission.version + 1;
  const [updated] = await tx.update(missions).set({ ...plan, version })
    .where(whereMission(user, mission.id)).returning(missionFields);
  await recordEvent(tx, user, mission.id, version, event);
  return withPositions(tx, user, updated!);
}

async function resolveRequirements(tx: Transaction, user: Identity, input: RequirementInput[]) {
  if (!input.length) return [];
  const rows = await tx.select({ skillId: skills.id, name: skills.name }).from(skills)
    .where(and(eq(skills.tenantId, user.tenantId), inArray(skills.id, input.map((r) => r.skillId))))
    .orderBy(skills.id);
  if (rows.length !== input.length) throw notFound();
  const levels = new Map(input.map((r) => [r.skillId, r.minProficiency]));
  return rows.map((r) => ({ ...r, minProficiency: levels.get(r.skillId)! }));
}

async function writeRequirements(tx: Transaction, user: Identity, missionId: string, positionId: string, requirements: RequirementInput[]) {
  if (!requirements.length) return;
  await tx.insert(positionSkills).values(requirements.map(({ skillId, minProficiency }) => ({
    tenantId: user.tenantId, missionId, positionId, skillId, minProficiency,
  })));
}
