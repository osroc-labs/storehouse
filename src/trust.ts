import { createHash, randomUUID } from 'node:crypto';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from 'node:path';
import { z } from 'zod';
import { CliError, ExitCode } from './errors.ts';
import { gitService } from './git.ts';
import { manifestService } from './manifest/manifest.ts';
import type { Manifest } from './manifest/schema.ts';
import { getAgentMarker } from './protect/agents.ts';
import type { Io } from './terminal/io.ts';
import { pathService } from './utils/paths.ts';

// A cloned repo's manifest decides which Google Cloud project a typed or pushed value goes to,
// and may ship the CLI a push hands the values to. So a person trusts each project, and each
// repo-local CLI by its content, once per manifest, and once for every worktree of a git repo;
// the answers live only in their own config.

const trustedBinarySchema = z.object({ path: z.string(), sha256: z.string() });

// what a person trusted, by manifest: the projects it sends values to, and the repo-local CLIs a
// push may hand them to
const trustListSchema = z.object({
  manifests: z.record(z.string(), z.array(z.string())),
  binaries: z.record(z.string(), z.array(trustedBinarySchema)).default({}),
});

// A manifest in a git repo is trusted under `repos`, by the git dir every worktree of the repo
// shares, then by its path in the worktree. The top level holds a manifest outside git, by its
// real path, and what was trusted that way for any manifest before.
const trustFileSchema = trustListSchema.extend({
  repos: z.record(z.string(), trustListSchema).default({}),
});

type TrustFile = z.infer<typeof trustFileSchema>;
type TrustList = z.infer<typeof trustListSchema>;
type TrustedBinary = z.infer<typeof trustedBinarySchema>;

const emptyTrustFile = (): TrustFile => ({
  manifests: {},
  binaries: {},
  repos: {},
});

type ProjectUse = { project: string; envs: string[]; names: string[] };

// Where a manifest's trust is kept: its real path, and the repo it's in when git has registered
// its worktree, with its path there.
const getTrustPlace = (manifestPath: string) => {
  const realPath = realpathSync.native(manifestPath);
  const repo = gitService.getSharedRepo(realPath);
  return {
    realPath,
    roots: gitService.getRepoRoots(manifestPath, repo),
    repo: repo && {
      ...repo,
      entry: relative(repo.root, realPath).split(sep).join('/'),
    },
  };
};

type TrustPlace = ReturnType<typeof getTrustPlace>;

// The person's trust file, refused when it would sit inside the repo the manifest is in, any
// worktree of it, or its git dir: a repo (or a relative XDG_CONFIG_HOME) mustn't be able to
// supply its own answers.
const getTrustFilePath = (env: Io['env'], place: TrustPlace) => {
  const path = join(
    env.XDG_CONFIG_HOME || join(env.HOME ?? homedir(), '.config'),
    'storehouse',
    'trusted-projects.json',
  );
  const realPath = pathService.getReal(resolve(path));
  if (
    !isAbsolute(path) ||
    place.roots.some((root) => pathService.isInside(root, realPath))
  ) {
    throw new CliError(
      ExitCode.failed,
      `The trust file ${path} would be inside the repo, so storehouse won't use it. Set XDG_CONFIG_HOME (or HOME) to an absolute directory outside the repo.`,
    );
  }
  return path;
};

const getBadTrustFileError = (path: string, why: string) =>
  new CliError(
    ExitCode.failed,
    `The trust file ${path} ${why}, so storehouse won't trust anything from it. Fix it or delete it, then trust again.`,
  );

// What the person has trusted. A file that's missing trusts nothing; one that's damaged, not a
// plain file of theirs, or writable by others is an error rather than a silent reset.
const readTrustFile = (env: Io['env'], place: TrustPlace): TrustFile => {
  const path = getTrustFilePath(env, place);
  if (!existsSync(path)) return emptyTrustFile();
  const stats = lstatSync(path);
  if (!stats.isFile()) throw getBadTrustFileError(path, "isn't a plain file");
  const isOthersFile =
    process.getuid !== undefined && stats.uid !== process.getuid();
  if (isOthersFile || (stats.mode & 0o022) !== 0) {
    throw getBadTrustFileError(
      path,
      'belongs to someone else or others can write it',
    );
  }
  let json: unknown;
  try {
    json = JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    throw getBadTrustFileError(path, "isn't valid JSON");
  }
  const parsed = trustFileSchema.safeParse(json);
  if (!parsed.success) {
    throw getBadTrustFileError(path, "isn't in storehouse's format");
  }
  return parsed.data;
};

