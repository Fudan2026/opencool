/**
 * Evaluate headline identity rules on the labeled pair corpus.
 *
 * `tests/fixtures/clustering-pairs.json` holds pairs of real headlines from
 * the published ledger, hand-labeled same-story / distinct-story. This
 * script measures any pair-level decision function against those labels:
 * false-merge rate (distinct pairs the rule joins) and false-split rate
 * (same pairs the rule keeps apart). Zero LLM, zero network; the fixture is
 * committed, so the measurement is reproducible.
 *
 * Usage: npx tsx scripts/topics-eval.ts [--sweep]
 */
import "./_env";

import fs from "node:fs";
import path from "node:path";

import {
  storyCluster,
  sameStoryHeadlines,
  headlineAffinity,
  SAME_EVENT_AFFINITY,
  REWORDED_REPEAT_AFFINITY,
  SAME_DAY_ENTITY_AFFINITY,
} from "../lib/topics/dedupe";

interface LabeledPair {
  a: string;
  b: string;
  label: "same" | "distinct";
  origin: string;
  sameUrl: boolean;
  dayGap: number;
}

const FIXTURE = path.join(__dirname, "..", "tests", "fixtures", "clustering-pairs.json");

function loadPairs(): LabeledPair[] {
  const raw = JSON.parse(fs.readFileSync(FIXTURE, "utf8"));
  if (!Array.isArray(raw?.pairs)) throw new Error("fixture missing pairs array");
  return raw.pairs;
}

function v1Same(a: string, b: string): boolean {
  return storyCluster(a) === storyCluster(b);
}

function v2Same(a: string, b: string, p: Pick<LabeledPair, "sameUrl" | "dayGap">): boolean {
  if (p.sameUrl && storyCluster(a) === storyCluster(b)) return true;
  return sameStoryHeadlines(a, b, p.dayGap);
}

interface Rates {
  n: number;
  same: number;
  distinct: number;
  fm: number;
  fs: number;
  fmRate: number;
  fsRate: number;
}

function measure(
  pairs: LabeledPair[],
  decide: (a: string, b: string, p: LabeledPair) => boolean,
): Rates {
  let same = 0;
  let distinct = 0;
  let fm = 0;
  let fs = 0;
  for (const p of pairs) {
    const joined = decide(p.a, p.b, p);
    if (p.label === "same") {
      same++;
      if (!joined) fs++;
    } else {
      distinct++;
      if (joined) fm++;
    }
  }
  return { n: pairs.length, same, distinct, fm, fs, fmRate: fm / distinct, fsRate: fs / same };
}

function show(name: string, r: Rates): void {
  console.log(
    `${name.padEnd(38)} n=${r.n} same=${r.same} distinct=${r.distinct} ` +
      `falseMerge=${r.fm} (${(r.fmRate * 100).toFixed(2)}%) ` +
      `falseSplit=${r.fs} (${(r.fsRate * 100).toFixed(2)}%)`,
  );
}

function v2WithGate(gate: string, value: number): (a: string, b: string, p: LabeledPair) => boolean {
  return (a, b, p) => {
    if (p.sameUrl && storyCluster(a) === storyCluster(b)) return true;
    const sameCluster = storyCluster(a) === storyCluster(b);
    if (!sameCluster) {
      const g = gate === "REWORDED_REPEAT_AFFINITY" ? value : REWORDED_REPEAT_AFFINITY;
      return headlineAffinity(a, b) >= g;
    }
    if (p.dayGap === 0) {
      const lettersA = (a ?? "").replace(/[^\p{L}]/gu, "");
      const lettersB = (b ?? "").replace(/[^\p{L}]/gu, "");
      const cjk = /[\u4e00-\u9fff]/;
      const latin = /[A-Za-z]/;
      const disjoint =
        (cjk.test(lettersA) && !latin.test(lettersA) && !cjk.test(lettersB) && latin.test(lettersB)) ||
        (cjk.test(lettersB) && !latin.test(lettersB) && !cjk.test(lettersA) && latin.test(lettersA));
      if (disjoint) return true;
      const g = gate === "SAME_DAY_ENTITY_AFFINITY" ? value : SAME_DAY_ENTITY_AFFINITY;
      return headlineAffinity(a, b) >= g;
    }
    const g = gate === "SAME_EVENT_AFFINITY" ? value : SAME_EVENT_AFFINITY;
    return headlineAffinity(a, b) >= g;
  };
}

