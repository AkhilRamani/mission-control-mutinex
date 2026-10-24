import { sql } from 'drizzle-orm';
import { boolean, check, foreignKey, index, integer, jsonb, pgEnum, pgTable, primaryKey, text, timestamp, unique, uniqueIndex, uuid } from 'drizzle-orm/pg-core';

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

export const crew = pgTable('crew', {
  id: uuid('id').defaultRandom().primaryKey(),
  tenantId: uuid('tenant_id').notNull(),
  userId: uuid('user_id').notNull(),
  biography: text('biography').notNull().default(''),
  active: boolean('active').notNull().default(true),
}, (t) => [
  unique('crew_tenant_id_id').on(t.tenantId, t.id),
  unique('crew_tenant_user').on(t.tenantId, t.userId),
  foreignKey({ columns: [t.tenantId, t.userId], foreignColumns: [users.tenantId, users.id] }),
  check('crew_biography_length', sql`length(${t.biography}) <= 2000`),
]);

export const skills = pgTable('skills', {
  id: uuid('id').defaultRandom().primaryKey(),
  tenantId: uuid('tenant_id').notNull().references(() => organisations.id),
  name: text('name').notNull(),
}, (t) => [
  unique('skills_tenant_id_id').on(t.tenantId, t.id),
  unique('skills_tenant_name').on(t.tenantId, t.name),
  check('skill_name_normalised', sql`${t.name} = lower(trim(${t.name})) AND length(${t.name}) BETWEEN 1 AND 80`),
]);

export const crewSkills = pgTable('crew_skills', {
  tenantId: uuid('tenant_id').notNull(),
  crewId: uuid('crew_id').notNull(),
  skillId: uuid('skill_id').notNull(),
  proficiency: integer('proficiency').notNull(),
}, (t) => [
  primaryKey({ columns: [t.tenantId, t.crewId, t.skillId] }),
  foreignKey({ columns: [t.tenantId, t.crewId], foreignColumns: [crew.tenantId, crew.id] }),
  foreignKey({ columns: [t.tenantId, t.skillId], foreignColumns: [skills.tenantId, skills.id] }),
  index('crew_skills_tenant_skill').on(t.tenantId, t.skillId),
  check('crew_skill_proficiency', sql`${t.proficiency} BETWEEN 1 AND 5`),
]);

export const availability = pgTable('availability', {
  id: uuid('id').defaultRandom().primaryKey(),
  tenantId: uuid('tenant_id').notNull(),
  crewId: uuid('crew_id').notNull(),
  start: timestamp('start', { withTimezone: true }).notNull(),
  end: timestamp('end', { withTimezone: true }).notNull(),
}, (t) => [
  foreignKey({ columns: [t.tenantId, t.crewId], foreignColumns: [crew.tenantId, crew.id] }),
  index('availability_tenant_crew_start').on(t.tenantId, t.crewId, t.start),
  check('availability_interval', sql`isfinite(${t.start}) AND isfinite(${t.end}) AND ${t.start} < ${t.end}`),
]);

export const missionState = pgEnum('mission_state', ['draft', 'submitted', 'approved', 'completed', 'cancelled']);

export const missions = pgTable('missions', {
  id: uuid('id').defaultRandom().primaryKey(),
  tenantId: uuid('tenant_id').notNull(),
  ownerId: uuid('owner_id').notNull(),
  title: text('title').notNull(),
  brief: text('brief').notNull(),
  start: timestamp('start', { withTimezone: true }).notNull(),
  end: timestamp('end', { withTimezone: true }).notNull(),
  state: missionState('state').notNull().default('draft'),
  version: integer('version').notNull().default(1),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().default(sql`clock_timestamp()`),
}, (t) => [
  unique('missions_tenant_id_id').on(t.tenantId, t.id),
  foreignKey({ columns: [t.tenantId, t.ownerId], foreignColumns: [users.tenantId, users.id] }),
  index('missions_tenant_state').on(t.tenantId, t.state, t.id),
  check('mission_title', sql`length(trim(${t.title})) BETWEEN 1 AND 120`),
  check('mission_brief', sql`length(${t.brief}) <= 4000`),
  check('mission_interval', sql`isfinite(${t.start}) AND isfinite(${t.end}) AND ${t.start} < ${t.end}`),
  check('mission_version', sql`${t.version} >= 1`),
  check('mission_created_finite', sql`isfinite(${t.createdAt})`),
]);

export const positions = pgTable('positions', {
  id: uuid('id').defaultRandom().primaryKey(),
  tenantId: uuid('tenant_id').notNull(),
  missionId: uuid('mission_id').notNull(),
  ordinal: integer('ordinal').notNull(),
  label: text('label').notNull(),
  removedAt: timestamp('removed_at', { withTimezone: true }),
}, (t) => [
  unique('positions_tenant_mission_id').on(t.tenantId, t.missionId, t.id),
  unique('positions_tenant_mission_ordinal').on(t.tenantId, t.missionId, t.ordinal),
  foreignKey({ columns: [t.tenantId, t.missionId], foreignColumns: [missions.tenantId, missions.id] }),
  check('position_ordinal', sql`${t.ordinal} >= 1`),
  check('position_label', sql`length(trim(${t.label})) BETWEEN 1 AND 120`),
  check('position_removed_finite', sql`${t.removedAt} IS NULL OR isfinite(${t.removedAt})`),
]);

