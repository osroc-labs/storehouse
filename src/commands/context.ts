import type { ParsedCommand } from '../command-line/command-line.ts';
import { dotenvService } from '../dotenv.ts';
import { CliError, ExitCode, getUsageError } from '../errors.ts';
import { manifestService } from '../manifest/manifest.ts';
import type { LoadedManifest } from '../manifest/manifest.ts';
import type { Manifest } from '../manifest/schema.ts';
import type { SecretService } from '../secret-manager/secrets.ts';
import type { Io } from '../terminal/io.ts';
import { format } from '../utils/format.ts';
import { mapAll } from '../utils/map-all.ts';

// What every command gets. A command checks what it can without Google and returns the rest to
// run, so a mistake is reported before a protected env asks for its name.
export type Context = {
  io: Io;
  loaded: LoadedManifest;
  line: ParsedCommand;
  secrets: SecretService;
  // envs protected by the manifest in the working tree or the one committed at HEAD
  protectedEnvs: ReadonlySet<string>;
};

export type CommandHandler = (context: Context) => () => Promise<number>;

const assertEnv = (manifest: Manifest, env: string) => {
  if (Object.hasOwn(manifest.envs, env)) return env;
  throw getUsageError(
    `There's no env "${env}" in storehouse.json. The envs are ${Object.keys(manifest.envs).join(', ')}.`,
  );
};

const assertKey = (manifest: Manifest, env: string, key: string) => {
  if (!Object.hasOwn(manifest.secrets, key)) {
    throw getUsageError(
      `${key} isn't in storehouse.json. storehouse never edits the manifest: add it under "secrets" in a commit, then run this again.\n  "${key}": { "purpose": "What it's for." }`,
    );
  }
  const envs = manifestService.secrets.getEnvs(manifest, key);
  if (envs.includes(env)) return key;
  throw getUsageError(
    `${key} isn't used in ${env}. Its envs are ${envs.join(', ')}; add ${env} to secrets.${key}.envs in storehouse.json to use it there.`,
  );
};

// where one env's key lives in Secret Manager
const getSecretLocation = (manifest: Manifest, env: string, key: string) => ({
  project: manifestService.envs.getProject(manifest, env),
  name: manifestService.secrets.getName(manifest, env, key),
});

const getNotSetError = ({
  env,
  key,
  name,
}: {
  env: string;
  key: string;
  name: string;
}) =>
  new CliError(
    ExitCode.missing,
    `${key} isn't set in ${env} (${name} has no enabled latest version). Set it with: storehouse set ${env} ${key}`,
  );

// pull and push send text; one trailing newline, from a paste, is dropped as set drops it
const getTextValue = (key: string, bytes: Uint8Array) => {
  let text;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch (error) {
    throw new CliError(
      ExitCode.failed,
      `${key}'s value isn't UTF-8 text, so it can't be written as a variable. Nothing was written or sent.`,
      { cause: error },
    );
  }
  return dotenvService.stripTrailingNewline(text);
};

// Each key's latest value, or only whether it's set when hasValues is false (a dry run reads none).
const getSecretsForEnv = async ({
  secrets,
  manifest,
  env,
  keys,
  hasValues,
}: {
  secrets: SecretService;
  manifest: Manifest;
  env: string;
  keys: readonly string[];
  hasValues: boolean;
}) => {
  const allSecrets = await mapAll(keys, async (key) => {
    const { project, name } = getSecretLocation(manifest, env, key);
    if (!hasValues) {
      const latestVersion = await secrets.getLatestVersion(project, name);
      return { key, name, isSet: latestVersion?.state === 'ENABLED' };
    }
    const bytes = await secrets.getValue(project, name);
    return {
      key,
      name,
      isSet: bytes !== undefined,
      ...(bytes !== undefined && { value: getTextValue(key, bytes) }),
    };
  });
  const missingKeys = allSecrets.filter((s) => !s.isSet).map((s) => s.key);
  const requiredMissing = missingKeys.filter(
    (key) => manifest.secrets[key]?.required === true,
  );
  return {
    setKeys: allSecrets.filter((s) => s.isSet).map((s) => s.key),
    requiredMissing,
    optionalMissing: missingKeys.filter(
      (key) => !requiredMissing.includes(key),
    ),
    values: Object.fromEntries(
      allSecrets.flatMap((s) => ('value' in s ? [[s.key, s.value]] : [])),
    ),
  };
};

const getMissingSecretsError = ({
  env,
  keys,
  stopped,
  isNamed,
}: {
  env: string;
  keys: readonly string[];
  stopped: string;
  isNamed: boolean;
}) =>
  new CliError(
    ExitCode.missing,
    [
      `${format.plural(keys.length, isNamed ? 'secret you named is' : 'required secret is', isNamed ? 'secrets you named are' : 'required secrets are')} missing in ${env}, so ${stopped}. Set ${keys.length === 1 ? 'it' : 'them'} first:`,
      ...keys.map((key) => `  storehouse set ${env} ${key}`),
    ].join('\n'),
  );

export const commandService = {
  assertEnv,
  assertKey,
  getSecretLocation,
  getNotSetError,
  getSecretsForEnv,
  getMissingSecretsError,
};
