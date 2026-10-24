// Only this error type is safe to display; raw transport/filesystem errors may contain secrets.
export class CliError extends Error {
  constructor(message: string, public readonly code = 'CLI_ERROR', public readonly recovery = '', public readonly requestId?: string) {
    super(message);
  }
}
