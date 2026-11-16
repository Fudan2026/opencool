/**
 * Bake `/feed/<theme>.xml` — one RSS 2.0 channel per theme in `themes.json`.
 *
 * A reader who only cares about 半导体 or 黄金 can subscribe to that theme
 * alone instead of the full triple brief. An edition enters a theme's channel
 * when any of the theme's catalog aliases matches that edition's briefs —
 * the same substring semantics `themeArticleHits` uses for `articleHits`,
 * applied across the archive's real sidecars (newest 30, mirroring feed.xml).
 *
 * Every item link carries the shared funnel UTM with a theme-specific
 * `utm_content=rss-<key>`, so the sister site can attribute traffic per
 * channel — the same one-value-per-entry-point contract every other surface
 * follows.
 *
 * Zero LLM, zero network: reads only files under the published tree.
 * Presence rule: no `themes.json` → no feeds, exit 0 — build-site strips the
 * references, nothing 404s.
 */
import "./_env";

import fs from "node:fs";
import path from "node:path";

import { loadThemeCatalog, themeArticleHits, type ThemeDef } from "../lib/themes/catalog";
import { SUPRO_UTM } from "../lib/output/supro";
import { SITE_URL, slotInstantIso } from "../lib/output/meta";
import { STRINGS } from "../lib/output/render";
import { REPORT_LOCALE } from "../lib/sources/registry";

const ROOT = process.env.REPORTS_DIR?.trim() || "daily_reports";
const THEMES = path.join(ROOT, "themes.json");
const OUT_DIR = path.join(ROOT, "feed");
/** Same cap as the main feed.xml: newest 30 real editions per channel. */
const ITEMS_CAP = 30;

function xmlEsc(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

interface EditionTexts {
  date: string;
  hour: string;
  /** True when at least one alias of the theme matched this edition. */
  hits: (theme: ThemeDef) => boolean;
}

function editionLabel(hour: string): string {
  const S = STRINGS;
  if (hour === "06") return S.editionMorning;
  if (hour === "13") return S.editionNoon;
  if (hour === "19") return S.editionEvening;
  return S.editionGeneric;
}

/** Real edition sidecars, newest first. Placeholders have no sidecar, so they cannot leak. */
function collectEditions(): EditionTexts[] {
  const out: Array<{ date: string; hour: string; texts: string[] }> = [];
  if (!fs.existsSync(ROOT)) return [];
  const days = fs
    .readdirSync(ROOT)
    .filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d))
    .sort()
    .reverse();
  for (const d of days) {
    const dir = path.join(ROOT, d);
    if (!fs.statSync(dir).isDirectory()) continue;
    for (const f of fs.readdirSync(dir).filter((x) => /^\d{2}\.json$/.test(x)).sort().reverse()) {
      try {
        const r = JSON.parse(fs.readFileSync(path.join(dir, f), "utf8"));
        const briefs = [
          ...(r?.finance_briefs ?? []),
          ...(r?.tech_briefs ?? []),
          ...(r?.politics_briefs ?? []),
        ];
        const texts = briefs
          .map((b: { title?: string; summary?: string }) => `${b.title ?? ""} ${b.summary ?? ""}`)
          .filter((x: string) => x.trim().length > 0);
        out.push({ date: d, hour: f.replace(/\.json$/, ""), texts });
      } catch {
        /* unreadable sidecar — never include an edition we cannot see */
      }
    }
  }
  return out.slice(0, ITEMS_CAP).map((e) => ({
    date: e.date,
    hour: e.hour,
    hits: (theme) => themeArticleHits(e.texts, theme).hits > 0,
  }));
}

function feedXml(key: string, name: string, editions: EditionTexts[]): string {
  const items = editions
    .map((e) => {
      const base = `${SITE_URL}/${e.date}/${e.hour}.html`;
      const link = `${base}?${SUPRO_UTM}&utm_content=rss-${key}`;
      const pubIso = slotInstantIso(e.date, e.hour);
      const pubDate = pubIso
        ? new Date(pubIso).toUTCString()
        : new Date(`${e.date}T00:00:00Z`).toUTCString();
      return `    <item>
      <title>${xmlEsc(`${STRINGS.siteTitle} ${editionLabel(e.hour)} · ${e.date} ${e.hour}:00`)}</title>
      <link>${xmlEsc(link)}</link>
      <guid isPermaLink="true">${xmlEsc(base)}</guid>
      <pubDate>${pubDate}</pubDate>
    </item>`;
    })
    .join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0">
  <channel>
    <title>${xmlEsc(`${name} · ${STRINGS.siteTitle}`)}</title>
    <link>${SITE_URL}/</link>
    <description>${xmlEsc(`${name} · ${STRINGS.siteTagline}`)}</description>
    <lastBuildDate>${new Date().toUTCString()}</lastBuildDate>
    <language>${REPORT_LOCALE === "en" ? "en" : "zh-CN"}</language>
${items}
  </channel>
</rss>
`;
}

function main(): void {
  if (!fs.existsSync(THEMES)) {
    console.log("[feeds:bake] themes.json not present — no feeds baked (references stay stripped)");
    return;
  }
  let themes: Array<{ key: string; name: string }> = [];
  try {
    const parsed = JSON.parse(fs.readFileSync(THEMES, "utf8"));
    themes = (parsed?.themes ?? []).filter(
      (t: { key?: unknown; name?: unknown }) => typeof t?.key === "string" && typeof t?.name === "string",
    );
  } catch (e) {
    console.warn(
      `[feeds:bake] themes.json unreadable — no feeds baked: ${e instanceof Error ? e.message : String(e)}`,
    );
    return;
  }
  if (!themes.length) {
    console.log("[feeds:bake] themes.json carries no themes — no feeds baked");
    return;
  }

  const catalog = new Map(loadThemeCatalog().map((t) => [t.key, t]));
  const editions = collectEditions();

  fs.mkdirSync(OUT_DIR, { recursive: true });
  let withItems = 0;
  let itemTotal = 0;
  for (const t of themes) {
    const theme = catalog.get(t.key);
    if (!theme) {
      // Every theme in themes.json should exist in the catalog (the same
      // custom file feeds both); a miss means the channel would be
      // permanently empty, so it is named rather than silently shipped.
      console.warn(`[feeds:bake] theme ${t.key} has no catalog entry (no aliases) — channel stays empty`);
    }
    const matched = theme ? editions.filter((e) => e.hits(theme)) : [];
    itemTotal += matched.length;
    if (matched.length) withItems++;
    const file = path.join(OUT_DIR, `${t.key}.xml`);
    fs.writeFileSync(file, feedXml(t.key, t.name, matched), "utf8");
  }
  console.log(
    `[feeds:bake] wrote ${themes.length} channel(s) to ${OUT_DIR} — ` +
      `${withItems} with items, ${itemTotal} item(s) across ${editions.length} scanned edition(s)`,
  );
}

main();
