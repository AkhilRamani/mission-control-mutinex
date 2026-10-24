import type { Database } from './client.js';
import { organisations, users } from './schema.js';
import { hashPassword } from '../domain/password.js';

export const seedPassword = 'Local-mission-123!';
export const tenantIds = { atlas: '10000000-0000-4000-8000-000000000001', boreal: '20000000-0000-4000-8000-000000000001' };

export async function seedIdentity(db: Database) {
  await db.transaction(async (tx) => {
    // Refuse nonempty databases. No reset/truncate option is necessary for this slice.
    if ((await tx.select({ id: organisations.id }).from(organisations).limit(1)).length) {
      throw new Error('Seed refused: database already contains organisations.');
    }
    await tx.insert(organisations).values([
      { id: tenantIds.atlas, slug: 'atlas', name: 'Atlas' },
      { id: tenantIds.boreal, slug: 'boreal', name: 'Boreal' },
    ]);
    for (const [slug, tenantId] of Object.entries(tenantIds)) {
      const accounts = [
        { username: 'director', displayName: 'Morgan', role: 'director' as const },
        ...(slug === 'atlas' ? [{ username: 'director2', displayName: 'Taylor', role: 'director' as const }] : []),
        { username: 'lead', displayName: 'Jordan', role: 'lead' as const },
        { username: 'alex', displayName: 'Alex', role: 'crew' as const },
        ...(slug === 'atlas' ? [{ username: 'sam', displayName: 'Sam', role: 'crew' as const }] : []),
      ];
      for (const [i, account] of accounts.entries()) {
        await tx.insert(users).values({
          ...account, tenantId, passwordHash: await hashPassword(seedPassword),
          id: `${slug === 'atlas' ? '1' : '2'}0000000-0000-4000-8001-${String(i + 1).padStart(12, '0')}`,
        });
      }
    }
  });
}
