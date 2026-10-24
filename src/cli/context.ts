import { loadCredentials } from './credentials.js';
import { apiOrigin, createClient } from './client.js';
import { CliError } from './errors.js';

export function createContext(api: () => string | undefined) {
  return async (required = true) => {
    const credentials = await loadCredentials();
    const apiUrl = apiOrigin(api() ?? process.env.MC_API_URL ?? credentials?.apiUrl ?? 'http://127.0.0.1:3000');
    if (required && !credentials) throw new CliError('Not logged in.', 'UNAUTHENTICATED', 'Run mc login --org <slug> --username <name>.');
    return { credentials, apiUrl, request: createClient(apiUrl, credentials) };
  };
}

export type CommandContext = ReturnType<typeof createContext>;
export type Print = (value: unknown, human: string) => void;
// API dates travel as ISO strings, including dates nested in mission/assignment views.
export type Json<T> = T extends Date ? string : T extends object ? { [K in keyof T]: Json<T[K]> } : T;
