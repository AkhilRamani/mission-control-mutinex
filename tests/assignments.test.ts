import { beforeEach, describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { serve } from '@hono/node-server';
import { createApp } from '../src/api/app.js';
import { assignments, crew, missionEvents, missions, positions, users } from '../src/db/schema.js';
import { seedPassword, tenantIds } from '../src/db/fixtures.js';
import { useTestDatabase } from './database.js';
import { createApiClient } from './api-client.js';
import { createCliRunner } from './cli-runner.js';

const { runtime, waitForLocks } = useTestDatabase();
const tenantId = tenantIds.atlas;
const ownerId = '10000000-0000-4000-8001-000000000003';
const alex = '10000000-0000-4000-8003-000000000004', sam = '10000000-0000-4000-8003-000000000005';
const leadCrew = '10000000-0000-4000-8003-000000000003';
const foreignCrew = '20000000-0000-4000-8003-000000000003';
const pilot = '10000000-0000-4000-8002-000000000001', medical = '10000000-0000-4000-8002-000000000002';
const plan = { title: 'Supply flight', brief: 'Deliver supplies', start: '2030-01-10T09:00:00Z', end: '2030-01-10T17:00:00Z' };
let app: ReturnType<typeof createApp>;
let client: ReturnType<typeof createApiClient>;
beforeEach(() => { app = createApp(runtime.db, { log: () => {} }); client = createApiClient(app, runtime.db); });
const path = (id: string) => `/missions/${id}`;
const show = (id: string) => client.ok('atlas/lead', path(id));
async function create(skillIds = [pilot, medical]) {
  let m = await client.ok('atlas/lead', '/missions', 'POST', plan);
  for (const [i, skillId] of skillIds.entries()) m = await client.ok('atlas/lead', `${path(m.id)}/positions`, 'POST', {
    version: m.version, label: i === 0 ? 'Pilot' : 'Medic', requirements: [{ skillId, minProficiency: 3 }],
  });
  return m;
}
async function propose(m: Awaited<ReturnType<typeof create>>, crewIds = [sam, alex]) {
  return client.ok('atlas/lead', `${path(m.id)}/proposals`, 'PUT', { version: m.version,
    proposals: m.positions.filter((p: { removedAt: string | null }) => !p.removedAt).map((p: { id: string }, i: number) => ({ positionId: p.id, crewId: crewIds[i] })),
  });
}
async function respond(missionId: string, crewId: string, action: 'accept' | 'decline' | 'retract') {
  const m = await show(missionId);
  const a = m.assignments.find((a: { crewId: string; state: string }) => a.crewId === crewId && ['proposed', 'accepted'].includes(a.state));
  return client.ok(crewId === alex ? 'atlas/alex' : 'atlas/sam', `/assignments/${a.id}/${action}`, 'POST', { version: m.version });
}
async function booking(crewId: string, start: string, end: string, state: 'confirmed' | 'released' | 'proposed' = 'confirmed') {
  const [m] = await runtime.db.insert(missions).values({ tenantId, ownerId, title: 'Booking fixture', brief: '',
    start: new Date(start), end: new Date(end), state: state === 'confirmed' ? 'completed' : 'draft' }).returning();
  const [p] = await runtime.db.insert(positions).values({ tenantId, missionId: m!.id, ordinal: 1, label: 'Historical' }).returning();
  const [a] = await runtime.db.insert(assignments).values({ tenantId, missionId: m!.id, positionId: p!.id, crewId, state,
    respondedAt: state === 'confirmed' ? new Date('2029-12-01Z') : null,
    bookedStart: state === 'confirmed' ? new Date(start) : null, bookedEnd: state === 'confirmed' ? new Date(end) : null,
  }).returning();
  return a!;
}

describe('matching and consent', () => {
  it('matches the full tenant pool, covers scarce skills, and explains impossible rosters without writes', async () => {
    // Place the eligible seeded people beyond a display page; no matching query may paginate them away.
    const [account] = await runtime.db.select().from(users).where(eq(users.id, ownerId));
    const accounts = Array.from({ length: 101 }, (_, i) => ({ id: randomUUID(), tenantId, username: `extra${i}`,
      displayName: `A${String(i).padStart(3, '0')}`, role: 'crew' as const, passwordHash: account!.passwordHash }));
    await runtime.db.insert(users).values(accounts);
    await runtime.db.insert(crew).values(accounts.map((u) => ({ tenantId, userId: u.id, active: false })));
    const m = await create();
    expect((await client.ok('atlas/lead', '/crew?limit=100')).items.some((c: { id: string }) => c.id === sam)).toBe(false);
    const match = await client.ok('atlas/lead', `${path(m.id)}/match`);
    expect(match).toMatchObject({ version: m.version, workloadMonth: '2030-01', complete: true,
      roster: [{ positionId: m.positions[0].id, crewId: sam }, { positionId: m.positions[1].id, crewId: alex }] });
    expect(match.roster[0]).toMatchObject({ availabilityCovered: true, workloadHours: 0,
      requirements: [{ skillId: pilot, minProficiency: 3, actualProficiency: 4 }] });
    expect(match.positions[1].excludedCandidates.find((c: { crewId: string }) => c.crewId === sam).reasons.join(' ')).toContain('declared proficiency is 0');
    expect(JSON.stringify(match)).not.toContain(foreignCrew);
    expect(await show(m.id)).toEqual(m);
    const third = await client.ok('atlas/lead', `${path(m.id)}/positions`, 'POST', { version: m.version, label: 'Second medic', requirements: [{ skillId: medical, minProficiency: 3 }] });
    const partial = await client.ok('atlas/lead', `${path(m.id)}/match`);
    expect(partial).toMatchObject({ complete: false, unfilled: [{ reason: expect.stringContaining('needed in other positions') }] });
    expect(partial.roster).toHaveLength(2);
    await client.ok('atlas/lead', `${path(m.id)}/positions/${third.positions[2].id}`, 'PATCH', { version: third.version, requirements: [{ skillId: medical, minProficiency: 5 }] });
    const impossible = await client.ok('atlas/lead', `${path(m.id)}/match`);
    expect(impossible.unfilled[0].reason).toContain('No eligible crew');
    expect((await client.ok('atlas/lead', `${path(m.id)}/history`)).items).toHaveLength(5);
  });

  it('uses clipped confirmed workload, retains completed work and treats booking adjacency correctly', async () => {
    const m = await create([pilot]);
    await booking(alex, '2029-12-31T00:00:00Z', '2030-01-02T00:00:00Z');
    await booking(sam, '2030-01-31T23:00:00Z', '2030-02-02T00:00:00Z');
    await booking(sam, '2030-01-03T00:00:00Z', '2030-01-04T00:00:00Z', 'released');
    await booking(sam, plan.start, plan.end, 'proposed');
    let match = await client.ok('atlas/lead', `${path(m.id)}/match`);
    expect(match.roster[0]).toMatchObject({ crewId: sam, workloadHours: 1 });
    expect(match.positions[0].eligibleCandidates).toContainEqual({ crewId: alex, displayName: 'Alex', workloadHours: 24 });
    await booking(sam, '2030-01-10T08:00:00Z', plan.start); // end == start is eligible
    match = await client.ok('atlas/lead', `${path(m.id)}/match`);
    expect(match.positions[0].eligibleCandidates.some((c: { crewId: string }) => c.crewId === sam)).toBe(true);
    const conflict = await booking(sam, plan.start, plan.end);
    match = await client.ok('atlas/lead', `${path(m.id)}/match`);
    expect(match.roster[0].crewId).toBe(alex);
    expect(match.positions[0].excludedCandidates.find((c: { crewId: string }) => c.crewId === sam).reasons).toContain('A confirmed booking overlaps this mission.');
    expect(JSON.stringify(match)).not.toContain(conflict.missionId);
  });

  it('records personal consent, permits tentative overlaps and preserves identical proposals', async () => {
    let m = await propose(await create());
    const first = m.assignments.find((a: { crewId: string }) => a.crewId === sam);
    const response = await respond(m.id, sam, 'accept');
    expect(response).toMatchObject({ state: 'accepted', respondedAt: expect.any(String), bookedStart: null, bookedEnd: null });
    const accepted = await show(m.id);
    expect(await propose(accepted)).toEqual(accepted);
    expect((await client.error('atlas/sam', `/assignments/${first.id}/accept`, 'POST', { version: m.version }, 409)).code).toBe('STALE_VERSION');
    expect((await client.error('atlas/sam', `/assignments/${first.id}/accept`, 'POST', { version: accepted.version }, 409)).code).toBe('ASSIGNMENT_STATE');
    await respond(m.id, alex, 'accept');
    const other = await propose(await create());
    await respond(other.id, sam, 'accept');
    expect((await client.ok('atlas/sam', '/assignments')).items.filter((a: { state: string }) => a.state === 'accepted')).toHaveLength(2);
    expect((await client.ok('atlas/lead', '/assignments?mine=true')).items).toEqual([]);
    await client.error('atlas/director', `/assignments/${first.id}/decline`, 'POST', { version: (await show(m.id)).version }, 403);
    // A Lead with a crew profile responds under exactly the same ownership rule.
    await client.ok('atlas/lead', '/crew/me/availability', 'POST', { start: plan.start, end: plan.end });
    let own = await client.ok('atlas/lead', '/missions', 'POST', plan);
    own = await client.ok('atlas/lead', `${path(own.id)}/positions`, 'POST', { version: own.version, label: 'Observer' });
    own = await propose(own, [leadCrew]);
    expect((await client.ok('atlas/lead', `/assignments/${own.assignments[0].id}/accept`, 'POST', { version: own.version })).state).toBe('accepted');
  });

  it('invalidates only affected consent and preserves the offered plan and previous responses in history', async () => {
    let m = await propose(await create([pilot, pilot]), [alex, sam]);
    await respond(m.id, alex, 'accept'); await respond(m.id, sam, 'accept');
    m = await show(m.id);
    expect(await client.ok('atlas/lead', path(m.id), 'PATCH', { version: m.version, title: plan.title })).toEqual(m);
    const originalResponse = m.assignments.find((a: { crewId: string }) => a.crewId === alex).respondedAt;
    m = await client.ok('atlas/lead', `${path(m.id)}/positions`, 'POST', { version: m.version, label: 'Unstaffed' });
    expect(m.assignments.every((a: { state: string }) => a.state === 'accepted')).toBe(true);
    m = await client.ok('atlas/lead', `${path(m.id)}/positions/${m.positions[0].id}`, 'PATCH', { version: m.version, label: 'Captain' });
    expect(m.assignments.find((a: { crewId: string }) => a.crewId === alex)).toMatchObject({ state: 'proposed', respondedAt: null });
    expect(m.assignments.find((a: { crewId: string }) => a.crewId === sam).state).toBe('accepted');
    const changes = (await client.ok('atlas/lead', `${path(m.id)}/history`)).items.at(-1).payload.assignmentChanges;
    expect(changes).toMatchObject([{ before: { state: 'accepted', respondedAt: originalResponse, plan: { position: { label: 'Pilot' } } },
      after: { state: 'proposed', respondedAt: null, plan: { position: { label: 'Captain' } } } }]);
    await respond(m.id, alex, 'accept'); m = await show(m.id);
    m = await client.ok('atlas/lead', `${path(m.id)}/positions/${m.positions[0].id}`, 'PATCH', { version: m.version, requirements: [{ skillId: pilot, minProficiency: 4 }] });
    expect(m.assignments.find((a: { crewId: string }) => a.crewId === alex).state).toBe('proposed');
    await respond(m.id, alex, 'accept'); m = await show(m.id);
    await client.ok('atlas/director', `/skills/${pilot}`, 'PATCH', { name: 'flight' });
    expect((await client.ok('atlas/lead', `${path(m.id)}/positions/${m.positions[0].id}`, 'PATCH', { version: m.version, requirements: [{ skillId: pilot, minProficiency: 4 }] })).version).toBe(m.version);
    for (const patch of [{ brief: 'Changed brief' }, { title: 'Changed title' }, { end: '2030-01-10T18:00:00Z' }]) {
      m = await client.ok('atlas/lead', path(m.id), 'PATCH', { version: m.version, ...patch });
      expect(m.assignments.every((a: { state: string; respondedAt: string | null }) => a.state === 'proposed' && a.respondedAt === null)).toBe(true);
      await respond(m.id, alex, 'accept'); await respond(m.id, sam, 'accept'); m = await show(m.id);
    }
    m = await client.ok('atlas/lead', `${path(m.id)}/positions/${m.positions[0].id}`, 'DELETE', { version: m.version });
    expect(m.assignments.find((a: { crewId: string }) => a.crewId === alex)).toMatchObject({ state: 'withdrawn', respondedAt: expect.any(String) });
    expect(m.assignments.find((a: { crewId: string }) => a.crewId === sam).state).toBe('accepted');
  });

  it('supports decline, retract, new attempts and atomic swaps; rejects invalid final rosters without effects', async () => {
    let m = await propose(await create([pilot, pilot]), [alex, sam]);
    const initialIds = m.assignments.map((a: { id: string }) => a.id);
    await respond(m.id, alex, 'accept'); await respond(m.id, alex, 'retract');
    await respond(m.id, alex, 'decline'); m = await show(m.id);
    const declined = m.assignments.find((a: { state: string }) => a.state === 'declined');
    await client.error('atlas/alex', `/assignments/${declined.id}/accept`, 'POST', { version: m.version }, 409);
    m = await propose(m, [alex, sam]);
    expect(m.assignments.find((a: { crewId: string; state: string }) => a.crewId === alex && a.state === 'proposed').id).not.toBe(declined.id);
    const before = m;
    for (const proposals of [
      [{ positionId: m.positions[0].id, crewId: alex }, { positionId: m.positions[1].id, crewId: alex }],
      [{ positionId: m.positions[0].id, crewId: alex }, { positionId: m.positions[0].id, crewId: sam }],
    ]) await client.error('atlas/lead', `${path(m.id)}/proposals`, 'PUT', { version: m.version, proposals }, 400);
    await client.error('atlas/lead', `${path(m.id)}/proposals`, 'PUT', { version: m.version, proposals: [{ positionId: m.positions[0].id, crewId: leadCrew }] }, 422);
    expect(await show(m.id)).toEqual(before);
    m = await propose(m, [sam, alex]);
    expect(m.assignments.filter((a: { state: string }) => a.state === 'proposed')).toHaveLength(2);
    expect(m.assignments.filter((a: { id: string }) => initialIds.includes(a.id)).map((a: { state: string }) => a.state).sort()).toEqual(['declined', 'withdrawn']);
    const assignment = m.assignments.find((a: { state: string }) => a.state === 'proposed');
    m = await client.ok('atlas/director', `${path(m.id)}/proposals/${assignment.id}`, 'DELETE', { version: m.version });
    expect(m.assignments.find((a: { id: string }) => a.id === assignment.id).state).toBe('withdrawn');
    await client.error('atlas/lead', `${path(m.id)}/proposals/${assignment.id}`, 'DELETE', { version: m.version }, 409);
    m = await client.ok('atlas/lead', `${path(m.id)}/proposals`, 'PUT', { version: m.version, proposals: [] });
    expect(m.assignments.some((a: { state: string }) => ['accepted', 'proposed'].includes(a.state))).toBe(false);
  });

  it('isolates tenant IDs, private peer assignments, related references, lists and historical projections', async () => {
    let m = await propose(await create());
    const own = m.assignments.find((a: { crewId: string }) => a.crewId === alex);
    const peer = m.assignments.find((a: { crewId: string }) => a.crewId === sam);
    const other = await create();
    const foreignMission = await client.ok('boreal/lead', '/missions', 'POST', plan);
    const baseline = await client.error('atlas/alex', `/assignments/${randomUUID()}`);
    for (const [actor, id] of [['atlas/alex', peer.id], ['boreal/alex', own.id], ['boreal/director', own.id]]) {
      expect(await client.error(actor!, `/assignments/${id}`)).toEqual(baseline);
      for (const action of ['accept', 'decline', 'retract']) expect(await client.error(actor!, `/assignments/${id}/${action}`, 'POST', { version: 999 })).toEqual(baseline);
    }
    expect(await client.error('atlas/alex', `/crew/${sam}/history`)).toEqual(baseline);
    expect(await client.error('atlas/lead', `/crew/${foreignCrew}/history`)).toEqual(baseline);
    expect(await client.error('atlas/lead', `${path(foreignMission.id)}/match`)).toEqual(baseline);
    expect(await client.error('atlas/lead', `${path(m.id)}/proposals`, 'PUT', { version: m.version, proposals: [{ positionId: m.positions[0].id, crewId: foreignCrew }] })).toEqual(baseline);
    const otherWithPosition = await client.ok('atlas/lead', `${path(other.id)}/positions`, 'POST', { version: other.version, label: 'Other mission' });
    expect(await client.error('atlas/lead', `${path(m.id)}/proposals`, 'PUT', { version: 999, proposals: [{ positionId: otherWithPosition.positions[0].id, crewId: alex }] })).toEqual(baseline);
    expect(await client.error('atlas/lead', `${path(other.id)}/proposals/${own.id}`, 'DELETE', { version: 999 })).toEqual(baseline);
    await client.error('atlas/alex', `${path(m.id)}/match`, 'GET', undefined, 403);
    await client.error('atlas/alex', `${path(m.id)}/proposals`, 'PUT', { version: m.version, proposals: [] }, 403);
    await client.error('atlas/alex', path(m.id), 'PATCH', { version: m.version, title: 'Cannot edit' }, 403);
    for (const id of [peer.positionId, randomUUID()]) {
      expect(await client.error('atlas/alex', `${path(m.id)}/positions/${id}`, 'PATCH', { version: 999, label: 'Hidden' })).toEqual(baseline);
      expect(await client.error('atlas/alex', `${path(m.id)}/positions/${id}`, 'DELETE', { version: 999 })).toEqual(baseline);
    }
    expect(await client.error('atlas/alex', `${path(m.id)}/proposals/${peer.id}`, 'DELETE', { version: 999 })).toEqual(baseline);
    await client.error('atlas/alex', `${path(m.id)}/proposals/${own.id}`, 'DELETE', { version: 999 }, 403);
    await client.error('atlas/alex', `${path(m.id)}/positions/${own.positionId}`, 'PATCH', { version: 999, label: 'Forbidden' }, 403);
    const restricted = await client.ok('atlas/alex', path(m.id));
    expect(restricted).not.toHaveProperty('ownerId');
    expect(restricted.positions.map((p: { id: string }) => p.id)).toEqual([own.positionId]);
    expect(restricted.assignments.map((a: { id: string }) => a.id)).toEqual([own.id]);
    for (const result of [restricted, await client.ok('atlas/alex', `${path(m.id)}/history`),
      await client.ok('atlas/alex', '/assignments?mine=false'), await client.ok('atlas/alex', '/crew/me/history')]) {
      expect(JSON.stringify(result)).not.toContain(peer.id);
      expect(JSON.stringify(result)).not.toContain(sam);
      expect(JSON.stringify(result)).not.toContain(peer.positionId);
      expect(JSON.stringify(result)).not.toContain('actorId');
    }
    const ownHistory = await client.ok('atlas/alex', `${path(m.id)}/history?limit=1`);
    expect(ownHistory.items).toHaveLength(1);
    expect(ownHistory.items[0].kind).toBe('proposals_updated');
    expect(ownHistory.items[0].payload.assignmentChanges).toHaveLength(1);
    expect((await client.ok('atlas/alex', '/missions?q=supply')).items.map((m: { id: string }) => m.id)).toEqual([m.id]);
    expect((await client.ok('boreal/lead', '/assignments')).items).toEqual([]);
    await client.error('atlas/alex', path(other.id));
    m = await client.ok('atlas/lead', `${path(m.id)}/proposals/${own.id}`, 'DELETE', { version: m.version });
    expect((await client.ok('atlas/alex', path(m.id))).assignments[0].state).toBe('withdrawn');
    expect((await client.ok('atlas/alex', '/crew/me/history')).items[0].id).toBe(own.id);
    expect((await client.ok('atlas/alex', `${path(m.id)}/history?limit=1`)).nextOffset).toBe(1);
    await client.ok('atlas/director', '/members', 'POST', { username: 'lead2', displayName: 'Other Lead', role: 'lead', password: seedPassword });
    await client.error('atlas/lead2', `${path(m.id)}/proposals`, 'PUT', { version: m.version, proposals: [] }, 403);
    await client.error('atlas/lead2', `${path(m.id)}/proposals/${peer.id}`, 'DELETE', { version: m.version }, 403);
  });

  it('rechecks eligibility for proposals and acceptance, and rejects all staffing mutations when frozen', async () => {
    let m = await propose(await create());
    const own = m.assignments.find((a: { crewId: string }) => a.crewId === alex);
    await client.ok('atlas/alex', `/crew/me/skills/${medical}`, 'PUT', { proficiency: 1 });
    const failure = await client.error('atlas/alex', `/assignments/${own.id}/accept`, 'POST', { version: m.version }, 422);
    expect(failure.message).toContain('medical requires 3');
    expect(await show(m.id)).toEqual(m);
    await client.ok('atlas/alex', `/crew/me/skills/${medical}`, 'PUT', { proficiency: 4 });
    await client.ok('atlas/director', `/crew/${alex}`, 'PATCH', { active: false });
    await client.error('atlas/lead', `${path(m.id)}/proposals`, 'PUT', { version: m.version, proposals: [{ positionId: own.positionId, crewId: alex }] }, 422);
    await client.ok('atlas/director', `/crew/${alex}`, 'PATCH', { active: true });
    const windows = await client.ok('atlas/alex', '/crew/me/availability');
    await client.ok('atlas/alex', `/crew/me/availability/${windows.items[0].id}`, 'DELETE');
    expect((await client.error('atlas/alex', `/assignments/${own.id}/accept`, 'POST', { version: m.version }, 422)).message).toContain('Availability');
    await client.ok('atlas/alex', '/crew/me/availability', 'POST', { start: plan.start, end: plan.end });
    const conflict = await booking(alex, plan.start, plan.end);
    const bookingError = await client.error('atlas/alex', `/assignments/${own.id}/accept`, 'POST', { version: m.version }, 422);
    expect(bookingError.message).toContain('confirmed booking overlaps');
    expect(JSON.stringify(bookingError)).not.toContain(conflict.missionId);
    for (const state of ['submitted', 'approved', 'completed', 'cancelled'] as const) {
      await runtime.db.update(missions).set({ state }).where(eq(missions.id, m.id));
      for (const [actor, target, method, body] of [
        ['atlas/lead', `${path(m.id)}/match`, 'GET', undefined],
        ['atlas/lead', `${path(m.id)}/proposals`, 'PUT', { version: m.version, proposals: [] }],
        ['atlas/director', `${path(m.id)}/proposals/${own.id}`, 'DELETE', { version: m.version }],
        ...['accept', 'decline', 'retract'].map((action) => ['atlas/alex', `/assignments/${own.id}/${action}`, 'POST', { version: m.version }]),
      ] as [string, string, string, unknown][]) expect((await client.error(actor, target, method, body, 409)).code).toBe('MISSION_FROZEN');
    }
    await runtime.db.update(missions).set({ state: 'draft', start: new Date('2000-01-01Z') }).where(eq(missions.id, m.id));
    for (const [actor, target, method, body] of [
      ['atlas/lead', `${path(m.id)}/match`, 'GET', undefined],
      ['atlas/lead', `${path(m.id)}/proposals`, 'PUT', { version: m.version, proposals: [] }],
      ['atlas/alex', `/assignments/${own.id}/accept`, 'POST', { version: m.version }],
    ] as [string, string, string, unknown][]) expect((await client.error(actor, target, method, body, 409)).code).toBe('START_NOT_FUTURE');
    // Decline/removal remain useful ways to clean up an elapsed draft.
    await client.ok('atlas/alex', `/assignments/${own.id}/decline`, 'POST', { version: m.version });
    m = await show(m.id);
    const samAssignment = m.assignments.find((a: { crewId: string }) => a.crewId === sam);
    await client.ok('atlas/lead', `${path(m.id)}/proposals/${samAssignment.id}`, 'DELETE', { version: m.version });
  });

  it('rolls back roster changes, consent responses and invalidation if recording the event fails', async () => {
    const unstaffed = await create([pilot]);
    await runtime.db.insert(missionEvents).values({ tenantId, missionId: unstaffed.id, missionVersion: unstaffed.version + 1,
      actorId: ownerId, kind: 'proposals_updated', payload: {} });
    await client.error('atlas/lead', `${path(unstaffed.id)}/proposals`, 'PUT', { version: unstaffed.version,
      proposals: [{ positionId: unstaffed.positions[0].id, crewId: sam }] }, 409);
    expect(await show(unstaffed.id)).toEqual(unstaffed);

    const staffed = await propose(await create());
    await respond(staffed.id, alex, 'accept');
    const before = await show(staffed.id);
    await runtime.db.insert(missionEvents).values({ tenantId, missionId: staffed.id, missionVersion: before.version + 1,
      actorId: ownerId, kind: 'mission_updated', payload: {} });
    await client.error('atlas/lead', path(staffed.id), 'PATCH', { version: before.version, brief: 'Must roll back' }, 409);
    expect(await show(staffed.id)).toEqual(before);

    const proposed = await propose(await create());
    const assignment = proposed.assignments.find((a: { crewId: string }) => a.crewId === alex);
    await runtime.db.insert(missionEvents).values({ tenantId, missionId: proposed.id, missionVersion: proposed.version + 1,
      actorId: ownerId, kind: 'assignment_responded', payload: {} });
    await client.error('atlas/alex', `/assignments/${assignment.id}/accept`, 'POST', { version: proposed.version }, 409);
    expect(await show(proposed.id)).toEqual(proposed);
  });

  it('serialises competing proposals and responses without duplicate attempts or events', async () => {
    let m = await create([pilot, pilot]);
    const proposals = [alex, sam].map((crewId) => [{ positionId: m.positions[0].id, crewId }]);
    const results = await Promise.all(proposals.map((proposals) => client.request('atlas/lead', `${path(m.id)}/proposals`, 'PUT', { version: m.version, proposals })));
    expect(results.map((r) => r.status).sort()).toEqual([200, 409]);
    m = await show(m.id);
    expect(m.assignments).toHaveLength(1);
    m = await propose(m, [alex, sam]);
    const version = m.version;
    const responses = await Promise.all([alex, sam].map((crewId) => {
      const a = m.assignments.find((a: { crewId: string; state: string }) => a.crewId === crewId && a.state === 'proposed');
      return client.request(crewId === alex ? 'atlas/alex' : 'atlas/sam', `/assignments/${a.id}/accept`, 'POST', { version });
    }));
    expect(responses.map((r) => r.status).sort()).toEqual([200, 409]);
    m = await show(m.id);
    const remaining = m.assignments.find((a: { state: string }) => a.state === 'proposed');
    await respond(m.id, remaining.crewId, 'accept');
    m = await show(m.id);
    expect(m.assignments.filter((a: { state: string }) => a.state === 'accepted')).toHaveLength(2);
    const history = await client.ok('atlas/lead', `${path(m.id)}/history`);
    expect(history.items.map((e: { missionVersion: number }) => e.missionVersion)).toEqual(Array.from({ length: m.version }, (_, i) => i + 1));
  });

  it('samples actual time after waiting on the crew lock during acceptance', async () => {
    const m = await propose(await create());
    const own = m.assignments.find((a: { crewId: string }) => a.crewId === alex);
    await client.token('atlas/alex');
    const start = new Date(Date.now() + 600), end = new Date(+start + 3_600_000);
    await runtime.db.update(missions).set({ start, end }).where(eq(missions.id, m.id));
    const blocker = await runtime.pool.connect();
    let pending: Promise<Response> | undefined;
    try {
      await blocker.query('BEGIN');
      await blocker.query('SELECT id FROM crew WHERE id = $1 FOR UPDATE', [alex]);
      pending = client.request('atlas/alex', `/assignments/${own.id}/accept`, 'POST', { version: m.version });
      await waitForLocks();
      await delay(Math.max(0, +start - Date.now() + 50));
      await blocker.query('COMMIT');
      const response = await pending;
      expect(response.status).toBe(409);
      expect(JSON.parse(await response.text()).error.code).toBe('START_NOT_FUTURE');
    } finally { await blocker.query('ROLLBACK'); blocker.release(); await pending; }
    expect((await show(m.id)).version).toBe(m.version);
  });

  it('enforces composite references, response/booking checks, current uniqueness and concurrent booking exclusion', async () => {
    const m = await create([pilot, pilot]), other = await create([pilot]);
    const row = { tenantId, missionId: m.id, positionId: m.positions[0].id, crewId: alex };
    for (const change of [{ crewId: foreignCrew }, { tenantId: tenantIds.boreal }, { missionId: other.id }]) {
      await expect(runtime.db.insert(assignments).values({ ...row, ...change })).rejects.toMatchObject({ cause: { code: '23503' } });
    }
    for (const change of [{ state: 'accepted' as const }, { state: 'declined' as const }, { state: 'confirmed' as const },
      { respondedAt: new Date() }, { bookedStart: new Date(plan.start) }]) {
      await expect(runtime.db.insert(assignments).values({ ...row, ...change })).rejects.toMatchObject({ cause: { code: '23514' } });
    }
    const [first] = await runtime.db.insert(assignments).values(row).returning();
    for (const change of [{ crewId: sam }, { positionId: m.positions[1].id }]) {
      await expect(runtime.db.insert(assignments).values({ ...row, ...change })).rejects.toMatchObject({ cause: { code: '23505' } });
    }
    await runtime.db.update(assignments).set({ state: 'declined', respondedAt: new Date() }).where(eq(assignments.id, first!.id));
    const confirmed = { ...row, state: 'confirmed' as const, respondedAt: new Date(), bookedStart: new Date(plan.start), bookedEnd: new Date(plan.end) };
    const results = await Promise.allSettled([
      runtime.db.insert(assignments).values(confirmed),
      runtime.db.insert(assignments).values({ ...confirmed, missionId: other.id, positionId: other.positions[0].id }),
    ]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(results.find((r) => r.status === 'rejected')).toMatchObject({ reason: { cause: { code: '23P01' } } });
    const adjacent = await booking(alex, plan.end, '2030-01-10T18:00:00Z');
    await runtime.db.update(assignments).set({ state: 'released', bookedStart: null, bookedEnd: null })
      .where(and(eq(assignments.tenantId, tenantId), eq(assignments.state, 'confirmed')));
    expect((await booking(alex, plan.start, plan.end)).state).toBe('confirmed');
    expect(adjacent.bookedStart!.toISOString()).toBe(new Date(plan.end).toISOString());
  });
});

it('completes matching and consent using the real CLI, including stale and partial-match recovery', async () => {
  const m = await create();
  const directory = await mkdtemp(join(tmpdir(), 'mc-consent-'));
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
    await cli(['login', '--org', 'atlas', '--username', 'lead', '--password-stdin'], `${seedPassword}\n`);
    const target = ['--mission', m.id];
    const match = await cli(['missions', 'match', ...target]);
    let mission = await cli(['missions', 'propose', ...target, '--version', String(match.version), '--suggested']);
    const assignment = mission.assignments.find((a: { crewId: string }) => a.crewId === alex);
    expect((await cli(['assignments', 'list'])).items).toHaveLength(2);
    await cli(['logout']);
    await cli(['login', '--org', 'atlas', '--username', 'alex', '--password-stdin'], `${seedPassword}\n`);
    const assignmentArgs = ['--assignment', assignment.id];
    expect((await cli(['assignments', 'show', ...assignmentArgs])).position.label).toBe('Medic');
    const unreviewed = await run(['assignments', 'accept', ...assignmentArgs]);
    expect(JSON.parse(unreviewed.stderr).error.code).toBe('VERSION_REQUIRED');
    const stale = await run(['assignments', 'accept', ...assignmentArgs, '--version', '1']);
    expect(JSON.parse(stale.stderr).error.code).toBe('STALE_VERSION');
    const accepted = await cli(['assignments', 'accept', ...assignmentArgs, '--version', String(mission.version)]);
    expect(accepted).toMatchObject({ state: 'accepted', bookedStart: null, version: mission.version + 1 });
    const retracted = await cli(['assignments', 'retract', ...assignmentArgs, '--version', String(accepted.version)]);
    const declined = await cli(['assignments', 'decline', ...assignmentArgs, '--version', String(retracted.version)]);
    expect((await cli(['crew', 'history', '--crew', 'me'])).items).toMatchObject([{ id: assignment.id, state: 'declined' }]);
    expect((await cli(['missions', 'show', ...target])).assignments).toHaveLength(1);
    expect((await cli(['missions', 'history', ...target])).items).toHaveLength(4);
    await cli(['logout']);
    await cli(['login', '--org', 'atlas', '--username', 'lead', '--password-stdin'], `${seedPassword}\n`);
    mission = await cli(['missions', 'propose', ...target, '--version', String(declined.version), '--pairs',
      `${m.positions[0].id}=${sam}`, `${m.positions[1].id}=${alex}`]);
    const current = mission.assignments.find((a: { crewId: string; state: string }) => a.crewId === alex && a.state === 'proposed');
    mission = await cli(['assignments', 'remove', '--assignment', current.id, '--version', String(mission.version), '--yes']);
    mission = await cli(['positions', 'add', ...target, '--version', String(mission.version), '--label', 'Impossible', '--requires', 'medical:5']);
    const refused = await run(['missions', 'propose', ...target, '--version', String(mission.version), '--suggested']);
    expect(JSON.parse(refused.stderr).error.code).toBe('INCOMPLETE_MATCH');
    expect((await cli(['missions', 'show', ...target])).version).toBe(mission.version);
  } finally {
    if ('closeAllConnections' in server) server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    await rm(directory, { recursive: true, force: true });
  }
}, 30000);
