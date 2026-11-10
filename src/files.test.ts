import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { fileService } from './files.ts';

describe('fileService.writePrivate', () => {
  const dir = () => mkdtempSync(join(tmpdir(), 'storehouse-files-'));

  it('creates it at 0600', () => {
    const cwd = dir();
    fileService.writePrivate({
      path: join(cwd, 'a'),
      data: 'x',
      cwd,
      isForced: false,
    });
    assert.equal(statSync(join(cwd, 'a')).mode & 0o777, 0o600);
  });

  it('refuses, without force, a file that appeared after the first check', () => {
    const cwd = dir();
    writeFileSync(join(cwd, 'a'), 'theirs');
    assert.throws(
      () =>
        fileService.writePrivate({
          path: join(cwd, 'a'),
          data: 'x',
          cwd,
          isForced: false,
        }),
      /a already exists\. Pass --force to overwrite it\./,
    );
    assert.equal(readFileSync(join(cwd, 'a'), 'utf8'), 'theirs');
  });
});
