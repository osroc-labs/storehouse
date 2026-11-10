import { CliError, ExitCode } from '../errors.ts';
import { manifestService } from '../manifest/manifest.ts';
import { protectedLabel } from '../secret-manager/secrets.ts';
import { format } from '../utils/format.ts';
import { commandService } from './context.ts';
import type { CommandHandler } from './context.ts';

// Labels storehouse-protected=true each of the manifest's secrets in a protected env that exists in
// Google, the layer no manifest edit can lift. Only a person at a terminal runs it.
export const handleProtect: CommandHandler = ({
  io,
  loaded,
  line,
  secrets,
  protectedEnvs,
}) => {
  const { manifest } = loaded;
  const env = commandService.assertEnv(manifest, line.words[0] ?? '');
  if (!protectedEnvs.has(env)) {
    throw new CliError(
      ExitCode.usage,
      `${env} isn't protected. Add "protected": true to envs.${env} in storehouse.json first, so the labels match it.`,
    );
  }
  const keys = manifestService.envs.getSecretKeys(manifest, env);

  return async () => {
    const labelledKeys: string[] = [];
    const alreadyLabelledKeys: string[] = [];
    const missingKeys: string[] = [];
    // Labels one secret if it needs it. One at a time: a write is never retried, so a failure
    // says exactly how far it got.
    const labelSecret = async (key: string) => {
      const { project, name } = commandService.getSecretLocation(
        manifest,
        env,
        key,
      );
      const labels = await secrets.getLabels(project, name);
      if (labels === undefined) {
        missingKeys.push(key);
        return;
      }
      if (labels[protectedLabel] === 'true') {
        alreadyLabelledKeys.push(key);
        return;
      }
      await secrets.updateLabels({
        project,
        secret: name,
        labels: { ...labels, [protectedLabel]: 'true' },
      });
      labelledKeys.push(key);
    };
    for (const key of keys) {
      try {
        await labelSecret(key);
      } catch (error) {
        if (labelledKeys.length === 0 || !(error instanceof Error)) throw error;
        throw new CliError(
          ExitCode.failed,
          `${error.message}\nAlready labelled in ${env}: ${labelledKeys.join(', ')}.`,
          { cause: error },
        );
      }
    }
    const lines = [
      labelledKeys.length > 0
        ? `Labelled ${format.plural(labelledKeys.length, 'secret')} in ${env} ${protectedLabel}=true: ${labelledKeys.join(', ')}.`
        : `No secret in ${env} needed the label.`,
      ...(alreadyLabelledKeys.length > 0
        ? [`Already labelled: ${alreadyLabelledKeys.join(', ')}.`]
        : []),
      ...(missingKeys.length > 0
        ? [
            `Not set yet, so not labelled (set labels them): ${missingKeys.join(', ')}.`,
          ]
        : []),
    ];
    io.stdout.write(`${lines.join('\n')}\n`);
    return ExitCode.ok;
  };
};
