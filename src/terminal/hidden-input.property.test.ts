import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import fc from 'fast-check';
import { createHiddenReader } from './hidden-input.ts';

// what a paste can hold: anything but the escape that would end it early
const pastedTextArbitrary = fc.string({
  unit: fc.oneof(
    fc.constantFrom('\n', '"', '#', ' ', '\t', '-', 'é', '👍'),
    fc
      .string({ unit: 'grapheme', minLength: 1, maxLength: 1 })
      .filter((c) => c >= ' ' && c !== '\u007f'),
  ),
});

// the input split into chunks at arbitrary points, as a terminal's reads might split it
const splitAt = (input: string, cuts: number[]) => {
  const points = [...new Set(cuts.map((c) => c % (input.length + 1)))].toSorted(
    (a, b) => a - b,
  );
  return [0, ...points, input.length]
    .slice(0, -1)
    .map((start, i) => input.slice(start, [...points, input.length][i]));
};

const readAll = (chunks: string[]) => {
  const reader = createHiddenReader();
  let hiddenInput = reader.feed('');
  for (const chunk of chunks) {
    if (hiddenInput.kind !== 'more') break;
    hiddenInput = reader.feed(chunk);
  }
  return hiddenInput;
};

describe('createHiddenReader, over arbitrary chunk splits', () => {
  it('reads a bracketed paste back exactly, however its chunks fall', () => {
    fc.assert(
      fc.property(
        pastedTextArbitrary,
        fc.array(fc.nat(), { maxLength: 8 }),
        (text, cuts) => {
          const input = `\u001b[200~${text.replaceAll('\n', '\r')}\u001b[201~\r`;
          assert.deepEqual(readAll(splitAt(input, cuts)), {
            kind: 'done',
            value: text,
          });
        },
      ),
      { numRuns: 3000 },
    );
  });

  it('never throws, whatever arrives', () => {
    fc.assert(
      fc.property(
        fc.array(fc.string({ unit: 'binary' }), { maxLength: 6 }),
        (chunks) => {
          const hiddenInput = readAll(chunks);
          assert.ok(
            ['more', 'done', 'stopped', 'unmarked'].includes(hiddenInput.kind),
          );
        },
      ),
      { numRuns: 3000 },
    );
  });
});
