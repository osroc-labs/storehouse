import assert from 'node:assert/strict';
import { stripVTControlCharacters, styleText } from 'node:util';
import { after, before, beforeEach, describe, it } from 'node:test';
import { ExitCode } from '../errors.ts';
import { fakeSecretManager } from '../testing/fake-secret-manager.ts';
import type { Fake } from '../testing/fake-secret-manager.ts';
import {
  createRepoForTest,
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

describe('status', () => {
  it('shows each secret in each env, leaving out protected envs', async () => {
    fake.seed(project, 'acme-dev-AUTH_SECRET', 'x');
    fake.seed(project, 'acme-dev-SEED_TOKEN', 'x');
    fake.seed(project, 'acme-stage-AUTH_SECRET', 'x', 'DISABLED');
    const r = await runStorehouseForTest(['status'], {
      cwd: createRepoForTest(),
      fake,
    });
    assert.equal(r.code, ExitCode.missing);
    const lines = r.stdout().split('\n');
    assert.match(lines[0] ?? '', /^ +dev +stage +purpose$/);
    assert.match(
      lines[1] ?? '',
      /^AUTH_SECRET +set 3d ago +MISSING +Signs session cookies\.$/,
    );
    assert.match(lines[2] ?? '', /^TWILIO_SID +missing +missing +The Twilio/);
    assert.match(lines[3] ?? '', /^SEED_TOKEN +set 3d ago +- +The sandbox/);
    assert.match(
      r.stdout(),
      /prod is protected and not shown\. Name it to include it: storehouse status dev stage prod/,
    );
    assert.match(
      r.stdout(),
      /1 required secret is missing:\n {2}storehouse set stage AUTH_SECRET/,
    );
    assert.ok(fake.requests.every((q) => !q.path.includes('acme-prod')));
    assert.deepEqual(accessed(), []);
  });

  it('exits 0 when every required secret is set', async () => {
    fake.seed(project, 'acme-dev-AUTH_SECRET', 'x');
    const r = await runStorehouseForTest(['status', 'dev'], {
      cwd: createRepoForTest(),
      fake,
    });
    assert.equal(r.code, 0);
    assert.doesNotMatch(r.stdout(), /protected/);
  });

  it('prints JSON with --json', async () => {
    fake.seed(project, 'acme-dev-AUTH_SECRET', 'x');
    const r = await runStorehouseForTest(['status', '--json'], {
      cwd: createRepoForTest(),
      fake,
    });
    const parsed: unknown = JSON.parse(r.stdout());
    assert.deepEqual(parsed, {
      envs: ['dev', 'stage'],
      secrets: [
        {
          key: 'AUTH_SECRET',
          purpose: 'Signs session cookies.',
          required: true,
          envs: {
            dev: {
              state: 'set',
              name: 'acme-dev-AUTH_SECRET',
              project,
              version: 1,
              updated: '2026-01-01T00:01:00.000Z',
            },
            stage: {
              state: 'missing',
              name: 'acme-stage-AUTH_SECRET',
              project,
            },
          },
        },
        {
          key: 'TWILIO_SID',
          purpose: 'The Twilio account that texts sign-in codes.',
          required: false,
          envs: {
            dev: { state: 'missing', name: 'acme-dev-TWILIO_SID', project },
            stage: { state: 'missing', name: 'acme-stage-TWILIO_SID', project },
          },
        },
        {
          key: 'SEED_TOKEN',
          purpose: "The sandbox seller's token, for the seed script.",
          required: false,
          envs: {
            dev: { state: 'missing', name: 'acme-dev-SEED_TOKEN', project },
            stage: { state: 'unused' },
          },
        },
      ],
      missingRequired: [{ key: 'AUTH_SECRET', env: 'stage' }],
      protectedLeftOut: ['prod'],
    });
  });

  it('cuts purposes to the terminal width, in colour', async () => {
    const r = await runStorehouseForTest(['status', 'dev'], {
      cwd: createRepoForTest(),
      fake,
      tty: true,
      columns: 40,
    });
    for (const line of stripVTControlCharacters(r.stdout()).split('\n')) {
      assert.ok(line.length <= 40, line);
    }
    assert.ok(
      r
        .stdout()
        .includes(styleText('red', 'MISSING', { validateStream: false })),
    );
    assert.match(r.stdout(), /…/);
  });

  it('shows a secret Google refuses as no access, keeps the rest, and names the fix', async () => {
    fake.seed(project, 'acme-dev-AUTH_SECRET', 'x');
    fake.denySecret(project, 'acme-dev-TWILIO_SID');
    const r = await runStorehouseForTest(['status', 'dev'], {
      cwd: createRepoForTest(),
      fake,
    });
    assert.equal(r.code, ExitCode.failed);
    assert.match(r.stdout(), /AUTH_SECRET +set 3d ago/);
    assert.match(r.stdout(), /TWILIO_SID +no access/);
    assert.equal(
      r.stderr(),
      'Google refused to show 1 secret: TWILIO_SID in dev. You need Secret Manager Viewer on acme-test to see them.\n',
    );
  });

  it('names the fix for a bad token', async () => {
    const r = await runStorehouseForTest(['status', 'dev'], {
      cwd: createRepoForTest(),
      fake,
      token: 'expired',
    });
    assert.equal(r.code, ExitCode.failed);
    assert.match(
      r.stderr(),
      /Google didn't accept the access token[\s\S]*gcloud auth login/,
    );
  });
});
