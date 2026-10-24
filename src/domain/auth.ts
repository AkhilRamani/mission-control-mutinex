import { createHash, randomBytes } from 'node:crypto';
import { and, eq, gt, sql } from 'drizzle-orm';
import type { Database } from '../db/client.js';
import { organisations, sessions, users } from '../db/schema.js';
import { AppError, forbidden, unauthenticated } from './errors.js';
import { dummyHash, hashPassword, verifyPassword } from './password.js';

const identityFields = {
  id: users.id, tenantId: users.tenantId, username: users.username,
  displayName: users.displayName, role: users.role,
  organisation: { slug: organisations.slug, name: organisations.name },
};
export type Identity = Awaited<ReturnType<typeof authenticate>>;
export function tokenHash(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

export async function login(db: Database, input: { organisation: string; username: string; password: string }) {
  return db.transaction(async (tx) => {
    const [account] = await tx.select({ ...identityFields, passwordHash: users.passwordHash })
      .from(users).innerJoin(organisations, eq(users.tenantId, organisations.id))
      .where(and(eq(organisations.slug, input.organisation), eq(users.username, input.username)))
      .for('update', { of: users });
    const valid = await verifyPassword(input.password, account?.passwordHash ?? dummyHash);
    if (!account || !valid) {
      throw new AppError(401, 'INVALID_CREDENTIALS', 'Invalid credentials.', 'Check organisation, username and password.');
    }
    const token = randomBytes(32).toString('base64url');
    const [session] = await tx.insert(sessions).values({
      tokenHash: tokenHash(token), tenantId: account.tenantId, userId: account.id,
      // Sample database time after the user lock, not transaction-start now().
      expiresAt: sql`clock_timestamp() + interval '24 hours'`,
    }).returning({ expiresAt: sessions.expiresAt });
    const { passwordHash: _passwordHash, ...user } = account;
    return { token, expiresAt: session!.expiresAt, user };
  });
}

export async function authenticate(db: Database, token: string) {
  if (!/^[A-Za-z0-9_-]{43}$/.test(token)) throw unauthenticated();
  const [user] = await db.select(identityFields).from(sessions)
    .innerJoin(users, and(eq(users.tenantId, sessions.tenantId), eq(users.id, sessions.userId)))
    .innerJoin(organisations, eq(organisations.id, users.tenantId))
    .where(and(eq(sessions.tokenHash, tokenHash(token)), gt(sessions.expiresAt, sql`clock_timestamp()`)));
  if (!user) throw unauthenticated();
  return user;
}

export async function logout(db: Database, user: Identity, token: string) {
  await db.delete(sessions).where(and(eq(sessions.tenantId, user.tenantId),
    eq(sessions.userId, user.id), eq(sessions.tokenHash, tokenHash(token))));
}

export async function changePassword(db: Database, user: Identity, token: string, oldPassword: string, newPassword: string) {
  await db.transaction(async (tx) => {
    const [account] = await tx.select({ passwordHash: users.passwordHash }).from(users)
      .where(and(eq(users.tenantId, user.tenantId), eq(users.id, user.id))).for('update');
    // A password change may have revoked this bearer while it waited on the lock.
    const [session] = await tx.select({ userId: sessions.userId }).from(sessions)
      .where(and(eq(sessions.tenantId, user.tenantId), eq(sessions.userId, user.id),
        eq(sessions.tokenHash, tokenHash(token)), gt(sessions.expiresAt, sql`clock_timestamp()`))).for('update');
    if (!account || !session) throw unauthenticated();
    if (!await verifyPassword(oldPassword, account.passwordHash)) {
      throw new AppError(401, 'INVALID_PASSWORD', 'Current password is incorrect.', 'Check your current password and retry.');
    }
    await tx.update(users).set({ passwordHash: await hashPassword(newPassword) })
      .where(and(eq(users.tenantId, user.tenantId), eq(users.id, user.id)));
    await tx.delete(sessions).where(and(eq(sessions.tenantId, user.tenantId), eq(sessions.userId, user.id)));
  });
}

export function requireDirector(user: Identity): void {
  if (user.role !== 'director') throw forbidden();
}