function main(): void {
  const pairs = loadPairs();
  console.log(
    `[eval] labeled pairs: ${pairs.length} ` +
      `(same ${pairs.filter((p) => p.label === "same").length}, ` +
      `distinct ${pairs.filter((p) => p.label === "distinct").length}, ` +
      `sameUrl ${pairs.filter((p) => p.sameUrl).length})`,
  );

  const v1 = measure(pairs, (a, b) => v1Same(a, b));
  show("v1 (cluster equality)", v1);
  const v2 = measure(pairs, (a, b, p) => v2Same(a, b, p));
  show(
    `v2 (gates ${SAME_DAY_ENTITY_AFFINITY}/${SAME_EVENT_AFFINITY}/${REWORDED_REPEAT_AFFINITY})`,
    v2,
  );
  console.log(
    `[eval] strictly better on both: fm ${v1.fmRate > v2.fmRate ? "YES" : "NO"} ` +
      `(${(v1.fmRate * 100).toFixed(2)}% -> ${(v2.fmRate * 100).toFixed(2)}%), ` +
      `fs ${v1.fsRate > v2.fsRate ? "YES" : "NO"} ` +
      `(${(v1.fsRate * 100).toFixed(2)}% -> ${(v2.fsRate * 100).toFixed(2)}%)`,
  );

  const origins = [...new Set(pairs.map((p) => p.origin.split(":")[0]))].sort();
  for (const o of origins) {
    const sub = pairs.filter((p) => p.origin.startsWith(o));
    show(`  v1/${o}`, measure(sub, (a, b) => v1Same(a, b)));
    show(`  v2/${o}`, measure(sub, (a, b, p) => v2Same(a, b, p)));
  }

  const halves: LabeledPair[][] = [[], []];
  pairs.forEach((p, i) => halves[i % 2].push(p));
  for (const [i, h] of halves.entries()) {
    const r1 = measure(h, (a, b) => v1Same(a, b));
    const r2 = measure(h, (a, b, p) => v2Same(a, b, p));
    console.log(
      `[eval] half ${i}: v1 fm=${(r1.fmRate * 100).toFixed(2)}% fs=${(r1.fsRate * 100).toFixed(2)}%  ` +
        `v2 fm=${(r2.fmRate * 100).toFixed(2)}% fs=${(r2.fsRate * 100).toFixed(2)}%`,
    );
  }

  if (!process.argv.includes("--sweep")) return;

  console.log("\n[eval] gate sensitivity (shipped value marked *)");
  const gates: Array<[string, number]> = [
    ["SAME_EVENT_AFFINITY", SAME_EVENT_AFFINITY],
    ["SAME_DAY_ENTITY_AFFINITY", SAME_DAY_ENTITY_AFFINITY],
    ["REWORDED_REPEAT_AFFINITY", REWORDED_REPEAT_AFFINITY],
  ];
  for (const [name, shipped] of gates) {
    for (const v of [shipped - 0.05, shipped, shipped + 0.05]) {
      const r = measure(pairs, v2WithGate(name, Math.max(0, +v.toFixed(2))));
      console.log(
        `  ${v === shipped ? "*" : " "}${name}=${Math.max(0, +v.toFixed(2)).toFixed(2)}  ` +
          `fm=${r.fm} (${(r.fmRate * 100).toFixed(2)}%) fs=${r.fs} (${(r.fsRate * 100).toFixed(2)}%)`,
      );
    }
  }
}

main();
