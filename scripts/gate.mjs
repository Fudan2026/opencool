#!/usr/bin/env node
/**
 * Edition gate — decides whether this run should build an edition, and which
 * one. Plain ESM on the runner's preinstalled Node: zero dependencies, no
 * `npm ci`, no build, so the gate job stays a few seconds and can fire every
 * 15 minutes instead of twice an hour.
 *
 * Why a module and not inline bash: the decision ("which date/slot should we
 * build?") is exactly the part that broke before — the catchup loop only ever
 * looked at TODAY, so once the date rolled over yesterday's missing slot
 * became unreachable. Here it is pure and unit-tested (tests/golden/gate.test.ts).
 *
 * Rules preserved from the bash gate:
 *   - `<date>/<slot>.json` on gh-pages is the existence oracle (build-site
 *     placeholders never write JSON), and ONLY a clean HTTP 200 counts as
 *     published. 404 / 403 / 429 / 000 / flake → treated as missing;
 *   - exact-slot hit, same-day catchup, REPORT_DAYS filter;
 *   - workflow_dispatch and push publish the latest due slot right away.
 *
 * New here:
 *   - the scan walks a REPORT_LOOKBACK_DAYS window oldest→newest and returns
 *     the OLDEST missing due slot (emitting edition-date AND edition-hour), so
 *     a rollover can no longer strand a slot permanently;
 *   - a build already in flight suppresses scheduled triggers, so the
 *     build job's `cancel-in-progress: true` cannot thrash a slow build on
 *     every 15-minute tick.
 */

import fs from "node:fs";
import { pathToFileURL } from "node:url";

const API_BASE = "https://api.github.com";
const DEFAULT_HOURS = [6, 13, 19];
const DEFAULT_LOOKBACK_DAYS = 2;
const CONTENT_REF = "gh-pages";

function pad2(n) {
  return String(n).padStart(2, "0");
}

/** "6,13,19" → [6,13,19]; junk dropped; falls back to the triple defaults. */
export function parseHours(raw) {
  const parts = String(raw ?? "")
    .split(",")
    .map((s) => parseInt(s.trim(), 10))
    .filter((n) => Number.isFinite(n) && n >= 0 && n <= 23);
  const uniq = [...new Set(parts)];
  return (uniq.length ? uniq : DEFAULT_HOURS).sort((a, b) => a - b);
}

/** Civil-date arithmetic (no timezone involved: YYYY-MM-DD is the unit). */
export function addDays(dateKey, delta) {
  const [y, m, d] = String(dateKey).split("-").map(Number);
  const t = new Date(Date.UTC(y, m - 1, d) + delta * 86_400_000);
  return `${t.getUTCFullYear()}-${pad2(t.getUTCMonth() + 1)}-${pad2(t.getUTCDate())}`;
}

/** 0 = Sunday … 6 = Saturday for a civil date. */
export function dayOfWeek(dateKey) {
  const [y, m, d] = String(dateKey).split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
}

/**
 * REPORT_DAYS filter: "*" (every day), or a comma list of `d` / `start-end`
 * day-of-week numbers, same grammar the bash gate used.
 */
export function dayMatches(dateKey, daysSpec) {
  const spec = String(daysSpec ?? "").trim() || "*";
  if (spec === "*") return true;
  const dow = dayOfWeek(dateKey);
  for (const raw of spec.split(",")) {
    const item = raw.trim();
    if (!item) continue;
    if (item.includes("-")) {
      const [start, end] = item.split("-").map((s) => parseInt(s.trim(), 10));
      if (Number.isFinite(start) && Number.isFinite(end) && dow >= start && dow <= end) {
        return true;
      }
    } else if (dow === parseInt(item, 10)) {
      return true;
    }
  }
  return false;
}

/**
 * Slots already due for `dateKey` at `now`. Past dates: every slot. Today:
 * every slot whose hour is <= the current hour. Future dates: none.
 */
export function dueSlots(now, dateKey, hours) {
  if (dateKey > now.date) return [];
  const all = hours.map((h) => pad2(h));
  if (dateKey < now.date) return all;
  return hours.filter((h) => h <= now.hour).map((h) => pad2(h));
}

/** Wall clock inside the report timezone, as civil date/hour/minute + dow. */
export function civilNow(now, tz) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(now);
  const p = {};
  for (const part of parts) p[part.type] = part.value;
  const date = `${p.year}-${p.month}-${p.day}`;
  return { date, hour: Number(p.hour), minute: Number(p.minute), dow: dayOfWeek(date) };
}

