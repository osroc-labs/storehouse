// What storehouse exits with, documented in the README.
export const ExitCode = {
  ok: 0,
  failed: 1,
  usage: 2,
  manifest: 3,
  missing: 4,
  refused: 5,
} as const;

export type ExitCode = (typeof ExitCode)[keyof typeof ExitCode];

// An error the person can act on: its message names the fix, and run() exits with its code.
export class CliError extends Error {
  readonly exitCode: ExitCode;

  constructor(exitCode: ExitCode, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'CliError';
    this.exitCode = exitCode;
  }
}

export const getErrorMessage = (error: unknown) =>
  error instanceof Error ? error.message : String(error);

// a mistake on the command line: an unknown command, option, env or key
export const getUsageError = (message: string) =>
  new CliError(ExitCode.usage, message);

// something outside storehouse failed: Google, a file, a CLI
export const getFailedError = (message: string, options?: ErrorOptions) =>
  new CliError(ExitCode.failed, message, options);
