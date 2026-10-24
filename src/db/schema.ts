import { sql } from 'drizzle-orm';
import { check, foreignKey, index, pgEnum, pgTable, text, timestamp, unique, uuid } from 'drizzle-orm/pg-core';

export const role = pgEnum('role', ['director', 'lead', 'crew']);

export const organisations = pgTable('organisations', {
  id: uuid('id').defaultRandom().primaryKey(),
  slug: text('slug').notNull().unique(),
  name: text('name').notNull(),
}, (t) => [
  check('organisation_slug', sql`${t.slug} ~ '^[a-z0-9]+(-[a-z0-9]+)*$' AND length(${t.slug}) <= 64`),
  check('organisation_name', sql`length(trim(${t.name})) BETWEEN 1 AND 120`),
]);

export const users = pgTable('users', {
  id: uuid('id').defaultRandom().primaryKey(),
  tenantId: uuid('tenant_id').notNull().references(() => organisations.id),
  username: text('username').notNull(),
  displayName: text('display_name').notNull(),
  passwordHash: text('password_hash').notNull(),
  role: role('role').notNull(),
}, (t) => [
  unique('users_tenant_id_id').on(t.tenantId, t.id),
  unique('users_tenant_username').on(t.tenantId, t.username),
  check('username_normalised', sql`${t.username} ~ '^[a-z0-9][a-z0-9._-]{0,63}$'`),
  check('user_display_name', sql`length(trim(${t.displayName})) BETWEEN 1 AND 120`),
  check('password_hash_present', sql`length(${t.passwordHash}) > 0`),
]);

export const sessions = pgTable('sessions', {
  tokenHash: text('token_hash').primaryKey(),
  tenantId: uuid('tenant_id').notNull(),
  userId: uuid('user_id').notNull(),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
}, (t) => [
  foreignKey({ columns: [t.tenantId, t.userId], foreignColumns: [users.tenantId, users.id] }),
  index('sessions_tenant_user').on(t.tenantId, t.userId),
  check('session_hash_format', sql`${t.tokenHash} ~ '^[a-f0-9]{64}$'`),
  check('session_expiry_finite', sql`isfinite(${t.expiresAt})`),
]);
