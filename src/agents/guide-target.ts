import { randomUUID } from 'node:crypto';
import {
  chmodSync,
  lstatSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import type { Stats } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { CliError, getErrorMessage, getFailedError } from '../errors.ts';
import { gitService } from '../git.ts';
import { pathService } from '../utils/paths.ts';

// The file the guide goes in, read and written with care: it comes from a repo anyone can commit
// to, so a symlink, a FIFO, a huge file or another tool's edit can't turn a write into damage.

export const maxGuideFileBytes = 1024 * 1024;

const hasErrorCode = (error: unknown, code: string) =>
  error instanceof Error && 'code' in error && error.code === code;

const getLinkStats = (path: string): Stats | undefined => {
  try {
    return lstatSync(path);
  } catch (error) {
    if (hasErrorCode(error, 'ENOENT')) return undefined;
    throw getFailedError(`Couldn't read ${path}: ${getErrorMessage(error)}`, {
      cause: error,
    });
  }
};

// a path's real location: its own when it exists, else its directory's plus its name
const getRealLocation = (path: string, shownPath: string) => {
  try {
    return join(realpathSync.native(dirname(path)), basename(path));
  } catch (error) {
    throw getFailedError(`There's no directory for ${shownPath}.`, {
      cause: error,
    });
  }
};

// Where the guide is written, following a symlink only to a regular file inside the repo. A path
// the person named (--file) may be outside it, with a notice; a link out of the repo needs --force.
const getGuideLocation = ({
  path,
  shownPath,
  repoRoot,
  isNamed,
  isForced,
}: {
  path: string;
  shownPath: string;
  repoRoot: string;
  isNamed: boolean;
  isForced: boolean;
}) => {
  const linkStats = getLinkStats(path);
  const namedLocation = getRealLocation(path, shownPath);
  const isNamedInside = pathService.isInside(repoRoot, namedLocation);
  if (linkStats === undefined || !linkStats.isSymbolicLink()) {
    if (linkStats !== undefined && !linkStats.isFile()) {
      throw getFailedError(
        `${shownPath} isn't a regular file, so storehouse won't write the guide in it. Name another with --file.`,
      );
    }
    if (!isNamedInside && !isNamed) {
      throw getFailedError(
        `${shownPath} is outside the repo (${repoRoot}), so storehouse won't write the guide there.`,
      );
    }
    return {
      path,
      notice: isNamedInside
        ? undefined
        : `${shownPath} is outside the repo (${repoRoot}).`,
    };
  }
  let linkedPath: string;
  try {
    linkedPath = realpathSync.native(path);
  } catch {
    throw getFailedError(
      `${shownPath} is a symlink to a file that doesn't exist, so storehouse won't write through it. Name a real file with --file.`,
    );
  }
  if (!statSync(linkedPath).isFile()) {
    throw getFailedError(
      `${shownPath} is a symlink to ${linkedPath}, which isn't a regular file, so storehouse won't write through it.`,
    );
  }
  if (pathService.isInside(repoRoot, linkedPath)) return { path: linkedPath };
  if (!isNamed || !isForced) {
    throw getFailedError(
      `${shownPath} is a symlink to ${linkedPath}, outside the repo, so storehouse won't write through it.${isNamed ? ' Pass --force to write there.' : ' Name a file in the repo with --file.'}`,
    );
  }
  return {
    path: linkedPath,
    notice: `${shownPath} leads to ${linkedPath}, outside the repo.`,
  };
};

// The location, refused in git's own directory, or over the manifest or a .gitignore, where the
// guide would break the repo.
const getGuideTarget = ({
  manifestPath,
  ...args
}: Parameters<typeof getGuideLocation>[0] & { manifestPath: string }) => {
  const target = getGuideLocation(args);
  if (gitService.isInternal(target.path, dirname(manifestPath))) {
    throw getFailedError(
      `${args.shownPath} leads into git's own directory, so storehouse won't write the guide there.`,
    );
  }
  const realTarget = pathService.getReal(target.path);
  const isOverOwnFile =
    pathService.isSame(realTarget, pathService.getReal(manifestPath)) ||
    pathService.isNamed(realTarget, '.gitignore');
  if (isOverOwnFile) {
    throw getFailedError(
      `${args.shownPath} leads to storehouse.json or a .gitignore, so storehouse won't write the guide there.`,
    );
  }
  return target;
};

const decoder = new TextDecoder('utf-8', { fatal: true });

// The file's bytes and its text, or undefined when it doesn't exist. Refuses a file that isn't
// plain UTF-8 under the cap, since rewriting it would change bytes outside the guide.
const readGuideFile = (path: string, shownPath: string) => {
  const stats = getLinkStats(path);
  if (stats === undefined) return undefined;
  if (!stats.isFile()) {
    throw getFailedError(`${shownPath} isn't a regular file.`);
  }
  if (stats.size > maxGuideFileBytes) {
    throw getFailedError(
      `${shownPath} is over 1 MB, so storehouse won't rewrite it.`,
    );
  }
  const bytes = readFileSync(path);
  try {
    return { bytes, text: decoder.decode(bytes), mode: stats.mode & 0o7777 };
  } catch {
    throw getFailedError(
      `${shownPath} isn't UTF-8 text, so storehouse won't rewrite it.`,
    );
  }
};

type GuideFile = ReturnType<typeof readGuideFile>;

const getChangedError = (shownPath: string) =>
  getFailedError(`${shownPath} changed while this ran. Run it again.`);

// A new file is created only if it's still missing; an existing one is replaced by a temp file with
// its mode, after checking nobody changed it since it was read.
const writeGuideFile = ({
  path,
  shownPath,
  existing,
  text,
}: {
  path: string;
  shownPath: string;
  existing: GuideFile;
  text: string;
}) => {
  if (existing === undefined) {
    try {
      writeFileSync(path, text, { flag: 'wx' });
    } catch (error) {
      if (hasErrorCode(error, 'EEXIST')) throw getChangedError(shownPath);
      throw getFailedError(
        `Couldn't write ${shownPath}: ${getErrorMessage(error)}`,
        { cause: error },
      );
    }
    return;
  }
  const tempPath = join(
    dirname(path),
    `.${basename(path)}.${randomUUID()}.tmp`,
  );
  try {
    writeFileSync(tempPath, text, { flag: 'wx', mode: existing.mode });
    chmodSync(tempPath, existing.mode);
    if (!readFileSync(path).equals(existing.bytes)) {
      throw getChangedError(shownPath);
    }
    renameSync(tempPath, path);
  } catch (error) {
    rmSync(tempPath, { force: true });
    if (error instanceof CliError) throw error;
    throw getFailedError(
      `Couldn't write ${shownPath}: ${getErrorMessage(error)}`,
      { cause: error },
    );
  }
};

export const guideTargetService = {
  get: getGuideTarget,
  read: readGuideFile,
  write: writeGuideFile,
};
