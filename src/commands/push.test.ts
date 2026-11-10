import assert from 'node:assert/strict';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { after, before, beforeEach, describe, it } from 'node:test';
import { ExitCode } from '../errors.ts';
import { fakeSecretManager } from '../testing/fake-secret-manager.ts';
import type { Fake } from '../testing/fake-secret-manager.ts';
import {
  createRepoForTest,
  fakeManifest,
  runStorehouseForTest,
} from '../testing/storehouse-for-test.ts';

const project = 'acme-test';
let fake: Fake;

before(async () => {
  fake = await fakeSecretManager({ pageSize: 2 });
});
after(async () => {
  await fake.close();
});
beforeEach(() => {
  fake.reset();
});

const accessed = () => fake.requests.filter((r) => r.path.endsWith(':access'));

// a push whose repo-local wrangler, the test's fake, a person has trusted
const runPushForTest = (
  argv: string[],
  options: Parameters<typeof runStorehouseForTest>[1],
) => runStorehouseForTest(argv, { trusts: 'all', ...options });

describe('push', () => {
  // A wrangler in the Worker's node_modules that records its arguments, directory and stdin.
  const fakeWrangler = (
    cwd: string,
    exit = 0,
    says = 'Finished processing secrets file:',
  ) => {
    const bin = join(cwd, 'worker/node_modules/.bin');
    mkdirSync(bin, { recursive: true });
    const log = join(cwd, 'wrangler.log');
    writeFileSync(
      join(bin, 'wrangler'),
      `#!/bin/sh\n{ echo "$PWD"; echo "$@"; cat; echo; } >> '${log}'\necho '${says}'\nexit ${exit}\n`,
    );
    chmodSync(join(bin, 'wrangler'), 0o755);
    return () => (existsSync(log) ? readFileSync(log, 'utf8') : '');
  };

  it("sends the env's secrets in one wrangler secret bulk, on stdin", async () => {
    const cwd = createRepoForTest();
    const log = fakeWrangler(cwd);
    fake.seed(project, 'acme-stage-AUTH_SECRET', 'auth\n');
    fake.seed(project, 'acme-stage-TWILIO_SID', 'AC1');
    const r = await runPushForTest(['push', 'stage'], { cwd, fake });
    assert.equal(r.code, 0, r.stderr());
    const [dir, args, stdin] = log().split('\n');
    assert.match(dir ?? '', /\/worker$/);
    assert.equal(args, 'secret bulk --env=stage');
    assert.deepEqual(JSON.parse(stdin ?? ''), {
      AUTH_SECRET: 'auth',
      TWILIO_SID: 'AC1',
    });
    assert.match(
      r.stdout(),
      /Sent 2 secrets from stage to cloudflare-workers in worker \(--env stage\): AUTH_SECRET, TWILIO_SID\./,
    );
    assert.doesNotMatch(r.stdout() + r.stderr(), /AC1/);
  });

  it('sends only the keys named, and skips a missing optional one', async () => {
    const cwd = createRepoForTest();
    const log = fakeWrangler(cwd);
    fake.seed(project, 'acme-stage-AUTH_SECRET', 'auth');
    const r = await runPushForTest(['push', 'stage', 'AUTH_SECRET'], {
      cwd,
      fake,
    });
    assert.equal(r.code, 0, r.stderr());
    assert.deepEqual(JSON.parse(log().split('\n')[2] ?? ''), {
      AUTH_SECRET: 'auth',
    });
    const all = await runPushForTest(['push', 'stage'], { cwd, fake });
    assert.match(all.stdout(), /Not set in stage, so skipped: TWILIO_SID\./);
  });

  it('stops when a key it was asked for is missing', async () => {
    const cwd = createRepoForTest();
    const log = fakeWrangler(cwd);
    fake.seed(project, 'acme-stage-AUTH_SECRET', 'auth');
    const r = await runPushForTest(
      ['push', 'stage', 'AUTH_SECRET', 'TWILIO_SID'],
      {
        cwd,
        fake,
      },
    );
    assert.equal(r.code, ExitCode.missing);
    assert.match(
      r.stderr(),
      /1 secret you named is missing in stage, so nothing was sent\. Set it first:\n {2}storehouse set stage TWILIO_SID/,
    );
    assert.equal(log(), '');
  });

  it('stops before sending when a required secret is missing', async () => {
    const cwd = createRepoForTest();
    const log = fakeWrangler(cwd);
    fake.seed(project, 'acme-stage-TWILIO_SID', 'AC1');
    const r = await runPushForTest(['push', 'stage'], { cwd, fake });
    assert.equal(r.code, ExitCode.missing);
    assert.match(r.stderr(), /missing in stage, so nothing was sent/);
    assert.equal(log(), '');
  });

  it('shows what would go where with --dry-run, reading no values', async () => {
    const cwd = createRepoForTest();
    const log = fakeWrangler(cwd);
    fake.seed(project, 'acme-stage-AUTH_SECRET', 'auth');
    const r = await runPushForTest(['push', '--dry-run', 'stage'], {
      cwd,
      fake,
    });
    assert.equal(r.code, 0);
    assert.equal(
      r.stdout(),
      `Would send 1 secret from stage to cloudflare-workers in worker (--env stage):\n  AUTH_SECRET\n  using wrangler at ${realpathSync(join(cwd, 'worker/node_modules/.bin/wrangler'))}\n  $ node_modules/.bin/wrangler secret bulk --env=stage < (the values as JSON, on stdin)\nNot set in stage, so skipped: TWILIO_SID.\n`,
    );
    assert.deepEqual(accessed(), []);
    assert.equal(log(), '');
  });

  it("refuses a key that isn't pushed", async () => {
    const manifest = {
      ...fakeManifest(),
      secrets: {
        ...fakeManifest().secrets,
        LOCAL: { purpose: 'x', push: false },
      },
    };
    const r = await runPushForTest(['push', 'stage', 'LOCAL'], {
      cwd: createRepoForTest(manifest),
      fake,
    });
    assert.equal(r.code, ExitCode.usage);
    assert.match(r.stderr(), /LOCAL has "push": false/);
  });

  it('escapes U+2028 and U+2029, which wrangler would read as line breaks', async () => {
    const cwd = createRepoForTest();
    const log = fakeWrangler(cwd);
    fake.seed(project, 'acme-stage-AUTH_SECRET', 'a\u2028b\u2029c');
    const r = await runPushForTest(['push', 'stage', 'AUTH_SECRET'], {
      cwd,
      fake,
    });
    assert.equal(r.code, 0, r.stderr());
    const stdin = log().split('\n')[2] ?? '';
    assert.doesNotMatch(stdin, /[\u2028\u2029]/);
    assert.deepEqual(JSON.parse(stdin), { AUTH_SECRET: 'a\u2028b\u2029c' });
  });

  it('fails when wrangler exits 0 without saying it uploaded', async () => {
    const cwd = createRepoForTest();
    fakeWrangler(cwd, 0, 'No content found in file, or piped input.');
    fake.seed(project, 'acme-stage-AUTH_SECRET', 'auth');
    const r = await runPushForTest(['push', 'stage'], { cwd, fake });
    assert.equal(r.code, ExitCode.failed);
    assert.match(
      r.stderr(),
      /No content found[\s\S]*exited without saying it sent the values/,
    );
    assert.doesNotMatch(r.stdout(), /Sent/);
  });

  it("reports wrangler's failure", async () => {
    const cwd = createRepoForTest();
    fakeWrangler(cwd, 3);
    fake.seed(project, 'acme-stage-AUTH_SECRET', 'auth');
    const r = await runPushForTest(['push', 'stage'], { cwd, fake });
    assert.equal(r.code, ExitCode.failed);
    assert.match(
      r.stderr(),
      /`wrangler secret bulk --env=stage` failed in .*worker \(exit 3\)/,
    );
  });

  it("says so when wrangler isn't installed", async () => {
    const cwd = createRepoForTest();
    fake.seed(project, 'acme-stage-AUTH_SECRET', 'auth');
    const r = await runPushForTest(['push', 'stage'], {
      cwd,
      fake,
      env: { PATH: '/nonexistent' },
    });
    assert.equal(r.code, ExitCode.failed);
    assert.match(
      r.stderr(),
      /wrangler isn't installed in .*worker or on your PATH/,
    );
  });

  it('needs a push target for the env', async () => {
    const r = await runPushForTest(['push', 'dev'], {
      cwd: createRepoForTest(),
      fake,
    });
    assert.equal(r.code, ExitCode.usage);
    assert.match(r.stderr(), /dev has nowhere to push/);
  });
});
