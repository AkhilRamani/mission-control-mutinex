import { beforeEach, describe, expect, it } from 'vitest';
import { serve } from '@hono/node-server';
import type { ServerType } from '@hono/node-server';
import { and, eq, sql } from 'drizzle-orm';
import { mkdtemp, readFile, rm, stat, chmod, symlink, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { connectDatabase } from '../src/db/client.js';
import { seedDatabase, seedPassword, tenantIds } from '../src/db/fixtures.js';
import { organisations, sessions, users } from '../src/db/schema.js';
import { createApp } from '../src/api/app.js';
import { authenticate, changePassword, login, tokenHash } from '../src/domain/auth.js';
import { useTestDatabase } from './database.js';
import { createCliRunner } from './cli-runner.js';

const { runtime, runtimeUrl } = useTestDatabase();
let app: ReturnType<typeof createApp>;
let logs: unknown[];

function request(path: string, method = 'GET', body?: unknown, token?: string, extraHeaders: Record<string, string> = {}) {
  return app.request(`http://localhost${path}`, { method,
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}), ...extraHeaders },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}
const credentials = (organisation = 'atlas', username = 'alex', password = seedPassword) => ({ organisation, username, password });
const signIn = (organisation = 'atlas', username = 'alex') => login(runtime.db, credentials(organisation, username));
type LoginResponse = Omit<Awaited<ReturnType<typeof login>>, 'expiresAt'> & { expiresAt: string };

beforeEach(() => {
  logs = [];
  app = createApp(runtime.db, { log: (entry) => logs.push(entry) });
});

