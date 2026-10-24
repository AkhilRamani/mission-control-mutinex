import type { Database } from './client.js';
import { availability, crew, crewSkills, organisations, skills, users } from './schema.js';
import { hashPassword } from '../domain/password.js';

export const seedPassword = 'Local-mission-123!';
export const tenantIds = { atlas: '10000000-0000-4000-8000-000000000001', boreal: '20000000-0000-4000-8000-000000000001' };

export async function seedDatabase(db: Database) {
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
      const prefix = slug === 'atlas' ? '1' : '2';
      const skillNames = slug === 'atlas' ? ['piloting', 'medical'] : ['piloting', 'survival'];
      const catalogue = skillNames.map((name, i) => ({ name, tenantId,
        id: `${prefix}0000000-0000-4000-8002-${String(i + 1).padStart(12, '0')}` }));
      await tx.insert(skills).values(catalogue);
      const accounts = [
        { username: 'director', displayName: 'Morgan', role: 'director' as const },
        ...(slug === 'atlas' ? [{ username: 'director2', displayName: 'Taylor', role: 'director' as const }] : []),
        { username: 'lead', displayName: 'Jordan', role: 'lead' as const },
        { username: 'alex', displayName: 'Alex', role: 'crew' as const },
        ...(slug === 'atlas' ? [{ username: 'sam', displayName: 'Sam', role: 'crew' as const }] : []),
      ];
      for (const [i, account] of accounts.entries()) {
        const userId = `${prefix}0000000-0000-4000-8001-${String(i + 1).padStart(12, '0')}`;
        await tx.insert(users).values({
          ...account, tenantId, passwordHash: await hashPassword(seedPassword),
          id: userId,
        });
        if (account.role === 'director') continue;
        const crewId = `${prefix}0000000-0000-4000-8003-${String(i + 1).padStart(12, '0')}`;
        await tx.insert(crew).values({ id: crewId, tenantId, userId,
          biography: `${account.displayName}, ${slug} crew.`, active: true });
        const selectedSkills = account.username === 'alex' ? catalogue : [catalogue[account.username === 'sam' ? 0 : 1]!];
        await tx.insert(crewSkills).values(selectedSkills.map((skill) => ({ tenantId, crewId, skillId: skill.id,
          proficiency: account.role === 'lead' ? 1 : 4 })));
        // Fixed UTC anchor makes the initial profiles reproducible; mission seeds arrive in step 7.
        if (account.role === 'crew') await tx.insert(availability).values({
          id: `${prefix}0000000-0000-4000-8004-${String(i + 1).padStart(12, '0')}`, tenantId, crewId,
          start: new Date('2030-01-01T00:00:00Z'), end: new Date('2030-02-01T00:00:00Z'),
        });
      }
    }
  });
}
