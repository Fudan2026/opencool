/**
 * Limit-up / limit-down pool (涨跌停板) from `push2ex.eastmoney.com`.
 *
 * This is the one upstream that is *not* on `push2`: while `push2` answered
 * 502 to every request, `push2ex.eastmoney.com/getTopicZTPool` answered 200 in
 * under a second. It is a separate service on separate infrastructure, which
 * is exactly why it is worth a tape section of its own — when the quote host is
 * down we still have a record of which stocks were locked limit up or down.
 *
 * Fail-open: an unreachable pool yields `{ ok: false, reason }` and the caller
 * marks the section `unavailable` with that reason. A pool for a day with no
 * limit events is a legitimate empty result and is reported as `ok: true` with
 * zero rows — the two states are different and the tape keeps them apart.
 */

const HOST = "https://push2ex.eastmoney.com";
/** Public token the quote site itself uses for these pool endpoints. */
const UT = "7eea3edcaed734bea9cbfc24409ed989";
const HEADERS = {
  Referer: "https://quote.eastmoney.com/",
  Accept: "application/json,text/plain,*/*",
};
/** Rows kept per side; the pool can hold a few hundred on a violent day. */
const POOL_LIMIT = 60;

export interface LimitPoolRow {
  code: string;
  name: string;
  changePct: number;
  /** Consecutive-limit count when the upstream reports it (`lbc`), else null. */
  boards: number | null;
  /** Upstream `hybk` — the stock's own industry board name. */
  industry: string | null;
}

export interface LimitPoolResult {
  ok: boolean;
  /** Why the pool is missing; empty on success. */
  reason: string;
  tradeDate: string;
  limitUp: number;
  limitDown: number;
  rows: LimitPoolRow[];
  /** Latest `fbt`/`lbt`-derived stamp in epoch seconds, or null. */
  quoteStamp: number | null;
}

interface EmPoolStock {
  c?: string;
  n?: string;
  zdp?: number;
  lbc?: number;
  hybk?: string;
}

interface EmPoolPayload {
  rc?: number;
  data?: {
    tc?: number;
    qdate?: number;
    pool?: EmPoolStock[];
  } | null;
}

/** `2026-11-13` → `20261113`, the `date=` form these endpoints expect. */
export function poolDateKey(dateKey: string): string {
  return String(dateKey ?? "").replace(/-/g, "");
}

/**
 * Flatten one `getTopicXPool` payload into rows.
 *
 * `zdp` is the change percent and is the only field a row is dropped without:
 * a name and code with no move is a malformed row, not a flat stock.
 */
export function parseLimitPool(payload: unknown): {
  rows: LimitPoolRow[];
  total: number;
  tradeDate: string;
} {
  const body = payload as EmPoolPayload | null;
  const pool = body?.data?.pool;
  const qdate = Number(body?.data?.qdate);
  const tradeDate =
    Number.isFinite(qdate) && qdate > 19_000_000
      ? `${String(qdate).slice(0, 4)}-${String(qdate).slice(4, 6)}-${String(qdate).slice(6, 8)}`
      : "";
  const rows: LimitPoolRow[] = [];
  if (!Array.isArray(pool)) {
    return { rows, total: 0, tradeDate };
  }
  for (const s of pool) {
    const code = String(s?.c ?? "").trim();
    const name = String(s?.n ?? "").trim();
    const zdp = Number(s?.zdp);
    if (!/^\d{6}$/.test(code) || !name || !Number.isFinite(zdp)) continue;
    rows.push({
      code,
      name,
      changePct: zdp,
      boards: Number.isFinite(Number(s?.lbc)) ? Number(s?.lbc) : null,
      industry: s?.hybk ? String(s.hybk) : null,
    });
  }
  const total = Number(body?.data?.tc);
  return { rows, total: Number.isFinite(total) ? total : rows.length, tradeDate };
}

/**
 * The pool endpoints return the pool as of the trade date in the payload but
 * carry no per-row timestamp, so there is no honest market clock to read. The
 * caller therefore records the fetch time and says so (`timestampSource:
 * "fetch"`) rather than pretending `qdate` is a timestamp — a date is not an
 * instant, and "15:00:00 on that date" would be an invention.
 */
export async function fetchLimitPool(
  dateKey: string,
  options: {
    fetchImpl?: typeof fetch;
    sleepImpl?: (ms: number) => Promise<void>;
    limit?: number;
  } = {},
): Promise<LimitPoolResult> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const limit = options.limit ?? POOL_LIMIT;
  const date = poolDateKey(dateKey);
  const base: LimitPoolResult = {
    ok: false,
    reason: "",
    tradeDate: dateKey,
    limitUp: 0,
    limitDown: 0,
    rows: [],
    quoteStamp: null,
  };

  const sides: Array<{ name: "up" | "down"; url: string; sort: string }> = [
    {
      name: "up",
      url: `${HOST}/getTopicZTPool?ut=${UT}&dpt=wz.ztzt&Pageindex=0&pagesize=${limit}&sort=fbt%3Aasc&date=${date}`,
      sort: "limit-up",
    },
    {
      name: "down",
      url: `${HOST}/getTopicDTPool?ut=${UT}&dpt=wz.ztzt&Pageindex=0&pagesize=${limit}&sort=fund%3Aasc&date=${date}`,
      sort: "limit-down",
    },
  ];

  const parsed: Array<{ side: "up" | "down"; rows: LimitPoolRow[]; total: number; tradeDate: string }> = [];
  const failures: string[] = [];

  for (const s of sides) {
    try {
      const res = await fetchImpl(s.url, {
        headers: HEADERS,
        signal: AbortSignal.timeout(12_000),
      });
      if (!res.ok) {
        failures.push(`${s.sort} HTTP ${res.status}`);
        continue;
      }
      const body = (await res.json().catch(() => null)) as unknown;
      if (!body || typeof body !== "object") {
        failures.push(`${s.sort} non-JSON payload`);
        continue;
      }
      const p = parseLimitPool(body);
      parsed.push({ side: s.name, rows: p.rows, total: p.total, tradeDate: p.tradeDate });
    } catch (e) {
      failures.push(`${s.sort} ${e instanceof Error ? e.message : String(e)}`.slice(0, 160));
    }
  }

  if (!parsed.length) {
    return { ...base, reason: `push2ex unreachable: ${failures.join("; ")}` };
  }

  const rows = parsed.flatMap((p) => p.rows);
  const tradeDate = parsed.find((p) => p.tradeDate)?.tradeDate ?? dateKey;
  return {
    ok: true,
    reason: "",
    tradeDate,
    limitUp: parsed.find((p) => p.side === "up")?.total ?? 0,
    limitDown: parsed.find((p) => p.side === "down")?.total ?? 0,
    rows,
    quoteStamp: null,
  };
}
