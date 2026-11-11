import { execFileSync } from 'node:child_process';
import {
  appendFileSync,
  existsSync,
  lstatSync,
  readFileSync,
  realpathSync,
} from 'node:fs';
import { basename, dirname, join, relative, resolve, sep } from 'node:path';
import { CliError, ExitCode, getErrorMessage } from './errors.ts';
import { pathService } from './utils/paths.ts';

const getFailedError = (message: string) =>
  new CliError(ExitCode.failed, message);

// GIT_DIR and its kin can point git at another repo or none, so git runs without them and sees
// the repo on disk as it is
const getGitEnv = () =>
  Object.fromEntries(
    Object.entries(process.env).filter(([name]) => !name.startsWith('GIT_')),
  );

const runGit = (cwd: string, args: string[]) => {
  try {
    return {
      isOk: true,
      out: execFileSync('git', args, {
        cwd,
        env: getGitEnv(),
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      }).trim(),
      status: 0,
      said: '',
    };
  } catch (error) {
    const status =
      error instanceof Error && 'status' in error ? error.status : undefined;
    const stderr =
      error instanceof Error && 'stderr' in error ? String(error.stderr) : '';
    return {
      isOk: false,
      out: '',
      status,
      said: stderr.trim() || getErrorMessage(error),
    };
  }
};

// The nearest directory of path's that exists, and path's directory through any symlinks
// (/var is /private/var on a Mac), since git names the repo root that way.
const getRealDirectory = (path: string) => {
  let dir = dirname(path);
  while (!existsSync(dir) && dirname(dir) !== dir) dir = dirname(dir);
  return {
    existing: dir,
    real: join(realpathSync.native(dir), relative(dir, dirname(path))),
  };
};

// The repo a path is in: its root, none (outside a repo, or no git), or git's own error, such as
// a repo git refuses to read (safe.directory).
const getRepoAt = (dir: string) => {
  const found = runGit(dir, ['rev-parse', '--show-toplevel']);
  if (found.isOk && found.out) {
    return { kind: 'repo', root: realpathSync.native(found.out) } as const;
  }
  const isOutside =
    found.status === undefined || /not a git repository/i.test(found.said);
  return isOutside
    ? ({ kind: 'none' } as const)
    : ({ kind: 'error', said: found.said } as const);
};

const getRepo = (path: string) => getRepoAt(getRealDirectory(path).existing);

// the repo root a path is in, or undefined outside a git repo (or without git)
const getRepoRoot = (path: string) => {
  const repo = getRepo(path);
  return repo.kind === 'repo' ? repo.root : undefined;
};

// the path relative to the repo root, as a .gitignore line, or undefined outside a repo
const getIgnoreEntry = (path: string) => {
  const root = getRepoRoot(path);
  if (root === undefined) return undefined;
  return relative(root, join(getRealDirectory(path).real, basename(path)))
    .split(sep)
    .join('/');
};

// How git sees a file storehouse is about to write a value into. A tracked file can't be
// ignored, so a pull into one would put values in the next commit.
const getFileState = (path: string) => {
  const repo = getRepo(path);
  if (repo.kind !== 'repo') return repo;
  const entry = getIgnoreEntry(path) ?? basename(path);
  // on a disk that ignores case, git's own view is the one that ignores it too
  const tracked = runGit(repo.root, [
    '-c',
    `core.ignorecase=${pathService.isCaseInsensitive}`,
    'ls-files',
    '--',
    `:(${pathService.isCaseInsensitive ? 'icase,' : ''}literal)${entry}`,
  ]);
  if (tracked.isOk && tracked.out !== '') {
    return { kind: 'tracked', entry } as const;
  }
  const ignored = runGit(repo.root, ['check-ignore', '-q', '--', entry]);
  if (ignored.isOk) return { kind: 'ignored', entry } as const;
  if (ignored.status === 1) {
    return { kind: 'not-ignored', entry, root: repo.root } as const;
  }
  return { kind: 'error', said: ignored.said } as const;
};

// true or false, or undefined outside a repo or when git can't say
const isIgnoredByGit = (path: string) => {
  const state = getFileState(path);
  if (state.kind === 'ignored') return true;
  if (state.kind === 'not-ignored') return false;
  return undefined;
};

// An ignore line that names exactly one path: plain characters, no `..`, nothing git reads as a
// rule (`!`, `#`) or as another line.
const isPlainIgnoreEntry = (entry: string) =>
  /^[A-Za-z0-9._/-]+$/.test(entry) &&
  !entry.split('/').includes('..') &&
  !entry.startsWith('/');

const isSymlink = (path: string) => {
  try {
    return lstatSync(path).isSymbolicLink();
  } catch {
    return false;
  }
};

// .gitignore may only be written when it's a plain file (or absent): a committed symlink could
// point the append at .git/config or anywhere else
const isWritableGitignore = (gitignorePath: string) => {
  if (!existsSync(gitignorePath) && !isSymlink(gitignorePath)) return true;
  return lstatSync(gitignorePath).isFile();
};

// Adds path to the repo root's .gitignore unless git already ignores it. Returns the line it
// added, or undefined when it added none.
const ensureIgnored = (path: string) => {
  const state = getFileState(path);
  if (state.kind !== 'not-ignored') return undefined;
  const gitignorePath = join(state.root, '.gitignore');
  if (!isPlainIgnoreEntry(state.entry) || !isWritableGitignore(gitignorePath)) {
    throw getFailedError(
      `storehouse won't add ${JSON.stringify(state.entry)} to ${gitignorePath} itself (the path isn't plain, or .gitignore isn't a plain file). Make git ignore it yourself, then run this again.`,
    );
  }
  const existingIgnores = existsSync(gitignorePath)
    ? readFileSync(gitignorePath, 'utf8')
    : '';
  const lead =
    existingIgnores === '' || existingIgnores.endsWith('\n') ? '' : '\n';
  appendFileSync(gitignorePath, `${lead}${state.entry}\n`);
  return state.entry;
};

