import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { parse as parseWithWranglerDotenv } from 'dotenv';
import fc from 'fast-check';
import { dotenvService } from './dotenv.ts';
import { CliError } from './errors.ts';

// any text at all, weighted toward the characters dotenv treats specially
const valueArbitrary = fc.oneof(
  fc.string({ unit: 'binary' }),
  fc.string({
    unit: fc.constantFrom(
      '"',
      "'",
      '`',
      '\\',
      '\n',
      '\r',
      '#',
      '$',
      ' ',
      '\t',
      '=',
      'a',
      'é',
      ' ',
      '\0',
    ),
  }),
);

// what each refusal says about the value, checked against the value itself
const isRefusalTrue = (message: string, value: string) => {
  if (/carriage return/.test(message)) return value.includes('\r');
  if (/single quote or a line break/.test(message)) {
    return /['\n]/.test(value) && /["\\]/.test(value);
  }
  return false;
};

// letters, digits, spaces and punctuation no dotenv parser treats specially
const ordinaryCharacters = [
  'a',
  'b',
  'X',
  'Z',
  '0',
  '9',
  ' ',
  '-',
  '_',
  '=',
  '/',
  '+',
  '.',
  ':',
  '@',
  ',',
  'é',
];

describe('dotenvService.format, for every value', () => {
  it('writes what both parsers read back exactly, or refuses it for a reason that holds', () => {
    let writtenCount = 0;
    let refusedCount = 0;
    fc.assert(
      fc.property(valueArbitrary, (value) => {
        let written;
        try {
          written = dotenvService.format({ KEY: value });
        } catch (error) {
          assert.ok(error instanceof CliError, String(error));
          refusedCount++;
          assert.ok(
            isRefusalTrue(error.message, value),
            `refused ${JSON.stringify(value)} with: ${error.message}`,
          );
          return;
        }
        writtenCount++;
        assert.deepEqual(dotenvService.parse(written), { KEY: value });
        assert.deepEqual(parseWithWranglerDotenv(written), { KEY: value });
      }),
      { numRuns: 5000 },
    );
    // both sides of the property were exercised, so it can't pass by refusing everything
    assert.ok(writtenCount > 1000, `only ${writtenCount} values were written`);
    assert.ok(refusedCount > 100, `only ${refusedCount} values were refused`);
  });

  it('writes every value made of ordinary characters', () => {
    fc.assert(
      fc.property(
        fc.string({
          unit: fc.constantFrom(...ordinaryCharacters),
        }),
        (value) => {
          const written = dotenvService.format({ KEY: value });
          assert.deepEqual(dotenvService.parse(written), { KEY: value });
          assert.deepEqual(parseWithWranglerDotenv(written), { KEY: value });
        },
      ),
      { numRuns: 2000 },
    );
  });
});
