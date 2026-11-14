/**
 * Deterministic near-duplicate suppression + story clustering for rendered
 * panels.
 *
 * Why this exists (audit §2.3 / §3.5): the 2026-11-13 06:00 panel rendered 24
 * slots that contained three *exact* cross-source duplicates (same headline
 * from two wires) plus a weather forecast. Nothing in the render path deduped,
 * and SimHash — promised in Wave 9 — was never shipped. This module is the
 * dependency-free replacement: no network, no LLM, no hashing library.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * Two distinct jobs, deliberately separate
 * ─────────────────────────────────────────────────────────────────────────
 *
 * **1. Duck suppression** (`dedupeStories`) — remove the *same headline* seen
 * twice. Two stages: an exact key (`normalizeTitle` in the classifier already
 * strips `财联社11月13日电，` style prefixes, which is what made identical
 * stories look different), then weighted headline affinity at
 * `NEAR_DUPLICATE_THRESHOLD`. Survivor = most informative title, then newest,
 * then source id, so a truncated wire flash never displaces the fuller version
 * and the choice is stable across reruns.
 *
 * **2. Story clustering** (`storyCluster`) — group *different headlines about
 * one event*, which dedupe cannot do: `Nvidia scandal draws in Lutnick`,
 * `Who will replace Jensen Huang?` and `Value Nvidia, not Huang` are three
 * legitimate sentences about one story. The density cap counts these
 * together, using the first entity from `STORY_ENTITIES` named in the
 * headline. Headlines naming no tracked entity fall back to a coarse token
 * signature, so they still cannot flood a panel with near-identical wording.
 *
 * **3. Story identity** (`sameStoryHeadlines`) — the ledger's pair-level
 * "are these two headlines the same story?" decision, built on the weighted
 * `headlineAffinity`. v1 identity was cluster equality alone; measured on
 * 1430 labeled pairs harvested from the published ledger it mis-merged 77%
 * of distinct pairs (an entity key is a subject, not a story: `entity:trump`
 * had 500 sightings) and mis-split 26% of same-story pairs (a reworded
 * repeat that drops its entity mention never matched). v2 gates every
 * non-exact join on affinity, with identity conflicts for the classes the
 * corpus proved are never one story. See the labeled fixture under
 * `tests/fixtures/clustering-pairs.json` and `scripts/topics-eval.ts`.
 *
 * Both are pure functions of the article list: no clocks, no randomness, no I/O.
 */

import { normalizeTitleForMatch } from "../nlp/tokenize-title";
import { normalizeTitle } from "./classify";
import { STORY_ENTITIES } from "./entities";

/**
 * Titles at or above this headline affinity are treated as the same story on
 * a rendered panel. 0.65, not 0.6: the weighted affinity scale puts same-
 * template different-digit flashes (`季度观察1号观察` vs `季度追踪1号观察`,
 * 0.625) just under it while true reprints (`0.792`+) stay above — the old
 * plain-Jaccard 0.6 merged the former and let direction flips through.
 */
export const NEAR_DUPLICATE_THRESHOLD = 0.65;

// ─────────────────────────────────────────────────────────────────────────
// v2 — weighted headline affinity (cluster identity discipline)
// ─────────────────────────────────────────────────────────────────────────
//
// Measured on the real ledger (1430 labeled headline pairs harvested from
// stories.json), plain token Jaccard fails in both directions:
//
//   false merges — an entity cluster key alone merges *any* two headlines
//     naming the same entity: `entity:trump` had accumulated 500 sightings
//     of unrelated stories, `entity:huawei` nine different events over ten
//     days. Structurally near-identical flashes also merge on generic
//     vocabulary alone: two *different* ETFs halting (`纳指ETF嘉实(159501)…`
//     vs `纳指ETF广发(159941)…`, Jaccard 0.71) or two tenors of the same
//     yield move (`日本10年期国债…2.86%` vs `日本5年期…2.265%`, 0.67).
//   false splits — reworded repeats of one story with no tracked entity and
//     different urls never meet: `Bessent blames Lutnick's Commerce
//     Department for failing to block Megaspeed` vs `…for failure to
//     blacklist Megaspeed` (0.67, distinct records under v1).
//
// The fix keeps the exact key and the entity cluster, but gates every
// non-exact match on a *weighted* token overlap where:
//
//   - generic beat vocabulary (美股/指数/利率/收盘, "stocks", "markets",
//     "says", wire-format fillers, date numbers) counts 0.25 — naming the
//     beat is not naming the story;
//   - direction words (收涨/收跌, 上涨/下跌, rally/selloff) stay at full
//     weight — they are the one thing two opposite stories must not share;
//   - quantities (prices, percentages, counts, ticker codes) count 2.0 —
//     in finance the number usually *is* the story, so `2.86%` vs `2.265%`
//     and `159501` vs `159941` pull similarity down hard.
//
// Zero LLM, zero network, pure functions — the thresholds were tuned on the
// labeled corpus once and are asserted by the golden suite.

