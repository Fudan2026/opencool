/**
 * Bake daily_reports/search-index.json — inverted index over every real
 * edition sidecar (hero + briefs + keywords), chronological, newest last.
 * Fail-open like the other bakes; hard budget 2MB (drops oldest editions
 * until the serialized payload fits). Zero LLM.
 */
import "./_env";

import fs from "node:fs";
import path from "node:path";

import {
  buildIndex,
  SEARCH_BUDGET_BYTES,
  type SearchEditionInput,
} from "../lib/search/engine";

const ROOT = "daily_reports";
const OUT = path.join(ROOT, "search-index.json");
const SLOTS = ["06", "13", "19"];
const SUMMARY_CLIP = 160;

function collect(): SearchEditionInput[] {
  const out: SearchEditionInput[] = [];
  const days = fs
    .readdirSync(ROOT)
    .filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d))
    .sort();
  for (const d of days) {
    for (const h of SLOTS) {
      const fp = path.join(ROOT, d, `${h}.json`);
      if (!fs.existsSync(fp)) continue;
      try {
        const r = JSON.parse(fs.readFileSync(fp, "utf8"));
        const briefs = [
          ...(r?.finance_briefs ?? []),
          ...(r?.tech_briefs ?? []),
          ...(r?.politics_briefs ?? []),
        ];
        const texts = briefs
          .map((b: { title?: string; summary?: string }) =>
            `${b.title ?? ""} ${b.summary ?? ""}`.slice(0, SUMMARY_CLIP),
          )
          .filter((x: string) => x.trim().length > 0);
        out.push({
          date: d,
          hour: h,
          hero: String(r?.hero_headline ?? `${d} ${h}`),
          texts,
          keywords: r?.keywords ?? [],
        });
      } catch {
        // unreadable sidecar — skip
      }
    }
  }
  return out;
}

function main() {
  const editions = collect();
  // Newest-first window; grow from the minimum until under budget.
  let maxDocs = editions.length;
  let payload: string;
  for (;;) {
    const index = buildIndex(editions, { maxDocs });
    payload = JSON.stringify(index);
    if (
      Buffer.byteLength(payload, "utf8") <= SEARCH_BUDGET_BYTES ||
      maxDocs <= 30
    ) {
      break;
    }
    maxDocs = Math.floor(maxDocs * 0.8);
  }
  fs.writeFileSync(OUT, payload + "\n", "utf8");
  const bytes = Buffer.byteLength(payload, "utf8");
  const docs = JSON.parse(payload).docs.length;
  console.log(
    `[search:bake] wrote ${OUT} docs=${docs}/${editions.length} bytes=${(bytes / 1024).toFixed(0)}KB budget=${(SEARCH_BUDGET_BYTES / 1048576).toFixed(0)}MB`,
  );
}

main();
