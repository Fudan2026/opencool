/**
 * Free delayed East Money sector fund-flow snapshot.
 * Failures return null — never fatal. Label as unofficial / delayed.
 *
 * Why this no longer uses `clist/get`
 * -----------------------------------
 * `push2.eastmoney.com/api/qt/clist/get` — the historical source of a *ranked
 * board list plus fund flow in one call* — 502s for our clients for hours at a
 * time (measured 0/40 from a VM, and CI logged `boards=0` on every edition from
 * 2026-11-11). The sector-fund-flow panel went empty the same way the theme
 * boards did, for the same reason.
 *
 * The fix is the one PR #51 applied to the theme boards: `ulist.np/get` keeps
 * answering 200 on the same host and takes an explicit comma list of
 * `90.BKxxxx` board secids, so the *list* comes from the board registry
 * (`lib/invest/board-registry.ts` — `datacenter-web` plus the committed
 * `lib/themes/board-map.json` snapshot) and the *quotes plus net inflow* come
 * from one batched `ulist.np/get` call per 30 boards: `f3` change percent,
 * `f62` main-force net inflow, `f124` quote timestamp.
 *
 * Two entry points, one network path:
 *
 *   `fetchFundFlows()`      the published panel's shape (`FundFlowSnapshot | null`),
 *                           signature and fail-open contract unchanged.
 *   `fetchBoardFundFlow()`  the same rows plus the upstream quote stamp, for
 *                           callers that must record *when the market value is
 *                           from* (the point-in-time tape).
 */

import {
  fetchBoardRegistry,
  loadBoardMapSnapshot,
  type BoardEntry,
} from "./board-registry";
import { fetchJson } from "./http-json";

export interface SectorFlow {
  name: string;
  changePct: number;
  /** Net inflow in 亿元. */
  netInflowYi: number;
}

export interface FundFlowSnapshot {
  sectors: SectorFlow[];
  fetchedAt: string;
  note: string;
  /** Market timestamp the numbers describe, when the payload carried one. */
  asOf?: string;
  /** `upstream` when `asOf` came from the payload, `fetch` when it is our clock. */
  timestampSource?: "upstream" | "fetch";
}

export interface FundFlowFetchOptions {
  fetchImpl?: typeof fetch;
  sleepImpl?: (ms: number) => Promise<void>;
  /** Board list override — the tape already resolved the registry once. */
  boards?: readonly BoardEntry[];
}

/** One board's fund flow, before ranking. */
export interface BoardFlowRow {
  code: string;
  name: string;
  changePct: number;
  /** Main-force net inflow in 亿元. */
  netInflowYi: number;
}

export interface BoardFlowResult {
  rows: BoardFlowRow[];
  /** Latest `f124` epoch-seconds stamp seen, or `null` when the payload had none. */
  quoteStamp: number | null;
  /** Which board type produced the rows: 2 industry, 3 concept. */
  boardType: 2 | 3;
}

interface EmFlowRow {
  f12?: string;
  f14?: string;
  f3?: number | string | boolean | null;
  f62?: number | string | null;
  f124?: number | string | null;
}

export interface EmFlowResponse {
  data?: { diff?: EmFlowRow[] } | null;
}

const NOTE =
  "东方财富公开延时板块资金流 · 非官方 · 非实时 · 仅供参考 · 不构成投资建议";

/** Same chunk size as the board quotes: 50 works for `ulist.np`, 100 502s. */
const FLOW_CHUNK = 30;
/** The panel shows a leaderboard, not all ~500 boards. */
const FLOW_LIMIT = 12;
const QUOTE_HEADERS = { Referer: "https://data.eastmoney.com/bkzj/hy.html" };

/**
 * Parse one `ulist.np/get` fund-flow payload, keeping upstream order.
 *
 * A row without a usable `f62` is dropped rather than read as 0: "no inflow
 * data" and "exactly flat" are different facts and only one belongs on a
 * leaderboard. Same rule `parseBoardQuotes` applies to change percent.
 */
export function parseFundFlowRows(payload: unknown): BoardFlowRow[] {
  const rows = (payload as EmFlowResponse | null)?.data?.diff;
  if (!Array.isArray(rows)) return [];
  const out: BoardFlowRow[] = [];
  for (const row of rows) {
    const name = String(row?.f14 ?? "").trim();
    const code = String(row?.f12 ?? "").trim();
    const inflow = Number(row?.f62);
    if (!name || !Number.isFinite(inflow)) continue;
    const change = Number(row?.f3);
    out.push({
      code,
      name,
      changePct: Number.isFinite(change) ? change : 0,
      netInflowYi: inflow / 1e8,
    });
  }
  return out;
}

