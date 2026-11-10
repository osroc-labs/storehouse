import assert from 'node:assert/strict';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { after, before, beforeEach, describe, it } from 'node:test';
import { commands } from './command-line/commands.ts';
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
  fake = await fakeSecretManager({ pageSize: 2 });
});
after(async () => {
  await fake.close();
});
beforeEach(() => {
  fake.reset();
});

describe('the command line', () => {
  it('prints help for storehouse and every command', async () => {
    const cwd = createRepoForTest();
    const main = await runStorehouseForTest(['--help'], { cwd });
    assert.equal(main.code, 0);
    for (const name of Object.keys(commands)) {
      assert.match(main.stdout(), new RegExp(`  ${name} `));
      for (const argv of [
        [name, '--help'],
        ['help', name],
        [name, '-h'],
      ]) {
        const r = await runStorehouseForTest(argv, { cwd: '/' });
        assert.equal(r.code, 0, argv.join(' '));
        assert.match(r.stdout(), new RegExp(`^Usage: storehouse ${name}`));
      }
    }
    assert.equal((await runStorehouseForTest([], { cwd })).code, 0);
  });

  it('prints its version', async () => {
    const r = await runStorehouseForTest(['--version'], { cwd: '/' });
    assert.match(r.stdout(), /^\d+\.\d+\.\d+\n$/);
  });

  it('refuses a mistake with exit 2 and the fix', async () => {
    const cwd = createRepoForTest();
    const cases: [string[], RegExp][] = [
      [['stats'], /There's no command "stats"\. The commands are status, set/],
      [
        ['status', '--bogus'],
        /^Unknown option --bogus for storehouse status\.\nUsage: storehouse status \[env…\]\n/,
      ],
      [
        ['history', 'stage', '--all'],
        /^Unknown option --all for storehouse history\.\nUsage: storehouse history <env> \[KEY\]\n/,
      ],
      [
        ['--all', 'history', 'stage'],
        /^Unknown option --all for storehouse history\./,
      ],
      [
        ['history', 'stage', '-x'],
        /^Unknown option -x for storehouse history\./,
      ],
      [['--bogus'], /^Unknown option --bogus\.\nRun storehouse --help/],
      [
        ['get', 'dev', 'AUTH_SECRET', '--out'],
        /^--out needs a value\.\nUsage: storehouse get/,
      ],
      [['status', '--json=yes'], /^--json doesn't take a value\./],
      [['history', 'dev', '--limit', 'ten'], /--limit takes a whole number/],
      [
        ['history', 'dev', 'A', 'B'],
        /^Usage: storehouse history <env> \[KEY\]/,
      ],
      [['status', '--force'], /storehouse status doesn't take --force/],
      [['get', 'dev'], /Usage: storehouse get <env> <KEY>/],
      [
        ['get', 'qa', 'AUTH_SECRET'],
        /There's no env "qa".*The envs are dev, stage, prod/,
      ],
      [['status', 'qa'], /There's no env "qa"/],
      [
        ['get', 'dev', 'NOPE'],
        /NOPE isn't in storehouse\.json[\s\S]*"NOPE": \{ "purpose"/,
      ],
      [
        ['get', 'stage', 'SEED_TOKEN'],
        /SEED_TOKEN isn't used in stage\. Its envs are dev/,
      ],
      [['help', 'nope'], /There's no command "nope"/],
    ];
    for (const [argv, message] of cases) {
      const r = await runStorehouseForTest(argv, { cwd, fake });
      assert.equal(r.code, ExitCode.usage, argv.join(' '));
      assert.match(r.stderr(), message, argv.join(' '));
    }
    assert.deepEqual(fake.requests, []);
  });

  it('exits from the real process with the documented codes', () => {
    const cli = fileURLToPath(new URL('../src/cli.ts', import.meta.url));
    const cwd = createRepoForTest();
    const exit = (args: string[]) =>
      spawnSync(process.execPath, [cli, ...args], { cwd, encoding: 'utf8' });
    const unknown = exit(['history', 'stage', '--all']);
    assert.equal(unknown.status, ExitCode.usage);
    assert.equal(unknown.stdout, '');
    assert.match(
      unknown.stderr,
      /^Unknown option --all for storehouse history\./,
    );
    assert.equal(exit(['stats']).status, ExitCode.usage);
    assert.equal(exit(['get', 'dev']).status, ExitCode.usage);
    assert.equal(exit(['history', '--help']).status, 0);
  });

  it('says how to start when there is no manifest', async () => {
    const r = await runStorehouseForTest(['status'], { cwd: '/' });
    assert.equal(r.code, ExitCode.manifest);
    assert.match(r.stderr(), /No storehouse\.json here or in any parent/);
  });

  it('finds the manifest from a subdirectory', async () => {
    const cwd = join(createRepoForTest(), 'worker');
    const r = await runStorehouseForTest(['status', 'dev'], { cwd, fake });
    assert.equal(r.code, ExitCode.missing);
  });

  it('lists every problem with an invalid manifest', async () => {
    const cwd = createRepoForTest({
      project: 'proj-test',
      envs: {},
      secrets: { A: {} },
    });
    const r = await runStorehouseForTest(['status'], { cwd, fake });
    assert.equal(r.code, ExitCode.manifest);
    assert.match(r.stderr(), /has problems:\n {2}secrets\.A\.purpose/);
  });
});

describe('a protected env', () => {
  it('refuses under an agent, before any Google request', async () => {
    for (const argv of [
      ['get', 'prod', 'AUTH_SECRET'],
      ['--json', 'status', 'dev', 'prod'],
      ['push', '--dry-run', 'prod'],
      ['history', 'prod', 'AUTH_SECRET'],
    ]) {
      const r = await runStorehouseForTest(argv, {
        cwd: createRepoForTest(),
        fake,
        tty: true,
        env: { CLAUDECODE: '1' },
        answers: ['prod'],
      });
      assert.equal(r.code, ExitCode.refused, argv.join(' '));
      assert.match(
        r.stderr(),
        /prod is a protected env, and CLAUDECODE is set/,
      );
      assert.deepEqual(r.prompts, []);
    }
    assert.deepEqual(fake.requests, []);
  });

  it('refuses without a terminal on both ends', async () => {
    const piped = await runStorehouseForTest(['get', 'prod', 'AUTH_SECRET'], {
      cwd: createRepoForTest(),
      fake,
      stdinTTY: true,
      stdoutTTY: false,
    });
    assert.equal(piped.code, ExitCode.refused);
    assert.match(piped.stderr(), /nothing piped into or out of it/);
    const fed = await runStorehouseForTest(['set', 'prod', 'AUTH_SECRET'], {
      cwd: createRepoForTest(),
      fake,
      stdinTTY: false,
      stdoutTTY: true,
      stdin: 'x',
    });
    assert.equal(fed.code, ExitCode.refused);
    assert.deepEqual(fake.requests, []);
  });

  it("refuses when the name typed isn't the env's", async () => {
    const r = await runStorehouseForTest(['get', 'prod', 'AUTH_SECRET'], {
      cwd: createRepoForTest(),
      fake,
      tty: true,
      answers: ['y'],
    });
    assert.equal(r.code, ExitCode.refused);
    assert.deepEqual(fake.requests, []);
  });

  it('reports a mistake before asking for the name', async () => {
    const cwd = createRepoForTest(fakeManifest(), { 'taken.txt': 'x' });
    const cases: [string[], number, RegExp][] = [
      [
        ['get', 'prod', 'NOPE'],
        ExitCode.usage,
        /NOPE isn't in storehouse\.json/,
      ],
      [
        ['set', 'prod', 'NOPE'],
        ExitCode.usage,
        /NOPE isn't in storehouse\.json/,
      ],
      [
        ['history', 'prod', 'NOPE'],
        ExitCode.usage,
        /NOPE isn't in storehouse\.json/,
      ],
      [
        ['push', 'prod', 'NOPE'],
        ExitCode.usage,
        /NOPE isn't in storehouse\.json/,
      ],
      [
        ['get', 'prod', 'SEED_TOKEN'],
        ExitCode.usage,
        /SEED_TOKEN isn't used in prod/,
      ],
      [
        ['get', 'prod', 'AUTH_SECRET', '--out', 'taken.txt'],
        ExitCode.failed,
        /taken\.txt already exists/,
      ],
      [['status', 'dev', 'prod', 'qa'], ExitCode.usage, /There's no env "qa"/],
    ];
    for (const [argv, code, message] of cases) {
      const r = await runStorehouseForTest(argv, {
        cwd,
        fake,
        tty: true,
        answers: ['prod'],
      });
      assert.equal(r.code, code, argv.join(' '));
      assert.match(r.stderr(), message, argv.join(' '));
      assert.deepEqual(r.prompts, [], argv.join(' '));
    }
    assert.deepEqual(fake.requests, []);
  });

  it('works for a person who types its name', async () => {
    fake.seed(project, 'acme-prod-AUTH_SECRET', 'p');
    const r = await runStorehouseForTest(['get', 'prod', 'AUTH_SECRET'], {
      cwd: createRepoForTest(),
      fake,
      tty: true,
      answers: ['prod'],
    });
    assert.equal(r.code, 0, r.stderr());
    assert.equal(r.stdout(), 'p');
    const set = await runStorehouseForTest(['set', 'prod', 'AUTH_SECRET'], {
      cwd: createRepoForTest(),
      fake,
      tty: true,
      answers: ['prod', 'q'],
    });
    assert.equal(set.code, 0, set.stderr());
    assert.deepEqual(
      set.prompts.map((p) => p.isHidden),
      [false, true],
    );
  });

  it('asks nothing of an env that is not protected', async () => {
    const r = await runStorehouseForTest(['get', 'stage', 'AUTH_SECRET'], {
      cwd: createRepoForTest(),
      fake,
      env: { CLAUDECODE: '1' },
    });
    assert.equal(r.code, ExitCode.missing);
    assert.deepEqual(r.prompts, []);
  });
});
