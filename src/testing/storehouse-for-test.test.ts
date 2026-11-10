import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { cloudflareWorkersTarget } from '../push-targets/cloudflare-workers.ts';
import { findLeakForTest } from './storehouse-for-test.ts';

const pem =
  '-----BEGIN PRIVATE KEY-----\nMIIEvQIBADANBgkqhkiG9w0B\n-----END PRIVATE KEY-----';

describe('findLeakForTest', () => {
  it('catches a value carried in wrangler’s JSON in argv, the leak a reviewer planted', () => {
    const [invocation] = cloudflareWorkersTarget.getInvocations({
      target: { to: 'cloudflare-workers', dir: '.' },
      root: '/repo',
      values: { KEY: pem },
    });
    assert.ok(invocation);
    const leakyArgv = [...invocation.args, invocation.input];
    assert.equal(
      findLeakForTest({
        values: [pem],
        places: [{ where: "a CLI's argv", text: leakyArgv.join('\n') }],
      }),
      "a CLI's argv",
    );
  });

  for (const [form, text] of [
    ['base64', Buffer.from(pem).toString('base64')],
    ['URL-encoded', encodeURIComponent(pem)],
    ['one line of it', 'MIIEvQIBADANBgkqhkiG9w0B'],
    ['JSON-escaped', JSON.stringify(pem)],
  ] as const) {
    it(`catches a value written ${form}`, () => {
      assert.equal(
        findLeakForTest({ values: [pem], places: [{ where: 'stderr', text }] }),
        'stderr',
      );
    });
  }

  it('lets ordinary output through', () => {
    assert.equal(
      findLeakForTest({
        values: [pem],
        places: [{ where: 'stdout', text: 'Sent 1 secret from stage: KEY.' }],
      }),
      undefined,
    );
  });
});