/**
 * Latest `f124` epoch-seconds stamp in the payload, or `null` when absent.
 * Values below ~2001 in epoch seconds are placeholders, not quote times.
 */
export function latestQuoteStamp(payload: unknown): number | null {
  const rows = (payload as EmFlowResponse | null)?.data?.diff;
  if (!Array.isArray(rows)) return null;
  let max = 0;
  for (const row of rows) {
    const n = Number(row?.f124);
    if (Number.isFinite(n) && n > 1_000_000_000 && n > max) max = n;
  }
  return max || null;
}

/** Board registry: live first, committed snapshot second. */
async function resolveBoards(
  options: FundFlowFetchOptions,
): Promise<BoardEntry[] | null> {
  if (options.boards?.length) return [...options.boards];
  const live = await fetchBoardRegistry();
  if (live?.length) return live;
  const snapshot = loadBoardMapSnapshot();
  return snapshot?.length ? snapshot : null;
}

/**
 * Ranked board fund flow plus the upstream quote stamp.
 *
 * Industry boards (type 2) are tried first — the panel is a 行业 leaderboard.
 * Concept boards (type 3) are the documented fallback when the registry serves
 * a list with no industry rows, or when every industry chunk comes back empty.
 * `null` only when both fail, never a throw.
 */
export async function fetchBoardFundFlow(
  boards: readonly BoardEntry[] | null | undefined,
  options: Omit<FundFlowFetchOptions, "boards"> = {},
): Promise<BoardFlowResult | null> {
  const registry = boards?.length ? [...boards] : await resolveBoards(options);
  if (!registry?.length) return null;

  const groups: Array<{ type: 2 | 3; boards: BoardEntry[] }> = [
    { type: 2, boards: registry.filter((b) => b.type === 2) },
    { type: 3, boards: registry.filter((b) => b.type === 3) },
  ];
  for (const group of groups) {
    if (!group.boards.length) continue;
    const rows: BoardFlowRow[] = [];
    let quoteStamp: number | null = null;

    for (let i = 0; i < group.boards.length; i += FLOW_CHUNK) {
      const chunk = group.boards.slice(i, i + FLOW_CHUNK);
      const payload = await fetchJson<EmFlowResponse>(
        ["https://push2.eastmoney.com", "https://push2delay.eastmoney.com"].map(
          (host) =>
            `${host}/api/qt/ulist.np/get?fltt=2&invt=2` +
            `&fields=f12,f14,f3,f62,f124&secids=${chunk.map((b) => b.secid).join(",")}`,
        ),
        {
          headers: QUOTE_HEADERS,
          timeoutMs: 12_000,
          attempts: 3,
          retryDelayMs: 400,
          fetchImpl: options.fetchImpl,
          sleepImpl: options.sleepImpl,
        },
      );
      rows.push(...parseFundFlowRows(payload));
      const stamp = latestQuoteStamp(payload);
      if (stamp && (!quoteStamp || stamp > quoteStamp)) quoteStamp = stamp;
    }

    if (!rows.length) continue;
    // Ranked by net inflow, mirroring the sorted `clist/get` this replaced.
    // Ties keep registry order so a rerun over unchanged data is byte-stable.
    rows.sort((a, b) => b.netInflowYi - a.netInflowYi);
    return { rows, quoteStamp, boardType: group.type };
  }
  return null;
}

/**
 * Sector board fund flow (东方财富行业板块). Optional concept fallback.
 * Any failure → null (panel omitted). Signature unchanged: `daily.ts`'s flow
 * one-liner and `lib/invest/quant.ts` both consume exactly this shape.
 */
export async function fetchFundFlows(
  options: FundFlowFetchOptions = {},
): Promise<FundFlowSnapshot | null> {
  try {
    const result = await fetchBoardFundFlow(options.boards, options);
    if (!result?.rows.length) return null;
    const fetchedAt = new Date();
    const asOf = result.quoteStamp ? new Date(result.quoteStamp * 1000).toISOString() : null;
    return {
      sectors: result.rows.slice(0, FLOW_LIMIT).map((r) => ({
        name: r.name,
        changePct: r.changePct,
        netInflowYi: r.netInflowYi,
      })),
      fetchedAt: fetchedAt.toISOString(),
      note: NOTE,
      asOf: asOf ?? fetchedAt.toISOString(),
      timestampSource: asOf ? "upstream" : "fetch",
    };
  } catch {
    // Fail-open by repo invariant: an optional panel must never break a build.
    return null;
  }
}
