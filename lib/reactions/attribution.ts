/**
 * Attribution — deciding which sector a story is measured on.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * Why this is deliberately weak
 * ─────────────────────────────────────────────────────────────────────────
 *
 * The honest answer to "which sector did this headline move" is almost always
 * "we cannot tell, and any single-sector answer would be a story we told
 * ourselves". A story about Nvidia is not a statement about the A-share
 * semiconductor board; a story about the Fed is not a statement about banks.
 * Pretending otherwise produces a backtest that looks strong because the
 * mapping was chosen after seeing the numbers.
 *
 * So attribution is a *declaration*, made before any return is computed, from
 * vocabulary that already existed in the repo for other reasons:
 *
 *   1. `entity` — the story's `entities[]` (from `lib/topics/entities.ts`) maps
 *      to a theme in the curated catalog (`lib/themes/catalog.ts`) through a
 *      table below. Every link is an explicit, reviewable line, and each one
 *      carries the reason it exists. A story whose first mapped entity resolves
 *      to a theme the tape actually quoted is measured on that theme's board.
 *
 *   2. `topic` — no entity mapped, but the story's topic has a defensible
 *      broad board (a `policy` story is measured on nothing; a `tech-ai` story
 *      is measured on the AI concept board). Strictly weaker: `tech-ai` covers
 *      everything from chip export controls to an app launch.
 *
 *   3. `market` — nothing defensible. Measured on 上证指数 (the index), which
 *      answers "did the tape move" rather than "did this sector move". Kept
 *      rather than dropped so the counts are visible, and never used for a
 *      sector-level claim.
 *
 *   4. `null` — not measured at all: no entity, no topic board, or a mapped
 *      board the tape never quoted. Counted as `unmapped`, never silently
 *      dropped.
 *
 * The table is data, not logic, so a reviewer can audit the whole moat in one
 * screen. Links that would be indefensible (e.g. `trump` → 军工) are absent on
 * purpose.
 */

import { loadThemeCatalog, type ThemeDef } from "../themes/catalog";
import type { AttributedStory } from "./types";

export interface EntityThemeLink {
  /** Entity id from `STORY_ENTITIES`. */
  entity: string;
  /** Theme key from the theme catalog. */
  theme: string;
  /** Why this link is defensible in one line. */
  reason: string;
}

/**
 * The entity → theme table.
 *
 * Rule applied to every row: the entity must be an A-share *sector driver* —
 * i.e. a company or institution whose news routinely reprices a listed board
 * in Shanghai/Shenzhen, not merely a global topic. That is why the consumer
 * names (apple, tesla, byd, catl) are here — their supply chains are A-share
 * boards — while `trump`, `putin`, `israel` and the other pure geopolitics
 * entities have no row: their effect, if any, is diffuse and not attributable
 * to one board.
 */
export const ENTITY_THEME_LINKS: readonly EntityThemeLink[] = [
  { entity: "nvidia", theme: "ai-compute", reason: "Nvidia orders/data-centre demand read straight through to A-share compute" },
  { entity: "openai", theme: "ai", reason: "OpenAI releases reprice the AI application theme" },
  { entity: "anthropic", theme: "ai", reason: "Frontier model releases reprice the AI application theme" },
  { entity: "deepseek", theme: "ai", reason: "Domestic frontier model releases reprice the AI theme" },
  { entity: "microsoft", theme: "ai-compute", reason: "Azure capex guidance is a compute-demand signal" },
  { entity: "alphabet", theme: "ai-compute", reason: "Google capex guidance is a compute-demand signal" },
  { entity: "amazon", theme: "ai-compute", reason: "AWS capex guidance is a compute-demand signal" },
  { entity: "meta", theme: "ai-compute", reason: "Meta capex guidance is a compute-demand signal" },
  { entity: "tsmc", theme: "semiconductor", reason: "TSMC is the foundry read-through for the A-share chip board" },
  { entity: "smic", theme: "semiconductor", reason: "SMIC is the domestic foundry and an A-share constituent" },
  { entity: "samsung", theme: "semiconductor", reason: "Memory pricing drives the A-share component board" },
  { entity: "huawei", theme: "semiconductor", reason: "Huawei supply-chain news reprices the domestic chip board" },
  { entity: "apple", theme: "consumer-elec", reason: "Apple orders drive the A-share Apple supply chain" },
  { entity: "xiaomi", theme: "consumer-elec", reason: "Xiaomi is a listed consumer-electronics bellwether" },
  { entity: "tesla", theme: "ev", reason: "Tesla pricing/volume reprices the A-share EV chain" },
  { entity: "byd", theme: "ev", reason: "BYD is the largest listed A-share EV maker" },
  { entity: "catl", theme: "ev", reason: "CATL is the largest listed A-share battery maker" },
  { entity: "alibaba", theme: "ai", reason: "Alibaba cloud/AI capex reprices the domestic AI theme" },
  { entity: "tencent", theme: "gaming", reason: "Tencent is the domestic gaming bellwether" },
  { entity: "baidu", theme: "ai", reason: "Baidu's model releases reprice the domestic AI theme" },
  { entity: "bitcoin", theme: "comms", reason: "Crypto-mining demand reads through to A-share compute/comms hardware" },
  { entity: "gold", theme: "metals", reason: "Gold price moves are the 贵金属 board's own driver" },
  { entity: "oil", theme: "oil", reason: "Crude price moves are the 油气开采 board's own driver" },
  { entity: "opec", theme: "oil", reason: "OPEC supply decisions are the oil board's own driver" },
  { entity: "pboc", theme: "bank", reason: "PBOC policy is the direct driver of the bank board" },
  { entity: "fed", theme: "metals", reason: "Fed policy reprices gold, the 贵金属 board's driver" },
];

