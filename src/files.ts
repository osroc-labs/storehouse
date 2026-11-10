import { randomUUID } from 'node:crypto';
import { existsSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, relative } from 'node:path';
import { CliError, ExitCode, getErrorMessage } from './errors.ts';

const formatPath = (path: string, cwd: string) => relative(cwd, path) || path;

const getExistsError = (path: string, cwd: string) =>
  new CliError(
    ExitCode.failed,
    `${formatPath(path, cwd)} already exists. Pass --force to overwrite it.`,
  );

const getWriteError = (path: string, cwd: string, error: unknown) =>
  new CliError(
    ExitCode.failed,
    `Couldn't write ${formatPath(path, cwd)}: ${getErrorMessage(error)}`,
    { cause: error },
  );

const hasErrorCode = (error: unknown, code: string) =>
  error instanceof Error && 'code' in error && error.code === code;

// a quick check before any Google request; writePrivateFile checks again as it creates the file
const assertCanWrite = ({
  path,
  cwd,
  isForced,
}: {
  path: string;
  cwd: string;
  isForced: boolean;
}) => {
  if (!isForced && existsSync(path)) throw getExistsError(path, cwd);
};

// Owner-only (0600) from the moment it exists. Without --force the create is the check; with it, a
// new file is renamed over the old one, so a value never sits in a file with the old mode.
const writePrivateFile = ({
  path,
  data,
  cwd,
  isForced,
}: {
  path: string;
  data: string | Uint8Array;
  cwd: string;
  isForced: boolean;
}) => {
  if (!isForced) {
    try {
      writeFileSync(path, data, { flag: 'wx', mode: 0o600 });
    } catch (error) {
      throw hasErrorCode(error, 'EEXIST')
        ? getExistsError(path, cwd)
        : getWriteError(path, cwd, error);
    }
    return;
  }
  const tempPath = join(
    dirname(path),
    `.${basename(path)}.${randomUUID()}.tmp`,
  );
  try {
    writeFileSync(tempPath, data, { flag: 'wx', mode: 0o600 });
    renameSync(tempPath, path);
  } catch (error) {
    rmSync(tempPath, { force: true });
    throw getWriteError(path, cwd, error);
  }
};

export const fileService = {
  assertCanWrite,
  writePrivate: writePrivateFile,
  formatPath,
};
