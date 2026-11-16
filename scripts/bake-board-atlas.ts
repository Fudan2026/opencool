/**
 * Bake lib/reactions/board-atlas.json — the verified company/index atlas.
 *
 * DEV-TIME ONLY. This script exists so a human (or a scheduled refresh) can
 * regenerate the committed atlas from Eastmoney board *membership*; the daily
 * pipeline never runs it and never fetches anything — `lib/reactions/atlas.ts`
 * only `readFileSync`s the committed JSON. Zero LLM by construction.
 *
 * Ground truth, per row:
 *   boards       `datacenter-web.eastmoney.com` `RPT_EM_BOARD` (live, falling
 *                back to the committed `lib/themes/board-map.json` snapshot),
 *                industry boards only (type 2) — those are the boards the
 *                point-in-time tape quotes on every capture.
 *   membership   `RPT_BOARD_CONSTITUENT` filtered by board code: the same
 *                datacenter host and report `bake-themes.ts` reads members from.
 *   names        `push2.eastmoney.com/api/qt/ulist.np/get` (with the delay host
 *                as fallback) — the same quote endpoint the themes bake uses,
 *                because the constituent report carries no company name; plus
 *                `RPT_VALUEANALYSIS_DET` on the datacenter host as a fallback
 *                for whatever a `push2` 502 burst starves.
 *
 * Anti-hallucination rules, enforced here and re-verified by the atlas tests:
 *   1. a company row exists only if the fetch placed it in a board — nothing
 *      is typed from memory;
 *   2. an alias that two companies could claim (`平安`, `中信`) is recorded in
 *      `ambiguous` and excluded from matching;
 *   3. an alias that is a sector/market word (`银行`, `石油`) or a known
 *      false-positive short form (`移动`, `巨石`) is excluded the same way;
 *   4. a company ticker that collides with a quoted index code (`000001` is
 *      both 平安银行 and 上证指数) is excluded rather than guessed.
 *
 * Two more rules keep the file verifiable and calm:
 *   - a row ships only when its boardCode exists in the COMMITTED registry
 *     snapshot (`board-map.json`), because that is what the tests can check;
 *   - a company that several overlapping industry boards claim (山东黄金 sits
 *     in 黄金, 贵金属 and 有色金属) is mapped to the most specific board —
 *     the fewest fetched members — deterministically.
 *
 * Resumable: fetched membership and quoted names are cached in the OS temp dir
 * (override with ATLAS_CACHE), so an interrupted bake reuses everything it
 * already paid for. Politeness: bounded concurrency + short sleeps, matching
 * the themes bake's rhythm.
 */
import "./_env";

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  fetchBoardRegistry,
  loadBoardMapSnapshot,
  toQuoteSecid,
  type BoardEntry,
} from "../lib/invest/board-registry";
import { fetchJson } from "../lib/invest/http-json";
import type { AtlasAmbiguous, AtlasCompany, AtlasIndex, BoardAtlas } from "../lib/reactions/atlas";
import { COLLOQUIAL, GENERIC_BLOCKLIST, NOT_GENERIC } from "../lib/reactions/atlas-curation";

const OUT = path.resolve("lib/reactions/board-atlas.json");
const DATACENTER = "https://datacenter-web.eastmoney.com/api/data/v1/get";
const QUOTE_HOSTS = ["https://push2.eastmoney.com", "https://push2delay.eastmoney.com"];
const QUOTE_HEADERS = { Referer: "https://quote.eastmoney.com/" };
const SCHEMA_VERSION = 1;

/** Constituent pages per board; every industry board fits in one page at 500. */
const PAGE_SIZE = 500;
/** Member-name quote batch. */
const NAME_CHUNK = 50;
/** Concurrent constituent/fallback fetches — the same bound the themes bake uses. */
const CONCURRENCY = 4;
const POLITE_MS = 120;
/** Empty-but-valid replies are the datacenter throttle signature; retry. */
const EMPTY_ATTEMPTS = 4;

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Ticker codes that collide with a quoted index are ambiguous by definition. */
const INDEX_CODES: readonly string[] = ["000001", "399001", "399006"];

/** Index alias rows: the codes the tape quotes, with headline short forms. */
const INDEX_ROWS: readonly AtlasIndex[] = [
  { code: "000001", name: "上证指数", aliases: ["上证指数", "沪指", "上证综指", "沪市"] },
  { code: "399001", name: "深证成指", aliases: ["深证成指", "深成"] },
  { code: "399006", name: "创业板指", aliases: ["创业板指", "创指"] },
];