/**
 * Topic → theme, used only when no entity mapped.
 *
 * Deliberately sparse. `world`, `policy`, `opinion` and `filings` have no row:
 * a filing story is about one issuer, a policy story is about a rule, and
 * neither is a sector bet. Only `tech-ai` and `global-markets` get a broad
 * board, and both are labelled weaker in `attributionReason`.
 */
export const TOPIC_THEME_LINKS: readonly { topic: string; theme: string; reason: string }[] = [
  { topic: "tech-ai", theme: "ai", reason: "tech-ai topic → AI concept board (broad; topic alone, no entity)" },
];

/** Index used for `attribution: "market"`. 上证指数 is the tape's market proxy. */
export const MARKET_INDEX_CODE = "000001";

export interface AttributionContext {
  /** Theme key → resolved concept board, from the tape. */
  themeBoards: Map<string, { code: string; name: string }>;
  /** True when the tape quoted this index code, so a market fallback is measurable. */
  hasIndex?: (code: string) => boolean;
  /** Themes in the catalog, for display names. */
  themes?: readonly ThemeDef[];
}

const linkByEntity = new Map(ENTITY_THEME_LINKS.map((l) => [l.entity, l]));
const linkByTopic = new Map(TOPIC_THEME_LINKS.map((l) => [l.topic, l]));

/**
 * Resolve one story to the thing it is measured on.
 *
 * `target` is the tape series key (`board:BK0800` / `index:000001`), so the
 * measurement layer never has to guess what a target means.
 */
export function attributeStory(
  story: { id: string; firstSeenAt: string; firstEdition: string; topic: string; entities?: readonly string[] },
  ctx: AttributionContext,
): AttributedStory {
  const base = {
    id: story.id,
    firstSeenAt: story.firstSeenAt,
    firstEdition: story.firstEdition,
    topic: story.topic,
  };

  const themes = ctx.themes ?? loadThemeCatalog();
  const themeName = (key: string) => themes.find((t) => t.key === key)?.name ?? key;

  // 1. Entity, in the story's own declared order (which is priority order in
  //    the entity table), first link whose board the tape quoted.
  for (const entity of story.entities ?? []) {
    const link = linkByEntity.get(entity);
    if (!link) continue;
    const board = ctx.themeBoards.get(link.theme);
    if (!board) continue;
    return {
      ...base,
      target: `board:${board.code}`,
      targetLabel: board.name,
      attribution: "entity",
      entity,
      attributionReason: `${entity} → ${themeName(link.theme)} (${link.theme}): ${link.reason}`,
    };
  }

  // 2. Topic, only when it has a declared broad board and the tape quoted it.
  const topicLink = linkByTopic.get(story.topic);
  if (topicLink) {
    const board = ctx.themeBoards.get(topicLink.theme);
    if (board) {
      return {
        ...base,
        target: `board:${board.code}`,
        targetLabel: board.name,
        attribution: "topic",
        entity: null,
        attributionReason: topicLink.reason,
      };
    }
  }

  // 3. Market fallback: measured, but only asserts that the tape moved.
  if (ctx.hasIndex && !ctx.hasIndex(MARKET_INDEX_CODE)) {
    return {
      ...base,
      target: null,
      targetLabel: null,
      attribution: null,
      entity: null,
      attributionReason:
        "no entity or topic maps to a quoted sector board, and the tape has no 上证指数 quote to fall back on — counted as unmapped, not dropped",
    };
  }
  return {
    ...base,
    target: `index:${MARKET_INDEX_CODE}`,
    targetLabel: "上证指数",
    attribution: "market",
    entity: null,
    attributionReason:
      "no entity or topic maps to a sector board — measured on 上证指数, which answers 'did the tape move', not 'did this sector move'",
  };
}

/** True when the story could not be measured on anything at all. */
export function isUnmapped(story: AttributedStory): boolean {
  return story.attribution === null;
}
