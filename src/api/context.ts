import type { Identity } from '../domain/auth.js';

export type Env = { Variables: { requestId: string; user: Identity; token: string } };
