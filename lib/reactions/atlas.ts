/**
 * The board atlas — verified company/index aliases → industry boards.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * What this is, and what it is NOT
 * ─────────────────────────────────────────────────────────────────────────
 *
 * `attribution.ts` maps the ~40 *story entities* to curated theme boards by
 * hand, and that table is deliberately small: every line is a defensible
 * claim a reviewer can audit in one screen. But a finance headline names
 * *companies* far more often than it names our curated entities, and a
 * company's industry membership is not a matter of judgement — it is
 * published ground truth. `贵州茅台` is a constituent of the 食品饮料 board
 * because Eastmoney's board registry says so, not because we feel it is.
 *
 * So the atlas is a **committed data file** (`board-atlas.json`, produced at
 * dev time by `scripts/bake-board-atlas.ts` from `RPT_BOARD_CONSTITUENT`
 * membership) that turns that ground truth into a lookup: company name /
 * ticker / colloquial short form → the industry board the company actually
 * belongs to. Runtime is zero-LLM and zero-fetch — the daily pipeline only
 * ever reads the committed file.
 *
 * Three rules make a row trustworthy:
 *
 *   1. **No row ships on memory.** Every company row comes from the fetched
 *      membership of a registry board. A name the fetch never saw is not in
 *      the file, so nothing can be hallucinated into a mapping.
 *   2. **An alias resolves to exactly one company.** A short form that
 *      matches two members (`平安` → 中国平安 *and* 平安银行; `中信` → 中信证券
 *      *and* 中信银行) is ambiguous, and ambiguity is recorded in the file's
 *      `ambiguous` block and excluded from matching — never guessed.
 *   3. **An alias is not a sector word.** A generated alias that appears in a
 *      board name (`银行`, `石油`) or in the generic blocklist would map any
 *      headline about the *sector* to one *company*, so the baker excludes
 *      those too, with the reason recorded.
 *
 * Indexes get alias rows as well (沪指 → `index:000001`): a story that names
 * the index it is about is measured on *that* index rather than on the
 * default market proxy — a better target, not a different claim. Index
 * matches stay `attribution: "market"`: the index answers "did the tape
 * move", never "did this sector move".
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/** Where the committed atlas lives, next to this module (like board-map.json). */
export const BOARD_ATLAS_FILE = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "board-atlas.json",
);

/** One company → industry board row. Every field came from the dev-time fetch. */
export interface AtlasCompany {
  /** Company 简称 exactly as the constituent fetch returned it. */
  company: string;
  /** 6-digit ticker, e.g. `600519`. */
  code: string;
  /** Industry board code, e.g. `BK0438`. */
  boardCode: string;
  /** Industry board name, e.g. `食品饮料`. */
  boardName: string;
  /** Aliases that resolve to this company: name, ticker, distilled short forms. */
  aliases: string[];
}

/** Index aliases — a story naming an index is measured on that index. */
export interface AtlasIndex {
  /** Index code as the tape quotes it, e.g. `000001`. */
  code: string;
  name: string;
  aliases: string[];
}

export interface AtlasAmbiguous {
  /** The excluded alias. */
  alias: string;
  /** Why: `duplicate` (two companies) or `generic` (a sector/market word). */
  reason: "duplicate" | "generic";
  /** The companies it collided with, for `duplicate`. */
  companies?: string[];
}

export interface BoardAtlas {
  schemaVersion: number;
  /** When the dev-time bake ran. Diagnostics only — never a runtime input. */
  generatedAt: string;
  source: string;
  registry: "live" | "snapshot";
  /** How many industry boards the membership was fetched for. */
  boards: number;
  companies: AtlasCompany[];
  indexes: AtlasIndex[];
  /** Aliases excluded from matching, with the reason. Audit surface. */
  ambiguous: AtlasAmbiguous[];
}

let cached: BoardAtlas | null = null;

/**
 * Load the committed atlas. Absent or malformed file → `null`, never a
 * throw: attribution must degrade to the explicit-links-only path, not take
 * the bake down (same fail-open rule as `loadBoardMapSnapshot`).
 */
export function loadBoardAtlas(file?: string): BoardAtlas | null {
  if (file) {
    try {
      return parseAtlas(readFileSync(file, "utf8"));
    } catch {
      return null;
    }
  }
  if (cached) return cached;
  try {
    cached = parseAtlas(readFileSync(BOARD_ATLAS_FILE, "utf8"));
    return cached;
  } catch {
    return null;
  }
}

