import { describe, expect, it } from 'vitest';
import { coversInterval, missionPhase } from '../src/domain/time.js';

const interval = (start: number, end: number) => ({ start: new Date(start), end: new Date(end) });
it('derives approved phases at exact interval boundaries; other states have no phase', () => {
  const mission = { ...interval(10, 20), state: 'approved' };
  expect(missionPhase(mission, new Date(9))).toBe('scheduled');
  expect(missionPhase(mission, new Date(10))).toBe('active');
  expect(missionPhase(mission, new Date(19))).toBe('active');
  expect(missionPhase(mission, new Date(20))).toBe('awaiting_completion');
  expect(missionPhase(mission, new Date(21))).toBe('awaiting_completion');
  for (const state of ['draft', 'submitted', 'completed', 'cancelled']) {
    expect(missionPhase({ ...mission, state }, new Date(15))).toBeNull();
  }
});

describe('availability union coverage [start, end)', () => {
  it('requires whole coverage, merges overlaps/adjacency, and does not mutate input', () => {
    const windows = [interval(20, 30), interval(0, 10), interval(5, 20), interval(2, 3)];
    const original = structuredClone(windows);
    expect(coversInterval(windows, interval(0, 30))).toBe(true);
    expect(coversInterval(windows, interval(7, 21))).toBe(true);
    expect(coversInterval(windows, interval(0, 31))).toBe(false);
    expect(coversInterval(windows, interval(-1, 30))).toBe(false);
    expect(windows).toEqual(original);
    expect(coversInterval([interval(0, 10), interval(11, 20)], interval(0, 20))).toBe(false);
    expect(coversInterval([interval(0, 10), interval(10, 20)], interval(0, 20))).toBe(true);
    expect(coversInterval([interval(0, 10)], interval(10, 20))).toBe(false);
    expect(coversInterval([], interval(0, 1))).toBe(false);
    expect(coversInterval(windows, interval(10, 10))).toBe(false);
  });
});