/**
 * Core decision. Pure apart from the injected `probe(date, slot)`, which
 * returns an HTTP status (anything but 200 counts as missing).
 *
 * Scans [today - lookbackDays … today], oldest date first and, inside a date,
 * lowest slot first, and returns the first missing due slot. That is the
 * OLDEST missing slot, which is what makes a cross-midnight recovery possible.
 *
 * @returns {Promise<{shouldRun: boolean, date: string, hour: string,
 *   reason: "exact"|"catchup"|"backfill"|"all-published",
 *   checks: Array<{date: string, slot: string, status: number|null, skipped?: string}>}>}
 */
export async function decideEdition({ now, hours, lookbackDays, daysSpec, probe }) {
  const checks = [];
  const span = Math.max(0, Math.trunc(Number(lookbackDays) || 0));
  const earliest = addDays(now.date, -span);

  for (let cursor = earliest; cursor <= now.date; cursor = addDays(cursor, 1)) {
    if (!dayMatches(cursor, daysSpec)) {
      checks.push({ date: cursor, slot: "", status: null, skipped: "day-filter" });
      continue;
    }
    for (const slot of dueSlots(now, cursor, hours)) {
      let status;
      try {
        status = await probe(cursor, slot);
      } catch {
        status = 0;
      }
      if (typeof status !== "number") status = 0;
      checks.push({ date: cursor, slot, status });
      if (status !== 200) {
        const reason =
          cursor < now.date ? "backfill" : Number(slot) === now.hour ? "exact" : "catchup";
        return { shouldRun: true, date: cursor, hour: slot, reason, checks };
      }
    }
  }
  return { shouldRun: false, date: "", hour: "", reason: "all-published", checks };
}

/** Latest due slot today — the dispatch / push path (publish immediately). */
export function latestDueSlot(now, hours) {
  let chosen = hours[0];
  for (const h of hours) if (now.hour >= h) chosen = h;
  return pad2(chosen);
}

async function getJson(url, token, fetchImpl) {
  const res = await fetchImpl(url, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "opencool-edition-gate",
    },
    signal: AbortSignal.timeout(15_000),
  });
  if (res.status !== 200) return { status: res.status, body: null };
  return { status: 200, body: await res.json().catch(() => null) };
}

/** `<date>/<slot>.json` on gh-pages → HTTP status. Network failure → 0. */
export function makeContentsProbe({ repo, token, fetchImpl = fetch }) {
  return async (date, slot) => {
    if (!repo || !token) return 0;
    const url = `${API_BASE}/repos/${repo}/contents/${date}/${slot}.json?ref=${CONTENT_REF}`;
    try {
      const res = await fetchImpl(url, {
        method: "GET",
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: "application/vnd.github+json",
          "X-GitHub-Api-Version": "2022-11-28",
          "User-Agent": "opencool-edition-gate",
        },
        signal: AbortSignal.timeout(10_000),
      });
      return res.status;
    } catch (e) {
      console.warn(`[gate] probe ${date}/${slot}.json failed: ${e?.message ?? e}`);
      return 0;
    }
  };
}

/**
 * Is a "Build & publish" job of this workflow already running or queued?
 *
 * The build group is `cancel-in-progress: true`, so without this check a slow
 * build would be cancelled and restarted on every gate tick and could never
 * finish. Failures here fail OPEN (a redundant build is bounded; a starved
 * edition is not) and say so in the log.
 */
export async function hasBuildInFlight({
  repo,
  token,
  workflowFile = "daily.yml",
  selfRunId,
  buildJobName = "Build & publish",
  fetchImpl = fetch,
}) {
  if (!repo || !token) return { inFlight: false, checked: false, detail: "no repo/token" };
  try {
    const runs = [];
    for (const status of ["in_progress", "queued"]) {
      const list = await getJson(
        `${API_BASE}/repos/${repo}/actions/workflows/${workflowFile}/runs?status=${status}&per_page=20`,
        token,
        fetchImpl,
      );
      if (list.status !== 200 || !list.body || !Array.isArray(list.body.workflow_runs)) {
        return { inFlight: false, checked: false, detail: `runs list (${status}) HTTP ${list.status}` };
      }
      runs.push(...list.body.workflow_runs);
    }
    const candidates = runs
      .filter((r) => String(r.id) !== String(selfRunId ?? ""))
      .slice(0, 5);
    for (const run of candidates) {
      const jobs = await getJson(
        `${API_BASE}/repos/${repo}/actions/runs/${run.id}/jobs?per_page=100`,
        token,
        fetchImpl,
      );
      if (jobs.status !== 200 || !jobs.body || !Array.isArray(jobs.body.jobs)) continue;
      const busy = jobs.body.jobs.find(
        (j) =>
          j.name === buildJobName &&
          ["in_progress", "queued", "pending", "waiting"].includes(j.status),
      );
      if (busy) {
        return {
          inFlight: true,
          checked: true,
          detail: `run ${run.id} job ${busy.name} ${busy.status}`,
        };
      }
    }
    return { inFlight: false, checked: true, detail: `${candidates.length} active run(s) scanned` };
  } catch (e) {
    return { inFlight: false, checked: false, detail: `guard error: ${e?.message ?? e}` };
  }
}

