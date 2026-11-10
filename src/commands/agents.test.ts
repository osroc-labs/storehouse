import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { guideEnd, guideStart } from '../agents/agent-guide.ts';
import { ExitCode } from '../errors.ts';
import {
  createRepoForTest,
  fakeManifest,
  runStorehouseForTest,
} from '../testing/storehouse-for-test.ts';

describe('agents', () => {
  it('prints the guide, with no Google access', async () => {
    const r = await runStorehouseForTest(['agents'], {
      cwd: createRepoForTest(),
    });
    assert.equal(r.code, ExitCode.ok);
    assert.match(r.stdout(), /^## Secrets\n/);
    assert.doesNotMatch(r.stdout(), /storehouse:start/);
  });

  it('writes AGENTS.md beside the manifest, then says it is current', async () => {
    const cwd = createRepoForTest();
    const first = await runStorehouseForTest(['agents', '--write'], { cwd });
    assert.equal(first.code, ExitCode.ok);
    assert.equal(first.stdout(), "Wrote storehouse's guide in AGENTS.md.\n");
    const written = readFileSync(join(cwd, 'AGENTS.md'), 'utf8');
    assert.ok(written.startsWith(`${guideStart}\n## Secrets`));
    assert.ok(written.endsWith(`${guideEnd}\n`));

    const second = await runStorehouseForTest(['agents', '--write'], { cwd });
    assert.equal(second.stdout(), 'AGENTS.md is current.\n');
    assert.equal(readFileSync(join(cwd, 'AGENTS.md'), 'utf8'), written);
  });

  it('keeps what a person wrote around the block, and updates the block when the manifest changes', async () => {
    const cwd = createRepoForTest();
    await runStorehouseForTest(['agents', '--write'], { cwd });
    const path = join(cwd, 'AGENTS.md');
    writeFileSync(
      path,
      `# My repo\n\nRead docs/.\n\n${readFileSync(path, 'utf8')}\n## More, added later\n`,
    );
    const manifest = fakeManifest();
    writeFileSync(
      join(cwd, 'storehouse.json'),
      JSON.stringify({ ...manifest, envs: { ...manifest.envs, qa: {} } }),
    );
    const r = await runStorehouseForTest(['agents', '--write'], { cwd });
    assert.equal(r.stdout(), "Updated storehouse's guide in AGENTS.md.\n");
    const updated = readFileSync(path, 'utf8');
    assert.ok(
      updated.startsWith(
        '# My repo\n\nRead docs/.\n\n<!-- storehouse:start -->',
      ),
    );
    assert.ok(updated.endsWith(`${guideEnd}\n\n## More, added later\n`));
    assert.match(updated, /`qa`/);
  });

  it('shows the change with --dry-run, and writes nothing', async () => {
    const cwd = createRepoForTest();
    const r = await runStorehouseForTest(['agents', '--write', '--dry-run'], {
      cwd,
    });
    assert.equal(r.code, ExitCode.ok);
    assert.match(
      r.stdout(),
      /^--- AGENTS\.md\n\+\+\+ AGENTS\.md\n@@ line 1 @@\n\+<!-- storehouse:start -->/,
    );
    assert.equal(existsSync(join(cwd, 'AGENTS.md')), false);
  });

  it('writes to another file with --file', async () => {
    const cwd = createRepoForTest(fakeManifest(), {
      'CLAUDE.md': '@AGENTS.md\n',
    });
    const r = await runStorehouseForTest(
      ['agents', '--write', '--file', 'CLAUDE.md'],
      { cwd },
    );
    assert.equal(r.code, ExitCode.ok);
    assert.ok(
      readFileSync(join(cwd, 'CLAUDE.md'), 'utf8').startsWith(
        `@AGENTS.md\n\n${guideStart}`,
      ),
    );
    assert.equal(existsSync(join(cwd, 'AGENTS.md')), false);
  });

  it('refuses broken markers, naming the file', async () => {
    const cwd = createRepoForTest(fakeManifest(), {
      'AGENTS.md': `${guideStart}\nno end\n`,
    });
    const r = await runStorehouseForTest(['agents', '--write'], { cwd });
    assert.equal(r.code, ExitCode.usage);
    assert.match(
      r.stderr(),
      /AGENTS\.md has storehouse's markers out of order/,
    );
  });

  it('makes check warn, not fail, when the guide is stale', async () => {
    const cwd = createRepoForTest();
    await runStorehouseForTest(['agents', '--write'], { cwd });
    const current = await runStorehouseForTest(['check'], { cwd });
    assert.equal(current.stderr(), '');

    const manifest = fakeManifest();
    writeFileSync(
      join(cwd, 'storehouse.json'),
      JSON.stringify({ ...manifest, envs: { ...manifest.envs, qa: {} } }),
    );
    const stale = await runStorehouseForTest(['check'], { cwd });
    assert.equal(stale.code, ExitCode.ok);
    assert.equal(
      stale.stderr(),
      "AGENTS.md's storehouse guide is out of date with storehouse.json. Update it with: storehouse agents --write\n",
    );
    const asJson = await runStorehouseForTest(['check', '--json'], { cwd });
    assert.match(
      asJson.stdout(),
      /"warnings": \[\n\s+"AGENTS\.md's storehouse guide is out of date/,
    );
  });

  it('follows a symlink to a file in the repo, and keeps the link', async () => {
    const cwd = createRepoForTest(fakeManifest(), { 'CLAUDE.md': '# Mine\n' });
    symlinkSync('CLAUDE.md', join(cwd, 'AGENTS.md'));
    const r = await runStorehouseForTest(['agents', '--write'], { cwd });
    assert.equal(r.code, ExitCode.ok, r.stderr());
    assert.ok(
      readFileSync(join(cwd, 'CLAUDE.md'), 'utf8').startsWith(
        `# Mine\n\n${guideStart}`,
      ),
    );
    const check = await runStorehouseForTest(['check'], { cwd });
    assert.equal(check.stderr(), '');
  });

  it('keeps a CRLF file in CRLF, and check reads its guide as current', async () => {
    const cwd = createRepoForTest(fakeManifest(), {
      'AGENTS.md': '# Mine\r\n',
    });
    await runStorehouseForTest(['agents', '--write'], { cwd });
    const written = readFileSync(join(cwd, 'AGENTS.md'), 'utf8');
    assert.equal(written.replaceAll('\r\n', '').includes('\n'), false);
    const check = await runStorehouseForTest(['check'], { cwd });
    assert.equal(check.stderr(), '');
    const again = await runStorehouseForTest(['agents', '--write'], { cwd });
    assert.equal(again.stdout(), 'AGENTS.md is current.\n');
  });

  it('says when Claude Code would skip the new AGENTS.md for a CLAUDE.md above it', async () => {
    const manifest = fakeManifest();
    const root = createRepoForTest(manifest, {
      'CLAUDE.md': '@AGENTS.md\n',
      'apps/api/storehouse.json': JSON.stringify(manifest),
    });
    execFileSync('git', ['init', '-q'], { cwd: root });
    const cwd = join(root, 'apps/api');
    const r = await runStorehouseForTest(['agents', '--write'], { cwd });
    assert.equal(r.code, ExitCode.ok);
    assert.equal(
      r.stderr(),
      "Claude Code won't read AGENTS.md while ../../CLAUDE.md is above it. Add a CLAUDE.md beside it with the line @AGENTS.md, or put the guide in a CLAUDE.md with --file.\n",
    );
    writeFileSync(join(cwd, 'AGENTS.md'), '');
    writeFileSync(join(cwd, 'CLAUDE.md'), '@AGENTS.md\n');
    const beside = await runStorehouseForTest(['agents', '--write'], { cwd });
    assert.equal(beside.stderr(), '');
  });

  it('says nothing about Claude Code without a CLAUDE.md above', async () => {
    const manifest = fakeManifest();
    const root = createRepoForTest(manifest, {
      'apps/api/storehouse.json': JSON.stringify(manifest),
    });
    const r = await runStorehouseForTest(['agents', '--write'], {
      cwd: join(root, 'apps/api'),
    });
    assert.equal(r.stderr(), '');
  });

  it('notes a --file outside the repo, and writes it', async () => {
    const cwd = createRepoForTest();
    const outside = createRepoForTest();
    const r = await runStorehouseForTest(
      ['agents', '--write', '--file', join(outside, 'NOTES.md')],
      { cwd },
    );
    assert.equal(r.code, ExitCode.ok);
    assert.match(r.stderr(), /NOTES\.md is outside the repo \(/);
    assert.ok(existsSync(join(outside, 'NOTES.md')));
  });

  it("refuses a --file whose directory doesn't exist", async () => {
    const cwd = createRepoForTest();
    const r = await runStorehouseForTest(
      ['agents', '--write', '--file', 'missing/AGENTS.md'],
      { cwd },
    );
    assert.equal(r.code, ExitCode.failed);
    assert.match(r.stderr(), /There's no directory for missing\/AGENTS\.md\./);
  });

  it('refuses a directory where the guide would go', async () => {
    const cwd = createRepoForTest();
    mkdirSync(join(cwd, 'AGENTS.md'));
    const r = await runStorehouseForTest(['agents', '--write'], { cwd });
    assert.equal(r.code, ExitCode.failed);
    assert.match(r.stderr(), /AGENTS\.md isn't a regular file/);
  });
});
