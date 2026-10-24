import type { Credentials } from './credentials.js';
import { z } from 'zod';
import { CliError } from './errors.js';

const apiError = z.object({ error: z.object({ message: z.string(), code: z.string(), recovery: z.string(), requestId: z.string() }) });

export function apiOrigin(value: string): string {
  let url: URL;
  try { url = new URL(value); } catch { throw new CliError('Invalid API URL.'); }
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if ((url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback))
    || url.username || url.password || url.pathname !== '/' || url.search || url.hash) {
    throw new CliError('Use an HTTPS API origin, or HTTP on loopback only; no credentials, path, query or fragment.');
  }
  return url.origin;
}

export function createClient(apiUrl: string, credentials?: Credentials) {
  const origin = apiOrigin(apiUrl);
  if (credentials && apiOrigin(credentials.apiUrl) !== origin) {
    throw new CliError('Stored session belongs to a different API.', 'API_MISMATCH', 'Log out from its original API before switching servers.');
  }
  return async <T>(path: string, method = 'GET', body?: unknown): Promise<T> => {
    let response: Response;
    try {
      response = await fetch(`${origin}/v1${path}`, {
        method, redirect: 'error', signal: AbortSignal.timeout(15000),
        headers: { ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
          ...(credentials ? { Authorization: `Bearer ${credentials.token}` } : {}) },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
    } catch {
      throw new CliError('Could not reach the API.', 'NETWORK_ERROR',
        method === 'GET' ? 'Check the server and API URL.' : 'The result may be uncertain. Inspect the relevant list/show command before retrying; writes are never retried automatically.');
    }
    let result;
    try { result = await response.json(); } catch {
      throw new CliError('API returned an invalid response.', 'INVALID_RESPONSE', 'Check the API URL and server.');
    }
    if (!response.ok) {
      const parsed = apiError.safeParse(result);
      if (!parsed.success) throw new CliError(`Request failed (${response.status}).`, 'API_ERROR', 'Check the API URL and server.');
      const { error } = parsed.data;
      throw new CliError(error.message, error.code, error.recovery, error.requestId);
    }
    return result as T;
  };
}
