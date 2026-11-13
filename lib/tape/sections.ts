/**
 * Section builders for the point-in-time tape.
 *
 * Every captured value must carry two clocks, and this file is the only place
 * that decides what they are:
 *
 *   asOf        the market timestamp the value describes. Read from the
 *               upstream payload when the payload carries one (Eastmoney
 *               `f124` / `f86` epoch seconds). When it does not, this falls back
 *               to the fetch instant and `timestampSource: "fetch"` says so,
 *               instead of an invented market time.
 *   observedAt  when we fetched it, ISO 8601 with the market's own offset.
 *
 * Keeping this in one module is the point: no section builder can forget a
 * clock, because the clock fields are produced by `buildSection`, not typed by
 * hand in each builder. `assertTwoClocks` is the runtime check the round-trip
 * test uses and the baker runs before writing.
 */

import {
  fetchBoardQuotes,
  type BoardEntry,
  type BoardQuote,
} from "../invest/board-registry";
import { fetchBoardFundFlow } from "../invest/flows";
import { fetchMarketOverview } from "../invest/market-overview";
import { loadThemeCatalog, resolveBoard, type ThemeDef } from "../themes/catalog";
import { epochSecondsToIso, isoWithOffset } from "./time";
import { fetchLimitPool } from "./limit-pool";

/** How `asOf` was obtained. */
export type TimestampSource = "upstream" | "fetch";

/**
 * One captured section.
 *
 * `asOf` is the market timestamp the values describe; `observedAt` is when we
 * fetched them. When the payload carries no timestamp `asOf === observedAt` and
 * `timestampSource` is `"fetch"`, so a reader can always tell a market clock
 * from our clock without consulting another field.
 */
export interface TapeSection<T> {
  asOf: string;
  observedAt: string;
  timestampSource: TimestampSource;
  /** Present only when the section could not be captured. */
  unavailable?: true;
  /** Why it is unavailable — a short reason, never a stack trace. */
  reason?: string;
  records: T[];
  /** Upstream-specific detail worth keeping: board counts, registry source, … */
  meta?: Record<string, unknown>;
}

export interface IndexRecord {
  code: string;
  name: string;
  price: number;
  changePct: number;
  asOf: string;
  observedAt: string;
  timestampSource: TimestampSource;
}

export interface BoardRecord {
  code: string;
  name: string;
  secid: string;
  changePct: number;
  up: number;
  down: number;
  asOf: string;
  observedAt: string;
  timestampSource: TimestampSource;
}

export interface ThemeRecord {
  key: string;
  name: string;
  boardCode: string | null;
  boardName: string | null;
  changePct: number | null;
  up: number | null;
  down: number | null;
  asOf: string;
  observedAt: string;
  timestampSource: TimestampSource;
}

export interface FlowRecord {
  name: string;
  changePct: number;
  netInflowYi: number;
  asOf: string;
  observedAt: string;
  timestampSource: TimestampSource;
}

export interface LimitRecord {
  code: string;
  name: string;
  changePct: number;
  /** Consecutive limit boards when the upstream reports it. */
  boards: number | null;
  /** The stock's own industry board (upstream `hybk`). */
  industry: string | null;
  asOf: string;
  observedAt: string;
  timestampSource: TimestampSource;
}

/** Wrap records with their two clocks. The only way a record gets them. */
export function buildSection<T>(
  records: T[],
  observedAt: string,
  upstreamAsOf: string | null,
  meta?: Record<string, unknown>,
): TapeSection<T> {
  return {
    asOf: upstreamAsOf ?? observedAt,
    observedAt,
    timestampSource: upstreamAsOf ? "upstream" : "fetch",
    records,
    ...(meta ? { meta } : {}),
  };
}

/** A section that could not be captured: no records, an explicit reason. */
export function unavailableSection<T>(
  observedAt: string,
  reason: string,
  meta?: Record<string, unknown>,
): TapeSection<T> {
  return {
    asOf: observedAt,
    observedAt,
    timestampSource: "fetch",
    unavailable: true,
    reason,
    records: [],
    ...(meta ? { meta } : {}),
  };
}

/** Latest ISO instant among stamps; `null` when none parse. */
export function latestInstant(stamps: readonly (string | null)[]): string | null {
  let best: string | null = null;
  let bestMs = -Infinity;
  for (const s of stamps) {
    if (!s) continue;
    const ms = Date.parse(s);
    if (!Number.isFinite(ms)) continue;
    if (ms > bestMs) {
      bestMs = ms;
      best = s;
    }
  }
  return best;
}

