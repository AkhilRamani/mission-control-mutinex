import { and, eq, inArray, sql } from 'drizzle-orm';
import type { Database, Transaction } from '../../db/client.js';
import { missions, positions, positionSkills, skills } from '../../db/schema.js';
import type { Identity } from '../auth.js';
import { AppError, forbidden, notFound } from '../errors.js';
import {
  checkEdit, checkTimeline, findMission, finishChange, planSnapshot, positionSnapshot,
  readPositions, recordEvent, wherePosition, readMissionView, resetConsent, missionFields, missionSummary, positionFields,
} from './shared.js';

export type RequirementInput = { skillId: string; minProficiency: number };
export type PlanInput = { title: string; brief: string; start: Date; end: Date };
type PlanPatch = { [K in keyof PlanInput]?: PlanInput[K] | undefined };
type PositionInput = { label: string; requirements: RequirementInput[] };
type PositionPatch = { [K in keyof PositionInput]?: PositionInput[K] | undefined };

export async function createMission(db: Database, user: Identity, input: PlanInput) {
  if (user.role === 'crew') throw forbidden();
  return db.transaction(async (tx) => {
    await checkTimeline(tx, input.start, input.end);
    const [mission] = await tx.insert(missions)
      .values({ ...input, tenantId: user.tenantId, ownerId: user.id }).returning(missionFields);
    await recordEvent(tx, user, mission!.id, 1, { kind: 'mission_created', payload: { plan: planSnapshot(input) } });
    return { ...missionSummary(user, mission!), positions: [], assignments: [] };
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
      return readMissionView(tx, user, mission);
    }
    if (timeChanged) await checkTimeline(tx, next.start, next.end);
    const consent = await resetConsent(tx, user, mission);

    return finishChange(tx, user, mission, {
      kind: 'mission_updated', payload: { before: planSnapshot(mission), after: planSnapshot(next) },
    }, { patch: next, assignments: consent });
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
    if (next.label === position.label && !requirementsChanged) return readMissionView(tx, user, mission);
    const consent = await resetConsent(tx, user, mission, positionId);

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
    }, { assignments: consent });
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

    const consent = await resetConsent(tx, user, mission, positionId, true);
    const [removed] = await tx.update(positions).set({ removedAt: sql`clock_timestamp()` })
      .where(wherePosition(user, id, positionId)).returning(positionFields);

    return finishChange(tx, user, mission, {
      kind: 'position_removed',
      payload: {
        before: positionSnapshot(position),
        after: positionSnapshot({ ...removed!, requirements: position.requirements }),
      },
    }, { assignments: consent });
  });
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
