import { assertLocalDatabase, requiredEnv } from '../config.js';
import { connectDatabase } from './client.js';
import { seedDatabase } from './fixtures.js';

const url = requiredEnv('DATABASE_URL');
assertLocalDatabase(url, 'mission_control');
const { db, pool } = connectDatabase(url);
try {
  const now = new Date();
  await seedDatabase(db, now);
  console.log(`Seeded Atlas/Boreal demo data anchored to ${now.toISOString().slice(0, 10)} UTC. See README.md and WALKTHROUGH.md.`);
} catch {
  console.error('Seed failed: requires a migrated, empty local database. Existing data was not reset.');
  process.exitCode = 1;
} finally { await pool.end(); }
