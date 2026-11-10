// Writes src/generated/cli-docs.json, the site's facts, from the CLI and the README: each command's
// --help, `storehouse status` run against the fake Secret Manager, the README's install line, its
// Quickstart manifest once `storehouse check` passes it, and its exit codes once they match the
// CLI's. `--check` fails when the file is stale.
import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { ExitCode } from '../../src/errors.ts';
import { run } from '../../src/run.ts';
import { fakeSecretManager } from '../../src/testing/fake-secret-manager.ts';
import {
  createIoForTest,
  createRepoForTest,
} from '../../src/testing/storehouse-for-test.ts';
import { readmeService } from './readme.ts';

const outputUrl = new URL('../src/generated/cli-docs.json', import.meta.url);
const brandBuildUrl = new URL('../brand/build.mjs', import.meta.url);

// The README's status sample, as a repo would write it.
const statusManifest = {
  project: 'my-gcp-project',
  name: 'myapp-{env}-{key}',
  envs: { dev: {}, stage: {}, prod: { protected: true } },
  secrets: {
    AUTH_SECRET: { purpose: 'Signs session cookies.', required: true },
    SMS_SID: { purpose: 'The SMS account that texts sign-in codes.' },
    SEED_TOKEN: {
      purpose: 'A sandbox token, for the seed script.',
      envs: ['dev'],
    },
  },
};

// each set secret, and how many days before the test clock its value was stored
const statusSeeds = [
  { name: 'myapp-dev-AUTH_SECRET', daysAgo: 10 },
  { name: 'myapp-stage-AUTH_SECRET', daysAgo: 10 },
  { name: 'myapp-dev-SMS_SID', daysAgo: 2 },
  { name: 'myapp-dev-SEED_TOKEN', daysAgo: 7 },
];

const dayMs = 24 * 60 * 60 * 1000;

const runStorehouse = async (
  argv: string[],
  options: Omit<Parameters<typeof createIoForTest>[0], 'cwd'> & {
    cwd?: string;
  } = {},
) => {
  const t = createIoForTest({ cwd: process.cwd(), ...options });
  const code = await run(argv, t.io);
  if (t.stderr() !== '') {
    throw new Error(`storehouse ${argv.join(' ')} wrote:\n${t.stderr()}`);
  }
  return { code, stdout: t.stdout() };
};

const getOptionLines = (help: string) => {
  const [, block = ''] = help.split('\nOptions:\n');
  return block
    .split('\n')
    .filter((line) => line.startsWith('  '))
    .map((line) => {
      const [flag = '', description = ''] = line.trim().split(/ {2,}/);
      if (!flag.startsWith('-')) {
        throw new Error(
          `"${line.trim()}" in --help isn't an option line: a description wrapped?`,
        );
      }
      return { flag, description };
    });
};

// `Usage: storehouse push <env> [KEY…] [options]`, then a blank line, then the summary
const getCommandHelp = async (name: string) => {
  const { stdout } = await runStorehouse([name, '--help']);
  const [usageLine = '', , summary = ''] = stdout.split('\n');
  const usage = usageLine.replace(/^Usage: /, '').replace(/ \[options\]$/, '');
  return { name, usage, summary, options: getOptionLines(stdout) };
};

const getCommandNames = async () => {
  const { stdout } = await runStorehouse(['--help']);
  const [, block = ''] = stdout.split('\nCommands:\n');
  const [list = ''] = block.split('\n\n');
  return list.split('\n').map((line) => line.trim().split(' ')[0] ?? '');
};

// The README's status sample must be the CLI's own output, so the README can't drift either.
const assertReadmeStatus = (output: string) => {
  const sample = readmeService
    .getIntroBlocks()
    .find((block) => block.kind === 'code');
  const [command, ...lines] = sample?.text.split('\n') ?? [];
  if (command !== '$ storehouse status' || lines.join('\n') !== output) {
    throw new Error(
      `README.md's storehouse status sample isn't the CLI's output, which is:\n${output}`,
    );
  }
};

