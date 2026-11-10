import { existsSync } from 'node:fs';
import { basename, resolve } from 'node:path';
import { dotenvService } from '../dotenv.ts';
import { CliError, ExitCode } from '../errors.ts';
import { fileService } from '../files.ts';
import { gitService } from '../git.ts';
import { manifestService } from '../manifest/manifest.ts';
import type { Manifest } from '../manifest/schema.ts';
import { format } from '../utils/format.ts';
import { commandService } from './context.ts';
import type { CommandHandler } from './context.ts';

// wrangler, Vite and Next.js expand $NAME in .env files and no quoting stops them, so a value
// with a $ can't go in one losslessly; wrangler reads .dev.vars as written
const assertNoExpansion = (file: string, values: Record<string, string>) => {
  if (!/^\.env(\.|$)/.test(basename(file))) return;
  const keys = Object.keys(values).filter((key) => values[key]?.includes('$'));
  if (keys.length === 0) return;
  const isOne = keys.length === 1;
  throw new CliError(
    ExitCode.failed,
    `${keys.join(', ')} ${isOne ? 'has' : 'have'} a $ in ${isOne ? 'its value' : 'their values'}, and ${file} is a .env file, where wrangler and other tools replace $NAME with a variable. Nothing was written. Pull to .dev.vars instead, which wrangler reads as written.`,
  );
};

// the env's own pull file, else .env.<env> beside storehouse.json
const getPullFile = (manifest: Manifest, env: string) =>
  manifest.envs[env]?.pull?.file ?? `.env.${env}`;

export const handlePull: CommandHandler = ({ io, loaded, line, secrets }) => {
  const { manifest, root } = loaded;
  const env = commandService.assertEnv(manifest, line.words[0] ?? '');
  const file = getPullFile(manifest, env);
  const path = resolve(root, file);
  const shownPath = fileService.formatPath(path, io.cwd);
  if (!line.isDryRun) {
    fileService.assertCanWrite({ path, cwd: io.cwd, isForced: line.isForced });
  }
  const fileState = gitService.getFileState(path);
  if (fileState.kind === 'tracked') {
    throw new CliError(
      ExitCode.failed,
      `${fileState.entry} is tracked by git, so a pull would put secrets in a commit. Untrack it with: git rm --cached ${fileState.entry}`,
    );
  }
  // git refusing to answer (a repo it won't read, say) stops a write over a file that exists, which
  // it might track; a new file goes ahead, with a word that it may not be ignored
  if (fileState.kind === 'error' && existsSync(path)) {
    throw new CliError(
      ExitCode.failed,
      `git couldn't say whether ${shownPath} is tracked (${fileState.said}), so storehouse won't write over it.`,
    );
  }
  if (fileState.kind === 'error') {
    io.stderr.write(
      `git couldn't say whether ${shownPath} is ignored (${fileState.said}), so check it yourself before you commit.\n`,
    );
  }
  const keys = manifestService.envs
    .getSecretKeys(manifest, env)
    .filter((key) => manifest.secrets[key]?.pull !== false);

  return async () => {
    const { setKeys, requiredMissing, optionalMissing, values } =
      await commandService.getSecretsForEnv({
        secrets,
        manifest,
        env,
        keys,
        hasValues: !line.isDryRun,
      });
    const leftOutNote =
      optionalMissing.length > 0
        ? [`Not set in ${env}, so left out: ${optionalMissing.join(', ')}.`]
        : [];

    if (line.isDryRun) {
      const isBlockedByFile = !line.isForced && existsSync(path);
      const report = [
        `Would write ${format.plural(setKeys.length, 'secret')} from ${env} to ${shownPath}:`,
        ...setKeys.map((key) => `  ${key}`),
        ...leftOutNote,
        ...(requiredMissing.length > 0
          ? [
              `Required and not set, so the pull would stop: ${requiredMissing.join(', ')}.`,
            ]
          : []),
        ...(isBlockedByFile
          ? [`${shownPath} already exists. Pass --force to overwrite it.`]
          : []),
        ...(fileState.kind === 'not-ignored'
          ? [
              `Would add ${gitService.getIgnoreEntry(path) ?? shownPath} to .gitignore.`,
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
        stopped: 'nothing was written',
        isNamed: false,
      });
    }
    assertNoExpansion(file, values);
    const dotenvText = dotenvService.format(values);
    const addedIgnore = gitService.ensureIgnored(path);
    fileService.writePrivate({
      path,
      data: dotenvText,
      cwd: io.cwd,
      isForced: line.isForced,
    });
    io.stdout.write(
      `${[
        ...(addedIgnore === undefined
          ? []
          : [`Added ${addedIgnore} to .gitignore.`]),
        `Wrote ${format.plural(Object.keys(values).length, 'secret')} from ${env} to ${shownPath}.`,
        ...leftOutNote,
      ].join('\n')}\n`,
    );
    return ExitCode.ok;
  };
};
