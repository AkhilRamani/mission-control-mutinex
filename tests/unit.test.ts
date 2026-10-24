import { describe, expect, it } from 'vitest';
import { assertLocalDatabase } from '../src/config.js';
import { createAuthLimiter } from '../src/api/rate-limit.js';
import { dummyHash, hashPassword, verifyPassword } from '../src/domain/password.js';
import { apiOrigin, createClient } from '../src/cli/client.js';

describe('password storage', () => {
  it('salts hashes, verifies correctly, and performs dummy verification', async () => {
    const first = await hashPassword('an example password');
    expect(await hashPassword('an example password')).not.toBe(first);
    expect(first).not.toContain('an example password');
    expect(await verifyPassword('an example password', first)).toBe(true);
    expect(await verifyPassword('wrong', first)).toBe(false);
    expect(await verifyPassword('wrong', dummyHash)).toBe(false);
  });
});

describe('authentication budget', () => {
  it('allows ten attempts and resets at the one-minute boundary', () => {
    let now = 1000;
    const limit = createAuthLimiter(() => now);
    for (let i = 0; i < 10; i++) limit();
    expect(limit).toThrow('Too many');
    now += 59999;
    expect(limit).toThrow('Too many');
    now++;
    expect(limit).not.toThrow();
  });
});

describe('local test and seed safety', () => {
  it('rejects remote and non-test targets before destructive test setup', () => {
    expect(() => assertLocalDatabase('postgres://localhost/mission_control_test', 'mission_control_test')).not.toThrow();
    for (const url of [
      'postgres://localhost/mission_control',
      'postgres://remote/mission_control_test',
      'https://localhost/mission_control_test',
      'postgres://localhost/mission_control_test?host=remote',
      'postgres://localhost/mission_control_test?user=postgres',
    ]) {
      expect(() => assertLocalDatabase(url, 'mission_control_test')).toThrow('Refusing');
    }
  });
});

describe('CLI transport', () => {
  it('permits loopback HTTP and HTTPS, rejects insecure or ambiguous destinations', () => {
    expect(apiOrigin('http://127.0.0.1:3000')).toBe('http://127.0.0.1:3000');
    expect(apiOrigin('https://example.com')).toBe('https://example.com');
    for (const url of ['http://example.com', 'ftp://localhost', 'https://user:pass@example.com', 'https://example.com/path', 'https://example.com/?token=secret']) {
      expect(() => apiOrigin(url)).toThrow();
    }
  });
  it('never sends a saved token to a different origin', () => {
    expect(() => createClient('https://example.com', { apiUrl: 'https://other.example.com', token: 'secret', expiresAt: '' })).toThrow('different API');
  });
});
