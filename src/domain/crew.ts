import { and, eq, ilike, or } from 'drizzle-orm';

import type { Database, Transaction } from '../db/client.js';
import { availability, crew, crewSkills, skills, users } from '../db/schema.js';
import { requireDirector } from './auth.js';
import type { Identity } from './auth.js';
import { page, searchPattern } from './pagination.js';
import type { PageInput } from './pagination.js';
import { findSkill } from './organisation.js';
import { forbidden, notFound } from './errors.js';
import { checkConfirmedWork } from './crew-bookings.js';

const crewFields = { id: crew.id, userId: crew.userId, username: users.username, displayName: users.displayName,
  role: users.role, biography: crew.biography, active: crew.active };
const skillFields = { id: skills.id, name: skills.name };
const availabilityFields = { id: availability.id, start: availability.start, end: availability.end };

// This predicate also hides same-tenant peers from Crew members. 'me' always means the session's user.
function visibleCrew(user: Identity, id?: string) {
  return and(eq(crew.tenantId, user.tenantId), user.role === 'crew' ? eq(crew.userId, user.id) : undefined,
    id === 'me' ? eq(crew.userId, user.id) : id ? eq(crew.id, id) : undefined);
}

export async function findCrew(db: Database | Transaction, user: Identity, id: string, lock = false) {
  const query = db.select(crewFields).from(crew)
    .innerJoin(users, and(eq(users.tenantId, crew.tenantId), eq(users.id, crew.userId))).where(visibleCrew(user, id));
  const [profile] = await (lock ? query.for('update', { of: crew }) : query);
  if (!profile) throw notFound();
  return profile;
}

function requireOwner(user: Identity, profile: { userId: string }) {
  if (profile.userId !== user.id) throw forbidden();
}

export async function listCrew(db: Database, user: Identity, input: PageInput) {
  const pattern = input.q ? searchPattern(input.q) : undefined;
  const rows = await db.select(crewFields).from(crew)
    .innerJoin(users, and(eq(users.tenantId, crew.tenantId), eq(users.id, crew.userId)))
    .where(and(visibleCrew(user), pattern ? or(ilike(users.username, pattern), ilike(users.displayName, pattern)) : undefined))
    .orderBy(users.displayName, crew.id).limit(input.limit + 1).offset(input.offset);
  return page(rows, input);
}

export async function getCrew(db: Database | Transaction, user: Identity, id: string) {
  const profile = await findCrew(db, user, id);

  const levels = await db.select({ ...skillFields, proficiency: crewSkills.proficiency }).from(crewSkills)
    .innerJoin(skills, and(eq(skills.tenantId, crewSkills.tenantId), eq(skills.id, crewSkills.skillId)))
    .where(and(eq(crewSkills.tenantId, user.tenantId), eq(crewSkills.crewId, profile.id))).orderBy(skills.name, skills.id);
  return { ...profile, skills: levels };
}

export async function createCrew(db: Database, user: Identity, userId: string) {
  requireDirector(user);
  const [member] = await db.select({ id: users.id }).from(users)
    .where(and(eq(users.tenantId, user.tenantId), eq(users.id, userId)));
  if (!member) throw notFound();

  const [profile] = await db.insert(crew).values({ tenantId: user.tenantId, userId }).returning({ id: crew.id });
  return getCrew(db, user, profile!.id);
}

export async function updateCrew(db: Database, user: Identity, id: string,
  input: { displayName?: string | undefined; biography?: string | undefined; active?: boolean | undefined }) {
  return db.transaction(async (tx) => {
    const profile = await findCrew(tx, user, id, true);
    if (user.role !== 'director') {
      requireOwner(user, profile);
      if (input.active !== undefined) throw forbidden();
    }

    if (input.biography !== undefined || input.active !== undefined) {
      await tx.update(crew).set({ ...(input.biography !== undefined ? { biography: input.biography } : {}),
        ...(input.active !== undefined ? { active: input.active } : {}) })
        .where(and(eq(crew.tenantId, user.tenantId), eq(crew.id, profile.id)));
    }

    // Display name has one source of truth on the account.
    if (input.displayName !== undefined) {
      await tx.update(users).set({ displayName: input.displayName })
        .where(and(eq(users.tenantId, user.tenantId), eq(users.id, profile.userId)));
    }

    if (input.active === false) await checkConfirmedWork(tx, user, profile.id);
    return getCrew(tx, user, id);
  });
}

export async function setCrewSkill(db: Database, user: Identity, id: string, skillId: string, proficiency: number) {
  return db.transaction(async (tx) => {
    const profile = await findCrew(tx, user, id, true);
    await findSkill(tx, user, skillId);
    requireOwner(user, profile);

    await tx.insert(crewSkills).values({ tenantId: user.tenantId, crewId: profile.id, skillId, proficiency })
      .onConflictDoUpdate({ target: [crewSkills.tenantId, crewSkills.crewId, crewSkills.skillId], set: { proficiency } });
    await checkConfirmedWork(tx, user, profile.id);
    return { skillId, proficiency };
  });
}

export async function removeCrewSkill(db: Database, user: Identity, id: string, skillId: string) {
  await db.transaction(async (tx) => {
    const profile = await findCrew(tx, user, id, true);
    const where = and(eq(crewSkills.tenantId, user.tenantId), eq(crewSkills.crewId, profile.id), eq(crewSkills.skillId, skillId));
    const [level] = await tx.select({ skillId: crewSkills.skillId }).from(crewSkills).where(where);
    if (!level) throw notFound();
    requireOwner(user, profile);

    await tx.delete(crewSkills).where(where);
    await checkConfirmedWork(tx, user, profile.id);
  });
}

export async function listAvailability(db: Database, user: Identity, id: string, input: PageInput) {
  const profile = await findCrew(db, user, id);
  const rows = await db.select(availabilityFields).from(availability)
    .where(and(eq(availability.tenantId, user.tenantId), eq(availability.crewId, profile.id)))
    .orderBy(availability.start, availability.id).limit(input.limit + 1).offset(input.offset);
  return page(rows, input);
}

export async function addAvailability(db: Database, user: Identity, id: string, input: { start: Date; end: Date }) {
  return db.transaction(async (tx) => {
    const profile = await findCrew(tx, user, id, true);
    requireOwner(user, profile);

    const [window] = await tx.insert(availability).values({ ...input, tenantId: user.tenantId, crewId: profile.id })
      .returning(availabilityFields);
    return window!;
  });
}

export async function removeAvailability(db: Database, user: Identity, id: string, availabilityId: string) {
  await db.transaction(async (tx) => {
    const profile = await findCrew(tx, user, id, true);
    const where = and(eq(availability.tenantId, user.tenantId), eq(availability.crewId, profile.id), eq(availability.id, availabilityId));
    const [window] = await tx.select({ id: availability.id }).from(availability).where(where);
    if (!window) throw notFound();
    requireOwner(user, profile);

    await tx.delete(availability).where(where);
    await checkConfirmedWork(tx, user, profile.id);
  });
}
