import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, beforeEach, describe, it } from 'node:test';
import { ExitCode } from './errors.ts';
import { fakeSecretManager } from './testing/fake-secret-manager.ts';
import type { Fake } from './testing/fake-secret-manager.ts';
import {
  fakeManifest,
  runStorehouseForTest,
} from './testing/storehouse-for-test.ts';

const project = 'acme-test';
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

// A git repo with two apps, each with its own storehouse.json, as a monorepo or deploy repo has.
const createMonorepoForTest = () => {
  const root = mkdtempSync(join(tmpdir(), 'storehouse-monorepo-'));
  execFileSync('git', ['init', '-q'], { cwd: root });
  for (const app of ['api', 'web']) {
    const manifest = fakeManifest();
    const dir = join(root, 'apps', app);
    mkdirSync(join(dir, 'worker'), { recursive: true });
    writeFileSync(
      join(dir, 'storehouse.json'),
      JSON.stringify({
        ...manifest,
        name: `${app}-{env}-{key}`,
        envs: { ...manifest.envs, dev: { pull: { file: '.dev.vars' } } },
      }),
    );
  }
  return root;
};

describe('a repo with a manifest per app', () => {
  it('uses the nearest manifest, with paths from its own directory, and ignores the file from the repo root', async () => {
    const root = createMonorepoForTest();
    fake.seed(project, 'api-dev-AUTH_SECRET', 'api-value');
    const r = await runStorehouseForTest(['pull', 'dev'], {
      cwd: join(root, 'apps', 'api', 'worker'),
      fake,
    });
    assert.equal(r.code, ExitCode.ok, r.stderr());
    assert.equal(
      readFileSync(join(root, 'apps/api/.dev.vars'), 'utf8'),
      'AUTH_SECRET=api-value\n',
    );
    assert.equal(existsSync(join(root, 'apps/web/.dev.vars')), false);
    assert.match(r.stdout(), /^Added apps\/api\/\.dev\.vars to \.gitignore\./);
    assert.equal(
      readFileSync(join(root, '.gitignore'), 'utf8'),
      'apps/api/.dev.vars\n',
    );
    assert.ok(fake.requests.every((q) => !q.path.includes('web-')));
  });

  it('pushes from the push dir beside its own manifest', async () => {
    const root = createMonorepoForTest();
    fake.seed(project, 'web-stage-AUTH_SECRET', 'web-value');
    const r = await runStorehouseForTest(['push', 'stage', '--dry-run'], {
      cwd: join(root, 'apps', 'web'),
      fake,
    });
    assert.equal(r.code, ExitCode.ok, r.stderr());
    assert.match(r.stdout(), /to cloudflare-workers in worker \(--env stage\)/);
  });

  it("checks the repo root's workflows from an app's manifest", async () => {
    const root = createMonorepoForTest();
    mkdirSync(join(root, '.github', 'workflows'), { recursive: true });
    writeFileSync(
      join(root, '.github/workflows/deploy.yml'),
      `on: push\njobs:\n  d:\n    runs-on: ubuntu-latest\n    steps:\n      - uses: google-github-actions/get-secretmanager-secrets@v3\n        with:\n          secrets: "a:acme-test/api-stage-NOPE"\n`,
    );
    const r = await runStorehouseForTest(['check'], {
      cwd: join(root, 'apps', 'api'),
    });
    assert.equal(r.code, ExitCode.manifest);
    assert.match(
      r.stdout(),
      /\.github\/workflows\/deploy\.yml: .* names "acme-test\/api-stage-NOPE"/,
    );
  });
});
