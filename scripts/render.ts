import "./_env";

import fs from "node:fs";
import path from "node:path";

import type { ArticleInput, DailyReport } from "../lib/ai/pipeline";
import { groupRaw, renderHtml, renderMarkdown } from "../lib/output/render";
import { sources } from "../lib/sources/registry";
import { todayKey, editionHourKey, parseReportHours } from "../lib/utils";

const OUTPUT_DIR = "daily_reports";

/**
 * Re-render HTML from cached sidecar for a date + edition hour.
 *
 * Usage:
 *   npm run render
 *   npm run render -- 2026-09-15
 *   npm run render -- 2026-09-15 13
 */
function resolveHour(date: string, hourArg?: string): string {
  if (hourArg) return String(parseInt(hourArg, 10)).padStart(2, "0");
  const dir = path.join(OUTPUT_DIR, date);
  if (fs.existsSync(dir)) {
    const slots = fs
      .readdirSync(dir)
      .filter((f) => /^\d{2}\.json$/.test(f))
      .map((f) => f.slice(0, 2))
      .sort((a, b) => b.localeCompare(a));
    if (slots.length) return slots[0];
  }
  return editionHourKey();
}

function loadReport(date: string, hour: string): DailyReport {
  const slotFile = path.join(OUTPUT_DIR, date, `${hour}.json`);
  const legacy = path.join(OUTPUT_DIR, date, `${date}.json`);
  const file = fs.existsSync(slotFile) ? slotFile : legacy;
  if (!fs.existsSync(file)) {
    throw new Error(`Report JSON not found: ${slotFile}`);
  }
  return JSON.parse(fs.readFileSync(file, "utf8")) as DailyReport;
}

function loadArticles(date: string, hour: string): ArticleInput[] {
  const slotFile = path.join(OUTPUT_DIR, date, `${hour}-articles.json`);
  const legacy = path.join(OUTPUT_DIR, date, `${date}-articles.json`);
  const file = fs.existsSync(slotFile) ? slotFile : legacy;
  if (!fs.existsSync(file)) {
    throw new Error(
      `Articles sidecar not found: ${slotFile}\n` +
        `Run \`npm run daily\` for ${date} first.`,
    );
  }
  const data = JSON.parse(fs.readFileSync(file, "utf8")) as {
    articles: Array<
      Omit<ArticleInput, "publishedAt"> & { publishedAt?: string }
    >;
  };
  return data.articles.map((a) => ({
    ...a,
    publishedAt: a.publishedAt ? new Date(a.publishedAt) : undefined,
  }));
}

async function main() {
  const date = process.argv[2] || todayKey();
  const hour = resolveHour(date, process.argv[3]);
  const siblingHours = parseReportHours().map((h) => String(h).padStart(2, "0"));
  console.log(`[render] re-rendering ${date}/${hour} from cached data…`);

  const report = loadReport(date, hour);
  const articles = loadArticles(date, hour);
  console.log(`[render] loaded ${articles.length} articles + report`);

  const raw = groupRaw(articles, sources);
  const dateDir = path.join(OUTPUT_DIR, date);
  fs.mkdirSync(dateDir, { recursive: true });
  const base = path.join(dateDir, hour);
  fs.writeFileSync(
    `${base}.html`,
    renderHtml(report, raw, date, { editionHour: hour, siblingHours }),
    "utf8",
  );
  if (process.env.OUTPUT_MARKDOWN === "true") {
    fs.writeFileSync(`${base}.md`, renderMarkdown(report, date), "utf8");
    console.log(`[render] wrote ${base}.{html,md}`);
  } else {
    console.log(`[render] wrote ${base}.html`);
  }
}

main().catch((e) => {
  console.error("[render] FAILED:", e instanceof Error ? e.message : e);
  process.exit(1);
});
