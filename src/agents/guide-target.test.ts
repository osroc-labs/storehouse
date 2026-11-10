import assert from 'node:assert/strict';
import {
  appendFileSync,
  chmodSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { guideTargetService, maxGuideFileBytes } from './guide-target.ts';

const createDirForTest = () => mkdtempSync(join(tmpdir(), 'storehouse-guide-'));

describe('guideTargetService', () => {
  it("refuses to replace a file another tool changed after it was read, and leaves that tool's change", () => {
    const dir = createDirForTest();
    const path = join(dir, 'AGENTS.md');
    writeFileSync(path, '# Mine\n');
    const existing = guideTargetService.read(path, 'AGENTS.md');
    appendFileSync(path, 'Added by an editor.\n');
    assert.throws(
      () =>
        guideTargetService.write({
          path,
          shownPath: 'AGENTS.md',
          existing,
          text: '# Mine\n\nguide\n',
        }),
      /AGENTS\.md changed while this ran\. Run it again\./,
    );
    assert.equal(readFileSync(path, 'utf8'), '# Mine\nAdded by an editor.\n');
    assert.deepEqual(readdirSync(dir), ['AGENTS.md']);
  });

  it("won't create a file that appeared after it looked", () => {
    const dir = createDirForTest();
    const path = join(dir, 'AGENTS.md');
    const existing = guideTargetService.read(path, 'AGENTS.md');
    assert.equal(existing, undefined);
    writeFileSync(path, 'Someone else.\n');
    assert.throws(
      () =>
        guideTargetService.write({
          path,
          shownPath: 'AGENTS.md',
          existing,
          text: 'guide\n',
        }),
      /changed while this ran/,
    );
    assert.equal(readFileSync(path, 'utf8'), 'Someone else.\n');
  });

  it('keeps the mode of the file it replaces', () => {
    const dir = createDirForTest();
    const path = join(dir, 'AGENTS.md');
    writeFileSync(path, '# Mine\n', { mode: 0o640 });
    const existing = guideTargetService.read(path, 'AGENTS.md');
    guideTargetService.write({
      path,
      shownPath: 'AGENTS.md',
      existing,
      text: '# Mine\n\nguide\n',
    });
    assert.equal(statSync(path).mode & 0o777, 0o640);
    assert.equal(readFileSync(path, 'utf8'), '# Mine\n\nguide\n');
  });

  it("names the failure when it can't write the file", () => {
    const dir = createDirForTest();
    assert.throws(
      () =>
        guideTargetService.write({
          path: join(dir, 'missing/AGENTS.md'),
          shownPath: 'missing/AGENTS.md',
          existing: undefined,
          text: 'guide\n',
        }),
      /Couldn't write missing\/AGENTS\.md: ENOENT/,
    );
  });

  it('refuses a file over the cap, or one that is not UTF-8', () => {
    const dir = createDirForTest();
    const big = join(dir, 'big.md');
    writeFileSync(big, 'a'.repeat(maxGuideFileBytes + 1));
    assert.throws(
      () => guideTargetService.read(big, 'big.md'),
      /big\.md is over 1 MB/,
    );
    const latin = join(dir, 'latin.md');
    writeFileSync(latin, Buffer.from([0x63, 0x61, 0x66, 0xe9, 0x0a]));
    assert.throws(
      () => guideTargetService.read(latin, 'latin.md'),
      /latin\.md isn't UTF-8 text/,
    );
  });

  it("names the failure when it can't replace a file, and leaves no temp file", () => {
    const dir = createDirForTest();
    const path = join(dir, 'AGENTS.md');
    writeFileSync(path, '# Mine\n');
    const existing = guideTargetService.read(path, 'AGENTS.md');
    chmodSync(dir, 0o555);
    try {
      assert.throws(
        () =>
          guideTargetService.write({
            path,
            shownPath: 'AGENTS.md',
            existing,
            text: 'guide\n',
          }),
        /Couldn't write AGENTS\.md: EACCES/,
      );
    } finally {
      chmodSync(dir, 0o755);
    }
    assert.deepEqual(readdirSync(dir), ['AGENTS.md']);
  });

  it("names a path it can't look at", () => {
    const dir = createDirForTest();
    writeFileSync(join(dir, 'file'), '');
    assert.throws(
      () => guideTargetService.read(join(dir, 'file/AGENTS.md'), 'x'),
      /Couldn't read .*: ENOTDIR/,
    );
  });

  it('refuses the default file when it is outside the repo', () => {
    const dir = createDirForTest();
    const repoRoot = createDirForTest();
    assert.throws(
      () =>
        guideTargetService.get({
          manifestPath: join(repoRoot, 'storehouse.json'),
          path: join(dir, 'AGENTS.md'),
          shownPath: 'AGENTS.md',
          repoRoot,
          isNamed: false,
          isForced: false,
        }),
      /AGENTS\.md is outside the repo \(.*\), so storehouse won't write the guide there\./,
    );
  });
});
