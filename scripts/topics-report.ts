import "./_env";

import fs from "node:fs";
import path from "node:path";

import type { ArticleInput } from "../lib/ai/pipeline";
import { sources } from "../lib/sources/registry";
import { groupBySource } from "../lib/output/render";
import {
  routeEdition,
  editionStats,
  sectionsBelowFloor,
  SECTION_LIMITS,
  CLUSTER_CAP_PER_SECTION,
  CLUSTER_CAP_PER_EDITION,
  SECTION_ORDER,
} from "../lib/topics/routing";
import { exactStoryKey, storyCluster } from "../lib/topics/dedupe";

const OUTPUT_DIR = "daily_reports";

/**
 * Before/after composition report for one baked edition.
 *
 * This is the script that produces the PR body's evidence table, and it is
 * deliberately committed rather than run once in a shell: the claim "no source
 * exceeds 40% of a section" has to be re-checkable by anyone on any edition,
 * including one baked later from different news.
 *
 * `before` reproduces exactly what the shipped panels rendered at `main`:
 * `MERGED_SUBGROUP_LIMITS` / `SOURCE_DISPLAY_LIMITS` applied to the merged
 * subcategories, timestamp-sorted, with no dedupe. `after` is `routeEdition`.
 *
 * Usage:
 *   npm run topics:report -- 2026-11-13 06
 *   npm run topics:report              # latest baked slot
 */

function resolveSlot(date?: string, hour?: string): { date: string; hour: string } {
  if (date && hour) return { date, hour: String(parseInt(hour, 10)).padStart(2, "0") };
  if (!fs.existsSync(OUTPUT_DIR)) throw new Error(`no ${OUTPUT_DIR}/ directory — run npm run daily first`);
  const dates = fs
    .readdirSync(OUTPUT_DIR)
    .filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d))
    .sort();
  const latest = dates[dates.length - 1];
  if (!latest) throw new Error(`no editions in ${OUTPUT_DIR}/`);
  const slots = fs
    .readdirSync(path.join(OUTPUT_DIR, latest))
    .filter((f) => /^\d{2}-articles\.json$/.test(f))
    .map((f) => f.slice(0, 2))
    .sort();
  const h = slots[slots.length - 1];
  if (!h) throw new Error(`no articles sidecars for ${latest}`);
  return { date: latest, hour: h };
}

function loadArticles(date: string, hour: string): ArticleInput[] {
  const file = path.join(OUTPUT_DIR, date, `${hour}-articles.json`);
  if (!fs.existsSync(file)) throw new Error(`sidecar not found: ${file}`);
  const data = JSON.parse(fs.readFileSync(file, "utf8")) as {
    articles: Array<Omit<ArticleInput, "publishedAt"> & { publishedAt?: string }>;
  };
  return data.articles.map((a) => ({
    ...a,
    publishedAt: a.publishedAt ? new Date(a.publishedAt) : undefined,
  }));
}

interface PanelRow {
  panel: string;
  rendered: number;
  topSource: string;
  topCount: number;
  topShare: number;
  maxCluster: number;
  distinctTitles: number;
  totalTitles: number;
}

function pct(n: number, d: number): number {
  return d === 0 ? 0 : n / d;
}

/** What shipped before: merged subgroups, time-sorted, no dedupe, no caps. */
function beforeRows(articles: ArticleInput[]): PanelRow[] {
  const raw = groupBySource(articles, sources);
  const rows: PanelRow[] = [];
  for (const cat of ["finance", "politics", "tech"] as const) {
    for (const sub of raw[cat]) {
      const items = sub.sources.flatMap((s) => s.items);
      if (items.length === 0) continue;
      const bySource = new Map<string, number>();
      for (const i of items) bySource.set(i.sourceId, (bySource.get(i.sourceId) ?? 0) + 1);
      let topSource = "";
      let topCount = 0;
      for (const [id, n] of bySource) {
        if (n > topCount || (n === topCount && id < topSource)) {
          topSource = id;
          topCount = n;
        }
      }
      const byCluster = new Map<string, number>();
      for (const i of items) {
        const k = storyCluster(i.title);
        byCluster.set(k, (byCluster.get(k) ?? 0) + 1);
      }
      let maxCluster = 0;
      for (const n of byCluster.values()) if (n > maxCluster) maxCluster = n;
      rows.push({
        panel: `${cat}:${sub.id}`,
        rendered: items.length,
        topSource,
        topCount,
        topShare: pct(topCount, items.length),
        maxCluster,
        distinctTitles: new Set(items.map((i) => exactStoryKey(i.title))).size,
        totalTitles: items.length,
      });
    }
  }
  return rows;
}

function fmtPct(n: number): string {
  return `${(n * 100).toFixed(0)}%`;
}

