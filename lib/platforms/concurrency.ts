/**
 * Bounded parallel mapping, for adapters that must ask about each post
 * separately.
 *
 * Instagram and Facebook both expose post insights one media at a time, so a
 * report over N posts is N requests. Unbounded `Promise.all` over 500 of them
 * exhausts a Worker's concurrent-subrequest allowance and trips the platform's
 * own rate limiter; a serial loop takes long enough to hit the invocation
 * timeout. This is the middle, and it lives here rather than in one adapter
 * because the second adapter to need it would otherwise copy it.
 */
export async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let cursor = 0;

  async function worker(): Promise<void> {
    while (cursor < items.length) {
      const index = cursor;
      cursor += 1;
      results[index] = await fn(items[index], index);
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, () => worker())
  );
  return results;
}
