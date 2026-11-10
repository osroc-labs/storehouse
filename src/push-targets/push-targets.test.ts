import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, beforeEach, describe, it } from 'node:test';
import { ExitCode } from '../errors.ts';
import { FakeCliBehaviour, createFakeCliForTest } from '../testing/fake-cli.ts';
import { fakeSecretManager } from '../testing/fake-secret-manager.ts';
import type { Fake } from '../testing/fake-secret-manager.ts';
import {
  createRepoForTest,
  fakeManifest,
  runStorehouseForTest,
} from '../testing/storehouse-for-test.ts';
import { flyTarget } from './fly.ts';

const project = 'acme-test';
let fake: Fake;

before(async () => {
  fake = await fakeSecretManager();
});
after(async () => {
  await fake.close();
});
beforeEach(() => {
  fake.reset();
});

const authValue = 'auth-value-1234\nsecond line';
const sidValue = 'AC-sid-value-5678';

// a repo whose stage pushes to one target, a bin dir for the fake CLI, and the two secrets set
const setUpForTest = (target: Record<string, unknown>) => {
  const binDir = mkdtempSync(join(tmpdir(), 'storehouse-bin-'));
  const manifest = fakeManifest();
  const cwd = createRepoForTest({
    ...manifest,
    envs: { ...manifest.envs, stage: { push: [target] } },
  });
  fake.seed(project, 'acme-stage-AUTH_SECRET', authValue);
  fake.seed(project, 'acme-stage-TWILIO_SID', sidValue);
  return { cwd, binDir, env: { PATH: binDir } };
};

const pushForTest = ({ cwd, env }: { cwd: string; env: { PATH: string } }) =>
  runStorehouseForTest(['push', 'stage'], { cwd, fake, env });

// ports flyctl's parser (internal/command/secrets/parser.go), to read back what storehouse writes
const parseFlyImportForTest = (text: string) => {
  const secrets: Record<string, string> = {};
  let multilineKey: string | undefined;
  let multilineValue = '';
  for (const line of text.split('\n')) {
    if (multilineKey !== undefined) {
      if (line.endsWith('"""')) {
        secrets[multilineKey] = multilineValue + line.slice(0, -3);
        multilineKey = undefined;
        multilineValue = '';
      } else {
        multilineValue += `${line}\n`;
      }
      continue;
    }
    if (line.startsWith('#') || line.trim() === '') continue;
    const at = line.indexOf('=');
    const key = line.slice(0, at).trim();
    let value = line.slice(at + 1).replace(/^ +/, '');
    const hashAt = value.indexOf('#');
    if (hashAt !== -1 && value.slice(0, hashAt).split('"').length % 2 === 1) {
      value = value.slice(0, hashAt).replace(/ +$/, '');
    }
    if (value.startsWith('"""') && value.endsWith('"""') && value.length >= 6) {
      secrets[key] = value.slice(3, -3);
    } else if (value.startsWith('"""')) {
      multilineKey = key;
      multilineValue = `${value.slice(3)}\n`;
    } else {
      secrets[key] = value;
    }
  }
  return secrets;
};