// what a file at path in the commit at HEAD holds, or undefined (no repo, no commit, no file)
const getCommittedText = (path: string) => {
  const root = getRepoRoot(path);
  const entry = getIgnoreEntry(path);
  if (root === undefined || entry === undefined) return undefined;
  const shown = runGit(root, ['show', `HEAD:${entry}`]);
  return shown.isOk ? shown.out : undefined;
};

// The committed copy of the nearest file called fileName from dir up to the repo root, or
// undefined. A new, uncommitted manifest nearer the working directory doesn't hide it.
const getNearestCommittedText = (dir: string, fileName: string) => {
  const root = getRepoRoot(join(dir, fileName));
  if (root === undefined) return undefined;
  const realDir = realpathSync.native(dir);
  for (let current = realDir; ; current = dirname(current)) {
    const entry = relative(root, join(current, fileName)).split(sep).join('/');
    if (entry.startsWith('..')) return undefined;
    const shown = runGit(root, ['show', `HEAD:${entry}`]);
    if (shown.isOk) return shown.out;
    if (current === root || dirname(current) === current) return undefined;
  }
};

// whether git tracks the file at path (false outside a repo)
const isTrackedByGit = (path: string) => getFileState(path).kind === 'tracked';

// Whether git is sure it tracks nothing at path, in any letter case, asked from the repo root so
// a directory the repo dressed up as a git repo can't answer. A git error counts as tracked.
const isSurelyUntracked = (path: string, root: string) => {
  const repo = getRepoAt(root);
  if (repo.kind === 'none') return true;
  if (repo.kind === 'error') return false;
  const entry = relative(repo.root, path).split(sep).join('/');
  if (entry.startsWith('..')) return false;
  const listed = runGit(repo.root, [
    '-c',
    'core.ignorecase=true',
    'ls-files',
    '--',
    `:(icase,literal)${entry}`,
  ]);
  return listed.isOk && listed.out === '';
};

// The git directories of the repo at root: its git dir (wherever --separate-git-dir put it) and,
// for a worktree, the shared one. Asked from root, since git won't answer from inside its own.
const getGitDirectories = (root: string) => {
  const repo = getRepoAt(root);
  if (repo.kind !== 'repo') return [];
  const found = runGit(repo.root, [
    'rev-parse',
    '--absolute-git-dir',
    '--git-common-dir',
  ]);
  if (!found.isOk) return [];
  return found.out
    .split('\n')
    .filter(Boolean)
    .map((dir) => pathService.getReal(resolve(repo.root, dir)));
};

// The repo a real path is in, as every worktree of it shares it: git's common dir, the worktree
// root the path is under, and each worktree git has registered. Undefined outside a repo, or for
// a worktree git didn't register, as a planted `.git` file pointing into another repo would be.
const getSharedRepo = (realPath: string) => {
  const repo = getRepo(realPath);
  if (repo.kind !== 'repo') return undefined;
  const commonDir = runGit(repo.root, ['rev-parse', '--git-common-dir']);
  // without -z, which needs git 2.36; a path with a line break in it just doesn't match
  const listed = runGit(repo.root, ['worktree', 'list', '--porcelain']);
  if (!commonDir.isOk || commonDir.out === '' || !listed.isOk) return undefined;
  const worktrees = listed.out
    .split('\n')
    .filter((line) => line.startsWith('worktree '))
    .map((line) => pathService.getReal(line.slice('worktree '.length)));
  if (!worktrees.some((worktree) => pathService.isSame(worktree, repo.root))) {
    return undefined;
  }
  return {
    commonDir: pathService.getReal(resolve(repo.root, commonDir.out)),
    root: repo.root,
    worktrees,
  };
};

type SharedRepo = ReturnType<typeof getSharedRepo>;

// The real directories that count as the manifest's repo: its worktree root, the manifest's own
// directory, and the git dir and every worktree of a repo git ties together.
const getRepoRoots = (
  manifestPath: string,
  sharedRepo: SharedRepo = getSharedRepo(realpathSync.native(manifestPath)),
) =>
  [
    getRepoRoot(manifestPath),
    dirname(manifestPath),
    ...(sharedRepo === undefined
      ? []
      : [sharedRepo.commonDir, ...sharedRepo.worktrees]),
  ]
    .filter((root) => root !== undefined)
    .map(pathService.getReal);

// Whether path is git's own: a `.git` part in any letter case, or inside the git dir of the repo
// at root. A value written there could break or reconfigure the repo.
const isGitInternal = (path: string, root: string) => {
  const realPath = pathService.getReal(path);
  const hasGitPart = [path, realPath].some((p) =>
    p.split(sep).some((part) => part.toLowerCase() === '.git'),
  );
  return (
    hasGitPart ||
    getGitDirectories(root).some((dir) => pathService.isInside(dir, realPath))
  );
};

export const gitService = {
  isTracked: isTrackedByGit,
  isSurelyUntracked,
  isInternal: isGitInternal,
  getRepoRoot,
  getSharedRepo,
  getRepoRoots,
  getFileState,
  getCommittedText,
  getNearestCommittedText,
  ensureIgnored,
  isIgnored: isIgnoredByGit,
  getIgnoreEntry,
};
