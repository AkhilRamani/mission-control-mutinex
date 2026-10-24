import { Hono } from 'hono';
import { z } from 'zod';
import type { Database } from '../db/client.js';
import { getAssignment, listAssignments, respondToAssignment } from '../domain/missions/assignments.js';
import type { Env } from './context.js';
import { pageInput, parseInput, readJson, uuid as id, versionInput } from './validation.js';

const listInput = pageInput.extend({ mine: z.enum(['true', 'false']).transform((v) => v === 'true').optional() });

export function assignmentRoutes(db: Database) {
  const app = new Hono<Env>();
  app.get('/assignments', async (c) => c.json(await listAssignments(db, c.get('user'), parseInput(listInput, c.req.query()))));
  app.get('/assignments/:id', async (c) => c.json(await getAssignment(db, c.get('user'), parseInput(id, c.req.param('id')))));
  for (const action of ['accept', 'decline', 'retract'] as const) {
    app.post(`/assignments/:id/${action}`, async (c) => {
      const input = await readJson(c, versionInput);
      return c.json(await respondToAssignment(db, c.get('user'), parseInput(id, c.req.param('id')), input.version, action));
    });
  }
  return app;
}