describe('real PostgreSQL authentication', () => {
  it('logs in all roles in both tenants with explicit public identity fields', async () => {
    for (const organisation of ['atlas', 'boreal']) {
      for (const [username, role] of [['director', 'director'], ['lead', 'lead'], ['alex', 'crew']]) {
        const result = await request('/v1/auth/login', 'POST', credentials(organisation, username));
        expect(result.status).toBe(200);
        const body = await result.json() as LoginResponse;
        expect(body.user).toMatchObject({ role, tenantId: tenantIds[organisation as keyof typeof tenantIds] });
        expect(Object.keys(body.user).sort()).toEqual(['displayName', 'id', 'organisation', 'role', 'tenantId', 'username']);
        expect(body.user).not.toHaveProperty('passwordHash');
        const stored = await runtime.db.select().from(sessions).where(eq(sessions.tokenHash, tokenHash(body.token)));
        expect(stored).toHaveLength(1);
        expect(JSON.stringify(stored)).not.toContain(body.token);
        const expires = new Date(body.expiresAt).getTime() - Date.now();
        expect(expires).toBeGreaterThan(23.99 * 3600000);
        expect(expires).toBeLessThanOrEqual(24 * 3600000);
      }
    }
    expect(JSON.stringify(logs)).not.toContain(seedPassword);
    expect(logs).toContainEqual(expect.objectContaining({ route: '/v1/auth/login', status: 200, tenantId: tenantIds.atlas }));
  });

  it('normalises login names and ignores forged tenant/role headers and query identity', async () => {
    const result = await request('/v1/auth/login', 'POST', credentials(' ATLAS ', ' ALEX '));
    const { token, user } = await result.json() as LoginResponse;
    const me = await request(`/v1/me?tenantId=${tenantIds.boreal}&userId=someone-else`, 'GET', undefined, token,
      { 'x-tenant-id': tenantIds.boreal, 'x-role': 'director' });
    expect(me.status).toBe(200);
    expect(await me.json()).toEqual({ user });
    expect(user.tenantId).toBe(tenantIds.atlas);
    const forged = await request('/v1/auth/login', 'POST', { ...credentials(), tenantId: tenantIds.boreal });
    expect(forged.status).toBe(400);
  });

  it('uses identical errors for wrong passwords, unknown accounts and unknown tenants', async () => {
    const errors = [];
    for (const input of [credentials('atlas', 'alex', 'wrong'), credentials('atlas', 'missing'), credentials('missing', 'alex')]) {
      const response = await request('/v1/auth/login', 'POST', input);
      expect(response.status).toBe(401);
      const { error } = await response.json() as { error: { requestId: string; code: string; message: string; recovery: string } };
      expect(error.requestId).toBe(response.headers.get('x-request-id'));
      const { requestId: _requestId, ...rest } = error;
      errors.push(rest);
    }
    expect(errors[0]).toEqual(errors[1]);
    expect(errors[1]).toEqual(errors[2]);
  });

  it('rejects missing, malformed, expired and deleted tokens; logout affects only that session', async () => {
    const first = await signIn(); const other = await signIn();
    expect((await request('/v1/me')).status).toBe(401);
    expect((await request('/v1/me', 'GET', undefined, 'garbage')).status).toBe(401);
    expect((await request('/v1/auth/logout', 'POST', {}, first.token)).status).toBe(200);
    expect((await request('/v1/me', 'GET', undefined, first.token)).status).toBe(401);
    expect((await request('/v1/me', 'GET', undefined, other.token)).status).toBe(200);
    await runtime.db.update(sessions).set({ expiresAt: new Date(0) }).where(eq(sessions.tokenHash, tokenHash(other.token)));
    expect((await request('/v1/me', 'GET', undefined, other.token)).status).toBe(401);
  });

  it('changes only the authenticated password and revokes every session of that user', async () => {
    const first = await signIn(); const second = await signIn(); const foreign = await signIn('boreal');
    expect((await request('/v1/me/password', 'PUT', { oldPassword: 'wrong', newPassword: 'replacement-password' }, first.token)).status).toBe(401);
    expect((await request('/v1/me/password', 'PUT', { oldPassword: seedPassword, newPassword: 'short' }, first.token)).status).toBe(400);
    expect((await request('/v1/me/password', 'PUT', { oldPassword: seedPassword, newPassword: 'replacement-password', userId: foreign.user.id }, first.token)).status).toBe(400);
    expect((await request('/v1/me/password', 'PUT', { oldPassword: seedPassword, newPassword: 'replacement-password' }, first.token)).status).toBe(200);
    for (const token of [first.token, second.token]) expect((await request('/v1/me', 'GET', undefined, token)).status).toBe(401);
    expect((await request('/v1/me', 'GET', undefined, foreign.token)).status).toBe(200);
    await expect(signIn()).rejects.toMatchObject({ code: 'INVALID_CREDENTIALS' });
    await expect(login(runtime.db, credentials('atlas', 'alex', 'replacement-password'))).resolves.toBeDefined();
  });

  it('enforces tenant-qualified session references and non-owner runtime privileges', async () => {
    const session = await signIn();
    await expect(runtime.db.insert(sessions).values({ tokenHash: 'a'.repeat(64), tenantId: tenantIds.boreal,
      userId: session.user.id, expiresAt: new Date(Date.now() + 10000) })).rejects.toMatchObject({ cause: { code: '23503' } });
    await expect(runtime.db.insert(users).values({ tenantId: tenantIds.atlas, displayName: 'Invalid', role: 'crew',
      username: 'UPPER', passwordHash: 'hash' })).rejects.toMatchObject({ cause: { code: '23514', constraint: 'username_normalised' } });
    await expect(runtime.db.insert(users).values({ tenantId: tenantIds.atlas, displayName: 'Duplicate', role: 'crew',
      username: 'alex', passwordHash: 'hash' })).rejects.toMatchObject({ cause: { code: '23505' } });
    await expect(runtime.db.execute(sql`CREATE TABLE forbidden_runtime_ddl (id int)`)).rejects.toThrow();
    const result = await runtime.pool.query('SELECT rolsuper, rolcreatedb, rolcreaterole FROM pg_roles WHERE rolname = current_user');
    expect(result.rows[0]).toEqual({ rolsuper: false, rolcreatedb: false, rolcreaterole: false });
  });

  it('rejects malformed/oversized input and returns safe readiness errors', async () => {
    expect((await app.request('/v1/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{' })).status).toBe(400);
    expect((await request('/v1/auth/login', 'POST', { password: 'x'.repeat(17000) })).status).toBe(400);
    expect((await request('/health')).status).toBe(200);
    const offline = connectDatabase('postgres://unused:secret@127.0.0.1:1/unknown');
    try {
      const response = await createApp(offline.db, { log: () => {} }).request('/health');
      expect(response.status).toBe(503);
      expect(await response.json()).toEqual({ status: 'unavailable', database: 'unavailable' });
      const failedLogin = await createApp(offline.db, { log: () => {} }).request('/v1/auth/login', {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(credentials()),
      });
      expect(failedLogin.status).toBe(503);
      const text = await failedLogin.text();
      for (const privateDetail of ['secret', 'ECONNREFUSED', 'SELECT', 'password_hash', seedPassword]) expect(text).not.toContain(privateDetail);
    } finally { await offline.pool.end(); }
  });

  it('shares one budget across login/password changes and reports the remaining wait', async () => {
    let now = 1000;
    app = createApp(runtime.db, { log: () => {}, now: () => now });
    const { token } = await signIn();
    for (let i = 0; i < 9; i++) {
      await request('/v1/auth/login', 'POST', {}, undefined, { 'x-forwarded-for': `10.0.0.${i}` });
    }
    expect((await request('/v1/me/password', 'PUT', {}, token)).status).toBe(400);
    now += 59000;
    const response = await request('/v1/auth/login', 'POST', credentials());
    expect(response.status).toBe(429);
    expect(response.headers.get('retry-after')).toBe('1');
    expect(await response.json()).toMatchObject({ error: { recovery: 'Retry in 1s.' } });
    expect((await request('/v1/me/password', 'PUT', {}, token)).status).toBe(429);
    expect((await request('/v1/me', 'GET', undefined, token)).status).toBe(200);
  });

  it('refuses reseeding and preserves existing identities', async () => {
    await expect(seedDatabase(runtime.db)).rejects.toThrow('already contains');
    expect(await runtime.db.select().from(organisations)).toHaveLength(2);
    expect(await runtime.db.select().from(users)).toHaveLength(8);
  });
});

