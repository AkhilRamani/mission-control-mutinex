import { and, eq, gt, inArray, lt, sql } from 'drizzle-orm';

import type { Database, Transaction } from '../../db/client.js';
import { assignments, availability, crew, crewSkills, users } from '../../db/schema.js';
import type { Identity } from '../auth.js';
import { AppError, forbidden, notFound } from '../errors.js';
import { coversInterval, utcMonth, workloadHours } from '../time.js';
import type { Interval } from '../time.js';
import { checkDraft, checkTimeline, findMission, readPositions } from './shared.js';
import type { Mission, Position } from './shared.js';
import { compareCandidates, eligibility, selectTeam } from './matcher.js';
import type { CrewCandidate } from './matcher.js';

// All staffing writes use the same profile locks as crew edits, in UUID order.
export async function lockCrew(tx: Transaction, user: Identity, ids: string[]) {
  if (!ids.length) return;

  const rows = await tx.select({ id: crew.id }).from(crew).where(and(eq(crew.tenantId, user.tenantId), inArray(crew.id, ids)))
    .orderBy(crew.id).for('update');
  if (rows.length !== ids.length) throw notFound();
}

export async function loadCandidates(tx: Transaction, user: Identity, mission: Mission, ids?: string[]): Promise<CrewCandidate[]> {
  const month = utcMonth(mission.start);
  const earliest = new Date(Math.min(+month.start, +mission.start));
  const latest = new Date(Math.max(+month.end, +mission.end));

  const rows = await tx.select({ crewId: crew.id, displayName: users.displayName, active: crew.active }).from(crew)
    .innerJoin(users, and(eq(users.tenantId, crew.tenantId), eq(users.id, crew.userId)))
    .where(and(eq(crew.tenantId, user.tenantId), ids ? inArray(crew.id, ids) : undefined)).orderBy(crew.id);

  const levels = await tx.select({ crewId: crewSkills.crewId, skillId: crewSkills.skillId, proficiency: crewSkills.proficiency })
    .from(crewSkills).where(and(eq(crewSkills.tenantId, user.tenantId), ids ? inArray(crewSkills.crewId, ids) : undefined));

  const windows = await tx.select({ crewId: availability.crewId, start: availability.start, end: availability.end }).from(availability)
    .where(and(eq(availability.tenantId, user.tenantId), ids ? inArray(availability.crewId, ids) : undefined,
      lt(availability.start, mission.end), gt(availability.end, mission.start)));

  const bookings = await tx.select({ crewId: assignments.crewId, start: assignments.bookedStart, end: assignments.bookedEnd })
    .from(assignments).where(and(eq(assignments.tenantId, user.tenantId), eq(assignments.state, 'confirmed'),
      ids ? inArray(assignments.crewId, ids) : undefined, lt(assignments.bookedStart, latest), gt(assignments.bookedEnd, earliest)));

  // Group once, rather than querying for each crew member or position.
  const skillsByCrew = new Map<string, Map<string, number>>();
  const windowsByCrew = new Map<string, Interval[]>(), bookingsByCrew = new Map<string, Interval[]>();

  for (const r of levels) {
    const group = skillsByCrew.get(r.crewId) ?? new Map<string, number>();
    group.set(r.skillId, r.proficiency);
    skillsByCrew.set(r.crewId, group);
  }

  for (const [source, grouped] of [[windows, windowsByCrew], [bookings, bookingsByCrew]] as const) {
    for (const r of source) {
      const group = grouped.get(r.crewId) ?? [];
      group.push({ start: r.start!, end: r.end! });
      grouped.set(r.crewId, group);
    }
  }

  return rows.map((r) => {
    const booked = bookingsByCrew.get(r.crewId) ?? [];
    return { ...r, levels: skillsByCrew.get(r.crewId) ?? new Map<string, number>(),
      availabilityCovered: coversInterval(windowsByCrew.get(r.crewId) ?? [], mission),
      bookingConflict: booked.some((b) => b.start < mission.end && b.end > mission.start),
      workloadHours: workloadHours(booked, month) };
  });
}

export function checkEligibility(candidate: CrewCandidate, position: Position) {
  const { reasons } = eligibility(candidate, position);
  if (reasons.length) throw new AppError(422, 'INELIGIBLE_CREW', `Position ${position.label} (${position.id}): ${reasons.join(' ')}`,
    'Review crew skills, availability and current bookings; withdraw submitted plans before revising or rematching.');
}

export async function matchCrew(db: Database, user: Identity, id: string) {
  return db.transaction(async (tx) => {
    const mission = await findMission(tx, user, id);
    if (user.role === 'crew') throw forbidden();
    checkDraft(mission);
    await checkTimeline(tx, mission.start, mission.end);

    const snapshot = await tx.execute<{ snapshotAt: Date }>(sql`SELECT transaction_timestamp() AS "snapshotAt"`);
    const positions = (await readPositions(tx, user, id)).filter((p) => !p.removedAt);
    const candidates = await loadCandidates(tx, user, mission);

    const assessedPositions = positions.map((position) => {
      const assessments = candidates.map((candidate) => ({
        ...candidate, ...eligibility(candidate, position),
      })).sort(compareCandidates);
      return { ...position,
        eligible: assessments.filter((candidate) => candidate.reasons.length === 0),
        excluded: assessments.filter((candidate) => candidate.reasons.length > 0),
      };
    });

    const crewByPosition = selectTeam(assessedPositions.map((position) => ({
      id: position.id, ordinal: position.ordinal, candidates: position.eligible,
    })));

    const roster = assessedPositions.flatMap((position) => {
      const selected = position.eligible.find((candidate) => candidate.crewId === crewByPosition.get(position.id));
      if (!selected) return [];
      const isPreferred = selected.crewId === position.eligible[0]?.crewId;
      return [{
        positionId: position.id, positionLabel: position.label, crewId: selected.crewId, displayName: selected.displayName,
        workloadHours: selected.workloadHours, requirements: selected.requirements, availabilityCovered: selected.availabilityCovered,
        explanation: isPreferred
          ? 'First eligible candidate by workload, then crew ID.'
          : 'Alternative selected to preserve maximum coverage; the preferred candidate fills another position.',
      }];
    });

    const unfilled = assessedPositions.filter((position) => !crewByPosition.has(position.id)).map((position) => ({
      positionId: position.id, label: position.label,
      reason: position.eligible.length > 0
        ? 'Eligible crew are needed in other positions; no full roster is possible.' : 'No eligible crew meet all requirements.',
    }));

    const month = utcMonth(mission.start);
    return { missionId: id, version: mission.version, snapshotAt: snapshot.rows[0]!.snapshotAt,
      workloadMonth: month.start.toISOString().slice(0, 7), complete: unfilled.length === 0, roster, unfilled,
      positions: assessedPositions.map((position) => ({ positionId: position.id, label: position.label,
        eligibleCandidates: position.eligible.map((candidate) => ({
          crewId: candidate.crewId, displayName: candidate.displayName, workloadHours: candidate.workloadHours,
        })),
        excludedCandidates: position.excluded.map((candidate) => ({
          crewId: candidate.crewId, displayName: candidate.displayName, reasons: candidate.reasons,
        })),
      })),
    };
  }, { isolationLevel: 'repeatable read', accessMode: 'read only' });
}
