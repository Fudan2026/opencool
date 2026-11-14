/**
 * News → practice funnel, shared by every TS-rendered surface.
 *
 * OpenCool informs, SuPro (supro.si) practices. The UTM scheme is the single
 * source of attribution for the sister site, so it lives in one place:
 * `scripts/build-site.mjs` carries an identical copy for the pages it bakes
 * (it runs under plain node, not tsx) — keep the two in lockstep, the golden
 * tests assert both spellings byte-for-byte.
 *
 * `utm_content` names the *entry point*, never the product: each surface the
 * funnel touches passes its own value so supro.si can attribute traffic per
 * surface. Copy stays generic and honest — no performance claims, and every
 * strip carries the paper-simulation disclaimer.
 */

export const SUPRO_UTM =
  "utm_source=opencool&utm_medium=brief&utm_campaign=news_to_practice";

/** The supro.si paths the funnel links to. No invented destinations. */
export const SUPRO_PATHS = {
  home: "/",
  timing: "/timing/broad/",
  signals: "/signals",
  paper: "/paper",
  news: "/news",
} as const;

export type SuproPath = keyof typeof SUPRO_PATHS;

/** Absolute outbound URL for one funnel entry point. */
export function suproUrl(path: SuproPath, content: string): string {
  const p = SUPRO_PATHS[path];
  return `https://supro.si${p}?${SUPRO_UTM}&utm_content=${content}`;
}

/**
 * `target="_blank" rel="noopener"` pair every outbound funnel link carries.
 * Kept as one helper so no surface can ship the attribute pair half-written.
 */
export const SUPRO_LINK_ATTRS = 'target="_blank" rel="noopener"';
