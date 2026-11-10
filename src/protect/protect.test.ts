import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { ExitCode } from '../errors.ts';
import {
  createIoForTest,
  fakeManifest,
} from '../testing/storehouse-for-test.ts';
import { agentMarkers, getAgentMarker, ignoredAgentMarkers } from './agents.ts';
import { protectedInvocation, verifyProtectedAccess } from './protect.ts';
import type { ProtectedEnvs } from './protect.ts';

const envsOf = (argv: string[], manifest: ProtectedEnvs = fakeManifest()) =>
  protectedInvocation(argv, manifest)?.envs;

describe('protectedInvocation', () => {
  it('finds the env in the first word after the command', () => {
    for (const command of ['set', 'get', 'history']) {
      assert.deepEqual(envsOf([command, 'prod', 'AUTH_SECRET']), ['prod']);
      assert.equal(envsOf([command, 'stage', 'AUTH_SECRET']), undefined);
    }
    assert.deepEqual(envsOf(['history', 'prod']), ['prod']);
    assert.deepEqual(envsOf(['history', 'prod', '--limit', '5']), ['prod']);
    assert.deepEqual(envsOf(['history', '--limit=0', 'prod']), ['prod']);
    assert.equal(envsOf(['history', 'stage', '--limit', '5']), undefined);
    assert.deepEqual(envsOf(['history', 'prod', '--all']), ['prod']);
    assert.deepEqual(envsOf(['pull', 'prod']), ['prod']);
    assert.deepEqual(envsOf(['push', 'prod']), ['prod']);
    assert.deepEqual(envsOf(['push', 'prod', 'AUTH_SECRET', 'TWILIO_SID']), [
      'prod',
    ]);
    assert.equal(envsOf(['push', 'stage', 'AUTH_SECRET']), undefined);
  });

  it('finds every env status names, and none when it names none', () => {
    assert.deepEqual(envsOf(['status', 'dev', 'prod']), ['prod']);
    assert.deepEqual(envsOf(['status', 'prod', 'prod']), ['prod']);
    assert.equal(envsOf(['status']), undefined);
    assert.equal(envsOf(['status', 'dev', 'stage']), undefined);
    assert.equal(envsOf(['check']), undefined);
  });

  it('reads flags before the command and after it', () => {
    assert.deepEqual(envsOf(['--json', 'status', 'prod']), ['prod']);
    assert.deepEqual(envsOf(['--dry-run', 'push', 'prod']), ['prod']);
    assert.deepEqual(envsOf(['push', '--dry-run', 'prod', 'AUTH_SECRET']), [
      'prod',
    ]);
    assert.deepEqual(envsOf(['pull', 'prod', '--force']), ['prod']);
    assert.deepEqual(envsOf(['--force', 'pull', 'prod']), ['prod']);
    assert.deepEqual(envsOf(['--out', 'x', 'get', 'prod', 'AUTH_SECRET']), [
      'prod',
    ]);
    assert.deepEqual(envsOf(['get', '--out=x', 'prod', 'AUTH_SECRET']), [
      'prod',
    ]);
    assert.deepEqual(envsOf(['get', 'prod', 'AUTH_SECRET', '--out', 'x']), [
      'prod',
    ]);
  });

  it("doesn't take a flag's value for the env", () => {
    assert.equal(envsOf(['--out', 'prod', 'get', 'stage', 'A']), undefined);
    assert.equal(envsOf(['get', '--out=prod', 'stage', 'A']), undefined);
    assert.equal(envsOf(['get', 'stage', 'A', '--out', 'prod']), undefined);
  });

  it("doesn't take a key for the env", () => {
    assert.equal(envsOf(['set', 'stage', 'prod']), undefined);
    assert.equal(envsOf(['push', 'stage', 'prod']), undefined);
  });

  it('reads words after -- as storehouse does', () => {
    assert.deepEqual(envsOf(['get', '--', 'prod', 'AUTH_SECRET']), ['prod']);
  });

  it('lets help through, which touches nothing', () => {
    assert.equal(envsOf(['get', 'prod', 'AUTH_SECRET', '--help']), undefined);
    assert.equal(envsOf(['help', 'get']), undefined);
    assert.equal(envsOf(['--help']), undefined);
  });

  it('counts any word naming a protected env when storehouse would refuse the line', () => {
    assert.deepEqual(envsOf(['get', '--bogus', 'prod', 'A']), ['prod']);
    assert.deepEqual(envsOf(['status', '--env=prod']), ['prod']);
    assert.deepEqual(envsOf(['get', 'prod']), ['prod']);
    assert.deepEqual(envsOf(['get', 'prod', 'A', '--out']), ['prod']);
    assert.deepEqual(envsOf(['storehouse', 'get', 'prod', 'A']), ['prod']);
    assert.deepEqual(envsOf(['prod']), ['prod']);
    assert.equal(envsOf(['get', '--bogus', 'stage', 'A']), undefined);
  });

  it('knows only the envs the manifest protects', () => {
    const open = { envs: { dev: {}, prod: { protected: false } } };
    assert.equal(envsOf(['get', 'prod', 'A'], open), undefined);
    assert.equal(envsOf(['get', 'production', 'A']), undefined);
    assert.equal(envsOf(['get', 'toString', 'A']), undefined);
  });

  it('gives a reason a guard can show', () => {
    assert.match(
      protectedInvocation(['get', 'prod', 'A'], fakeManifest())?.reason ?? '',
      /protected env prod/,
    );
  });
});

