import { spawn } from 'node:child_process';
import {
  accessSync,
  constants,
  existsSync,
  readdirSync,
  realpathSync,
  statSync,
} from 'node:fs';
import {
  basename,
  delimiter,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve as resolvePath,
  sep,
} from 'node:path';
import { getFailedError } from '../errors.ts';
import { gitService } from '../git.ts';
import { pathService } from '../utils/paths.ts';
import type { Io } from '../terminal/io.ts';

// One run of a platform's CLI. Values only ever go in `input` (stdin), never in `args`.
export type CliInvocation = {
  command: string;
  args: string[];
  cwd: string;
  // the secrets this run sends, so a failure can say which already went
  keys: readonly string[];
  input: string;
  // what stdin holds, for --dry-run
  inputLabel: string;
  // text the CLI prints only once it has really sent the values, when its exit code can't be trusted
  successText?: string;
  // what to do when the CLI isn't installed, and when it fails (most often: not logged in)
  installHint: string;
  failureHint: string;
  // the name the CLI is run under, when command is the real path it resolved to
  argv0?: string;
};

// A repo-local CLI is a candidate only when it's really an installed one: named exactly so in a
// node_modules/.bin, its real file inside node_modules under the manifest's directory, and git sure
// it tracks neither. Even then, push runs it only once a person trusts it (trust.ts).
const isInstalledCli = ({
  path,
  name,
  root,
}: {
  path: string;
  name: string;
  root: string;
}) => {
  if (!existsSync(path)) return false;
  const binDir = realpathSync.native(dirname(path));
  const isBinDir =
    basename(binDir) === '.bin' && basename(dirname(binDir)) === 'node_modules';
  if (!isBinDir || !readdirSync(binDir).includes(name)) return false;
  const realPath = realpathSync.native(path);
  const realRoot = realpathSync.native(root);
  return (
    pathService.isInside(realRoot, realPath) &&
    relative(realRoot, realPath).split(sep).includes('node_modules') &&
    gitService.isSurelyUntracked(join(binDir, name), realRoot) &&
    gitService.isSurelyUntracked(realPath, realRoot)
  );
};

// an installed CLI in the project's node_modules, else the repo's, else the name for the PATH
const getCliPath = ({
  name,
  root,
  dir,
}: {
  name: string;
  root: string;
  dir: string;
}) =>
  [
    resolvePath(root, dir, 'node_modules', '.bin', name),
    join(root, 'node_modules', '.bin', name),
  ].find((path) => isInstalledCli({ path, name, root })) ?? name;

// whether the command is a repo-local CLI rather than a name looked up on the PATH
const isRepoLocal = (command: string) => command.includes(sep);

const isExecutableFile = (path: string) => {
  try {
    accessSync(path, constants.X_OK);
    return statSync(path).isFile();
  } catch {
    return false;
  }
};

// A node_modules/.bin anywhere is a project's, not a global install: npm and pnpm put every
// ancestor's on the PATH, and git may not be there to say which repo it belongs to.
const isInPackageBin = (path: string) => {
  const parts = path.split(sep).map((part) => part.toLowerCase());
  return parts.some(
    (part, i) => part === 'node_modules' && parts[i + 1] === '.bin',
  );
};

// What a name finds on the PATH, as absolute real paths: the first match outside the repo, and the
// first inside it, which needs trust. A relative or empty entry is skipped: it would mean something
// else in each directory a CLI runs in.
const findOnPath = ({
  name,
  env,
  repoRoots,
}: {
  name: string;
  env: Io['env'];
  repoRoots: readonly string[];
}) => {
  let inRepo: string | undefined;
  for (const dir of (env.PATH ?? '').split(delimiter)) {
    const candidate = join(dir, name);
    if (!isAbsolute(dir) || !isExecutableFile(candidate)) continue;
    const realPath = realpathSync.native(candidate);
    const isInRepo = [realPath, pathService.getReal(dir)].some(
      (path) =>
        isInPackageBin(path) ||
        repoRoots.some((root) => pathService.isInside(root, path)),
    );
    if (!isInRepo) return { outside: realPath, inRepo };
    inRepo ??= candidate;
  }
  return { inRepo };
};

// "using wrangler at /opt/homebrew/bin/wrangler": exactly the file that gets the values
const formatSource = (name: string, path: string | undefined) =>
  path === undefined
    ? `using ${name}: not installed`
    : `using ${name} at ${path}`;

// a word as a shell would need it to read back as one word
const formatShellWord = (word: string) =>
  /^[\w@%+=:,./-]+$/.test(word) ? word : `'${word.replaceAll("'", "'\\''")}'`;

const formatInvocation = (invocation: CliInvocation) => {
  const shownCommand = isRepoLocal(invocation.command)
    ? relative(invocation.cwd, invocation.command)
    : invocation.command;
  return `${[shownCommand, ...invocation.args].map(formatShellWord).join(' ')} < (${invocation.inputLabel})`;
};

const getDisplayName = (invocation: CliInvocation) =>
  [invocation.command.split('/').at(-1), ...invocation.args].join(' ');

// Runs it with its output shown on stderr, and fails unless it exits 0 (and says successText).
const runCli = (invocation: CliInvocation, io: Io) =>
  new Promise<void>((resolve, reject) => {
    const { command, args, cwd, input, successText, installHint } = invocation;
    // the absolute path, named as the CLI expects to be, so a shim that reads argv[0] still works
    const child = spawn(command, args, {
      cwd,
      env: io.env,
      argv0: invocation.argv0 ?? basename(command),
    });
    let output = '';
    const relayOutput = (data: Buffer) => {
      const text = data.toString('utf8');
      output += text;
      (io.stderr.writeRelayed ?? io.stderr.write)(text);
    };
    child.stdout.on('data', relayOutput);
    child.stderr.on('data', relayOutput);
    child.on('error', (error) => {
      const isMissing = 'code' in error && error.code === 'ENOENT';
      reject(
        isMissing
          ? getFailedError(
              `${command.split('/').at(-1) ?? command} isn't installed in ${cwd} or on your PATH. ${installHint}`,
              { cause: error },
            )
          : getFailedError(`Couldn't run ${command}: ${error.message}`, {
              cause: error,
            }),
      );
    });
    child.on('close', (code) => {
      if (code !== 0) {
        reject(
          getFailedError(
            `\`${getDisplayName(invocation)}\` failed in ${cwd} (exit ${code ?? 'signal'}). Its output is above. ${invocation.failureHint}`,
          ),
        );
        return;
      }
      if (successText !== undefined && !output.includes(successText)) {
        reject(
          getFailedError(
            `\`${getDisplayName(invocation)}\` in ${cwd} exited without saying it sent the values ("${successText}"), so they may not have been sent. Its output is above.`,
          ),
        );
        return;
      }
      resolve();
    });
    child.stdin.on('error', () => {
      // a CLI that exits before reading stdin reports its own failure through `close`
    });
    child.stdin.end(input);
  });

export const cliService = {
  getPath: getCliPath,
  isRepoLocal,
  findOnPath,
  format: formatInvocation,
  formatSource,
  run: runCli,
};