const getStatusSample = async () => {
  const fake = await fakeSecretManager();
  const cwd = createRepoForTest(statusManifest);
  try {
    const now = createIoForTest({ cwd }).io.now();
    for (const { name, daysAgo } of statusSeeds) {
      fake.seed(statusManifest.project, name, 'sample value');
      const version = fake.secrets.get(`${statusManifest.project}/${name}`)
        ?.versions[0];
      if (!version) throw new Error(`The fake didn't store ${name}.`);
      version.created = new Date(now.getTime() - daysAgo * dayMs).toISOString();
    }
    const { code, stdout } = await runStorehouse(['status'], { cwd, fake });
    const output = stdout.trimEnd();
    assertReadmeStatus(output);
    return { command: 'storehouse status', output, code };
  } finally {
    await fake.close();
    rmSync(cwd, { recursive: true, force: true });
  }
};

// the storehouse.json from the README's Quickstart, refused unless `storehouse check` passes it
const getQuickstartManifest = async () => {
  const [, block = ''] =
    /```json\n([\s\S]*?)\n *```/.exec(
      readmeService.getSectionText('Quickstart'),
    ) ?? [];
  const manifest = block.replace(/^ {3}/gm, '');
  const cwd = createRepoForTest(JSON.parse(manifest));
  try {
    const { code } = await runStorehouse(['check'], { cwd });
    if (code !== ExitCode.ok) {
      throw new Error(
        "storehouse check refuses the README's Quickstart manifest.",
      );
    }
    return manifest;
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
};

// The README's first install line, without its comment. The OG card has it baked in, so the
// brand kit's build script must say the same.
const getInstallCommand = () => {
  const [, block = ''] =
    /```sh\n([\s\S]*?)\n```/.exec(readmeService.getSectionText('Install')) ??
    [];
  const [firstLine = ''] = block.split('\n');
  const command = firstLine.replace(/#.*$/, '').trim();
  if (command === '') throw new Error("README.md's Install has no command.");
  if (!readFileSync(brandBuildUrl, 'utf8').includes(`'${command}'`)) {
    throw new Error(
      `brand/build.mjs doesn't draw "${command}" on the OG card. Change it, rebuild the kit and copy social/og-image.png.`,
    );
  }
  return command;
};

// The meanings are the README's; the codes must be exactly the ones the CLI exits with.
const getExitCodes = () => {
  const section = readmeService.getSectionText('Exit codes');
  const rows = [...section.matchAll(/^\| (\d+) \| (.+) \|$/gm)].map(
    ([, code = '', meaning = '']) => ({
      code: Number(code),
      meaning: readmeService.parseInline(meaning),
    }),
  );
  const documented = rows.map((r) => r.code).join(',');
  const exited = Object.values(ExitCode).join(',');
  if (documented !== exited) {
    throw new Error(
      `README.md's exit codes (${documented}) aren't the CLI's (${exited}).`,
    );
  }
  return rows;
};

// The README's own words for each section the site shows, so an edit there fails the check here.
const getReadmeBlocks = () => {
  const why = readmeService.getSectionBlocks('Why');
  const [whyIntro] = why;
  const whyTable = why.find((block) => block.kind === 'table');
  if (whyIntro?.kind !== 'paragraph' || !whyTable) {
    throw new Error("README.md's Why lost its first paragraph or its table.");
  }
  return {
    install: readmeService
      .getSectionBlocks('Install')
      .filter((block) => block.kind === 'paragraph'),
    quickstart: readmeService.getSectionBlocks('Quickstart'),
    commands: readmeService.getSectionBlocks('Commands').slice(0, 1),
    agents: readmeService.getSectionBlocks('Working with coding agents'),
    protectedEnvs: readmeService.getSectionBlocks('Protected environments'),
    why: [whyIntro, whyTable],
  };
};

const prepareCliDocs = async () => {
  const names = await getCommandNames();
  const commands = [];
  for (const name of names) commands.push(await getCommandHelp(name));
  const docs = {
    install: getInstallCommand(),
    commands,
    status: await getStatusSample(),
    quickstartManifest: await getQuickstartManifest(),
    exitCodes: getExitCodes(),
    readme: getReadmeBlocks(),
  };
  return `${JSON.stringify(docs, null, 2)}\n`;
};

const handleCliDocs = async () => {
  const { values } = parseArgs({ options: { check: { type: 'boolean' } } });
  const docs = await prepareCliDocs();
  if (values.check !== true) {
    writeFileSync(outputUrl, docs);
    return;
  }
  const existing = readFileSync(outputUrl, 'utf8');
  if (existing === docs) return;
  console.error(
    'site/src/generated/cli-docs.json is stale: the CLI or README changed. Run pnpm --filter storehouse-site run docs.',
  );
  process.exitCode = 1;
};

await handleCliDocs();
