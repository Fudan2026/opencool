/**
 * Bake daily_reports/themes.json — 题材热点 (theme heat + constituents
 * + article cross-links). Article hits from the newest real edition sidecar.
 * Fail-open per theme; zero LLM.
 * Runs AFTER `npm run daily` in CI (consumes the fresh sidecar).
 *
 * Board data does NOT come from `clist/get` any more. That endpoint 502s for
 * our clients for hours at a time (0/40 from a VM, and CI logged `boards=0`
 * every run from 2026-11-11), which emptied board heat and every theme's
 * constituents for days without failing a test. The replacement path:
 *
 *   list    `datacenter-web.eastmoney.com` `RPT_EM_BOARD` — different
 *           infrastructure, answered 3/3 pages while `push2` refused
 *           everything; falls back to the committed `lib/themes/board-map.json`.
 *   quotes  `push2.eastmoney.com/api/qt/ulist.np/get` — still 200 on the host
 *           that 502s `clist/get`; takes an explicit `secids` list, so one
 *           batched request per 30 boards covers every theme.
 *   members `datacenter-web.eastmoney.com` `RPT_BOARD_CONSTITUENT`, with the
 *           names and moves of the members quoted through `ulist.np/get`.
 *
 * See `lib/invest/board-registry.ts` for the parsers and the fetch helpers.
 */
import "./_env";

import fs from "node:fs";
import path from "node:path";

import {
  fetchBoardQuotes,
  fetchBoardRegistry,
  fetchConstituents,
  loadBoardMapSnapshot,
  type BoardEntry,
} from "../lib/invest/board-registry";
import { fetchJson } from "../lib/invest/http-json";
import {
  themeArticleHits,
  resolveBoard,
  loadThemeCatalog,
  type ThemeDef,
} from "../lib/themes/catalog";

const ROOT = "daily_reports";
const OUT = path.join(ROOT, "themes.json");
const QUOTE_HEADERS = { Referer: "https://quote.eastmoney.com/" };
/** The published `themes.json` ships the top 3 members per board. */
const PUBLISHED_CONSTITUENTS = 3;

interface Constituent {
  symbol: string;
  name: string;
  changePct: number;
}

/**
 * Resolve the board registry, preferring live data and falling back to the
 * committed snapshot. The two are reported apart so a run that used stale
 * metadata is visible in the log instead of silently looking healthy.
 */
async function loadBoards(): Promise<{ boards: BoardEntry[]; registry: "live" | "snapshot" | "none" }> {
  const live = await fetchBoardRegistry();
  if (live?.length) return { boards: live, registry: "live" };
  const snapshot = loadBoardMapSnapshot();
  if (snapshot?.length) return { boards: snapshot, registry: "snapshot" };
  return { boards: [], registry: "none" };
}

/** Quote a board's candidate members and keep the biggest movers. */
async function topConstituents(boardName: string): Promise<Constituent[]> {
  const { secids } = await fetchConstituents(boardName);
  if (!secids.length) return [];

  const j = await fetchJson<{
    data?: { diff?: Array<{ f12?: string; f14?: string; f3?: number }> };
  }>(
    [
      "https://push2.eastmoney.com",
      "https://push2delay.eastmoney.com",
    ].map(
      (host) =>
        `${host}/api/qt/ulist.np/get?fltt=2&invt=2` +
        `&fields=f12,f14,f3&secids=${secids.join(",")}`,
    ),
    { headers: QUOTE_HEADERS, timeoutMs: 12_000, attempts: 4, retryDelayMs: 400 },
  );

  return (j?.data?.diff ?? [])
    .filter((d) => d.f12 && d.f14 && Number.isFinite(Number(d.f3)))
    .map((d) => ({
      symbol: String(d.f12),
      name: String(d.f14),
      changePct: Number(d.f3),
    }))
    .sort((a, b) => Math.abs(b.changePct) - Math.abs(a.changePct))
    .slice(0, PUBLISHED_CONSTITUENTS);
}

/**
 * How many boards to enrich at once. Measured against the live host: at 6 the
 * throttle's "empty but well-formed" replies outran the retry budget and 3 of
 * 24 boards came back memberless; at 4 every board resolved on repeated runs.
 */
const CONSTITUENT_CONCURRENCY = 4;

/** Latest real sidecar: text pool for article-hit counting. */
function latestSidecarTexts(): { date: string; hour: string; texts: string[] } | null {
  const days = fs
    .readdirSync(ROOT)
    .filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d))
    .sort();
  for (let i = days.length - 1; i >= 0; i--) {
    const dir = path.join(ROOT, days[i]);
    for (const f of fs.readdirSync(dir).filter((x) => /^\d{2}\.json$/).sort().reverse()) {
      try {
        const r = JSON.parse(fs.readFileSync(path.join(dir, f), "utf8"));
        const briefs = [
          ...(r?.finance_briefs ?? []),
          ...(r?.tech_briefs ?? []),
          ...(r?.politics_briefs ?? []),
        ];
        const texts = briefs
          .map((b: { title?: string; summary?: string }) =>
            `${b.title ?? ""} ${b.summary ?? ""}`,
          )
          .filter((x: string) => x.trim().length > 0);
        return { date: days[i], hour: f.replace(/\.json$/, ""), texts };
      } catch {
        /* try next */
      }
    }
  }
  return null;
}

