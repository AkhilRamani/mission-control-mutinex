import { Hono } from 'hono';
import type { Handler, MiddlewareHandler } from 'hono';
import { z } from 'zod';
import type { Database } from '../db/client.js';
import { authenticate, changePassword, login, logout } from '../domain/auth.js';
import { unauthenticated } from '../domain/errors.js';
import type { Env } from './context.js';
import { newPassword, username, readJson } from './validation.js';

const password = z.string().min(1).max(128);
const loginInput = z.strictObject({
  organisation: z.string().trim().toLowerCase().max(64).regex(/^[a-z0-9]+(-[a-z0-9]+)*$/), username, password,
});
const passwordInput = z.strictObject({ oldPassword: password, newPassword });

export function loginHandler(db: Database, limit: () => void): Handler<Env> {
  return async (c) => {
    limit();
    const result = await login(db, await readJson(c, loginInput));
    c.set('user', result.user);
    return c.json(result);
  };
}

export function requireAuthentication(db: Database): MiddlewareHandler<Env> {
  return async (c, next) => {
    const header = c.req.header('authorization');
    if (!header?.startsWith('Bearer ')) throw unauthenticated();
    const token = header.slice(7);
    c.set('user', await authenticate(db, token));
    c.set('token', token);
    await next();
  };
}

export function authRoutes(db: Database, limit: () => void) {
  const app = new Hono<Env>();
  app.get('/me', (c) => c.json({ user: c.get('user') }));
  app.post('/auth/logout', async (c) => {
    await readJson(c, z.strictObject({}));
    await logout(db, c.get('user'), c.get('token'));
    return c.json({ message: 'Logged out.' });
  });
  app.put('/me/password', async (c) => {
    limit();
    const input = await readJson(c, passwordInput);
    await changePassword(db, c.get('user'), c.get('token'), input.oldPassword, input.newPassword);
    return c.json({ message: 'Password changed. All sessions revoked; log in again.' });
  });
  return app;
}
