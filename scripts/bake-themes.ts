/**
 * Bake daily_reports/themes.json — 题材热点 (theme heat + constituents
 * + article cross-links). Data: Eastmoney keyless concept-board APIs
 * (live-verified 2026-11-05, 531 boards); article hits from the newest
 * real edition sidecar. Fail-open per theme; zero LLM.
 * Runs AFTER `npm run daily` in CI (consumes the fresh sidecar).
 */
import "./_env";

import fs from "node:fs";
import path from "node:path";

import {
  themeArticleHits,
  resolveBoard,
  loadThemeCatalog,
  type ThemeDef,
} from "../lib/themes/catalog";

const ROOT = "daily_reports";
const OUT = path.join(ROOT, "themes.json");
const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";
const BOARD_LIST_URL = (pn: number) =>
  `https://push2.eastmoney.com/api/qt/clist/get?pn=${pn}&pz=100&po=1&np=1&fltt=2&invt=2&fid=f3&fs=m:90+t:3&fields=f12,f14,f3`;
const CONSTITUENTS_URL = (bk: string) =>
  `https://push2.eastmoney.com/api/qt/clist/get?pn=1&pz=8&po=1&np=1&fltt=2&invt=2&fid=f3&fs=b:${bk}&fields=f12,f14,f3`;

interface BoardRow {
  code: string;
  name: string;
  changePct: number;
}

async function fetchJson<T>(url: string): Promise<T | null> {
  try {
    const res = await fetch(url, {
      headers: { "user-agent": UA },
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) return null;
    return (await res.json()) as T;
  } catch {
    return null;
  }
}

async function fetchBoards(): Promise<BoardRow[]> {
  // EM clist caps pz at 100 — paginate (531 boards -> 6 pages).
  const out: BoardRow[] = [];
  for (let pn = 1; pn <= 8; pn++) {
    const j = await fetchJson<{
      data?: { diff?: Array<{ f12: string; f14: string; f3: number }> };
    }>(BOARD_LIST_URL(pn));
    const rows = j?.data?.diff ?? [];
    if (!rows.length) break;
    for (const d of rows) {
      out.push({
        code: String(d.f12),
        name: String(d.f14),
        changePct: Number(d.f3) || 0,
      });
    }
    if (rows.length < 100) break;
  }
  return out;
}

async function fetchConstituents(bk: string): Promise<BoardRow[]> {
  const j = await fetchJson<{
    data?: { diff?: Array<{ f12: string; f14: string; f3: number }> };
  }>(CONSTITUENTS_URL(bk));
  return (j?.data?.diff ?? []).map((d) => ({
    code: String(d.f12),
    name: String(d.f14),
    changePct: Number(d.f3) || 0,
  }));
}

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

async function main() {
  const boards = await fetchBoards();
  const side = latestSidecarTexts();
  const themes: Array<Record<string, unknown>> = [];
  let okThemes = 0;

  for (const th of loadThemeCatalog()) {
    const board = boards.length ? resolveBoard(th, boards) : null;
    let constituents: BoardRow[] = [];
    if (board) {
      constituents = await fetchConstituents(board.code);
    }
    const art = side
      ? themeArticleHits(side.texts, th)
      : { hits: 0, matched: [] as string[] };
    if (board || art.hits > 0) okThemes++;
    themes.push({
      key: th.key,
      name: th.name,
      boardCode: board?.code ?? null,
      boardName: board?.name ?? null,
      boardChangePct: board?.changePct ?? null,
      articleHits: art.hits,
      matchedAliases: art.matched,
      constituents: constituents.map((c) => ({
        symbol: c.code,
        name: c.name,
        changePct: c.changePct,
      })),
    });
    // Bounded politeness: small gap between constituent fetches.
    if (board) await new Promise((r) => setTimeout(r, 120));
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
    source: "eastmoney-concept-boards",
    status: boards.length ? ("ok" as const) : ("degraded" as const),
    edition: side ? `${side.date}/${side.hour}` : null,
    themes,
  };
  fs.writeFileSync(OUT, JSON.stringify(payload, null, 2) + "\n", "utf8");
  console.log(
    `[themes:bake] wrote ${OUT} themes=${themes.length} ok=${okThemes} boards=${boards.length} edition=${payload.edition ?? "none"}`,
  );
}

main().catch((e) => {
  console.error(e);
  // fail-open: do not fail CI
  process.exit(0);
});
