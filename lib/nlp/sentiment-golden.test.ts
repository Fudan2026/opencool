import test from "node:test";
import assert from "node:assert/strict";

import { scoreSentiment } from "./sentiment";
import { GOLDEN_HEADLINES } from "./golden-set";
import type { ArticleInput } from "../ai/pipeline";

/**
 * GOLDEN regression floor for the dictionary sentiment gauge.
 *
 * The 500-headline corpus (see golden-set.ts header for provenance and
 * labeling rules) is frozen evaluation data. The measured agreements of
 * the v2 lexicon were:
 *
 *   overall  83.2% (416/500)   — v1 baseline was 63.2% (316/500)
 *   positive 58.1%   negative 75.9%   neutral 93.0%
 *   fin-bucket 80.7%  pol-bucket 87.0%
 *
 * The floors below sit under those numbers so small, *justified*
 * vocabulary edits don't trip the gate; a lexicon change that drops the
 * gauge below them is a regression until the corpus is re-reviewed
 * (re-labeling requires the two-pass consistency check documented in
 * internal/sentiment-lexicon-v2.md).
 *
 * Protocol: each headline is scored as a single-article corpus (title ×2,
 * no excerpt — the ledger publishes titles only), mapped through the
 * production neutral band (|score| < 8 → neutral).
 */

const NEUTRAL_BAND = 8;
type Pred = "positive" | "negative" | "neutral";

function predict(score: number): Pred {
  if (score >= NEUTRAL_BAND) return "positive";
  if (score <= -NEUTRAL_BAND) return "negative";
  return "neutral";
}

function scoreHeadline(title: string): number {
  const s = scoreSentiment([
    {
      sourceId: "golden",
      title,
      excerpt: "",
      url: "https://example.com/golden",
      category: "finance",
      source: "golden",
    } as ArticleInput,
  ]);
  return s.score;
}

test("golden: corpus integrity", () => {
  assert.equal(GOLDEN_HEADLINES.length, 500);
  const labels = { positive: 0, negative: 0, neutral: 0 };
  const buckets = { fin: 0, pol: 0 };
  for (const h of GOLDEN_HEADLINES) {
    labels[h.label]++;
    buckets[h.bucket]++;
  }
  assert.deepEqual(labels, { positive: 86, negative: 112, neutral: 302 });
  assert.deepEqual(buckets, { fin: 300, pol: 200 });
});

test("golden: v2 agreement floors", () => {
  const byLabel = { positive: 0, negative: 0, neutral: 0 };
  const correct = { positive: 0, negative: 0, neutral: 0 };
  for (const h of GOLDEN_HEADLINES) {
    byLabel[h.label]++;
    if (predict(scoreHeadline(h.title)) === h.label) correct[h.label]++;
  }
  const total = GOLDEN_HEADLINES.length;
  const agreed = correct.positive + correct.negative + correct.neutral;

  // Floors: overall ≥ 83%, neutral ≥ 90%, negative ≥ 70%, positive ≥ 50%.
  assert.ok(
    agreed / total >= 0.83,
    `overall agreement ${(100 * agreed) / total}% below the 83% floor`,
  );
  for (const k of ["positive", "negative", "neutral"] as const) {
    const rate = correct[k] / byLabel[k];
    const floor = k === "neutral" ? 0.9 : k === "negative" ? 0.7 : 0.5;
    assert.ok(
      rate >= floor,
      `${k} recall ${(100 * rate).toFixed(1)}% below the ${(floor * 100).toFixed(0)}% floor`,
    );
  }
});