/* ------------------------------------------------------------------ */
/* Fetches                                                             */
/* ------------------------------------------------------------------ */

interface ConstituentRow {
  SECUCODE?: string;
  SECURITY_CODE?: string;
}

interface ConstituentResponse {
  result?: { pages?: number; data?: ConstituentRow[] } | null;
  success?: boolean;
}

/**
 * All `SECUCODE`s of one board. Filtered by board *code*, not name — names can
 * repeat across board types, and the industry row is the one the tape quotes.
 * An empty-but-valid reply is the datacenter throttle signature (see
 * `fetchConstituents` in board-registry.ts), so it is retried, and only a
 * board that stays empty after the retries is reported as zero members.
 */
async function fetchBoardMembers(
  board: BoardEntry,
  attempts: number,
): Promise<{ secucodes: string[]; empty: boolean }> {
  const filter = encodeURIComponent(`(BOARD_CODE_BK="${board.code}")`);
  const url = (page: number) =>
    `${DATACENTER}?reportName=RPT_BOARD_CONSTITUENT` +
    `&columns=SECUCODE,SECURITY_CODE&pageNumber=${page}&pageSize=${PAGE_SIZE}` +
    `&sortColumns=SECURITY_CODE&sortTypes=1&filter=${filter}`;

  for (let attempt = 1; attempt <= attempts; attempt++) {
    const first = await fetchJson<ConstituentResponse>(url(1), { timeoutMs: 20_000, attempts: 2 });
    const rows = first?.result?.data ?? [];
    if (rows.length) {
      const secucodes: string[] = [];
      for (const row of rows) {
        const secucode = String(row?.SECUCODE ?? "").trim();
        if (secucode) secucodes.push(secucode);
      }
      // One page covers every industry board (largest observed: ~190 members).
      // A `pages > 1` reply is honoured rather than assumed wrong.
      const pages = Number(first?.result?.pages) || 1;
      for (let pn = 2; pn <= pages; pn++) {
        const next = await fetchJson<ConstituentResponse>(url(pn), { timeoutMs: 20_000, attempts: 2 });
        for (const row of next?.result?.data ?? []) {
          const secucode = String(row?.SECUCODE ?? "").trim();
          if (secucode) secucodes.push(secucode);
        }
      }
      return { secucodes, empty: false };
    }
    if (attempt < attempts) await sleep(400 * attempt);
  }
  return { secucodes: [], empty: true };
}

interface QuoteNameResponse {
  data?: { diff?: Array<{ f12?: string; f14?: string }> } | null;
}

/** Spaces stripped, fullwidth ASCII folded to halfwidth, so aliases match headlines. */
function normalizeName(raw: string): string {
  return raw
    .replace(/[\s\u3000]/g, "")
    .replace(/[\uFF01-\uFF5E]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xFEE0));
}

function rowsOf(j: QuoteNameResponse): Map<string, string> {
  const out = new Map<string, string>();
  for (const row of j?.data?.diff ?? []) {
    const code = String(row?.f12 ?? "").trim();
    // `f14` pads some names with spaces (`五 粮 液`) and renders some in
    // fullwidth (`京东方Ａ`); headlines carry neither, so both are
    // normalized rather than shipped as dead aliases.
    const name = normalizeName(String(row?.f14 ?? ""));
    if (code && name) out.set(code, name);
  }
  return out;
}

/**
 * Read one quote batch's rows, or `null` when the reply carries none.
 *
 * Dev-time tolerance, deliberately local to this script: during a `push2` 502
 * burst the hosts answer `502` **with a complete, valid JSON body** (observed
 * on 2026-11-14: every probe), and the shared `fetchJson` rightly refuses
 * non-2xx bodies for the live pipeline. A one-off dev bake may read the body
 * anyway — the parse is strict, so a real nginx error page still fails.
 */