describe('agent markers', () => {
  it('finds each marker, set and non-empty', () => {
    for (const marker of agentMarkers) {
      const value = 'value' in marker ? marker.value : '1';
      assert.equal(getAgentMarker({ [marker.name]: value })?.name, marker.name);
    }
    assert.deepEqual(getAgentMarker({ AI_AGENT: 'claude-code_2_agent' }), {
      name: 'AI_AGENT',
      agent: 'claude-code_2_agent',
    });
    assert.deepEqual(getAgentMarker({ AI_AGENT: 'x', CLAUDECODE: '1' }), {
      name: 'CLAUDECODE',
      agent: 'Claude Code',
    });
    assert.equal(getAgentMarker({}), undefined);
    assert.equal(getAgentMarker({ CLAUDECODE: '' }), undefined);
    assert.equal(getAgentMarker({ CLAUDECODE: '  ' }), undefined);
  });

  it("doesn't count what a person's own terminal sets", () => {
    for (const marker of ignoredAgentMarkers) {
      assert.equal(getAgentMarker({ [marker.name]: '1' }), undefined);
    }
    assert.equal(
      getAgentMarker({ CURSOR_EXTENSION_HOST_ROLE: 'user' }),
      undefined,
    );
    assert.equal(getAgentMarker({ TERM_PROGRAM: 'vscode' }), undefined);
  });
});

describe('verifyProtectedAccess', () => {
  const cwd = '/';

  it('refuses under an agent, before asking anything', async () => {
    const t = createIoForTest({
      cwd,
      tty: true,
      env: { CODEX_SANDBOX: 'seatbelt' },
    });
    await assert.rejects(
      verifyProtectedAccess(['prod'], t.io),
      (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.match(
          error.message,
          /CODEX_SANDBOX is set in this shell \(Codex CLI\)/,
        );
        assert.equal('exitCode' in error && error.exitCode, ExitCode.refused);
        return true;
      },
    );
    assert.deepEqual(t.prompts, []);
  });

  it('needs a terminal on stdin and on stdout', async () => {
    for (const [stdinTTY, stdoutTTY] of [
      [false, true],
      [true, false],
      [false, false],
    ] as const) {
      const t = createIoForTest({
        cwd,
        stdinTTY,
        stdoutTTY,
        answers: ['prod'],
      });
      await assert.rejects(
        verifyProtectedAccess(['prod'], t.io),
        /in a terminal/,
      );
      assert.deepEqual(t.prompts, []);
    }
  });

  it('needs the name typed', async () => {
    const wrong = createIoForTest({ cwd, tty: true, answers: ['yes'] });
    await assert.rejects(
      verifyProtectedAccess(['prod'], wrong.io),
      /That isn't "prod"/,
    );
    const right = createIoForTest({ cwd, tty: true, answers: ['prod'] });
    await verifyProtectedAccess(['prod'], right.io);
    assert.equal(right.prompts.length, 1);
    assert.equal(right.prompts[0]?.isHidden, false);
  });

  it('asks for each protected env', async () => {
    const t = createIoForTest({ cwd, tty: true, answers: ['prod', 'nope'] });
    await assert.rejects(
      verifyProtectedAccess(['prod', 'live'], t.io),
      /"live"/,
    );
    assert.equal(t.prompts.length, 2);
  });

  it('does nothing for no protected env', async () => {
    const t = createIoForTest({ cwd, env: { CLAUDECODE: '1' } });
    await verifyProtectedAccess([], t.io);
  });
});
