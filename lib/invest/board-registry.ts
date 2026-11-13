/**
 * Eastmoney board registry + board quotes, keyless.
 *
 * Why this module exists
 * ----------------------
 * `push2.eastmoney.com/api/qt/clist/get` — the historical source of the theme
 * board list — is 502-ing for our clients for hours at a time (measured: 0/40
 * from a VM, and the CI bake logged `boards=0` on every run since 2026-11-11).
 * When it does answer, it answers in short bursts, so it cannot be depended on
 * for a list the pipeline needs once per edition.
 *
 * The board list does not actually need a live quote feed: board codes and
 * names are near-static metadata (~1080 rows, a handful of additions a month).
 * So the list is read from `datacenter-web.eastmoney.com`
 * (`RPT_EM_BOARD`), a different service on different infrastructure that
 * answered 3/3 pages reliably while `push2` was refusing every request from the
 * same host. Quotes — which *do* need to be live — come from
 * `push2.eastmoney.com/api/qt/ulist.np/get`, which kept answering 200 on the
 * same host that 502'd `clist/get`, and which accepts an explicit comma list of
 * board `secids` (`90.BK0800`). One batched request covers every theme.
 *
 * Resilience: the registry is also committed as `lib/themes/board-map.json`,
 * refreshed by the low-frequency `board-map` workflow. If the live registry is
 * unreachable the baker resolves against that snapshot instead, so theme board
 * heat degrades to "yesterday's board list + today's quotes" rather than to
 * zero. Constituents likewise come from `datacenter-web` (`RPT_BOARD_CONSTITUENT`),
 * with names and moves taken from the same working quote endpoint.
 *
 * Every function returns `null`/empty on failure — callers are fail-open by
 * repo invariant. Parsing is pure and exported so the payload contract is
 * testable without the network.
 */

import { readFileSync } from "node:fs";
import path from "node:path";

import { fetchJson } from "./http-json";

export interface BoardEntry {
  /** Eastmoney board code, e.g. `BK0800`. */
  code: string;
  /** Board display name (zh), the resolution key. */
  name: string;
  /** Quote identifier, e.g. `90.BK0800`. */
  secid: string;
  /** Eastmoney board type: 1 region, 2 industry, 3 concept, 4 style. */
  type: number;
}

export interface BoardQuote {
  name: string;
  changePct: number;
  /** Constituents that advanced. */
  up: number;
  /** Constituents that declined. */
  down: number;
  /**
   * Upstream quote stamp in epoch **seconds** (`f124`), when the payload
   * carried one. The point-in-time tape records this as the market clock of a
   * board value; the edition panels ignore it.
   */
  quoteStamp?: number | null;
}

export interface ConstituentRefs {
  /** Quote secids (`0.000034` / `1.600000`) for the board's largest members. */
  secids: string[];
  /** Declared member count for the whole board. */
  total: number;
}

const DATACENTER = "https://datacenter-web.eastmoney.com/api/data/v1/get";
const QUOTE_HOSTS = [
  "https://push2.eastmoney.com",
  "https://push2delay.eastmoney.com",
];
const QUOTE_HEADERS = { Referer: "https://quote.eastmoney.com/" };
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Registry page size; the service caps out well above this. */
const REGISTRY_PAGE_SIZE = 500;
/** `ulist.np/get` answered for 50 secids and 502'd for 100; stay well below. */
const QUOTE_CHUNK = 30;
/** How many members per board to quote before keeping the top movers. */
const CONSTITUENT_CANDIDATES = 20;
/** Outer retries for the datacenter "empty but well-formed" throttle reply. */
const CONSTITUENT_ATTEMPTS = 5;

interface EmRegistryRow {
  BOARD_NAME?: string;
  NEW_BOARD_CODE?: string;
  BOARD_TYPE_NEW?: string | number;
  IS_VALID?: string | number;
}

interface EmRegistryResponse {
  result?: { pages?: number; data?: EmRegistryRow[] } | null;
}

interface EmQuoteRow {
  f12?: string;
  f14?: string;
  f3?: number | string | boolean | null;
  f104?: number;
  f105?: number;
  f124?: number | string | null;
}

export interface EmQuoteResponse {
  data?: { diff?: EmQuoteRow[] } | null;
}

interface EmConstituentRow {
  SECUCODE?: string;
  TOTAL_COUNT?: number;
}

