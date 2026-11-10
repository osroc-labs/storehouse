import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { workflowService } from './workflows.ts';

const { isGlobMatch } = workflowService;

describe('workflowService.isGlobMatch', () => {
  for (const [pattern, text, expected] of [
    [
      'my-org/release/.github/workflows/*',
      'my-org/release/.github/workflows/ios.yml',
      true,
    ],
    ['*-secret', 'p12-secret', true],
    ['*-secret', 'p12-secrets', false],
    ['a*b*c', 'axxbyyc', true],
    ['a*b*c', 'axxbyy', false],
    ['exact', 'exact', true],
    ['exact', 'exactly', false],
    ['*', '', true],
    ['a.b', 'axb', false],
  ] as const) {
    it(`isGlobMatch(${pattern}, ${text}) is ${expected}`, () => {
      assert.equal(isGlobMatch(pattern, text), expected);
    });
  }

  it("finishes fast on the reviewer's pattern that hung the old matcher", () => {
    const pattern = `${'*a'.repeat(30)}*b`;
    const text = 'a'.repeat(900);
    const started = performance.now();
    assert.equal(isGlobMatch(pattern, text), false);
    assert.ok(performance.now() - started < 100, 'took 100ms or more');
  });

  it("doesn't match a pattern or text too long to be real", () => {
    assert.equal(isGlobMatch('*'.repeat(201), 'x'), false);
    assert.equal(isGlobMatch('*', 'x'.repeat(1001)), false);
  });
});
