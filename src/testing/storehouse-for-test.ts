import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { manifestService } from '../manifest/manifest.ts';
import type { LoadedManifest } from '../manifest/manifest.ts';
import { pushTargetService } from '../push-targets/push-targets.ts';
import { cliService } from '../push-targets/run-cli.ts';
import { run } from '../run.ts';
import { CredentialSource } from '../secret-manager/credentials.ts';
import type { Credentials, Token } from '../secret-manager/credentials.ts';
import { trustService } from '../trust.ts';
import type { Io } from '../terminal/io.ts';
import { getAllFakeCliRuns } from './fake-cli.ts';
import { token } from './fake-secret-manager.ts';
import type { Fake } from './fake-secret-manager.ts';

// a manifest for a test to start from; each call is a fresh object
export const fakeManifest = () => ({
  project: 'acme-test',
  name: 'acme-{env}-{key}',
  envs: {
    dev: { pull: { file: 'worker/.dev.vars' } },
    stage: {
      push: [{ to: 'cloudflare-workers', dir: 'worker', wranglerEnv: 'stage' }],
    },
    prod: {
      protected: true,
      push: [{ to: 'cloudflare-workers', dir: 'worker', wranglerEnv: 'prod' }],
    },
  },
  secrets: {
    AUTH_SECRET: { purpose: 'Signs session cookies.', required: true },
    TWILIO_SID: { purpose: 'The Twilio account that texts sign-in codes.' },
    SEED_TOKEN: {
      purpose: "The sandbox seller's token, for the seed script.",
      envs: ['dev'],
      pull: false,
    },
  },
});

// A temporary repo holding a manifest (and any other files), with the Worker's directory made.
export const createRepoForTest = (
  manifest: unknown = fakeManifest(),
  files: Record<string, string> = {},
) => {
  const root = mkdtempSync(join(tmpdir(), 'storehouse-test-'));
  mkdirSync(join(root, 'worker'));
  writeFileSync(
    join(root, 'storehouse.json'),
    JSON.stringify(manifest, null, 2),
  );
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), text);
  }
  return root;
};

// A config directory holding this trust file, owner-only as storehouse writes it.
export const createConfigWithTrustForTest = (trustFile: unknown) => {
  const configDir = mkdtempSync(join(tmpdir(), 'storehouse-config-'));
  mkdirSync(join(configDir, 'storehouse'));
  writeFileSync(
    join(configDir, 'storehouse', 'trusted-projects.json'),
    JSON.stringify(trustFile),
    { mode: 0o600 },
  );
  return configDir;
};

// A config directory whose trust file trusts what the manifest at cwd uses, as a person who ran
// storehouse trust would have.
const createTrustedConfigForTest = (
  cwd: string,
  trusts: 'all' | 'projects' | 'none',
) => {
  const configDir = mkdtempSync(join(tmpdir(), 'storehouse-config-'));
  if (trusts === 'none') return configDir;
  let loaded: LoadedManifest;
  try {
    loaded = manifestService.get(cwd);
  } catch {
    return configDir;
  }
  const { manifest, path, root } = loaded;
  const manifestKey = realpathSync.native(path);
  const projects = [
    manifest.project,
    ...Object.values(manifest.envs).map((config) => config.project),
  ].filter((project) => project !== undefined);
  const binaries =
    trusts === 'all'
      ? Object.values(manifest.envs).flatMap((config) =>
          config.push.flatMap((target) =>
            pushTargetService
              .getInvocations({ target, root, keys: [], values: {} })
              .map((invocation) => invocation.command)
              .filter(cliService.isRepoLocal)
              .map(trustService.getBinaryIdentity),
          ),
        )
      : [];
  mkdirSync(join(configDir, 'storehouse'));
  writeFileSync(
    join(configDir, 'storehouse', 'trusted-projects.json'),
    JSON.stringify({
      manifests: { [manifestKey]: projects },
      binaries: { [manifestKey]: binaries },
    }),
  );
  return configDir;
};

type IoOptions = {
  cwd: string;
  // what the test's own trust file trusts up front: the manifest's projects and its repo-local
  // CLIs ('all'), only its projects (the default), or nothing
  trusts?: 'all' | 'projects' | 'none';
  fake?: Fake;
  env?: Record<string, string | undefined>;
  stdin?: string | Buffer;
  tty?: boolean;
  stdinTTY?: boolean;
  stdoutTTY?: boolean;
  answers?: string[];
  columns?: number;
  token?: string;
  timeoutMs?: number;
  credentials?: Credentials;
};

// Credentials that hand out one token, then each next one on refresh, as a source that can
// refresh would after Google refuses one.
export const createCredentialsForTest = (
  tokens: readonly string[],
  quotaProject?: string,
) => {
  let index = 0;
  const getToken = () =>
    Promise.resolve<Token>({
      token: tokens[index] ?? tokens.at(-1) ?? '',
      expiresAt: undefined,
      quotaProject,
    });
  return {
    getToken,
    refreshToken: () => {
      if (index + 1 >= tokens.length) return Promise.resolve(undefined);
      index++;
      return getToken();
    },
    describe: async () => ({
      source: CredentialSource.accessTokenEnv,
      detail: 'a token for tests',
      token: await getToken(),
    }),
  } satisfies Credentials;
};

