import { getRequestListener } from '@hono/node-server';
import { createServer } from 'node:http';

import { createApp } from './api/app.js';
import { port, requiredEnv } from './config.js';
import { connectDatabase } from './db/client.js';

async function main() {
  const { db, pool } = connectDatabase(requiredEnv('DATABASE_URL'));
  try {
    const { rows } = await pool.query<{ rolsuper: boolean; rolcreatedb: boolean; rolcreaterole: boolean }>(
      'SELECT rolsuper, rolcreatedb, rolcreaterole FROM pg_roles WHERE rolname = current_user',
    );
    if (!rows[0] || rows[0].rolsuper || rows[0].rolcreatedb || rows[0].rolcreaterole) {
      throw new Error('Runtime requires an unprivileged database role.');
    }

    const server = createServer({ requestTimeout: 15000, headersTimeout: 10000 }, getRequestListener(createApp(db).fetch));
    for (const signal of ['SIGINT', 'SIGTERM'] as const) {
      process.once(signal, () => {
        server.close(() => { void pool.end(); });
        server.closeIdleConnections();
        setTimeout(() => process.exit(1), 10000).unref();
      });
    }

    server.on('error', () => {
      console.error('Server failed to listen. Check PORT.');
      void pool.end();
      process.exitCode = 1;
    });

    const listenPort = port();
    server.listen(listenPort, '127.0.0.1', () => {
      console.log(JSON.stringify({ event: 'listening', host: '127.0.0.1', port: listenPort }));
    });
  } catch {
    await pool.end();
    throw new Error('Startup failed. Check PORT, database readiness, migrations and runtime credentials.');
  }
}

main().catch((error: Error) => {
  console.error(error.message);
  process.exitCode = 1;
});