function main() {
  const [dateArg, hourArg] = process.argv.slice(2);
  const { date, hour } = resolveSlot(dateArg, hourArg);
  const articles = loadArticles(date, hour);
  const subcategories: Record<string, string | undefined> = {};
  for (const s of sources) subcategories[s.id] = s.subcategory;

  const before = beforeRows(articles);
  const after = routeEdition(articles, subcategories);
  const stats = editionStats(after);

  const beforeTotal = before.reduce((n, r) => n + r.rendered, 0);
  const afterTotal = after.total;
  const dupesSuppressed = after.duplicates;

  const out: string[] = [];
  out.push(`# Topic routing — before / after (${date} ${hour}:00)\n`);
  out.push(
    `${articles.length} fetched → **${beforeTotal}** rendered before (merged panels, no dedupe) → **${afterTotal}** rendered after (topic-routed, capped).\n`,
  );
  out.push(`${dupesSuppressed} duplicate stories suppressed before routing.\n`);

  out.push("## Before — merged panels as shipped on main\n");
  out.push("| panel | items | top source | share | max one story | unique titles |");
  out.push("|---|---:|---|---:|---:|---:|");
  for (const r of before) {
    const dupeNote =
      r.distinctTitles < r.totalTitles ? ` (${r.totalTitles - r.distinctTitles} dup)` : "";
    out.push(
      `| \`${r.panel}\` | ${r.rendered} | ${r.topSource} | ${fmtPct(r.topShare)} | ${r.maxCluster} | ${r.distinctTitles}${dupeNote} |`,
    );
  }

  out.push("\n## After — topic sections, capped\n");
  out.push("| lane | topic | items | pool | top source | share | max one story | within 40%? |");
  out.push("|---|---|---:|---:|---|---:|---:|:--:|");
  for (const s of stats) {
    const limit = SECTION_LIMITS[s.topic];
    const ok = s.rendered >= 3 && s.maxSourceShare <= limit.sourceShare + 1e-9;
    out.push(
      `| ${s.lane} | ${s.topic} | ${s.rendered} | ${s.available} | ${s.maxSourceId || "—"} | ${fmtPct(s.maxSourceShare)} | ${s.maxCluster} | ${ok ? "yes" : "no"} |`,
    );
  }

  const belowFloor = sectionsBelowFloor(after, 3);
  const withheld = after.lanes.flatMap((l) => l.omitted.map((o) => ({ lane: l.lane, ...o })));

  // A single story is the sharpest evidence, because "no source exceeds 40%"
  // can be satisfied while one event still names itself 15 ways. Count the
  // biggest entity cluster edition-wide, before and after.
  out.push("\n## The one-story test\n");
  const rawBefore = groupBySource(articles, sources);
  const beforeByEntity = new Map<string, number>();
  for (const cat of Object.keys(rawBefore) as Array<keyof typeof rawBefore>) {
    for (const sub of rawBefore[cat]) {
      for (const src of sub.sources) {
        for (const item of src.items) {
          const k = storyCluster(item.title);
          if (!k.startsWith("entity:")) continue;
          beforeByEntity.set(k, (beforeByEntity.get(k) ?? 0) + 1);
        }
      }
    }
  }
  const afterByEntity = new Map<string, number>();
  for (const lane of after.lanes) {
    for (const section of lane.sections) {
      for (const item of section.items) {
        const k = storyCluster(item.title);
        if (!k.startsWith("entity:")) continue;
        afterByEntity.set(k, (afterByEntity.get(k) ?? 0) + 1);
      }
    }
  }
  const topBefore = [...beforeByEntity.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3);
  if (topBefore.length === 0) {
    out.push("No tracked entity dominated this edition.\n");
  } else {
    out.push("| story | slots before | slots after | cap |");
    out.push("|---|---:|---:|---:|");
    for (const [entity, n] of topBefore) {
      out.push(
        `| \`${entity}\` | ${n} | ${afterByEntity.get(entity) ?? 0} | ≤${CLUSTER_CAP_PER_EDITION} |`,
      );
    }
    const worst = topBefore[0];
    const afterCount = afterByEntity.get(worst[0]) ?? 0;
    out.push(
      `\nLargest single story: **${worst[0]}** — ${worst[1]} slots before, ${afterCount} after (${worst[1] > 0 ? Math.round((1 - afterCount / worst[1]) * 100) : 0}% fewer).\n`,
    );
  }

  out.push("\n## Guarantees\n");
  const violations = stats.filter(
    (s) => s.rendered >= 3 && s.maxSourceShare > SECTION_LIMITS[s.topic].sourceShare + 1e-9,
  );
  const clusterViolations = stats.filter((s) => s.maxCluster > CLUSTER_CAP_PER_SECTION);
  out.push(
    `- Sections rendered: **${stats.length}** across ${after.lanes.length} lanes, in locked order ${SECTION_ORDER.join(" → ")}.`,
  );
  out.push(
    `- Per-source 40% rule: **${violations.length === 0 ? "holds in every section" : `${violations.length} violation(s)`}**.`,
  );
  out.push(
    `- Per-cluster ≤${CLUSTER_CAP_PER_SECTION}/section: **${clusterViolations.length === 0 ? "holds" : `${clusterViolations.length} violation(s)`}**.`,
  );
  out.push(`- Per-cluster ≤${CLUSTER_CAP_PER_EDITION}/edition: **enforced before sections are kept**.`);
  out.push(`- Sections below three sources (reported, not hidden): **${belowFloor.length}**.`);
  out.push(`- Topics withheld for failing the item floor: **${withheld.length}**.`);
  for (const w of withheld) out.push(`  - ${w.lane}:${w.topic} — pool ${w.available}`);

  const narrative = out.join("\n");
  console.log(narrative);

  const outFile = path.join("logs", `topics-report-${date}-${hour}.md`);
  try {
    fs.mkdirSync("logs", { recursive: true });
    fs.writeFileSync(outFile, narrative + "\n", "utf8");
    console.log(`\n[topics:report] wrote ${outFile}`);
  } catch {
    // stdout is enough when the filesystem is read-only
  }
}

try {
  main();
} catch (e) {
  console.error(`[topics:report] FAILED: ${e instanceof Error ? e.message : e}`);
  process.exit(1);
}
