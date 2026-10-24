import type { Command } from 'commander';
import { clearCredentials, saveCredentials } from './credentials.js';
import { createClient } from './client.js';
import { CliError } from './errors.js';
import { readPasswords } from './input.js';
import type { Identity } from '../domain/auth.js';
import type { CommandContext, Print } from './context.js';

function describe(user: Identity) {
  return `${user.displayName} (${user.username}) | ${user.role} | ${user.organisation.name} (${user.organisation.slug})`;
}

export function registerAuthCommands(program: Command, context: CommandContext, print: Print) {
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
}
