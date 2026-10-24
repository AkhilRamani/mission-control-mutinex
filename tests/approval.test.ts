import { beforeEach, describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { serve } from '@hono/node-server';
import { createApp } from '../src/api/app.js';
import { assignments, availability, missionEvents, missions } from '../src/db/schema.js';
import { seedPassword, tenantIds } from '../src/db/fixtures.js';
import { useTestDatabase } from './database.js';
import { createApiClient } from './api-client.js';
import { createCliRunner } from './cli-runner.js';

const { runtime } = useTestDatabase();
const alex = '10000000-0000-4000-8003-000000000004', sam = '10000000-0000-4000-8003-000000000005';
const pilot = '10000000-0000-4000-8002-000000000001', medical = '10000000-0000-4000-8002-000000000002';
const alexWindow = '10000000-0000-4000-8004-000000000004';
const ownerId = '10000000-0000-4000-8001-000000000003';
const plan = { title: 'Supply flight', brief: 'Deliver supplies', start: '2030-01-10T09:00:00Z', end: '2030-01-10T17:00:00Z' };
let app: ReturnType<typeof createApp>;
let client: ReturnType<typeof createApiClient>;
beforeEach(() => { app = createApp(runtime.db, { log: () => {} }); client = createApiClient(app, runtime.db); });
const path = (id: string) => `/missions/${id}`;
const show = (id: string) => client.ok('atlas/lead', path(id));
async function create(owner = 'atlas/lead') {
  let m = await client.ok(owner, '/missions', 'POST', plan);
  for (const [label, skillId] of [['Pilot', pilot], ['Medic', medical]]) {
    m = await client.ok(owner, `${path(m.id)}/positions`, 'POST', { version: m.version, label, requirements: [{ skillId, minProficiency: 3 }] });
  }
  return client.ok(owner, `${path(m.id)}/proposals`, 'PUT', { version: m.version,
    proposals: m.positions.map((p: { id: string }, i: number) => ({ positionId: p.id, crewId: [sam, alex][i] })),
  });
}
async function acceptAll(id: string) {
  let m = await show(id);
  for (const actor of ['atlas/sam', 'atlas/alex']) {
    const crewId = actor === 'atlas/sam' ? sam : alex;
    const a = m.assignments.find((a: { crewId: string; state: string }) => a.crewId === crewId && a.state === 'proposed');
    await client.ok(actor, `/assignments/${a.id}/accept`, 'POST', { version: m.version });
    m = await show(id);
  }
  return m;
}
async function submit(id: string) {
  const m = await acceptAll(id);
  return client.ok('atlas/director', `${path(id)}/submit`, 'POST', { version: m.version });
}
async function approve(m: Awaited<ReturnType<typeof create>>, actor = 'atlas/director') {
  return client.ok(actor, `${path(m.id)}/approve`, 'POST', { version: m.version });
}
async function history(id: string) { return client.ok('atlas/director', `${path(id)}/history`); }

describe('submission and independent approval', () => {
  it('freezes accepted consent, then books the whole plan and preserves private history projections', async () => {
    const accepted = await acceptAll((await create()).id);
    const submitted = await client.ok('atlas/lead', `${path(accepted.id)}/submit`, 'POST', { version: accepted.version });
    expect(submitted).toMatchObject({ state: 'submitted', version: accepted.version + 1, assignments: accepted.assignments });
    await client.error('atlas/lead', path(submitted.id), 'PATCH', { version: submitted.version, title: 'Frozen' }, 409);
    await client.error('atlas/alex', `/assignments/${submitted.assignments.find((a: { crewId: string }) => a.crewId === alex).id}/retract`, 'POST', { version: submitted.version }, 409);
    const approved = await approve(submitted);
    expect(approved).toMatchObject({ state: 'approved', version: submitted.version + 1 });
    expect(approved.assignments).toEqual(submitted.assignments.map((a: object) => ({ ...a, state: 'confirmed',
      bookedStart: new Date(plan.start).toISOString(), bookedEnd: new Date(plan.end).toISOString() })));
    const events = (await history(approved.id)).items;
    expect(events.map((e: { missionVersion: number }) => e.missionVersion)).toEqual(Array.from({ length: approved.version }, (_, i) => i + 1));
    expect(events.slice(-2).map((e: { kind: string }) => e.kind)).toEqual(['mission_submitted', 'mission_approved']);
    expect(events.at(-1).payload.assignmentChanges).toHaveLength(2);
    expect(events.at(-1).payload.assignmentChanges[0]).toMatchObject({ before: { state: 'accepted' }, after: { state: 'confirmed' } });
    const own = await client.ok('atlas/alex', `${path(approved.id)}/history`);
    expect(own.items.slice(-2).map((e: { kind: string }) => e.kind)).toEqual(['mission_submitted', 'mission_approved']);
    expect(JSON.stringify(own)).not.toContain(sam);
    expect(JSON.stringify(own)).not.toContain('actorId');
    expect((await client.error('atlas/director', `${path(approved.id)}/approve`, 'POST', { version: submitted.version }, 409)).code).toBe('STALE_VERSION');
    for (const action of ['submit', 'withdraw', 'approve', 'reject']) {
      await client.error('atlas/director', `${path(approved.id)}/${action}`, 'POST', { version: approved.version,
        ...(['withdraw', 'reject'].includes(action) ? { reason: 'Already approved' } : {}) }, 409);
    }
    expect(await show(approved.id)).toEqual(approved);
    expect((await history(approved.id)).items).toEqual(events);
  });

  it('requires positions, a complete roster and fresh personal consent, without partial submission', async () => {
    const empty = await client.ok('atlas/lead', '/missions', 'POST', plan);
    expect((await client.error('atlas/lead', `${path(empty.id)}/submit`, 'POST', { version: empty.version }, 422)).code).toBe('INCOMPLETE_ROSTER');
    let m = await create();
    expect((await client.error('atlas/lead', `${path(m.id)}/submit`, 'POST', { version: m.version }, 422)).code).toBe('CONSENT_REQUIRED');
    const declined = m.assignments.find((a: { crewId: string }) => a.crewId === alex);
    await client.ok('atlas/alex', `/assignments/${declined.id}/decline`, 'POST', { version: m.version });
    m = await show(m.id);
    expect((await client.error('atlas/lead', `${path(m.id)}/submit`, 'POST', { version: m.version }, 422)).code).toBe('INCOMPLETE_ROSTER');
    const before = await show(m.id);
    expect(before.state).toBe('draft');
    expect(before.assignments.every((a: { bookedStart: string | null }) => a.bookedStart === null)).toBe(true);
    expect((await history(m.id)).items.some((e: { kind: string }) => e.kind === 'mission_submitted')).toBe(false);
  });

  it('rechecks current skills, active status, availability and future start at submission and approval', async () => {
    let m = await acceptAll((await create()).id);
    await client.ok('atlas/alex', `/crew/me/skills/${medical}`, 'PUT', { proficiency: 2 });
    expect((await client.error('atlas/lead', `${path(m.id)}/submit`, 'POST', { version: m.version }, 422)).code).toBe('INELIGIBLE_CREW');
    expect(await show(m.id)).toEqual(m);
    await client.ok('atlas/alex', `/crew/me/skills/${medical}`, 'PUT', { proficiency: 4 });
    m = await client.ok('atlas/lead', `${path(m.id)}/submit`, 'POST', { version: m.version });
    for (const [change, restore] of [
      [() => client.ok('atlas/alex', `/crew/me/skills/${medical}`, 'PUT', { proficiency: 2 }),
        () => client.ok('atlas/alex', `/crew/me/skills/${medical}`, 'PUT', { proficiency: 4 })],
      [() => client.ok('atlas/director', `/crew/${alex}`, 'PATCH', { active: false }),
        () => client.ok('atlas/director', `/crew/${alex}`, 'PATCH', { active: true })],
      [() => client.ok('atlas/alex', `/crew/me/availability/${alexWindow}`, 'DELETE'),
        () => client.ok('atlas/alex', '/crew/me/availability', 'POST', { start: plan.start, end: plan.end })],
    ]) {
      await change!();
      expect((await client.error('atlas/director', `${path(m.id)}/approve`, 'POST', { version: m.version }, 422)).code).toBe('INELIGIBLE_CREW');
      expect(await show(m.id)).toEqual(m);
      await restore!();
    }
    await runtime.db.update(missions).set({ start: new Date('2000-01-01Z') }).where(eq(missions.id, m.id));
    expect((await client.error('atlas/director', `${path(m.id)}/approve`, 'POST', { version: m.version }, 409)).code).toBe('START_NOT_FUTURE');
    expect((await history(m.id)).items.at(-1).kind).toBe('mission_submitted');
  });

  it('checks visibility and ownership before version/state and keeps approval independent of the immutable creator', async () => {
    const m = await submit((await create()).id);
    const foreign = await client.ok('boreal/lead', '/missions', 'POST', plan);
    await client.ok('atlas/director', '/members', 'POST', { username: 'lead2', displayName: 'Other Lead', role: 'lead', password: seedPassword });
    for (const action of ['submit', 'withdraw', 'approve', 'reject']) {
      const body = { version: 999, ...(['withdraw', 'reject'].includes(action) ? { reason: 'Private decision' } : {}) };
      const baseline = await client.error('atlas/director', `${path(randomUUID())}/${action}`, 'POST', body);
      expect(await client.error('atlas/director', `${path(foreign.id)}/${action}`, 'POST', body)).toEqual(baseline);
      expect(await client.error('boreal/director', `${path(m.id)}/${action}`, 'POST', body)).toEqual(baseline);
      await client.error('atlas/alex', `${path(m.id)}/${action}`, 'POST', body, 403);
      await client.error('atlas/lead2', `${path(m.id)}/${action}`, 'POST', body, 403);
    }
    await client.error('atlas/lead', `${path(m.id)}/approve`, 'POST', { version: m.version }, 403);
    let directorOwned = await submit((await create('atlas/director')).id);
    for (const action of ['approve', 'reject']) {
      await client.error('atlas/director', `${path(directorOwned.id)}/${action}`, 'POST', { version: 999,
        ...(action === 'reject' ? { reason: 'Self approval forbidden' } : {}) }, 403);
    }
    directorOwned = await approve(directorOwned, 'atlas/director2');
    expect(directorOwned.ownerId).toBe('10000000-0000-4000-8001-000000000001');
  });

  it.each(['withdraw', 'reject'] as const)('%s returns to draft, records a private reason and requires fresh consent', async (action) => {
    const m = await submit((await create()).id);
    const actor = action === 'withdraw' ? 'atlas/lead' : 'atlas/director';
    for (const reason of [undefined, ' ']) {
      await client.error(actor, `${path(m.id)}/${action}`, 'POST', { version: m.version, reason }, 400);
    }
    const reason = 'Revise the supply plan';
    const returned = await client.ok(actor, `${path(m.id)}/${action}`, 'POST', { version: m.version, reason });
    expect(returned).toMatchObject({ state: 'draft', version: m.version + 1 });
    expect(returned.assignments).toEqual(m.assignments.map((a: object) => ({ ...a, state: 'proposed', respondedAt: null })));
    expect((await history(m.id)).items.at(-1).payload).toMatchObject({ reason,
      assignmentChanges: expect.arrayContaining([expect.objectContaining({ before: expect.objectContaining({ state: 'accepted', respondedAt: expect.any(String) }) })]) });
    const own = await client.ok('atlas/alex', `${path(m.id)}/history`);
    expect(own.items.at(-1).kind).toBe(action === 'withdraw' ? 'mission_withdrawn' : 'mission_rejected');
    expect(JSON.stringify(own)).not.toContain(reason);
    expect(JSON.stringify(own)).not.toContain(sam);
    await client.error(actor, `${path(m.id)}/${action}`, 'POST', { version: returned.version, reason }, 409);
    await client.error('atlas/lead', `${path(m.id)}/submit`, 'POST', { version: returned.version }, 422);
    expect((await submit(m.id)).state).toBe('submitted');
  });

  it('rolls back bookings and consent resets when event insertion fails', async () => {
    // Withdrawal/rejection share the same operation; cover its reset and approval's booking writes.
    for (const action of ['withdraw', 'approve'] as const) {
      const m = await submit((await create()).id);
      await runtime.db.insert(missionEvents).values({ tenantId: tenantIds.atlas, missionId: m.id,
        missionVersion: m.version + 1, actorId: ownerId, kind: 'mission_updated', payload: {} });
      await client.error('atlas/director', `${path(m.id)}/${action}`, 'POST', { version: m.version,
        ...(action === 'withdraw' ? { reason: 'Should roll back' } : {}) }, 409);
      expect(await show(m.id)).toEqual(m);
    }
  });
});

describe('confirmed-work profile protection', () => {
  it('checks every required skill while allowing skill changes for a position with no requirements', async () => {
    let m = await create();
    m = await client.ok('atlas/lead', `${path(m.id)}/positions/${m.positions[0].id}`, 'PATCH', { version: m.version, requirements: [] });
    m = await client.ok('atlas/lead', `${path(m.id)}/positions/${m.positions[1].id}`, 'PATCH', { version: m.version,
      requirements: [{ skillId: pilot, minProficiency: 3 }, { skillId: medical, minProficiency: 3 }] });
    m = await approve(await submit(m.id));
    for (const skillId of [pilot, medical]) {
      const failure = await client.error('atlas/alex', `/crew/me/skills/${skillId}`, 'DELETE', undefined, 409);
      expect(failure.code).toBe('CONFIRMED_WORK');
    }
    await client.ok('atlas/sam', `/crew/me/skills/${pilot}`, 'DELETE');
    await client.error('atlas/director', `/crew/${sam}`, 'PATCH', { active: false }, 409);
    expect((await show(m.id)).assignments).toEqual(m.assignments);
  });

  it('preserves skills, active status and full availability while allowing edits that keep commitments valid', async () => {
    const m = await approve(await submit((await create()).id));
    const before = await client.ok('atlas/alex', '/crew/me');
    expect((await client.error('atlas/director', `/crew/${alex}`, 'PATCH', { active: false, biography: 'Must roll back', displayName: 'Changed' }, 409)).code).toBe('CONFIRMED_WORK');
    expect(await client.ok('atlas/alex', '/crew/me')).toEqual(before);
    for (const [target, method, body] of [
      [`/crew/me/skills/${medical}`, 'PUT', { proficiency: 2 }],
      [`/crew/me/skills/${medical}`, 'DELETE', undefined],
      [`/crew/me/availability/${alexWindow}`, 'DELETE', undefined],
    ] as [string, string, unknown][]) {
      const error = await client.error('atlas/alex', target, method, body, 409);
      expect(error.code).toBe('CONFIRMED_WORK');
      expect(JSON.stringify(error)).not.toContain(m.id);
    }
    await client.ok('atlas/alex', `/crew/me/skills/${medical}`, 'PUT', { proficiency: 3 });
    await client.ok('atlas/alex', `/crew/me/skills/${pilot}`, 'DELETE'); // Not required by Alex's position.
    await client.ok('atlas/alex', '/crew/me', 'PATCH', { biography: 'Still available', displayName: 'Alex Updated' });
    const split = '2030-01-10T12:00:00Z';
    const first = await client.ok('atlas/alex', '/crew/me/availability', 'POST', { start: plan.start, end: split });
    await client.ok('atlas/alex', '/crew/me/availability', 'POST', { start: split, end: plan.end });
    await client.ok('atlas/alex', `/crew/me/availability/${alexWindow}`, 'DELETE'); // Adjacent windows still cover it.
    await client.error('atlas/alex', `/crew/me/availability/${first.id}`, 'DELETE', undefined, 409);
    expect((await client.ok('atlas/alex', '/crew/me')).skills).toMatchObject([{ id: medical, proficiency: 3 }]);
    expect((await client.ok('atlas/alex', '/crew/me/availability')).items).toHaveLength(2);
    expect(await show(m.id)).toEqual(m); // Profile edits do not mutate missions or lock their rows.
  });

  it('guards active work, but ended or explicitly completed work imposes no profile restriction', async () => {
    const m = await approve(await submit((await create()).id));
    await runtime.db.update(missions).set({ start: new Date('2000-01-01Z') }).where(eq(missions.id, m.id));
    await runtime.db.update(assignments).set({ bookedStart: new Date('2000-01-01Z') }).where(eq(assignments.missionId, m.id));
    await runtime.db.update(availability).set({ start: new Date('2000-01-01Z') }).where(eq(availability.crewId, alex));
    await client.error('atlas/alex', `/crew/me/skills/${medical}`, 'DELETE', undefined, 409);
    await runtime.db.update(missions).set({ end: new Date('2000-01-02Z') }).where(eq(missions.id, m.id));
    await runtime.db.update(assignments).set({ bookedEnd: new Date('2000-01-02Z') }).where(eq(assignments.missionId, m.id));
    await client.ok('atlas/alex', `/crew/me/skills/${medical}`, 'DELETE');
    await runtime.db.update(missions).set({ state: 'completed' }).where(eq(missions.id, m.id));
    await client.ok('atlas/alex', `/crew/me/availability/${alexWindow}`, 'DELETE');
    await client.ok('atlas/director', `/crew/${alex}`, 'PATCH', { active: false });
  });
});

// Observe real PostgreSQL lock waits rather than depending on request timing.
async function waitForLocks(count = 1) {
  const deadline = Date.now() + 3000;
  while (Date.now() < deadline) {
    const result = await runtime.pool.query("SELECT 1 FROM pg_stat_activity WHERE datname = current_database() AND usename = current_user AND wait_event_type = 'Lock'");
    if ((result.rowCount ?? 0) >= count) return;
    await delay(10);
  }
  throw new Error(`Expected ${count} blocked requests`);
}

describe('approval concurrency', () => {
  it('allows exactly one conflicting approval and keeps every losing assignment accepted', async () => {
    const first = await submit((await create()).id), second = await submit((await create()).id);
    const responses = await Promise.all([first, second].map((m) =>
      client.request('atlas/director', `${path(m.id)}/approve`, 'POST', { version: m.version })));
    expect(responses.map((r) => r.status).sort()).toEqual([200, 409]);
    const loser = responses.findIndex((r) => r.status === 409);
    const failure = JSON.parse(await responses[loser]!.text()).error;
    expect(failure.code).toBe('CREW_CONFLICT');
    expect(JSON.stringify(failure)).not.toContain([first, second][1 - loser]!.id);
    for (const [i, before] of [first, second].entries()) {
      const after = await show(before.id);
      if (i === loser) expect(after).toEqual(before);
      else {
        expect(after.state).toBe('approved');
        expect(after.assignments.every((a: { state: string }) => a.state === 'confirmed')).toBe(true);
      }
      expect((await history(before.id)).items.filter((e: { kind: string }) => e.kind === 'mission_approved')).toHaveLength(i === loser ? 0 : 1);
    }
    expect(await runtime.db.select().from(assignments).where(and(eq(assignments.tenantId, tenantIds.atlas), eq(assignments.state, 'confirmed')))).toHaveLength(2);
  });

  it('serialises approval against withdrawal using the reviewed mission version', async () => {
    const m = await submit((await create()).id);
    const results = await Promise.all([
      client.request('atlas/director', `${path(m.id)}/approve`, 'POST', { version: m.version }),
      client.request('atlas/lead', `${path(m.id)}/withdraw`, 'POST', { version: m.version, reason: 'Needs revision' }),
    ]);
    expect(results.map((r) => r.status).sort()).toEqual([200, 409]);
    const after = await show(m.id);
    expect(after.version).toBe(m.version + 1);
    expect(after.assignments.every((a: { state: string }) => a.state === (after.state === 'approved' ? 'confirmed' : 'proposed'))).toBe(true);
  });

  it('sees a skill edit that commits while approval waits for its crew lock', async () => {
    const m = await submit((await create()).id);
    await client.token('atlas/alex');
    const blocker = await runtime.pool.connect();
    let pending: Promise<Response> | undefined, edit: Promise<Response> | undefined;
    try {
      await blocker.query('BEGIN');
      // Hold the skill row so the real edit owns the crew lock before approval starts.
      await blocker.query('SELECT skill_id FROM crew_skills WHERE tenant_id = $1 AND crew_id = $2 AND skill_id = $3 FOR UPDATE', [tenantIds.atlas, alex, medical]);
      edit = client.request('atlas/alex', `/crew/me/skills/${medical}`, 'PUT', { proficiency: 2 });
      await waitForLocks();
      pending = client.request('atlas/director', `${path(m.id)}/approve`, 'POST', { version: m.version });
      await waitForLocks(2);
      await blocker.query('COMMIT');
      expect((await edit).status).toBe(200);
      const response = await pending;
      expect(response.status).toBe(422);
      expect(JSON.parse(await response.text()).error.code).toBe('INELIGIBLE_CREW');
    } finally { await blocker.query('ROLLBACK'); blocker.release(); await Promise.all([pending, edit]); }
    expect(await show(m.id)).toEqual(m);
  });

  it('rejects a real profile edit after waiting for approval to commit its booking', async () => {
    const m = await submit((await create()).id);
    await client.token('atlas/alex');
    const blocker = await runtime.pool.connect();
    let approval: Promise<Response> | undefined, edit: Promise<Response> | undefined;
    try {
      await blocker.query('BEGIN');
      // The event actor FK delays commit after approval has taken all crew locks.
      await blocker.query('SELECT id FROM users WHERE id = $1 FOR UPDATE', ['10000000-0000-4000-8001-000000000001']);
      approval = client.request('atlas/director', `${path(m.id)}/approve`, 'POST', { version: m.version });
      await waitForLocks();
      edit = client.request('atlas/alex', `/crew/me/skills/${medical}`, 'DELETE');
      await waitForLocks(2);
      await blocker.query('COMMIT');
      expect((await approval).status).toBe(200);
      const response = await edit;
      expect(response.status).toBe(409);
      expect(JSON.parse(await response.text()).error.code).toBe('CONFIRMED_WORK');
    } finally { await blocker.query('ROLLBACK'); blocker.release(); await Promise.all([approval, edit]); }
    expect((await client.ok('atlas/alex', '/crew/me')).skills.some((s: { id: string }) => s.id === medical)).toBe(true);
  });

  it('rejects approval when a crew lock wait crosses the mission start', async () => {
    const m = await submit((await create()).id);
    await client.token('atlas/director');
    const start = new Date(Date.now() + 600), end = new Date(+start + 3_600_000);
    await runtime.db.update(missions).set({ start, end }).where(eq(missions.id, m.id));
    const blocker = await runtime.pool.connect();
    let pending: Promise<Response> | undefined;
    try {
      await blocker.query('BEGIN');
      await blocker.query('SELECT id FROM crew WHERE id = $1 FOR UPDATE', [alex]);
      pending = client.request('atlas/director', `${path(m.id)}/approve`, 'POST', { version: m.version });
      await waitForLocks();
      await delay(Math.max(0, +start - Date.now() + 50));
      await blocker.query('COMMIT');
      const response = await pending;
      expect(response.status).toBe(409);
      expect(JSON.parse(await response.text()).error.code).toBe('START_NOT_FUTURE');
    } finally { await blocker.query('ROLLBACK'); blocker.release(); await pending; }
    const after = await show(m.id);
    expect(after).toMatchObject({ state: m.state, version: m.version, assignments: m.assignments });
  });
});

it('submits, withdraws, rejects and approves through the real CLI with explicit stale-version recovery', async () => {
  let m = await acceptAll((await create()).id);
  const directory = await mkdtemp(join(tmpdir(), 'mc-approval-'));
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
  const args = (action: string) => ['missions', action, '--mission', m.id, '--version', String(m.version)];
  try {
    await cli(['login', '--org', 'atlas', '--username', 'lead', '--password-stdin'], `${seedPassword}\n`);
    m = await cli(args('submit'));
    expect(m.state).toBe('submitted');
    const unconfirmed = await run([...args('withdraw'), '--reason', 'Revise']);
    expect(JSON.parse(unconfirmed.stderr).error.code).toBe('CONFIRMATION_REQUIRED');
    m = await cli([...args('withdraw'), '--reason', 'Revise', '--yes']);
    expect(m.state).toBe('draft');
    m = await acceptAll(m.id);
    m = await cli(args('submit'));
    await cli(['logout']);
    await cli(['login', '--org', 'atlas', '--username', 'director', '--password-stdin'], `${seedPassword}\n`);
    m = await cli([...args('reject'), '--reason', 'Revise again', '--yes']);
    m = await acceptAll(m.id);
    m = await cli(args('submit'));
    const unreviewed = await run(['missions', 'approve', '--mission', m.id]);
    expect(JSON.parse(unreviewed.stderr).error.code).toBe('VERSION_REQUIRED');
    const stale = await run(['missions', 'approve', '--mission', m.id, '--version', String(m.version - 1)]);
    expect(JSON.parse(stale.stderr).error.code).toBe('STALE_VERSION');
    expect(await show(m.id)).toEqual(m);
    m = await cli(args('approve'));
    expect(m.state).toBe('approved');
    expect((await cli(['missions', 'history', '--mission', m.id])).items.at(-1).kind).toBe('mission_approved');
  } finally {
    if ('closeAllConnections' in server) server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    await rm(directory, { recursive: true, force: true });
  }
}, 30000);
