import type { getMission, missionHistory } from '../domain/missions/reads.js';
import type { getAssignment, listAssignments, respondToAssignment } from '../domain/missions/assignments.js';
import type { matchCrew } from '../domain/missions/matching.js';
import type { Json } from './context.js';

export type Mission = Json<Awaited<ReturnType<typeof getMission>>>;
export type MissionSummary = Omit<Mission, 'positions' | 'assignments'>;
export type History = Json<Awaited<ReturnType<typeof missionHistory>>>;
export type Match = Json<Awaited<ReturnType<typeof matchCrew>>>;
export type Assignment = Json<Awaited<ReturnType<typeof getAssignment>>>;
export type AssignmentPage = Json<Awaited<ReturnType<typeof listAssignments>>>;
export type AssignmentResponse = Json<Awaited<ReturnType<typeof respondToAssignment>>>;

export const missionRow = (m: MissionSummary) => `${m.id} | v${m.version} | ${m.state} | ${m.title} | ${m.start} → ${m.end}`;
export const assignmentRow = (a: AssignmentPage['items'][number]) =>
  `${a.id} | ${a.state} | ${a.displayName} | ${a.title}: ${a.label} | mission ${a.missionId} v${a.version} | ${a.start} → ${a.end}`;

export function missionDetails(m: Mission) {
  const positions = m.positions.map((p) => {
    const requirements = p.requirements.map((r) => `${r.name}:${r.minProficiency} [${r.skillId}]`).join(', ') || 'no requirements';
    return `${p.id} | #${p.ordinal} ${p.label}${p.removedAt ? ' (removed)' : ''} | ${requirements}`;
  });
  const assignments = m.assignments.map((a) => `${a.id} | position ${a.positionId} | crew ${a.crewId} | ${a.state}`);
  return [missionRow(m), ...(m.ownerId ? [`Owner: ${m.ownerId}`] : []), `Brief: ${m.brief || '(empty)'}`,
    'Positions:', ...(positions.length ? positions : ['(none)']),
    'Assignments:', ...(assignments.length ? assignments : ['(none)']),
  ].join('\n');
}

export function assignmentDetails(a: Assignment) {
  const requirements = a.position.requirements.map((r) => `${r.name}:${r.minProficiency}`).join(', ') || '(none)';
  return [
    `${a.id} | ${a.state} | mission ${a.missionId} v${a.version}`,
    a.mission.title, a.mission.brief, `${a.mission.start} → ${a.mission.end}`,
    `Position: ${a.position.label}`, `Requirements: ${requirements}`, `Crew: ${a.crewId}`,
    `Response: ${a.respondedAt ?? '(none)'}`, `History: mc missions history --mission ${a.missionId}`,
  ].join('\n');
}

export function matchDetails(m: Match) {
  const roster = m.roster.flatMap((r) => [
    `${r.positionLabel} [${r.positionId}] → ${r.displayName} [${r.crewId}] | ${r.workloadHours} confirmed hours`,
    r.requirements.map((s) => `${s.name}: requires ${s.minProficiency}, declared ${s.actualProficiency}`).join(', '),
    `Full availability: ${r.availabilityCovered}. ${r.explanation}`,
  ]);
  const unfilled = m.unfilled.map((p) => `Unfilled ${p.label} [${p.positionId}]: ${p.reason}`);
  const excluded = m.positions.flatMap((p) => p.excludedCandidates.map((c) =>
    `${p.label}: excluded ${c.displayName} [${c.crewId}]: ${c.reasons.join(' ')}`));
  return [
    `Mission ${m.missionId} | v${m.version} | snapshot ${m.snapshotAt}`,
    `Workload month: ${m.workloadMonth} UTC (preference only)`, ...roster, ...unfilled, ...excluded,
  ].join('\n');
}
