import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { Readable } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';
import { readPasswords } from '../src/cli/input.js';
import { createClient } from '../src/cli/client.js';
import { Command } from 'commander';
import { registerMissionActions } from '../src/cli/mission-actions.js';
import { CliError } from '../src/cli/errors.js';
import * as input from '../src/cli/input.js';

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

describe('interactive approval', () => {
  it('uses the displayed version and propagates stale-state errors without refreshing or retrying', async () => {
    const mission = { id: 'mission-id', version: 7, state: 'submitted', title: 'Supply flight', brief: 'Deliver supplies',
      start: '2030-01-10T09:00:00Z', end: '2030-01-10T17:00:00Z', positions: [], assignments: [] };
    const request = vi.fn().mockResolvedValueOnce(mission).mockRejectedValueOnce(new CliError('Changed', 'STALE_VERSION'));
    const tty = vi.spyOn(process, 'stdin', 'get').mockReturnValue({ isTTY: true } as typeof process.stdin);
    const display = vi.spyOn(console, 'error').mockImplementation(() => {});
    const confirm = vi.spyOn(input, 'confirmRemoval').mockResolvedValue();
    const print = vi.fn();
    try {
      const program = new Command();
      registerMissionActions(program.command('missions'), async () => ({ request, apiUrl: 'http://127.0.0.1:3000', credentials: undefined }), print);
      await expect(program.parseAsync(['missions', 'approve', '--mission', mission.id], { from: 'user' }))
        .rejects.toMatchObject({ code: 'STALE_VERSION' });
      expect(display).toHaveBeenCalledWith(expect.stringContaining('v7'));
      expect(confirm).toHaveBeenCalledOnce();
      expect(request.mock.calls).toEqual([[`/missions/${mission.id}`], [`/missions/${mission.id}/approve`, 'POST', { version: 7 }]]);
      expect(print).not.toHaveBeenCalled();
    } finally { tty.mockRestore(); display.mockRestore(); confirm.mockRestore(); }
  });
});