/**
 * Beat/filler vocabulary whose presence in both headlines carries almost no
 * same-story evidence. Auditable table: adding a token here down-weights it
 * in `headlineAffinity` and in every consumer (panel dedupe, identity).
 * CJK entries are 2-character bigrams as emitted by the tokenizer.
 */
export const GENERIC_HEADLINE_TOKENS: readonly string[] = [
  // — zh: markets & instruments —
  "美股", "指数", "大指", "三大", "利率", "收盘", "开盘", "高开", "低开",
  "盘前", "盘中", "盘后", "午间", "市场", "全球", "经济", "板块", "集体",
  "国债", "期货", "基点", "个基", "成交", "资金", "股价", "股指",
  // — zh: verbs of quoting/reporting & format fillers —
  "报道", "消息", "快讯", "新闻", "精选", "早报", "晚报", "数据", "最新",
  "今日", "昨日", "宣布", "表示", "公布", "发布", "召开", "举行", "机构",
  "财新", "电讯", "通讯", "社电", "日电",
  // — en: markets & format fillers —
  "stock", "stocks", "market", "markets", "index", "futures", "shares",
  "share", "wall", "street", "says", "said", "report", "reports", "data",
  "news", "live", "update", "updates", "wrap", "today", "latest", "daily",
  "after", "before", "amid", "over", "from", "with", "the", "and",
];

/** Weight of a generic token in `headlineAffinity`. */
export const GENERIC_TOKEN_WEIGHT = 0.25;
/** Weight of a quantity (non-date number) in `headlineAffinity`. */
export const NUMERIC_TOKEN_WEIGHT = 2;
/** Affinity returned for a pair that disagrees on an identity-defining token. */
export const IDENTITY_CONFLICT_AFFINITY = 0.05;

/** Direction vocabulary — an up-only headline never describes a down-only move. */
const UP_TOKENS = new Set([
  "收涨", "上涨", "涨超", "涨幅", "大涨", "涨停", "走高", "升破", "拉升",
  "rise", "rises", "rose", "gain", "gains", "jump", "jumps", "surge", "surges",
  "climb", "climbs", "rally", "rallies", "soar", "soars", "up",
]);
const DOWN_TOKENS = new Set([
  "收跌", "下跌", "跌超", "跌幅", "大跌", "跌停", "走低", "跌破", "下挫",
  "回落", "fall", "falls", "fell", "drop", "drops", "slide", "slides",
  "sink", "sinks", "slump", "tumble", "down", "lost", "loses", "plunge",
]);
/** Asset-class vocabulary — an equity-only flash never reports a debt-only flow. */
const EQUITY_TOKENS = new Set([
  "股票", "日股", "美股", "欧股", "a股", "港股", "股市",
  "stocks", "stock", "shares", "equities", "equity",
]);
const DEBT_TOKENS = new Set([
  "债券", "国债", "地方债", "金融债",
  "treasury", "bond", "bonds", "treasuries",
]);

const GENERIC_TOKENS = new Set(GENERIC_HEADLINE_TOKENS);

/** Date phrases — their numbers are context (edition day), never identity. */
const DATE_PHRASE =
  /(\d{1,2}月\d{1,2}日)|(\d{4}年)|(nov\.?\s?\d{1,2})|(dec\.?\s?\d{1,2})|(jan\.?\s?\d{1,2})|(feb\.?\s?\d{1,2})|(mar\.?\s?\d{1,2})|(apr\.?\s?\d{1,2})|(may\s?\d{1,2})|(jun\.?\s?\d{1,2})|(jul\.?\s?\d{1,2})|(aug\.?\s?\d{1,2})|(sep\.?\s?\d{1,2})|(oct\.?\s?\d{1,2})|(\d{1,2}\s?(?:nov|dec|jan|feb|mar|apr|may|jun|jul|aug|sep|oct))/g;
