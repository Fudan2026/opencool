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
 * stories look different), then Jaccard similarity over shared title tokens at
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
 * Both are pure functions of the article list: no clocks, no randomness, no I/O.
 */

import { normalizeTitleForMatch, tokenizeTitle, jaccard } from "../nlp/tokenize-title";
import { normalizeTitle } from "./classify";
import { STORY_ENTITIES } from "./entities";

/** Titles at or above this token overlap are treated as the same story. */
export const NEAR_DUPLICATE_THRESHOLD = 0.6;

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
  return normalizeTitleForMatch(normalizeTitle(title ?? ""));
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
  const tokenCache = new Map<T, Set<string>>();

  const tokensOf = (item: T): Set<string> => {
    let t = tokenCache.get(item);
    if (t === undefined) {
      t = tokenizeTitle(normalizeTitle(item.title ?? ""));
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
    const tokens = tokensOf(item);
    for (const candidateKey of order) {
      const rep = groups.get(candidateKey)![0];
      if (jaccard(tokens, tokensOf(rep)) >= NEAR_DUPLICATE_THRESHOLD) {
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
export function firstStoryEntity(title: string): string | null {
  const hay = normalizeTitle(title ?? "").toLowerCase();
  if (!hay) return null;
  for (const entity of STORY_ENTITIES) {
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
          if (okBefore && okAfter) return entity.id;
          from = idx + alias.length;
        }
      } else if (hay.includes(alias.toLowerCase())) {
        return entity.id;
      }
    }
  }
  return null;
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
  const entity = firstStoryEntity(title);
  if (entity) return `entity:${entity}`;
  return `title:${exactStoryKey(title)}`;
}
