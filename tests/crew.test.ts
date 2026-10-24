import { beforeEach, describe, expect, it } from 'vitest';
import { and, eq, sql } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { serve } from '@hono/node-server';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../src/api/app.js';
import { connectDatabase } from '../src/db/client.js';
import { availability, crew, crewSkills, skills, users } from '../src/db/schema.js';
import { seedPassword, tenantIds } from '../src/db/fixtures.js';
import { login } from '../src/domain/auth.js';
import { useTestDatabase } from './database.js';
import { createCliRunner } from './cli-runner.js';

const { runtime, runtimeUrl } = useTestDatabase();
const ids = {
  alex: '10000000-0000-4000-8003-000000000004', sam: '10000000-0000-4000-8003-000000000005',
  lead: '10000000-0000-4000-8003-000000000003', boreal: '20000000-0000-4000-8003-000000000003',
  pilot: '10000000-0000-4000-8002-000000000001', medical: '10000000-0000-4000-8002-000000000002',
  foreignSkill: '20000000-0000-4000-8002-000000000001',
  alexWindow: '10000000-0000-4000-8004-000000000004', samWindow: '10000000-0000-4000-8004-000000000005',
  foreignWindow: '20000000-0000-4000-8004-000000000003',
};
const window = { start: '2030-03-01T09:00:00Z', end: '2030-03-01T10:00:00Z' };
let app: ReturnType<typeof createApp>;
let tokens: Map<string, string>;
let logs: unknown[];
beforeEach(() => { tokens = new Map(); logs = []; app = createApp(runtime.db, { log: (entry) => logs.push(entry) }); });
async function token(actor: string) {
  if (!tokens.has(actor)) {
    const [organisation, username] = actor.split('/');
    const session = await login(runtime.db, { organisation: organisation!, username: username!, password: seedPassword });
    tokens.set(actor, session.token);
  }
  return tokens.get(actor)!;
}
async function request(actor: string, path: string, method = 'GET', body?: unknown) {
  return app.request(`/v1${path}`, { method,
    headers: { authorization: `Bearer ${await token(actor)}`, 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}
async function ok(actor: string, path: string, method = 'GET', body?: unknown) {
  const response = await request(actor, path, method, body);
  const data = JSON.parse(await response.text());
  expect(response.status, JSON.stringify(data)).toBeLessThan(300);
  return data;
}
async function error(actor: string, path: string, method = 'GET', body?: unknown, status = 404) {
  const response = await request(actor, path, method, body);
  const data = JSON.parse(await response.text());
  expect(response.status, JSON.stringify(data)).toBe(status);
  const { requestId, ...safe } = data.error;
  expect(requestId).toBeTruthy();
  return safe;
}

describe('organisation, members and crew permissions', () => {
  it('requires authentication for every registered protected route and HTTP method', async () => {
    for (const route of app.routes) {
      if (route.method === 'ALL' || route.path === '/health' || route.path === '/v1/auth/login') continue;
      const path = route.path.replace(/:[^/]+/g, ids.alex);
      const response = await app.request(path, { method: route.method });
      expect(response.status, `${route.method} ${route.path}`).toBe(401);
    }
  });

  it('provisions an account/profile; the owner declares skills and availability; a Lead discovers them', async () => {
    const member = await ok('atlas/director', '/members', 'POST', {
      username: ' NEW.CREW ', displayName: 'New Crew', role: 'crew', password: 'created-password-123',
    });
    expect(member).toMatchObject({ username: 'new.crew', role: 'crew' });
    expect(Object.keys(member).sort()).toEqual(['displayName', 'id', 'role', 'username']);
    expect((await request('atlas/director', '/crew', 'POST', { userId: member.id })).status).toBe(201);
    const session = await login(runtime.db, { organisation: 'atlas', username: 'new.crew', password: 'created-password-123' });
    tokens.set('atlas/new.crew', session.token);
    const own = await ok('atlas/new.crew', '/crew/me');
    await ok('atlas/new.crew', '/crew/me', 'PATCH', { displayName: 'New Pilot', biography: 'Crew biography' });
    expect((await ok('atlas/new.crew', '/me')).user.displayName).toBe('New Pilot');
    await ok('atlas/new.crew', `/crew/me/skills/${ids.pilot}`, 'PUT', { proficiency: 3 });
    await ok('atlas/new.crew', '/crew/me/availability', 'POST', window);
    const found = await ok('atlas/lead', '/crew?q=New%20Pilot');
    expect(found.items).toHaveLength(1);
    expect(found.items[0]).toMatchObject({ id: own.id, displayName: 'New Pilot' });
    expect((await ok('atlas/lead', `/crew/${own.id}`)).skills).toEqual([{ id: ids.pilot, name: 'piloting', proficiency: 3 }]);
    expect((await ok('atlas/lead', `/crew/${own.id}/availability`)).items).toHaveLength(1);
    expect(JSON.stringify(logs)).not.toContain('created-password-123');
    expect(JSON.stringify(logs)).not.toContain('Crew biography');
  });

  it('restricts account and organisation administration to Directors and preserves the login slug', async () => {
    await ok('atlas/director', '/organisation', 'PATCH', { name: 'Atlas Operations' });
    expect(await ok('atlas/alex', '/organisation')).toMatchObject({ name: 'Atlas Operations', slug: 'atlas' });
    expect(await ok('boreal/director', '/organisation')).toMatchObject({ name: 'Boreal', slug: 'boreal' });
    for (const actor of ['atlas/lead', 'atlas/alex']) {
      await error(actor, '/organisation', 'PATCH', { name: 'Forbidden' }, 403);
      await error(actor, '/members', 'GET', undefined, 403);
      await error(actor, '/members', 'POST', { username: 'no', displayName: 'No', role: 'crew', password: seedPassword }, 403);
      await error(actor, '/crew', 'POST', { userId: '10000000-0000-4000-8001-000000000001' }, 403);
    }
    await error('atlas/director', '/organisation', 'PATCH', { name: 'Atlas', slug: 'changed' }, 400);
    await error('atlas/director', '/members', 'POST', { username: 'bad', displayName: 'Bad', role: 'crew', password: 'short' }, 400);
    const duplicate = await error('atlas/director', '/members', 'POST', { username: 'ALEX', displayName: 'Duplicate', role: 'crew', password: seedPassword }, 409);
    expect(duplicate.code).toBe('ALREADY_EXISTS');
    expect(JSON.stringify(duplicate)).not.toMatch(/constraint|password_hash|tenant_id/);
    const created = await ok('atlas/director', '/members', 'POST', { username: 'boreal-only', displayName: 'Local', role: 'director', password: seedPassword });
    expect(created.role).toBe('director');
    await error('atlas/director', '/members', 'POST', { username: 'bad', displayName: 'Bad', role: 'crew', password: seedPassword, tenantId: tenantIds.boreal }, 400);
  });

  it('hides foreign IDs and same-tenant peers, including child routes and identical error responses', async () => {
    const missing = randomUUID();
    const baseline = await error('atlas/alex', `/crew/${missing}`);
    for (const id of [ids.sam, ids.boreal, missing]) {
      expect(await error('atlas/alex', `/crew/${id}`)).toEqual(baseline);
      expect(await error('atlas/alex', `/crew/${id}/availability`)).toEqual(baseline);
      expect(await error('atlas/alex', `/crew/${id}`, 'PATCH', { biography: 'hidden' })).toEqual(baseline);
      expect(await error('atlas/alex', `/crew/${id}/skills/${ids.pilot}`, 'PUT', { proficiency: 5 })).toEqual(baseline);
      expect(await error('atlas/alex', `/crew/${id}/availability`, 'POST', window)).toEqual(baseline);
      expect(await error('atlas/alex', `/crew/${id}/skills/${ids.pilot}`, 'DELETE')).toEqual(baseline);
      expect(await error('atlas/alex', `/crew/${id}/availability/${ids.samWindow}`, 'DELETE')).toEqual(baseline);
    }
    for (const actor of ['atlas/director', 'atlas/lead']) {
      expect(await error(actor, `/crew/${ids.boreal}`)).toEqual(baseline);
      expect(await error(actor, `/crew/${ids.boreal}/availability`)).toEqual(baseline);
    }
    for (const userId of ['20000000-0000-4000-8001-000000000003', missing]) {
      expect(await error('atlas/director', '/crew', 'POST', { userId })).toEqual(baseline);
    }
    expect((await ok('atlas/alex', '/crew')).items.map((c: { id: string }) => c.id)).toEqual([ids.alex]);
    expect((await ok('atlas/alex', '/crew?q=Sam')).items).toEqual([]);
    expect((await ok('atlas/alex', '/crew?q=Boreal')).items).toEqual([]);
  });

  it('allows own profile edits for any role and Director metadata edits, but only owner skills/availability', async () => {
    await ok('atlas/lead', '/crew/me', 'PATCH', { biography: 'Lead bio' });
    await ok('atlas/lead', `/crew/me/skills/${ids.pilot}`, 'PUT', { proficiency: 2 });
    await ok('atlas/lead', '/crew/me/availability', 'POST', window);
    await error('atlas/lead', `/crew/${ids.alex}`, 'PATCH', { biography: 'No' }, 403);
    await error('atlas/alex', '/crew/me', 'PATCH', { active: false }, 403);
    await error('atlas/lead', '/crew/me', 'PATCH', { active: true }, 403);
    await ok('atlas/director', `/crew/${ids.alex}`, 'PATCH', { displayName: 'Alex Changed', biography: 'Updated', active: false });
    expect(await ok('atlas/alex', '/crew/me')).toMatchObject({ active: false, displayName: 'Alex Changed', biography: 'Updated' });
    for (const actor of ['atlas/director', 'atlas/lead']) {
      await error(actor, `/crew/${ids.alex}/skills/${ids.pilot}`, 'PUT', { proficiency: 5 }, 403);
      await error(actor, `/crew/${ids.alex}/skills/${ids.pilot}`, 'DELETE', undefined, 403);
      await error(actor, `/crew/${ids.alex}/availability`, 'POST', window, 403);
      await error(actor, `/crew/${ids.alex}/availability/${ids.alexWindow}`, 'DELETE', undefined, 403);
    }
    const director = (await ok('atlas/director', '/me')).user;
    await ok('atlas/director', '/crew', 'POST', { userId: director.id });
    await ok('atlas/director', '/crew/me', 'PATCH', { biography: 'Director crew' });
    await ok('atlas/director', `/crew/me/skills/${ids.pilot}`, 'PUT', { proficiency: 3 });
    await ok('atlas/director', '/crew/me/availability', 'POST', window);
    await error('atlas/director', '/crew', 'POST', { userId: director.id }, 409);
  });

  it('scopes literal search and stable pagination, with strict bounds and explicit response fields', async () => {
    const first = await ok('atlas/lead', '/crew?limit=1');
    const second = await ok('atlas/lead', `/crew?limit=1&offset=${first.nextOffset}`);
    expect(first.nextOffset).toBe(1);
    expect(second.items[0].id).not.toBe(first.items[0].id);
    expect((await ok('atlas/lead', '/crew?offset=3')).nextOffset).toBeNull();
    expect(Object.keys(first.items[0]).sort()).toEqual(['active', 'biography', 'displayName', 'id', 'role', 'userId', 'username']);
    expect((await ok('atlas/lead', '/crew?q=aLeX')).items.map((c: { id: string }) => c.id)).toEqual([ids.alex]);
    expect((await ok('atlas/lead', '/crew?q=%25')).items).toEqual([]);
    expect((await ok('atlas/lead', '/crew?q=%27%20OR%201%3D1')).items).toEqual([]);
    expect((await ok('atlas/director', '/members?q=alex')).items).toHaveLength(1);
    expect((await ok('boreal/director', '/members?q=director2')).items).toEqual([]);
    expect((await ok('atlas/alex', '/skills?q=survival')).items).toEqual([]);
    expect((await ok('boreal/alex', '/skills?q=medical')).items).toEqual([]);
    expect((await ok('atlas/alex', '/skills?limit=1')).nextOffset).toBe(1);
    await runtime.db.insert(skills).values(Array.from({ length: 30 }, (_, i) => ({ tenantId: tenantIds.atlas, name: `page-${String(i).padStart(2, '0')}` })));
    const defaultPage = await ok('atlas/alex', '/skills?q=page-');
    expect(defaultPage.items).toHaveLength(25); expect(defaultPage.nextOffset).toBe(25);
    expect((await ok('atlas/alex', '/skills?q=page-&offset=25')).items).toHaveLength(5);
    expect((await ok('boreal/alex', '/skills?q=page-')).items).toEqual([]);
    for (const suffix of ['?limit=0', '?limit=101', '?limit=1.5', '?offset=-1', '?offset=999999999999', '?tenantId=x']) {
      await error('atlas/director', `/crew${suffix}`, 'GET', undefined, 400);
    }
    await error('atlas/alex', '/crew/me', 'PATCH', {}, 400);
    await error('atlas/alex', '/crew/me', 'PATCH', { userId: randomUUID(), biography: 'No' }, 400);
    await error('atlas/alex', '/crew/not-a-uuid', 'GET', undefined, 400);
    await error('atlas/director', '/crew/me'); // No optional profile yet.
  });
});

describe('skills, availability and database constraints', () => {
  it('normalises skill names, restricts catalogue changes and prevents deletion of referenced skills', async () => {
    const skill = await ok('atlas/director', '/skills', 'POST', { name: ' Navigation ' });
    expect(skill.name).toBe('navigation');
    await error('atlas/director', '/skills', 'POST', { name: 'NAVIGATION' }, 409);
    await ok('boreal/director', '/skills', 'POST', { name: 'navigation' });
    for (const actor of ['atlas/lead', 'atlas/alex']) {
      await error(actor, '/skills', 'POST', { name: 'No' }, 403);
      await error(actor, `/skills/${skill.id}`, 'PATCH', { name: 'No' }, 403);
      await error(actor, `/skills/${skill.id}`, 'DELETE', undefined, 403);
    }
    await ok('atlas/director', `/skills/${skill.id}`, 'PATCH', { name: 'Navigation Basics' });
    await ok('atlas/alex', `/crew/me/skills/${skill.id}`, 'PUT', { proficiency: 3 });
    await ok('atlas/alex', `/crew/me/skills/${skill.id}`, 'PUT', { proficiency: 4 });
    expect((await ok('atlas/alex', '/crew/me')).skills.filter((s: { id: string }) => s.id === skill.id)).toEqual([
      { id: skill.id, name: 'navigation basics', proficiency: 4 },
    ]);
    expect((await error('atlas/director', `/skills/${skill.id}`, 'DELETE', undefined, 409)).code).toBe('REFERENCE_CONFLICT');
    await ok('atlas/alex', `/crew/me/skills/${skill.id}`, 'DELETE');
    await error('atlas/alex', `/crew/me/skills/${skill.id}`, 'DELETE');
    await ok('atlas/director', `/skills/${skill.id}`, 'DELETE');
    await error('atlas/director', `/skills/${skill.id}`, 'DELETE');
    for (const id of [ids.foreignSkill, randomUUID()]) {
      await error('atlas/director', `/skills/${id}`, 'PATCH', { name: 'hidden' });
      await error('atlas/director', `/skills/${id}`, 'DELETE');
      await error('atlas/alex', `/crew/me/skills/${id}`, 'PUT', { proficiency: 3 });
      await error('atlas/alex', `/crew/me/skills/${id}`, 'DELETE');
    }
    for (const proficiency of [0, 6, 1.5, '3']) await error('atlas/alex', `/crew/me/skills/${ids.pilot}`, 'PUT', { proficiency }, 400);
  });

  it('preserves offset instants, permits overlap/adjacency and checks the parent on every removal', async () => {
    const added = await ok('atlas/alex', '/crew/me/availability', 'POST', { start: '2030-03-01T20:00:00+11:00', end: '2030-03-01T21:00:00+11:00' });
    expect(added).toEqual({ id: expect.any(String), start: '2030-03-01T09:00:00.000Z', end: '2030-03-01T10:00:00.000Z' });
    await ok('atlas/alex', '/crew/me/availability', 'POST', { start: window.end, end: '2030-03-01T11:00:00Z' });
    await ok('atlas/alex', '/crew/me/availability', 'POST', window);
    const page = await ok('atlas/alex', '/crew/me/availability?limit=2');
    expect(page.items).toHaveLength(2); expect(page.nextOffset).toBe(2);
    for (const id of [ids.samWindow, ids.foreignWindow, randomUUID()]) {
      await error('atlas/alex', `/crew/me/availability/${id}`, 'DELETE');
    }
    await error('atlas/director', `/crew/${ids.sam}/availability/${added.id}`, 'DELETE');
    await ok('atlas/alex', `/crew/me/availability/${added.id}`, 'DELETE');
    await error('atlas/alex', `/crew/me/availability/${added.id}`, 'DELETE');
    for (const invalid of [
      { start: window.end, end: window.start }, { start: window.start, end: window.start },
      { start: '2030-03-01T09:00:00', end: window.end }, { start: 'infinity', end: window.end },
      { start: '2030-02-30T09:00:00Z', end: window.end }, { ...window, crewId: ids.sam },
    ]) await error('atlas/alex', '/crew/me/availability', 'POST', invalid, 400);
  });

  it('enforces composite FKs, uniqueness, proficiency and finite intervals even outside the API', async () => {
    const tenantId = tenantIds.atlas;
    const wrongTenant = { tenantId: tenantIds.boreal, crewId: ids.alex };
    await expect(runtime.db.insert(crew).values({ tenantId: tenantIds.boreal, userId: '10000000-0000-4000-8001-000000000004' }))
      .rejects.toMatchObject({ cause: { code: '23503' } });
    await expect(runtime.db.insert(crewSkills).values({ ...wrongTenant, skillId: ids.foreignSkill, proficiency: 3 }))
      .rejects.toMatchObject({ cause: { code: '23503' } });
    await expect(runtime.db.insert(crewSkills).values({ tenantId, crewId: ids.alex, skillId: ids.foreignSkill, proficiency: 3 }))
      .rejects.toMatchObject({ cause: { code: '23503' } });
    await expect(runtime.db.update(crewSkills).set({ proficiency: 6 }).where(eq(crewSkills.crewId, ids.alex)))
      .rejects.toMatchObject({ cause: { code: '23514' } });
    await expect(runtime.db.insert(availability).values({ ...wrongTenant, start: new Date(window.start), end: new Date(window.end) }))
      .rejects.toMatchObject({ cause: { code: '23503' } });
    await expect(runtime.db.insert(availability).values({ tenantId, crewId: ids.alex, start: new Date(window.end), end: new Date(window.start) }))
      .rejects.toMatchObject({ cause: { code: '23514' } });
    await expect(runtime.db.execute(sql`INSERT INTO availability (tenant_id, crew_id, start, "end") VALUES (${tenantId}, ${ids.alex}, '-infinity', 'infinity')`))
      .rejects.toMatchObject({ cause: { code: '23514' } });
    await expect(runtime.db.insert(skills).values({ tenantId, name: 'NOT NORMALISED' })).rejects.toMatchObject({ cause: { code: '23514' } });
  });

  it('serialises every profile/eligibility edit on the crew row', async () => {
    const url = new URL(runtimeUrl); url.searchParams.set('application_name', 'crew-edit-race');
    const editing = connectDatabase(url.toString());
    const editingApp = createApp(editing.db, { log: () => {} });
    const auth = await token('atlas/alex');
    const blocker = await runtime.pool.connect();
    const actions: [string, string, unknown?][] = [
      [`/crew/me`, 'PATCH', { biography: 'Locked edit' }],
      [`/crew/me/skills/${ids.pilot}`, 'PUT', { proficiency: 3 }],
      [`/crew/me/skills/${ids.medical}`, 'DELETE'],
      [`/crew/me/availability`, 'POST', window],
      [`/crew/me/availability/${ids.alexWindow}`, 'DELETE'],
    ];
    try {
      for (const [path, method, body] of actions) {
        await blocker.query('BEGIN');
        await blocker.query('SELECT id FROM crew WHERE tenant_id = $1 AND id = $2 FOR UPDATE', [tenantIds.atlas, ids.alex]);
        const pending = editingApp.request(`/v1${path}`, { method, headers: { authorization: `Bearer ${auth}`, 'content-type': 'application/json' },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
        let blocked = false;
        const deadline = Date.now() + 3000;
        while (Date.now() < deadline) {
          const result = await runtime.pool.query("SELECT 1 FROM pg_stat_activity WHERE application_name = 'crew-edit-race' AND wait_event_type = 'Lock'");
          if (result.rowCount) { blocked = true; break; }
          await delay(10);
        }
        await blocker.query('COMMIT');
        const result = await pending;
        expect(blocked).toBe(true); expect(result.status).toBeLessThan(300);
      }
    } finally { await blocker.query('ROLLBACK'); blocker.release(); await editing.pool.end(); }
    expect((await ok('atlas/alex', '/crew/me')).biography).toBe('Locked edit');
  });

  it('handles concurrent duplicate creation safely without cross-tenant conflicts', async () => {
    await token('atlas/director');
    const results = await Promise.all([1, 2].map(() => request('atlas/director', '/skills', 'POST', { name: 'duplicate-race' })));
    expect(results.map((r) => r.status).sort()).toEqual([201, 409]);
    expect(await runtime.db.select({ id: skills.id }).from(skills).where(and(eq(skills.tenantId, tenantIds.atlas), eq(skills.name, 'duplicate-race')))).toHaveLength(1);
    expect((await request('boreal/director', '/skills', 'POST', { name: 'duplicate-race' })).status).toBe(201);
  });
});

it('completes the Director → Crew → Lead workflow through the real CLI', async () => {
  const configDir = await mkdtemp(join(tmpdir(), 'mission-control-crew-cli-'));
  const server = serve({ fetch: app.fetch, hostname: '127.0.0.1', port: 0 });
  await new Promise<void>((resolveReady) => server.listening ? resolveReady() : server.once('listening', resolveReady));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Expected TCP address');
  const runCli = createCliRunner(configDir, `http://127.0.0.1:${address.port}`);
  async function cli(args: string[], input = '', expectedCode = 0) {
    const result = await runCli(args, input);
    expect(result.code, result.stderr).toBe(expectedCode);
    expect(result.stdout + result.stderr).not.toContain(seedPassword);
    return JSON.parse(expectedCode ? result.stderr : result.stdout);
  }
  try {
    await cli(['login', '--org', 'atlas', '--username', 'director', '--password-stdin'], `${seedPassword}\n`);
    await cli(['org', 'update', '--name', 'Atlas CLI']);
    expect((await cli(['org', 'show'])).name).toBe('Atlas CLI');
    const member = await cli(['members', 'create', '--username', 'cli-crew', '--name', 'CLI Crew', '--role', 'crew', '--password-stdin'], `${seedPassword}\n`);
    expect((await cli(['members', 'list', '--search', 'cli-crew'])).items[0].id).toBe(member.id);
    const profile = await cli(['crew', 'create', '--member', member.id]);
    const skill = await cli(['skills', 'add', '--name', 'CLI Skill']);
    await cli(['skills', 'rename', '--skill', skill.id, '--name', 'CLI Skill Renamed']);
    expect((await cli(['skills', 'list', '--search', 'cli skill'])).items[0].id).toBe(skill.id);
    await cli(['logout']);
    await cli(['login', '--org', 'atlas', '--username', 'cli-crew', '--password-stdin'], `${seedPassword}\n`);
    await cli(['crew', 'update', '--crew', 'me', '--bio', 'Ready']);
    await cli(['crew', 'skills', 'set', '--crew', 'me', '--skill', skill.id, '--level', '4']);
    const window = await cli(['availability', 'add', '--start', '2030-03-01T09:00:00Z', '--end', '2030-03-01T10:00:00Z']);
    expect((await cli(['availability', 'list', '--crew', 'me'])).items[0].id).toBe(window.id);
    expect((await cli(['crew', 'show'])).skills).toHaveLength(1);
    const refusal = await cli(['availability', 'remove', '--window', window.id], '', 1);
    expect(refusal.error.code).toBe('CONFIRMATION_REQUIRED');
    await cli(['availability', 'remove', '--window', window.id, '--yes']);
    await cli(['availability', 'add', '--start', '2030-03-01T09:00:00Z', '--end', '2030-03-01T10:00:00Z']);
    await cli(['crew', 'skills', 'remove', '--skill', skill.id, '--yes']);
    await cli(['crew', 'skills', 'set', '--skill', ids.pilot, '--level', '3']);
    await cli(['logout']);
    await cli(['login', '--org', 'atlas', '--username', 'lead', '--password-stdin'], `${seedPassword}\n`);
    expect((await cli(['crew', 'list', '--search', 'CLI Crew', '--limit', '1'])).items[0].id).toBe(profile.id);
    expect((await cli(['crew', 'show', '--crew', profile.id])).skills[0].name).toBe('piloting');
    expect((await cli(['availability', 'list', '--crew', profile.id])).items).toHaveLength(1);
    expect((await cli(['crew', 'update', '--crew', profile.id, '--bio', 'Not mine'], '', 1)).error.code).toBe('FORBIDDEN');
    await cli(['logout']);
    await cli(['login', '--org', 'atlas', '--username', 'director', '--password-stdin'], `${seedPassword}\n`);
    await cli(['skills', 'remove', '--skill', skill.id, '--yes']);
    expect((await cli(['skills', 'list', '--search', 'cli skill'])).items).toEqual([]);
    await cli(['logout']);
    const [persisted] = await runtime.db.select({ username: users.username }).from(users).where(eq(users.id, member.id));
    expect(persisted?.username).toBe('cli-crew');
  } finally {
    await new Promise<void>((resolveClose, reject) => server.close((error) => error ? reject(error) : resolveClose()));
    await rm(configDir, { recursive: true, force: true });
  }
}, 30000);
