import assert from 'node:assert/strict';
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
  fake = await fakeSecretManager({ pageSize: 2 });
});
after(async () => {
  await fake.close();
});
beforeEach(() => {
  fake.reset();
});

// a manifest with a rule for a team's own reusable workflows and action, as a release pipeline has
const manifestWithRules = () => ({
  ...fakeManifest(),
  workflows: [
    {
      uses: 'my-org/release/.github/workflows/*',
      inputs: {
        '*-secret': 'name',
        '*-secrets': 'names',
        'deploy-secret-env': 'labelled',
      },
    },
    { uses: 'my-org/release/actions/secrets', inputs: { secrets: 'labelled' } },
  ],
});

const releaseWorkflow = (withBlock: string) => `name: Release
on: push
jobs:
  ios:
    uses: my-org/release/.github/workflows/ios.yml@v1
    with:
${withBlock}
  deploy:
    runs-on: ubuntu-latest
    steps:
      - uses: my-org/release/actions/secrets@v1
        with:
          secrets: |
            dist-cert.p12: acme-prod-AUTH_SECRET
            other.txt: acme-prod-TWILIO_SID@3
`;

const googleWorkflow = (secrets: string) => `on: push
jobs:
  deploy:
    runs-on: ubuntu-latest
    steps:
      - id: secrets
        uses: google-github-actions/get-secretmanager-secrets@v3
        with:
          secrets: ${secrets}
`;

describe('check', () => {
  it('passes a good manifest and the workflows its rules describe, with no Google access', async () => {
    const cwd = createRepoForTest(manifestWithRules(), {
      '.github/workflows/release.yml':
        releaseWorkflow(`      p12-secret: acme-prod-AUTH_SECRET
      profile-secrets: |
        acme-prod-TWILIO_SID
        acme-stage-TWILIO_SID
      deploy-secret-env: "EXPO_TOKEN: acme-dev-SEED_TOKEN"
      asc-key-id-secret: \${{ vars.KEY }}
      gcp-project-number: "123"`),
      '.github/workflows/other.yml':
        'on: push\njobs:\n  x:\n    uses: someone/else/.github/workflows/a.yml@v1\n    with:\n      p12-secret: nope\n',
    });
    const r = await runStorehouseForTest(['check'], { cwd, fake });
    assert.equal(r.code, 0, r.stdout());
    assert.match(
      r.stdout(),
      /is good: 3 envs, 3 secrets, 7 Secret Manager names, 1 workflow checked\./,
    );
    assert.deepEqual(fake.requests, []);
  });

  it('names each secret a workflow names that the manifest lacks', async () => {
    const cwd = createRepoForTest(manifestWithRules(), {
      '.github/workflows/release.yml':
        releaseWorkflow(`      p12-secret: acme-prod-P12
      profile-secrets: |
        acme-prod-PROFILE`),
    });
    const r = await runStorehouseForTest(['check'], { cwd });
    assert.equal(r.code, ExitCode.manifest);
    assert.match(r.stdout(), /has 2 problems:/);
    assert.match(
      r.stdout(),
      /release\.yml: jobs\.ios\.with\.p12-secret names "acme-prod-P12", which storehouse\.json doesn't have/,
    );
    assert.match(
      r.stdout(),
      /jobs\.ios\.with\.profile-secrets names "acme-prod-PROFILE"/,
    );
  });

  it("ignores another team's workflows when the manifest has no rule for them", async () => {
    const cwd = createRepoForTest(fakeManifest(), {
      '.github/workflows/release.yml': releaseWorkflow(
        '      p12-secret: anything',
      ),
    });
    const r = await runStorehouseForTest(['check'], { cwd });
    assert.equal(r.code, 0, r.stdout());
    assert.doesNotMatch(r.stdout(), /workflow checked/);
  });

  it("knows Google's get-secretmanager-secrets in every form it takes", async () => {
    const cwd = createRepoForTest(fakeManifest(), {
      '.github/workflows/a.yml': googleWorkflow(`|
            token:acme-test/acme-stage-AUTH_SECRET
            sid:projects/acme-test/secrets/acme-stage-TWILIO_SID/versions/3
            old:acme-test/acme-dev-SEED_TOKEN/2, other:another-project/anything
            regional:projects/acme-test/locations/us/secrets/whatever`),
    });
    const ok = await runStorehouseForTest(['check'], { cwd });
    assert.equal(ok.code, 0, ok.stdout());
    assert.match(ok.stdout(), /1 workflow checked/);

    const missing = createRepoForTest(fakeManifest(), {
      '.github/workflows/a.yml': googleWorkflow(
        '"a:acme-test/acme-stage-NOPE, b:projects/acme-test/secrets/acme-dev-ALSO_NOPE"',
      ),
    });
    const r = await runStorehouseForTest(['check'], { cwd: missing });
    assert.equal(r.code, ExitCode.manifest);
    assert.match(
      r.stdout(),
      /names "acme-test\/acme-stage-NOPE", which storehouse\.json doesn't have/,
    );
    assert.match(r.stdout(), /names "acme-test\/acme-dev-ALSO_NOPE"/);
  });

  it('refuses a workflow rule with an unknown input format', async () => {
    const manifest = {
      ...fakeManifest(),
      workflows: [{ uses: 'x/y', inputs: { secret: 'csv' } }],
    };
    const r = await runStorehouseForTest(['check'], {
      cwd: createRepoForTest(manifest),
    });
    assert.equal(r.code, ExitCode.manifest);
    assert.match(r.stdout(), /workflows\.0\.inputs\.secret/);
  });

  it('reports schema problems, missing directories and bad YAML', async () => {
    const manifest = {
      ...fakeManifest(),
      envs: {
        ...fakeManifest().envs,
        stage: { push: [{ to: 'cloudflare-workers', dir: 'gone' }] },
      },
    };
    const cwd = createRepoForTest(manifest, {
      '.github/workflows/bad.yml': 'jobs: [\n',
    });
    const r = await runStorehouseForTest(['check', '--json'], { cwd });
    assert.equal(r.code, ExitCode.manifest);
    const parsed: unknown = JSON.parse(r.stdout());
    assert.ok(
      typeof parsed === 'object' && parsed !== null && 'problems' in parsed,
    );
    assert.match(
      JSON.stringify(parsed.problems),
      /envs\.stage\.push\[0\]\.dir: there's no directory gone/,
    );
    assert.match(JSON.stringify(parsed.problems), /bad\.yml: isn't valid YAML/);
  });
});
