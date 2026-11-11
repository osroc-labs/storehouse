import { basename } from 'node:path';
import { CliError, ExitCode, getUsageError } from '../errors.ts';
import { gitService } from '../git.ts';
import { manifestService } from '../manifest/manifest.ts';
import type { Manifest } from '../manifest/schema.ts';
import { pushTargetService } from '../push-targets/push-targets.ts';
import { cliService } from '../push-targets/run-cli.ts';
import { trustService } from '../trust.ts';
import type { CommandToRun } from '../trust.ts';
import { format } from '../utils/format.ts';
import { commandService } from './context.ts';
import type { CommandHandler } from './context.ts';

const getKeysToPush = ({
  manifest,
  env,
  namedKeys,
}: {
  manifest: Manifest;
  env: string;
  namedKeys: readonly string[];
}) => {
  if (namedKeys.length === 0) {
    return manifestService.envs
      .getSecretKeys(manifest, env)
      .filter((key) => manifest.secrets[key]?.push !== false);
  }
  return [...new Set(namedKeys)].map((key) => {
    commandService.assertKey(manifest, env, key);
    if (manifest.secrets[key]?.push !== false) return key;
    throw getUsageError(
      `${key} has "push": false in storehouse.json, so it's never pushed.`,
    );
  });
};

export const handlePush: CommandHandler = ({ io, loaded, line, secrets }) => {
  const { manifest, root } = loaded;
  const env = commandService.assertEnv(manifest, line.words[0] ?? '');
  const targets = manifest.envs[env]?.push ?? [];
  if (targets.length === 0) {
    throw getUsageError(
      `${env} has nowhere to push. Add a target to envs.${env} in storehouse.json, such as "push": [{ "to": "cloudflare-workers", "dir": "." }].`,
    );
  }
  const namedKeys = line.words.slice(1);
  const keys = getKeysToPush({ manifest, env, namedKeys });
  const isNamed = namedKeys.length > 0;

  const plannedCommands = targets.flatMap((target) =>
    pushTargetService
      .getInvocations({ target, root, keys, values: {} })
      .map((invocation) => invocation.command),
  );
  const repoRoots = gitService.getRepoRoots(loaded.path);
  const findOnPath = (name: string) =>
    cliService.findOnPath({ name, env: io.env, repoRoots });
  // which file --dry-run says a planned command would run, and whether it still needs trust
  const formatDrySource = (command: string) => {
    const name = basename(command);
    const onPath = findOnPath(name);
    const isPlannedLocal = cliService.isRepoLocal(command);
    const repoPath = isPlannedLocal ? command : onPath.inRepo;
    if (repoPath === undefined || (!isPlannedLocal && onPath.outside)) {
      return cliService.formatSource(name, onPath.outside);
    }
    const isTrusted = trustService.isBinaryTrusted({
      env: io.env,
      manifestPath: loaded.path,
      path: repoPath,
    });
    return `${cliService.formatSource(name, trustService.getBinaryIdentity(repoPath).path)}${isTrusted ? '' : " (the repo's own, not trusted yet: push asks you first, and without a terminal uses one outside the repo)"}`;
  };

  return async () => {
    // before any value is read, so an untrusted CLI never comes near one
    const commands = line.isDryRun
      ? new Map<string, CommandToRun>()
      : await trustService.getCommandsToRun({
          io,
          manifestPath: loaded.path,
          commands: plannedCommands,
          findOnPath,
          isTrustCommand: false,
        });
    const secretsForEnv = await commandService.getSecretsForEnv({
      secrets,
      manifest,
      env,
      keys,
      hasValues: !line.isDryRun,
    });
    const { setKeys, values } = secretsForEnv;
    // a key named on the command line is one the person expects to go, so a missing one stops it
    const requiredMissing = isNamed
      ? [...secretsForEnv.requiredMissing, ...secretsForEnv.optionalMissing]
      : secretsForEnv.requiredMissing;
    const optionalMissing = isNamed ? [] : secretsForEnv.optionalMissing;
    const skippedNote =
      optionalMissing.length > 0
        ? [`Not set in ${env}, so skipped: ${optionalMissing.join(', ')}.`]
        : [];

    if (line.isDryRun) {
      const report = [
        ...targets.flatMap((target) => [
          `Would send ${format.plural(setKeys.length, 'secret')} from ${env} to ${pushTargetService.format(target)}:`,
          ...setKeys.map((key) => `  ${key}`),
          ...pushTargetService
            .getInvocations({ target, root, keys: setKeys, values: {} })
            .flatMap((invocation) => [
              `  ${formatDrySource(invocation.command)}`,
              `  $ ${cliService.format(invocation)}`,
            ]),
        ]),
        ...skippedNote,
        ...(requiredMissing.length > 0
          ? [
              `Required and not set, so the push would stop before sending anything: ${requiredMissing.join(', ')}.`,
            ]
          : []),
      ];
      io.stdout.write(`${report.join('\n')}\n`);
      return requiredMissing.length > 0 ? ExitCode.missing : ExitCode.ok;
    }

    if (requiredMissing.length > 0) {
      throw commandService.getMissingSecretsError({
        env,
        keys: requiredMissing,
        stopped: 'nothing was sent',
        isNamed,
      });
    }
    if (setKeys.length === 0) {
      throw new CliError(
        ExitCode.failed,
        `None of ${env}'s secrets are set, so there's nothing to push.`,
      );
    }
    // every invocation first, so a value a target can't take stops the push before anything is sent
    const plannedTargets = targets.map((target) => ({
      label: pushTargetService.format(target),
      invocations: pushTargetService.getInvocations({
        target,
        root,
        keys: setKeys,
        values,
      }),
    }));
    const alreadySent: string[] = [];
    // in order, so a failure says exactly what already went where
    for (const { label, invocations } of plannedTargets) {
      const sentKeys: string[] = [];
      try {
        for (const planned of invocations) {
          const name = basename(planned.command);
          const command = commands.get(planned.command);
          if (command === undefined) {
            throw new CliError(
              ExitCode.failed,
              `${name} isn't installed in ${planned.cwd} or on your PATH. ${planned.installHint}`,
            );
          }
          trustService.assertUnchanged(command);
          io.stderr.write(`${cliService.formatSource(name, command.path)}\n`);
          await cliService.run(
            { ...planned, command: command.path, argv0: name },
            io,
          );
          sentKeys.push(...planned.keys);
        }
      } catch (error) {
        const sentSoFar = [
          ...alreadySent,
          ...(sentKeys.length > 0 ? [`${label}: ${sentKeys.join(', ')}`] : []),
        ];
        if (sentSoFar.length === 0 || !(error instanceof Error)) throw error;
        throw new CliError(
          ExitCode.failed,
          `${error.message}\nAlready sent before it failed: ${sentSoFar.join('; ')}.`,
          { cause: error },
        );
      }
      alreadySent.push(`${label}: ${sentKeys.join(', ')}`);
      io.stdout.write(
        `Sent ${format.plural(setKeys.length, 'secret')} from ${env} to ${label}: ${setKeys.join(', ')}.\n`,
      );
    }
    if (skippedNote.length > 0) io.stdout.write(`${skippedNote.join('\n')}\n`);
    return ExitCode.ok;
  };
};
