import { drizzle } from 'drizzle-orm/node-postgres';
import pg from 'pg';

export function connectDatabase(url: string) {
  const pool = new pg.Pool({
    connectionString: url, max: 5, connectionTimeoutMillis: 3000,
    statement_timeout: 10000, lock_timeout: 5000, idle_in_transaction_session_timeout: 15000,
  });

  // Idle connection errors arrive outside query promises; never log connection URLs.
  pool.on('error', () => console.error(JSON.stringify({ event: 'database_connection_error' })));
  return { db: drizzle(pool), pool };
}

export type Database = ReturnType<typeof connectDatabase>['db'];
export type Transaction = Parameters<Parameters<Database['transaction']>[0]>[0];
