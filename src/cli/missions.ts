import { Command, Option } from 'commander';
import { z } from 'zod';
import type { RequirementInput } from '../domain/missions/planning.js';
import type { Page } from '../domain/pagination.js';
import type { CommandContext, Print } from './context.js';
import { matchDetails, missionDetails, missionRow } from './mission-output.js';
import type { Mission, MissionSummary, History, Match } from './mission-output.js';
import { CliError } from './errors.js';
import { confirmRemoval, parseVersion } from './input.js';
import { listOptions, listing, query } from './pagination.js';
import { registerApprovalCommands } from './mission-approval.js';

type Request = Awaited<ReturnType<CommandContext>>['request'];
const path = (id: string) => `/missions/${encodeURIComponent(id)}`;

function reviewedVersion(command: Command) {
  return command.requiredOption('--version <number>', 'mission version you reviewed with missions show', parseVersion);
}
function planOptions(command: Command) {
  return command.option('--title <text>', 'mission title').option('--brief <text>', 'mission brief; empty string clears it')
    .option('--start <timestamp>', 'ISO timestamp with Z or offset (inclusive)')
    .option('--end <timestamp>', 'ISO timestamp with Z or offset (exclusive)');
}

async function requirements(request: Request, values: string[]) {
  const result: RequirementInput[] = [];
  for (const value of values) {
    const colon = value.lastIndexOf(':');
    const name = value.slice(0, colon).trim().toLowerCase(), level = value.slice(colon + 1);
    if (colon < 1 || !name || !/^[1-5]$/.test(level)) {
      throw new CliError('Invalid requirement.', 'INVALID_ARGUMENT', 'Use --requires piloting:3 medical:2, or skill UUIDs followed by :level (1–5).');
    }
    let skillId: string | undefined;
    if (z.uuid().safeParse(name).success) skillId = name;
    else {
      let offset: number | null = 0;
      do {
        const page: Page<{ id: string; name: string }> = await request(`/skills?q=${encodeURIComponent(name)}&limit=100&offset=${offset}`);
        skillId = page.items.find((skill) => skill.name === name)?.id;
        offset = page.nextOffset;
      } while (!skillId && offset !== null);
      if (!skillId) throw new CliError(`Unknown skill: ${name}.`, 'SKILL_NOT_FOUND', 'Run mc skills list and use an exact name or ID.');
    }
    if (result.some((r) => r.skillId === skillId)) throw new CliError('Duplicate skill requirement.', 'INVALID_ARGUMENT', 'Specify each skill once.');
    result.push({ skillId, minProficiency: Number(level) });
  }
  return result;
}

