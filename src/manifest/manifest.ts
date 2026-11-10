import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { z } from 'zod';
import { CliError, ExitCode, getErrorMessage } from '../errors.ts';
import { gitService } from '../git.ts';
import { pathService } from '../utils/paths.ts';
import { manifestSchema } from './schema.ts';
import type { Manifest } from './schema.ts';

const manifestFileName = 'storehouse.json';
const placeholders = new Set(['{env}', '{key}']);
const secretIdPattern = /^[A-Za-z0-9_-]{1,255}$/;

const getEnvsForSecret = (manifest: Manifest, key: string) =>
  manifest.secrets[key]?.envs ?? Object.keys(manifest.envs);

const isSecretUsedInEnv = (manifest: Manifest, key: string, env: string) =>
  getEnvsForSecret(manifest, key).includes(env);

const getProjectForEnv = (manifest: Manifest, env: string) =>
  manifest.envs[env]?.project ?? manifest.project ?? '';

const getSecretName = (manifest: Manifest, env: string, key: string) =>
  (manifest.secrets[key]?.name ?? manifest.name ?? '')
    .replaceAll('{env}', env)
    .replaceAll('{key}', key);

const getSecretKeysForEnv = (manifest: Manifest, env: string) =>
  Object.keys(manifest.secrets).filter((key) =>
    isSecretUsedInEnv(manifest, key, env),
  );