async function quoteNamesOnce(secids: readonly string[]): Promise<Map<string, string> | null> {
  const url = (host: string) =>
    `${host}/api/qt/ulist.np/get?fltt=2&invt=2&fields=f12,f14&secids=${secids.join(",")}`;
  for (const host of QUOTE_HOSTS) {
    // Strict path first, so a healthy host costs one request.
    const j = await fetchJson<QuoteNameResponse>(url(host), {
      headers: QUOTE_HEADERS,
      timeoutMs: 12_000,
      attempts: 1,
    });
    if (j?.data?.diff?.length) return rowsOf(j);
    // Tolerant path: same URL, body accepted regardless of status.
    try {
      const res = await fetch(url(host), {
        headers: {
          ...QUOTE_HEADERS,
          "user-agent":
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        },
        redirect: "manual",
        signal: AbortSignal.timeout(12_000),
      });
      const body = await res.text();
      if (body.trimStart().startsWith("{")) {
        const parsed = JSON.parse(body) as QuoteNameResponse;
        if (parsed?.data?.diff?.length) return rowsOf(parsed);
      }
    } catch {
      /* fall through to the next host */
    }
  }
  return null;
}

/** Company names for codes, via the same quote endpoint the themes bake uses. */
async function fetchNames(codes: readonly string[]): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  for (let i = 0; i < codes.length; i += NAME_CHUNK) {
    const chunk = codes.slice(i, i + NAME_CHUNK);
    let got: Map<string, string> | null = null;
    for (let attempt = 1; attempt <= 3 && !got?.size; attempt++) {
      got = await quoteNamesOnce(chunk);
      if (attempt < 3) await sleep(400 * attempt);
    }
    if (got) for (const [code, name] of got) out.set(code, name);
    if (i + NAME_CHUNK < codes.length) await sleep(POLITE_MS);
  }
  return out;
}

interface ValuationRow {
  SECURITY_CODE?: string;
  SECURITY_NAME_ABBR?: string;
}

interface ValuationResponse {
  result?: { data?: ValuationRow[] } | null;
}

/**
 * Fallback name source on the datacenter host — the one that stayed healthy
 * through every observed `push2` 502 burst. `RPT_VALUEANALYSIS_DET` carries
 * `SECURITY_NAME_ABBR`, but each code has many period rows, so an IN-clause
 * needs paging; one `pageSize=1` request per code is cheaper and simple.
 * Only consulted for codes the quote pass could not name.
 */
