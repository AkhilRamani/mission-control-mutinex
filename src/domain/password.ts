import { randomBytes, scrypt, timingSafeEqual } from 'node:crypto';

// ~32 MiB per verification. Parameters travel with the hash; passwords never persist.
const N = 32768, r = 8, p = 3;

function derive(password: string, salt: string): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(password, salt, 64, { N, r, p, maxmem: 64 * 1024 * 1024 }, (error, key) => {
      if (error) reject(error); else resolve(key);
    });
  });
}

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16).toString('hex');
  const key = await derive(password, salt);
  return `scrypt$${N}$${r}$${p}$${salt}$${key.toString('hex')}`;
}

// Unknown accounts still perform the full password verification work.
export const dummyHash = `scrypt$${N}$${r}$${p}$${'0'.repeat(32)}$${'0'.repeat(128)}`;

export async function verifyPassword(password: string, hash: string): Promise<boolean> {
  const parts = hash.split('$');
  if (parts.length !== 6 || parts.slice(0, 4).join('$') !== `scrypt$${N}$${r}$${p}`
    || !/^[a-f0-9]{32}$/.test(parts[4]!) || !/^[a-f0-9]{128}$/.test(parts[5]!)) {
    throw new Error('Invalid stored password format.');
  }
  const key = await derive(password, parts[4]!);
  return timingSafeEqual(key, Buffer.from(parts[5]!, 'hex'));
}
