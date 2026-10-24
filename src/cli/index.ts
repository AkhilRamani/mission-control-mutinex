import { Command, CommanderError } from 'commander';
import { clearCredentials, loadCredentials, saveCredentials } from './credentials.js';
import { apiOrigin, createClient } from './client.js';
import { CliError } from './errors.js';
import { readPasswords } from './input.js';
import type { Identity } from '../domain/auth.js';

const program = new Command().name('mc').description('Mission Control API client')
  .option('--api <origin>', 'API origin (or MC_API_URL; defaults to stored origin or http://127.0.0.1:3000)')
  .option('--json', 'machine-readable output')
  .configureOutput({ writeErr: () => {} }).exitOverride();
// Available even when argument parsing fails before Commander sets its options.
const jsonOutput = process.argv.includes('--json');

function print(value: unknown, human: string) {
  console.log(jsonOutput ? JSON.stringify(value) : human);
}
function describe(user: Identity) {
  return `${user.displayName} (${user.username}) | ${user.role} | ${user.organisation.name} (${user.organisation.slug})`;
}
async function context(required = true) {
  const credentials = await loadCredentials();
  const apiUrl = apiOrigin(program.opts().api ?? process.env.MC_API_URL ?? credentials?.apiUrl ?? 'http://127.0.0.1:3000');
  if (required && !credentials) throw new CliError('Not logged in.', 'UNAUTHENTICATED', 'Run mc login --org <slug> --username <name>.');
  return { credentials, apiUrl, request: createClient(apiUrl, credentials) };
}

program.command('login').description('Log in and save a private, server-bound session')
  .requiredOption('--org <slug>', 'organisation slug')
  .requiredOption('--username <name>', 'username')
  .option('--password-stdin', 'read one password line from stdin instead of a hidden prompt')
  .action(async (opts) => {
    const { credentials, apiUrl, request } = await context(false);
    if (credentials) throw new CliError('A session is already stored.', 'ALREADY_LOGGED_IN', 'Run mc logout before switching accounts.');
    const [password] = await readPasswords(['Password'], Boolean(opts.passwordStdin));
    const result = await request<{ token: string; expiresAt: string; user: Identity }>('/auth/login', 'POST', {
      organisation: opts.org, username: opts.username, password,
    });
    try { await saveCredentials({ apiUrl, token: result.token, expiresAt: result.expiresAt }); }
    catch (error) {
      // If disk storage fails, revoke the newly created session where possible.
      await createClient(apiUrl, { apiUrl, token: result.token, expiresAt: result.expiresAt })('/auth/logout', 'POST', {}).catch(() => {});
      if (error instanceof CliError) throw error;
      throw new CliError('Cannot save private credentials.', 'STORAGE_ERROR', 'Check MC_CONFIG_DIR (default ~/.config/mission-control), ownership and permissions (700).');
    }
    print({ user: result.user, expiresAt: result.expiresAt }, `Logged in: ${describe(result.user)}`);
  });

program.command('whoami').description('Show the identity and organisation authenticated by the API')
  .action(async () => {
    const { request } = await context();
    const result = await request<{ user: Identity }>('/me');
    print(result, describe(result.user));
  });

program.command('logout').description('Revoke the current session and remove local credentials')
  .action(async () => {
    const { credentials, request } = await context(false);
    if (credentials) {
      try { await request('/auth/logout', 'POST', {}); }
      catch (error) { if (!(error instanceof CliError) || error.code !== 'UNAUTHENTICATED') throw error; }
      await clearCredentials();
    }
    print({ message: 'Logged out.' }, 'Logged out.');
  });

program.command('password').description('Manage your own password')
  .command('change').description('Change your password and revoke all your sessions')
  .option('--password-stdin', 'read current and new password on two stdin lines')
  .action(async (opts) => {
    const { request } = await context();
    const [oldPassword, newPassword] = await readPasswords(['Current password', 'New password (12–128 characters)'], Boolean(opts.passwordStdin));
    const result = await request<{ message: string }>('/me/password', 'PUT', { oldPassword, newPassword });
    await clearCredentials();
    print(result, result.message);
  });

try {
  if (process.argv.length === 2) program.help();
  await program.parseAsync();
} catch (error) {
  if (error instanceof CommanderError && error.exitCode === 0) { process.exitCode = 0; }
  else {
    let safe: CliError;
    if (error instanceof CliError) safe = error;
    else if (error instanceof CommanderError) {
      safe = new CliError('Invalid command arguments.', 'INVALID_ARGUMENT', 'Run mc --help or mc <command> --help.');
    } else {
      safe = new CliError(error instanceof Error && error.name === 'ExitPromptError' ? 'Cancelled.' : 'Command failed. Check local credential storage and retry.');
    }
    const output = { error: { code: safe.code, message: safe.message, recovery: safe.recovery, ...(safe.requestId ? { requestId: safe.requestId } : {}) } };
    console.error(jsonOutput ? JSON.stringify(output) : `${safe.code}: ${safe.message}${safe.recovery ? ` ${safe.recovery}` : ''}${safe.requestId ? ` [${safe.requestId}]` : ''}`);
    process.exitCode = 1;
  }
}