describe('push targets', () => {
  it('sends GitHub Actions secrets one gh secret set at a time, values on stdin only', async () => {
    const setup = setUpForTest({
      to: 'github-actions',
      repo: 'acme/app',
      environment: 'staging',
    });
    const getRuns = createFakeCliForTest({ binDir: setup.binDir, name: 'gh' });
    fake.seed(project, 'acme-stage-AUTH_SECRET', 'single-line-auth-value');
    const r = await pushForTest(setup);
    assert.equal(r.code, ExitCode.ok, r.stderr());
    assert.deepEqual(
      getRuns().map((run) => ({ argv: run.argv, stdin: run.stdin })),
      [
        {
          argv: [
            'secret',
            'set',
            'AUTH_SECRET',
            '--repo=acme/app',
            '--env=staging',
          ],
          stdin: 'single-line-auth-value',
        },
        {
          argv: [
            'secret',
            'set',
            'TWILIO_SID',
            '--repo=acme/app',
            '--env=staging',
          ],
          stdin: sidValue,
        },
      ],
    );
    assert.match(
      r.stdout(),
      /Sent 2 secrets from stage to github-actions in acme\/app \(environment staging\)/,
    );
  });

  it('sets organization secrets with their visibility', async () => {
    const setup = setUpForTest({
      to: 'github-actions',
      org: 'acme',
      visibility: 'selected',
      repos: ['app', 'api'],
    });
    const getRuns = createFakeCliForTest({ binDir: setup.binDir, name: 'gh' });
    fake.seed(project, 'acme-stage-AUTH_SECRET', 'single-line-auth-value');
    const r = await pushForTest(setup);
    assert.equal(r.code, ExitCode.ok, r.stderr());
    assert.deepEqual(getRuns()[0]?.argv, [
      'secret',
      'set',
      'AUTH_SECRET',
      '--org=acme',
      '--visibility=selected',
      '--repos=app,api',
    ]);
  });

  it('refuses, before sending anything, a value gh would change', async () => {
    const setup = setUpForTest({ to: 'github-actions' });
    const getRuns = createFakeCliForTest({ binDir: setup.binDir, name: 'gh' });
    fake.seed(project, 'acme-stage-TWILIO_SID', 'ends-with-two-newlines\n\n');
    const r = await pushForTest(setup);
    assert.equal(r.code, ExitCode.failed);
    assert.match(
      r.stderr(),
      /TWILIO_SID: gh secret set can't take this value as it is \(gh drops a trailing line break\), so nothing was sent anywhere/,
    );
    assert.deepEqual(getRuns(), []);
  });

  it('sends Vercel variables with --force, each value exactly as it is', async () => {
    const setup = setUpForTest({
      to: 'vercel',
      environments: ['production', 'preview'],
      scope: 'acme-team',
    });
    const getRuns = createFakeCliForTest({
      binDir: setup.binDir,
      name: 'vercel',
    });
    const r = await pushForTest(setup);
    assert.equal(r.code, ExitCode.ok, r.stderr());
    const [first] = getRuns();
    assert.ok(first);
    assert.deepEqual(first.argv, [
      'env',
      'add',
      'AUTH_SECRET',
      '--environment=production,preview',
      '--force',
      '--yes',
      '--scope=acme-team',
    ]);
    assert.equal(first.stdin, authValue);
  });

  it('refuses, in check, every target field that a CLI could read as a flag', async () => {
    for (const target of [
      { to: 'github-actions', environment: '--repo=attacker/app' },
      { to: 'github-actions', org: '-x' },
      { to: 'github-actions', repo: '-x/app' },
      {
        to: 'github-actions',
        org: 'acme',
        visibility: 'selected',
        repos: ['--x'],
      },
      { to: 'vercel', environments: ['--cwd=/tmp'] },
      { to: 'vercel', environments: ['preview'], scope: '--cwd=/tmp' },
      { to: 'fly', app: '--config=/tmp/x' },
      { to: 'cloudflare-workers', wranglerEnv: '--name=other' },
    ]) {
      const setup = setUpForTest(target);
      const r = await runStorehouseForTest(['check'], { cwd: setup.cwd });
      assert.equal(r.code, ExitCode.manifest, JSON.stringify(target));
    }
  });

  it('refuses, before sending anything, a one-line value vercel would trim', async () => {
    const setup = setUpForTest({ to: 'vercel', environments: ['preview'] });
    const getRuns = createFakeCliForTest({
      binDir: setup.binDir,
      name: 'vercel',
    });
    fake.seed(project, 'acme-stage-TWILIO_SID', 'one-line-value\n\n');
    const r = await pushForTest(setup);
    assert.equal(r.code, ExitCode.failed);
    assert.match(
      r.stderr(),
      /TWILIO_SID: vercel env add can't take this value as it is \(vercel drops the line break at the end of a one-line value\)/,
    );
    assert.deepEqual(getRuns(), []);
  });

  it('sends Fly secrets in one fly secrets import that flyctl reads back exactly', async () => {
    const setup = setUpForTest({ to: 'fly', app: 'acme-api', stage: true });
    const getRuns = createFakeCliForTest({ binDir: setup.binDir, name: 'fly' });
    const r = await pushForTest(setup);
    assert.equal(r.code, ExitCode.ok, r.stderr());
    const [onlyRun, ...otherRuns] = getRuns();
    assert.ok(onlyRun);
    assert.deepEqual(otherRuns, []);
    assert.deepEqual(onlyRun.argv, [
      'secrets',
      'import',
      '--app=acme-api',
      '--stage',
    ]);
    assert.deepEqual(parseFlyImportForTest(onlyRun.stdin), {
      AUTH_SECRET: authValue,
      TWILIO_SID: sidValue,
    });
  });

  it('writes Fly values flyctl reads back, and refuses those it would change', () => {
    const readable = {
      PLAIN: 'abc',
      EMPTY: '',
      QUOTES: 'say "hi" and \'bye\'',
      HASH: 'a # b',
      PEM: '-----BEGIN KEY-----\nabc\n-----END KEY-----\n',
      TRIPLE_END: 'ends with """',
      SPACES: '  padded  ',
    };
    assert.deepEqual(
      parseFlyImportForTest(flyTarget.utils.formatFlyImport(readable)),
      readable,
    );
    for (const value of ['a\r\nb', '"#x', 'one"""\ntwo', 'x'.repeat(70_000)]) {
      assert.throws(
        () => flyTarget.utils.formatFlyImport({ K: value }),
        /K: fly secrets import can't take this value/,
      );
    }
  });

  for (const [target, name, installHint] of [
    [
      { to: 'github-actions' },
      'gh',
      /gh isn't installed .* Install the GitHub CLI/,
    ],
    [
      { to: 'vercel', environments: ['production'] },
      'vercel',
      /vercel isn't installed .* Install the Vercel CLI/,
    ],
    [{ to: 'fly' }, 'fly', /fly isn't installed .* Install flyctl/],
    [
      { to: 'cloudflare-workers' },
      'wrangler',
      /wrangler isn't installed .* Add wrangler/,
    ],
  ] as const) {
    it(`names how to install ${name} when it's missing`, async () => {
      const setup = setUpForTest(target);
      const r = await pushForTest(setup);
      assert.equal(r.code, ExitCode.failed);
      assert.match(r.stderr(), installHint);
    });

    it(`shows ${name}'s own words and the login fix when it isn't logged in`, async () => {
      const setup = setUpForTest(target);
      createFakeCliForTest({
        binDir: setup.binDir,
        name,
        behaviour: FakeCliBehaviour.notLoggedIn,
      });
      const r = await pushForTest(setup);
      assert.equal(r.code, ExitCode.failed);
      assert.match(
        r.stderr(),
        /You are not logged in\.[\s\S]*failed in .* \(exit 1\)\. Its output is above\. .*log/,
      );
    });

    it(`reports ${name} exiting non-zero`, async () => {
      const setup = setUpForTest(target);
      createFakeCliForTest({
        binDir: setup.binDir,
        name,
        behaviour: FakeCliBehaviour.fails,
      });
      const r = await pushForTest(setup);
      assert.equal(r.code, ExitCode.failed);
      assert.match(r.stderr(), /Something went wrong\.[\s\S]*\(exit 3\)/);
      assert.doesNotMatch(r.stdout(), /Sent/);
    });
  }

  it('fails when wrangler stops partway and exits 0', async () => {
    const setup = setUpForTest({ to: 'cloudflare-workers' });
    createFakeCliForTest({
      binDir: setup.binDir,
      name: 'wrangler',
      behaviour: FakeCliBehaviour.partial,
    });
    const r = await pushForTest(setup);
    assert.equal(r.code, ExitCode.failed);
    assert.match(r.stderr(), /exited without saying it sent the values/);
  });

  it('says which secrets went before a per-secret CLI failed partway', async () => {
    const setup = setUpForTest({ to: 'vercel', environments: ['production'] });
    createFakeCliForTest({
      binDir: setup.binDir,
      name: 'vercel',
      behaviour: FakeCliBehaviour.failsSecond,
    });
    const r = await pushForTest(setup);
    assert.equal(r.code, ExitCode.failed);
    assert.match(
      r.stderr(),
      /Already sent before it failed: vercel in \. \(production\): AUTH_SECRET\./,
    );
  });

  it('shows each command with --dry-run, and runs none', async () => {
    const setup = setUpForTest({ to: 'github-actions', repo: 'acme/app' });
    const getRuns = createFakeCliForTest({ binDir: setup.binDir, name: 'gh' });
    const r = await runStorehouseForTest(['push', 'stage', '--dry-run'], {
      cwd: setup.cwd,
      fake,
      env: setup.env,
    });
    assert.equal(r.code, ExitCode.ok);
    assert.match(
      r.stdout(),
      /\$ gh secret set AUTH_SECRET --repo=acme\/app < \(the value of AUTH_SECRET, on stdin\)/,
    );
    assert.deepEqual(getRuns(), []);
  });
});
