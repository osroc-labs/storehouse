import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, before, beforeEach, describe, it } from 'node:test';
import { ExitCode } from './errors.ts';
import { fakeSecretManager } from './testing/fake-secret-manager.ts';
import type { Fake } from './testing/fake-secret-manager.ts';
import {
  createRepoForTest,
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

const asAgent = { env: { CLAUDECODE: '1' }, tty: true };

// a repo whose committed manifest protects prod, with the working copy edited to drop it
const createEditedRepoForTest = () => {
  const cwd = createRepoForTest();
  execFileSync('git', ['init', '-q'], { cwd });
  execFileSync('git', ['add', 'storehouse.json'], { cwd });
  execFileSync(
    'git',
    [
      '-c',
      'user.name=t',
      '-c',
      'user.email=t@example.com',
      'commit',
      '-qm',
      'manifest',
    ],
    { cwd },
  );
  const manifest = fakeManifest();
  writeFileSync(
    join(cwd, 'storehouse.json'),
    JSON.stringify({ ...manifest, envs: { ...manifest.envs, prod: {} } }),
  );
  return cwd;
};

describe('what makes an env protected', () => {
  it('keeps an env protected when an edit removes it from the committed manifest', async () => {
    const cwd = createEditedRepoForTest();
    fake.seed(project, 'acme-prod-AUTH_SECRET', 'prod-value');
    const r = await runStorehouseForTest(['get', 'prod', 'AUTH_SECRET'], {
      cwd,
      fake,
      ...asAgent,
    });
    assert.equal(r.code, ExitCode.refused);
    assert.match(r.stderr(), /prod is a protected env, and CLAUDECODE is set/);
    assert.deepEqual(fake.requests, []);
    const status = await runStorehouseForTest(['status'], { cwd, fake });
    assert.match(status.stdout(), /prod is protected and not shown/);
  });

  it('applies the rules to a secret labelled protected, whatever the manifest says', async () => {
    fake.seed(project, 'acme-stage-AUTH_SECRET', 'labelled-value', 'ENABLED', {
      'storehouse-protected': 'true',
    });
    const cwd = createRepoForTest();
    const agent = await runStorehouseForTest(['get', 'stage', 'AUTH_SECRET'], {
      cwd,
      fake,
      ...asAgent,
    });
    assert.equal(agent.code, ExitCode.refused);
    assert.equal(
      fake.requests.filter((q) => q.path.endsWith(':access')).length,
      0,
    );

    const piped = await runStorehouseForTest(['pull', 'stage', '--force'], {
      cwd,
      fake,
    });
    assert.equal(piped.code, ExitCode.refused);

    const person = await runStorehouseForTest(['get', 'stage', 'AUTH_SECRET'], {
      cwd,
      fake,
      tty: true,
      answers: ['stage'],
    });
    assert.equal(person.code, ExitCode.ok, person.stderr());
    assert.equal(person.stdout(), 'labelled-value');
    assert.equal(person.prompts.length, 1);
  });

  it('labels a protected env’s secrets when it sets them', async () => {
    const cwd = createRepoForTest();
    const created = await runStorehouseForTest(['set', 'prod', 'AUTH_SECRET'], {
      cwd,
      fake,
      tty: true,
      answers: ['prod', 'new-prod-value'],
    });
    assert.equal(created.code, ExitCode.ok, created.stderr());
    assert.deepEqual(
      fake.secrets.get(`${project}/acme-prod-AUTH_SECRET`)?.labels,
      {
        storehouse: 'true',
        env: 'prod',
        'storehouse-protected': 'true',
      },
    );

    fake.seed(project, 'acme-prod-TWILIO_SID', 'older-value');
    const relabelled = await runStorehouseForTest(
      ['set', 'prod', 'TWILIO_SID'],
      {
        cwd,
        fake,
        tty: true,
        answers: ['prod', 'newer-value'],
      },
    );
    assert.equal(relabelled.code, ExitCode.ok, relabelled.stderr());
    assert.equal(
      fake.secrets.get(`${project}/acme-prod-TWILIO_SID`)?.labels[
        'storehouse-protected'
      ],
      'true',
    );
  });

  it("keeps the committed manifest's protection when GIT_DIR points git elsewhere", async () => {
    const cwd = createEditedRepoForTest();
    fake.seed(project, 'acme-prod-AUTH_SECRET', 'prod-value');
    const saved = process.env.GIT_DIR;
    process.env.GIT_DIR = '/nonexistent';
    try {
      const r = await runStorehouseForTest(['get', 'prod', 'AUTH_SECRET'], {
        cwd,
        fake,
        ...asAgent,
      });
      assert.equal(r.code, ExitCode.refused);
      assert.equal(r.stdout(), '');
    } finally {
      if (saved === undefined) delete process.env.GIT_DIR;
      else process.env.GIT_DIR = saved;
    }
  });
});

describe('protect', () => {
  it("labels every existing secret of a protected env, once a person types the env's name", async () => {
    fake.seed(project, 'acme-prod-AUTH_SECRET', 'a-value', 'ENABLED', {
      storehouse: 'true',
    });
    fake.seed(project, 'acme-prod-TWILIO_SID', 'b-value', 'ENABLED', {
      'storehouse-protected': 'true',
    });
    const cwd = createRepoForTest();
    const r = await runStorehouseForTest(['protect', 'prod'], {
      cwd,
      fake,
      tty: true,
      answers: ['prod'],
    });
    assert.equal(r.code, ExitCode.ok, r.stderr());
    assert.equal(
      r.stdout(),
      'Labelled 1 secret in prod storehouse-protected=true: AUTH_SECRET.\nAlready labelled: TWILIO_SID.\n',
    );
    assert.deepEqual(
      fake.secrets.get(`${project}/acme-prod-AUTH_SECRET`)?.labels,
      { storehouse: 'true', 'storehouse-protected': 'true' },
    );
    assert.equal(
      fake.requests.filter((q) => q.path.endsWith(':access')).length,
      0,
    );

    // the label now holds against an edit that unprotects prod
    writeFileSync(
      join(cwd, 'storehouse.json'),
      JSON.stringify({
        ...fakeManifest(),
        envs: { ...fakeManifest().envs, prod: {} },
      }),
    );
    const agent = await runStorehouseForTest(['get', 'prod', 'AUTH_SECRET'], {
      cwd,
      fake,
      ...asAgent,
    });
    assert.equal(agent.code, ExitCode.refused);
  });

  it('names the secrets not set yet, and refuses an agent and an env that is not protected', async () => {
    const cwd = createRepoForTest();
    const r = await runStorehouseForTest(['protect', 'prod'], {
      cwd,
      fake,
      tty: true,
      answers: ['prod'],
    });
    assert.equal(r.code, ExitCode.ok, r.stderr());
    assert.equal(
      r.stdout(),
      'No secret in prod needed the label.\nNot set yet, so not labelled (set labels them): AUTH_SECRET, TWILIO_SID.\n',
    );
    const agent = await runStorehouseForTest(['protect', 'prod'], {
      cwd,
      fake,
      ...asAgent,
    });
    assert.equal(agent.code, ExitCode.refused);
    const open = await runStorehouseForTest(['protect', 'stage'], {
      cwd,
      fake,
    });
    assert.equal(open.code, ExitCode.usage);
    assert.match(open.stderr(), /stage isn't protected/);
  });
});
