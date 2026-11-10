import { relative, resolve } from 'node:path';
import { CliError, ExitCode } from '../errors.ts';
import { gitService } from '../git.ts';
import { fileService } from '../files.ts';
import { commandService } from './context.ts';
import type { CommandHandler } from './context.ts';

export const handleGet: CommandHandler = ({ io, loaded, line, secrets }) => {
  const { manifest } = loaded;
  const env = commandService.assertEnv(manifest, line.words[0] ?? '');
  const key = commandService.assertKey(manifest, env, line.words[1] ?? '');
  const { project, name } = commandService.getSecretLocation(
    manifest,
    env,
    key,
  );
  const outPath =
    line.out === undefined ? undefined : resolve(io.cwd, line.out);
  if (
    outPath !== undefined &&
    !line.isForced &&
    gitService.isInternal(outPath, loaded.root)
  ) {
    throw new CliError(
      ExitCode.failed,
      `${line.out ?? outPath} is inside git's own directory. Pass --force to write there anyway.`,
    );
  }
  if (outPath !== undefined) {
    fileService.assertCanWrite({
      path: outPath,
      cwd: io.cwd,
      isForced: line.isForced,
    });
  }

  return async () => {
    const value = await secrets.getValue(project, name);
    if (value === undefined) {
      throw commandService.getNotSetError({ env, key, name });
    }
    if (outPath === undefined) {
      io.stdout.write(value);
      return ExitCode.ok;
    }
    fileService.writePrivate({
      path: outPath,
      data: value,
      cwd: io.cwd,
      isForced: line.isForced,
    });
    io.stderr.write(`Wrote ${key} (${env}) to ${relative(io.cwd, outPath)}.\n`);
    return ExitCode.ok;
  };
};
