import { readFileSync } from 'node:fs';
import { z } from 'zod';
import { commandLineService } from './command-line/command-line.ts';
import type { CommandName } from './command-line/commands.ts';
import { handleAgents } from './commands/agents.ts';
import { handleAuth } from './commands/auth.ts';
import { handleCheck } from './commands/check.ts';
import { commandService } from './commands/context.ts';
import type { CommandHandler } from './commands/context.ts';
import { handleGet } from './commands/get.ts';
import { handleHistory } from './commands/history.ts';
import { handleProtect } from './commands/protect.ts';
import { handlePull } from './commands/pull.ts';
import { handlePush } from './commands/push.ts';
import { handleSet } from './commands/set.ts';
import { handleTrust } from './commands/trust.ts';
import { handleStatus } from './commands/status.ts';
import { CliError, ExitCode } from './errors.ts';
import { manifestService } from './manifest/manifest.ts';
import {
  protectedInvocation,
  verifyProtectedAccess,
} from './protect/protect.ts';
import { createSecretManagerApi } from './secret-manager/secret-manager-api.ts';
import { createSecretService } from './secret-manager/secrets.ts';
import { trustService } from './trust.ts';
import type { Io } from './terminal/io.ts';
import { format } from './utils/format.ts';

const commandHandlers = {
  status: handleStatus,
  set: handleSet,
  get: handleGet,
  history: handleHistory,
  pull: handlePull,
  push: handlePush,
  protect: handleProtect,
} satisfies Record<
  Exclude<CommandName, 'check' | 'trust' | 'auth' | 'agents'>,
  CommandHandler
>;

const getPackageVersion = () =>
  z
    .object({ version: z.string() })
    .parse(
      JSON.parse(
        readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
      ),
    ).version;

const handleCommandLine = async (argv: readonly string[], io: Io) => {
  const line = commandLineService.parse(argv);
  if (line.kind === 'version') {
    io.stdout.write(`${getPackageVersion()}\n`);
    return ExitCode.ok;
  }
  if (line.kind === 'help') {
    io.stdout.write(
      line.command === undefined
        ? commandLineService.help.main(getPackageVersion())
        : commandLineService.help.command(line.command),
    );
    return ExitCode.ok;
  }
  if (line.command === 'check') return handleCheck({ io, isJson: line.isJson });
  if (line.command === 'auth') return handleAuth({ io, isJson: line.isJson });

  const loaded = manifestService.get(io.cwd);
  if (line.command === 'trust') return handleTrust({ io, loaded });
  if (line.command === 'agents') {
    return handleAgents({
      io,
      loaded,
      isWriting: line.isWriting,
      isDryRun: line.isDryRun,
      isForced: line.isForced,
      file: line.file,
    });
  }
  for (const env of commandLineService.getEnvWords(line)) {
    commandService.assertEnv(loaded.manifest, env);
  }

  const protectedEnvs = manifestService.getProtectedEnvs({
    ...loaded,
    cwd: io.cwd,
  });
  const envWords = commandLineService.getEnvWords(line);
  const confirmedEnvs =
    protectedInvocation(argv, {
      envs: Object.fromEntries(
        [...protectedEnvs].map((env) => [env, { protected: true }]),
      ),
    })?.envs ?? [];
  // a secret labelled protected applies the rules once, for the envs on this command line
  let labelCheck: Promise<void> | undefined;
  const confirmLabelledSecret = () => {
    if (confirmedEnvs.length > 0) return Promise.resolve();
    labelCheck ??= verifyProtectedAccess(
      envWords.length > 0 ? envWords : ['this env'],
      io,
    );
    return labelCheck;
  };
  const runCommand = commandHandlers[line.command]({
    io,
    loaded,
    line,
    protectedEnvs,
    secrets: createSecretService(createSecretManagerApi(io.google), {
      onProtectedSecret: confirmLabelledSecret,
    }),
  });
  await verifyProtectedAccess(confirmedEnvs, io);
  // set and push send values to the manifest's project, so it has to be one the person trusts;
  // protect writes labels there too
  if (
    line.command === 'set' ||
    line.command === 'push' ||
    line.command === 'protect'
  ) {
    const [env = ''] = line.words;
    const keys =
      line.command === 'set'
        ? line.words.slice(1, 2)
        : manifestService.envs.getSecretKeys(loaded.manifest, env);
    await trustService.verify({
      io,
      manifestPath: loaded.path,
      projectUses: trustService.getProjectUses({
        manifest: loaded.manifest,
        pairs: keys.map((key) => ({ env, key })),
      }),
      isTrustCommand: false,
    });
  }
  return runCommand();
};

// Every string storehouse prints passes through here, so nothing a manifest, Google or a CLI says
// can send a terminal its own escape sequences. A value from get is bytes and goes out as it is.
const withSafeOutput = (io: Io) =>
  ({
    ...io,
    stdout: {
      ...io.stdout,
      write: (data) => {
        io.stdout.write(
          typeof data === 'string' ? format.terminalSafe(data) : data,
        );
      },
    },
    stderr: {
      ...io.stderr,
      write: (data) => {
        io.stderr.write(format.terminalSafe(data));
      },
      writeRelayed: (data) => {
        io.stderr.write(format.terminalSafe(data, { isRelayed: true }));
      },
    },
  }) satisfies Io;

// Runs one command line and returns its exit code. Errors go to stderr; none is thrown.
export const run = async (argv: readonly string[], unsafeIo: Io) => {
  const io = withSafeOutput(unsafeIo);
  try {
    return await handleCommandLine(argv, io);
  } catch (error) {
    if (error instanceof CliError) {
      io.stderr.write(`${error.message}\n`);
      return error.exitCode;
    }
    // the system refusing a file or a process (ENOENT, EACCES, EISDIR) is a failure, not a bug
    if (error instanceof Error && 'syscall' in error) {
      io.stderr.write(`${error.message}\n`);
      return ExitCode.failed;
    }
    io.stderr.write(
      `storehouse failed unexpectedly. This is a bug; please report it with the output below.\n${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`,
    );
    return ExitCode.failed;
  }
};
