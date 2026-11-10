import assert from 'node:assert/strict';
import {
  chmodSync,
  existsSync,
  readFileSync,
  statSync,
  symlinkSync,
} from 'node:fs';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
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

const accessed = () => fake.requests.filter((r) => r.path.endsWith(':access'));
const mode = (path: string) => statSync(path).mode & 0o777;

describe('pull', () => {
  it('writes the dotenv file, 0600, without pull: false secrets', async () => {
    const cwd = createRepoForTest();
    fake.seed(project, 'acme-dev-AUTH_SECRET', 'a b\n');
    fake.seed(project, 'acme-dev-SEED_TOKEN', 'seed');
    const r = await runStorehouseForTest(['pull', 'dev'], { cwd, fake });
    assert.equal(r.code, 0, r.stderr());
    const path = join(cwd, 'worker/.dev.vars');
    assert.equal(readFileSync(path, 'utf8'), "AUTH_SECRET='a b'\n");
    assert.equal(mode(path), 0o600);
    assert.match(
      r.stdout(),
      /Wrote 1 secret from dev to worker\/\.dev\.vars\.\nNot set in dev, so left out: TWILIO_SID\./,
    );
  });

  it('refuses to overwrite without --force, before reading anything', async () => {
    const cwd = createRepoForTest(fakeManifest(), {
      'worker/.dev.vars': 'OLD=1\n',
    });
    fake.seed(project, 'acme-dev-AUTH_SECRET', 'new');
    const r = await runStorehouseForTest(['pull', 'dev'], { cwd, fake });
    assert.equal(r.code, ExitCode.failed);
    assert.match(
      r.stderr(),
      /worker\/\.dev\.vars already exists\. Pass --force/,
    );
    assert.deepEqual(fake.requests, []);
    chmodSync(join(cwd, 'worker/.dev.vars'), 0o644);
    const forced = await runStorehouseForTest(['pull', 'dev', '--force'], {
      cwd,
      fake,
    });
    assert.equal(forced.code, 0);
    assert.equal(
      readFileSync(join(cwd, 'worker/.dev.vars'), 'utf8'),
      'AUTH_SECRET=new\n',
    );
    assert.equal(mode(join(cwd, 'worker/.dev.vars')), 0o600);
  });

  it('lists the keys with --dry-run, reading no values and writing nothing', async () => {
    const cwd = createRepoForTest(fakeManifest(), {
      'worker/.dev.vars': 'OLD=1\n',
    });
    fake.seed(project, 'acme-dev-AUTH_SECRET', 'x');
    const r = await runStorehouseForTest(['pull', 'dev', '--dry-run'], {
      cwd,
      fake,
    });
    assert.equal(r.code, 0);
    assert.equal(
      r.stdout(),
      'Would write 1 secret from dev to worker/.dev.vars:\n  AUTH_SECRET\nNot set in dev, so left out: TWILIO_SID.\nworker/.dev.vars already exists. Pass --force to overwrite it.\n',
    );
    assert.deepEqual(accessed(), []);
    assert.equal(
      readFileSync(join(cwd, 'worker/.dev.vars'), 'utf8'),
      'OLD=1\n',
    );
  });

  it('stops before writing when a required secret is missing', async () => {
    const cwd = createRepoForTest();
    const r = await runStorehouseForTest(['pull', 'dev'], { cwd, fake });
    assert.equal(r.code, ExitCode.missing);
    assert.match(
      r.stderr(),
      /1 required secret is missing in dev, so nothing was written\. Set it first:\n {2}storehouse set dev AUTH_SECRET/,
    );
    assert.equal(existsSync(join(cwd, 'worker/.dev.vars')), false);
  });

  it("refuses a value it can't write losslessly, and writes nothing", async () => {
    const cwd = createRepoForTest();
    fake.seed(project, 'acme-dev-AUTH_SECRET', 'it\'s "both"\nlines');
    const r = await runStorehouseForTest(['pull', 'dev'], { cwd, fake });
    assert.equal(r.code, ExitCode.failed);
    assert.match(
      r.stderr(),
      /AUTH_SECRET: a value with a single quote or a line break, and a double quote or a backslash/,
    );
    assert.equal(existsSync(join(cwd, 'worker/.dev.vars')), false);
  });

  it("refuses a value that isn't text", async () => {
    const cwd = createRepoForTest();
    fake.seed(project, 'acme-dev-AUTH_SECRET', Buffer.from([0xff, 0xfe]));
    const r = await runStorehouseForTest(['pull', 'dev'], { cwd, fake });
    assert.equal(r.code, ExitCode.failed);
    assert.match(r.stderr(), /AUTH_SECRET's value isn't UTF-8 text/);
    assert.equal(existsSync(join(cwd, 'worker/.dev.vars')), false);
  });

  it("names a pull file it can't write, as a failure rather than a bug", async () => {
    const manifest = {
      ...fakeManifest(),
      envs: {
        ...fakeManifest().envs,
        dev: { pull: { file: 'missing/.dev.vars' } },
      },
    };
    fake.seed(project, 'acme-dev-AUTH_SECRET', 'x');
    const r = await runStorehouseForTest(['pull', 'dev'], {
      cwd: createRepoForTest(manifest),
      fake,
    });
    assert.equal(r.code, ExitCode.failed);
    assert.match(r.stderr(), /^Couldn't write missing\/\.dev\.vars: ENOENT/);
    assert.doesNotMatch(r.stderr(), /bug/);
  });

  it('writes .env.<env> beside storehouse.json when the env has no pull file', async () => {
    const cwd = createRepoForTest();
    fake.seed(project, 'acme-stage-AUTH_SECRET', 'a');
    const r = await runStorehouseForTest(['pull', 'stage'], { cwd, fake });
    assert.equal(r.code, 0, r.stderr());
    assert.equal(
      readFileSync(join(cwd, '.env.stage'), 'utf8'),
      'AUTH_SECRET=a\n',
    );
    assert.equal(mode(join(cwd, '.env.stage')), 0o600);
    // Outside a git repo the .gitignore step is skipped.
    assert.doesNotMatch(r.stdout(), /gitignore/);
    assert.equal(existsSync(join(cwd, '.gitignore')), false);
    fake.seed(project, 'acme-stage-AUTH_SECRET', 'pa$$');
    const dollar = await runStorehouseForTest(['pull', 'stage', '--force'], {
      cwd,
      fake,
    });
    assert.match(
      dollar.stderr(),
      /AUTH_SECRET has a \$ in its value, and \.env\.stage is a \.env file/,
    );
  });

  describe('in a git repo', () => {
    const gitRepo = (files: Record<string, string> = {}) => {
      const cwd = createRepoForTest(fakeManifest(), files);
      execFileSync('git', ['init', '-q'], { cwd });
      return cwd;
    };

    it('refuses to write values into a file git tracks, before reading any', async () => {
      const cwd = gitRepo({ 'worker/.dev.vars': 'AUTH_SECRET=placeholder\n' });
      execFileSync('git', ['add', 'worker/.dev.vars'], { cwd });
      fake.seed(project, 'acme-dev-AUTH_SECRET', 'real-value');
      for (const argv of [
        ['pull', 'dev', '--force'],
        ['pull', 'dev', '--dry-run'],
      ]) {
        const r = await runStorehouseForTest(argv, { cwd, fake });
        assert.equal(r.code, ExitCode.failed, argv.join(' '));
        assert.equal(
          r.stderr(),
          'worker/.dev.vars is tracked by git, so a pull would put secrets in a commit. Untrack it with: git rm --cached worker/.dev.vars\n',
        );
      }
      assert.equal(
        readFileSync(join(cwd, 'worker/.dev.vars'), 'utf8'),
        'AUTH_SECRET=placeholder\n',
      );
      assert.equal(existsSync(join(cwd, '.gitignore')), false);
      assert.deepEqual(fake.requests, []);
    });

    it('adds the file it writes to the root .gitignore, once', async () => {
      const cwd = gitRepo();
      fake.seed(project, 'acme-stage-AUTH_SECRET', 'a');
      const r = await runStorehouseForTest(['pull', 'stage'], { cwd, fake });
      assert.equal(r.code, 0, r.stderr());
      assert.match(
        r.stdout(),
        /^Added \.env\.stage to \.gitignore\.\nWrote 1 secret/,
      );
      assert.equal(
        readFileSync(join(cwd, '.gitignore'), 'utf8'),
        '.env.stage\n',
      );
      const again = await runStorehouseForTest(['pull', 'stage', '--force'], {
        cwd,
        fake,
      });
      assert.doesNotMatch(again.stdout(), /gitignore/);
      assert.equal(
        readFileSync(join(cwd, '.gitignore'), 'utf8'),
        '.env.stage\n',
      );
    });

    it('appends the path from the repo root, run from anywhere in it', async () => {
      const cwd = gitRepo({ '.gitignore': 'node_modules' });
      fake.seed(project, 'acme-dev-AUTH_SECRET', 'a');
      const r = await runStorehouseForTest(['pull', 'dev'], {
        cwd: join(cwd, 'worker'),
        fake,
      });
      assert.equal(r.code, 0, r.stderr());
      assert.match(r.stdout(), /Added worker\/\.dev\.vars to \.gitignore\./);
      assert.equal(
        readFileSync(join(cwd, '.gitignore'), 'utf8'),
        'node_modules\nworker/.dev.vars\n',
      );
    });

    it('leaves .gitignore alone when git already ignores the file', async () => {
      const cwd = gitRepo({ '.gitignore': '.env*\n' });
      fake.seed(project, 'acme-stage-AUTH_SECRET', 'a');
      const r = await runStorehouseForTest(['pull', 'stage'], { cwd, fake });
      assert.doesNotMatch(r.stdout(), /gitignore/);
      assert.equal(readFileSync(join(cwd, '.gitignore'), 'utf8'), '.env*\n');
    });

    it('says what it would add with --dry-run, and adds nothing', async () => {
      const cwd = gitRepo();
      fake.seed(project, 'acme-stage-AUTH_SECRET', 'a');
      const r = await runStorehouseForTest(['pull', 'stage', '--dry-run'], {
        cwd,
        fake,
      });
      assert.match(r.stdout(), /Would add \.env\.stage to \.gitignore\./);
      assert.equal(existsSync(join(cwd, '.gitignore')), false);
    });
  });

  it('pulls a protected env to .env.<env> for a person who types its name', async () => {
    const cwd = createRepoForTest();
    fake.seed(project, 'acme-prod-AUTH_SECRET', 'p');
    const r = await runStorehouseForTest(['pull', 'prod'], {
      cwd,
      fake,
      tty: true,
      answers: ['prod'],
    });
    assert.equal(r.code, 0, r.stderr());
    assert.equal(r.prompts.length, 1);
    assert.equal(
      readFileSync(join(cwd, '.env.prod'), 'utf8'),
      'AUTH_SECRET=p\n',
    );
    assert.equal(mode(join(cwd, '.env.prod')), 0o600);
    const agent = await runStorehouseForTest(['pull', 'prod', '--force'], {
      cwd,
      fake,
      tty: true,
      env: { CLAUDECODE: '1' },
    });
    assert.equal(agent.code, ExitCode.refused);
  });

  it('refuses to overwrite a file before asking for a protected name', async () => {
    const cwd = createRepoForTest(fakeManifest(), { '.env.prod': 'old' });
    const r = await runStorehouseForTest(['pull', 'prod'], {
      cwd,
      fake,
      tty: true,
      answers: ['prod'],
    });
    assert.equal(r.code, ExitCode.failed);
    assert.match(r.stderr(), /\.env\.prod already exists\. Pass --force/);
    assert.deepEqual(r.prompts, []);
    assert.deepEqual(fake.requests, []);
  });

  it('accepts a pull file on a protected env', async () => {
    const manifest = {
      ...fakeManifest(),
      envs: {
        ...fakeManifest().envs,
        prod: { protected: true, pull: { file: '.dev.vars' } },
      },
    };
    const r = await runStorehouseForTest(['check'], {
      cwd: createRepoForTest(manifest),
    });
    assert.equal(r.code, 0, r.stdout());
  });

  it('refuses a $ in a value for a .env file, which wrangler expands', async () => {
    for (const file of ['.env', '.env.local', 'worker/.env.stage']) {
      const manifest = {
        ...fakeManifest(),
        envs: { ...fakeManifest().envs, dev: { pull: { file } } },
      };
      const cwd = createRepoForTest(manifest);
      fake.reset();
      fake.seed(project, 'acme-dev-AUTH_SECRET', 'pa$$word');
      fake.seed(project, 'acme-dev-TWILIO_SID', 'plain');
      const r = await runStorehouseForTest(['pull', 'dev'], { cwd, fake });
      assert.equal(r.code, ExitCode.failed, file);
      assert.match(
        r.stderr(),
        /AUTH_SECRET has a \$ in its value, and .*\.env.* is a \.env file[\s\S]*Pull to \.dev\.vars instead/,
      );
      assert.equal(existsSync(join(cwd, file)), false);
    }
  });

  it('writes a $ as it is to .dev.vars and other files', async () => {
    for (const file of ['worker/.dev.vars', 'secrets.env', 'env.txt']) {
      const manifest = {
        ...fakeManifest(),
        envs: { ...fakeManifest().envs, dev: { pull: { file } } },
      };
      const cwd = createRepoForTest(manifest);
      fake.reset();
      fake.seed(project, 'acme-dev-AUTH_SECRET', 'pa$$word');
      const r = await runStorehouseForTest(['pull', 'dev'], { cwd, fake });
      assert.equal(r.code, 0, r.stderr());
      assert.equal(
        readFileSync(join(cwd, file), 'utf8'),
        'AUTH_SECRET=pa$$word\n',
      );
    }
  });
});

describe('where pull and push may write', () => {
  const withPaths = (pull: string, dir = 'worker') => {
    const manifest = fakeManifest();
    return {
      ...manifest,
      envs: {
        ...manifest.envs,
        dev: { pull: { file: pull } },
        stage: { push: [{ to: 'cloudflare-workers', dir }] },
      },
    };
  };

  for (const [pull, dir, message] of [
    [
      '/etc/storehouse.env',
      'worker',
      /envs\.dev\.pull\.file: A path here is relative to storehouse\.json/,
    ],
    [
      '../escaped.env',
      'worker',
      /envs\.dev\.pull\.file: A path here is relative to storehouse\.json/,
    ],
    [
      '.dev.vars',
      '../elsewhere',
      /envs\.stage\.push\.0\.dir: A path here is relative to storehouse\.json/,
    ],
    [
      '.dev.vars',
      '/abs/worker',
      /envs\.stage\.push\.0\.dir: A path here is relative to storehouse\.json/,
    ],
  ] as const) {
    it(`refuses ${pull === '.dev.vars' ? dir : pull} in check and every command`, async () => {
      const cwd = createRepoForTest(withPaths(pull, dir));
      const checked = await runStorehouseForTest(['check'], { cwd });
      assert.equal(checked.code, ExitCode.manifest);
      assert.match(checked.stdout(), message);
      const pulled = await runStorehouseForTest(['pull', 'dev', '--force'], {
        cwd,
        fake,
      });
      assert.equal(pulled.code, ExitCode.manifest);
      assert.match(pulled.stderr(), message);
    });
  }

  it('refuses a pull file reached through a symlinked directory outside the repo', async () => {
    const outside = createRepoForTest();
    const cwd = createRepoForTest(withPaths('linked/.dev.vars'));
    symlinkSync(outside, join(cwd, 'linked'));
    const r = await runStorehouseForTest(['check'], { cwd });
    assert.equal(r.code, ExitCode.manifest);
    assert.match(
      r.stdout(),
      /envs\.dev\.pull\.file: "linked\/\.dev\.vars" is outside the repo/,
    );
  });
});
