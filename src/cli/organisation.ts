import { Command, Option } from 'commander';

import { confirmAction, readPasswords } from './input.js';
import type { CommandContext, Print } from './context.js';
import { listOptions, query, listing } from './pagination.js';
import type { Page } from '../domain/pagination.js';
import type { createMember, getOrganisation, listSkills } from '../domain/organisation.js';

type Member = Awaited<ReturnType<typeof createMember>>;
type Skill = Awaited<ReturnType<typeof listSkills>>['items'][number];
type Organisation = Awaited<ReturnType<typeof getOrganisation>>;

const segment = encodeURIComponent;
const memberRow = (m: Member) => `${m.id} | ${m.displayName} (@${m.username}) | ${m.role}`;
const skillRow = (s: Skill) => `${s.id} | ${s.name}`;

export function registerOrganisationCommands(program: Command, context: CommandContext, print: Print) {
  const org = program.command('org').description('Show organisation settings; Directors may update the name');

  org.command('show').action(async () => {
    const { request } = await context();
    const result = await request<Organisation>('/organisation');
    print(result, `${result.name} (${result.slug}) | ${result.id}`);
  });

  org.command('update').requiredOption('--name <name>', 'organisation display name').action(async (opts) => {
    const { request } = await context();
    const result = await request<Organisation>('/organisation', 'PATCH', { name: opts.name });
    print(result, `${result.name} (${result.slug}) | ${result.id}`);
  });

  const members = program.command('members').description('Director-only account provisioning and discovery');

  listOptions(members.command('list')).action(async (opts) => {
    const { request } = await context();
    const result = await request<Page<Member>>(`/members${query(opts)}`);
    print(result, listing(result, memberRow));
  });

  members.command('create').requiredOption('--username <username>', 'immutable login name')
    .requiredOption('--name <name>', 'display name')
    .addOption(new Option('--role <role>', 'fixed account role').choices(['director', 'lead', 'crew']).makeOptionMandatory())
    .option('--password-stdin', 'read the initial password from one stdin line; otherwise prompt privately')
    .action(async (opts) => {
      const { request } = await context();
      const [password] = await readPasswords(['Initial password (12–128 characters)'], Boolean(opts.passwordStdin));
      const result = await request<Member>('/members', 'POST', { username: opts.username, displayName: opts.name, role: opts.role, password });
      print(result, `${memberRow(result)}\nTo create its crew profile: mc crew create --member ${result.id}`);
    });

  const skills = program.command('skills').description('Tenant skill catalogue; Directors manage names (renames must preserve meaning)');

  listOptions(skills.command('list')).action(async (opts) => {
    const { request } = await context();
    const result = await request<Page<Skill>>(`/skills${query(opts)}`);
    print(result, listing(result, skillRow));
  });

  skills.command('add').requiredOption('--name <name>', 'skill name, stored lowercase').action(async (opts) => {
    const { request } = await context();
    const result = await request<Skill>('/skills', 'POST', { name: opts.name });
    print(result, skillRow(result));
  });

  skills.command('rename').requiredOption('--skill <id>', 'skill ID from skills list').requiredOption('--name <name>', 'new name, same meaning')
    .action(async (opts) => {
      const { request } = await context();
      const result = await request<Skill>(`/skills/${segment(opts.skill)}`, 'PATCH', { name: opts.name });
      print(result, skillRow(result));
    });

  skills.command('remove').requiredOption('--skill <id>', 'unreferenced skill ID').option('--yes', 'confirm without prompting')
    .action(async (opts) => {
      const { request } = await context();
      await confirmAction(`Remove skill ${opts.skill}?`, Boolean(opts.yes));
      const result = await request<{ message: string }>(`/skills/${segment(opts.skill)}`, 'DELETE');
      print(result, result.message);
    });
}
