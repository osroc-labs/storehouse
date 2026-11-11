import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { after, before, beforeEach, describe, it } from 'node:test';
import { ExitCode } from '../errors.ts';
import { fakeSecretManager } from '../testing/fake-secret-manager.ts';
import type { Fake } from '../testing/fake-secret-manager.ts';
import {
  createRepoForTest,
  fakeManifest,
  runStorehouseForTest,
} from '../testing/storehouse-for-test.ts';

let fake: Fake;

before(async () => {
  fake = await fakeSecretManager();
});
after(async () => {
  await fake.close();
});
beforeEach(() => {
  fake.reset();
});

const runGitForTest = (cwd: string, args: string[]) =>
  execFileSync(
    'git',
    ['-c', 'user.name=t', '-c', 'user.email=t@example.com', ...args],
    { cwd, encoding: 'utf8' },
  );

// a git repo with its manifest committed
const createCommittedRepoForTest = () => {
  const root = createRepoForTest();
  runGitForTest(root, ['init', '-q']);
  runGitForTest(root, ['add', 'storehouse.json']);
  runGitForTest(root, ['commit', '-q', '-m', 'manifest']);
  return root;
};

// a second worktree of the repo at root, somewhere else on disk
const addWorktreeForTest = (root: string) => {
  const dir = mkdtempSync(join(tmpdir(), 'storehouse-worktree-'));
  // git names a worktree by its directory, so each one's is unique
  const worktree = join(dir, basename(dir));
  runGitForTest(root, ['worktree', 'add', '-q', worktree]);
  return worktree;
};

const createConfigForTest = () =>
  mkdtempSync(join(tmpdir(), 'storehouse-config-'));

const readTrustFileForTest = (config: string): unknown =>
  JSON.parse(
    readFileSync(join(config, 'storehouse/trusted-projects.json'), 'utf8'),
  );

// a trust file as storehouse kept it before repos: each manifest's projects by its real path
const writeLegacyTrustForTest = (
  config: string,
  manifests: Record<string, string[]>,
) => {
  mkdirSync(join(config, 'storehouse'));
  writeFileSync(
    join(config, 'storehouse/trusted-projects.json'),
    JSON.stringify({ manifests }),
    { mode: 0o600 },
  );
};

// set as a coding agent would run it: no terminal, CLAUDECODE set
const setAsAgentForTest = (cwd: string, config: string) =>
  runStorehouseForTest(['set', 'dev', 'AUTH_SECRET'], {
    cwd,
    fake,
    env: { XDG_CONFIG_HOME: config, CLAUDECODE: '1' },
    stdin: 'a-typed-value',
  });

const trustForTest = (cwd: string, config: string) =>
  runStorehouseForTest(['trust'], {
    cwd,
    env: { XDG_CONFIG_HOME: config },
    tty: true,
    answers: ['acme-test'],
  });

