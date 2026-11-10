import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { ExitCode } from '../errors.ts';
import {
  createCredentialsForTest,
  runStorehouseForTest,
} from '../testing/storehouse-for-test.ts';

describe('auth', () => {
  it('says where the token came from, with no manifest needed', async () => {
    const r = await runStorehouseForTest(['auth'], {
      cwd: '/',
      credentials: createCredentialsForTest(['t'], 'acme-billing'),
    });
    assert.equal(r.code, ExitCode.ok);
    assert.equal(
      r.stdout(),
      'Google credentials: GOOGLE_OAUTH_ACCESS_TOKEN (a token for tests).\nQuota project: acme-billing.\n',
    );
  });

  it('prints JSON, and never the token', async () => {
    const r = await runStorehouseForTest(['auth', '--json'], {
      cwd: '/',
      credentials: createCredentialsForTest(['secret-token']),
    });
    assert.deepEqual(JSON.parse(r.stdout()), {
      source: 'GOOGLE_OAUTH_ACCESS_TOKEN',
      detail: 'a token for tests',
    });
    assert.doesNotMatch(r.stdout() + r.stderr(), /secret-token/);
  });
});
