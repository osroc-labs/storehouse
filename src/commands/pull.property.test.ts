import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { parse as parseWithWranglerDotenv } from 'dotenv';
import fc from 'fast-check';
import { dotenvService } from '../dotenv.ts';
import { ExitCode } from '../errors.ts';
import { fakeSecretManager } from '../testing/fake-secret-manager.ts';
import type { Fake } from '../testing/fake-secret-manager.ts';
import {
  createRepoForTest,
  runStorehouseForTest,
} from '../testing/storehouse-for-test.ts';

let fake: Fake;

before(async () => {
  fake = await fakeSecretManager();
});
after(async () => {
  await fake.close();
});

const manifest = {
  project: 'proj-test',
  name: 'app-{env}-{key}',
  envs: { dev: { pull: { file: '.dev.vars' } } },
  secrets: { KEY: { purpose: 'Any value at all.' } },
};

// letters, digits, spaces and punctuation no dotenv parser treats specially
const ordinaryCharacters = [
  'a',
  'b',
  'X',
  'Z',
  '0',
  '9',
  ' ',
  '-',
  '_',
  '=',
  '/',
  '+',
  '.',
  ':',
  '@',
  ',',
  'é',
];

describe('pull, for every value', () => {
  it('writes a file both parsers read back exactly, or writes nothing and says why', async () => {
    let writtenCount = 0;
    await fc.assert(
      fc.asyncProperty(
        fc.string({ unit: 'binary', minLength: 1 }),
        async (value) => {
          fake.reset();
          fake.seed('proj-test', 'app-dev-KEY', value);
          const cwd = createRepoForTest(manifest);
          const r = await runStorehouseForTest(['pull', 'dev'], { cwd, fake });
          const path = join(cwd, '.dev.vars');
          if (r.code !== ExitCode.ok) {
            assert.equal(r.code, ExitCode.failed, r.stderr());
            assert.match(r.stderr(), /KEY/);
            assert.equal(existsSync(path), false);
            return;
          }
          writtenCount++;
          // pull drops one trailing newline, as set does on the way in
          const expected = dotenvService.stripTrailingNewline(value);
          const written = readFileSync(path, 'utf8');
          assert.deepEqual(dotenvService.parse(written), { KEY: expected });
          assert.deepEqual(parseWithWranglerDotenv(written), { KEY: expected });
        },
      ),
      { numRuns: 150 },
    );
    // most values are written, so the property can't pass by refusing everything
    assert.ok(
      writtenCount > 75,
      `only ${writtenCount} of 150 values were written`,
    );
  });

  it('writes every value made of ordinary characters', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.string({
          unit: fc.constantFrom(...ordinaryCharacters),
          minLength: 1,
        }),
        async (value) => {
          fake.reset();
          fake.seed('proj-test', 'app-dev-KEY', value);
          const cwd = createRepoForTest(manifest);
          const r = await runStorehouseForTest(['pull', 'dev'], { cwd, fake });
          assert.equal(r.code, ExitCode.ok, r.stderr());
          const written = readFileSync(join(cwd, '.dev.vars'), 'utf8');
          assert.deepEqual(dotenvService.parse(written), { KEY: value });
        },
      ),
      { numRuns: 60 },
    );
  });
});
