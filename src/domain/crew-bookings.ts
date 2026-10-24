import { and, eq, gt, sql } from 'drizzle-orm';
import type { Transaction } from '../db/client.js';
import { assignments, availability, crew, crewSkills, positionSkills } from '../db/schema.js';
import type { Identity } from './auth.js';
import { AppError } from './errors.js';
import { coversInterval } from './time.js';

// Called after an eligibility edit, with the crew row locked. Failure rolls back the edit.
// Never lock missions here: staffing operations lock mission first, then crew.
export async function checkConfirmedWork(tx: Transaction, user: Identity, crewId: string) {
  // Confirmed bookings protect future/active work; completed work has already ended.
  // LEFT JOINs preserve positions without requirements and expose missing skills as NULL.
  const bookings = await tx.select({ active: crew.active,
    required: positionSkills.minProficiency, proficiency: crewSkills.proficiency,
    start: assignments.bookedStart, end: assignments.bookedEnd }).from(assignments)
    .innerJoin(crew, and(eq(crew.tenantId, assignments.tenantId), eq(crew.id, assignments.crewId)))
    .leftJoin(positionSkills, and(eq(positionSkills.tenantId, assignments.tenantId),
      eq(positionSkills.missionId, assignments.missionId), eq(positionSkills.positionId, assignments.positionId)))
    .leftJoin(crewSkills, and(eq(crewSkills.tenantId, assignments.tenantId),
      eq(crewSkills.crewId, assignments.crewId), eq(crewSkills.skillId, positionSkills.skillId)))
    .where(and(eq(assignments.tenantId, user.tenantId), eq(assignments.crewId, crewId), eq(assignments.state, 'confirmed'),
      gt(assignments.bookedEnd, sql`clock_timestamp()`)));
  if (!bookings.length) return;
  const windows = await tx.select({ start: availability.start, end: availability.end }).from(availability)
    .where(and(eq(availability.tenantId, user.tenantId), eq(availability.crewId, crewId)));
  const invalid = bookings.some((b) => !b.active || (b.proficiency ?? 0) < (b.required ?? 0)
    || !coversInterval(windows, { start: b.start!, end: b.end! }));
  if (invalid) throw new AppError(409, 'CONFIRMED_WORK', 'This change would invalidate future or active confirmed work.',
    'Keep the required skills and full availability, or ask the mission owner/Director to cancel and replace the approved plan.');
}
