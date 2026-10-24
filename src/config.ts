export function requiredEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Set ${name}; see .env.example.`);
  return value;
}

export function port(): number {
  const value = Number(process.env.PORT ?? 3000);
  if (!Number.isInteger(value) || value < 1 || value > 65535) throw new Error('Invalid PORT.');
  return value;
}

export function assertLocalDatabase(url: string, database: string): void {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error('Invalid database URL.');
  }
  if (!['postgres:', 'postgresql:'].includes(parsed.protocol)
    || !['127.0.0.1', 'localhost', '[::1]'].includes(parsed.hostname)
    || parsed.pathname !== `/${database}` || parsed.search || parsed.hash) {
    // pg permits query parameters to override connection fields, including host/user.
    throw new Error(`Refusing operation: use a loopback PostgreSQL database named ${database}, without query parameters or fragments.`);
  }
}
