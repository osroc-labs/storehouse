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

const writes = () => fake.requests.filter((r) => r.method !== 'GET');

describe('set', () => {
  it('creates a new secret with its labels, from stdin, dropping one newline', async () => {
    const r = await runStorehouseForTest(['set', 'stage', 'TWILIO_SID'], {
      cwd: createRepoForTest(),
      fake,
      stdin: 'AC123\n',
    });
    assert.equal(r.code, 0, r.stderr());
    assert.equal(fake.value(project, 'acme-stage-TWILIO_SID'), 'AC123');
    assert.deepEqual(
      fake.secrets.get(`${project}/acme-stage-TWILIO_SID`)?.labels,
      {
        storehouse: 'true',
        env: 'stage',
      },
    );
    assert.match(
      r.stdout(),
      /Set TWILIO_SID in stage: acme-stage-TWILIO_SID, version 1\./,
    );
    assert.doesNotMatch(r.stdout() + r.stderr(), /AC123/);
  });

  it('reads a hidden prompt at a terminal', async () => {
    const r = await runStorehouseForTest(['set', 'dev', 'AUTH_SECRET'], {
      cwd: createRepoForTest(),
      fake,
      tty: true,
      answers: ['s3cret'],
    });
    assert.equal(r.code, 0, r.stderr());
    assert.deepEqual(r.prompts, [
      { question: 'Value for AUTH_SECRET in dev (hidden): ', isHidden: true },
    ]);
    assert.equal(fake.value(project, 'acme-dev-AUTH_SECRET'), 's3cret');
  });

  it('adds a version only when the value changed', async () => {
    const cwd = createRepoForTest();
    fake.seed(project, 'acme-dev-AUTH_SECRET', 'same');
    const unchanged = await runStorehouseForTest(
      ['set', 'dev', 'AUTH_SECRET'],
      {
        cwd,
        fake,
        stdin: 'same\n',
      },
    );
    assert.equal(unchanged.code, 0);
    assert.match(
      unchanged.stdout(),
      /already has this value \(acme-dev-AUTH_SECRET, version 1\)/,
    );
    assert.equal(
      fake.secrets.get(`${project}/acme-dev-AUTH_SECRET`)?.versions.length,
      1,
    );
    const changed = await runStorehouseForTest(['set', 'dev', 'AUTH_SECRET'], {
      cwd,
      fake,
      stdin: 'new',
    });
    assert.match(changed.stdout(), /version 2\./);
    assert.equal(fake.value(project, 'acme-dev-AUTH_SECRET'), 'new');
  });

  it('adds a version over a disabled one', async () => {
    fake.seed(project, 'acme-dev-AUTH_SECRET', 'old', 'DISABLED');
    const r = await runStorehouseForTest(['set', 'dev', 'AUTH_SECRET'], {
      cwd: createRepoForTest(),
      fake,
      stdin: 'old',
    });
    assert.equal(r.code, 0, r.stderr());
    assert.match(r.stdout(), /version 2\./);
  });

  it('keeps bytes as they are', async () => {
    const bytes = Buffer.from([0, 255, 10, 13, 10]);
    await runStorehouseForTest(['set', 'dev', 'AUTH_SECRET'], {
      cwd: createRepoForTest(),
      fake,
      stdin: bytes,
    });
    assert.deepEqual(
      fake.secrets.get(`${project}/acme-dev-AUTH_SECRET`)?.versions[0]?.data,
      bytes.subarray(0, -1),
    );
  });

  it("doesn't retry a write, so a retry can't add a second version", async () => {
    fake.failNext(503, ':addVersion');
    const r = await runStorehouseForTest(['set', 'dev', 'AUTH_SECRET'], {
      cwd: createRepoForTest(),
      fake,
      stdin: 'v',
    });
    assert.equal(r.code, ExitCode.failed);
    assert.match(
      r.stderr(),
      /Google failed to add a version to acme-dev-AUTH_SECRET \(503 UNAVAILABLE\)/,
    );
    assert.equal(
      fake.requests.filter((q) => q.path.endsWith(':addVersion')).length,
      1,
    );
  });

  it('refuses an empty value', async () => {
    const r = await runStorehouseForTest(['set', 'dev', 'AUTH_SECRET'], {
      cwd: createRepoForTest(),
      fake,
      stdin: '\n',
    });
    assert.equal(r.code, ExitCode.failed);
    assert.match(r.stderr(), /empty, so nothing was stored/);
    assert.deepEqual(writes(), []);
  });

  it('refuses a key the manifest lacks, saying what to add', async () => {
    const r = await runStorehouseForTest(['set', 'dev', 'NEW_KEY'], {
      cwd: createRepoForTest(),
      fake,
      stdin: 'x',
    });
    assert.equal(r.code, ExitCode.usage);
    assert.match(r.stderr(), /never edits the manifest/);
    assert.deepEqual(fake.requests, []);
  });
});
