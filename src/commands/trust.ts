import { ExitCode } from '../errors.ts';
import type { LoadedManifest } from '../manifest/manifest.ts';
import { manifestService } from '../manifest/manifest.ts';
import { pushTargetService } from '../push-targets/push-targets.ts';
import { cliService } from '../push-targets/run-cli.ts';
import type { Io } from '../terminal/io.ts';
import { trustService } from '../trust.ts';

// Every project the manifest sends values to, and every repo-local CLI a push would hand them to,
// trusted once by a person at a terminal.
export const handleTrust = async ({
  io,
  loaded,
}: {
  io: Io;
  loaded: LoadedManifest;
}) => {
  const { manifest, path, root } = loaded;
  const pairs = Object.keys(manifest.envs).flatMap((env) =>
    manifestService.envs
      .getSecretKeys(manifest, env)
      .map((key) => ({ env, key })),
  );
  const projectUses = trustService.getProjectUses({ manifest, pairs });
  await trustService.verify({ io, manifestPath: path, projectUses });
  const plannedCommands = Object.values(manifest.envs).flatMap((config) =>
    config.push.flatMap((target) =>
      pushTargetService
        .getInvocations({ target, root, keys: [], values: {} })
        .map((invocation) => invocation.command),
    ),
  );
  const repoRoots = cliService.getRepoRoots(path);
  const commandsToRun = await trustService.getCommandsToRun({
    io,
    manifestPath: path,
    commands: plannedCommands,
    findOnPath: (name) =>
      cliService.findOnPath({ name, env: io.env, repoRoots }),
    isFallbackAllowed: false,
  });
  const binaries = [...commandsToRun.values()].flatMap((command) =>
    command?.sha256 === undefined ? [] : [command.path],
  );
  io.stdout.write(
    `Trusted for this manifest: ${[...projectUses.map((u) => u.project), ...binaries].join(', ')}.\n`,
  );
  return ExitCode.ok;
};