async function fetchNamesFallback(codes: readonly string[]): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const fetchOne = async (code: string): Promise<void> => {
    const url =
      `${DATACENTER}?reportName=RPT_VALUEANALYSIS_DET` +
      `&columns=SECURITY_CODE,SECURITY_NAME_ABBR&pageNumber=1&pageSize=1` +
      `&sortColumns=SECURITY_CODE&sortTypes=1` +
      `&filter=${encodeURIComponent(`(SECURITY_CODE="${code}")`)}`;
    const j = await fetchJson<ValuationResponse>(url, { timeoutMs: 20_000, attempts: 2 });
    const row = j?.result?.data?.[0];
    const name = normalizeName(String(row?.SECURITY_NAME_ABBR ?? ""));
    if (row && name) out.set(code, name);
  };
  for (let i = 0; i < codes.length; i += CONCURRENCY) {
    await Promise.all(codes.slice(i, i + CONCURRENCY).map(fetchOne));
    if (i + CONCURRENCY < codes.length) await sleep(POLITE_MS);
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* Resumable cache                                                     */
/* ------------------------------------------------------------------ */

interface AtlasCache {
  boards: Record<string, string[]>;
  names: Record<string, string>;
}

function cacheFile(): string {
  return process.env.ATLAS_CACHE?.trim() || path.join(os.tmpdir(), "opencool-board-atlas-cache.json");
}

function loadCache(): AtlasCache {
  try {
    const parsed = JSON.parse(fs.readFileSync(cacheFile(), "utf8")) as AtlasCache;
    if (parsed && typeof parsed === "object" && typeof parsed.boards === "object" && typeof parsed.names === "object") {
      return parsed;
    }
  } catch {
    /* no usable cache — start cold */
  }
  return { boards: {}, names: {} };
}

function saveCache(cache: AtlasCache): void {
  fs.writeFileSync(cacheFile(), JSON.stringify(cache), "utf8");
}

/* ------------------------------------------------------------------ */
/* Alias distillation                                                  */
/* ------------------------------------------------------------------ */

/**
 * Candidate aliases for one company, before the global ambiguity/generic
 * pass. Rules are deliberately few and mechanical, so a reviewer can hold all
 * of them in mind:
 *   - the fetched 简称 itself;
 *   - the 6-digit ticker;
 *   - `中国` stripped from the head when ≥ 2 characters remain;
 *   - the curated COLLOQUIAL table (validated against membership below).
 */
function candidateAliases(company: string, code: string): Array<{ alias: string; via: string }> {
  const out: Array<{ alias: string; via: string }> = [{ alias: company, via: "name" }];
  if (/^\d{6}$/.test(code)) out.push({ alias: code, via: "ticker" });
  const stripped = company.startsWith("中国") && company.length >= 4 ? company.slice(2) : null;
  if (stripped && stripped.length >= 2) out.push({ alias: stripped, via: "strip-中国" });
  return out;
}

/* ------------------------------------------------------------------ */
/* Main                                                                */
/* ------------------------------------------------------------------ */

async function main(): Promise<void> {
  const live = await fetchBoardRegistry();
  const registry: BoardEntry[] = live?.length ? live : (loadBoardMapSnapshot() ?? []);
  if (!registry.length) {
    throw new Error("board registry unavailable (live and snapshot) — refusing to bake an atlas from memory");
  }
  const registrySource: "live" | "snapshot" = live?.length ? "live" : "snapshot";
  const industries = registry.filter((b) => b.type === 2);
  console.log(`[atlas:bake] registry=${registrySource} industry boards=${industries.length}`);

  const cache = loadCache();

  // Committed registry snapshot, read raw: it carries each board's `type`,
  // which the `loadBoardMapSnapshot` loader drops. This is the ground truth
  // the atlas tests verify against, so the bake verifies against it too.
  const snapshotBoards: Array<{ code: string; name: string; type: number }> = (() => {
    try {
      return (JSON.parse(fs.readFileSync(path.resolve("lib/themes/board-map.json"), "utf8")).boards ?? []) as Array<{
        code: string;
        name: string;
        type: number;
      }>;
    } catch {
      return [];
    }
  })();
  const committedIndustries = new Set(snapshotBoards.filter((b) => b.type === 2).map((b) => b.code));

  // Membership per board, resumable: only boards missing from the cache are
  // fetched, and the cache is rewritten after every board so an interrupted
  // run keeps what it paid for.
  let fetchedBoards = 0;
  for (let i = 0; i < industries.length; i += CONCURRENCY) {
    const batch = industries.slice(i, i + CONCURRENCY);
    await Promise.all(
      batch.map(async (board) => {
        if (cache.boards[board.code]?.length) return;
        const { secucodes, empty } = await fetchBoardMembers(board, EMPTY_ATTEMPTS);
        if (!empty) {
          cache.boards[board.code] = secucodes;
          fetchedBoards++;
        } else {
          console.warn(`[atlas:bake] ${board.code} ${board.name}: no members after ${EMPTY_ATTEMPTS} attempts`);
        }
      }),
    );
    saveCache(cache);
    if (i + CONCURRENCY < industries.length) await sleep(POLITE_MS);
  }
  const covered = industries.filter((b) => cache.boards[b.code]?.length);
  console.log(
    `[atlas:bake] membership fetched for ${covered.length}/${industries.length} boards (${fetchedBoards} new this run)`,
  );

  // Names for every member code not already cached. Keyed by the 6-digit code
  // (`f12`), which is what the quote rows return and what a secid splits into.
  const allCodes = new Set<string>();
  for (const board of covered) {
    for (const secucode of cache.boards[board.code]) {
      const secid = toQuoteSecid(secucode);
      const code = secid?.split(".")[1] ?? "";
      if (code) allCodes.add(code);
    }
  }
  const missing = [...allCodes].filter((c) => !cache.names[c]);
  if (missing.length) {
    const names = await fetchNames(missing);
    for (const [code, name] of names) cache.names[code] = name;
    saveCache(cache);
    console.log(`[atlas:bake] quoted ${names.size}/${missing.length} member names`);
  }
  // Whatever a 502 burst on the quote hosts still starved, the healthy
  // datacenter host names instead — a member without a name cannot match a
  // headline and would silently shrink the atlas by that company.
  const starved = [...allCodes].filter((c) => !cache.names[c]);
  if (starved.length) {
    const names = await fetchNamesFallback(starved);
    for (const [code, name] of names) cache.names[code] = name;
    saveCache(cache);
    console.log(`[atlas:bake] datacenter fallback named ${names.size}/${starved.length} remaining members`);
  }

  // Company rows from the fetched membership — this list IS the anti-hallucination
  // guarantee: nothing below can reference a company the fetch did not place.
  interface Member {
    company: string;
    code: string;
    boardCode: string;
    boardName: string;
  }
  const members: Member[] = [];
  const boardNameOf = new Map(industries.map((b) => [b.code, b.name]));
  for (const board of covered) {
    for (const secucode of cache.boards[board.code]) {
      const secid = toQuoteSecid(secucode);
      const code = secid?.split(".")[1] ?? "";
      // B shares (`200xxx` SZ / `900xxx` SH) are never a finance headline's
      // subject separate from their A-share twin, and keeping them turns every
      // A-share name into a "collision" with its own B sibling
      // (`*ST皇庭` vs `*ST皇庭B`). Dropped as a documented dev-time rule.
      if (/^(200|900)/.test(code)) continue;
      // Normalized here as well: cache entries written by older bakes may
      // still carry fullwidth characters.
      const raw = code ? cache.names[code] : undefined;
      const name = raw ? normalizeName(raw) : undefined;
      if (!code || !name) continue;
      members.push({ company: name, code, boardCode: board.code, boardName: boardNameOf.get(board.code) ?? "" });
    }
  }
  const byCode = new Map<string, Member[]>();
  for (const m of members) byCode.set(m.code, [...(byCode.get(m.code) ?? []), m]);
  const companies: Member[] = [];
  let multiBoard = 0;
  for (const [code, list] of byCode) {
    if (list.length > 1) {
      // Eastmoney's type-2 universe is nested (山东黄金 sits in 黄金, 贵金属
      // AND 有色金属), so a code legitimately appears in several boards. The
      // most specific board — fewest fetched members, tie broken by code — is
      // the one the company's own news most directly reprices; every claimant
      // is a real membership, so any choice is verifiable.
      multiBoard++;
      list.sort(
        (a, b) =>
          (cache.boards[a.boardCode]?.length ?? Infinity) -
          (cache.boards[b.boardCode]?.length ?? Infinity) ||
          a.boardCode.localeCompare(b.boardCode),
      );
    }
    companies.push(list[0]);
  }
  if (multiBoard) {
    console.log(`[atlas:bake] ${multiBoard} companies sit in overlapping industry boards — resolved to the most specific board`);
  }

  // Verified means verified against the COMMITTED registry snapshot: a live
  // board too new for board-map.json cannot be checked by the tests or by a
  // cold clone, so its rows wait for the next board-map refresh instead of
  // shipping uncheckable.
  const verifiable = companies.filter((c) => {
    if (committedIndustries.has(c.boardCode)) return true;
    console.warn(`[atlas:bake] ${c.company} (${c.code}): board ${c.boardCode} is not in the committed snapshot — row deferred until board-map refresh`);
    return false;
  });

  // Generic vocabulary: every board name (all 1,081 — region and concept names
  // are sector words too) plus the blocklist above.
  const genericWords = new Set<string>([...registry.map((b) => b.name), ...GENERIC_BLOCKLIST]);

  // Alias → company assignment, with the two exclusion rules applied globally.
  const ambiguous = new Map<string, AtlasAmbiguous>();
  const exclude = (alias: string, reason: AtlasAmbiguous["reason"], companies: string[]) => {
    if (!ambiguous.has(alias)) ambiguous.set(alias, { alias, reason, ...(reason === "duplicate" ? { companies } : {}) });
  };
  const aliasToCompany = new Map<string, Member>();
  for (const m of verifiable) {
    for (const { alias } of candidateAliases(m.company, m.code)) {
      const existing = aliasToCompany.get(alias);
      if (existing && existing.code !== m.code) {
        exclude(alias, "duplicate", [existing.company, m.company]);
        aliasToCompany.delete(alias);
      } else if (!ambiguous.has(alias)) {
        aliasToCompany.set(alias, m);
      }
    }
  }
  // The curated colloquial table: an entry ships only when exactly one fetched
  // member's name contains its stem — the table is validated, not trusted.
  for (const [alias, stem] of Object.entries(COLLOQUIAL)) {
    const holders = verifiable.filter((c) => c.company.includes(stem));
    if (holders.length !== 1) {
      console.warn(`[atlas:bake] colloquial ${alias}→${stem}: ${holders.length} members match, dropped`);
      continue;
    }
    const existing = aliasToCompany.get(alias);
    if (existing && existing.code !== holders[0].code) {
      exclude(alias, "duplicate", [existing.company, holders[0].company]);
      aliasToCompany.delete(alias);
    } else if (!ambiguous.has(alias)) {
      aliasToCompany.set(alias, holders[0]);
    }
  }
  // An alias that is somebody ELSE's name-fragment names two companies just as
  // surely as a duplicated short form (`茅台` would be ambiguous if a second
  // 茅台-named member existed; `平安` is, with 平安银行).
  for (const [alias, owner] of [...aliasToCompany]) {
    const others = verifiable.filter((c) => c.code !== owner.code && c.company.includes(alias));
    if (others.length) {
      exclude(alias, "duplicate", [owner.company, ...others.map((o) => o.company)]);
      aliasToCompany.delete(alias);
    }
  }
  // Sector words and known false-positive short forms never auto-link.
  for (const alias of [...aliasToCompany.keys()]) {
    for (const word of genericWords) {
      if (word && word.includes(alias)) {
        exclude(alias, "generic", []);
        aliasToCompany.delete(alias);
        break;
      }
    }
  }
  // Reviewed exceptions: an alias excluded only because a company-named board
  // contains it is not a sector word. Re-validated against membership so the
  // exception can never introduce a name the fetch did not see.
  for (const [alias, stem] of Object.entries(NOT_GENERIC)) {
    const holder = verifiable.find((c) => c.company === stem || c.company.includes(stem));
    if (!holder) {
      console.warn(`[atlas:bake] NOT_GENERIC ${alias}→${stem}: no such member, ignored`);
      continue;
    }
    const record = ambiguous.get(alias);
    if (record?.reason === "generic") {
      ambiguous.delete(alias);
      aliasToCompany.set(alias, holder);
    }
  }
  // A ticker that is also a quoted index code is ambiguous, never a company.
  for (const code of INDEX_CODES) {
    if (aliasToCompany.has(code)) {
      const owner = aliasToCompany.get(code)!;
      exclude(code, "duplicate", [owner.company, "上证指数/深证成指/创业板指 (index codes)"]);
      aliasToCompany.delete(code);
    }
  }
  // Index aliases must not collide with a company name fragment either.
  const indexes: AtlasIndex[] = [];
  for (const row of INDEX_ROWS) {
    const aliases: string[] = [];
    for (const alias of row.aliases) {
      const clash = verifiable.filter((c) => c.company.includes(alias));
      if (clash.length) {
        exclude(alias, "duplicate", [row.name, ...clash.map((c) => c.company)]);
      } else {
        aliases.push(alias);
      }
    }
    indexes.push({ ...row, aliases: aliases.length ? aliases : [row.name] });
  }

  // Rows: aliases grouped back per company, companies sorted by code so the
  // committed file diffs readably.
  const aliasGroups = new Map<string, string[]>();
  for (const [alias, m] of aliasToCompany) {
    aliasGroups.set(m.code, [...(aliasGroups.get(m.code) ?? []), alias]);
  }
  const rows: AtlasCompany[] = verifiable
    .map((m) => ({
      company: m.company,
      code: m.code,
      boardCode: m.boardCode,
      boardName: m.boardName,
      aliases: (aliasGroups.get(m.code) ?? []).sort((a, b) => b.length - a.length || a.localeCompare(b)),
    }))
    .sort((a, b) => a.code.localeCompare(b.code));

  const atlas: BoardAtlas = {
    schemaVersion: SCHEMA_VERSION,
    generatedAt: new Date().toISOString(),
    source: "eastmoney-board-registry RPT_BOARD_CONSTITUENT membership",
    registry: registrySource,
    boards: covered.length,
    companies: rows,
    indexes,
    ambiguous: [...ambiguous.values()].sort((a, b) => a.alias.localeCompare(b.alias)),
  };

  const aliasCount = rows.reduce((n, r) => n + r.aliases.length, 0);
  fs.writeFileSync(OUT, `${JSON.stringify(atlas, null, 2)}\n`, "utf8");
  console.log(
    `[atlas:bake] wrote ${OUT}: companies=${rows.length} aliases=${aliasCount} ` +
      `boards=${covered.length} indexes=${indexes.length} ambiguous=${atlas.ambiguous.length}`,
  );
}

main().catch((e) => {
  console.error(e);
  // Dev-time tool: a failed bake must be visible, but the committed atlas on
  // disk is never damaged — fail without touching it.
  process.exit(1);
});