interface EmConstituentResponse {
  result?: { data?: EmConstituentRow[] } | null;
}

/**
 * Flatten `RPT_EM_BOARD` pages into board entries.
 *
 * Keeps only `IS_VALID === "1"` (one delisted board is in the registry) and
 * de-duplicates by code, because overlapping pages are possible when the
 * registry shifts between requests.
 */
export function parseBoardRegistry(pages: readonly unknown[]): BoardEntry[] {
  const out: BoardEntry[] = [];
  const seen = new Set<string>();
  for (const page of pages) {
    const rows = (page as EmRegistryResponse | null)?.result?.data;
    if (!Array.isArray(rows)) continue;
    for (const row of rows) {
      const code = String(row?.NEW_BOARD_CODE ?? "").trim();
      const name = String(row?.BOARD_NAME ?? "").trim();
      const valid = String(row?.IS_VALID ?? "1");
      if (!/^BK\d+$/.test(code) || !name || valid === "0") continue;
      if (seen.has(code)) continue;
      seen.add(code);
      const type = Number(row?.BOARD_TYPE_NEW);
      out.push({ code, name, secid: `90.${code}`, type: Number.isFinite(type) ? type : 0 });
    }
  }
  return out;
}

/**
 * Index a `ulist.np/get` payload by board code.
 *
 * `f3` is the change percent; a suspended or freshly listed board reports `"-"`
 * which must not become `0` silently — it is dropped so callers can tell
 * "no quote" from "flat".
 *
 * `f124` is the upstream quote stamp (epoch seconds); it is carried through as
 * `quoteStamp` because the point-in-time tape has to record the market clock of
 * a value, not just our fetch clock. It stays optional: a payload without it is
 * still a usable quote, it just cannot claim a market timestamp.
 */
export function parseBoardQuotes(payload: unknown): Map<string, BoardQuote> {
  const out = new Map<string, BoardQuote>();
  const rows = (payload as EmQuoteResponse | null)?.data?.diff;
  if (!Array.isArray(rows)) return out;
  for (const row of rows) {
    const code = String(row?.f12 ?? "").trim();
    if (!code) continue;
    const raw = row?.f3;
    if (typeof raw !== "number" || !Number.isFinite(raw)) continue;
    const stamp = Number(row?.f124);
    out.set(code, {
      name: String(row?.f14 ?? "").trim(),
      changePct: raw,
      up: Number(row?.f104) || 0,
      down: Number(row?.f105) || 0,
      quoteStamp: Number.isFinite(stamp) && stamp > 1_000_000_000 ? stamp : null,
    });
  }
  return out;
}

/** `000034.SZ` → `0.000034`, `600000.SH` → `1.600000`. */
export function toQuoteSecid(secucode: string): string | null {
  const [symbol, market] = String(secucode ?? "").trim().toUpperCase().split(".");
  if (!/^\d{6}$/.test(symbol ?? "")) return null;
  if (market === "SH") return `1.${symbol}`;
  if (market === "SZ" || market === "BJ") return `0.${symbol}`;
  return null;
}

export function parseConstituents(payload: unknown): ConstituentRefs {
  const rows = (payload as EmConstituentResponse | null)?.result?.data;
  if (!Array.isArray(rows) || rows.length === 0) return { secids: [], total: 0 };
  const secids: string[] = [];
  for (const row of rows) {
    const secid = toQuoteSecid(String(row?.SECUCODE ?? ""));
    if (secid) secids.push(secid);
  }
  return { secids, total: Number(rows[0]?.TOTAL_COUNT) || 0 };
}

/** Live board registry, paginated. `null` when the service is unreachable. */
export async function fetchBoardRegistry(): Promise<BoardEntry[] | null> {
  const url = (pageNumber: number) =>
    `${DATACENTER}?reportName=RPT_EM_BOARD&columns=ALL` +
    `&pageNumber=${pageNumber}&pageSize=${REGISTRY_PAGE_SIZE}`;

  const first = await fetchJson<EmRegistryResponse>(url(1), {
    timeoutMs: 20_000,
    attempts: 3,
  });
  const pages = Number(first?.result?.pages) || 0;
  const collected: unknown[] = [first];
  for (let pn = 2; pn <= pages; pn++) {
    collected.push(await fetchJson<EmRegistryResponse>(url(pn), { timeoutMs: 20_000, attempts: 3 }));
  }
  const boards = parseBoardRegistry(collected);
  return boards.length ? boards : null;
}

