import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { Readable } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';
import { readPasswords } from '../src/cli/input.js';
import { createClient } from '../src/cli/client.js';

describe('CLI input and errors', () => {
  it.each([
    ['login'],
    ['whoami', '--unknown'],
    ['unknown-command'],
  ])('returns JSON for invalid arguments: %s', (...args) => {
    const result = spawnSync(process.execPath, ['--import', 'tsx', resolve('src/cli/index.ts'), '--json', ...args], { encoding: 'utf8' });
    expect(result.status).toBe(1);
    expect(result.stdout).toBe('');
    expect(JSON.parse(result.stderr)).toMatchObject({ error: { code: 'INVALID_ARGUMENT', recovery: expect.any(String) } });
  });

  it('decodes a password whose UTF-8 character crosses stdin chunks', async () => {
    const input = Readable.from([Buffer.from([0xc3]), Buffer.from([0xa9, 0x0a])]);
    const stdin = vi.spyOn(process, 'stdin', 'get').mockReturnValue(input as typeof process.stdin);
    try { expect(await readPasswords(['Password'], true)).toEqual(['é']); }
    finally { stdin.mockRestore(); }
  });

  it.each([
    ['broken JSON', 200, 'INVALID_RESPONSE'],
    ['{}', 502, 'API_ERROR'],
  ])('preserves uncertain-write recovery for unusable responses: %s', async (body, status, code) => {
    const fetch = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(body, { status }));
    try {
      const request = createClient('http://127.0.0.1:3000');
      await expect(request('/missions', 'POST', {})).rejects.toMatchObject({
        code, recovery: expect.stringContaining('Inspect the relevant list/show command before retrying'),
      });
      expect(fetch).toHaveBeenCalledTimes(1);
    } finally { fetch.mockRestore(); }
  });
});
