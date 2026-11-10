import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, it } from 'node:test';
import { ExitCode } from '../errors.ts';
import { fakeSecretManager, token } from '../testing/fake-secret-manager.ts';
import type { Fake } from '../testing/fake-secret-manager.ts';
import {
  createCredentialsForTest,
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

const getRequestsTo = (suffix: string) =>
  fake.requests.filter((r) => r.path.endsWith(suffix));

const getValueForTest = (options: { timeoutMs?: number } = {}) =>
  runStorehouseForTest(['get', 'dev', 'AUTH_SECRET'], {
    cwd: createRepoForTest(),
    fake,
    ...options,
  });

describe('Secret Manager faults', () => {
  it('waits as long as Retry-After says on a 429, then reads', async () => {
    fake.seed(project, 'acme-dev-AUTH_SECRET', 'v');
    fake.injectFault({ kind: 'status', code: 429, retryAfter: '0' }, ':access');
    const r = await getValueForTest();
    assert.equal(r.code, ExitCode.ok, r.stderr());
    assert.equal(r.stdout(), 'v');
    assert.equal(getRequestsTo(':access').length, 2);
  });

  it('retries a read through a 500 and a 503', async () => {
    fake.seed(project, 'acme-dev-AUTH_SECRET', 'v');
    fake.failNext(500, ':access');
    fake.injectFault(
      {
        kind: 'status',
        code: 503,
        retryAfter: 'Thu, 01 Jan 1970 00:00:00 GMT',
      },
      ':access',
    );
    const r = await getValueForTest();
    assert.equal(r.code, ExitCode.ok, r.stderr());
    assert.equal(getRequestsTo(':access').length, 3);
  });

  it('gives up after three tries and says what failed', async () => {
    for (let i = 0; i < 3; i++) fake.failNext(503, ':access');
    const r = await getValueForTest();
    assert.equal(r.code, ExitCode.failed);
    assert.match(
      r.stderr(),
      /^Google failed to read acme-dev-AUTH_SECRET's value \(503 UNAVAILABLE\): Try again\./,
    );
  });

  it('says to wait when Google keeps limiting requests', async () => {
    for (let i = 0; i < 3; i++) {
      fake.injectFault(
        { kind: 'status', code: 429, retryAfter: '0' },
        ':access',
      );
    }
    const r = await getValueForTest();
    assert.equal(r.code, ExitCode.failed);
    assert.match(
      r.stderr(),
      /Google is limiting requests to project acme-test[\s\S]*Wait a minute and run it again/,
    );
  });

  it('retries a read that times out, and names the fix when it keeps timing out', async () => {
    fake.seed(project, 'acme-dev-AUTH_SECRET', 'v');
    fake.injectFault({ kind: 'timeout' }, ':access');
    const once = await getValueForTest({ timeoutMs: 100 });
    assert.equal(once.code, ExitCode.ok, once.stderr());

    for (let i = 0; i < 3; i++)
      fake.injectFault({ kind: 'timeout' }, ':access');
    const always = await getValueForTest({ timeoutMs: 100 });
    assert.equal(always.code, ExitCode.failed);
    assert.match(
      always.stderr(),
      /^Secret Manager didn't answer in time while trying to read acme-dev-AUTH_SECRET's value\. Check your connection/,
    );
  });

  it('retries a read whose connection drops mid-body', async () => {
    fake.seed(project, 'acme-dev-AUTH_SECRET', 'v');
    fake.injectFault({ kind: 'reset' }, ':access');
    const r = await getValueForTest();
    assert.equal(r.code, ExitCode.ok, r.stderr());
    assert.equal(r.stdout(), 'v');
  });

  it('says so when a reply is not JSON', async () => {
    fake.seed(project, 'acme-dev-AUTH_SECRET', 'v');
    fake.injectFault({ kind: 'malformed' }, ':access');
    const r = await getValueForTest();
    assert.equal(r.code, ExitCode.failed);
    assert.match(
      r.stderr(),
      /^Secret Manager's reply to read acme-dev-AUTH_SECRET's value wasn't JSON\./,
    );
  });

  it('never retries a write, so it cannot add a second version', async () => {
    for (const fault of [
      { kind: 'status', code: 503 },
      { kind: 'timeout' },
      { kind: 'reset' },
    ] as const) {
      fake.reset();
      fake.injectFault(fault, ':addVersion');
      const r = await runStorehouseForTest(['set', 'dev', 'AUTH_SECRET'], {
        cwd: createRepoForTest(),
        fake,
        stdin: 'v',
        timeoutMs: 100,
      });
      assert.equal(r.code, ExitCode.failed, fault.kind);
      assert.equal(getRequestsTo(':addVersion').length, 1, fault.kind);
    }
  });

  it('gets a new token when one expires mid-run, and carries on', async () => {
    fake.seed(project, 'acme-dev-AUTH_SECRET', 'v');
    fake.revokeToken(token);
    fake.acceptToken('fresh-token');
    const credentials = createCredentialsForTest([token, 'fresh-token']);
    const r = await runStorehouseForTest(['get', 'dev', 'AUTH_SECRET'], {
      cwd: createRepoForTest(),
      fake,
      credentials,
    });
    assert.equal(r.code, ExitCode.ok, r.stderr());
    assert.equal(r.stdout(), 'v');
    // the first request is refused, refreshes the token, and is sent again
    const [refused, resent] = fake.requests;
    assert.ok(refused && resent);
    assert.equal(refused.headers.authorization, `Bearer ${token}`);
    assert.equal(resent.headers.authorization, 'Bearer fresh-token');
    assert.equal(resent.path, refused.path);
  });

  it("names the fix when a token can't be refreshed", async () => {
    fake.revokeToken(token);
    const r = await getValueForTest();
    assert.equal(r.code, ExitCode.failed);
    assert.match(
      r.stderr(),
      /Google didn't accept the access token[\s\S]*`storehouse auth` shows which credentials/,
    );
  });

  it('sends the quota project of application default credentials', async () => {
    fake.seed(project, 'acme-dev-AUTH_SECRET', 'v');
    const r = await runStorehouseForTest(['get', 'dev', 'AUTH_SECRET'], {
      cwd: createRepoForTest(),
      fake,
      credentials: createCredentialsForTest([token], 'acme-billing'),
    });
    assert.equal(r.code, ExitCode.ok, r.stderr());
    assert.equal(
      fake.requests[0]?.headers['x-goog-user-project'],
      'acme-billing',
    );
  });

  it('reads every page of versions', async () => {
    for (const v of ['a', 'b', 'c', 'd', 'e'])
      fake.seed(project, 'acme-dev-AUTH_SECRET', v);
    const r = await runStorehouseForTest(
      ['history', 'dev', 'AUTH_SECRET', '--json', '--limit', '0'],
      {
        cwd: createRepoForTest(),
        fake,
      },
    );
    assert.equal(r.code, ExitCode.ok);
    assert.equal(
      getRequestsTo('/versions').length +
        fake.requests.filter((q) => q.path.includes('/versions?')).length,
      3,
    );
  });
});
