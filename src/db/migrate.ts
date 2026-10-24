import { migrate } from 'drizzle-orm/node-postgres/migrator';

import { requiredEnv } from '../config.js';
import { connectDatabase } from './client.js';

const { db, pool } = connectDatabase(requiredEnv('MIGRATION_DATABASE_URL'));
try {
  await migrate(db, { migrationsFolder: './drizzle' });
  console.log('Migrations applied.');
} catch {
  console.error('Migration failed. Check the migration credentials, database readiness and SQL files.');
  process.exitCode = 1;
} finally {
  await pool.end();
}
