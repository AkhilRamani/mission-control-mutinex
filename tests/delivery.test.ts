import { beforeEach, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:net';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createApp } from '../src/api/app.js';
import { seedDatabase, seedPassword, tenantIds } from '../src/db/fixtures.js';
import { assignments, missions } from '../src/db/schema.js';
import { useTestDatabase } from './database.js';
import { createApiClient } from './api-client.js';
import { createCliRunner } from './cli-runner.js';

const { runtime, runtimeUrl, clear } = useTestDatabase();
const anchor = new Date();
anchor.setUTCHours(0, 0, 0, 0);
const at = (days: number, hours: number) => new Date(+anchor + days * 86_400_000 + hours * 3_600_000).toISOString();
beforeEach(async () => { await clear(); await seedDatabase(runtime.db, anchor); });

it('seeds both tenants with coherent history, useful matching examples and all lifecycle states', async () => {
  const client = createApiClient(createApp(runtime.db, { log: () => {} }), runtime.db);
  const atlas = await client.ok('atlas/lead', '/missions');
  const boreal = await client.ok('boreal/lead', '/missions');
  expect(atlas.items).toHaveLength(12);
  expect(boreal.items).toHaveLength(2);
  expect(new Set(atlas.items.map((m: { state: string }) => m.state))).toEqual(new Set(['draft', 'submitted', 'approved', 'completed', 'cancelled']));
  const supply = atlas.items.find((m: { title: string }) => m.title === 'Supply flight');
  const matched = await client.ok('atlas/lead', `/missions/${supply.id}/match`);
  expect(matched.complete).toBe(true);
  expect(matched.roster.map((r: { positionLabel: string; displayName: string }) => [r.positionLabel, r.displayName])).toEqual([['Pilot', 'Sam'], ['Medic', 'Alex']]);
  expect(matched.positions[0].excludedCandidates).toEqual(expect.arrayContaining([
    expect.objectContaining({ displayName: 'Jules', reasons: expect.arrayContaining([expect.stringContaining('piloting')]) }),
    expect.objectContaining({ displayName: 'Lee', reasons: expect.arrayContaining([expect.stringContaining('Availability')]) }),
  ]));
  const partial = atlas.items.find((m: { title: string }) => m.title === 'Partial rescue');
  expect((await client.ok('atlas/lead', `/missions/${partial.id}/match`)).complete).toBe(false);
  for (const m of atlas.items) {
    const history = await client.ok('atlas/lead', `/missions/${m.id}/history`);
    expect(history.items.map((e: { missionVersion: number }) => e.missionVersion)).toEqual(Array.from({ length: m.version }, (_, i) => i + 1));
    const detail = await client.ok('atlas/lead', `/missions/${m.id}`);
    const last = history.items.at(-1);
    if (detail.assignments.length) {
      expect(last.payload.assignmentChanges).toBeDefined();
      for (const change of last.payload.assignmentChanges) {
        const assignment = detail.assignments.find((a: { id: string }) => a.id === change.after.id);
        expect(assignment).toMatchObject({ state: change.after.state, respondedAt: change.after.respondedAt,
          bookedStart: change.after.bookedStart, bookedEnd: change.after.bookedEnd });
      }
    }
  }
  const rejected = atlas.items.find((m: { title: string }) => m.title === 'Rejected plan');
  const ownHistory = await client.ok('atlas/alex', `/missions/${rejected.id}/history`);
  expect(ownHistory.items.at(-1).kind).toBe('mission_rejected');
  expect(JSON.stringify(ownHistory)).not.toContain('reason');
  expect(JSON.stringify(ownHistory)).not.toContain('actorId');
  await client.error('boreal/lead', `/missions/${supply.id}`);
  await client.error('atlas/lead', `/missions/${boreal.items[0].id}`);
  await expect(seedDatabase(runtime.db, anchor)).rejects.toThrow('already contains');
  expect(await client.ok('atlas/lead', '/missions')).toEqual(atlas);
});

it('runs the full CLI journey, recovers from decline/rejection/conflict and preserves state across process restart', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'mc-delivery-'));
  const probe = createServer();
  probe.listen(0, '127.0.0.1');
  await once(probe, 'listening');
  const address = probe.address();
  if (!address || typeof address === 'string') throw new Error('Expected TCP port');
  const port = address.port;
  await new Promise<void>((done) => probe.close(() => done()));
  let server: ReturnType<typeof spawn> | undefined;
  async function start() {
    server = spawn(process.execPath, ['--import', 'tsx', resolve('src/index.ts')], {
      env: { ...process.env, DATABASE_URL: runtimeUrl, PORT: String(port) }, stdio: ['ignore', 'pipe', 'pipe'],
    });
    const child = server;
    await new Promise<void>((ready, reject) => {
      const timer = setTimeout(() => reject(new Error('API startup timed out')), 10000);
      child.once('error', (error) => { clearTimeout(timer); reject(error); });
      child.once('exit', () => { clearTimeout(timer); reject(new Error('API exited before listening')); });
      child.stdout!.on('data', (chunk: Buffer) => {
        if (chunk.toString().includes('"event":"listening"')) { clearTimeout(timer); ready(); }
      });
      child.stderr!.on('data', () => {}); // Drain without logging environment-dependent errors/secrets.
    });
  }
  async function stop() {
    if (!server || server.exitCode !== null || server.signalCode !== null) return;
    const closed = once(server, 'close');
    server.kill('SIGTERM');
    const [code] = await closed;
    expect(code).toBe(0);
  }
  const loggedIn = new Set<string>();
  async function run(actor: string, args: string[], input = '') {
    const cli = createCliRunner(join(directory, actor), `http://127.0.0.1:${port}`);
    if (!loggedIn.has(actor)) {
      const login = await cli(['login', '--org', 'atlas', '--username', actor, '--password-stdin'], `${seedPassword}\n`);
      expect(login.code, login.stderr).toBe(0);
      loggedIn.add(actor);
    }
    return cli(args, input);
  }
  async function ok(actor: string, args: string[]) {
    const result = await run(actor, args);
    expect(result.code, result.stderr).toBe(0);
    return JSON.parse(result.stdout);
  }
  async function error(actor: string, args: string[], code: string) {
    const result = await run(actor, args);
    expect(result.code).toBe(1);
    expect(JSON.parse(result.stderr).error.code).toBe(code);
  }
  const show = (id: string) => ok('lead', ['missions', 'show', '--mission', id]);
  const action = (verb: string, m: { id: string; version: number }) => ['missions', verb, '--mission', m.id, '--version', String(m.version)];
  async function acceptAll(id: string) {
    for (const actor of ['sam', 'alex']) {
      const list = await ok(actor, ['assignments', 'list', '--mine']);
      const a = list.items.find((a: { missionId: string; state: string }) => a.missionId === id && a.state === 'proposed');
      const reviewed = await ok(actor, ['assignments', 'show', '--assignment', a.id]);
      await ok(actor, ['assignments', 'accept', '--assignment', a.id, '--version', String(reviewed.version)]);
    }
    return show(id);
  }
  try {
    await start();
    let m = await ok('lead', ['missions', 'create', '--title', 'CLI delivery', '--brief', 'Complete a supply run', '--start', at(10, 9), '--end', at(10, 17)]);
    for (const [label, skill] of [['Pilot', 'piloting:3'], ['Medic', 'medical:3']]) {
      m = await ok('lead', ['positions', 'add', '--mission', m.id, '--version', String(m.version), '--label', label!, '--requires', skill!]);
    }
    expect((await ok('lead', ['missions', 'match', '--mission', m.id])).complete).toBe(true);
    m = await ok('lead', [...action('propose', m), '--suggested']);
    const own = (await ok('sam', ['assignments', 'list', '--mine'])).items.find((a: { missionId: string }) => a.missionId === m.id);
    await ok('sam', ['assignments', 'decline', '--assignment', own.id, '--version', String(own.version)]);
    m = await show(m.id);
    await error('lead', action('submit', m), 'INCOMPLETE_ROSTER');
    m = await ok('lead', [...action('propose', m), '--suggested']);
    m = await acceptAll(m.id);
    m = await ok('lead', action('submit', m));
    m = await ok('director', [...action('reject', m), '--reason', 'Recheck supplies', '--yes']);
    expect(m.assignments.filter((a: { state: string }) => a.state === 'proposed')).toHaveLength(2);
    m = await acceptAll(m.id);
    m = await ok('lead', action('submit', m));
    m = await ok('director', action('approve', m));
    const history = await ok('lead', ['missions', 'history', '--mission', m.id]);
    await stop();
    await start();
    expect(await show(m.id)).toEqual(m);
    expect(await ok('lead', ['missions', 'history', '--mission', m.id])).toEqual(history);
    // Simulate elapsed time in the fixture only, avoiding a clock override in the production API.
    await runtime.db.transaction(async (tx) => {
      const start = new Date(at(-4, 9)), end = new Date(at(-4, 17));
      await tx.update(missions).set({ start, end }).where(and(eq(missions.tenantId, tenantIds.atlas), eq(missions.id, m.id)));
      await tx.update(assignments).set({ bookedStart: start, bookedEnd: end })
        .where(and(eq(assignments.tenantId, tenantIds.atlas), eq(assignments.missionId, m.id), eq(assignments.state, 'confirmed')));
    });
    m = await show(m.id);
    expect((await ok('lead', [...action('complete', m), '--yes'])).state).toBe('completed');

    // Discover the seeded conflict by name, withdraw it, and move it to a free interval.
    const pending = await ok('lead', ['missions', 'list', '--search', 'Awaiting review']);
    let conflict = await show(pending.items[0].id);
    await error('director', action('approve', conflict), 'CREW_CONFLICT');
    conflict = await ok('lead', [...action('withdraw', conflict), '--reason', 'Choose a free day', '--yes']);
    conflict = await ok('lead', [...action('update', conflict), '--start', at(12, 9), '--end', at(12, 17)]);
    conflict = await acceptAll(conflict.id);
    conflict = await ok('lead', action('submit', conflict));
    conflict = await ok('director', action('approve', conflict));
    conflict = await ok('lead', [...action('cancel', conflict), '--reason', 'Run cancelled', '--yes']);
    expect(conflict.assignments.every((a: { state: string }) => a.state === 'released')).toBe(true);
  } finally {
    await stop();
    await rm(directory, { recursive: true, force: true });
  }
}, 60000);
