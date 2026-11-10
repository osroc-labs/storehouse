import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { cliService } from './run-cli.ts';

describe('cliService.format', () => {
  it('quotes a word a shell would split or read, so the dry run shows one word as one', () => {
    assert.equal(
      cliService.format({
        command: 'gh',
        args: ['secret', 'set', 'KEY', "--env=a --repo=it's/x", '--app=$(id)'],
        cwd: '/repo',
        input: '',
        inputLabel: 'the value',
        installHint: '',
        keys: ['KEY'],
        failureHint: '',
      }),
      "gh secret set KEY '--env=a --repo=it'\\''s/x' '--app=$(id)' < (the value)",
    );
  });
});
