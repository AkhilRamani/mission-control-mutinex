import { afterAll, beforeAll, beforeEach } from 'vitest';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { sql } from 'drizzle-orm';
import { setTimeout as delay } from 'node:timers/promises';
import { assertLocalDatabase, requiredEnv } from '../src/config.js';
import { connectDatabase } from '../src/db/client.js';
import { seedDatabase } from '../src/db/fixtures.js';
import { availability, crew, crewSkills, organisations, skills, users } from '../src/db/schema.js';

// Integration files run serially against this dedicated database. Refuse unsafe targets before connecting.
export function useTestDatabase() {
  const runtimeUrl = requiredEnv('TEST_DATABASE_URL');
  const migrationUrl = requiredEnv('TEST_MIGRATION_DATABASE_URL');
  assertLocalDatabase(runtimeUrl, 'mission_control_test');
  assertLocalDatabase(migrationUrl, 'mission_control_test');
  if (new URL(runtimeUrl).username === new URL(migrationUrl).username) throw new Error('Use separate test runtime/migration roles.');
  const runtime = connectDatabase(runtimeUrl), migration = connectDatabase(migrationUrl);
  const truncate = sql`TRUNCATE mission_events, assignments, position_skills, positions, missions, availability, crew_skills, crew, skills, sessions, users, organisations`;
  const clear = () => migration.db.execute(truncate);
  async function snapshot() {
    return { organisations: await runtime.db.select().from(organisations), users: await runtime.db.select().from(users),
      crew: await runtime.db.select().from(crew), skills: await runtime.db.select().from(skills),
      levels: await runtime.db.select().from(crewSkills), availability: await runtime.db.select().from(availability) };
  }
  let fixtures: Awaited<ReturnType<typeof snapshot>>;
  beforeAll(async () => {
    await migrate(migration.db, { migrationsFolder: './drizzle' });
    await clear();
    await seedDatabase(runtime.db);
    fixtures = await snapshot();
  });
  beforeEach(async () => {
    // Restore real seed rows without rehashing unchanged passwords on every test.
    await migration.db.transaction(async (tx) => {
      await tx.execute(truncate);
      await tx.insert(organisations).values(fixtures.organisations);
      await tx.insert(users).values(fixtures.users);
      await tx.insert(skills).values(fixtures.skills);
      await tx.insert(crew).values(fixtures.crew);
      await tx.insert(crewSkills).values(fixtures.levels);
      await tx.insert(availability).values(fixtures.availability);
    });
  });
  afterAll(async () => { await Promise.all([runtime.pool.end(), migration.pool.end()]); });
  // Observe actual blocked requests. Files run serially with a dedicated runtime role.
  async function waitForLocks(count = 1) {
    const deadline = Date.now() + 3000;
    while (Date.now() < deadline) {
      const result = await runtime.pool.query("SELECT 1 FROM pg_stat_activity WHERE datname = current_database() AND usename = current_user AND wait_event_type = 'Lock'");
      if ((result.rowCount ?? 0) >= count) return;
      await delay(10);
    }
    throw new Error(`Expected ${count} blocked requests`);
  }
  return { runtime, runtimeUrl, waitForLocks, clear };
}
