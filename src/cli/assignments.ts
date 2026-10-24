import { Command } from 'commander';

import type { CommandContext, Print } from './context.js';
import { CliError } from './errors.js';
import { confirmAction, parseVersion } from './input.js';
import { assignmentDetails, assignmentRow, missionDetails } from './mission-output.js';
import type { Assignment, AssignmentPage, AssignmentResponse, Mission } from './mission-output.js';
import { listing, listOptions, query } from './pagination.js';

const path = (id: string) => `/assignments/${encodeURIComponent(id)}`;

export function registerAssignmentCommands(program: Command, context: CommandContext, print: Print) {
  const assignments = program.command('assignments').description('Proposals, personal consent and retained attempts');

  listOptions(assignments.command('list').option('--mine', 'only assignments for your own crew profile'), false).action(async (opts) => {
    const { request } = await context();
    const result = await request<AssignmentPage>(`/assignments${query(opts)}${opts.mine ? '&mine=true' : ''}`);
    print(result, listing(result, assignmentRow));
  });

  assignments.command('show').requiredOption('--assignment <id>', 'assignment ID from list or missions show').action(async (opts) => {
    const { request } = await context();
    const result = await request<Assignment>(path(opts.assignment));
    print(result, assignmentDetails(result));
  });

  assignments.command('accept').requiredOption('--assignment <id>', 'your proposed assignment')
    .option('--version <number>', 'reviewed mission version; otherwise review and confirm interactively', parseVersion).action(async (opts) => {
      const { request } = await context();
      let version: number | undefined = opts.version;
      if (version === undefined) {
        if (!process.stdin.isTTY) throw new CliError('A reviewed version is required.', 'VERSION_REQUIRED', 'Run assignments show, review the plan and pass --version.');
        const assignment = await request<Assignment>(path(opts.assignment));
        console.error(assignmentDetails(assignment));
        await confirmAction('Accept this exact plan? Consent does not reserve time.', false);
        version = assignment.version;
      }
      const result = await request<AssignmentResponse>(`${path(opts.assignment)}/accept`, 'POST', { version });
      print(result, `${result.id} | ${result.state} | mission ${result.missionId} v${result.version} | consent only, no booking`);
    });

  for (const action of ['decline', 'retract'] as const) {
    assignments.command(action).requiredOption('--assignment <id>', 'your assignment ID')
      .requiredOption('--version <number>', 'mission version you reviewed', parseVersion).action(async (opts) => {
        const { request } = await context();
        const result = await request<AssignmentResponse>(`${path(opts.assignment)}/${action}`, 'POST', { version: opts.version });
        print(result, `${result.id} | ${result.state} | mission ${result.missionId} v${result.version}`);
      });
  }

  assignments.command('remove').description('Owner/Director: withdraw one draft proposal, retaining its history')
    .requiredOption('--assignment <id>', 'assignment ID').requiredOption('--version <number>', 'reviewed mission version', parseVersion)
    .option('--yes', 'confirm without prompting').action(async (opts) => {
      const { request } = await context();
      const assignment = await request<Assignment>(path(opts.assignment));
      await confirmAction(`Withdraw assignment ${assignment.id} from ${assignment.mission.title}?`, Boolean(opts.yes));
      const result = await request<Mission>(`/missions/${encodeURIComponent(assignment.missionId)}/proposals/${encodeURIComponent(assignment.id)}`, 'DELETE', { version: opts.version });
      print(result, missionDetails(result));
    });
}