/**
 * Published status. `failed` is deliberately distinct from `degraded`: a
 * snapshot exists precisely so that "no boards" can never be an expected
 * outcome, so zero boards means the fetch path broke and the run must say so
 * rather than reporting an honest-degradation `degraded`.
 */
function bakeStatus(boardThemes: number, registry: "live" | "snapshot" | "none"): "ok" | "degraded" | "failed" {
  if (boardThemes > 0) return "ok";
  return registry === "none" ? "degraded" : "failed";
}

async function main() {
  const { boards, registry } = await loadBoards();
  const side = latestSidecarTexts();

  // One batched quote call set for every resolved board, before the per-theme
  // constituent work starts.
  const matched = loadThemeCatalog().map((theme) => ({
    theme,
    board: boards.length ? resolveBoard(theme, boards) : null,
  }));
  const quotes = await fetchBoardQuotes(
    matched.map((m) => m.board).filter((b): b is BoardEntry => b !== null),
  );

  // Constituents are independent per board, so they run through a small pool.
  // Sequentially this step dominated the bake (24 boards x slow tail latency).
  const constituents = new Map<string, Constituent[]>();
  const queue = matched.filter((m) => m.board !== null);
  const fetchInto = async (board: BoardEntry) => {
    constituents.set(board.code, await topConstituents(board.name));
  };
  let cursor = 0;
  const worker = async () => {
    for (let i = cursor++; i < queue.length; i = cursor++) {
      await fetchInto(queue[i].board!);
      // Bounded politeness: the registry host is generous but not free.
      await new Promise((r) => setTimeout(r, 120));
    }
  };
  await Promise.all(Array.from({ length: CONSTITUENT_CONCURRENCY }, worker));

  // Second sweep for the boards the throttle starved. Empty members are the one
  // field where a miss is silent in the published JSON, so they get one more
  // pass rather than shipping a board with no constituents.
  const starved = queue.filter((m) => (constituents.get(m.board!.code) ?? []).length === 0);
  for (let i = 0; i < starved.length; i += CONSTITUENT_CONCURRENCY) {
    await Promise.all(starved.slice(i, i + CONSTITUENT_CONCURRENCY).map((m) => fetchInto(m.board!)));
  }

  const themes: Array<Record<string, unknown>> = [];
  let okThemes = 0;
  let boardThemes = 0;

  for (const { theme, board } of matched) {
    const quote = board ? quotes.get(board.code) : undefined;
    const art: { hits: number; matched: string[] } = side
      ? themeArticleHits(side.texts, theme)
      : { hits: 0, matched: [] };

    if (board) boardThemes++;
    if (board || art.hits > 0) okThemes++;

    themes.push({
      key: theme.key,
      name: theme.name,
      boardCode: board?.code ?? null,
      boardName: board?.name ?? null,
      boardChangePct: quote ? quote.changePct : null,
      /** Advancing / declining members, from the board quote itself. */
      boardUp: quote ? quote.up : null,
      boardDown: quote ? quote.down : null,
      articleHits: art.hits,
      matchedAliases: art.matched,
      constituents: board ? (constituents.get(board.code) ?? []) : [],
    });
  }

  // Composite sort: article heat first (news-driven), then board move.
  themes.sort(
    (a, b) =>
      (b.articleHits as number) - (a.articleHits as number) ||
      Math.abs((b.boardChangePct as number) ?? 0) -
        Math.abs((a.boardChangePct as number) ?? 0),
  );

  const payload = {
    generatedAt: new Date().toISOString(),
    source: "eastmoney-board-registry",
    status: bakeStatus(boardThemes, registry),
    registry,
    edition: side ? `${side.date}/${side.hour}` : null,
    themes,
  };
  fs.writeFileSync(OUT, JSON.stringify(payload, null, 2) + "\n", "utf8");
  console.log(
    `[themes:bake] wrote ${OUT} themes=${themes.length} ok=${okThemes} ` +
      `boards=${boardThemes} registry=${registry} edition=${payload.edition ?? "none"}`,
  );
  if (payload.status === "failed") {
    console.error(
      "[themes:bake] boards=0 with a committed board map — board resolution is broken, " +
        "themes.json is degraded to article heat only",
    );
  }
}

main().catch((e) => {
  console.error(e);
  // fail-open: do not fail CI
  process.exit(0);
});
