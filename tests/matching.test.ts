import { describe, expect, it } from 'vitest';
import { eligibility, selectTeam } from '../src/domain/missions/matcher.js';
import { utcMonth, workloadHours } from '../src/domain/time.js';

const interval = (start: string, end: string) => ({ start: new Date(start), end: new Date(end) });
function positionsFor(graph: string[][]) {
  return graph.map((candidates, i) => ({ id: String(i), ordinal: i + 1,
    candidates: candidates.map((crewId) => ({ crewId, workloadHours: 0 })),
  }));
}

// Independent oracle: enumerate every valid roster instead of using augmenting paths.
function exhaustiveSize(graph: string[][], index = 0, used = new Set<string>()): number {
  if (index === graph.length) return 0;
  let best = exhaustiveSize(graph, index + 1, used);
  for (const id of graph[index]!) if (!used.has(id)) {
    best = Math.max(best, 1 + exhaustiveSize(graph, index + 1, new Set([...used, id])));
  }
  return best;
}

describe('maximum-coverage matching', () => {
  it('puts Sam in the common pilot position so Alex can cover the scarce medical position', () => {
    const positions = positionsFor([['alex', 'sam'], ['alex']]);
    expect(Object.fromEntries(selectTeam(positions))).toEqual({ '0': 'sam', '1': 'alex' });
  });

  it('reroutes a chain of earlier choices to fill every position', () => {
    // Every position has two candidates. The final position needs a multi-hop reassignment.
    const positions = positionsFor([['a', 'b'], ['a', 'c'], ['c', 'd'], ['a', 'b']]);
    const result = selectTeam(positions);
    expect(result.size).toBe(4);
    expect(new Set(result.values()).size).toBe(4);
    for (const p of positions) expect(p.candidates.map((c) => c.crewId)).toContain(result.get(p.id));
  });

  it('returns partial coverage without reusing a person when a full roster is impossible', () => {
    const result = selectTeam(positionsFor([['alex'], ['alex'], [], ['sam']]));
    expect(result.size).toBe(2);
    expect(new Set(result.values())).toEqual(new Set(['alex', 'sam']));
    expect(result.has('2')).toBe(false);
  });

  it('uses position ordinal to break ties between equally constrained positions', () => {
    const positions = positionsFor([['alex'], ['alex']]);
    positions[0]!.ordinal = 20;
    positions[1]!.ordinal = 3;
    expect(Object.fromEntries(selectTeam(positions))).toEqual({ '1': 'alex' });
  });

  it('prefers lower workload, then crew ID, without treating workload as a capacity cap', () => {
    const position = { id: 'pilot', ordinal: 1, candidates: [
      { crewId: 'alex', workloadHours: 800 }, { crewId: 'sam', workloadHours: 300 },
    ] };
    expect(selectTeam([position]).get('pilot')).toBe('sam');
    position.candidates[0]!.workloadHours = 300;
    expect(selectTeam([position]).get('pilot')).toBe('alex');
  });

  it('is deterministic across input order and does not mutate the candidate graph', () => {
    const positions = positionsFor([['a', 'b'], ['a', 'c'], ['a', 'c']]);
    const original = structuredClone(positions);
    const result = selectTeam(positions);
    expect(positions).toEqual(original);
    const reversed = [...positions].reverse().map((p) => ({ ...p, candidates: [...p.candidates].reverse() }));
    expect([...selectTeam(reversed)].sort()).toEqual([...result].sort());
  });

  it.each([[0, 3], [3, 0], [2, 4], [4, 2], [3, 3]])(
    'agrees with exhaustive search for every %i-position / %i-crew graph', (positionCount, crewCount) => {
      const crewIds = Array.from({ length: crewCount }, (_, c) => `crew-${c}`);
      for (let mask = 0; mask < 2 ** (positionCount * crewCount); mask++) {
        const graph = Array.from({ length: positionCount }, (_, p) =>
          crewIds.filter((_, c) => mask & (1 << (p * crewCount + c))));
        const positions = positionsFor(graph);
        // Non-uniform workload must never reduce achievable coverage.
        for (const p of positions) for (const c of p.candidates) c.workloadHours = c.crewId === 'crew-0' ? 100 : 0;
        const result = selectTeam(positions);
        expect(result.size, `graph ${mask}`).toBe(exhaustiveSize(graph));
        expect(new Set(result.values()).size).toBe(result.size);
        for (const [p, c] of result) expect(graph[Number(p)]).toContain(c);
      }
    },
  );
});

