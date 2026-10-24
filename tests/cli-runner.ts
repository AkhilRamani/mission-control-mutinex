import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { resolve } from 'node:path';
import { serve } from '@hono/node-server';
import type { createApp } from '../src/api/app.js';

// Feature tests share only the HTTP lifecycle; assertions stay with their workflows.
export async function serveCliApp(app: ReturnType<typeof createApp>) {
  const server = serve({ fetch: app.fetch, hostname: '127.0.0.1', port: 0 });
  if (!server.listening) await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Expected TCP server');
  return {
    url: `http://127.0.0.1:${address.port}`,
    async close() {
      const closed = new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
      if ('closeAllConnections' in server) server.closeAllConnections();
      await closed;
    },
  };
}

// Exercise the actual executable and HTTP client, not command-handler mocks.
export function createCliRunner(configDir: string, apiUrl: string) {
  return (args: string[], input = '') => new Promise<{ stdout: string; stderr: string; code: number | null }>((resolveRun, reject) => {
    const child = spawn(process.execPath, ['--import', 'tsx', resolve('src/cli/index.ts'), '--json', ...args], {
      env: { ...process.env, MC_CONFIG_DIR: configDir, MC_API_URL: apiUrl }, stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '', stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk.toString(); });
    child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
    child.on('error', reject);
    child.on('close', (code) => resolveRun({ stdout, stderr, code }));
    child.stdin.end(input);
  });
}
