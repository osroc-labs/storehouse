import assert from 'node:assert/strict';
import { setTimeout as sleep } from 'node:timers/promises';
import { describe, it } from 'node:test';
import { mapAll } from './map-all.ts';

describe(mapAll.name, () => {
  it('runs at most the limit at once and keeps the order', async () => {
    let running = 0;
    let mostRunning = 0;
    const doubled = await mapAll(
      [1, 2, 3, 4, 5, 6, 7],
      async (n) => {
        running++;
        mostRunning = Math.max(mostRunning, running);
        await sleep(5);
        running--;
        return n * 2;
      },
      { limit: 3 },
    );
    assert.deepEqual(doubled, [2, 4, 6, 8, 10, 12, 14]);
    assert.equal(mostRunning, 3);
  });

  it('returns an empty list for no items', async () => {
    assert.deepEqual(await mapAll([], () => Promise.resolve(1)), []);
  });
});
