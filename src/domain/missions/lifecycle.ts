import { and, eq, inArray, sql } from 'drizzle-orm';

import type { Database } from '../../db/client.js';
import { assignments } from '../../db/schema.js';
import type { Identity } from '../auth.js';
import { AppError } from '../errors.js';
import { lockCrew } from './matching.js';
import {
  assignmentFields, checkVersion, currentStates, findMission, readAssignments, readPositions, requirePlanner,
} from './shared.js';
import { assignmentSnapshot, finishChange } from './changes.js';

export async function cancelMission(db: Database, user: Identity, id: string, version: number, reason: string) {
  return db.transaction(async (tx) => {
    const mission = await findMission(tx, user, id, true);
    requirePlanner(user, mission);
    checkVersion(mission, version);
    if (mission.state === 'completed' || mission.state === 'cancelled') throw new AppError(409, 'MISSION_STATE',
      'Completed or cancelled missions are final.', 'Run mc missions show and mc missions history; create a replacement mission if needed.');

    const current = (await readAssignments(tx, user, id)).filter((a) => currentStates.some((s) => s === a.state));

    // Same mission-then-crew order as approval; waiting profile edits see the released bookings.
    await lockCrew(tx, user, current.map((a) => a.crewId));

    const positions = await readPositions(tx, user, id);
    const after = await tx.update(assignments).set({
      state: mission.state === 'approved' ? 'released' : 'withdrawn', bookedStart: null, bookedEnd: null,
    }).where(and(eq(assignments.tenantId, user.tenantId), eq(assignments.missionId, id),
      inArray(assignments.state, currentStates))).returning(assignmentFields);

    return finishChange(tx, user, mission, { kind: 'mission_cancelled', payload: { reason } }, {
      patch: { state: 'cancelled' }, assignments: {
        before: current.map((a) => assignmentSnapshot(mission, positions.find((p) => p.id === a.positionId)!, a)), after,
      },
    });
  });
}

export async function completeMission(db: Database, user: Identity, id: string, version: number) {
  return db.transaction(async (tx) => {
    const mission = await findMission(tx, user, id, true);
    requirePlanner(user, mission);
    checkVersion(mission, version);
    if (mission.state !== 'approved') throw new AppError(409, 'MISSION_STATE', 'Only approved missions can be completed.',
      'Run mc missions show and mc missions history. Submit and approve drafts first; terminal missions cannot change.');

    const result = await tx.execute<{ ended: boolean }>(sql`SELECT clock_timestamp() >= ${mission.end.toISOString()}::timestamptz AS ended`);
    if (!result.rows[0]!.ended) throw new AppError(409, 'MISSION_NOT_ENDED', 'The mission has not reached its scheduled end.',
      'Wait until the end to complete, or cancel with a reason if the mission will not finish as planned.');

    const confirmed = (await readAssignments(tx, user, id)).filter((a) => a.state === 'confirmed');

    const positions = await readPositions(tx, user, id);

    // Keep bookings intact and include own snapshots in Crew's completion history.
    return finishChange(tx, user, mission, { kind: 'mission_completed', payload: {} }, {
      patch: { state: 'completed' }, assignments: {
        before: confirmed.map((a) => assignmentSnapshot(mission, positions.find((p) => p.id === a.positionId)!, a)), after: confirmed,
      },
    });
  });
}
