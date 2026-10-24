import { assertLocalDatabase, requiredEnv } from '../config.js';
import { connectDatabase } from './client.js';
import { seedDatabase } from './fixtures.js';

const url = requiredEnv('DATABASE_URL');
assertLocalDatabase(url, 'mission_control');
const { db, pool } = connectDatabase(url);
try {
  await seedDatabase(db);
  console.log('Seeded Atlas/Boreal accounts, crew, skills and availability. Local login details are in README.md.');
} catch {
  console.error('Seed failed: requires a migrated, empty local database. Existing data was not reset.');
  process.exitCode = 1;
} finally { await pool.end(); }
