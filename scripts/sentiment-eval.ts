/**
 * Golden-set eval for the dictionary sentiment gauge.
 *
 * Scores every hand-labeled headline in lib/nlp/golden-set.ts as a
 * single-article corpus through the SAME scoreSentiment() the pipeline
 * uses (title ×2, no excerpt — the ledger only publishes titles), maps the
 * score to positive/negative/neutral through the production neutral band
 * (|score| < 8 → neutral), and reports agreement against the human label.
 *
 * Usage: tsx scripts/sentiment-eval.ts [-v]
 *   -v lists every disagreement with score, hits and label.
 *
 * This is a maintenance tool, not a pipeline step: it is how lexicon
 * changes are measured before landing (the regression floor lives in
 * lib/nlp/sentiment-golden.test.ts). It reads no env and needs no dotenv
 * preload: the gauge only consults REPORT_LOCALE, which defaults to "zh".
 */
import { scoreSentiment, matchText } from "../lib/nlp/sentiment";
import { GOLDEN_HEADLINES, type GoldenHeadline } from "../lib/nlp/golden-set";
import type { ArticleInput } from "../lib/ai/pipeline";

const NEUTRAL_BAND = 8;

function asArticle(h: GoldenHeadline): ArticleInput {
  return {
    sourceId: "golden",
    title: h.title,
    excerpt: "",
    url: "https://example.com/golden",
    category: "finance",
    source: "golden",
  } as ArticleInput;
}

type Pred = "positive" | "negative" | "neutral";

function predict(score: number): Pred {
  if (score >= NEUTRAL_BAND) return "positive";
  if (score <= -NEUTRAL_BAND) return "negative";
  return "neutral";
}

const verbose = process.argv.includes("-v");
const byLabel = { positive: 0, negative: 0, neutral: 0 };
const byPred = { positive: 0, negative: 0, neutral: 0 };
const correct = { positive: 0, negative: 0, neutral: 0 };
const bucketStats = { fin: { n: 0, ok: 0 }, pol: { n: 0, ok: 0 } };
const misses: Array<{ i: number; h: GoldenHeadline; score: number; pred: Pred; drivers: string[] }> = [];
let agreed = 0;

GOLDEN_HEADLINES.forEach((h, i) => {
  const s = scoreSentiment([asArticle(h)]);
  const pred = predict(s.score);
  byLabel[h.label]++;
  byPred[pred]++;
  bucketStats[h.bucket].n++;
  if (pred === h.label) {
    agreed++;
    correct[h.label]++;
    bucketStats[h.bucket].ok++;
  } else {
    const hits = matchText(h.title.toLowerCase()).map((m) => `${m.term}(${m.weight > 0 ? "+" : ""}${m.weight}×${m.hits})`);
    misses.push({ i, h, score: s.score, pred, drivers: hits });
  }
});

const pct = (n: number, d: number) => (d === 0 ? "n/a" : `${((100 * n) / d).toFixed(1)}%`);
const total = GOLDEN_HEADLINES.length;

console.log(`golden set: ${total} headlines`);
console.log(`  human labels:  pos ${byLabel.positive}  neg ${byLabel.negative}  neu ${byLabel.neutral}`);
console.log(`  gauge predicts: pos ${byPred.positive}  neg ${byPred.negative}  neu ${byPred.neutral}`);
console.log(`AGREEMENT: ${pct(agreed, total)} (${agreed}/${total})`);
for (const k of ["positive", "negative", "neutral"] as const) {
  console.log(`  ${k}: ${pct(correct[k], byLabel[k])} correct (${correct[k]}/${byLabel[k]})`);
}
console.log(`  fin-bucket (finance-lane headlines, what the gauge scores in production): ${pct(bucketStats.fin.ok, bucketStats.fin.n)} (${bucketStats.fin.ok}/${bucketStats.fin.n})`);
console.log(`  pol-bucket (politics-lane headlines, robustness check): ${pct(bucketStats.pol.ok, bucketStats.pol.n)} (${bucketStats.pol.ok}/${bucketStats.pol.n})`);
if (verbose) {
  console.log(`\ndisagreements (${misses.length}):`);
  for (const m of misses) {
    console.log(`  #${m.i} [${m.h.label}→${m.pred} ${m.score}] ${m.h.title.slice(0, 70)}${m.drivers.length ? "  [" + m.drivers.join(", ") + "]" : "  [no hits]"}`);
  }
}
