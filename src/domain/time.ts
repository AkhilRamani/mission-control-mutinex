export type Interval = { start: Date; end: Date };

// Coverage uses the union of windows, including adjacency. Call with the full pool, never a display page.
export function coversInterval(windows: Interval[], target: Interval): boolean {
  if (!(target.start < target.end)) return false;
  let coveredUntil = target.start.getTime();
  for (const window of [...windows].sort((a, b) => a.start.getTime() - b.start.getTime())) {
    if (window.start.getTime() > coveredUntil) return false;
    coveredUntil = Math.max(coveredUntil, window.end.getTime());
    if (coveredUntil >= target.end.getTime()) return true;
  }
  return false;
}
