/**
 * Bake public-side data product daily_reports/keywords.json — rolling
 * 7-day keyword frequency over real edition sidecars. Runs under tsx
 * (build-trails precedent); build-site only READS the JSON for the
 * status.html block. Zero LLM.
 */
import "./_env";

import fs from "node:fs";
import path from "node:path";

import { aggregateKeywords } from "../lib/nlp/keywords";

const ROOT = "daily_reports";
const OUT = path.join(ROOT, "keywords.json");
const WINDOW_DAYS = 7;
const SLOTS = ["06", "13", "19"];

function main() {
  const cutoff = new Date(Date.now() - WINDOW_DAYS * 86_400_000)
    .toISOString()
    .slice(0, 10);
  const editions: Array<{ date: string; hour: string; keywords?: string[] }> = [];
  const days = fs
    .readdirSync(ROOT)
    .filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d) && d >= cutoff)
    .sort();
  for (const d of days) {
    for (const h of SLOTS) {
      const fp = path.join(ROOT, d, `${h}.json`);
      if (!fs.existsSync(fp)) continue;
      try {
        const r = JSON.parse(fs.readFileSync(fp, "utf8"));
        editions.push({ date: d, hour: h, keywords: r?.keywords });
      } catch {
        // unreadable sidecar — skip
      }
    }
  }
  const agg = aggregateKeywords(editions, WINDOW_DAYS);
  fs.writeFileSync(OUT, JSON.stringify(agg, null, 2) + "\n", "utf8");
  console.log(
    `[keywords:bake] wrote ${OUT} editions=${agg.editions} terms=${agg.items.length}`,
  );
}

main();
