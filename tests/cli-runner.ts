import { spawn } from 'node:child_process';
import { resolve } from 'node:path';

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
