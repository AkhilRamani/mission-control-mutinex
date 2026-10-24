import { Command, CommanderError } from 'commander';

import { CliError } from './errors.js';
import { registerCrewCommands } from './crew.js';
import { registerAuthCommands } from './auth.js';
import { registerOrganisationCommands } from './organisation.js';
import { registerMissionCommands } from './missions.js';
import { registerAssignmentCommands } from './assignments.js';
import { createContext } from './context.js';

const program = new Command().name('mc').description('Mission Control API client')
  .option('--api <origin>', 'API origin (or MC_API_URL; defaults to stored origin or http://127.0.0.1:3000)')
  .option('--json', 'machine-readable output')
  .configureOutput({ writeErr: () => {} }).exitOverride();

// Available even when argument parsing fails before Commander sets its options.
const jsonOutput = process.argv.includes('--json');

function print(value: unknown, human: string) {
  console.log(jsonOutput ? JSON.stringify(value) : human);
}

const context = createContext(() => program.opts().api);
registerAuthCommands(program, context, print);
registerOrganisationCommands(program, context, print);
registerCrewCommands(program, context, print);
registerMissionCommands(program, context, print);
registerAssignmentCommands(program, context, print);

try {
  if (process.argv.length === 2) program.help();
  await program.parseAsync();
} catch (error) {
  if (error instanceof CommanderError && error.exitCode === 0) {
    process.exitCode = 0;
  } else {
    let safe: CliError;
    if (error instanceof CliError) safe = error;
    else if (error instanceof CommanderError) {
      safe = new CliError('Invalid command arguments.', 'INVALID_ARGUMENT', 'Run mc --help or mc <command> --help.');
    } else {
      safe = new CliError(error instanceof Error && error.name === 'ExitPromptError' ? 'Cancelled.' : 'Command failed. Check local credential storage and retry.');
    }

    const output = { error: { code: safe.code, message: safe.message, recovery: safe.recovery, ...(safe.requestId ? { requestId: safe.requestId } : {}) } };
    console.error(jsonOutput ? JSON.stringify(output) : `${safe.code}: ${safe.message}${safe.recovery ? ` ${safe.recovery}` : ''}${safe.requestId ? ` [${safe.requestId}]` : ''}`);
    process.exitCode = 1;
  }
}
