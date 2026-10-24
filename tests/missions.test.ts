import { beforeEach, describe, expect, it } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { serve } from '@hono/node-server';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../src/api/app.js';
import { missionEvents, missions, positions, positionSkills, skills } from '../src/db/schema.js';
import { seedPassword, tenantIds } from '../src/db/fixtures.js';
import { useTestDatabase } from './database.js';
import { createCliRunner } from './cli-runner.js';
import { createApiClient } from './api-client.js';

const { runtime, waitForLocks } = useTestDatabase();
const pilot = '10000000-0000-4000-8002-000000000001', medical = '10000000-0000-4000-8002-000000000002';
const foreignSkill = '20000000-0000-4000-8002-000000000001';
const plan = { title: 'Supply flight', brief: 'Deliver supplies', start: '2030-01-10T09:00:00Z', end: '2030-01-10T17:00:00Z' };
const requirement = { skillId: pilot, minProficiency: 3 };
let app: ReturnType<typeof createApp>;
let request: ReturnType<typeof createApiClient>['request'];
let ok: ReturnType<typeof createApiClient>['ok'];
let error: ReturnType<typeof createApiClient>['error'];
beforeEach(() => {
  app = createApp(runtime.db, { log: () => {} });
  ({ request, ok, error } = createApiClient(app, runtime.db));
});

const create = (actor = 'atlas/lead') => ok(actor, '/missions', 'POST', plan);
const add = (id: string, version: number) => ok('atlas/lead', `/missions/${id}/positions`, 'POST', { version, label: 'Pilot', requirements: [requirement] });

