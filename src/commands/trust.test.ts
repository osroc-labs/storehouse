import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { ExitCode } from '../errors.ts';
import {
  createRepoForTest,
  runStorehouseForTest,
} from '../testing/storehouse-for-test.ts';

describe('trust', () => {
  it('trusts every project the manifest uses, once a person types each id', async () => {
    const cwd = createRepoForTest();
    const config = mkdtempSync(join(tmpdir(), 'storehouse-config-'));
    const r = await runStorehouseForTest(['trust'], {
      cwd,
      env: { XDG_CONFIG_HOME: config },
      tty: true,
      answers: ['acme-test'],
    });
    assert.equal(r.code, ExitCode.ok, r.stderr());
    assert.equal(r.stdout(), 'Trusted for this manifest: acme-test.\n');
    assert.deepEqual(
      JSON.parse(
        readFileSync(join(config, 'storehouse/trusted-projects.json'), 'utf8'),
      ),
      {
        manifests: {
          [realpathSync(join(cwd, 'storehouse.json'))]: ['acme-test'],
        },
        binaries: {},
      },
    );
  });

  it('refuses a wrong id, and refuses without a terminal', async () => {
    const cwd = createRepoForTest();
    const wrong = await runStorehouseForTest(['trust'], {
      cwd,
      trusts: 'none',
      tty: true,
      answers: ['yes'],
    });
    assert.equal(wrong.code, ExitCode.refused);
    assert.match(wrong.stderr(), /That isn't "acme-test"/);
    const piped = await runStorehouseForTest(['trust'], {
      cwd,
      trusts: 'none',
    });
    assert.equal(piped.code, ExitCode.refused);
  });
});
