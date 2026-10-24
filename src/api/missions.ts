import { Hono } from 'hono';
import { z } from 'zod';
import type { Database } from '../db/client.js';
import { missionState } from '../db/schema.js';
import * as missions from '../domain/missions/planning.js';
import { getMission, listMissions, missionHistory } from '../domain/missions/reads.js';
import { matchCrew } from '../domain/missions/matching.js';
import { proposeCrew, removeProposal } from '../domain/missions/assignments.js';
import type { Env } from './context.js';
import { displayName, instant, pageInput, searchInput, parseInput, readJson } from './validation.js';

const id = z.uuid().toLowerCase();
const version = z.number().int().min(1).max(2147483647);
const plan = { title: displayName, brief: z.string().trim().max(4000), start: instant, end: instant };
const createInput = z.strictObject({ ...plan, brief: plan.brief.default('') });
const patchInput = z.strictObject({ version, ...z.object(plan).partial().shape })
  .refine((value) => Object.keys(value).length > 1);
const requirements = z.array(z.strictObject({ skillId: id, minProficiency: z.number().int().min(1).max(5) }))
  .refine((values) => new Set(values.map((v) => v.skillId)).size === values.length);
const positionInput = z.strictObject({ version, label: displayName, requirements: requirements.default([]) });
const positionPatch = z.strictObject({ version, label: displayName.optional(), requirements: requirements.optional() })
  .refine((value) => Object.keys(value).length > 1);
const listInput = searchInput.extend({ state: z.enum(missionState.enumValues).optional() });
const proposalsInput = z.strictObject({ version, proposals: z.array(z.strictObject({ positionId: id, crewId: id }))
  .refine((pairs) => new Set(pairs.map((p) => p.positionId)).size === pairs.length && new Set(pairs.map((p) => p.crewId)).size === pairs.length) });

export function missionRoutes(db: Database) {
  const app = new Hono<Env>();
  app.get('/missions', async (c) => c.json(await listMissions(db, c.get('user'), parseInput(listInput, c.req.query()))));
  app.post('/missions', async (c) => c.json(await missions.createMission(db, c.get('user'), await readJson(c, createInput)), 201));
  app.get('/missions/:id', async (c) => c.json(await getMission(db, c.get('user'), parseInput(id, c.req.param('id')))));
  app.get('/missions/:id/history', async (c) => c.json(await missionHistory(db, c.get('user'), parseInput(id, c.req.param('id')), parseInput(pageInput, c.req.query()))));
  app.get('/missions/:id/match', async (c) => c.json(await matchCrew(db, c.get('user'), parseInput(id, c.req.param('id')))));
  app.put('/missions/:id/proposals', async (c) => {
    const input = await readJson(c, proposalsInput);
    return c.json(await proposeCrew(db, c.get('user'), parseInput(id, c.req.param('id')), input.version, input.proposals));
  });
  app.delete('/missions/:id/proposals/:assignmentId', async (c) => {
    const input = await readJson(c, z.strictObject({ version }));
    return c.json(await removeProposal(db, c.get('user'), parseInput(id, c.req.param('id')), parseInput(id, c.req.param('assignmentId')), input.version));
  });
  app.patch('/missions/:id', async (c) => {
    const { version, ...input } = await readJson(c, patchInput);
    return c.json(await missions.updateMission(db, c.get('user'), parseInput(id, c.req.param('id')), version, input));
  });
  app.post('/missions/:id/positions', async (c) => {
    const { version, ...input } = await readJson(c, positionInput);
    return c.json(await missions.addPosition(db, c.get('user'), parseInput(id, c.req.param('id')), version, input), 201);
  });
  app.patch('/missions/:id/positions/:positionId', async (c) => {
    const { version, ...input } = await readJson(c, positionPatch);
    return c.json(await missions.updatePosition(db, c.get('user'), parseInput(id, c.req.param('id')), parseInput(id, c.req.param('positionId')), version, input));
  });
  app.delete('/missions/:id/positions/:positionId', async (c) => {
    const input = await readJson(c, z.strictObject({ version }));
    return c.json(await missions.removePosition(db, c.get('user'), parseInput(id, c.req.param('id')), parseInput(id, c.req.param('positionId')), input.version));
  });
  return app;
}
