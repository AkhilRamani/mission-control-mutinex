import { z } from 'zod';
import type { Context } from 'hono';
import { AppError } from '../domain/errors.js';

export const username = z.string().trim().toLowerCase().regex(/^[a-z0-9][a-z0-9._-]{0,63}$/);
export const newPassword = z.string().min(12).max(128);
export const displayName = z.string().trim().min(1).max(120);
const pagination = {
  limit: z.string().regex(/^\d+$/).transform(Number).pipe(z.number().int().min(1).max(100)).default(25),
  offset: z.string().regex(/^\d+$/).transform(Number).pipe(z.number().int().min(0).max(2147483647)).default(0),
};
export const pageInput = z.strictObject(pagination);
export const searchInput = z.strictObject({ ...pagination, q: z.string().trim().max(120).optional() });

export async function readJson<T>(c: Context, schema: z.ZodType<T>): Promise<T> {
  if (c.req.header('content-type')?.split(';')[0]?.trim() !== 'application/json') {
    throw new AppError(400, 'INVALID_INPUT', 'Expected application/json.', 'Send a JSON request body.');
  }
  let body: unknown;
  try { body = await c.req.json(); } catch {
    throw new AppError(400, 'INVALID_INPUT', 'Invalid JSON.', 'Correct the request body.');
  }
  return parseInput(schema, body);
}

export function parseInput<T>(schema: z.ZodType<T>, value: unknown): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success) {
    // Do not echo input or unrecognised field names, which may contain secrets.
    throw new AppError(400, 'INVALID_INPUT', 'Invalid or unsupported fields.',
      'Check the documented fields and command help; unknown fields are rejected.');
  }
  return parsed.data;
}
