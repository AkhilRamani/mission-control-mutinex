export type RankedCandidate = { crewId: string; workloadHours: number };
export type CrewCandidate = RankedCandidate & {
  displayName: string;
  active: boolean;
  levels: ReadonlyMap<string, number>;
  availabilityCovered: boolean;
  bookingConflict: boolean;
};
type PositionCandidates = { id: string; ordinal: number; candidates: readonly RankedCandidate[] };
type Requirement = { skillId: string; name: string; minProficiency: number };

export const compareCandidates = (a: RankedCandidate, b: RankedCandidate) =>
  a.workloadHours - b.workloadHours || (a.crewId < b.crewId ? -1 : a.crewId > b.crewId ? 1 : 0);

// Augmenting paths guarantee maximum coverage, not minimum workload or global fairness.
// Returns position ID -> crew ID. Candidate arrays are copied before sorting.
export function selectTeam(input: readonly PositionCandidates[]): Map<string, string> {
  const orderedPositions = input.map((position) => ({
    ...position, candidates: [...position.candidates].sort(compareCandidates),
  })).sort((a, b) => a.candidates.length - b.candidates.length || a.ordinal - b.ordinal);
  const positionsById = new Map(orderedPositions.map((position) => [position.id, position]));
  const positionByCrew = new Map<string, string>();

  function tryAssign(positionId: string, visitedCrew: Set<string>): boolean {
    for (const { crewId } of positionsById.get(positionId)!.candidates) {
      if (visitedCrew.has(crewId)) continue;
      visitedCrew.add(crewId);
      const previousPosition = positionByCrew.get(crewId);
      // Try moving the existing position to another person before using this crew member.
      if (previousPosition === undefined || tryAssign(previousPosition, visitedCrew)) {
        positionByCrew.set(crewId, positionId);
        return true;
      }
    }
    return false;
  }

  // A fresh visited set for each position allows earlier choices to move.
  for (const position of orderedPositions) tryAssign(position.id, new Set());
  return new Map([...positionByCrew].map(([crewId, positionId]) => [positionId, crewId]));
}

export function eligibility(candidate: CrewCandidate, position: { requirements: readonly Requirement[] }) {
  const requirements = position.requirements.map((requirement) => ({
    ...requirement, actualProficiency: candidate.levels.get(requirement.skillId) ?? 0,
  }));
  const reasons: string[] = [];
  if (!candidate.active) reasons.push('Crew profile is inactive.');
  if (!candidate.availabilityCovered) reasons.push('Availability does not cover the full mission interval.');
  if (candidate.bookingConflict) reasons.push('A confirmed booking overlaps this mission.');
  for (const requirement of requirements) {
    if (requirement.actualProficiency < requirement.minProficiency) {
      reasons.push(`${requirement.name} requires ${requirement.minProficiency}; declared proficiency is ${requirement.actualProficiency}.`);
    }
  }
  return { reasons, requirements };
}
