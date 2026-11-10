import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, it } from 'node:test';
import { ExitCode } from '../errors.ts';
import { fakeSecretManager } from '../testing/fake-secret-manager.ts';
import type { Fake } from '../testing/fake-secret-manager.ts';
import {
  createRepoForTest,
  runStorehouseForTest,
} from '../testing/storehouse-for-test.ts';

const project = 'acme-test';
// history shows times in the person's own zone; the tests pin one
process.env.TZ = 'UTC';

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

describe('history', () => {
  it('lists every version, newest first, across pages, without values', async () => {
    for (const v of ['a', 'b', 'c'])
      fake.seed(project, 'acme-dev-AUTH_SECRET', v);
    const r = await runStorehouseForTest(
      ['history', 'dev', 'AUTH_SECRET', '--json'],
      {
        cwd: createRepoForTest(),
        fake,
      },
    );
    assert.equal(r.code, 0);
    const parsed: unknown = JSON.parse(r.stdout());
    assert.deepEqual(parsed, {
      key: 'AUTH_SECRET',
      env: 'dev',
      project,
      name: 'acme-dev-AUTH_SECRET',
      versions: [3, 2, 1].map((n) => ({
        number: n,
        created: `2026-01-01T00:0${n}:00.000Z`,
        state: 'ENABLED',
      })),
      total: 3,
    });
    assert.equal(fake.requests.length, 2);
    assert.deepEqual(accessed(), []);
  });

  it('prints a table', async () => {
    fake.seed(project, 'acme-dev-AUTH_SECRET', 'a', 'DISABLED');
    fake.seed(project, 'acme-dev-AUTH_SECRET', 'b');
    const r = await runStorehouseForTest(['history', 'dev', 'AUTH_SECRET'], {
      cwd: createRepoForTest(),
      fake,
    });
    assert.equal(
      r.stdout(),
      `AUTH_SECRET in dev: acme-dev-AUTH_SECRET in acme-test

version  state     added
2        enabled   Jan 1 00:02  3d ago
1        disabled  Jan 1 00:01  3d ago
`,
    );
  });

  it("lists every secret's versions in an env, newest first, missing ones last", async () => {
    fake.seed(project, 'acme-dev-AUTH_SECRET', 'a');
    fake.seed(project, 'acme-dev-SEED_TOKEN', 'b', 'DISABLED');
    fake.seed(project, 'acme-dev-AUTH_SECRET', 'c');
    fake.seed(project, 'acme-stage-TWILIO_SID', 'other env');
    const r = await runStorehouseForTest(['history', 'dev'], {
      cwd: createRepoForTest(),
      fake,
    });
    assert.equal(r.code, 0, r.stderr());
    assert.equal(
      r.stdout(),
      `added                key          version  state
Jan 1 00:03  3d ago  AUTH_SECRET  2        enabled
Jan 1 00:02  3d ago  SEED_TOKEN   1        disabled
Jan 1 00:01  3d ago  AUTH_SECRET  1        enabled
-                    TWILIO_SID   -        missing
`,
    );
    assert.deepEqual(accessed(), []);
    assert.ok(fake.requests.every((q) => !q.path.includes('acme-stage')));
  });

  it('caps the rows with --limit, 20 by default, and 0 for all', async () => {
    for (let i = 0; i < 25; i++)
      fake.seed(project, 'acme-dev-AUTH_SECRET', `v${i}`);
    const cwd = createRepoForTest();
    const rows = (out: string) =>
      out.split('\n').filter((l) => l.startsWith('Jan ')).length;
    const byDefault = await runStorehouseForTest(['history', 'dev'], {
      cwd,
      fake,
    });
    assert.equal(rows(byDefault.stdout()), 20);
    assert.match(
      byDefault.stdout(),
      /Showing the newest 20 of 25 versions\. --limit 0 shows them all\./,
    );
    assert.match(byDefault.stdout(), /TWILIO_SID +- +missing/);
    const three = await runStorehouseForTest(
      ['history', 'dev', '--limit', '3'],
      {
        cwd,
        fake,
      },
    );
    assert.equal(rows(three.stdout()), 3);
    const all = await runStorehouseForTest(['history', '--limit=0', 'dev'], {
      cwd,
      fake,
    });
    assert.equal(rows(all.stdout()), 25);
    assert.doesNotMatch(all.stdout(), /Showing/);
    const one = await runStorehouseForTest(
      ['history', 'dev', 'AUTH_SECRET', '--limit', '2', '--json'],
      { cwd, fake },
    );
    const parsed: unknown = JSON.parse(one.stdout());
    assert.ok(
      typeof parsed === 'object' &&
        parsed !== null &&
        'versions' in parsed &&
        'total' in parsed,
    );
    assert.ok(Array.isArray(parsed.versions));
    assert.equal(parsed.versions.length, 2);
    assert.equal(parsed.total, 25);
  });

  it("prints an env's history as JSON", async () => {
    fake.seed(project, 'acme-dev-AUTH_SECRET', 'a');
    const r = await runStorehouseForTest(['history', 'dev', '--json'], {
      cwd: createRepoForTest(),
      fake,
    });
    const parsed: unknown = JSON.parse(r.stdout());
    assert.deepEqual(parsed, {
      env: 'dev',
      versions: [
        {
          key: 'AUTH_SECRET',
          name: 'acme-dev-AUTH_SECRET',
          project,
          number: 1,
          state: 'ENABLED',
          created: '2026-01-01T00:01:00.000Z',
        },
      ],
      total: 1,
      missing: [
        { key: 'TWILIO_SID', project, name: 'acme-dev-TWILIO_SID' },
        { key: 'SEED_TOKEN', project, name: 'acme-dev-SEED_TOKEN' },
      ],
    });
  });

  it('keeps the protected-env rules for a whole env', async () => {
    const r = await runStorehouseForTest(['history', 'prod'], {
      cwd: createRepoForTest(),
      fake,
      tty: true,
      env: { CLAUDECODE: '1' },
    });
    assert.equal(r.code, ExitCode.refused);
    const piped = await runStorehouseForTest(['history', 'prod', '--json'], {
      cwd: createRepoForTest(),
      fake,
    });
    assert.equal(piped.code, ExitCode.refused);
    assert.deepEqual(fake.requests, []);
  });
});
