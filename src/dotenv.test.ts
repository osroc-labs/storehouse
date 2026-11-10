import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { parse as dotenvParse } from 'dotenv';
import { dotenvService } from './dotenv.ts';

const {
  format: formatDotenv,
  parse: parseDotenv,
  stripTrailingNewline,
} = dotenvService;

describe('dotenvService', () => {
  it('parses keys and values, skipping comments', () => {
    assert.deepEqual(parseDotenv('# note\nA=1\nB="two words"\n'), {
      A: '1',
      B: 'two words',
    });
  });

  it('round-trips awkward values', () => {
    const vars = {
      PLAIN: 'abc123',
      EMPTY: '',
      SPACES: 'has space # and hash',
      DOUBLE: 'say "hi"',
      SINGLE: "it's",
      NEWLINE: 'one\ntwo',
      BACKSLASH: 'a\\b',
      BACKTICK: 'a`b',
      DOLLAR: '$HOME and ${PATH}',
      PEM: '-----BEGIN KEY-----\nabc\n-----END KEY-----',
    };
    const written = formatDotenv(vars);
    assert.deepEqual(parseDotenv(written), vars);
    assert.deepEqual(dotenvParse(written), vars);
  });

  it("refuses a value it can't write losslessly, naming the key", () => {
    assert.throws(() => formatDotenv({ X: 'it\'s "both"\n' }), /^Error: X:|X:/);
    assert.throws(() => formatDotenv({ Y: "it's\\here" }), /Y:/);
  });

  it('refuses a carriage return, which neither parser reads back', () => {
    for (const value of ['a\rb', 'a\r\nb', 'abc\r']) {
      assert.throws(
        () => formatDotenv({ CR: value }),
        /CR: a value with a carriage return/,
      );
    }
  });
});

describe('trailing newlines', () => {
  it('drops one, from a paste', () => {
    assert.equal(stripTrailingNewline('abc\n'), 'abc');
    assert.equal(stripTrailingNewline('abc\n\n'), 'abc\n');
    assert.equal(stripTrailingNewline('abc'), 'abc');
  });
});