/** Bracketed identifiers: ticker codes, fund codes, `(十八期)`-style issues. */
const BRACKET_SPAN = /[（(]([^（()）]{1,24})[)）]/g;
const CJK_NUMERAL_PERIOD = /^[\u4e00-\u9fff]{0,4}期$/;
/** Tenor tokens: `10年期` vs `5年期` are different instruments. */
const TENOR_SPAN = /\d{1,2}年期/g;
const CJK_RUN = /[\u4e00-\u9fff]+/g;

/**
 * Weighted token profile of one headline: token → weight, plus the
 * identity-defining token sets used for conflict detection.
 *
 * Deliberately *not* `tokenizeTitle`: this tokenizer keeps number runs whole
 * (`2.265` is one token, not `2` `8` `6` bigram shards), extracts date phrases
 * and bracketed identifiers before numbers are seen, and assigns per-token
 * weights. `tokenizeTitle` stays untouched for its own consumers.
 *
 * Pure function of the title, so profiles and exact keys are memoized — the
 * ledger asks the same handful of headline strings thousands of times per
 * bake, and recomputing them made a 500-article edition take a minute.
 * The caches are capped and cleared wholesale when full; identity never
 * depends on cache state.
 */
export interface HeadlineProfile {
  tokens: Map<string, number>;
  /** bracketed identifiers, e.g. `159501`, `十八期` */
  ids: Set<string>;
  /** tenor tokens, e.g. `10年期` */
  tenors: Set<string>;
  /** non-date quantity tokens, e.g. `2.86`, `1200` */
  quantities: Set<string>;
  /** first tracked entity named, when any (`storyCluster`'s anchor) */
  entity: string | null;
  up: number;
  down: number;
  equity: number;
  debt: number;
}

/** Pure-function memo caches, capped and cleared wholesale when full. */
const PROFILE_CACHE_LIMIT = 20_000;
const profileCache = new Map<string, HeadlineProfile>();
const exactKeyCache = new Map<string, string>();
const clusterCache = new Map<string, string>();

function memoPut<T>(cache: Map<string, T>, key: string, value: T): T {
  if (cache.size >= PROFILE_CACHE_LIMIT) cache.clear();
  cache.set(key, value);
  return value;
}

export function profileHeadline(title: string): HeadlineProfile {
  const key = title ?? "";
  const hit = profileCache.get(key);
  if (hit !== undefined) return hit;
  return memoPut(profileCache, key, computeProfile(key));
}