async function waitForLock(name: string) {
  const deadline = Date.now() + 4000;
  while (Date.now() < deadline) {
    const result = await runtime.pool.query("SELECT 1 FROM pg_stat_activity WHERE application_name = $1 AND wait_event_type = 'Lock'", [name]);
    if (result.rowCount) return;
    await delay(10);
  }
  throw new Error(`Expected blocked database operation: ${name}`);
}

describe('deterministic password/login races', () => {
  it.each(['login-first', 'change-first'])('%s cannot leave a session authenticated with an obsolete password', async (order) => {
    const existing = await signIn();
    const clientA = new URL(runtimeUrl); clientA.searchParams.set('application_name', 'race-a');
    const clientB = new URL(runtimeUrl); clientB.searchParams.set('application_name', 'race-b');
    const a = connectDatabase(clientA.toString()), b = connectDatabase(clientB.toString());
    const blocker = await runtime.pool.connect();
    const settledLogin = (db: typeof runtime.db) => login(db, credentials()).then((value) => ({ value }), (error: unknown) => ({ error }));
    try {
      await blocker.query('BEGIN');
      await blocker.query('SELECT id FROM users WHERE tenant_id = $1 AND id = $2 FOR UPDATE', [existing.user.tenantId, existing.user.id]);
      const first = order === 'login-first' ? settledLogin(a.db)
        : changePassword(a.db, existing.user, existing.token, seedPassword, 'changed-race-password');
      await waitForLock('race-a');
      const second = order === 'login-first'
        ? changePassword(b.db, existing.user, existing.token, seedPassword, 'changed-race-password') : settledLogin(b.db);
      await waitForLock('race-b');
      await blocker.query('COMMIT');
      const outcomes = await Promise.all([first, second]);
      const outcome = outcomes[order === 'login-first' ? 0 : 1];
      if (order === 'login-first') {
        expect(outcome).toHaveProperty('value');
        if (outcome && 'value' in outcome) await expect(authenticate(runtime.db, outcome.value.token)).rejects.toMatchObject({ code: 'UNAUTHENTICATED' });
      } else { expect(outcome).toMatchObject({ error: { code: 'INVALID_CREDENTIALS' } }); }
      expect(await runtime.db.select().from(sessions).where(and(eq(sessions.tenantId, existing.user.tenantId), eq(sessions.userId, existing.user.id)))).toHaveLength(0);
      await expect(login(runtime.db, credentials('atlas', 'alex', 'changed-race-password'))).resolves.toBeDefined();
    } finally {
      await blocker.query('ROLLBACK'); blocker.release();
      await Promise.all([a.pool.end(), b.pool.end()]);
    }
  });

  it('rechecks a revoked session even when its caller already authenticated', async () => {
    const session = await signIn();
    const user = await authenticate(runtime.db, session.token);
    await changePassword(runtime.db, user, session.token, seedPassword, 'changed-password-one');
    await expect(changePassword(runtime.db, user, session.token, 'changed-password-one', 'changed-password-two'))
      .rejects.toMatchObject({ code: 'UNAUTHENTICATED' });
  });
});

