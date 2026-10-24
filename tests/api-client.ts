import { expect } from 'vitest';
import type { createApp } from '../src/api/app.js';
import type { Database } from '../src/db/client.js';
import { seedPassword } from '../src/db/fixtures.js';
import { login } from '../src/domain/auth.js';

// Fresh per test. Domain login avoids the HTTP auth budget; auth tests exercise that boundary separately.
export function createApiClient(app: ReturnType<typeof createApp>, db: Database) {
  const tokens = new Map<string, Promise<string>>();
  function token(actor: string) {
    if (!tokens.has(actor)) {
      const [organisation, username] = actor.split('/');
      tokens.set(actor, login(db, { organisation: organisation!, username: username!, password: seedPassword }).then((session) => session.token));
    }
    return tokens.get(actor)!;
  }
  async function request(actor: string, path: string, method = 'GET', body?: unknown) {
    return app.request(`/v1${path}`, { method,
      headers: { authorization: `Bearer ${await token(actor)}`, 'content-type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  }
  async function ok(actor: string, path: string, method = 'GET', body?: unknown) {
    const response = await request(actor, path, method, body), data = JSON.parse(await response.text());
    expect(response.status, JSON.stringify(data)).toBeGreaterThanOrEqual(200);
    expect(response.status, JSON.stringify(data)).toBeLessThan(300);
    return data;
  }
  async function error(actor: string, path: string, method = 'GET', body?: unknown, status = 404) {
    const response = await request(actor, path, method, body), data = JSON.parse(await response.text());
    expect(response.status, JSON.stringify(data)).toBe(status);
    const { requestId, ...safe } = data.error;
    expect(requestId).toBeTruthy();
    return safe;
  }
  return { request, ok, error, token, useToken: (actor: string, value: string) => tokens.set(actor, Promise.resolve(value)) };
}
