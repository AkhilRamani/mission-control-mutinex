import { and, eq } from 'drizzle-orm';
import type { Database, Transaction } from '../../db/client.js';
import { assignments } from '../../db/schema.js';
import { requireDirector } from '../auth.js';
import type { Identity } from '../auth.js';
import { AppError, forbidden } from '../errors.js';
import { checkEligibility, loadCandidates, lockCrew } from './matching.js';
import {
  assignmentFields, assignmentSnapshot, checkEdit, checkTimeline, checkVersion, currentStates,
  findMission, finishChange, readAssignments, readPositions, requirePlanner, resetConsent,
} from './shared.js';
import type { Mission } from './shared.js';

export async function submitMission(db: Database, user: Identity, id: string, version: number) {
  return db.transaction(async (tx) => {
    const mission = await findMission(tx, user, id, true);
    checkEdit(user, mission, version);
    const roster = await validateRoster(tx, user, mission);
    // Include unchanged consent snapshots so crew can see their submission event.
    return finishChange(tx, user, mission, { kind: 'mission_submitted', payload: {} }, {
      patch: { state: 'submitted' }, assignments: { before: roster.before, after: roster.assignments },
    });
  });
}

export async function approveMission(db: Database, user: Identity, id: string, version: number) {
  return db.transaction(async (tx) => {
    const mission = await findMission(tx, user, id, true);
    requireIndependentDirector(user, mission);
    checkVersion(mission, version);
    checkSubmitted(mission);
    const roster = await validateRoster(tx, user, mission);
    const confirmed = await tx.update(assignments).set({ state: 'confirmed', bookedStart: mission.start, bookedEnd: mission.end })
      .where(and(eq(assignments.tenantId, user.tenantId), eq(assignments.missionId, id),
        eq(assignments.state, 'accepted'))).returning(assignmentFields);
    return finishChange(tx, user, mission, { kind: 'mission_approved', payload: {} }, {
      patch: { state: 'approved' }, assignments: { before: roster.before, after: confirmed },
    });
  });
}

export async function returnToDraft(db: Database, user: Identity, id: string, version: number,
  action: 'withdraw' | 'reject', reason: string) {
  return db.transaction(async (tx) => {
    const mission = await findMission(tx, user, id, true);
    if (action === 'reject') requireIndependentDirector(user, mission);
    else requirePlanner(user, mission);
    checkVersion(mission, version);
    checkSubmitted(mission);
    const changes = await resetConsent(tx, user, mission);
    return finishChange(tx, user, mission, { kind: action === 'reject' ? 'mission_rejected' : 'mission_withdrawn', payload: { reason } }, {
      patch: { state: 'draft' }, assignments: changes,
    });
  });
}

function requireIndependentDirector(user: Identity, mission: Mission) {
  requireDirector(user);
  if (user.id === mission.ownerId) throw forbidden();
}
function checkSubmitted(mission: Mission) {
  if (mission.state !== 'submitted') throw new AppError(409, 'MISSION_STATE', 'This action requires a submitted mission.',
    'Run mc missions show. Drafts must be staffed and submitted; approved plans require cancellation and replacement.');
}
// The caller holds the mission lock and has checked the transition and permissions.
async function validateRoster(tx: Transaction, user: Identity, mission: Mission) {
  const positions = (await readPositions(tx, user, mission.id)).filter((p) => !p.removedAt);
  const current = (await readAssignments(tx, user, mission.id)).filter((a) => currentStates.some((s) => s === a.state));
  if (!positions.length || positions.length !== current.length || positions.some((p) => !current.some((a) => a.positionId === p.id))) {
    throw new AppError(422, 'INCOMPLETE_ROSTER', 'Every active position needs an assignment, and at least one position is required.',
      'Review mc missions show. Withdraw submitted plans before adding positions or proposing a complete roster.');
  }
  if (current.some((a) => a.state !== 'accepted')) throw new AppError(422, 'CONSENT_REQUIRED', 'Every assigned crew member must accept the current plan.',
    'Withdraw submitted plans first. Ask crew to review and accept; declined attempts need a new proposal.');
  const ids = current.map((a) => a.crewId);
  await lockCrew(tx, user, ids);
  // READ COMMITTED sees edits/approvals that committed while waiting for these locks.
  await checkTimeline(tx, mission.start, mission.end);
  const candidates = await loadCandidates(tx, user, mission, ids);
  if (mission.state === 'submitted' && candidates.some((c) => c.bookingConflict)) throw new AppError(409, 'CREW_CONFLICT',
    'A confirmed booking overlaps this mission.', 'Withdraw the plan, rematch crew and obtain fresh consent before resubmitting.');
  const before = current.map((assignment) => {
    const position = positions.find((p) => p.id === assignment.positionId)!;
    checkEligibility(candidates.find((c) => c.crewId === assignment.crewId)!, position);
    return assignmentSnapshot(mission, position, assignment);
  });
  return { assignments: current, before };
}
