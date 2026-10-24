import { and, eq, ilike, or } from 'drizzle-orm';
import type { Database, Transaction } from '../db/client.js';
import { organisations, skills, users } from '../db/schema.js';
import { requireDirector } from './auth.js';
import type { Identity } from './auth.js';
import { notFound } from './errors.js';
import { hashPassword } from './password.js';
import { page, searchPattern } from './pagination.js';
import type { PageInput } from './pagination.js';

const organisationFields = { id: organisations.id, slug: organisations.slug, name: organisations.name };
const memberFields = { id: users.id, username: users.username, displayName: users.displayName, role: users.role };
const skillFields = { id: skills.id, name: skills.name };

export async function getOrganisation(db: Database, user: Identity) {
  const [result] = await db.select(organisationFields)
    .from(organisations).where(eq(organisations.id, user.tenantId));
  if (!result) throw notFound();
  return result;
}

export async function updateOrganisation(db: Database, user: Identity, name: string) {
  requireDirector(user);
  const [result] = await db.update(organisations).set({ name }).where(eq(organisations.id, user.tenantId)).returning(organisationFields);
  if (!result) throw notFound();
  return result;
}

export async function listMembers(db: Database, user: Identity, input: PageInput) {
  requireDirector(user);
  const pattern = input.q ? searchPattern(input.q) : undefined;
  const rows = await db.select(memberFields).from(users).where(and(eq(users.tenantId, user.tenantId),
    pattern ? or(ilike(users.username, pattern), ilike(users.displayName, pattern)) : undefined))
    .orderBy(users.username, users.id).limit(input.limit + 1).offset(input.offset);
  return page(rows, input);
}

export async function createMember(db: Database, user: Identity,
  input: { username: string; displayName: string; role: Identity['role']; password: string }) {
  requireDirector(user);
  const [member] = await db.insert(users).values({ tenantId: user.tenantId, username: input.username,
    displayName: input.displayName, role: input.role, passwordHash: await hashPassword(input.password) }).returning(memberFields);
  return member!;
}

export async function listSkills(db: Database, user: Identity, input: PageInput) {
  const rows = await db.select(skillFields).from(skills).where(and(eq(skills.tenantId, user.tenantId),
    input.q ? ilike(skills.name, searchPattern(input.q)) : undefined))
    .orderBy(skills.name, skills.id).limit(input.limit + 1).offset(input.offset);
  return page(rows, input);
}

export async function createSkill(db: Database, user: Identity, name: string) {
  requireDirector(user);
  const [skill] = await db.insert(skills).values({ tenantId: user.tenantId, name }).returning(skillFields);
  return skill!;
}

export async function findSkill(db: Database | Transaction, user: Identity, id: string) {
  const [skill] = await db.select(skillFields).from(skills)
    .where(and(eq(skills.tenantId, user.tenantId), eq(skills.id, id)));
  if (!skill) throw notFound();
  return skill;
}

export async function renameSkill(db: Database, user: Identity, id: string, name: string) {
  await findSkill(db, user, id);
  requireDirector(user);
  const [skill] = await db.update(skills).set({ name })
    .where(and(eq(skills.tenantId, user.tenantId), eq(skills.id, id))).returning(skillFields);
  if (!skill) throw notFound();
  return skill;
}

export async function deleteSkill(db: Database, user: Identity, id: string) {
  await findSkill(db, user, id);
  requireDirector(user);
  // Restrictive FKs also reject deletion when a concurrent skill assignment wins the race.
  const removed = await db.delete(skills).where(and(eq(skills.tenantId, user.tenantId), eq(skills.id, id)))
    .returning({ id: skills.id });
  if (!removed.length) throw notFound();
}