export const createIoForTest = (options: IoOptions) => {
  const out: (string | Uint8Array)[] = [];
  const err: string[] = [];
  const prompts: { question: string; isHidden: boolean }[] = [];
  // what was typed at a hidden prompt: a value, which the leak check looks for
  const hiddenAnswers: string[] = [];
  const answers = [...(options.answers ?? [])];
  const io: Io = {
    cwd: options.cwd,
    env: {
      PATH: process.env.PATH,
      // the person's own trust file is never read or written by a test
      XDG_CONFIG_HOME: createTrustedConfigForTest(
        options.cwd,
        options.trusts ?? 'projects',
      ),
      ...options.env,
    },
    stdin: {
      isTTY: options.stdinTTY ?? options.tty ?? false,
      readAll: () => Promise.resolve(Buffer.from(options.stdin ?? '')),
    },
    stdout: {
      isTTY: options.stdoutTTY ?? options.tty ?? false,
      columns: options.columns,
      write: (data) => {
        out.push(data);
      },
    },
    stderr: {
      isTTY: false,
      write: (data) => {
        err.push(data);
      },
    },
    prompt: (question, { isHidden }) => {
      prompts.push({ question, isHidden });
      const answer = answers.shift();
      if (isHidden && answer !== undefined) hiddenAnswers.push(answer);
      return answer === undefined
        ? Promise.reject(new Error(`Unexpected prompt: ${question}`))
        : Promise.resolve(answer);
    },
    now: () => new Date(Date.UTC(2026, 0, 4, 12)),
    google: {
      baseUrl: options.fake?.baseUrl ?? 'http://127.0.0.1:9/v1',
      credentials:
        options.credentials ??
        createCredentialsForTest([options.token ?? token]),
      retryBaseMs: 1,
      timeoutMs: options.timeoutMs ?? 2000,
    },
  };
  return {
    io,
    prompts,
    hiddenAnswers,
    stdout: () =>
      Buffer.concat(out.map((c) => Buffer.from(c))).toString('utf8'),
    stdoutBytes: () => Buffer.concat(out.map((c) => Buffer.from(c))),
    stderr: () => err.join(''),
  };
};

// values short enough to turn up in ordinary output by chance aren't checked
const minLeakLength = 8;

// Every secret value this run could know: what the fake holds and what was typed or piped in.
const getKnownValues = (
  options: IoOptions,
  hiddenAnswers: readonly string[],
) => [
  ...[...(options.fake?.secrets.values() ?? [])].flatMap((secret) =>
    secret.versions.map((v) => v.data.toString('utf8')),
  ),
  ...(typeof options.stdin === 'string' ? [options.stdin] : []),
  ...hiddenAnswers,
];

// Each form a value could leak in: as it is, JSON-escaped, base64 (as Secret Manager carries it),
// URL-encoded, and each of its lines on its own. Forms too short to tell from ordinary text are
// left out.
export const getLeakFormsForTest = (value: string) =>
  [
    value,
    JSON.stringify(value).slice(1, -1),
    Buffer.from(value).toString('base64'),
    encodeURIComponent(value),
    ...value.split(/\r?\n/),
  ]
    .map((form) => form.trim())
    .filter((form) => form.length >= minLeakLength);

// get prints a value to stdout by design; nothing else may show one anywhere
const isPrintingValue = (argv: readonly string[]) =>
  argv.includes('get') && !argv.some((word) => word.startsWith('--out'));

// the first place any form of any value turns up, or undefined
export const findLeakForTest = ({
  values,
  places,
}: {
  values: readonly string[];
  places: readonly { where: string; text: string }[];
}) => {
  for (const form of values.flatMap(getLeakFormsForTest)) {
    const leak = places.find((place) => place.text.includes(form));
    if (leak) return leak.where;
  }
  return undefined;
};

const assertNoLeaks = ({
  argv,
  options,
  hiddenAnswers,
  stdout,
  stderr,
}: {
  argv: readonly string[];
  options: IoOptions;
  hiddenAnswers: readonly string[];
  stdout: string;
  stderr: string;
}) => {
  const leakedInto = findLeakForTest({
    values: getKnownValues(options, hiddenAnswers),
    places: [
      ...(isPrintingValue(argv) ? [] : [{ where: 'stdout', text: stdout }]),
      { where: 'stderr', text: stderr },
      ...getAllFakeCliRuns().map((r) => ({
        where: "a CLI's argv or env",
        text: [...r.argv, ...Object.values(r.env)].join('\n'),
      })),
    ],
  });
  if (leakedInto !== undefined) {
    throw new Error(
      `storehouse ${argv.join(' ')} leaked a secret value into ${leakedInto}`,
    );
  }
};

export const runStorehouseForTest = async (
  argv: string[],
  options: IoOptions,
) => {
  const t = createIoForTest(options);
  const code = await run(argv, t.io);
  assertNoLeaks({
    argv,
    options,
    hiddenAnswers: t.hiddenAnswers,
    stdout: t.stdout(),
    stderr: t.stderr(),
  });
  return { code, ...t };
};