// a manifest's own text, made safe to show: control characters written as escapes
const escapeControlCharacters = (text: string) =>
  text.replace(
    /\p{Cc}/gu,
    (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`,
  );

const formatZodProblems = (error: z.ZodError) =>
  error.issues.map((issue) => {
    const path = issue.path
      .map((segment) => escapeControlCharacters(String(segment)))
      .join('.');
    // a message can quote a key from the file, line break and all
    const message = escapeControlCharacters(issue.message);
    return path ? `${path}: ${message}` : message;
  });

const getPatternProblems = (pattern: string, where: string) =>
  (pattern.match(/\{[^}]*\}/g) ?? [])
    .filter((token) => !placeholders.has(token))
    .map(
      (token) => `${where}: ${token} isn't a placeholder. Use {env} and {key}.`,
    );

const getEnvProblems = (manifest: Manifest) => {
  const envNames = Object.keys(manifest.envs);
  if (envNames.length === 0) return ['envs: add at least one env.'];
  return envNames
    .filter((env) => !getProjectForEnv(manifest, env))
    .map(
      (env) =>
        `envs.${env}: no Google Cloud project. Set "project" at the top of the manifest or in envs.${env}.`,
    );
};

const getSecretEnvProblems = (manifest: Manifest, key: string) =>
  (manifest.secrets[key]?.envs ?? [])
    .filter((env) => !Object.hasOwn(manifest.envs, env))
    .map(
      (env) =>
        `secrets.${key}.envs: "${env}" isn't an env. The envs are ${Object.keys(manifest.envs).join(', ')}.`,
    );

// Each secret's name in each env it's used in, so names can be checked and compared.
const getNamedSecrets = (manifest: Manifest) =>
  Object.keys(manifest.secrets)
    .filter((key) => manifest.secrets[key]?.name ?? manifest.name)
    .flatMap((key) =>
      getEnvsForSecret(manifest, key)
        .filter((env) => Object.hasOwn(manifest.envs, env))
        .map((env) => ({
          key,
          env,
          project: getProjectForEnv(manifest, env),
          name: getSecretName(manifest, env, key),
        })),
    );

const getNameProblems = (manifest: Manifest) => {
  const namedSecrets = getNamedSecrets(manifest);
  const invalid = namedSecrets
    .filter((s) => !secretIdPattern.test(s.name))
    .map(
      (s) =>
        `secrets.${s.key}: its ${s.env} name, ${JSON.stringify(s.name)}, isn't a valid Secret Manager name (letters, digits, - and _, up to 255).`,
    );
  const valid = namedSecrets.filter((s) => secretIdPattern.test(s.name));
  const duplicates = valid.flatMap((s, i) => {
    const first = valid.find(
      (other) => other.project === s.project && other.name === s.name,
    );
    if (!first || valid.indexOf(first) === i) return [];
    return [
      `secrets.${s.key}: its ${s.env} name, ${JSON.stringify(s.name)}, is also ${first.key} in ${first.env}'s. Each env and key needs its own name: put {env} and {key} in the pattern.`,
    ];
  });
  return [...invalid, ...duplicates];
};

// Everything wrong with a parsed manifest that the schema alone can't say.
const getManifestProblems = (manifest: Manifest) => [
  ...getEnvProblems(manifest),
  ...(manifest.name === undefined
    ? []
    : getPatternProblems(manifest.name, 'name')),
  ...Object.entries(manifest.secrets).flatMap(([key, secret]) => [
    ...(secret.name === undefined && manifest.name === undefined
      ? [
          `secrets.${key}: no name. Set "name" at the top of the manifest, such as "myapp-{env}-{key}", or on the secret.`,
        ]
      : []),
    ...(secret.name === undefined
      ? []
      : getPatternProblems(secret.name, `secrets.${key}.name`)),
    ...getSecretEnvProblems(manifest, key),
  ]),
  ...getNameProblems(manifest),
];

// Pull files and push dirs stay inside the repo (or the manifest's directory outside one), so a
// one-line manifest change can't point a pull --force at a file elsewhere on disk.
const getLocationProblems = (manifest: Manifest, manifestPath: string) => {
  const manifestDir = dirname(manifestPath);
  const root = pathService.getReal(
    gitService.getRepoRoot(manifestPath) ?? manifestDir,
  );
  const locations = Object.entries(manifest.envs).flatMap(([env, config]) => [
    ...(config.pull
      ? [{ where: `envs.${env}.pull.file`, path: config.pull.file }]
      : []),
    ...config.push.flatMap((target, i) =>
      'dir' in target
        ? [{ where: `envs.${env}.push[${i}].dir`, path: target.dir }]
        : [],
    ),
  ]);
  // the schema already refuses absolute paths and `..`; this catches a symlink out of the repo,
  // git's own files, and a pull over the manifest or .gitignore
  return locations.flatMap(({ where, path }) => {
    const location = resolve(manifestDir, path);
    const realLocation = pathService.getReal(location);
    if (!pathService.isInside(root, realLocation)) {
      return [
        `${where}: ${JSON.stringify(path)} is outside the repo (${root}). Keep it inside, so a pull or push can't touch files elsewhere.`,
      ];
    }
    if (gitService.isInternal(location, manifestDir)) {
      return [
        `${where}: ${JSON.stringify(path)} is inside git's own directory. Keep it out of .git, so a pull or push can't change the repo itself.`,
      ];
    }
    const isOverOwnFile =
      where.endsWith('.pull.file') &&
      (pathService.isSame(realLocation, pathService.getReal(manifestPath)) ||
        pathService.isNamed(realLocation, '.gitignore'));
    const isDirectory =
      where.endsWith('.pull.file') &&
      existsSync(realLocation) &&
      statSync(realLocation).isDirectory();
    if (isDirectory) {
      return [
        `${where}: ${JSON.stringify(path)} is a directory. Name a file, such as .env.${where.split('.')[1] ?? 'dev'}.`,
      ];
    }
    if (isOverOwnFile) {
      return [
        `${where}: ${JSON.stringify(path)} is storehouse.json or a .gitignore. Pull to a file of its own, such as .env.${where.split('.')[1] ?? 'dev'}.`,
      ];
    }
    return [];
  });
};

const parseManifest = (json: unknown) => {
  const parsedManifest = manifestSchema.safeParse(json);
  if (!parsedManifest.success) {
    return {
      manifest: undefined,
      problems: formatZodProblems(parsedManifest.error),
    };
  }
  return {
    manifest: parsedManifest.data,
    problems: getManifestProblems(parsedManifest.data),
  };
};

// The nearest storehouse.json, from dir up to the root, or undefined.
const getManifestPath = (dir: string): string | undefined => {
  const path = join(dir, manifestFileName);
  if (existsSync(path)) return path;
  if (dirname(dir) === dir) return undefined;
  return getManifestPath(dirname(dir));
};

const getManifestPathOrThrow = (cwd: string) => {
  const path = getManifestPath(cwd);
  if (path !== undefined) return path;
  throw new CliError(
    ExitCode.manifest,
    `No ${manifestFileName} here or in any parent directory. Create one at the repo root: the README's quickstart has an example.`,
  );
};

const readManifestJson = (path: string) => {
  let text;
  try {
    text = readFileSync(path, 'utf8');
  } catch (error) {
    throw new CliError(
      ExitCode.manifest,
      `Couldn't read ${path}: ${getErrorMessage(error)}`,
      { cause: error },
    );
  }
  try {
    const json: unknown = JSON.parse(text);
    return json;
  } catch (error) {
    throw new CliError(
      ExitCode.manifest,
      `${escapeControlCharacters(path)} isn't valid JSON: ${escapeControlCharacters(getErrorMessage(error))}`,
      { cause: error },
    );
  }
};

// The manifest for a command: found from cwd and valid, or an error that lists every problem.
const getManifest = (cwd: string) => {
  const path = getManifestPathOrThrow(cwd);
  const parsedManifest = parseManifest(readManifestJson(path));
  const { manifest } = parsedManifest;
  const problems = manifest
    ? [...parsedManifest.problems, ...getLocationProblems(manifest, path)]
    : parsedManifest.problems;
  if (manifest === undefined || problems.length > 0) {
    throw new CliError(
      ExitCode.manifest,
      [
        `${escapeControlCharacters(path)} has problems:`,
        ...problems.map((p) => `  ${p}`),
      ].join('\n'),
    );
  }
  return { manifest, root: dirname(path), path };
};

const protectedEnvsSchema = z.object({
  envs: z.record(
    z.string(),
    z.object({ protected: z.boolean().optional() }).loose(),
  ),
});

const getProtectedEnvNames = (committedText: string | undefined) => {
  if (committedText === undefined) return [];
  try {
    const envs =
      protectedEnvsSchema.safeParse(JSON.parse(committedText)).data?.envs ?? {};
    return Object.keys(envs).filter((env) => envs[env]?.protected === true);
  } catch {
    // not JSON at HEAD: nothing committed to go by
    return [];
  }
};

// The envs protected by the manifest in the working tree, by its own committed copy, or by the
// nearest manifest committed above where the command runs, so neither deleting "protected" nor a
// new manifest beside the old one lifts it.
const getProtectedEnvs = ({
  manifest,
  path,
  cwd,
}: {
  manifest: Manifest;
  path: string;
  cwd: string;
}) =>
  new Set([
    ...Object.keys(manifest.envs).filter(
      (env) => manifest.envs[env]?.protected === true,
    ),
    ...getProtectedEnvNames(gitService.getCommittedText(path)),
    ...getProtectedEnvNames(
      gitService.getNearestCommittedText(cwd, manifestFileName),
    ),
  ]);

export type LoadedManifest = ReturnType<typeof getManifest>;

export const manifestService = {
  get: getManifest,
  parse: parseManifest,
  getLocationProblems,
  getProtectedEnvs,
  readJson: readManifestJson,
  path: { get: getManifestPath, getOrThrow: getManifestPathOrThrow },
  envs: { getProject: getProjectForEnv, getSecretKeys: getSecretKeysForEnv },
  secrets: {
    getName: getSecretName,
    getEnvs: getEnvsForSecret,
    isUsedIn: isSecretUsedInEnv,
  },
};
