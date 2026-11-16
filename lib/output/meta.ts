/**
 * Structured discovery helpers — the search/social half of the publish.
 *
 * Every generated public page carries og:/twitter: card meta, and JSON-LD
 * where a fitting schema exists (NewsArticle per edition, WebSite on the
 * home page, CollectionPage on the archive). All of it is baked statically
 * at build time; nothing here touches the network or a clock beyond the
 * report timezone.
 *
 * Dates: the edition sidecar's dual clocks are ISO 8601 with an explicit
 * offset, and so are the dates published here. The offset always comes from
 * `REPORT_TZ` via `lib/stories/time.ts` — no hardcoded Asia/Shanghai.
 *
 * `scripts/build-site.mjs` carries a plain-JS mirror of the tag builders for
 * the pages node bakes (it runs under node, not tsx). Keep the two in
 * lockstep: the golden tests assert the shapes of both.
 */

import { REPORT_LOCALE } from "../sources/registry";
import { getReportTz } from "../utils";
import { isoWithOffset, offsetMinutes } from "../stories/time";

/** Canonical public base URL of the GitHub Pages site. */
export const SITE_URL = "https://fudan2026.github.io/opencool";

/** og:locale for the active report locale. */
export function ogLocale(): "zh_CN" | "en_US" {
  return REPORT_LOCALE === "en" ? "en_US" : "zh_CN";
}

/**
 * The slot instant of an edition as ISO 8601 with the REPORT_TZ offset,
 * e.g. `2026-11-14T06:00:00+08:00`. The date key and hour are wall-clock
 * values in the report timezone already, so only the offset needs deriving —
 * and it is derived from `REPORT_TZ` at that instant, never assumed.
 */
export function slotInstantIso(date: string, hour: string): string {
  const probe = new Date(`${date}T${hour}:00:00Z`);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !/^\d{2}$/.test(hour) || Number.isNaN(probe.getTime())) {
    return "";
  }
  const off = offsetMinutes(probe, getReportTz());
  const sign = off < 0 ? "-" : "+";
  const abs = Math.abs(off);
  const hh = String(Math.floor(abs / 60)).padStart(2, "0");
  const mm = String(abs % 60).padStart(2, "0");
  return `${date}T${hour}:00:00${sign}${hh}:${mm}`;
}

/** The render instant in the report timezone — `dateModified` for an edition. */
export function buildInstantIso(): string {
  return isoWithOffset(new Date(), getReportTz());
}

function escapeAttr(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

export interface SocialMeta {
  title: string;
  description: string;
  /** Absolute URL of the page. */
  url: string;
  type?: "website" | "article";
  /** `article:published_time` when type is article. */
  publishedIso?: string;
  /** `article:modified_time`. */
  modifiedIso?: string;
}

/** og: + twitter: card meta block for one page. */
export function socialMetaTags(m: SocialMeta): string {
  const type = m.type ?? "website";
  const published = m.type === "article" && m.publishedIso ? `\n<meta property="article:published_time" content="${escapeAttr(m.publishedIso)}">` : "";
  const modified = m.modifiedIso ? `\n<meta property="article:modified_time" content="${escapeAttr(m.modifiedIso)}">` : "";
  return `<meta name="description" content="${escapeAttr(m.description)}">
<meta property="og:title" content="${escapeAttr(m.title)}">
<meta property="og:description" content="${escapeAttr(m.description)}">
<meta property="og:type" content="${type}">
<meta property="og:url" content="${escapeAttr(m.url)}">
<meta property="og:site_name" content="OpenCool">
<meta property="og:locale" content="${ogLocale()}">${published}${modified}
<meta name="twitter:card" content="summary">
<meta name="twitter:title" content="${escapeAttr(m.title)}">
<meta name="twitter:description" content="${escapeAttr(m.description)}">`;
}

/** One JSON-LD script block. */
export function jsonLdScript(obj: unknown): string {
  return `<script type="application/ld+json">${JSON.stringify(obj, null, 2)}</script>`;
}

export interface NewsArticleLd {
  headline: string;
  description: string;
  url: string;
  datePublishedIso: string;
  dateModifiedIso: string;
  image?: string;
}

/** NewsArticle for one edition page. Dates are ISO 8601 with the REPORT_TZ offset. */
export function newsArticleLd(a: NewsArticleLd): Record<string, unknown> {
  return {
    "@context": "https://schema.org",
    "@type": "NewsArticle",
    headline: a.headline,
    description: a.description,
    mainEntityOfPage: { "@type": "WebPage", "@id": a.url },
    datePublished: a.datePublishedIso,
    dateModified: a.dateModifiedIso,
    ...(a.image ? { image: [a.image] } : {}),
    inLanguage: REPORT_LOCALE === "en" ? "en" : "zh-CN",
    isAccessibleForFree: true,
    publisher: {
      "@type": "Organization",
      name: "OpenCool",
      url: `${SITE_URL}/`,
    },
  };
}

/** WebSite for the home page. */
export function webSiteLd(): Record<string, unknown> {
  return {
    "@context": "https://schema.org",
    "@type": "WebSite",
    name: "OpenCool",
    url: `${SITE_URL}/`,
    inLanguage: REPORT_LOCALE === "en" ? "en" : "zh-CN",
  };
}

/** WebPage for a data/reading surface. */
export function webPageLd(name: string, url: string, description: string): Record<string, unknown> {
  return {
    "@context": "https://schema.org",
    "@type": "WebPage",
    name,
    url,
    description,
    isAccessibleForFree: true,
  };
}

/** CollectionPage for the archive / story-thread listings. */
export function collectionPageLd(
  name: string,
  url: string,
  description: string,
): Record<string, unknown> {
  return {
    "@context": "https://schema.org",
    "@type": "CollectionPage",
    name,
    url,
    description,
    isAccessibleForFree: true,
  };
}
