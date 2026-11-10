import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import {
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseEnv } from 'node:util';
import { createCredentials } from '../src/secret-manager/credentials.ts';
import { secretManagerUrl } from '../src/secret-manager/secret-manager-api.ts';

// Runs storehouse against a real Google Cloud project with throwaway secrets, then deletes them,
// even when a step fails. STOREHOUSE_LIVE_PROJECT names the project. No value is ever printed.

const project = process.env.STOREHOUSE_LIVE_PROJECT;
if (!project) {
  console.error(
    'Set STOREHOUSE_LIVE_PROJECT to a Google Cloud project you can create secrets in.',
  );
  process.exit(2);
}

const prefix = `storehouse-live-${randomBytes(4).toString('hex')}`;
const cli = new URL('../src/cli.ts', import.meta.url).pathname;
const repo = mkdtempSync(join(tmpdir(), 'storehouse-live-'));
writeFileSync(
  join(repo, 'storehouse.json'),
  JSON.stringify({
    project,
    name: `${prefix}-{env}-{key}`,
    envs: { live: { pull: { file: '.env.live' } } },
    secrets: {
      FIRST: { purpose: 'A throwaway for the live test.' },
      SECOND: { purpose: 'Another throwaway, never set.' },
    },
  }),
);
const valueOne = `live-${randomBytes(12).toString('hex')}`;
const valueTwo = `live-${randomBytes(12).toString('hex')}\nwith a second line`;

const runStorehouse = (args: string[], input?: string) => {
  const ran = spawnSync(process.execPath, [cli, ...args], {
    cwd: repo,
    input: input ?? '',
    encoding: 'utf8',
  });
  for (const value of [valueOne, valueTwo]) {
    const isPrinting = args[0] === 'get' && !args.includes('--out');
    if (!isPrinting && `${ran.stdout}${ran.stderr}`.includes(value)) {
      throw new Error(`storehouse ${args.join(' ')} printed a value`);
    }
  }
  return ran;
};

const steps: [string, () => void][] = [
  [
    'status shows both missing',
    () => {
      const ran = runStorehouse(['status']);
      if (ran.status !== 0 || (ran.stdout.match(/missing/g) ?? []).length !== 2)
        throw new Error(ran.stderr);
    },
  ],
  [
    'set creates a new secret',
    () => {
      const ran = runStorehouse(['set', 'live', 'FIRST'], `${valueOne}\n`);
      if (ran.status !== 0 || !/Created .* version 1\./s.test(ran.stdout))
        throw new Error(ran.stderr);
    },
  ],
  [
    'set leaves an unchanged value alone',
    () => {
      const ran = runStorehouse(['set', 'live', 'FIRST'], valueOne);
      if (ran.status !== 0 || !/already has this value/.test(ran.stdout))
        throw new Error(ran.stderr);
    },
  ],
  [
    'set adds a version for a changed value',
    () => {
      const ran = runStorehouse(['set', 'live', 'FIRST'], valueTwo);
      if (ran.status !== 0 || !/version 2\./.test(ran.stdout))
        throw new Error(ran.stderr);
    },
  ],
  [
    'get prints the value exactly',
    () => {
      const ran = runStorehouse(['get', 'live', 'FIRST']);
      if (ran.status !== 0 || ran.stdout !== valueTwo)
        throw new Error('the value came back different');
    },
  ],
  [
    'get --out writes it, 0600',
    () => {
      const ran = runStorehouse(['get', 'live', 'FIRST', '--out', 'first.txt']);
      const path = join(repo, 'first.txt');
      if (
        ran.status !== 0 ||
        readFileSync(path, 'utf8') !== valueTwo ||
        (statSync(path).mode & 0o777) !== 0o600
      ) {
        throw new Error(ran.stderr);
      }
    },
  ],
  [
    'history lists both versions',
    () => {
      const ran = runStorehouse(['history', 'live', 'FIRST', '--json']);
      if (ran.status !== 0 || !ran.stdout.includes('"total": 2'))
        throw new Error(ran.stderr);
    },
  ],
  [
    'history of the env lists them and the missing one',
    () => {
      const ran = runStorehouse(['history', 'live']);
      if (ran.status !== 0 || !/SECOND +- +missing/.test(ran.stdout))
        throw new Error(ran.stderr);
    },
  ],
  [
    'status shows the set one',
    () => {
      const ran = runStorehouse(['status', '--json']);
      if (ran.status !== 0 || !ran.stdout.includes('"state": "set"'))
        throw new Error(ran.stderr);
    },
  ],
  [
    'pull writes a file that reads back exactly',
    () => {
      const ran = runStorehouse(['pull', 'live']);
      const pulled = parseEnv(readFileSync(join(repo, '.env.live'), 'utf8'));
      if (ran.status !== 0 || pulled.FIRST !== valueTwo)
        throw new Error(ran.stderr);
    },
  ],
];

const deleteThrowaways = async () => {
  const credentials = createCredentials({ env: process.env });
  const { token } = await credentials.getToken();
  for (const key of ['FIRST', 'SECOND']) {
    const name = `${prefix}-live-${key}`;
    // only ever this run's own throwaways
    if (!name.startsWith('storehouse-live-')) continue;
    const resp = await fetch(
      `${secretManagerUrl}/projects/${project}/secrets/${name}`,
      {
        method: 'DELETE',
        headers: { authorization: `Bearer ${token}` },
      },
    );
    if (resp.ok) console.log(`deleted ${name}`);
    else if (resp.status !== 404)
      console.error(
        `couldn't delete ${name} (${resp.status}): delete it by hand`,
      );
  }
};

let failures = 0;
try {
  for (const [name, step] of steps) {
    try {
      step();
      console.log(`ok    ${name}`);
    } catch (error) {
      failures++;
      console.log(
        `FAIL  ${name}: ${error instanceof Error ? error.message.split('\n')[0] : 'failed'}`,
      );
    }
  }
} finally {
  await deleteThrowaways();
  rmSync(repo, { recursive: true, force: true });
}
console.log(
  failures === 0
    ? `all ${steps.length} steps passed against ${project}`
    : `${failures} of ${steps.length} steps failed`,
);
process.exitCode = failures === 0 ? 0 : 1;
