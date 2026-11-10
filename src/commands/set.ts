import { CliError, ExitCode } from '../errors.ts';
import { protectedLabel } from '../secret-manager/secrets.ts';
import { commandService } from './context.ts';
import type { CommandHandler } from './context.ts';

// one trailing newline, from `echo` or the end of a paste, isn't part of the value
const removeTrailingNewline = (bytes: Uint8Array) =>
  bytes.at(-1) === 0x0a ? bytes.subarray(0, -1) : bytes;

export const handleSet: CommandHandler = ({
  io,
  loaded,
  line,
  secrets,
  protectedEnvs,
}) => {
  const { manifest } = loaded;
  const env = commandService.assertEnv(manifest, line.words[0] ?? '');
  const key = commandService.assertKey(manifest, env, line.words[1] ?? '');
  const { project, name } = commandService.getSecretLocation(
    manifest,
    env,
    key,
  );

  return async () => {
    // first, so a secret labelled protected asks before it asks for a value
    const existingLabels = await secrets.getLabels(project, name);
    const value = removeTrailingNewline(
      io.stdin.isTTY
        ? Buffer.from(
            await io.prompt(`Value for ${key} in ${env} (hidden): `, {
              isHidden: true,
            }),
            'utf8',
          )
        : await io.stdin.readAll(),
    );
    if (value.length === 0) {
      throw new CliError(
        ExitCode.failed,
        `The value for ${key} is empty, so nothing was stored.`,
      );
    }

    const latestVersion = await secrets.getLatestVersion(project, name);
    if (latestVersion?.state === 'ENABLED') {
      const existingValue = await secrets.getValue(project, name);
      if (existingValue && Buffer.from(value).equals(existingValue)) {
        io.stdout.write(
          `${key} in ${env} already has this value (${name}, version ${latestVersion.number}). Nothing changed.\n`,
        );
        return ExitCode.ok;
      }
    }
    const isProtected = protectedEnvs.has(env);
    if (existingLabels === undefined) {
      await secrets.create({
        project,
        secret: name,
        labels: {
          storehouse: 'true',
          env,
          ...(isProtected && { [protectedLabel]: 'true' }),
        },
      });
      io.stdout.write(`Created ${name} in ${project}.\n`);
    }
    // a secret made before its env was protected gets the label the first time it's set
    const isMissingLabel =
      existingLabels !== undefined &&
      isProtected &&
      existingLabels[protectedLabel] !== 'true';
    if (isMissingLabel) {
      await secrets.updateLabels({
        project,
        secret: name,
        labels: { ...existingLabels, [protectedLabel]: 'true' },
      });
    }
    const createdVersion = await secrets.addVersion({
      project,
      secret: name,
      value,
    });
    io.stdout.write(
      `Set ${key} in ${env}: ${name}, version ${createdVersion.number}.\n`,
    );
    return ExitCode.ok;
  };
};