describe('draft mission planning', () => {
  it('retains ownership and atomic versioned history through edits, no-ops and soft-removal', async () => {
    let mission = await create();
    const path = `/missions/${mission.id}`;
    expect(mission).toMatchObject({ ownerId: '10000000-0000-4000-8001-000000000003', version: 1, state: 'draft', positions: [] });
    expect(mission).not.toHaveProperty('tenantId');
    mission = await add(mission.id, 1);
    const positionId = mission.positions[0].id, child = `${path}/positions/${positionId}`;
    expect(mission.positions[0]).toMatchObject({ ordinal: 1, removedAt: null, requirements: [{ ...requirement, name: 'piloting' }] });
    mission = await ok('atlas/lead', path, 'PATCH', { version: 2, brief: 'Revised delivery' });
    expect(mission.version).toBe(3);
    const noOp = await ok('atlas/lead', path, 'PATCH', { version: 3, brief: ' Revised delivery ', start: '2030-01-10T20:00:00+11:00' });
    expect(noOp).toEqual(mission);
    const updated = await ok('atlas/lead', child, 'PATCH', { version: 3, label: 'Pilot / medic', requirements: [requirement, { skillId: medical, minProficiency: 2 }] });
    expect(updated.version).toBe(4);
    expect(await ok('atlas/lead', child, 'PATCH', { version: 4, requirements: [{ skillId: medical, minProficiency: 2 }, requirement] })).toEqual(updated);
    expect((await error('atlas/lead', path, 'PATCH', { version: 3, title: 'Stale' }, 409)).code).toBe('STALE_VERSION');
    mission = await ok('atlas/director', child, 'DELETE', { version: 4 });
    expect(mission).toMatchObject({ version: 5, positions: [{ id: positionId, ordinal: 1, removedAt: expect.any(String) }] });
    expect((await error('atlas/lead', child, 'DELETE', { version: 4 }, 409)).code).toBe('STALE_VERSION');
    expect((await error('atlas/lead', child, 'PATCH', { version: 5, label: 'Restore' }, 409)).code).toBe('POSITION_REMOVED');
    expect((await error('atlas/lead', child, 'DELETE', { version: 5 }, 409)).code).toBe('POSITION_REMOVED');
    mission = await add(mission.id, 5);
    expect(mission.positions.map((p: { ordinal: number }) => p.ordinal)).toEqual([1, 2]);
    await ok('atlas/director', `/skills/${pilot}`, 'PATCH', { name: 'aircraft piloting' });
    const history = await ok('atlas/lead', `${path}/history`);
    expect(history.items.map((e: { missionVersion: number }) => e.missionVersion)).toEqual([1, 2, 3, 4, 5, 6]);
    expect(history.items[1].payload.position.requirements[0].name).toBe('piloting');
    expect(history.items[2].payload).toMatchObject({ before: { brief: plan.brief }, after: { brief: 'Revised delivery' } });
    expect(history.items[4]).toMatchObject({ kind: 'position_removed', actorId: '10000000-0000-4000-8001-000000000001',
      payload: { before: { removedAt: null }, after: { removedAt: expect.any(String) } } });
    expect((await ok('atlas/lead', `${path}/history?limit=2`)).nextOffset).toBe(2);
    expect((await ok('atlas/lead', `${path}/history?offset=6`)).items).toEqual([]);
    const relabelled = await ok('atlas/lead', `${path}/positions/${mission.positions[1].id}`, 'PATCH', { version: 6, label: 'Captain' });
    expect(relabelled).toMatchObject({ version: 7, positions: [expect.anything(), { label: 'Captain', requirements: [{ ...requirement, name: 'aircraft piloting' }] }] });
  });

  it('hides foreign missions, related records and history; limits Crew and other Leads', async () => {
    const own = await create(), foreign = await create('boreal/lead'), other = await create('atlas/director');
    const ownWithPosition = await add(own.id, 1);
    const otherWithPosition = await ok('atlas/director', `/missions/${other.id}/positions`, 'POST', { version: 1, label: 'Director position' });
    const baseline = await error('atlas/lead', `/missions/${randomUUID()}`);
    for (const [actor, id] of [['atlas/lead', foreign.id], ['atlas/director', foreign.id], ['atlas/alex', own.id], ['atlas/alex', foreign.id]]) {
      const path = `/missions/${id}`;
      expect(await error(actor!, path)).toEqual(baseline);
      expect(await error(actor!, `${path}/history`)).toEqual(baseline);
      expect(await error(actor!, path, 'PATCH', { version: 999, title: 'Hidden' })).toEqual(baseline);
      expect(await error(actor!, `${path}/positions`, 'POST', { version: 999, label: 'Hidden' })).toEqual(baseline);
      expect(await error(actor!, `${path}/positions/${ownWithPosition.positions[0].id}`, 'PATCH', { version: 999, label: 'Hidden' })).toEqual(baseline);
      expect(await error(actor!, `${path}/positions/${ownWithPosition.positions[0].id}`, 'DELETE', { version: 999 })).toEqual(baseline);
    }
    for (const skillId of [foreignSkill, randomUUID()]) {
      expect(await error('atlas/lead', `/missions/${own.id}/positions`, 'POST', { version: 2, label: 'Hidden', requirements: [{ skillId, minProficiency: 1 }] })).toEqual(baseline);
      expect(await error('atlas/lead', `/missions/${own.id}/positions/${ownWithPosition.positions[0].id}`, 'PATCH', { version: 2, label: 'Hidden', requirements: [{ skillId, minProficiency: 1 }] })).toEqual(baseline);
    }
    expect(await ok('atlas/lead', `/missions/${own.id}`)).toEqual(ownWithPosition); // Failed changes roll back everything.
    expect((await ok('atlas/lead', `/missions/${own.id}/history`)).items).toHaveLength(2);
    for (const positionId of [otherWithPosition.positions[0].id, randomUUID()]) {
      expect(await error('atlas/lead', `/missions/${own.id}/positions/${positionId}`, 'PATCH', { version: 999, label: 'Wrong parent' })).toEqual(baseline);
      expect(await error('atlas/lead', `/missions/${own.id}/positions/${positionId}`, 'DELETE', { version: 999 })).toEqual(baseline);
    }
    await ok('atlas/director', '/members', 'POST', { username: 'lead2', displayName: 'Other Lead', role: 'lead', password: seedPassword });
    expect((await ok('atlas/lead2', `/missions/${own.id}`)).id).toBe(own.id);
    await error('atlas/lead2', `/missions/${own.id}`, 'PATCH', { version: 2, title: 'Forbidden' }, 403);
    await error('atlas/lead2', `/missions/${own.id}/positions`, 'POST', { version: 2, label: 'Forbidden' }, 403);
    await error('atlas/lead2', `/missions/${own.id}/positions/${ownWithPosition.positions[0].id}`, 'PATCH', { version: 2, label: 'Forbidden' }, 403);
    await error('atlas/lead2', `/missions/${own.id}/positions/${ownWithPosition.positions[0].id}`, 'DELETE', { version: 2 }, 403);
    await error('atlas/alex', '/missions', 'POST', plan, 403);
    expect((await ok('atlas/alex', '/missions?q=Supply')).items).toEqual([]);
    expect((await ok('atlas/lead', '/missions')).items.map((m: { id: string }) => m.id).sort()).toEqual([own.id, other.id].sort());
    expect((await ok('atlas/lead', '/missions?limit=1')).nextOffset).toBe(1);
    expect((await ok('atlas/lead', '/missions?offset=1')).items[0].id).toBe(other.id);
    expect((await ok('boreal/lead', '/missions?q=SUPPLY')).items.map((m: { id: string }) => m.id)).toEqual([foreign.id]);
    expect((await ok('atlas/lead', '/missions?q=%25')).items).toEqual([]);
    expect((await ok('atlas/lead', '/missions?state=approved')).items).toEqual([]);
  });

  it('validates protected fields, timestamps, versions and requirements without partial writes', async () => {
    for (const input of [{ ...plan, start: plan.end }, { ...plan, end: plan.start }, { ...plan, start: '2030-01-10T09:00:00' },
      { ...plan, start: '2030-02-30T09:00:00Z' }, { ...plan, title: ' ' }, { ...plan, brief: 'a'.repeat(4001) }]) {
      await error('atlas/lead', '/missions', 'POST', input, 400);
    }
    expect((await error('atlas/lead', '/missions', 'POST', { ...plan, start: '2000-01-01T00:00:00Z' }, 409)).code).toBe('START_NOT_FUTURE');
    const mission = await create(), path = `/missions/${mission.id}`;
    for (const key of ['id', 'ownerId', 'tenantId', 'state', 'createdAt']) {
      await error('atlas/lead', '/missions', 'POST', { ...plan, [key]: mission.id }, 400);
      await error('atlas/lead', path, 'PATCH', { version: 1, title: 'Changed', [key]: mission.id }, 400);
    }
    for (const input of [{}, { version: 1 }, { version: '1', title: 'Bad' }, { version: 0, title: 'Bad' }, { version: 1, start: plan.end }]) {
      await error('atlas/lead', path, 'PATCH', input, 400);
    }
    for (const requirements of [[requirement, requirement], [{ ...requirement, minProficiency: 0 }], [{ ...requirement, minProficiency: 6 }],
      [{ ...requirement, minProficiency: 1.5 }], [{ ...requirement, minProficiency: '3' }], [{ ...requirement, tenantId: tenantIds.atlas }]]) {
      await error('atlas/lead', `${path}/positions`, 'POST', { version: 1, label: 'Pilot', requirements }, 400);
    }
    await error('atlas/lead', `${path}/positions`, 'POST', { version: 1, label: 'Pilot', ordinal: 1 }, 400);
    for (const query of ['?state=active', '?limit=101', '?offset=-1', '?tenantId=x']) await error('atlas/lead', `/missions${query}`, 'GET', undefined, 400);
    expect(await ok('atlas/lead', path)).toEqual(mission);
    const added = await ok('atlas/lead', `${path}/positions`, 'POST', { version: 1, label: 'Requirements pending' });
    expect(added.positions[0].requirements).toEqual([]);
    const populated = await ok('atlas/lead', `${path}/positions/${added.positions[0].id}`, 'PATCH', { version: 2, requirements: [requirement] });
    expect(populated.version).toBe(3);
    const cleared = await ok('atlas/lead', `${path}/positions/${added.positions[0].id}`, 'PATCH', { version: 3, requirements: [] });
    expect(cleared).toMatchObject({ version: 4, positions: [{ requirements: [] }] });
  });

  it('rejects every planning mutation once frozen, including identical patches', async () => {
    const mission = await create();
    const withPosition = await add(mission.id, 1), path = `/missions/${mission.id}`, child = `${path}/positions/${withPosition.positions[0].id}`;
    // Later slices expose these transitions; fixtures exercise the guard now.
    for (const state of ['submitted', 'approved', 'completed', 'cancelled'] as const) {
      await runtime.db.update(missions).set({ state }).where(eq(missions.id, mission.id));
      for (const actor of ['atlas/lead', 'atlas/director']) {
        for (const [target, method, body] of [
          [path, 'PATCH', { version: 2, title: plan.title }], [child, 'PATCH', { version: 2, label: 'Pilot' }],
          [`${path}/positions`, 'POST', { version: 2, label: 'Extra' }], [child, 'DELETE', { version: 2 }],
        ] as const) expect((await error(actor, target, method, body, 409)).code).toBe('MISSION_FROZEN');
      }
    }
    expect((await ok('atlas/lead', `${path}/history`)).items).toHaveLength(2);
  });

  it('serialises competing writes and allocates ordinals without duplicate events', async () => {
    const mission = await create(), path = `/missions/${mission.id}`;
    const writes = await Promise.all(['First', 'Second'].map((label) => request('atlas/lead', `${path}/positions`, 'POST', { version: 1, label })));
    expect(writes.map((r) => r.status).sort()).toEqual([201, 409]);
    const after = await ok('atlas/lead', path);
    expect(after).toMatchObject({ version: 2, positions: [{ ordinal: 1 }] });
    expect(after.positions).toHaveLength(1);
    const edits = await Promise.all(['First', 'Second'].map((brief) => request('atlas/lead', path, 'PATCH', { version: 2, brief })));
    expect(edits.map((r) => r.status).sort()).toEqual([200, 409]);
    expect((await ok('atlas/lead', `${path}/history`)).items.map((e: { missionVersion: number }) => e.missionVersion)).toEqual([1, 2, 3]);
  });

  it('rolls back the plan and version if recording history fails', async () => {
    const mission = await create(), path = `/missions/${mission.id}`;
    // Deliberately occupy the next event version to force a failure after the plan UPDATE.
    await runtime.db.insert(missionEvents).values({ tenantId: tenantIds.atlas, missionId: mission.id,
      missionVersion: 2, actorId: mission.ownerId, kind: 'mission_updated', payload: {} });
    await error('atlas/lead', path, 'PATCH', { version: 1, title: 'Must roll back' }, 409);
    expect(await ok('atlas/lead', path)).toEqual(mission);
  });

  it('checks actual time after a lock wait and allows rescheduling an elapsed draft', async () => {
    const mission = await create(), path = `/missions/${mission.id}`;
    const blocker = await runtime.pool.connect();
    let pending: Promise<Response> | undefined;
    try {
      await blocker.query('BEGIN');
      await blocker.query('SELECT id FROM missions WHERE id = $1 FOR UPDATE', [mission.id]);
      const start = new Date(Date.now() + 500).toISOString();
      pending = request('atlas/lead', path, 'PATCH', { version: 1, start });
      // Observe the blocked request, then release only after its proposed start passes.
      await waitForLocks();
      await delay(Math.max(0, Date.parse(start) - Date.now() + 50));
      await blocker.query('COMMIT');
      const response = await pending;
      expect(response.status).toBe(409);
      expect(JSON.parse(await response.text()).error.code).toBe('START_NOT_FUTURE');
    } finally { await blocker.query('ROLLBACK'); blocker.release(); await pending; }
    expect((await ok('atlas/lead', path)).version).toBe(1);
    await runtime.db.update(missions).set({ start: new Date('2000-01-01T00:00:00Z'), end: new Date('2000-01-02T00:00:00Z') }).where(eq(missions.id, mission.id));
    expect((await ok('atlas/lead', path, 'PATCH', { version: 1, start: plan.start, end: plan.end })).version).toBe(2);
  });

  it('enforces tenant/parent FKs, row constraints and append-only history in PostgreSQL', async () => {
    const mission = await create(), other = await create(), withPosition = await add(mission.id, 1);
    const tenantId = tenantIds.atlas, positionId = withPosition.positions[0].id;
    const dbPlan = { tenantId, ownerId: mission.ownerId, title: 'DB plan', brief: '', start: new Date(plan.start), end: new Date(plan.end) };
    await expect(runtime.db.insert(missions).values({ ...dbPlan, tenantId: tenantIds.boreal })).rejects.toMatchObject({ cause: { code: '23503' } });
    await expect(runtime.db.insert(positions).values({ tenantId: tenantIds.boreal, missionId: mission.id, ordinal: 1, label: 'Foreign' })).rejects.toMatchObject({ cause: { code: '23503' } });
    for (const input of [{ tenantId, missionId: mission.id, positionId, skillId: foreignSkill }, { tenantId, missionId: other.id, positionId, skillId: medical }]) {
      await expect(runtime.db.insert(positionSkills).values({ ...input, minProficiency: 3 })).rejects.toMatchObject({ cause: { code: '23503' } });
    }
    await expect(runtime.db.insert(positions).values({ tenantId, missionId: mission.id, ordinal: 1, label: 'Duplicate' })).rejects.toMatchObject({ cause: { code: '23505' } });
    for (const changes of [{ title: '' }, { version: 0 }, { end: new Date(plan.start) }]) {
      await expect(runtime.db.insert(missions).values({ ...dbPlan, ...changes })).rejects.toMatchObject({ cause: { code: '23514' } });
    }
    await expect(runtime.db.insert(positionSkills).values({ tenantId, missionId: mission.id, positionId, skillId: medical, minProficiency: 6 })).rejects.toMatchObject({ cause: { code: '23514' } });
    const event = { tenantId, missionId: mission.id, missionVersion: 3, actorId: mission.ownerId, kind: 'mission_updated', payload: {} };
    await expect(runtime.db.insert(missionEvents).values({ ...event, actorId: '20000000-0000-4000-8001-000000000002' })).rejects.toMatchObject({ cause: { code: '23503' } });
    await expect(runtime.db.insert(missionEvents).values({ ...event, missionVersion: 1 })).rejects.toMatchObject({ cause: { code: '23505' } });
    await expect(runtime.db.insert(missionEvents).values({ ...event, kind: 'unknown' })).rejects.toMatchObject({ cause: { code: '23514' } });
    await expect(runtime.db.execute(sql`INSERT INTO mission_events (tenant_id, mission_id, mission_version, actor_id, kind, payload)
      VALUES (${tenantId}, ${mission.id}, 3, ${mission.ownerId}, 'mission_updated', '[]'::jsonb)`)).rejects.toMatchObject({ cause: { code: '23514' } });
    await expect(runtime.db.update(missionEvents).set({ payload: {} })).rejects.toMatchObject({ cause: { code: '42501' } });
    await expect(runtime.db.delete(missionEvents)).rejects.toMatchObject({ cause: { code: '42501' } });
    await expect(runtime.db.delete(skills).where(eq(skills.id, pilot))).rejects.toMatchObject({ cause: { code: '23503' } });
  });
});

