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

export function utcMonth(start: Date): Interval {
  const monthStart = new Date(start);
  monthStart.setUTCDate(1);
  monthStart.setUTCHours(0, 0, 0, 0);
  const monthEnd = new Date(monthStart);
  monthEnd.setUTCMonth(monthEnd.getUTCMonth() + 1);
  return { start: monthStart, end: monthEnd };
}

export function workloadHours(bookings: readonly Interval[], month: Interval) {
  return bookings.reduce((totalHours, booking) => {
    const overlapStart = Math.max(booking.start.getTime(), month.start.getTime());
    const overlapEnd = Math.min(booking.end.getTime(), month.end.getTime());
    return totalHours + Math.max(0, overlapEnd - overlapStart) / 3_600_000;
  }, 0);
}