// owner-only, written whole by a rename
const writeTrustFile = (
  env: Io['env'],
  place: TrustPlace,
  trustFile: TrustFile,
) => {
  const path = getTrustFilePath(env, place);
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const tempPath = `${path}.${randomUUID()}.tmp`;
  writeFileSync(tempPath, `${JSON.stringify(trustFile, null, 2)}\n`, {
    flag: 'wx',
    mode: 0o600,
  });
  renameSync(tempPath, path);
};

// Each list that may hold the place's trust, with its key there and the worktree a CLI in it is
// kept relative to: the repo's, then the top level's by the real path.
const getTrustLists = (trustFile: TrustFile, place: TrustPlace) => [
  ...(place.repo === undefined
    ? []
    : [
        {
          list: trustFile.repos[place.repo.commonDir],
          key: place.repo.entry,
          root: place.repo.root,
        },
      ]),
  { list: trustFile, key: place.realPath, root: undefined },
];

// the trust file with the place's own list changed: its repo's, or the top level's outside git
const updateTrustList = (
  trustFile: TrustFile,
  place: TrustPlace,
  update: (list: TrustList, key: string) => TrustList,
) => {
  if (place.repo === undefined) {
    return { ...trustFile, ...update(trustFile, place.realPath) };
  }
  const { commonDir, entry } = place.repo;
  return {
    ...trustFile,
    repos: {
      ...trustFile.repos,
      [commonDir]: update(
        trustFile.repos[commonDir] ?? { manifests: {}, binaries: {} },
        entry,
      ),
    },
  };
};

const isProjectTrusted = ({
  env,
  place,
  project,
}: {
  env: Io['env'];
  place: TrustPlace;
  project: string;
}) =>
  getTrustLists(readTrustFile(env, place), place).some(
    ({ list, key }) => list?.manifests[key]?.includes(project) ?? false,
  );

const recordTrustedProject = ({
  env,
  place,
  project,
}: {
  env: Io['env'];
  place: TrustPlace;
  project: string;
}) => {
  const trustFile = readTrustFile(env, place);
  writeTrustFile(
    env,
    place,
    updateTrustList(trustFile, place, (list, key) => ({
      ...list,
      manifests: {
        ...list.manifests,
        [key]: [...new Set([...(list.manifests[key] ?? []), project])],
      },
    })),
  );
};

// each project a set of env and key pairs sends values to, with the envs and names it holds
const getProjectUses = ({
  manifest,
  pairs,
}: {
  manifest: Manifest;
  pairs: readonly { env: string; key: string }[];
}) => {
  const located = pairs.map(({ env, key }) => ({
    env,
    project: manifestService.envs.getProject(manifest, env),
    name: manifestService.secrets.getName(manifest, env, key),
  }));
  return [...new Set(located.map((l) => l.project))].map((project) => {
    const inProject = located.filter((l) => l.project === project);
    return {
      project,
      envs: [...new Set(inProject.map((l) => l.env))],
      names: inProject.map((l) => l.name),
    } satisfies ProjectUse;
  });
};

const getRefusal = (message: string) => new CliError(ExitCode.refused, message);

// Asks the person to trust each project this run would send values to or from, once.
const verifyTrustedProjects = async ({
  io,
  manifestPath,
  projectUses,
}: {
  io: Io;
  manifestPath: string;
  projectUses: readonly ProjectUse[];
}) => {
  const place = getTrustPlace(manifestPath);
  const untrusted = projectUses.filter(
    ({ project }) => !isProjectTrusted({ env: io.env, place, project }),
  );
  if (untrusted.length === 0) return;
  const shownPath = relative(io.cwd, manifestPath) || manifestPath;
  const projects = untrusted.map((u) => u.project).join(', ');
  const marker = getAgentMarker(io.env);
  if (marker) {
    throw getRefusal(
      `${shownPath} sends secrets to Google Cloud project ${projects}, which hasn't been trusted for it, and ${marker.name} is set (${marker.agent}). A person trusts a project: they run storehouse trust in their own terminal.`,
    );
  }
  if (!io.stdin.isTTY || !io.stdout.isTTY) {
    throw getRefusal(
      `${shownPath} sends secrets to Google Cloud project ${projects}, which hasn't been trusted for it. Run storehouse trust in a terminal once.`,
    );
  }
  for (const { project, envs, names } of untrusted) {
    io.stderr.write(
      `${shownPath} keeps ${envs.join(', ')}'s secrets in Google Cloud project ${project}: ${names.join(', ')}.\n`,
    );
    const typedProject = await io.prompt(
      `Type ${project} to trust it for this manifest: `,
      { isHidden: false },
    );
    if (typedProject.trim() !== project) {
      throw getRefusal(`That isn't "${project}". Nothing was done.`);
    }
    recordTrustedProject({ env: io.env, place, project });
  }
};