export function registerMissionCommands(program: Command, context: CommandContext, print: Print) {
  const missions = program.command('missions').description('Plan, staff and approve missions using the version you reviewed');
  registerApprovalCommands(missions, context, print);
  listOptions(missions.command('list')).addOption(new Option('--state <state>', 'filter mission state')
    .choices(['draft', 'submitted', 'approved', 'completed', 'cancelled'])).action(async (opts) => {
    const { request } = await context();
    const result = await request<Page<MissionSummary>>(`/missions${query(opts)}${opts.state ? `&state=${opts.state}` : ''}`);
    print(result, listing(result, missionRow));
  });
  missions.command('create').requiredOption('--title <text>', 'mission title').option('--brief <text>', 'mission brief', '')
    .requiredOption('--start <timestamp>', 'future ISO timestamp with Z or offset (inclusive)')
    .requiredOption('--end <timestamp>', 'ISO timestamp with Z or offset (exclusive)').action(async (opts) => {
      const { request } = await context();
      const result = await request<Mission>('/missions', 'POST', { title: opts.title, brief: opts.brief, start: opts.start, end: opts.end });
      print(result, missionDetails(result));
    });
  missions.command('show').requiredOption('--mission <id>', 'mission ID').action(async (opts) => {
    const { request } = await context();
    const result = await request<Mission>(path(opts.mission));
    print(result, missionDetails(result));
  });
  missions.command('match').requiredOption('--mission <id>', 'draft mission ID').action(async (opts) => {
    const { request } = await context();
    const result = await request<Match>(`${path(opts.mission)}/match`);
    print(result, matchDetails(result));
  });
  reviewedVersion(missions.command('propose').description('Replace the roster; omitted positions are withdrawn. Partial manual rosters are allowed.')
    .requiredOption('--mission <id>', 'draft mission ID')
    .addOption(new Option('--pairs <position=crew...>', 'position and crew IDs').conflicts('suggested'))
    .addOption(new Option('--suggested', 'apply a full fresh match using the reviewed mission version').conflicts('pairs')))
    .action(async (opts) => {
      const { request } = await context();
      let proposals: { positionId: string; crewId: string }[];
      if (opts.suggested) {
        const match = await request<Match>(`${path(opts.mission)}/match`);
        if (match.version !== opts.version) throw new CliError('The mission has changed.', 'STALE_VERSION', 'Run missions show and match, then use the reviewed version.');
        if (!match.complete) throw new CliError('A full roster is not possible.', 'INCOMPLETE_MATCH', 'Run missions match for exclusions; revise the plan or propose explicit partial pairs.');
        proposals = match.roster.map(({ positionId, crewId }) => ({ positionId, crewId }));
      } else if (opts.pairs) {
        proposals = opts.pairs.map((value: string) => {
          const parts = value.split('=');
          if (parts.length !== 2 || !parts.every((p) => z.uuid().safeParse(p).success)) {
            throw new CliError('Invalid proposal pair.', 'INVALID_ARGUMENT', 'Use --pairs <position-id>=<crew-id> ... from missions show and crew list.');
          }
          return { positionId: parts[0]!, crewId: parts[1]! };
        });
      } else throw new CliError('Choose a roster.', 'INVALID_ARGUMENT', 'Use --suggested or --pairs <position-id>=<crew-id> ... .');
      const result = await request<Mission>(`${path(opts.mission)}/proposals`, 'PUT', { version: opts.version, proposals });
      print(result, missionDetails(result));
    });
  reviewedVersion(planOptions(missions.command('update').requiredOption('--mission <id>', 'mission ID'))).action(async (opts) => {
    const { request } = await context();
    const result = await request<Mission>(path(opts.mission), 'PATCH', { version: opts.version, title: opts.title, brief: opts.brief, start: opts.start, end: opts.end });
    print(result, missionDetails(result));
  });
  listOptions(missions.command('history').requiredOption('--mission <id>', 'mission ID'), false).action(async (opts) => {
    const { request } = await context();
    const result = await request<History>(`${path(opts.mission)}/history${query(opts)}`);
    print(result, `Mission ${result.missionId} | current v${result.version}\n${listing(result,
      (e) => `v${e.missionVersion} | ${e.occurredAt} | ${e.kind}${'actorId' in e ? ` | actor ${e.actorId}` : ''}\n${JSON.stringify(e.payload, null, 2)}`)}`);
  });

  const positions = program.command('positions').description('Draft positions and their required skills; mutations return the updated mission');
  reviewedVersion(positions.command('add').requiredOption('--mission <id>', 'mission ID').requiredOption('--label <text>', 'position label')
    .option('--requires <skill:level...>', 'exact skill names or IDs, each with minimum proficiency 1–5')).action(async (opts) => {
    const { request } = await context();
    const result = await request<Mission>(`${path(opts.mission)}/positions`, 'POST', {
      version: opts.version, label: opts.label, requirements: await requirements(request, opts.requires ?? []),
    });
    print(result, missionDetails(result));
  });
  reviewedVersion(positions.command('update').requiredOption('--mission <id>', 'mission ID').requiredOption('--position <id>', 'position ID from missions show')
    .option('--label <text>', 'position label').option('--requires <skill:level...>', 'replace all requirements with these exact skill names or IDs')
    .addOption(new Option('--clear-requirements', 'remove all requirements').conflicts('requires'))).action(async (opts) => {
    const { request } = await context();
    const result = await request<Mission>(`${path(opts.mission)}/positions/${encodeURIComponent(opts.position)}`, 'PATCH', {
      version: opts.version, label: opts.label,
      requirements: opts.clearRequirements ? [] : opts.requires ? await requirements(request, opts.requires) : undefined,
    });
    print(result, missionDetails(result));
  });
  reviewedVersion(positions.command('remove').requiredOption('--mission <id>', 'mission ID').requiredOption('--position <id>', 'position ID from missions show')
    .option('--yes', 'confirm without prompting')).action(async (opts) => {
    const { request } = await context();
    await confirmRemoval(`Remove position ${opts.position} from mission ${opts.mission}?`, Boolean(opts.yes));
    const result = await request<Mission>(`${path(opts.mission)}/positions/${encodeURIComponent(opts.position)}`, 'DELETE', { version: opts.version });
    print(result, missionDetails(result));
  });
}