function computeProfile(title: string): HeadlineProfile {
  const tokens = new Map<string, number>();
  const ids = new Set<string>();
  const tenors = new Set<string>();
  const quantities = new Set<string>();
  let up = 0;
  let down = 0;
  let equity = 0;
  let debt = 0;

  // Everything identity-shaped must be lifted from the RAW surface, before
  // punctuation (decimal points, thousands commas, `%`) is flattened to
  // spaces by `normalizeTitleForMatch` and the shapes are destroyed.
  let raw = normalizeTitle(title ?? "")
    // URLs go first: their digits are addresses, not quantities.
    .replace(/https?:\/\/\S+/g, " ")
    // Bracketed identifiers: ticker/fund codes, `(十八期)`-style issues.
    .replace(BRACKET_SPAN, (_m: string, inner: string) => {
      const c = inner.trim().toLowerCase();
      if (/\d/.test(c) || CJK_NUMERAL_PERIOD.test(c)) {
        tokens.set(`id:${c}`, NUMERIC_TOKEN_WEIGHT);
        ids.add(c);
      } else if (c) {
        tokens.set(`br:${c}`, 1);
      }
      return " ";
    });

  // Date phrases first, so their digits are never read as quantities.
  raw = raw.replace(DATE_PHRASE, (m) => {
    tokens.set(`date:${m.replace(/\s+/g, "")}`, GENERIC_TOKEN_WEIGHT);
    return " ";
  });
  // Tenors next: `10年期` is an instrument, not a quantity.
  raw = raw.replace(TENOR_SPAN, (m) => {
    tokens.set(`tenor:${m}`, NUMERIC_TOKEN_WEIGHT);
    tenors.add(m);
    return " ";
  });
  // Quantities: whole number runs — decimals and thousands commas intact,
  // commas normalized so `1,880.8` and `1880.8` are the same datapoint.
  raw = raw.replace(/\d+(?:,\d{3})*(?:\.\d+)?/g, (m) => {
    const q = m.replace(/,/g, "");
    tokens.set(q, Math.max(tokens.get(q) ?? 0, NUMERIC_TOKEN_WEIGHT));
    quantities.add(q);
    return " ";
  });

  let s = normalizeTitleForMatch(raw);
  if (!s) return { tokens, ids, tenors, quantities, entity: firstStoryEntity(title ?? ""), up, down, equity, debt };

  const note = (t: string, w: number): void => {
    tokens.set(t, w);
    if (UP_TOKENS.has(t)) up++;
    if (DOWN_TOKENS.has(t)) down++;
    if (EQUITY_TOKENS.has(t)) equity++;
    if (DEBT_TOKENS.has(t)) debt++;
  };

  // ASCII words.
  for (const w of s.split(/[^a-z0-9']+/)) {
    if (w.length < 2) continue;
    note(w, GENERIC_TOKENS.has(w) ? GENERIC_TOKEN_WEIGHT : 1);
  }

  // CJK bigrams (digit-free after the passes above).
  for (const run of s.match(CJK_RUN) ?? []) {
    for (let i = 0; i < run.length - 1; i++) {
      note(run.slice(i, i + 2), GENERIC_TOKENS.has(run.slice(i, i + 2)) ? GENERIC_TOKEN_WEIGHT : 1);
    }
    if (run.length === 1) note(run, GENERIC_TOKENS.has(run) ? GENERIC_TOKEN_WEIGHT : 1);
  }
  return { tokens, ids, tenors, quantities, entity: firstStoryEntity(title ?? ""), up, down, equity, debt };
}

/**
 * When two headlines agree on every word but disagree on their quantities,
 * the quantities ARE the story: `国内黄金克价跌破890元` vs `跌破860元` are two
 * prints, and `某上市公司第0号…公告` vs `第1号…公告` are two filings — same
 * template, different datapoint. Fires only when the wording is essentially
 * identical (numberless affinity ≥ `TEMPLATE_MATCH_AFFINITY`), so a reworded
 * repeat whose numbers moved with an intraday update (`Soars 68%` vs
 * `Up 7.9%`, numberless affinity 0.8) still merges.
 */
export const TEMPLATE_MATCH_AFFINITY = 0.85;

/** Weighted Jaccard over tokens excluding the quantity tokens. */
function numberlessAffinity(a: HeadlineProfile, b: HeadlineProfile): number {
  const ta = new Map([...a.tokens].filter(([t]) => !a.quantities.has(t) && !t.startsWith("tenor:")));
  const tb = new Map([...b.tokens].filter(([t]) => !b.quantities.has(t) && !t.startsWith("tenor:")));
  if (ta.size === 0 || tb.size === 0) return 0;
  let inter = 0;
  for (const [t, w] of ta) {
    const wb = tb.get(t);
    if (wb !== undefined) inter += Math.min(w, wb);
  }
  let union = 0;
  for (const [t, w] of ta) union += Math.max(w, tb.get(t) ?? 0);
  for (const [t, w] of tb) if (!ta.has(t)) union += w;
  return union === 0 ? 0 : inter / union;
}

/** True when the pair disagrees on an identity-defining token class. */
function identityConflict(a: HeadlineProfile, b: HeadlineProfile): boolean {
  // Different tracked subjects: `微软发布新产品线公告` vs `苹果发布新产品线公告`
  // share the template but name different companies — that is never one story.
  if (a.entity !== null && b.entity !== null && a.entity !== b.entity) return true;
  // Same template, different datapoint (see TEMPLATE_MATCH_AFFINITY).
  if (a.quantities.size > 0 && b.quantities.size > 0) {
    let differ = false;
    for (const q of a.quantities) if (!b.quantities.has(q)) differ = true;
    for (const q of b.quantities) if (!a.quantities.has(q)) differ = true;
    if (differ && numberlessAffinity(a, b) >= TEMPLATE_MATCH_AFFINITY) return true;
  }
  // Different bracketed identifiers: 159501 vs 159941, 十八期 vs 二十一期.
  if (a.ids.size > 0 && b.ids.size > 0) {
    for (const x of a.ids) if (!b.ids.has(x)) return true;
    for (const x of b.ids) if (!a.ids.has(x)) return true;
  }
  // Different tenors: 日本10年期国债 vs 日本5年期国债.
  if (a.tenors.size > 0 && b.tenors.size > 0) {
    for (const x of a.tenors) if (!b.tenors.has(x)) return true;
    for (const x of b.tenors) if (!a.tenors.has(x)) return true;
  }
  // Opposite directions: 收涨 vs 收跌, rises vs falls.
  const aUp = a.up > 0 && a.down === 0;
  const aDown = a.down > 0 && a.up === 0;
  const bUp = b.up > 0 && b.down === 0;
  const bDown = b.down > 0 && b.up === 0;
  if ((aUp && bDown) || (aDown && bUp)) return true;
  // Opposite asset classes: 外资买进日股 vs 外资买进日本债券.
  const aEq = a.equity > 0 && a.debt === 0;
  const aDebt = a.debt > 0 && a.equity === 0;
  const bEq = b.equity > 0 && b.debt === 0;
  const bDebt = b.debt > 0 && b.equity === 0;
  if ((aEq && bDebt) || (aDebt && bEq)) return true;
  return false;
}

/**
 * Weighted Jaccard similarity of two headlines, 0..1.
 *
 * Shared distinctive tokens (quantities, direction words, names) push the
 * score up; shared generic beat vocabulary barely moves it. A disagreement on
 * an identity-defining token class — different fund codes, different tenors,
 * opposite directions, opposite asset classes — collapses the score to
 * `IDENTITY_CONFLICT_AFFINITY`, below every gate: two flashes that agree on
 * the template but disagree on the one token that names the subject are two
 * different stories, however similar their wording.
 */
export function headlineAffinity(a: string, b: string): number {
  return affinityOfProfiles(profileHeadline(a), profileHeadline(b));
}

function affinityOfProfiles(pa: HeadlineProfile, pb: HeadlineProfile): number {
  if (identityConflict(pa, pb)) return IDENTITY_CONFLICT_AFFINITY;
  const ta = pa.tokens;
  const tb = pb.tokens;
  if (ta.size === 0 || tb.size === 0) return 0;
  let inter = 0;
  for (const [t, w] of ta) {
    const wb = tb.get(t);
    if (wb !== undefined) inter += Math.min(w, wb);
  }
  let union = 0;
  for (const [t, w] of ta) union += Math.max(w, tb.get(t) ?? 0);
  for (const [t, w] of tb) if (!ta.has(t)) union += w;
  return union === 0 ? 0 : inter / union;
}

/** True when one headline is CJK-only and the other ASCII-only. */
function scriptDisjoint(a: string, b: string): boolean {
  const letters = (t: string) => (t ?? "").replace(/[^\p{L}]/gu, "");
  const cjk = /[\u4e00-\u9fff]/;
  const latin = /[A-Za-z]/;
  const la = letters(a);
  const lb = letters(b);
  return (
    (cjk.test(la) && !latin.test(la) && !cjk.test(lb) && latin.test(lb)) ||
    (cjk.test(lb) && !latin.test(lb) && !cjk.test(la) && latin.test(la))
  );
}

/**
 * Affinity at which two headlines sharing an entity cluster are the same
 * *event* when the observations are more than a day apart. Tuned once on the
 * labeled corpus (te in the sweep): different stories about one entity share
 * almost no distinctive vocabulary, however recent.
 */
export const SAME_EVENT_AFFINITY = 0.35;

/**
 * Same-entity gate when both observations fall on the same calendar day.
 * Lower than `SAME_EVENT_AFFINITY` because temporal proximity is real
 * corroboration: several wires covering one event on one day reword freely
 * (`Nvidia board weighs replacing Jensen Huang` vs `Nvidia stock falls as
 * succession talk swirls`, affinity 0.089 — the ledger's own spec makes
 * those one story), while *different* stories about one entity still share almost
 * nothing — on 2026-11-13 alone `entity:trump` held the BBC deposition, the
 * Michigan rallies, the Miller appointment and the wind-power campaign as
 * separate stories, and half of them stay below this gate.
 */
export const SAME_DAY_ENTITY_AFFINITY = 0.08;

/**
 * Affinity at which two headlines are the same story *without* a shared
 * cluster — the reworded-repeat channel. No entity corroboration, but the
 * identity conflicts (codes, tenors, directions, asset classes) already
 * guard the dangerous zones, so the gate can sit low enough to catch
 * cross-wire rewordings like `Man United sack head coach Michael Carrick
 * after dismal run` vs `Manchester United sack Michael Carrick as manager`.
 */
export const REWORDED_REPEAT_AFFINITY = 0.2;

/**
 * Do these two headlines report the same discrete story?
 *
 * v1 identity was `storyCluster(a) === storyCluster(b)` — entity equality or
 * an exact surface key. v2 keeps both anchors and adds the discipline the
 * labeled corpus demanded:
 *
 *   1. exact surface key → same (unchanged, the true repeat);
 *   2. same entity cluster:
 *      - same calendar day (`dayGap === 0`) AND the two headlines are in
 *        different scripts → same. The cross-language relay: one event
 *        covered in both lanes (`英伟达财报超预期，盘后大涨` / `Nvidia
 *        earnings beat estimates, shares jump`) shares zero tokens, and the
 *        entity + the day are the identity.
 *      - otherwise affinity ≥ gate — `SAME_DAY_ENTITY_AFFINITY` for same-day
 *        pairs, `SAME_EVENT_AFFINITY` across days. This is what splits the
 *        entity mega-records: different stories about one entity share
 *        almost no distinctive vocabulary, however recent.
 *   3. different clusters AND affinity ≥ `REWORDED_REPEAT_AFFINITY` → a
 *      reworded repeat that dropped or swapped its entity mention.
 *
 * `dayGap` is calendar days between the two observations (edition dates);
 * callers that do not know it should omit it and get the conservative gate.
 * Pure function of the two strings plus that one integer. The URL+cluster
 * guard and the wire self-repeat guard in the ledger are untouched and
 * remain stricter than this.
 */
export function sameStoryHeadlines(a: string, b: string, dayGap = 1): boolean {
  const ka = exactStoryKey(a);
  const kb = exactStoryKey(b);
  if (!ka || !kb) return false;
  if (ka === kb) return true;
  if (storyCluster(a) === storyCluster(b)) {
    if (dayGap === 0 && scriptDisjoint(a, b)) return true;
    return headlineAffinity(a, b) >= (dayGap === 0 ? SAME_DAY_ENTITY_AFFINITY : SAME_EVENT_AFFINITY);
  }
  return headlineAffinity(a, b) >= REWORDED_REPEAT_AFFINITY;
}

export interface DedupeItem {
  title: string;
  sourceId?: string;
  publishedAt?: Date;
}

export interface DedupeResult<T extends DedupeItem> {
  /** Survivors, in their original relative order. */
  kept: T[];
  /** Items folded into a survivor, for logging and tests. */
  dropped: T[];
}

/**
 * Canonical key for "same story, same headline surface".
 *
 * `normalizeTitle` strips wire prefixes and leading dates; the extra fold
 * removes case, punctuation and whitespace. CJK is unaffected beyond
 * whitespace, so 财联社's `财联社11月13日电，X` and 华尔街见闻's `X` collapse.
 */
export function exactStoryKey(title: string): string {
  const raw = title ?? "";
  const hit = exactKeyCache.get(raw);
  if (hit !== undefined) return hit;
  return memoPut(exactKeyCache, raw, normalizeTitleForMatch(normalizeTitle(raw)));
}

/** Informative-first ordering used to pick a cluster's survivor. */
function betterSurvivor<T extends DedupeItem>(a: T, b: T): number {
  const la = exactStoryKey(a.title).length;
  const lb = exactStoryKey(b.title).length;
  if (la !== lb) return lb - la;
  const ta = a.publishedAt?.getTime() ?? Number.NEGATIVE_INFINITY;
  const tb = b.publishedAt?.getTime() ?? Number.NEGATIVE_INFINITY;
  if (ta !== tb) return tb - ta;
  return (a.sourceId ?? "").localeCompare(b.sourceId ?? "");
}

/**
 * Collapse duplicate stories. Survivors keep their original relative order so
 * the caller's ranking (recency, heat) is untouched.
 *
 * O(n²) token comparisons — correct for a panel-sized list and keeps the code
 * dependency-free and obvious.
 */
export function dedupeStories<T extends DedupeItem>(items: readonly T[]): DedupeResult<T> {
  const groups = new Map<string, T[]>();
  const order: string[] = [];
  const tokenCache = new Map<T, HeadlineProfile>();

  const tokensOf = (item: T): HeadlineProfile => {
    let t = tokenCache.get(item);
    if (t === undefined) {
      t = profileHeadline(item.title);
      tokenCache.set(item, t);
    }
    return t;
  };

  for (const item of items) {
    const key = exactStoryKey(item.title);
    const siblings = groups.get(key);
    if (siblings) {
      siblings.push(item);
      continue;
    }

    // Compare only against group representatives: transitive similarity must
    // never chain-merge a whole panel into one bucket.
    let matchedKey: string | null = null;
    for (const candidateKey of order) {
      const rep = groups.get(candidateKey)![0];
      if (affinityOfProfiles(tokensOf(item), tokensOf(rep)) >= NEAR_DUPLICATE_THRESHOLD) {
        matchedKey = candidateKey;
        break;
      }
    }
    if (matchedKey) groups.get(matchedKey)!.push(item);
    else {
      groups.set(key, [item]);
      order.push(key);
    }
  }

  const survivors = new Set<T>();
  for (const key of order) {
    const members = groups.get(key)!;
    let best = members[0];
    for (const m of members) if (betterSurvivor(m, best) < 0) best = m;
    survivors.add(best);
  }

  const kept: T[] = [];
  const dropped: T[] = [];
  for (const item of items) {
    if (survivors.has(item)) kept.push(item);
    else dropped.push(item);
  }
  return { kept, dropped };
}

const ASCII_START = /^[A-Za-z]/;

/**
 * First tracked entity named in the title, or null.
 *
 * ASCII aliases match on word boundaries so `meta` does not fire inside
 * `metadata` and `huang` does not fire inside `shanghai`. Short aliases that
 * are common English words (`eu`) are word-bounded for the same reason.
 */
/**
 * Every tracked entity named in the title, in `STORY_ENTITIES` declaration
 * order (which is priority order — see the module note on Nvidia/Lutnick).
 *
 * `firstStoryEntity` is this function's head, so the matcher exists once. The
 * story ledger needs the whole set, not just the first: its stable id hashes
 * "the entity set at first sighting", so a headline naming 英伟达 and 台积电 must
 * be distinguishable from one naming only 英伟达.
 */
export function storyEntities(title: string): string[] {
  const hay = normalizeTitle(title ?? "").toLowerCase();
  if (!hay) return [];
  const found = new Set<string>();
  for (const entity of STORY_ENTITIES) {
    if (found.has(entity.id)) continue;
    for (const alias of entity.aliases) {
      if (ASCII_START.test(alias)) {
        let from = 0;
        while (from <= hay.length) {
          const idx = hay.indexOf(alias, from);
          if (idx < 0) break;
          const before = hay[idx - 1];
          const after = hay[idx + alias.length];
          const okBefore = before === undefined || !/[a-z0-9]/.test(before);
          const okAfter = after === undefined || !/[a-z0-9]/.test(after);
          if (okBefore && okAfter) {
            found.add(entity.id);
            break;
          }
          from = idx + alias.length;
        }
      } else if (hay.includes(alias.toLowerCase())) {
        found.add(entity.id);
        break;
      }
    }
  }
  return STORY_ENTITIES.filter((e) => found.has(e.id)).map((e) => e.id);
}

export function firstStoryEntity(title: string): string | null {
  return storyEntities(title)[0] ?? null;
}

/**
 * Cluster key for the per-cluster density cap.
 *
 * Precedence, chosen so the cap tightens where floods actually happen:
 *
 *  1. A tracked entity → that entity id. Cross-language by construction, so
 *     `英伟达…` and `Nvidia…` share one budget and the edition-wide cap cannot
 *     be dodged by switching lane.
 *  2. Otherwise the exact story key — enough to stop a wire re-publishing one
 *     headline under trivial edits.
 *
 * Deliberately NOT a fuzzy key for entity-less headlines: clustering unrelated
 * copy by shared vocabulary is how a cap turns into censorship of a beat.
 */
export function storyCluster(title: string): string {
  const raw = title ?? "";
  const hit = clusterCache.get(raw);
  if (hit !== undefined) return hit;
  const entity = firstStoryEntity(raw);
  const key = entity ? `entity:${entity}` : `title:${exactStoryKey(raw)}`;
  return memoPut(clusterCache, raw, key);
}
