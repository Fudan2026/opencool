/**
 * Assert `daily_reports/reactions.json` is publishable and honest.
 *
 * The failure this exists to prevent is the one that already happened twice in
 * this repo (theme boards `boards=0`, a ledger stamped in the runner's clock):
 * a bake that produces a *valid-looking* file describing nothing, under a green
 * run. `reactions.json` is the artifact whose whole value is that its numbers
 * can be trusted, so the rules that make it trustworthy are checked here rather
 * than trusted to the producer:
 *
 *   1. the file exists, parses, and declares which metric is the headline;
 *   2. no aggregate publishes a mean/median/percentile below the sample floor;
 *   3. every aggregate row carries `n`;
 *   4. a `pending` horizon carries no return, and an `ok` horizon carries one;
 *   5. `marketExcessPct` is only present when a cross-section backed it.
 *
 * Deliberately NOT asserted: that any sample exists. Tape history starts at the
 * first real session, so the day-one file is legitimately all `insufficient`,
 * and failing on that would block the file that must exist to be readable.
 *
 * Exit 0 = publishable. Exit 1 = do not publish.
 */
import fs from "node:fs";

const FILE = process.argv[2] ?? "daily_reports/reactions.json";
const MIN_SAMPLE_DEFAULT = 20;

function fail(message) {
  console.error(`::error::reactions.json ${message}`);
  process.exit(1);
}

if (!fs.existsSync(FILE)) fail(`is missing (${FILE})`);

let payload;
try {
  payload = JSON.parse(fs.readFileSync(FILE, "utf8"));
} catch (e) {
  fail(`is not valid JSON: ${e instanceof Error ? e.message : String(e)}`);
}

if (!payload || typeof payload !== "object") fail("is not a JSON object");

const problems = [];

if (typeof payload.headlineMetric !== "string" || !payload.headlineMetric) {
  problems.push("headlineMetric must name the headline number");
}
if (typeof payload.headlineReason !== "string" || payload.headlineReason.length < 20) {
  problems.push("headlineReason must explain the choice");
}
if (!payload.method || typeof payload.method !== "object") {
  problems.push("method must document the arithmetic");
}
if (!payload.tape || typeof payload.tape.days !== "number") {
  problems.push("tape summary is missing");
}
if (!payload.ledger || typeof payload.ledger.capBinding !== "boolean") {
  problems.push("ledger summary must say whether the story cap is binding");
}

const minSample =
  typeof payload.method?.minSample === "number" ? payload.method.minSample : MIN_SAMPLE_DEFAULT;

const rows = [
  ...(Array.isArray(payload.aggregates?.byTopic) ? payload.aggregates.byTopic : []),
  ...(Array.isArray(payload.aggregates?.byEntity) ? payload.aggregates.byEntity : []),
];

for (const row of rows) {
  const where = `aggregate ${JSON.stringify(row.key)}`;
  if (typeof row.n === "undefined") {
    // `n` lives per horizon on an aggregate row; a row without any horizon is
    // the real defect.
    if (!row.horizons) problems.push(`${where}: no horizons and no n`);
  }
  for (const [horizon, d] of Object.entries(row.horizons ?? {})) {
    if (!d || typeof d !== "object") {
      problems.push(`${where} ${horizon}: not an object`);
      continue;
    }
    if (typeof d.n !== "number") {
      problems.push(`${where} ${horizon}: every row must publish n`);
      continue;
    }
    const hasDistribution =
      d.mean !== undefined || d.median !== undefined || d.p25 !== undefined || d.p75 !== undefined;
    if (d.status === "insufficient" && hasDistribution) {
      problems.push(`${where} ${horizon}: status insufficient but a distribution was published (n=${d.n})`);
    }
    if (d.status === "ok" && d.n < minSample) {
      problems.push(`${where} ${horizon}: status ok at n=${d.n} < minSample=${minSample}`);
    }
    if (d.status === "ok" && d.mean === undefined) {
      problems.push(`${where} ${horizon}: status ok without a mean`);
    }
  }
}

for (const story of Array.isArray(payload.observations) ? payload.observations : []) {
  for (const [horizon, sample] of Object.entries(story.horizons ?? {})) {
    if (!sample || typeof sample !== "object") continue;
    const where = `story ${story.id} ${horizon}`;
    if (sample.status === "pending") {
      if (sample.rawReturnPct !== undefined || sample.marketExcessPct !== undefined) {
        problems.push(`${where}: pending horizon carries a return (lookahead)`);
      }
    }
    if (sample.status === "ok") {
      if (typeof sample.rawReturnPct !== "number") problems.push(`${where}: ok without rawReturnPct`);
      if (typeof sample.entry?.ms !== "number" || typeof sample.exit?.ms !== "number") {
        problems.push(`${where}: ok without entry/exit instants`);
      }
    }
    if (typeof sample.marketExcessPct === "number") {
      if (typeof sample.marketUniverse !== "number") {
        problems.push(`${where}: marketExcessPct without a marketUniverse`);
      } else if (sample.marketUniverse < (payload.method?.minCrossSection ?? 50)) {
        problems.push(
          `${where}: marketExcessPct from a ${sample.marketUniverse}-board cross-section (below the floor)`,
        );
      }
      if (typeof sample.marketMeanPct !== "number") {
        problems.push(`${where}: marketExcessPct without the market mean it was subtracted from`);
      }
    }
    if (typeof sample.entry?.ms === "number" && typeof story.firstSeenAt === "string") {
      const seen = Date.parse(story.firstSeenAt);
      if (Number.isFinite(seen) && sample.entry.ms < seen) {
        problems.push(`${where}: entry predates firstSeenAt (lookahead)`);
      }
    }
  }
}

if (problems.length) {
  for (const p of problems.slice(0, 25)) console.error(`::error::reactions.json ${p}`);
  if (problems.length > 25) console.error(`::error::…and ${problems.length - 25} more`);
  console.error(`[reactions] ${problems.length} problem(s) — refusing to publish`);
  process.exit(1);
}

const c = payload.counts ?? {};
const h = c.horizons ?? {};
console.log(
  `[reactions] ok headline=${payload.headlineMetric} stories=${c.stories} ` +
    `tapeDays=${payload.tape?.days} rows=${rows.length} ` +
    `horizons=${Object.entries(h)
      .map(([k, v]) => `${k}:ok${v.ok}/pend${v.pending}`)
      .join(",")} gaps=${(payload.gaps ?? []).length}`,
);