describe('eligibility', () => {
  const position = {
    id: 'medic-pilot', ordinal: 1, label: 'Medic pilot', removedAt: null,
    requirements: [
      { skillId: 'piloting', name: 'piloting', minProficiency: 3 },
      { skillId: 'medical', name: 'medical', minProficiency: 4 },
    ],
  };
  function candidate() {
    return { crewId: 'alex', displayName: 'Alex', active: true,
      availabilityCovered: true, bookingConflict: false, workloadHours: 500,
      levels: new Map([['piloting', 3], ['medical', 4]]),
    };
  }

  it('accepts exact thresholds for every skill and reports required and actual proficiency', () => {
    const result = eligibility(candidate(), position);
    expect(result.reasons).toEqual([]);
    expect(result.requirements).toMatchObject([
      { skillId: 'piloting', minProficiency: 3, actualProficiency: 3 },
      { skillId: 'medical', minProficiency: 4, actualProficiency: 4 },
    ]);
  });

  it('rejects a missing or underqualified skill even when another requirement is satisfied', () => {
    const person = candidate();
    person.levels.delete('medical');
    expect(eligibility(person, position).reasons).toEqual(['medical requires 4; declared proficiency is 0.']);
    person.levels.set('medical', 3);
    expect(eligibility(person, position).reasons).toEqual(['medical requires 4; declared proficiency is 3.']);
  });

  it.each([
    [{ active: false }, 'Crew profile is inactive.'],
    [{ availabilityCovered: false }, 'Availability does not cover the full mission interval.'],
    [{ bookingConflict: true }, 'A confirmed booking overlaps this mission.'],
  ])('rejects an otherwise skilled person with %j', (change, reason) => {
    expect(eligibility({ ...candidate(), ...change }, position).reasons).toEqual([reason]);
  });

  it('reports all exclusion reasons instead of hiding later failures behind the first', () => {
    const person = { ...candidate(), active: false, availabilityCovered: false, bookingConflict: true, levels: new Map<string, number>() };
    expect(eligibility(person, position).reasons).toEqual([
      'Crew profile is inactive.', 'Availability does not cover the full mission interval.',
      'A confirmed booking overlaps this mission.',
      'piloting requires 3; declared proficiency is 0.', 'medical requires 4; declared proficiency is 0.',
    ]);
  });
});

describe('UTC workload heuristic', () => {
  it.each([
    ['2030-02-01T01:00:00+11:00', '2030-01-01T00:00:00Z', '2030-02-01T00:00:00Z'],
    ['2030-01-31T23:30:00-02:00', '2030-02-01T00:00:00Z', '2030-03-01T00:00:00Z'],
    ['2028-02-29T12:00:00Z', '2028-02-01T00:00:00Z', '2028-03-01T00:00:00Z'],
    ['2030-12-20T12:00:00Z', '2030-12-01T00:00:00Z', '2031-01-01T00:00:00Z'],
  ])('selects the UTC month for %s without changing the input', (input, start, end) => {
    const date = new Date(input), original = +date;
    expect(utcMonth(date)).toEqual(interval(start, end));
    expect(+date).toBe(original);
  });

  it('clips booking durations at both month boundaries and excludes adjacent intervals', () => {
    const month = utcMonth(new Date('2030-01-10T00:00:00Z'));
    expect(workloadHours([
      interval('2029-12-31T23:00:00Z', '2030-01-01T02:00:00Z'),
      interval('2030-01-31T23:00:00Z', '2030-02-01T02:00:00Z'),
      interval('2030-02-01T00:00:00Z', '2030-02-01T04:00:00Z'),
      interval('2029-12-30T00:00:00Z', '2030-01-01T00:00:00Z'),
    ], month)).toBe(3);
    expect(workloadHours([], month)).toBe(0);
    expect(workloadHours([interval('2029-12-01T00:00:00Z', '2030-03-01T00:00:00Z')], month)).toBe(31 * 24);
    expect(workloadHours([interval('2030-01-10T09:00:00Z', '2030-01-10T09:45:00Z')], month)).toBe(0.75);
  });
});