/** Test seam: clear the module cache so a fixture file can be swapped in. */
export function resetBoardAtlasCache(): void {
  cached = null;
}

export function parseAtlas(raw: string): BoardAtlas | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  const a = parsed as Partial<BoardAtlas> | null;
  if (!a || typeof a !== "object") return null;
  if (a.schemaVersion !== 1) return null;
  if (!Array.isArray(a.companies) || !Array.isArray(a.indexes) || !Array.isArray(a.ambiguous)) return null;
  for (const c of a.companies) {
    if (!c || typeof c.company !== "string" || !c.company) return null;
    if (typeof c.code !== "string" || !/^\d{6}$/.test(c.code)) return null;
    if (typeof c.boardCode !== "string" || !/^BK\d+$/.test(c.boardCode)) return null;
    if (typeof c.boardName !== "string" || !c.boardName) return null;
    if (!Array.isArray(c.aliases) || c.aliases.some((x) => typeof x !== "string" || !x)) return null;
  }
  for (const i of a.indexes) {
    if (!i || typeof i.code !== "string" || !/^\d{6}$/.test(i.code)) return null;
    if (typeof i.name !== "string" || !Array.isArray(i.aliases)) return null;
  }
  for (const m of a.ambiguous) {
    if (!m || typeof m.alias !== "string" || (m.reason !== "duplicate" && m.reason !== "generic")) return null;
  }
  return a as BoardAtlas;
}

/* ------------------------------------------------------------------ */
/* Matching                                                            */
/* ------------------------------------------------------------------ */

/** An alias hit inside a headline. */
export interface AtlasMatch {
  /** Which alias matched, as written in the title. */
  alias: string;
  /** Index of the match start — the caller's tiebreak for priority. */
  at: number;
  company?: AtlasCompany;
  index?: AtlasIndex;
}

/** Word-bounded match for pure-ASCII aliases (`601318`, `TCL`). */
function containsAsciiWord(hay: string, needle: string): number {
  const isWord = (c: string) => /[A-Za-z0-9]/.test(c);
  let from = 0;
  for (;;) {
    const at = hay.indexOf(needle, from);
    if (at < 0) return -1;
    const before = at > 0 && isWord(hay[at - 1]);
    const after = at + needle.length < hay.length && isWord(hay[at + needle.length]);
    if (!before && !after) return at;
    from = at + 1;
  }
}

/** Position of `alias` in `title`, or −1. ASCII aliases match word-bounded. */
export function aliasPosition(title: string, alias: string): number {
  if (!title || !alias) return -1;
  // A pure-ASCII alias inside CJK text still needs no boundary check (CJK
  // codepoints are non-word for this purpose), so one rule covers both lanes.
  if (/^[\x21-\x7e]+$/.test(alias)) return containsAsciiWord(title, alias);
  return title.indexOf(alias);
}

/**
 * Every alias hit in a title, for the atlas tables.
 *
 * Pure: no I/O, deterministic. Callers decide priority; the matcher only
 * reports what is literally present.
 */
export function matchAtlas(title: string, atlas: BoardAtlas | null): AtlasMatch[] {
  if (!atlas || !title) return [];
  const out: AtlasMatch[] = [];
  for (const company of atlas.companies) {
    for (const alias of company.aliases) {
      const at = aliasPosition(title, alias);
      if (at >= 0) {
        out.push({ alias, at, company });
        break; // one hit per company is enough to claim the title
      }
    }
  }
  for (const index of atlas.indexes) {
    for (const alias of index.aliases) {
      const at = aliasPosition(title, alias);
      if (at >= 0) {
        out.push({ alias, at, index });
        break;
      }
    }
  }
  return out;
}

/**
 * The one atlas target a title names, when it names exactly one thing
 * unambiguously.
 *
 * Priority — the earliest alias in the title wins, longest on a tie — mirrors
 * the story-entity convention (`entities.ts`): the first-named subject is
 * the story's subject. Company beats index on a full tie because a sector
 * claim is stronger than an index observation.
 */
export function resolveAtlasTarget(
  title: string,
  atlas: BoardAtlas | null,
): { kind: "company" | "index"; match: AtlasMatch } | null {
  const matches = matchAtlas(title, atlas);
  if (!matches.length) return null;
  matches.sort(
    (a, b) =>
      a.at - b.at ||
      b.alias.length - a.alias.length ||
      (a.company ? 0 : 1) - (b.company ? 0 : 1),
  );
  const first = matches[0];
  return { kind: first.company ? "company" : "index", match: first };
}