// a repo-local CLI's real file and what it holds, read once
const readBinary = (path: string) => {
  const realPath = realpathSync.native(path);
  return { path: realPath, content: readFileSync(realPath) };
};

type BinaryRead = ReturnType<typeof readBinary>;

const getSha256 = (content: Buffer) =>
  createHash('sha256').update(content).digest('hex');

// a repo-local CLI as a person is shown it, and as it's hashed again just before it runs
const getIdentity = ({ path, content }: BinaryRead) =>
  ({ path, sha256: getSha256(content) }) satisfies TrustedBinary;

const getBinaryIdentity = (path: string) => getIdentity(readBinary(path));

// A sha256 of a CLI that leaves out its worktree's own path, which pnpm writes into each .bin
// file: the root followed by a separator, so /w/app-x isn't read as /w/app. Each part between is
// hashed after its length, so no other content matches.
const getWorktreeSha256 = (content: Buffer, root: string) => {
  const hash = createHash('sha256');
  const rootBytes = Buffer.from(`${root}${sep}`);
  let start = 0;
  for (
    let at = content.indexOf(rootBytes);
    at !== -1;
    at = content.indexOf(rootBytes, start)
  ) {
    hash.update(`${at - start}:`).update(content.subarray(start, at));
    start = at + rootBytes.length;
  }
  hash.update(`${content.length - start}:`).update(content.subarray(start));
  return hash.digest('hex');
};

// A CLI as a list keeps it. A repo's keeps one in its worktree by its path there and its worktree
// sha256, so the same CLI in every worktree is one entry; otherwise its real path and sha256.
const getTrustedForm = (binary: BinaryRead, root: string | undefined) => {
  if (root === undefined || !pathService.isInside(root, binary.path)) {
    return getIdentity(binary);
  }
  return {
    path: relative(root, binary.path).split(sep).join('/'),
    sha256: getWorktreeSha256(binary.content, root),
  } satisfies TrustedBinary;
};

const isBinaryTrusted = ({
  env,
  place,
  binary,
}: {
  env: Io['env'];
  place: TrustPlace;
  binary: BinaryRead;
}) =>
  getTrustLists(readTrustFile(env, place), place).some(
    ({ list, key, root }) => {
      const form = getTrustedForm(binary, root);
      return (list?.binaries[key] ?? []).some(
        (trusted) =>
          trusted.path === form.path && trusted.sha256 === form.sha256,
      );
    },
  );

// whether the CLI at path, as it is now, is trusted for the manifest
const isBinaryPathTrusted = ({
  env,
  manifestPath,
  path,
}: {
  env: Io['env'];
  manifestPath: string;
  path: string;
}) =>
  isBinaryTrusted({
    env,
    place: getTrustPlace(manifestPath),
    binary: readBinary(path),
  });

const recordTrustedBinary = ({
  env,
  place,
  binary,
}: {
  env: Io['env'];
  place: TrustPlace;
  binary: BinaryRead;
}) => {
  const trustFile = readTrustFile(env, place);
  const form = getTrustedForm(binary, place.repo?.root);
  writeTrustFile(
    env,
    place,
    updateTrustList(trustFile, place, (list, key) => ({
      ...list,
      binaries: {
        ...list.binaries,
        // every version stays trusted, since each worktree may have its own
        [key]: [
          ...(list.binaries[key] ?? []).filter(
            (trusted) =>
              trusted.path !== form.path || trusted.sha256 !== form.sha256,
          ),
          form,
        ],
      },
    })),
  );
};

