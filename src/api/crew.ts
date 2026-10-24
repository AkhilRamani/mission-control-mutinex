import { Hono } from 'hono';
import { z } from 'zod';
import type { Database } from '../db/client.js';
import type { Env } from './context.js';
import * as crew from '../domain/crew.js';
import { displayName, instant, pageInput, searchInput, parseInput, readJson } from './validation.js';

const uuid = z.uuid();
const crewId = z.union([z.literal('me'), uuid]);
const profileInput = z.strictObject({ displayName: displayName.optional(), biography: z.string().trim().max(2000).optional(),
  active: z.boolean().optional() }).refine((input) => Object.keys(input).length > 0);
const intervalInput = z.strictObject({ start: instant, end: instant }).refine((input) => input.start < input.end);

export function crewRoutes(db: Database) {
  const app = new Hono<Env>();
  app.get('/crew', async (c) => c.json(await crew.listCrew(db, c.get('user'), parseInput(searchInput, c.req.query()))));
  app.post('/crew', async (c) => {
    const input = await readJson(c, z.strictObject({ userId: uuid }));
    return c.json(await crew.createCrew(db, c.get('user'), input.userId), 201);
  });
  app.get('/crew/:id', async (c) => c.json(await crew.getCrew(db, c.get('user'), parseInput(crewId, c.req.param('id')))));
  app.patch('/crew/:id', async (c) => c.json(await crew.updateCrew(db, c.get('user'), parseInput(crewId, c.req.param('id')),
    await readJson(c, profileInput))));
  app.put('/crew/:id/skills/:skillId', async (c) => {
    const input = await readJson(c, z.strictObject({ proficiency: z.number().int().min(1).max(5) }));
    return c.json(await crew.setCrewSkill(db, c.get('user'), parseInput(crewId, c.req.param('id')),
      parseInput(uuid, c.req.param('skillId')), input.proficiency));
  });
  app.delete('/crew/:id/skills/:skillId', async (c) => {
    await crew.removeCrewSkill(db, c.get('user'), parseInput(crewId, c.req.param('id')), parseInput(uuid, c.req.param('skillId')));
    return c.json({ message: 'Crew skill removed.' });
  });
  app.get('/crew/:id/availability', async (c) => c.json(await crew.listAvailability(db, c.get('user'),
    parseInput(crewId, c.req.param('id')), parseInput(pageInput, c.req.query()))));
  app.post('/crew/:id/availability', async (c) => c.json(await crew.addAvailability(db, c.get('user'),
    parseInput(crewId, c.req.param('id')), await readJson(c, intervalInput)), 201));
  app.delete('/crew/:id/availability/:availabilityId', async (c) => {
    await crew.removeAvailability(db, c.get('user'), parseInput(crewId, c.req.param('id')), parseInput(uuid, c.req.param('availabilityId')));
    return c.json({ message: 'Availability removed.' });
  });
  
  return app;
}
