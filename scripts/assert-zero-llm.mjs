#!/usr/bin/env node
/**
 * Post-run zero-token assertion for the build job.
 *
 * `LLM_MODE=off` makes every backend unreachable (lib/ai/llm.ts throws
 * LlmDisabledError before dispatch), and every backend that *does* run appends
 * one JSON line to `logs/llm-calls.jsonl`. So "that file has no line for this
 * run" is direct, machine-checkable proof that the run spent zero tokens — no
 * human or agent needs to read the log afterwards.
 *
 * Usage:
 *   node scripts/assert-zero-llm.mjs [--since <ISO>]
 *
 * Behaviour:
 *   - file missing  → PASS (the expected zero-call case; `logs/` is not even
 *                     created when no backend is ever reached);
 *   - empty file    → PASS;
 *   - any record    → FAIL, printing each offending call so the log names the
 *                     call site that woke up;
 *   - `--since`     → only records at/after that instant count (defence in
 *                     depth for a runner that reuses a log directory);
 *   - a line that is not valid JSON still counts as a call: an unparseable
 *                     append is evidence a backend wrote something, and a
 *                     silent pass is exactly the failure mode this guards.
 */
import fs from "node:fs";
import path from "node:path";

export const DEFAULT_LOG_PATH = path.join("logs", "llm-calls.jsonl");

/**
 * Read the call log and return the records that belong to this run.
 *
 * @param {{logPath?: string, since?: string|null, readFile?: typeof fs.readFileSync,
 *   exists?: typeof fs.existsSync}} [opts]
 * @returns {{records: Array<Record<string, unknown>>, raw: string[], missing: boolean}}
 */
export function findLlmCalls(opts = {}) {
  const logPath = opts.logPath ?? DEFAULT_LOG_PATH;
  const exists = opts.exists ?? fs.existsSync;
  const readFile = opts.readFile ?? fs.readFileSync;
  if (!exists(logPath)) return { records: [], raw: [], missing: true };

  const text = String(readFile(logPath, "utf8"));
  const raw = text
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
  if (raw.length === 0) return { records: [], raw: [], missing: false };

  const since = opts.since ? Date.parse(opts.since) : NaN;
  const records = [];
  for (const line of raw) {
    let parsed;
    try {
      parsed = JSON.parse(line);
    } catch {
      // Unparseable append: still a backend write. Never let it pass.
      records.push({ ts: "(unparseable)", raw: line });
      continue;
    }
    if (Number.isFinite(since)) {
      const ts = Date.parse(parsed?.ts ?? "");
      // A record with no timestamp cannot be excluded — count it.
      if (Number.isFinite(ts) && ts < since) continue;
    }
    records.push(parsed);
  }
  return { records, raw, missing: false };
}

/**
 * @param {{logPath?: string, since?: string|null}} [opts]
 * @returns {{ok: boolean, count: number, missing: boolean, records: Array<Record<string, unknown>>}}
 */
export function assertZeroLlm(opts = {}) {
  const { records, missing } = findLlmCalls(opts);
  return { ok: records.length === 0, count: records.length, missing, records };
}

function argValue(name, fallback = "") {
  const i = process.argv.indexOf(name);
  if (i >= 0 && process.argv[i + 1]) return process.argv[i + 1];
  return fallback;
}

function main() {
  const since = argValue("--since", process.env.LLM_LOG_SINCE || "") || null;
  const logPath = process.env.LLM_CALL_LOG || DEFAULT_LOG_PATH;
  const result = assertZeroLlm({ logPath, since });

  if (result.ok) {
    console.log(
      `[zero-llm] PASS — no LLM call in this run (${logPath} ${result.missing ? "absent" : "empty"})`,
    );
    return;
  }

  console.error(
    `::error::${result.count} LLM call(s) recorded in ${logPath} — this pipeline must spend zero tokens`,
  );
  for (const r of result.records.slice(0, 20)) {
    console.error(
      `  ${r.ts} backend=${r.backend ?? "?"} model=${r.model ?? "?"} success=${r.success ?? "?"}`,
    );
  }
  if (result.records.length > 20) {
    console.error(`  … ${result.records.length - 20} more (see ${logPath})`);
  }
  process.exit(1);
}

const invokedDirectly =
  process.argv[1] &&
  path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname);
if (invokedDirectly) main();
