import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { format } from './format.ts';

// times a person reads are in their own zone; the tests pin one
process.env.TZ = 'UTC';

const now = new Date('2026-03-10T12:00:00Z');

describe('format', () => {
  for (const [iso, expected] of [
    ['2026-03-10T11:59:30Z', 'just now'],
    ['2026-03-10T11:58:00Z', '2m ago'],
    ['2026-03-10T09:00:00Z', '3h ago'],
    ['2026-03-07T12:00:00Z', '3d ago'],
    ['2026-01-09T12:00:00Z', '2mo ago'],
    ['2024-03-10T12:00:00Z', '2y ago'],
  ] as const) {
    it(`format.ago(${iso}) is "${expected}"`, () => {
      assert.equal(format.ago(iso, now), expected);
    });
  }

  it('shows when, with the year only when it is not this one', () => {
    assert.equal(
      format.when('2026-11-02T22:38:59.123456Z', now),
      'Nov 2 22:38',
    );
    assert.equal(format.when('2025-11-02T22:38:00Z', now), 'Nov 2 2025 22:38');
  });

  it('counts one and many', () => {
    assert.equal(format.plural(1, 'secret'), '1 secret');
    assert.equal(format.plural(2, 'secret'), '2 secrets');
    assert.equal(format.plural(0, 'is', 'are'), '0 are');
  });

  it('pads table columns by visible width, colour aside', () => {
    const paint = format.painter({ env: { FORCE_COLOR: '1' }, isTTY: false });
    assert.equal(
      format.table([
        [paint('bold', 'a'), 'bb', 'c'],
        ['ddd', 'e', ''],
      ]),
      `${paint('bold', 'a')}    bb  c\nddd  e`,
    );
  });

  it('paints only for a terminal that wants colour', () => {
    const tty = { isTTY: true };
    assert.equal(
      format.terminalSafe(format.painter({ ...tty, env: {} })('red', 'x')),
      '\u001b[31mx\u001b[39m',
    );
    // text inside the paint can't colour itself
    assert.equal(
      format.terminalSafe(
        format.painter({ ...tty, env: {} })('red', '\u001b[32mx'),
      ),
      '\u001b[31m\\u001b[32mx\u001b[39m',
    );
    assert.equal(
      format.painter({ ...tty, env: { NO_COLOR: '1' } })('red', 'x'),
      'x',
    );
    assert.equal(
      format.painter({ ...tty, env: { TERM: 'dumb' } })('red', 'x'),
      'x',
    );
    assert.equal(format.painter({ isTTY: false, env: {} })('red', 'x'), 'x');
  });

  it('cuts text to the room it has', () => {
    assert.equal(format.truncate('abcdef', 4), 'abc…');
    assert.equal(format.truncate('abc', 4), 'abc');
    assert.equal(format.truncate('abcdef', 0), 'abcdef');
  });
});
