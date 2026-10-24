import { randomUUID } from 'node:crypto';
import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { sql } from 'drizzle-orm';
import { z } from 'zod';
import type { Database } from '../db/client.js';
import { authenticate, changePassword, login, logout } from '../domain/auth.js';
import type { Identity } from '../domain/auth.js';
import { AppError, unauthenticated } from '../domain/errors.js';
import { loginInput, passwordInput, readJson } from './validation.js';
import { createAuthLimiter } from './rate-limit.js';

type Env = { Variables: { requestId: string; user: Identity; token: string } };
type Log = { requestId: string; method: string; route: string; status: number; durationMs: number; actorId?: string; tenantId?: string };

export function createApp(db: Database, options: { log?: (entry: Log) => void; now?: () => number } = {}) {
  const app = new Hono<Env>();
  const limit = createAuthLimiter(options.now);
  const log = options.log ?? ((entry: Log) => console.log(JSON.stringify(entry)));

  app.use('*', async (c, next) => {
    const start = performance.now();
    c.set('requestId', randomUUID());
    c.header('X-Request-Id', c.get('requestId'));
    c.header('Cache-Control', 'no-store');
    c.header('X-Content-Type-Options', 'nosniff');
    await next();
    const user = c.get('user');
    log({ requestId: c.get('requestId'), method: c.req.method,
      route: c.req.routePath ?? 'unmatched', status: c.res.status,
      durationMs: Math.round(performance.now() - start),
      ...(user ? { actorId: user.id, tenantId: user.tenantId } : {}),
    });
  });
  app.use('*', bodyLimit({ maxSize: 16 * 1024, onError: () => {
    throw new AppError(400, 'BODY_TOO_LARGE', 'Request body exceeds 16 KiB.', 'Reduce the request body.');
  } }));

  app.onError((error, c) => {
    let safe = error instanceof AppError ? error : undefined;
    // Drizzle wraps driver errors. Inspect codes only; never send/log SQL or driver text.
    const cause = error.cause ?? error;
    const code = typeof cause === 'object' && cause && 'code' in cause ? cause.code : undefined;
    if (!safe && ['40P01', '55P03', '57014'].includes(String(code))) {
      safe = new AppError(409, 'RETRYABLE_CONFLICT', 'The operation could not obtain a database lock in time.', 'Check the current state, then retry.');
    }
    if (!safe && (/^08/.test(String(code)) || ['ECONNREFUSED', 'ECONNRESET', 'EPIPE', '57P01', '57P02', '57P03'].includes(String(code)))) {
      safe = new AppError(503, 'SERVICE_UNAVAILABLE', 'Service temporarily unavailable.', 'Check database readiness and retry.');
    }
    safe ??= new AppError(500, 'INTERNAL_ERROR', 'An unexpected error occurred.', 'Use the request ID to locate the failed request in the server log.');
    if (safe.retryAfter !== undefined) c.header('Retry-After', String(safe.retryAfter));
    return c.json({ error: { code: safe.code, message: safe.message, recovery: safe.recovery, requestId: c.get('requestId') } }, safe.status);
  });
  app.notFound(() => {
    throw new AppError(404, 'NOT_FOUND', 'Resource not found.', 'Check the API path or list visible resources.');
  });

  app.get('/health', async (c) => {
    try {
      await db.execute(sql`select 1`);
      return c.json({ status: 'ok', database: 'ready' });
    } catch {
      return c.json({ status: 'unavailable', database: 'unavailable' }, 503);
    }
  });
  app.post('/v1/auth/login', async (c) => {
    limit();
    const result = await login(db, await readJson(c, loginInput));
    c.set('user', result.user);
    return c.json(result);
  });
  app.use('/v1/*', async (c, next) => {
    const header = c.req.header('authorization');
    if (!header?.startsWith('Bearer ')) throw unauthenticated();
    const token = header.slice(7);
    c.set('user', await authenticate(db, token));
    c.set('token', token);
    await next();
  });
  app.get('/v1/me', (c) => c.json({ user: c.get('user') }));
  app.post('/v1/auth/logout', async (c) => {
    await readJson(c, z.strictObject({}));
    await logout(db, c.get('user'), c.get('token'));
    return c.json({ message: 'Logged out.' });
  });
  app.put('/v1/me/password', async (c) => {
    limit();
    const input = await readJson(c, passwordInput);
    await changePassword(db, c.get('user'), c.get('token'), input.oldPassword, input.newPassword);
    return c.json({ message: 'Password changed. All sessions revoked; log in again.' });
  });
  return app;
}