export const positionSkills = pgTable('position_skills', {
  tenantId: uuid('tenant_id').notNull(),
  missionId: uuid('mission_id').notNull(),
  positionId: uuid('position_id').notNull(),
  skillId: uuid('skill_id').notNull(),
  minProficiency: integer('min_proficiency').notNull(),
}, (t) => [
  primaryKey({ columns: [t.tenantId, t.missionId, t.positionId, t.skillId] }),
  foreignKey({ columns: [t.tenantId, t.missionId, t.positionId], foreignColumns: [positions.tenantId, positions.missionId, positions.id] }),
  foreignKey({ columns: [t.tenantId, t.skillId], foreignColumns: [skills.tenantId, skills.id] }),
  index('position_skills_tenant_skill').on(t.tenantId, t.skillId),
  check('position_skill_proficiency', sql`${t.minProficiency} BETWEEN 1 AND 5`),
]);

export const missionEvents = pgTable('mission_events', {
  id: uuid('id').defaultRandom().primaryKey(),
  tenantId: uuid('tenant_id').notNull(),
  missionId: uuid('mission_id').notNull(),
  missionVersion: integer('mission_version').notNull(),
  actorId: uuid('actor_id').notNull(),
  kind: text('kind').notNull(),
  occurredAt: timestamp('occurred_at', { withTimezone: true }).notNull().default(sql`clock_timestamp()`),
  payload: jsonb('payload').$type<Record<string, unknown>>().notNull(),
}, (t) => [
  unique('events_tenant_mission_version').on(t.tenantId, t.missionId, t.missionVersion),
  foreignKey({ columns: [t.tenantId, t.missionId], foreignColumns: [missions.tenantId, missions.id] }),
  foreignKey({ columns: [t.tenantId, t.actorId], foreignColumns: [users.tenantId, users.id] }),
  check('event_version', sql`${t.missionVersion} >= 1`),
  check('event_time_finite', sql`isfinite(${t.occurredAt})`),
  check('event_payload_object', sql`jsonb_typeof(${t.payload}) = 'object'`),
  check('event_kind', sql`${t.kind} IN ('mission_created', 'mission_updated', 'position_added', 'position_updated', 'position_removed', 'proposals_updated', 'assignment_responded', 'mission_submitted', 'mission_withdrawn', 'mission_rejected', 'mission_approved')`),
]);

export const assignmentState = pgEnum('assignment_state', ['proposed', 'accepted', 'declined', 'confirmed', 'withdrawn', 'released']);

export const assignments = pgTable('assignments', {
  id: uuid('id').defaultRandom().primaryKey(),
  tenantId: uuid('tenant_id').notNull(),
  missionId: uuid('mission_id').notNull(),
  positionId: uuid('position_id').notNull(),
  crewId: uuid('crew_id').notNull(),
  state: assignmentState('state').notNull().default('proposed'),
  respondedAt: timestamp('responded_at', { withTimezone: true }),
  bookedStart: timestamp('booked_start', { withTimezone: true }),
  bookedEnd: timestamp('booked_end', { withTimezone: true }),
}, (t) => [
  foreignKey({ columns: [t.tenantId, t.missionId, t.positionId], foreignColumns: [positions.tenantId, positions.missionId, positions.id] }),
  foreignKey({ columns: [t.tenantId, t.crewId], foreignColumns: [crew.tenantId, crew.id] }),
  uniqueIndex('assignments_current_position').on(t.tenantId, t.missionId, t.positionId)
    .where(sql`${t.state} IN ('proposed', 'accepted', 'confirmed')`),
  uniqueIndex('assignments_current_crew').on(t.tenantId, t.missionId, t.crewId)
    .where(sql`${t.state} IN ('proposed', 'accepted', 'confirmed')`),
  index('assignments_tenant_crew_mission').on(t.tenantId, t.crewId, t.missionId),
  index('assignments_tenant_mission_position').on(t.tenantId, t.missionId, t.positionId),
  check('assignment_response', sql`
    (${t.state} = 'proposed' AND ${t.respondedAt} IS NULL) OR
    (${t.state} IN ('accepted', 'declined', 'confirmed') AND ${t.respondedAt} IS NOT NULL AND isfinite(${t.respondedAt})) OR
    (${t.state} IN ('withdrawn', 'released') AND (${t.respondedAt} IS NULL OR isfinite(${t.respondedAt})))`),
  check('assignment_booking', sql`
    (${t.state} = 'confirmed' AND ${t.bookedStart} IS NOT NULL AND ${t.bookedEnd} IS NOT NULL
      AND isfinite(${t.bookedStart}) AND isfinite(${t.bookedEnd}) AND ${t.bookedStart} < ${t.bookedEnd}) OR
    (${t.state} <> 'confirmed' AND ${t.bookedStart} IS NULL AND ${t.bookedEnd} IS NULL)`),
  // btree_gist confirmed-booking exclusion is maintained in the SQL migration.
]);