describe('trust', () => {
  it('trusts every project the manifest uses, once a person types each id, by its real path outside git', async () => {
    const cwd = createRepoForTest();
    const config = createConfigForTest();
    const r = await trustForTest(cwd, config);
    assert.equal(r.code, ExitCode.ok, r.stderr());
    assert.equal(r.stdout(), 'Trusted for this manifest: acme-test.\n');
    assert.deepEqual(readTrustFileForTest(config), {
      manifests: {
        [realpathSync(join(cwd, 'storehouse.json'))]: ['acme-test'],
      },
      binaries: {},
      repos: {},
    });
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

describe('trust in a git repo', () => {
  it('is kept once for the repo, and every worktree of it shares it', async () => {
    const main = createCommittedRepoForTest();
    const worktree = addWorktreeForTest(main);
    const config = createConfigForTest();
    const trusted = await trustForTest(worktree, config);
    assert.equal(trusted.code, ExitCode.ok, trusted.stderr());
    assert.deepEqual(readTrustFileForTest(config), {
      manifests: {},
      binaries: {},
      repos: {
        [realpathSync(join(main, '.git'))]: {
          manifests: { 'storehouse.json': ['acme-test'] },
          binaries: {},
        },
      },
    });

    for (const cwd of [main, worktree, addWorktreeForTest(main)]) {
      const r = await setAsAgentForTest(cwd, config);
      assert.equal(r.code, ExitCode.ok, r.stderr());
    }
  });

  it('refuses a worktree whose manifest names another project until a person trusts it', async () => {
    const main = createCommittedRepoForTest();
    const worktree = addWorktreeForTest(main);
    const config = createConfigForTest();
    assert.equal((await trustForTest(main, config)).code, ExitCode.ok);
    writeFileSync(
      join(worktree, 'storehouse.json'),
      JSON.stringify({ ...fakeManifest(), project: 'elsewhere' }),
    );
    const r = await setAsAgentForTest(worktree, config);
    assert.equal(r.code, ExitCode.refused);
    assert.match(
      r.stderr(),
      /sends secrets to Google Cloud project elsewhere, which hasn't been trusted for it/,
    );
    assert.deepEqual(fake.requests, []);
  });

  it("doesn't carry trust to another repo, or another manifest in the same repo", async () => {
    const config = createConfigForTest();
    assert.equal(
      (await trustForTest(createCommittedRepoForTest(), config)).code,
      ExitCode.ok,
    );
    const otherRepo = await setAsAgentForTest(
      createCommittedRepoForTest(),
      config,
    );
    assert.equal(otherRepo.code, ExitCode.refused);

    const main = createCommittedRepoForTest();
    assert.equal((await trustForTest(main, config)).code, ExitCode.ok);
    mkdirSync(join(main, 'app'));
    writeFileSync(
      join(main, 'app/storehouse.json'),
      JSON.stringify(fakeManifest()),
    );
    const nested = await setAsAgentForTest(join(main, 'app'), config);
    assert.equal(nested.code, ExitCode.refused);
    assert.deepEqual(fake.requests, []);
  });

  it('still honours trust kept by the real path, for that checkout only', async () => {
    const main = createCommittedRepoForTest();
    const worktree = addWorktreeForTest(main);
    const config = createConfigForTest();
    writeLegacyTrustForTest(config, {
      [realpathSync(join(main, 'storehouse.json'))]: ['acme-test'],
    });
    const r = await setAsAgentForTest(main, config);
    assert.equal(r.code, ExitCode.ok, r.stderr());
    const other = await setAsAgentForTest(worktree, config);
    assert.equal(other.code, ExitCode.refused);
  });

  it('asks again about a project trusted only by the real path, and moves it to the repo', async () => {
    const main = createCommittedRepoForTest();
    const worktree = addWorktreeForTest(main);
    const config = createConfigForTest();
    const elsewhere = join(createRepoForTest(), 'storehouse.json');
    writeLegacyTrustForTest(config, {
      [realpathSync(join(main, 'storehouse.json'))]: ['acme-test'],
      [elsewhere]: ['acme-test'],
    });
    const trusted = await trustForTest(main, config);
    assert.equal(trusted.code, ExitCode.ok, trusted.stderr());
    assert.match(
      trusted.stderr(),
      /keeps .*'s secrets in Google Cloud project acme-test/,
    );
    assert.deepEqual(readTrustFileForTest(config), {
      manifests: { [elsewhere]: ['acme-test'] },
      binaries: {},
      repos: {
        [realpathSync(join(main, '.git'))]: {
          manifests: { 'storehouse.json': ['acme-test'] },
          binaries: {},
        },
      },
    });
    const r = await setAsAgentForTest(worktree, config);
    assert.equal(r.code, ExitCode.ok, r.stderr());
  });

  it('keeps trust by the real path as it was when no one can be asked, or the answer is wrong', async () => {
    const main = createCommittedRepoForTest();
    const config = createConfigForTest();
    const legacy = {
      [realpathSync(join(main, 'storehouse.json'))]: ['acme-test'],
    };
    writeLegacyTrustForTest(config, legacy);
    const agent = await runStorehouseForTest(['trust'], {
      cwd: main,
      env: { XDG_CONFIG_HOME: config, CLAUDECODE: '1' },
      tty: true,
      answers: ['acme-test'],
    });
    assert.equal(agent.code, ExitCode.ok, agent.stderr());
    const piped = await runStorehouseForTest(['trust'], {
      cwd: main,
      env: { XDG_CONFIG_HOME: config },
    });
    assert.equal(piped.code, ExitCode.ok, piped.stderr());
    const wrong = await runStorehouseForTest(['trust'], {
      cwd: main,
      env: { XDG_CONFIG_HOME: config },
      tty: true,
      answers: ['yes'],
    });
    assert.equal(wrong.code, ExitCode.refused);
    assert.deepEqual(readTrustFileForTest(config), { manifests: legacy });
  });
});
