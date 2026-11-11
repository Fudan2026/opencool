/**
 * Period-bucketing helpers for trend intelligence (WoW / MoM). Pure —
 * consumed by scripts/bake-periods.ts and unit-tested. Monday-based
 * ISO weeks; deterministic (no Date.now inside).
 */

export interface PeriodEdition {
  date: string; // YYYY-MM-DD
  score: number | null;
  pos: number;
  neg: number;
  themes: Array<{ name: string; hits: number }>;
  /** Mean of that edition's index changePct values, or null. */
  idxPct: number | null;
}

export interface PeriodBucket {
  /** Bucket start label (weekStart Monday / YYYY-MM for months). */
  key: string;
  /** Inclusive end label. */
  end: string;
  editions: number;
  avgSentiment: number | null;
  deltaVsPrev: number | null;
  posNegRatio: number | null;
  topThemes: Array<{ name: string; hits: number }>;
  avgIndexChangePct: number | null;
}

/** Monday-based week start for a YYYY-MM-DD date (deterministic UTC math). */
export function weekStartOf(date: string): string {
  const d = new Date(`${date}T12:00:00Z`);
  const dow = d.getUTCDay(); // 0 Sun .. 6 Sat
  const back = (dow + 6) % 7; // days since Monday
  d.setUTCDate(d.getUTCDate() - back);
  return d.toISOString().slice(0, 10);
}

function r1(n: number): number {
  return Math.round(n * 10) / 10;
}

function buildBucket(
  key: string,
  end: string,
  rows: PeriodEdition[],
): Omit<PeriodBucket, "deltaVsPrev"> {
  const scored = rows.filter((r) => r.score != null) as Array<
    PeriodEdition & { score: number }
  >;
  const avgSentiment = scored.length
    ? r1(scored.reduce((a, b) => a + b.score, 0) / scored.length)
    : null;
  const pos = rows.reduce((a, b) => a + b.pos, 0);
  const neg = rows.reduce((a, b) => a + b.neg, 0);
  const posNegRatio = pos + neg > 0 ? Math.round((pos / (pos + neg)) * 100) / 100 : null;
  const themeAcc = new Map<string, number>();
  for (const r of rows) {
    for (const t of r.themes) {
      themeAcc.set(t.name, (themeAcc.get(t.name) ?? 0) + t.hits);
    }
  }
  const topThemes = [...themeAcc.entries()]
    .map(([name, hits]) => ({ name, hits }))
    .sort((a, b) => b.hits - a.hits)
    .slice(0, 5);
  const idx = rows.filter((r) => r.idxPct != null) as Array<
    PeriodEdition & { idxPct: number }
  >;
  const avgIndexChangePct = idx.length
    ? Math.round((idx.reduce((a, b) => a + b.idxPct, 0) / idx.length) * 100) / 100
    : null;
  return {
    key,
    end,
    editions: rows.length,
    avgSentiment,
    posNegRatio,
    topThemes,
    avgIndexChangePct,
  };
}

/** Bucket chronologically (oldest first) by Monday-based week. */
export function bucketByIsoWeek(
  rows: PeriodEdition[],
): Omit<PeriodBucket, "deltaVsPrev">[] {
  const groups = new Map<string, PeriodEdition[]>();
  for (const r of rows) {
    const k = weekStartOf(r.date);
    (groups.get(k) ?? groups.set(k, []).get(k)!).push(r);
  }
  const keys = [...groups.keys()].sort();
  return keys.map((k, i) => {
    const rowsIn = groups.get(k)!;
    const lastDay = rowsIn.reduce((a, b) => (b.date > a.date ? b : a)).date;
    return buildBucket(k, i + 1 < keys.length ? keys[i + 1] : lastDay, rowsIn);
  });
}

/** Bucket by calendar month (YYYY-MM). */
export function bucketByMonth(
  rows: PeriodEdition[],
): Omit<PeriodBucket, "deltaVsPrev">[] {
  const groups = new Map<string, PeriodEdition[]>();
  for (const r of rows) {
    const k = r.date.slice(0, 7);
    (groups.get(k) ?? groups.set(k, []).get(k)!).push(r);
  }
  const keys = [...groups.keys()].sort();
  return keys.map((k, i) => {
    const rowsIn = groups.get(k)!;
    const lastDay = rowsIn.reduce((a, b) => (b.date > a.date ? b : a)).date;
    return buildBucket(k, i + 1 < keys.length ? keys[i + 1] : lastDay, rowsIn);
  });
}

/** Attach deltaVsPrev = avgSentiment − previous bucket's (null first). */
export function deltaChain(
  buckets: Omit<PeriodBucket, "deltaVsPrev">[],
): PeriodBucket[] {
  return buckets.map((b, i) => ({
    ...b,
    deltaVsPrev:
      i === 0 || b.avgSentiment == null || buckets[i - 1].avgSentiment == null
        ? null
        : Math.round((b.avgSentiment - buckets[i - 1].avgSentiment!) * 10) / 10,
  }));
}