const ISO_WITH_OFFSET = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}[+-]\d{2}:\d{2}$/;

/** True for an ISO 8601 instant that carries an explicit UTC offset. */
export function isOffsetIso(value: unknown): value is string {
  return typeof value === "string" && ISO_WITH_OFFSET.test(value);
}

export interface ClockViolation {
  section: string;
  record: number | null;
  field: string;
  detail: string;
}

/**
 * Structural check that every section and every record carries both clocks,
 * with an offset, and that `timestampSource` is consistent with them.
 *
 * Returned rather than thrown so the caller decides: the baker logs and refuses
 * to write, the test asserts an empty list.
 */
export function assertTwoClocks(snapshot: Record<string, unknown>): ClockViolation[] {
  const out: ClockViolation[] = [];
  for (const [name, raw] of Object.entries(snapshot)) {
    const section = raw as Partial<TapeSection<Record<string, unknown>>>;
    if (!section || typeof section !== "object" || !Array.isArray(section.records)) continue;
    for (const field of ["asOf", "observedAt"] as const) {
      const v = section[field];
      if (!isOffsetIso(v)) {
        out.push({
          section: name,
          record: null,
          field,
          detail: `${field} must be ISO with offset, got ${JSON.stringify(v)}`,
        });
      }
    }
    if (section.timestampSource !== "upstream" && section.timestampSource !== "fetch") {
      out.push({
        section: name,
        record: null,
        field: "timestampSource",
        detail: `timestampSource must be upstream|fetch, got ${JSON.stringify(section.timestampSource)}`,
      });
    }
    section.records.forEach((rec, i) => {
      for (const field of ["asOf", "observedAt"] as const) {
        const v = (rec as Record<string, unknown>)[field];
        if (!isOffsetIso(v)) {
          out.push({
            section: name,
            record: i,
            field,
            detail: `${field} must be ISO with offset, got ${JSON.stringify(v)}`,
          });
        }
      }
      const src = (rec as Record<string, unknown>).timestampSource;
      if (src !== "upstream" && src !== "fetch") {
        out.push({
          section: name,
          record: i,
          field: "timestampSource",
          detail: `record timestampSource must be upstream|fetch, got ${JSON.stringify(src)}`,
        });
      }
    });
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* Capture                                                             */
/* ------------------------------------------------------------------ */

export interface BoardResolution {
  boards: BoardEntry[] | null;
  registry: "live" | "snapshot" | "none";
}

export interface CaptureOptions {
  /** `YYYY-MM-DD` in REPORT_TZ. */
  date: string;
  /** Capture slot `HH:MM`. */
  slot: string;
  /** Capture instant; defaults to now. */
  now?: Date;
  timezone: string;
  /** Test seams. */
  fetchImpl?: typeof fetch;
  sleepImpl?: (ms: number) => Promise<void>;
  /** Registry already resolved by the caller (the baker resolves it once). */
  resolved?: BoardResolution;
  themes?: readonly ThemeDef[];
}

export interface BoardQuotes {
  map: Map<string, BoardQuote> | null;
  /** Latest `f124` stamp across the quoted rows, ISO with offset. */
  asOf: string | null;
}

export interface TapeSections {
  indices: TapeSection<IndexRecord>;
  industries: TapeSection<BoardRecord>;
  themes: TapeSection<ThemeRecord>;
  fundFlows: TapeSection<FlowRecord>;
  limitPool: TapeSection<LimitRecord>;
}

function errText(e: unknown): string {
  return (e instanceof Error ? e.message : String(e)).slice(0, 200);
}

/**
 * One batched quote pass over the industry boards, shared by the industry and
 * theme sections so a theme's number and its board's number come from the same
 * upstream response and the same instant.
 */
export async function captureBoardQuotes(
  boards: readonly BoardEntry[] | null,
  observedAt: string,
  tz: string,
  options: Pick<CaptureOptions, "fetchImpl" | "sleepImpl">,
): Promise<BoardQuotes> {
  if (!boards?.length) return { map: null, asOf: null };
  const industries = boards.filter((b) => b.type === 2);
  if (!industries.length) return { map: null, asOf: null };
  try {
    const map = await fetchBoardQuotes(industries, {
      fetchImpl: options.fetchImpl,
      sleepImpl: options.sleepImpl,
    });
    if (!map.size) return { map: null, asOf: null };
    // Every row of one batch carries the same `f124`; take the latest so a
    // partially-updated batch reports the newest market clock it contains.
    let stamp = 0;
    for (const q of map.values()) {
      const n = Number(q.quoteStamp);
      if (Number.isFinite(n) && n > stamp) stamp = n;
    }
    return { map, asOf: epochSecondsToIso(stamp || null, tz) };
  } catch {
    return { map: null, asOf: null };
  }
}

async function buildIndices(
  observedAt: string,
  tz: string,
  options: Pick<CaptureOptions, "fetchImpl">,
): Promise<TapeSection<IndexRecord>> {
  try {
    const overview = await fetchMarketOverview({ fetchImpl: options.fetchImpl });
    if (!overview?.indices?.length) {
      return unavailableSection<IndexRecord>(observedAt, "market-overview returned no indices");
    }
    // `f86` is the upstream quote stamp — the actual market clock of the value.
    // When a row lacks it we fall back per record, so one stale index cannot
    // borrow a sibling's timestamp.
    const asOf = epochSecondsToIso(
      overview.indices.reduce<number>((max, i) => {
        const n = Number(i.quoteStamp);
        return Number.isFinite(n) && n > max ? n : max;
      }, 0) || null,
      tz,
    );
    const records: IndexRecord[] = overview.indices.map((i) => {
      const own = epochSecondsToIso(i.quoteStamp ?? null, tz);
      return {
        code: i.code,
        name: i.name,
        price: i.price,
        changePct: i.changePct,
        asOf: own ?? observedAt,
        observedAt,
        timestampSource: own ? ("upstream" as const) : ("fetch" as const),
      };
    });
    return buildSection(records, observedAt, asOf, { note: overview.note });
  } catch (e) {
    return unavailableSection<IndexRecord>(observedAt, `market-overview threw: ${errText(e)}`);
  }
}

function buildIndustries(
  boards: readonly BoardEntry[] | null,
  quotes: BoardQuotes,
  observedAt: string,
): TapeSection<BoardRecord> {
  if (!boards?.length) {
    return unavailableSection<BoardRecord>(observedAt, "board registry unavailable");
  }
  const industries = boards.filter((b) => b.type === 2);
  if (!industries.length) {
    return unavailableSection<BoardRecord>(observedAt, "registry carried no industry boards");
  }
  if (!quotes.map) {
    return unavailableSection<BoardRecord>(observedAt, "ulist.np returned no board quotes", {
      registryBoards: industries.length,
    });
  }
  const records: BoardRecord[] = [];
  for (const board of industries) {
    const q = quotes.map.get(board.code);
    if (!q) continue;
    records.push({
      code: board.code,
      name: q.name || board.name,
      secid: board.secid,
      changePct: q.changePct,
      up: q.up,
      down: q.down,
      asOf: quotes.asOf ?? observedAt,
      observedAt,
      timestampSource: quotes.asOf ? ("upstream" as const) : ("fetch" as const),
    });
  }
  if (!records.length) {
    return unavailableSection<BoardRecord>(observedAt, "no industry board carried a quote", {
      registryBoards: industries.length,
    });
  }
  return buildSection(records, observedAt, quotes.asOf, {
    registryBoards: industries.length,
    quoted: records.length,
  });
}

/**
 * Theme boards resolved through the same registry and the same quote map, so a
 * theme row is a view of its board row, not a second fetch that could disagree.
 * A theme that resolves no board keeps its `null`s rather than being dropped:
 * "this theme has no board today" is information about our resolver.
 */
function buildThemes(
  boards: readonly BoardEntry[] | null,
  quotes: BoardQuotes,
  themes: readonly ThemeDef[],
  observedAt: string,
): TapeSection<ThemeRecord> {
  if (!boards?.length) {
    return unavailableSection<ThemeRecord>(observedAt, "board registry unavailable");
  }
  const records: ThemeRecord[] = [];
  let resolved = 0;
  for (const theme of themes) {
    const board = resolveBoard(theme, boards as BoardEntry[]);
    if (board) resolved++;
    const q = board ? quotes.map?.get(board.code) : undefined;
    records.push({
      key: theme.key,
      name: theme.name,
      boardCode: board?.code ?? null,
      boardName: board?.name ?? null,
      changePct: q ? q.changePct : null,
      up: q ? q.up : null,
      down: q ? q.down : null,
      asOf: quotes.asOf ?? observedAt,
      observedAt,
      timestampSource: quotes.asOf ? "upstream" : "fetch",
    });
  }
  if (!resolved) {
    return unavailableSection<ThemeRecord>(observedAt, "no theme resolved a board", {
      themes: themes.length,
    });
  }
  return buildSection(records, observedAt, quotes.asOf, {
    themes: themes.length,
    resolved,
  });
}

async function buildFundFlows(
  boards: readonly BoardEntry[] | null,
  observedAt: string,
  tz: string,
  options: Pick<CaptureOptions, "fetchImpl" | "sleepImpl">,
): Promise<TapeSection<FlowRecord>> {
  if (!boards?.length) {
    return unavailableSection<FlowRecord>(observedAt, "board registry unavailable");
  }
  try {
    const flow = await fetchBoardFundFlow(boards, {
      fetchImpl: options.fetchImpl,
      sleepImpl: options.sleepImpl,
    });
    if (!flow?.rows.length) {
      return unavailableSection<FlowRecord>(observedAt, "ulist.np returned no fund-flow rows");
    }
    const asOf = epochSecondsToIso(flow.quoteStamp, tz);
    const records: FlowRecord[] = flow.rows.map((r) => ({
      name: r.name,
      changePct: r.changePct,
      netInflowYi: Number(r.netInflowYi.toFixed(4)),
      asOf: asOf ?? observedAt,
      observedAt,
      timestampSource: asOf ? ("upstream" as const) : ("fetch" as const),
    }));
    return buildSection(records, observedAt, asOf, { boardType: flow.boardType });
  } catch (e) {
    return unavailableSection<FlowRecord>(observedAt, `fund flow threw: ${errText(e)}`);
  }
}

async function buildLimitPool(
  dateKey: string,
  observedAt: string,
  tz: string,
  options: Pick<CaptureOptions, "fetchImpl" | "sleepImpl">,
): Promise<TapeSection<LimitRecord>> {
  try {
    const pool = await fetchLimitPool(dateKey, {
      fetchImpl: options.fetchImpl,
      sleepImpl: options.sleepImpl,
    });
    if (!pool.ok) {
      return unavailableSection<LimitRecord>(observedAt, pool.reason || "push2ex unreachable", {
        upstream: "push2ex",
      });
    }
    const asOf = epochSecondsToIso(pool.quoteStamp, tz);
    const records: LimitRecord[] = pool.rows.map((r) => ({
      code: r.code,
      name: r.name,
      changePct: r.changePct,
      boards: r.boards,
      industry: r.industry,
      asOf: asOf ?? observedAt,
      observedAt,
      timestampSource: asOf ? ("upstream" as const) : ("fetch" as const),
    }));
    return buildSection(records, observedAt, asOf, {
      upstream: "push2ex",
      tradeDate: pool.tradeDate,
      limitUp: pool.limitUp,
      limitDown: pool.limitDown,
    });
  } catch (e) {
    return unavailableSection<LimitRecord>(observedAt, `limit pool threw: ${errText(e)}`);
  }
}

/**
 * Capture every section. Never throws for an upstream failure: sections degrade
 * independently, so a dead concept feed cannot cost us the index values we did
 * see. The only way this rejects is a caller bug (a bad slot string).
 */
export async function captureSections(options: CaptureOptions): Promise<{
  sections: TapeSections;
  observedAt: string;
  registry: "live" | "snapshot" | "none";
}> {
  const now = options.now ?? new Date();
  const observedAt = isoWithOffset(now, options.timezone);
  const resolved = options.resolved ?? { boards: null, registry: "none" as const };
  const themes = options.themes ?? loadThemeCatalog();

  const quotes = await captureBoardQuotes(resolved.boards, observedAt, options.timezone, options);

  const [indices, fundFlows, limitPool] = await Promise.all([
    buildIndices(observedAt, options.timezone, options),
    buildFundFlows(resolved.boards, observedAt, options.timezone, options),
    buildLimitPool(options.date, observedAt, options.timezone, options),
  ]);

  return {
    observedAt,
    registry: resolved.registry,
    sections: {
      indices,
      industries: buildIndustries(resolved.boards, quotes, observedAt),
      themes: buildThemes(resolved.boards, quotes, themes, observedAt),
      fundFlows,
      limitPool,
    },
  };
}

/** Sections in stable order — used by the index, the revision diff and the log. */
export const TAPE_SECTIONS = [
  "indices",
  "industries",
  "themes",
  "fundFlows",
  "limitPool",
] as const;

export type TapeSectionName = (typeof TAPE_SECTIONS)[number];