describe('real CLI over HTTP', () => {
  it('completes login/whoami/password/logout, retains sessions across server restart and protects secrets', async () => {
    const configDir = await mkdtemp(join(tmpdir(), 'mission-control-cli-'));
    let server: ServerType | undefined;
    const start = (port = 0) => new Promise<number>((resolvePort) => {
      server = serve({ fetch: app.fetch, hostname: '127.0.0.1', port }, (info) => resolvePort(info.port));
    });
    const stop = () => new Promise<void>((resolveStop, reject) => server!.close((error) => error ? reject(error) : resolveStop()));
    const port = await start();
    const cli = createCliRunner(configDir, `http://127.0.0.1:${port}`);
    try {
      const login = await cli(['login', '--org', 'atlas', '--username', 'alex', '--password-stdin'], `${seedPassword}\n`);
      expect(login.code, login.stderr).toBe(0);
      const file = join(configDir, 'session.json');
      const stored = JSON.parse(await readFile(file, 'utf8'));
      expect((await stat(file)).mode & 0o777).toBe(0o600);
      expect((await stat(configDir)).mode & 0o777).toBe(0o700);
      expect(login.stdout + login.stderr).not.toContain(stored.token);
      expect(login.stdout + login.stderr).not.toContain(seedPassword);
      await stop(); await start(port);
      const me = await cli(['whoami']);
      expect(me.code, me.stderr).toBe(0);
      expect(JSON.parse(me.stdout).user.organisation.slug).toBe('atlas');
      await chmod(file, 0o644);
      const unsafeFile = await cli(['whoami']);
      expect(unsafeFile.code).toBe(1);
      expect(JSON.parse(unsafeFile.stderr)).toMatchObject({ error: { code: 'STORAGE_ERROR', message: expect.stringContaining('600') } });
      await chmod(file, 0o600);
      const original = await readFile(file, 'utf8');
      const target = join(configDir, 'private-session.json');
      await writeFile(target, original, { mode: 0o600 });
      await unlink(file); await symlink(target, file);
      expect((await cli(['whoami'])).code).toBe(1);
      await unlink(file); await writeFile(file, original, { mode: 0o600 });
      const changed = await cli(['password', 'change', '--password-stdin'], `${seedPassword}\nchanged-cli-password\n`);
      expect(changed.code, changed.stderr).toBe(0);
      await expect(stat(file)).rejects.toMatchObject({ code: 'ENOENT' });
      expect((await cli(['whoami'])).code).toBe(1);
      const old = await cli(['login', '--org', 'atlas', '--username', 'alex', '--password-stdin'], `${seedPassword}\n`);
      expect(old.code).toBe(1); expect(old.stdout).toBe('');
      expect(JSON.parse(old.stderr).error.code).toBe('INVALID_CREDENTIALS');
      expect((await cli(['login', '--org', 'atlas', '--username', 'alex', '--password-stdin'], 'changed-cli-password\n')).code).toBe(0);
      await stop();
      const offlineLogout = await cli(['logout']);
      expect(offlineLogout.code).toBe(1);
      expect(JSON.parse(offlineLogout.stderr).error.code).toBe('NETWORK_ERROR');
      expect(await stat(file)).toBeDefined();
      await start(port);
      expect((await cli(['logout'])).code).toBe(0);
      expect((await cli(['logout'])).code).toBe(0);
      expect((await cli(['whoami'])).code).toBe(1);
      expect(JSON.stringify(logs)).not.toContain(stored.token);
      expect(JSON.stringify(logs)).not.toContain('changed-cli-password');
    } finally { await stop(); await rm(configDir, { recursive: true, force: true }); }
  });
});
