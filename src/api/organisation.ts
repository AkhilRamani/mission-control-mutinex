import { Hono } from 'hono';
import { z } from 'zod';
import type { Database } from '../db/client.js';
import type { Env } from './context.js';
import * as organisation from '../domain/organisation.js';
import { displayName, searchInput, username, newPassword, parseInput, readJson } from './validation.js';

const skillInput = z.strictObject({ name: z.string().trim().toLowerCase().min(1).max(80) });
const memberInput = z.strictObject({ username, displayName, role: z.enum(['director', 'lead', 'crew']), password: newPassword });

export function organisationRoutes(db: Database) {
  const app = new Hono<Env>();
  app.get('/organisation', async (c) => c.json(await organisation.getOrganisation(db, c.get('user'))));
  app.patch('/organisation', async (c) => {
    const input = await readJson(c, z.strictObject({ name: displayName }));
    return c.json(await organisation.updateOrganisation(db, c.get('user'), input.name));
  });
  app.get('/members', async (c) => c.json(await organisation.listMembers(db, c.get('user'), parseInput(searchInput, c.req.query()))));
  app.post('/members', async (c) => c.json(await organisation.createMember(db, c.get('user'), await readJson(c, memberInput)), 201));
  app.get('/skills', async (c) => c.json(await organisation.listSkills(db, c.get('user'), parseInput(searchInput, c.req.query()))));
  app.post('/skills', async (c) => {
    const input = await readJson(c, skillInput);
    return c.json(await organisation.createSkill(db, c.get('user'), input.name), 201);
  });
  app.patch('/skills/:id', async (c) => {
    const input = await readJson(c, skillInput);
    return c.json(await organisation.renameSkill(db, c.get('user'), parseInput(z.uuid(), c.req.param('id')), input.name));
  });
  app.delete('/skills/:id', async (c) => {
    await organisation.deleteSkill(db, c.get('user'), parseInput(z.uuid(), c.req.param('id')));
    return c.json({ message: 'Skill removed.' });
  });
  return app;
}