/**
 * Fetch-options seam shared by the network helpers, so the parse → resolve
 * path can be driven from a captured payload in tests.
 */
export interface BoardFetchOptions {
  fetchImpl?: typeof fetch;
  sleepImpl?: (ms: number) => Promise<void>;
}

/** Batched board quotes. Missing entries simply have no quote today. */
export async function fetchBoardQuotes(
  boards: readonly BoardEntry[],
  options: BoardFetchOptions = {},
): Promise<Map<string, BoardQuote>> {
  const out = new Map<string, BoardQuote>();
  const secids = boards.map((b) => b.secid);
  for (let i = 0; i < secids.length; i += QUOTE_CHUNK) {
    const chunk = secids.slice(i, i + QUOTE_CHUNK);
    const j = await fetchJson<EmQuoteResponse>(
      QUOTE_HOSTS.map(
        (host) =>
          `${host}/api/qt/ulist.np/get?fltt=2&invt=2` +
          `&fields=f12,f14,f3,f104,f105,f124&secids=${chunk.join(",")}`,
      ),
      {
        headers: QUOTE_HEADERS,
        timeoutMs: 12_000,
        attempts: 5,
        retryDelayMs: 500,
        fetchImpl: options.fetchImpl,
        sleepImpl: options.sleepImpl,
      },
    );
    for (const [code, quote] of parseBoardQuotes(j)) out.set(code, quote);
  }
  return out;
}

/**
 * Candidate members of one board (top `CONSTITUENT_CANDIDATES` by code order).
 *
 * A throttled request answers `200` with `{"success":false,
 * "message":"返回数据为空"}` — a well-formed payload with no rows, which a
 * naive parse reads as "this board has no members". Every real board has
 * members, so an empty result is retried rather than believed.
 */
export async function fetchConstituents(
  boardName: string,
  options: BoardFetchOptions & { attempts?: number } = {},
): Promise<ConstituentRefs> {
  const filter = encodeURIComponent(`(BOARD_NAME="${boardName}")`);
  const url =
    `${DATACENTER}?reportName=RPT_BOARD_CONSTITUENT` +
    `&columns=SECURITY_CODE,SECUCODE,TOTAL_COUNT` +
    `&pageNumber=1&pageSize=${CONSTITUENT_CANDIDATES}` +
    `&sortColumns=SECURITY_CODE&sortTypes=1&filter=${filter}`;

  const attempts = Math.max(1, options.attempts ?? CONSTITUENT_ATTEMPTS);
  for (let attempt = 1; attempt <= attempts; attempt++) {
    const j = await fetchJson<EmConstituentResponse>(url, {
      timeoutMs: 20_000,
      attempts: 2,
      fetchImpl: options.fetchImpl,
      sleepImpl: options.sleepImpl,
    });
    const refs = parseConstituents(j);
    if (refs.secids.length) return refs;
    // Empty-but-valid is the throttle signature, not an empty board.
    if (attempt < attempts) await (options.sleepImpl ?? sleep)(400 * attempt);
  }
  return { secids: [], total: 0 };
}

/**
 * Committed registry snapshot — the fallback when the live registry is down.
 * Returns `null` when the file is absent or malformed (never throws: a bad
 * snapshot must not take the bake down with it).
 */
export function loadBoardMapSnapshot(file?: string): BoardEntry[] | null {
  const fp = file ?? path.resolve("lib/themes/board-map.json");
  try {
    const parsed = JSON.parse(readFileSync(fp, "utf8")) as { boards?: unknown };
    const boards = parseBoardRegistry([{ result: { data: snapshotToRegistryRows(parsed.boards) } }]);
    return boards.length ? boards : null;
  } catch {
    return null;
  }
}

/** Snapshot rows use the published `{code, name}` shape, not the API field names. */
function snapshotToRegistryRows(boards: unknown): EmRegistryRow[] {
  if (!Array.isArray(boards)) return [];
  return boards.map((raw) => {
    const b = raw as { code?: unknown; name?: unknown };
    return { NEW_BOARD_CODE: String(b?.code ?? ""), BOARD_NAME: String(b?.name ?? ""), IS_VALID: "1" };
  });
}
