// Runs fn over items, at most `limit` at a time, and returns the results in order.
export const mapAll = async <T, R>(
  items: readonly T[],
  fn: (item: T) => Promise<R>,
  { limit = 8 }: { limit?: number } = {},
) => {
  const results: R[] = [];
  const queue = items.entries();
  const runQueue = async () => {
    for (const [index, item] of queue) results[index] = await fn(item);
  };
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, runQueue),
  );
  return results;
};