// Why a person can't be asked here, or undefined when they can.
const getUnaskableReason = (io: Io) => {
  const marker = getAgentMarker(io.env);
  if (marker) return `${marker.name} is set (${marker.agent})`;
  if (!io.stdin.isTTY || !io.stdout.isTTY)
    return 'there is no terminal to ask in';
  return undefined;
};

// The CLI a planned command runs as, an absolute real path, and the sha256 a person trusted when
// it's the repo's own; undefined when it isn't installed anywhere.
export type CommandToRun = { path: string; sha256?: string } | undefined;

// What a name finds on the PATH: the first match outside the repo, and the first inside it.
type PathMatches = {
  outside?: string | undefined;
  inRepo?: string | undefined;
};

// What each planned command (a repo-local path, or a name for the PATH) runs as. The repo's own
// CLI, whether planned or the only one the PATH finds, runs once a person trusts its content for
// this manifest; otherwise the PATH's outside the repo, said out loud. With isFallbackAllowed
// false (storehouse trust), one that can't be asked about is refused instead.
const getCommandsToRun = async ({
  io,
  manifestPath,
  commands,
  findOnPath,
  isFallbackAllowed,
}: {
  io: Io;
  manifestPath: string;
  commands: readonly string[];
  findOnPath: (name: string) => PathMatches;
  isFallbackAllowed: boolean;
}) => {
  const commandsToRun = new Map<string, CommandToRun>();
  const place = getTrustPlace(manifestPath);
  const shownManifestPath = relative(io.cwd, manifestPath) || manifestPath;
  for (const command of new Set(commands)) {
    const name = basename(command);
    const onPath = findOnPath(name);
    const repoPath = command.includes(sep) ? command : onPath.inRepo;
    if (repoPath === undefined || (!command.includes(sep) && onPath.outside)) {
      commandsToRun.set(
        command,
        onPath.outside === undefined ? undefined : { path: onPath.outside },
      );
      continue;
    }
    const read = readBinary(repoPath);
    const binary = getIdentity(read);
    if (isBinaryTrusted({ env: io.env, place, binary: read })) {
      commandsToRun.set(command, binary);
      continue;
    }
    const unaskableReason = getUnaskableReason(io);
    if (unaskableReason === undefined) {
      io.stderr.write(
        `${shownManifestPath} would hand values to the repo's own ${name}: ${binary.path} (sha256 ${binary.sha256}).\n`,
      );
      const typedName = await io.prompt(
        `Type ${name} to trust this ${name} for this manifest: `,
        { isHidden: false },
      );
      if (typedName.trim() !== name) {
        throw getRefusal(`That isn't "${name}". Nothing was done.`);
      }
      recordTrustedBinary({ env: io.env, place, binary: read });
      commandsToRun.set(command, binary);
      continue;
    }
    const fallback = isFallbackAllowed ? onPath.outside : undefined;
    if (fallback === undefined) {
      throw getRefusal(
        `The repo's own ${name} (${binary.path}) isn't trusted for ${shownManifestPath}, and ${unaskableReason}${isFallbackAllowed ? `, and there's no ${name} on your PATH outside the repo` : ''}. A person trusts it: they run storehouse trust in their own terminal.`,
      );
    }
    io.stderr.write(
      `Not using the repo's own ${name} (${binary.path}): it isn't trusted for ${shownManifestPath}, and ${unaskableReason}. Using ${fallback} instead; run storehouse trust in a terminal to trust it.\n`,
    );
    commandsToRun.set(command, { path: fallback });
  }
  return commandsToRun;
};

// Hashes a trusted CLI again just before it runs, so one swapped since it was trusted doesn't.
const assertUnchanged = (command: NonNullable<CommandToRun>) => {
  if (command.sha256 === undefined) return;
  if (getBinaryIdentity(command.path).sha256 === command.sha256) return;
  throw getRefusal(
    `${command.path} changed since it was trusted, so it wasn't run. Nothing more was sent.`,
  );
};

export const trustService = {
  verify: verifyTrustedProjects,
  getCommandsToRun,
  assertUnchanged,
  isBinaryTrusted: isBinaryPathTrusted,
  getBinaryIdentity,
  getProjectUses,
};
