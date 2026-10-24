import { beforeEach, describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../src/api/app.js';
import { assignments, missionEvents, missions } from '../src/db/schema.js';
import { seedPassword, tenantIds } from '../src/db/fixtures.js';
import { useTestDatabase } from './database.js';
import { createApiClient } from './api-client.js';
import { createCliRunner, serveCliApp } from './cli-runner.js';

const { runtime, waitForLocks } = useTestDatabase();
const alex = '10000000-0000-4000-8003-000000000004', sam = '10000000-0000-4000-8003-000000000005';
const pilot = '10000000-0000-4000-8002-000000000001', medical = '10000000-0000-4000-8002-000000000002';
const ownerId = '10000000-0000-4000-8001-000000000003';
const plan = { title: 'Supply flight', brief: 'Deliver supplies', start: '2030-01-10T09:00:00Z', end: '2030-01-10T17:00:00Z' };
let app: ReturnType<typeof createApp>;
let client: ReturnType<typeof createApiClient>;
beforeEach(() => { app = createApp(runtime.db, { log: () => {} }); client = createApiClient(app, runtime.db); });
const path = (id: string) => `/missions/${id}`;
const show = (id: string) => client.ok('atlas/lead', path(id));
const history = (id: string) => client.ok('atlas/lead', `${path(id)}/history`);
const cancel = (m: { id: string; version: number }) => client.ok('atlas/lead', `${path(m.id)}/cancel`, 'POST', { version: m.version, reason: 'Flight aborted' });
async function draft(times = plan) {
  let m = await client.ok('atlas/lead', '/missions', 'POST', times);
  for (const [label, skillId] of [['Pilot', pilot], ['Medic', medical]]) {
    m = await client.ok('atlas/lead', `${path(m.id)}/positions`, 'POST', { version: m.version, label, requirements: [{ skillId, minProficiency: 3 }] });
  }
  return m;
}
async function proposed() {
  const m = await draft();
  return client.ok('atlas/lead', `${path(m.id)}/proposals`, 'PUT', { version: m.version,
    proposals: m.positions.map((p: { id: string }, i: number) => ({ positionId: p.id, crewId: [sam, alex][i] })),
  });
}
async function acceptAll(id: string) {
  let m = await show(id);
  for (const [actor, crewId] of [['atlas/sam', sam], ['atlas/alex', alex]] as const) {
    const a = m.assignments.find((a: { crewId: string }) => a.crewId === crewId);
    await client.ok(actor, `/assignments/${a.id}/accept`, 'POST', { version: m.version });
    m = await show(m.id);
  }
  return m;
}
async function submitted() {
  const m = await acceptAll((await proposed()).id);
  return client.ok('atlas/lead', `${path(m.id)}/submit`, 'POST', { version: m.version });
}
async function approved() {
  const m = await submitted();
  return client.ok('atlas/director', `${path(m.id)}/approve`, 'POST', { version: m.version });
}
// Move fixture intervals instead of introducing a clock service or waiting for real mission durations.
async function moveInterval(id: string, start: Date, end: Date) {
  await runtime.db.transaction(async (tx) => {
    await tx.update(missions).set({ start, end }).where(and(eq(missions.tenantId, tenantIds.atlas), eq(missions.id, id)));
    await tx.update(assignments).set({ bookedStart: start, bookedEnd: end })
      .where(and(eq(assignments.tenantId, tenantIds.atlas), eq(assignments.missionId, id), eq(assignments.state, 'confirmed')));
  });
  return show(id);
}
const endMission = (id: string) => moveInterval(id, new Date('2000-01-10T09:00:00Z'), new Date('2000-01-10T17:00:00Z'));

describe('mission operation', () => {
  it('exposes clock-driven phases to planners and crew without mutating state, version or history', async () => {
    let m = await approved();
    const events = await history(m.id);
    const a = m.assignments.find((a: { crewId: string }) => a.crewId === alex);
    for (const phase of ['scheduled', 'active', 'awaiting_completion']) {
      if (phase === 'active') m = await moveInterval(m.id, new Date(Date.now() - 3_600_000), new Date(Date.now() + 3_600_000));
      if (phase === 'awaiting_completion') m = await endMission(m.id);
      expect(await client.ok('atlas/alex', path(m.id))).toMatchObject({ state: 'approved', phase, version: m.version });
      expect((await client.ok('atlas/lead', '/missions?state=approved')).items[0].phase).toBe(phase);
      expect((await client.ok('atlas/alex', '/assignments?mine=true')).items[0].phase).toBe(phase);
      expect((await client.ok('atlas/alex', `/assignments/${a.id}`)).mission.phase).toBe(phase);
      expect(await history(m.id)).toEqual(events);
    }
  });

  it('completes only approved, ended missions and retains bookings, responses and own history', async () => {
    let m = await approved();
    expect((await client.error('atlas/lead', `${path(m.id)}/complete`, 'POST', { version: m.version }, 409)).code).toBe('MISSION_NOT_ENDED');
    expect(await show(m.id)).toEqual(m);
    m = await endMission(m.id);
    const completed = await client.ok('atlas/lead', `${path(m.id)}/complete`, 'POST', { version: m.version });
    expect(completed).toMatchObject({ state: 'completed', phase: null, version: m.version + 1, assignments: m.assignments });
    const event = (await history(m.id)).items.at(-1);
    expect(event.kind).toBe('mission_completed');
    expect(event.payload.assignmentChanges).toHaveLength(2);
    const own = await client.ok('atlas/alex', `${path(m.id)}/history`);
    expect(own.items.at(-1).kind).toBe('mission_completed');
    expect(JSON.stringify(own)).not.toContain(sam);
    expect(JSON.stringify(own)).not.toContain('actorId');
    // Historical bookings impose no eligibility restrictions after their end.
    await client.ok('atlas/alex', `/crew/me/skills/${medical}`, 'DELETE');
    for (const action of ['cancel', 'complete']) {
      await client.error('atlas/director', `${path(m.id)}/${action}`, 'POST', { version: completed.version,
        ...(action === 'cancel' ? { reason: 'Too late' } : {}) }, 409);
    }
    expect(await show(m.id)).toEqual(completed);
  });

  it.each(['draft', 'submitted', 'approved'])('cancels %s plans, retaining responses and private release history', async (state) => {
    let m = state === 'draft' ? await proposed() : state === 'submitted' ? await submitted() : await approved();
    if (state === 'draft') {
      const a = m.assignments.find((a: { crewId: string }) => a.crewId === alex);
      const s = m.assignments.find((a: { crewId: string }) => a.crewId === sam);
      await client.ok('atlas/alex', `/assignments/${a.id}/decline`, 'POST', { version: m.version });
      m = await show(m.id);
      m = await client.ok('atlas/lead', `${path(m.id)}/proposals`, 'PUT', { version: m.version,
        proposals: [{ positionId: a.positionId, crewId: alex }, { positionId: s.positionId, crewId: sam }] });
      await client.ok('atlas/sam', `/assignments/${s.id}/accept`, 'POST', { version: m.version });
      m = await show(m.id); // Includes declined, proposed and accepted attempts.
    }
    const cancelled = await cancel(m);
    expect(cancelled).toMatchObject({ state: 'cancelled', phase: null, version: m.version + 1 });
    expect(cancelled.assignments).toEqual(m.assignments.map((a: { state: string }) => ({ ...a,
      ...(['proposed', 'accepted', 'confirmed'].includes(a.state) ? {
        state: a.state === 'confirmed' ? 'released' : 'withdrawn', bookedStart: null, bookedEnd: null,
      } : {}),
    })));
    const event = (await history(m.id)).items.at(-1);
    expect(event).toMatchObject({ kind: 'mission_cancelled', payload: { reason: 'Flight aborted' } });
    expect(event.payload.assignmentChanges).toHaveLength(2);
    if (state === 'approved') expect(event.payload.assignmentChanges[0].before.bookedStart).toBe(plan.start.replace('Z', '.000Z'));
    const own = await client.ok('atlas/alex', `${path(m.id)}/history`);
    expect(own.items.at(-1).kind).toBe('mission_cancelled');
    expect(JSON.stringify(own)).not.toContain('Flight aborted');
    expect(JSON.stringify(own)).not.toContain(sam);
    const stale = await client.error('atlas/lead', `${path(m.id)}/cancel`, 'POST', { version: m.version, reason: 'Retry' }, 409);
    expect(stale.code).toBe('STALE_VERSION');
    for (const action of ['cancel', 'complete']) {
      await client.error('atlas/lead', `${path(m.id)}/${action}`, 'POST', { version: cancelled.version,
        ...(action === 'cancel' ? { reason: 'Retry with new version' } : {}) }, 409);
    }
    expect(await show(m.id)).toEqual(cancelled);
    expect((await history(m.id)).items.at(-1)).toEqual(event);
  });

  it('allows empty draft cancellation but validates reasons and blocks premature completion', async () => {
    const m = await client.ok('atlas/lead', '/missions', 'POST', plan);
    for (const reason of [undefined, ' ']) {
      await client.error('atlas/lead', `${path(m.id)}/cancel`, 'POST', { version: m.version, reason }, 400);
    }
    await client.error('atlas/lead', `${path(m.id)}/cancel`, 'POST', { version: m.version, reason: 'Abort', tenantId: tenantIds.boreal }, 400);
    await client.error('atlas/lead', `${path(m.id)}/complete`, 'POST', { version: m.version }, 409);
    const cancelled = await cancel(m);
    expect(cancelled.assignments).toEqual([]);
    expect((await history(m.id)).items.at(-1).kind).toBe('mission_cancelled');
  });

  it('allows late cancellation and releases the whole booking rather than recording completion', async () => {
    const m = await endMission((await approved()).id);
    expect(m.phase).toBe('awaiting_completion');
    const cancelled = await cancel(m);
    expect(cancelled.state).toBe('cancelled');
    expect(cancelled.assignments.every((a: { state: string; bookedEnd: null }) => a.state === 'released' && a.bookedEnd === null)).toBe(true);
    const event = (await history(m.id)).items.at(-1);
    expect(event.payload.assignmentChanges[0].before.bookedEnd).toBe('2000-01-10T17:00:00.000Z');
  });

  it('releases conflicts and workload, while a replacement requires new consent and approval', async () => {
    const original = await approved(), replacement = await draft();
    const adjacent = await draft({ ...plan, start: plan.end, end: '2030-01-11T01:00:00Z' });
    expect((await client.ok('atlas/lead', `${path(replacement.id)}/match`)).complete).toBe(false);
    const before = await client.ok('atlas/lead', `${path(adjacent.id)}/match`);
    expect(before.roster.map((r: { workloadHours: number }) => r.workloadHours)).toEqual([8, 8]);
    await client.error('atlas/lead', path(original.id), 'PATCH', { version: original.version, title: 'Change approved plan' }, 409);
    await cancel(original);
    const match = await client.ok('atlas/lead', `${path(replacement.id)}/match`);
    expect(match.complete).toBe(true);
    expect(match.roster.map((r: { workloadHours: number }) => r.workloadHours)).toEqual([0, 0]);
    let m = await client.ok('atlas/lead', `${path(replacement.id)}/proposals`, 'PUT', { version: replacement.version,
      proposals: match.roster.map(({ positionId, crewId }: { positionId: string; crewId: string }) => ({ positionId, crewId })) });
    await client.error('atlas/lead', `${path(m.id)}/submit`, 'POST', { version: m.version }, 422);
    m = await acceptAll(m.id);
    m = await client.ok('atlas/lead', `${path(m.id)}/submit`, 'POST', { version: m.version });
    expect((await client.ok('atlas/director', `${path(m.id)}/approve`, 'POST', { version: m.version })).state).toBe('approved');
  });

  it('checks tenant visibility and planner ownership before version, time and state', async () => {
    const m = await approved(), foreign = await client.ok('boreal/lead', '/missions', 'POST', plan);
    await client.ok('atlas/director', '/members', 'POST', { username: 'lead2', displayName: 'Other Lead', role: 'lead', password: seedPassword });
    for (const action of ['cancel', 'complete']) {
      const body = { version: 999, ...(action === 'cancel' ? { reason: 'Abort' } : {}) };
      const missing = await client.error('atlas/director', `${path(randomUUID())}/${action}`, 'POST', body);
      expect(await client.error('atlas/director', `${path(foreign.id)}/${action}`, 'POST', body)).toEqual(missing);
      expect(await client.error('boreal/director', `${path(m.id)}/${action}`, 'POST', body)).toEqual(missing);
      await client.error('atlas/alex', `${path(m.id)}/${action}`, 'POST', body, 403);
      await client.error('atlas/lead2', `${path(m.id)}/${action}`, 'POST', body, 403);
    }
    // A Director may operate another owner's plan; independent approval rules do not apply here.
    expect((await client.ok('atlas/director', `${path(m.id)}/cancel`, 'POST', { version: m.version, reason: 'Director decision' })).state).toBe('cancelled');
  });

  it('rolls back cancellation and booking releases if history cannot be recorded', async () => {
    const m = await approved();
    await runtime.db.insert(missionEvents).values({ tenantId: tenantIds.atlas, missionId: m.id,
      missionVersion: m.version + 1, actorId: ownerId, kind: 'mission_updated', payload: {} });
    await client.error('atlas/lead', `${path(m.id)}/cancel`, 'POST', { version: m.version, reason: 'Must roll back' }, 409);
    expect(await show(m.id)).toEqual(m);
  });
});

describe('operation concurrency', () => {
  it.each(['approve', 'complete'])('serialises cancellation against %s with one version and event', async (action) => {
    const m = action === 'approve' ? await submitted() : await endMission((await approved()).id);
    const results = await Promise.all([
      client.request('atlas/lead', `${path(m.id)}/cancel`, 'POST', { version: m.version, reason: 'Abort' }),
      client.request('atlas/director', `${path(m.id)}/${action}`, 'POST', { version: m.version }),
    ]);
    expect(results.map((r) => r.status).sort()).toEqual([200, 409]);
    const after = await show(m.id);
    expect(after.version).toBe(m.version + 1);
    expect(after.assignments.every((a: { state: string }) => a.state === (after.state === 'cancelled'
      ? (action === 'approve' ? 'withdrawn' : 'released') : 'confirmed'))).toBe(true);
    expect((await history(m.id)).items).toHaveLength(after.version);
  });

  it('lets a waiting profile edit proceed after cancellation releases confirmed work', async () => {
    const m = await approved();
    await client.token('atlas/alex');
    const blocker = await runtime.pool.connect();
    let cancellation: Promise<Response> | undefined, edit: Promise<Response> | undefined;
    try {
      await blocker.query('BEGIN');
      // Delay event insertion after cancellation owns crew locks and has released bookings.
      await blocker.query('SELECT id FROM users WHERE id = $1 FOR UPDATE', [ownerId]);
      cancellation = client.request('atlas/lead', `${path(m.id)}/cancel`, 'POST', { version: m.version, reason: 'Abort' });
      await waitForLocks(1);
      edit = client.request('atlas/alex', `/crew/me/skills/${medical}`, 'DELETE');
      await waitForLocks(2);
      await blocker.query('COMMIT');
      expect((await cancellation).status).toBe(200);
      expect((await edit).status).toBe(200);
    } finally { await blocker.query('ROLLBACK'); blocker.release(); await Promise.all([cancellation, edit]); }
    expect((await show(m.id)).state).toBe('cancelled');
  });
});

it('shows phases and closes missions through the real CLI, requiring reviewed versions and confirmation', async () => {
  const first = await approved();
  const directory = await mkdtemp(join(tmpdir(), 'mc-lifecycle-'));
  const server = await serveCliApp(app);
  const run = createCliRunner(directory, server.url);
  async function cli(args: string[], input = '') {
    const result = await run(args, input);
    expect(result.code, result.stderr).toBe(0);
    return JSON.parse(result.stdout);
  }
  const args = (action: string, m: { id: string; version: number }) => ['missions', action, '--mission', m.id, '--version', String(m.version)];
  try {
    await cli(['login', '--org', 'atlas', '--username', 'lead', '--password-stdin'], `${seedPassword}\n`);
    expect((await cli(['missions', 'show', '--mission', first.id])).phase).toBe('scheduled');
    const early = await run([...args('complete', first), '--yes']);
    expect(JSON.parse(early.stderr).error.code).toBe('MISSION_NOT_ENDED');
    const unconfirmed = await run([...args('cancel', first), '--reason', 'Abort']);
    expect(JSON.parse(unconfirmed.stderr).error.code).toBe('CONFIRMATION_REQUIRED');
    expect((await cli([...args('cancel', first), '--reason', 'Abort', '--yes'])).state).toBe('cancelled');
    const second = await endMission((await approved()).id);
    const completed = await cli([...args('complete', second), '--yes']);
    expect(completed).toMatchObject({ state: 'completed', phase: null });
    expect((await cli(['missions', 'history', '--mission', second.id])).items.at(-1).kind).toBe('mission_completed');
  } finally {
    await server.close();
    await rm(directory, { recursive: true, force: true });
  }
}, 20000);
