/**
 * Bake daily_reports/periods.json — trend intelligence: WoW (6 Monday-
 * based weeks) and MoM (3 calendar months) buckets of sentiment, theme
 * hits and index moves, with deltaVsPrev chains. Pure arithmetic over
 * the restored sidecar tree; zero network, zero LLM. Fail-open; gate:
 * ≥2 week-buckets with ≥3 editions total, else skip.
 */
import "./_env";

import fs from "node:fs";
import path from "node:path";

import {
  bucketByIsoWeek,
  bucketByMonth,
  deltaChain,
  type PeriodEdition,
} from "../lib/periods/periods";

const ROOT = "daily_reports";
const OUT = path.join(ROOT, "periods.json");
const SLOTS = ["06", "13", "19"];
const MAX_WEEKS = 6;
const MAX_MONTHS = 3;
const MIN_EDITIONS = 3;

function collect(): PeriodEdition[] {
  const out: PeriodEdition[] = [];
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
        const idx = r?.quant?.market?.indices;
        out.push({
          date: d,
          score: typeof r?.sentiment?.score === "number" ? r.sentiment.score : null,
          pos: Number(r?.sentiment?.posHits) || 0,
          neg: Number(r?.sentiment?.negHits) || 0,
          themes: (r?.themes ?? []).map((x: { name: string; articleHits: number }) => ({
            name: x.name,
            hits: x.articleHits,
          })),
          idxPct:
            Array.isArray(idx) && idx.length
              ? idx.reduce((a: number, b: { changePct: number }) => a + b.changePct, 0) / idx.length
              : null,
        });
      } catch {
        // unreadable sidecar — skip
      }
    }
  }
  return out;
}

function main() {
  const all = collect();
  const weeks = deltaChain(bucketByIsoWeek(all)).slice(-MAX_WEEKS);
  const months = deltaChain(bucketByMonth(all)).slice(-MAX_MONTHS);
  const totalEditions = weeks.reduce((a, b) => a + b.editions, 0);

  if (weeks.length < 2 || totalEditions < MIN_EDITIONS) {
    console.log(
      `[periods:bake] insufficient history (weeks=${weeks.length}, editions=${totalEditions}) — skip, previous periods.json kept`,
    );
    return;
  }

  const payload = {
    version: 1,
    generatedAt: new Date().toISOString(),
    source: "bake-periods",
    editions: totalEditions,
    weeks,
    months,
    note: "Zero AI · pure arithmetic · not investment advice",
  };
  fs.writeFileSync(OUT, JSON.stringify(payload, null, 2) + "\n", "utf8");
  console.log(
    `[periods:bake] wrote ${OUT} weeks=${weeks.length} months=${months.length} editions=${totalEditions}`,
  );
}

main();