function intEnv(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") return fallback;
  const n = parseInt(raw.trim(), 10);
  if (!Number.isFinite(n) || n < 0 || n > 30) {
    throw new Error(`${name} must be an integer 0-30, got "${raw}"`);
  }
  return n;
}

function writeOutputs(result) {
  const lines = [
    `should-run=${result.shouldRun ? "true" : "false"}`,
    `edition-hour=${result.shouldRun ? result.hour : ""}`,
    `edition-date=${result.shouldRun ? result.date : ""}`,
    `backfill=${result.shouldRun && result.reason === "backfill" ? "true" : "false"}`,
    `reason=${result.reason}`,
  ];
  const out = process.env.GITHUB_OUTPUT;
  if (out) fs.appendFileSync(out, `${lines.join("\n")}\n`);
  console.log(lines.join("\n"));

  const summary = process.env.GITHUB_STEP_SUMMARY;
  if (summary) {
    const rows = (result.checks || [])
      .map((c) =>
        c.skipped
          ? `| ${c.date} | — | skipped (${c.skipped}) |`
          : `| ${c.date} | ${c.slot} | ${c.status === 200 ? "published" : `MISSING (HTTP ${c.status})`} |`,
      )
      .join("\n");
    fs.appendFileSync(
      summary,
      [
        `### Edition gate — ${result.shouldRun ? `${result.date} / ${result.hour} (${result.reason})` : `no build (${result.reason})`}`,
        "",
        "| date | slot | state |",
        "| --- | --- | --- |",
        rows || "| — | — | — |",
        "",
      ].join("\n"),
    );
  }
}

async function main() {
  const tz = process.env.REPORT_TZ?.trim() || "Asia/Shanghai";
  const hours = parseHours(process.env.REPORT_HOUR);
  const daysSpec = process.env.REPORT_DAYS?.trim() || "*";
  const lookbackDays = intEnv("REPORT_LOOKBACK_DAYS", DEFAULT_LOOKBACK_DAYS);
  const eventName = process.env.GITHUB_EVENT_NAME || process.env.EVENT_NAME || "";
  const repo = process.env.GITHUB_REPOSITORY || "";
  const token = process.env.GH_TOKEN || process.env.GITHUB_TOKEN || "";
  const selfRunId = process.env.GITHUB_RUN_ID || "";

  // Testing / local dry-run hook: replay the decision at another wall clock.
  const nowRaw = process.env.GATE_NOW?.trim();
  const nowDate = nowRaw ? new Date(nowRaw) : new Date();
  if (Number.isNaN(nowDate.getTime())) throw new Error(`GATE_NOW is not a date: "${nowRaw}"`);
  const now = civilNow(nowDate, tz);

  console.log(
    `[gate] now ${now.date} ${pad2(now.hour)}:${pad2(now.minute)} ${tz} (dow ${now.dow}) ` +
      `hours=${hours.join(",")} days=${daysSpec} lookback=${lookbackDays}d event=${eventName || "local"}`,
  );

  const probe = makeContentsProbe({ repo, token });

  if (eventName === "workflow_dispatch" || eventName === "push") {
    const hour = latestDueSlot(now, hours);
    const result = {
      shouldRun: true,
      date: now.date,
      hour,
      reason: eventName === "push" ? "push" : "manual",
      checks: [],
    };
    console.log(`[gate] ${eventName} → latest due slot ${now.date}/${hour}`);
    writeOutputs(result);
    return;
  }

  let result = await decideEdition({ now, hours, lookbackDays, daysSpec, probe });

  if (result.shouldRun) {
    const guard = await hasBuildInFlight({ repo, token, selfRunId });
    if (guard.inFlight) {
      console.log(`[gate] build already in flight (${guard.detail}) — not stacking another`);
      result = { ...result, shouldRun: false, reason: "build-in-flight" };
    } else if (!guard.checked) {
      console.warn(`[gate] in-flight guard unavailable (${guard.detail}) — proceeding`);
    }
  }

  if (result.shouldRun) {
    console.log(
      `[gate] ↻ ${result.reason}: ${result.date}/${result.hour} — ` +
        `${result.checks.filter((c) => c.status !== null).length} sidecar(s) probed`,
    );
  } else {
    console.log(`[gate] ✗ nothing to build (${result.reason})`);
  }
  writeOutputs(result);
}

const invokedDirectly =
  process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url;
if (invokedDirectly) {
  main().catch((e) => {
    console.error(`[gate] FAILED: ${e?.message ?? e}`);
    process.exit(1);
  });
}
