import { z } from 'zod';
import type { Context } from 'hono';
import { AppError } from '../domain/errors.js';

const password = z.string().min(1).max(128);
export const loginInput = z.strictObject({
  organisation: z.string().trim().toLowerCase().max(64).regex(/^[a-z0-9]+(-[a-z0-9]+)*$/),
  username: z.string().trim().toLowerCase().regex(/^[a-z0-9][a-z0-9._-]{0,63}$/),
  password,
});
export const passwordInput = z.strictObject({ oldPassword: password, newPassword: z.string().min(12).max(128) });

export async function readJson<T>(c: Context, schema: z.ZodType<T>): Promise<T> {
  if (c.req.header('content-type')?.split(';')[0]?.trim() !== 'application/json') {
    throw new AppError(400, 'INVALID_INPUT', 'Expected application/json.', 'Send a JSON request body.');
  }
  let body: unknown;
  try { body = await c.req.json(); } catch {
    throw new AppError(400, 'INVALID_INPUT', 'Invalid JSON.', 'Correct the request body.');
  }
  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    // Do not echo input or unrecognised field names, which may contain secrets.
    throw new AppError(400, 'INVALID_INPUT', 'Invalid or unsupported fields.',
      'Use the documented fields. New passwords must contain 12–128 characters.');
  }
  return parsed.data;
}
