import type { Command } from 'commander';
import type { CommandContext, Print } from './context.js';
import { CliError } from './errors.js';
import { confirmRemoval, parseVersion } from './input.js';
import { missionDetails } from './mission-output.js';
import type { Mission } from './mission-output.js';

export function registerApprovalCommands(missions: Command, context: CommandContext, print: Print) {
  missions.command('submit').description('Freeze a fully accepted, eligible roster for independent approval')
    .requiredOption('--mission <id>', 'draft mission ID')
    .requiredOption('--version <number>', 'mission version you reviewed', parseVersion).action(async (opts) => {
      const { request } = await context();
      const result = await request<Mission>(`/missions/${encodeURIComponent(opts.mission)}/submit`, 'POST', { version: opts.version });
      print(result, missionDetails(result));
    });
  missions.command('approve').description('Independent Director: recheck and reserve the entire roster atomically')
    .requiredOption('--mission <id>', 'submitted mission ID')
    .option('--version <number>', 'reviewed mission version; otherwise review and confirm interactively', parseVersion).action(async (opts) => {
      const { request } = await context();
      const path = `/missions/${encodeURIComponent(opts.mission)}`;
      let version: number | undefined = opts.version;
      if (version === undefined) {
        if (!process.stdin.isTTY) throw new CliError('A reviewed version is required.', 'VERSION_REQUIRED',
          'Run missions show, review the full plan and roster, then pass --version.');
        const mission = await request<Mission>(path);
        console.error(missionDetails(mission));
        await confirmRemoval('Approve this exact plan and reserve its crew?', false);
        version = mission.version;
      }
      const result = await request<Mission>(`${path}/approve`, 'POST', { version });
      print(result, missionDetails(result));
    });
  for (const action of ['withdraw', 'reject'] as const) {
    missions.command(action).description(`${action === 'reject' ? 'Independent Director' : 'Owner/Director'}: return to draft and reset all consent`)
      .requiredOption('--mission <id>', 'submitted mission ID')
      .requiredOption('--version <number>', 'mission version you reviewed', parseVersion)
      .requiredOption('--reason <text>', 'reason recorded in planner-visible history')
      .option('--yes', 'confirm without prompting').action(async (opts) => {
        const { request } = await context();
        await confirmRemoval(`${action === 'reject' ? 'Reject' : 'Withdraw'} mission ${opts.mission} and reset all consent?`, Boolean(opts.yes));
        const result = await request<Mission>(`/missions/${encodeURIComponent(opts.mission)}/${action}`, 'POST', { version: opts.version, reason: opts.reason });
        print(result, missionDetails(result));
      });
  }
}
