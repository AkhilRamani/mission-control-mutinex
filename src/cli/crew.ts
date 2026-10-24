import { Command, Option } from 'commander';

import { confirmAction } from './input.js';
import type { getCrew, listCrew } from '../domain/crew.js';
import type { Page } from '../domain/pagination.js';
import type { CommandContext, Print } from './context.js';
import { listOptions, query, listing } from './pagination.js';
import { assignmentRow } from './mission-output.js';
import type { AssignmentPage } from './mission-output.js';

type Profile = Awaited<ReturnType<typeof getCrew>>;
type CrewSummary = Awaited<ReturnType<typeof listCrew>>['items'][number];
type Window = { id: string; start: string; end: string };

const segment = encodeURIComponent;
const profilePath = (id: string) => `/crew/${segment(id)}`;

const crewRow = (c: CrewSummary) => `${c.id} | ${c.displayName} (@${c.username}) | ${c.role} | ${c.active ? 'active' : 'inactive'}`;
const windowRow = (w: Window) => `${w.id} | ${w.start} → ${w.end}`;

const profileText = (p: Profile) => `${crewRow(p)}\nBiography: ${p.biography || '(empty)'}\nSkills:\n${p.skills.length
  ? p.skills.map((s) => `${s.id} | ${s.name} | proficiency ${s.proficiency}/5`).join('\n') : '(none)'}\nAvailability: mc availability list --crew ${p.id}`;

export function registerCrewCommands(program: Command, context: CommandContext, print: Print) {
  const crew = program.command('crew').description('Crew discovery and profiles; Crew members see only themselves');

  listOptions(crew.command('list')).action(async (opts) => {
    const { request } = await context();
    const result = await request<Page<CrewSummary>>(`/crew${query(opts)}`);
    print(result, listing(result, crewRow));
  });

  crew.command('create').description('Director: create one optional profile for an existing member')
    .requiredOption('--member <id>', 'account ID from members list/create').action(async (opts) => {
      const { request } = await context();
      const result = await request<Profile>('/crew', 'POST', { userId: opts.member });
      print(result, profileText(result));
    });

  crew.command('show').option('--crew <id|me>', 'crew ID, or your own profile', 'me').action(async (opts) => {
    const { request } = await context();
    const result = await request<Profile>(profilePath(opts.crew));
    print(result, profileText(result));
  });

  listOptions(crew.command('history').option('--crew <id|me>', 'crew ID, or your own profile', 'me'), false).action(async (opts) => {
    const { request } = await context();
    const result = await request<AssignmentPage & { crewId: string }>(`${profilePath(opts.crew)}/history${query(opts)}`);
    print(result, `Crew ${result.crewId}\n${listing(result, assignmentRow)}`);
  });

  crew.command('update').description('Update own name/biography; Directors may edit others and active status')
    .option('--crew <id|me>', 'crew ID, or your own profile', 'me').option('--name <name>', 'display name')
    .option('--bio <text>', 'biography; use an empty string to clear')
    .addOption(new Option('--active <boolean>', 'Director-only eligibility flag').choices(['true', 'false']))
    .option('--yes', 'confirm deactivation without prompting').action(async (opts) => {
      const { request } = await context();
      if (opts.active === 'false') await confirmAction(`Deactivate crew ${opts.crew}?`, Boolean(opts.yes));
      const result = await request<Profile>(profilePath(opts.crew), 'PATCH', {
        ...(opts.name !== undefined ? { displayName: opts.name } : {}), ...(opts.bio !== undefined ? { biography: opts.bio } : {}),
        ...(opts.active !== undefined ? { active: opts.active === 'true' } : {}),
      });
      print(result, profileText(result));
    });

  const levels = crew.command('skills').description('Manage only your own skills; use crew show to view them');

  levels.command('set').option('--crew <id|me>', 'your crew profile', 'me').requiredOption('--skill <id>', 'skill ID from skills list')
    .requiredOption('--level <1-5>', 'self-declared proficiency: 1 beginner, 2 basic, 3 independent, 4 advanced, 5 expert')
    .action(async (opts) => {
      const { request } = await context();
      const result = await request<{ skillId: string; proficiency: number }>(`${profilePath(opts.crew)}/skills/${segment(opts.skill)}`, 'PUT', { proficiency: Number(opts.level) });
      print(result, `${result.skillId} | proficiency ${result.proficiency}/5`);
    });

  levels.command('remove').option('--crew <id|me>', 'your crew profile', 'me').requiredOption('--skill <id>', 'skill ID from crew show')
    .option('--yes', 'confirm without prompting').action(async (opts) => {
      const { request } = await context();
      await confirmAction(`Remove skill ${opts.skill} from crew ${opts.crew}?`, Boolean(opts.yes));
      const result = await request<{ message: string }>(`${profilePath(opts.crew)}/skills/${segment(opts.skill)}`, 'DELETE');
      print(result, result.message);
    });

  const availability = program.command('availability').description('UTC availability windows; only owners may add/remove their windows');

  listOptions(availability.command('list').option('--crew <id|me>', 'crew ID, or your own profile', 'me'), false).action(async (opts) => {
    const { request } = await context();
    const result = await request<Page<Window>>(`${profilePath(opts.crew)}/availability${query(opts)}`);
    print(result, listing(result, windowRow));
  });

  availability.command('add').option('--crew <id|me>', 'your crew profile', 'me')
    .requiredOption('--start <timestamp>', 'ISO timestamp with Z or offset (inclusive)')
    .requiredOption('--end <timestamp>', 'ISO timestamp with Z or offset (exclusive)').action(async (opts) => {
      const { request } = await context();
      const result = await request<Window>(`${profilePath(opts.crew)}/availability`, 'POST', { start: opts.start, end: opts.end });
      print(result, windowRow(result));
    });

  availability.command('remove').option('--crew <id|me>', 'your crew profile', 'me').requiredOption('--window <id>', 'window ID from availability list')
    .option('--yes', 'confirm without prompting').action(async (opts) => {
      const { request } = await context();
      await confirmAction(`Remove availability ${opts.window} from crew ${opts.crew}?`, Boolean(opts.yes));
      const result = await request<{ message: string }>(`${profilePath(opts.crew)}/availability/${segment(opts.window)}`, 'DELETE');
      print(result, result.message);
    });
}
