/**
 * Fair round-robin selection — the one copy of the algorithm.
 *
 * This started life as `selectRoundRobin()` inside `lib/ai/pipeline.ts`, where
 * it kept one chatty source from filling the whole LLM payload. The same
 * shape is now needed by the rendered panels (so a wire that publishes every
 * 60 seconds cannot take every slot), so the algorithm moved here and both
 * callers share it instead of drifting.
 *
 * Contract: take up to `limit` items, one per bucket per pass, iterating
 * buckets in a stable order. Optional per-bucket caps and an `accept`
 * predicate let a caller add density constraints without forking the loop.
 *
 * Deterministic by construction: no randomness, no clocks beyond the caller's
 * own ordering, and every tie broken by the bucket rank then input order.
 */

export interface RoundRobinOptions<T> {
  /** Hard maximum number of items returned. */
  limit: number;
  /** Bucket key — a source id in every current caller. */
  keyOf: (item: T) => string;
  /** Stable bucket iteration order (lower first). Defaults to discovery order. */
  rankOf?: (key: string) => number;
  /** Within-bucket ordering. Defaults to input order. */
  compare?: (a: T, b: T) => number;
  /** Maximum items any single bucket may contribute. Unlimited when omitted. */
  perBucketMax?: number;
  /**
   * Return false to skip an item for this pass. Called with the items already
   * picked, so a caller can enforce an aggregate limit (e.g. "at most two
   * items per story cluster in this panel").
   */
  accept?: (item: T, picked: readonly T[]) => boolean;
}

interface Bucket<T> {
  key: string;
  rank: number;
  items: T[];
  taken: number;
}

export function roundRobinSelect<T>(
  items: readonly T[],
  opts: RoundRobinOptions<T>,
): T[] {
  const limit = Math.max(0, Math.floor(opts.limit));
  if (limit === 0 || items.length === 0) return [];

  const byKey = new Map<string, Bucket<T>>();
  let discovery = 0;
  for (const item of items) {
    const key = opts.keyOf(item);
    let bucket = byKey.get(key);
    if (!bucket) {
      bucket = {
        key,
        rank: opts.rankOf ? opts.rankOf(key) : discovery++,
        items: [],
        taken: 0,
      };
      byKey.set(key, bucket);
    }
    bucket.items.push(item);
  }

  const buckets = [...byKey.values()].sort(
    (a, b) => a.rank - b.rank || a.key.localeCompare(b.key),
  );
  if (opts.compare) {
    for (const b of buckets) b.items.sort(opts.compare);
  }

  const picked: T[] = [];
  let progress = true;
  while (picked.length < limit && progress) {
    progress = false;
    for (const bucket of buckets) {
      if (picked.length >= limit) break;
      if (opts.perBucketMax !== undefined && bucket.taken >= opts.perBucketMax) {
        continue;
      }
      // Walk the bucket's remaining items: `accept` may reject the head item
      // (cluster already saturated) while a later one is still admissible.
      while (bucket.items.length > 0) {
        const candidate = bucket.items[0];
        if (opts.accept && !opts.accept(candidate, picked)) {
          // A rejected item is dropped for this panel, not deferred — keeping
          // it would make the pass loop forever on the same head item.
          bucket.items.shift();
          continue;
        }
        bucket.items.shift();
        bucket.taken += 1;
        picked.push(candidate);
        progress = true;
        break;
      }
    }
  }
  return picked;
}