it('plans and revises a mission through the real CLI, with discoverable IDs and stale-write recovery', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'mc-planning-'));
  const server = serve({ fetch: app.fetch, hostname: '127.0.0.1', port: 0 });
  if (!server.listening) await new Promise<void>((resolve) => server.once('listening', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Expected TCP server');
  const run = createCliRunner(directory, `http://127.0.0.1:${address.port}`);
  async function cli(args: string[], input = '') {
    const result = await run(args, input);
    expect(result.code, result.stderr).toBe(0);
    return JSON.parse(result.stdout);
  }
  try {
    // Exact skill lookup must work beyond the first search page.
    await runtime.db.insert(skills).values(Array.from({ length: 101 }, (_, i) => ({ tenantId: tenantIds.atlas, name: `a${i}-piloting` })));
    await cli(['login', '--org', 'atlas', '--username', 'lead', '--password-stdin'], `${seedPassword}\n`);
    let mission = await cli(['missions', 'create', '--title', plan.title, '--brief', plan.brief, '--start', plan.start, '--end', plan.end]);
    const missionArgs = ['--mission', mission.id];
    expect((await cli(['missions', 'list', '--search', 'supply', '--state', 'draft'])).items[0].id).toBe(mission.id);
    mission = await cli(['positions', 'add', ...missionArgs, '--version', '1', '--label', 'Pilot', '--requires', 'piloting:3', `${medical}:2`]);
    const positionArgs = [...missionArgs, '--position', mission.positions[0].id];
    expect(mission.positions[0].requirements).toHaveLength(2);
    const missingVersion = await run(['missions', 'update', ...missionArgs, '--title', 'Unreviewed']);
    expect(missingVersion.code).toBe(1); expect(JSON.parse(missingVersion.stderr).error.code).toBe('INVALID_ARGUMENT');
    const stale = await run(['missions', 'update', ...missionArgs, '--version', '1', '--title', 'Unreviewed']);
    expect(stale.code).toBe(1); expect(JSON.parse(stale.stderr).error).toMatchObject({ code: 'STALE_VERSION', recovery: expect.stringContaining('show') });
    mission = await cli(['missions', 'show', ...missionArgs]);
    mission = await cli(['missions', 'update', ...missionArgs, '--version', String(mission.version), '--title', 'Revised flight']);
    mission = await cli(['positions', 'update', ...positionArgs, '--version', String(mission.version), '--clear-requirements', '--label', 'Trainee']);
    expect(mission.positions[0].requirements).toEqual([]);
    const missing = await run(['positions', 'add', ...missionArgs, '--version', '4', '--label', 'Invalid', '--requires', 'nonexistent:3']);
    expect(missing.code).toBe(1); expect(JSON.parse(missing.stderr).error.code).toBe('SKILL_NOT_FOUND');
    const refused = await run(['positions', 'remove', ...positionArgs, '--version', '4']);
    expect(refused.code).toBe(1); expect(JSON.parse(refused.stderr).error.code).toBe('CONFIRMATION_REQUIRED');
    mission = await cli(['positions', 'remove', ...positionArgs, '--version', '4', '--yes']);
    expect(mission).toMatchObject({ version: 5, positions: [{ removedAt: expect.any(String) }] });
    expect((await cli(['missions', 'history', ...missionArgs])).items).toHaveLength(5);
    await cli(['logout']);
    await cli(['login', '--org', 'boreal', '--username', 'lead', '--password-stdin'], `${seedPassword}\n`);
    expect((await cli(['missions', 'list'])).items).toEqual([]);
    const hidden = await run(['missions', 'show', ...missionArgs]);
    expect(hidden.code).toBe(1); expect(JSON.parse(hidden.stderr).error.code).toBe('NOT_FOUND');
  } finally {
    if ('closeAllConnections' in server) server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    await rm(directory, { recursive: true, force: true });
  }
}, 30000);
