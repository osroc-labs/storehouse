import assert from 'node:assert/strict';
import { chmodSync, readdirSync, readFileSync, statSync } from 'node:fs';
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

const mode = (path: string) => statSync(path).mode & 0o777;

describe('get', () => {
  it('prints the value with nothing added', async () => {
    fake.seed(project, 'acme-dev-AUTH_SECRET', 'line one\nline two\n');
    const r = await runStorehouseForTest(['get', 'dev', 'AUTH_SECRET'], {
      cwd: createRepoForTest(),
      fake,
    });
    assert.equal(r.code, 0);
    assert.equal(r.stdout(), 'line one\nline two\n');
  });

  it('writes a 0600 file with --out, and overwrites only with --force', async () => {
    const cwd = createRepoForTest();
    fake.seed(project, 'acme-dev-AUTH_SECRET', Buffer.from([1, 2, 3]));
    const r = await runStorehouseForTest(
      ['get', 'dev', 'AUTH_SECRET', '--out', 'secret.bin'],
      { cwd, fake },
    );
    assert.equal(r.code, 0, r.stderr());
    assert.equal(r.stdout(), '');
    assert.deepEqual(
      readFileSync(join(cwd, 'secret.bin')),
      Buffer.from([1, 2, 3]),
    );
    assert.equal(mode(join(cwd, 'secret.bin')), 0o600);
    const again = await runStorehouseForTest(
      ['get', 'dev', 'AUTH_SECRET', '--out=secret.bin'],
      { cwd, fake },
    );
    assert.equal(again.code, ExitCode.failed);
    assert.match(again.stderr(), /secret\.bin already exists\. Pass --force/);
    chmodSync(join(cwd, 'secret.bin'), 0o644);
    const forced = await runStorehouseForTest(
      ['get', 'dev', 'AUTH_SECRET', '--out=secret.bin', '--force'],
      { cwd, fake },
    );
    assert.equal(forced.code, 0);
    assert.equal(mode(join(cwd, 'secret.bin')), 0o600);
  });

  it('counts a disabled latest version as not set', async () => {
    fake.seed(project, 'acme-dev-AUTH_SECRET', 'old');
    fake.seed(project, 'acme-dev-AUTH_SECRET', 'new', 'DISABLED');
    const r = await runStorehouseForTest(['get', 'dev', 'AUTH_SECRET'], {
      cwd: createRepoForTest(),
      fake,
    });
    assert.equal(r.code, ExitCode.missing);
    assert.match(r.stderr(), /no enabled latest version/);
  });

  it('retries a read Google fails for a moment', async () => {
    fake.seed(project, 'acme-dev-AUTH_SECRET', 'v');
    fake.failNext(503);
    const r = await runStorehouseForTest(['get', 'dev', 'AUTH_SECRET'], {
      cwd: createRepoForTest(),
      fake,
    });
    assert.equal(r.code, 0, r.stderr());
    assert.equal(r.stdout(), 'v');
  });

  it('overwrites with --force by renaming a new 0600 file over the old one', async () => {
    const cwd = createRepoForTest(fakeManifest(), { 'old.txt': 'old' });
    chmodSync(join(cwd, 'old.txt'), 0o644);
    fake.seed(project, 'acme-dev-AUTH_SECRET', 'new');
    const r = await runStorehouseForTest(
      ['get', 'dev', 'AUTH_SECRET', '--out', 'old.txt', '--force'],
      { cwd, fake },
    );
    assert.equal(r.code, 0, r.stderr());
    assert.equal(readFileSync(join(cwd, 'old.txt'), 'utf8'), 'new');
    assert.equal(mode(join(cwd, 'old.txt')), 0o600);
    assert.deepEqual(
      readdirSync(cwd).filter((f) => f.endsWith('.tmp')),
      [],
    );
  });

  it("names a file it can't write, as a failure rather than a bug", async () => {
    const cwd = createRepoForTest();
    fake.seed(project, 'acme-dev-AUTH_SECRET', 'v');
    const r = await runStorehouseForTest(
      ['get', 'dev', 'AUTH_SECRET', '--out', 'worker', '--force'],
      { cwd, fake },
    );
    assert.equal(r.code, ExitCode.failed);
    assert.match(r.stderr(), /^Couldn't write worker: /);
    assert.doesNotMatch(r.stderr(), /bug/);
    assert.deepEqual(
      readdirSync(cwd).filter((f) => f.endsWith('.tmp')),
      [],
    );
  });

  it('says how to set a missing secret, with exit 4', async () => {
    const r = await runStorehouseForTest(['get', 'dev', 'AUTH_SECRET'], {
      cwd: createRepoForTest(),
      fake,
    });
    assert.equal(r.code, ExitCode.missing);
    assert.match(r.stderr(), /Set it with: storehouse set dev AUTH_SECRET/);
  });
});
