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
/**
 * One day, on purpose. A backfill re-fetches the feeds at build time, so a
 * slot recovered a few hours after midnight carries news from that same
 * night and is close to what the slot would have published. A slot recovered
 * two days late would file today's headlines under a date two days old — a
 * badge does not make that a truthful record of that day. The rollover
 * failure this fixes needs exactly one day of lookback; losing more than
 * that is an outage, not a dropped trigger.
 */
const DEFAULT_LOOKBACK_DAYS = 1;
const CONTENT_REF = "gh-pages";

/**
 * Tape capture slots — half-hourly during the two A-share sessions, Shanghai,
 * weekdays only. Ten per day, not 24x7: overnight the quote feed returns the
 * previous close, so an overnight tick adds rows and no information.
 *
 * Lives here (zero-dependency ESM, runnable by bare Node) because the tape gate
 * runs on the same cheap tick as the edition gate and must not need `npm ci`.
 * `lib/tape/schedule.ts` re-exports it, so the baker and the gate can never
 * disagree about which slots exist.
 */
export const TAPE_SLOTS = [
  "09:35",
  "10:05",
  "10:35",
  "11:05",
  "11:35",
  "13:05",
  "13:35",
  "14:05",
  "14:35",
  "15:05",
];

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

/**
 * The latest slot already DUE today — the dispatch / push path.
 *
 * Returns `null` when no slot is due yet (`now.hour < min(hours)`). That null is
 * load-bearing, not a convenience: the historical fallback `chosen = hours[0]`
 * meant a 02:25 push resolved to the 06:00 slot and published the day's first
 * edition 3h34m EARLY, under a `06` label whose content was 02:26 market data
 * (run 43481490148). At 06:00 the gate then probed `06.json`, saw 200 and
 * concluded the slot was met, so the real 06:00 edition never ran — a permanent
 * vintage error in the one field that carries the claim.
 *
 * `null` says "nothing is due"; the caller must not publish, and must not
 * substitute a slot that is not yet due.
 */
export function latestDueSlot(now, hours) {
  const first = Math.min(...hours);
  if (now.hour < first) return null;
  let chosen = null;
  for (const h of hours) if (now.hour >= h) chosen = h;
  return chosen === null ? null : pad2(chosen);
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
  const probePath = makePathProbe({ repo, token, fetchImpl });
  return async (date, slot) => probePath(`${date}/${slot}.json`);
}

/**
 * Arbitrary path inside the published tree → HTTP status (0 on any failure).
 *
 * The edition probe needs `<date>/<slot>.json`; the tape gate needs
 * `tape/<date>/<HHMM>.json` to tell "this slot is already captured" from
 * "capture it". One implementation so the 200-only rule cannot drift between
 * the two.
 */
export function makePathProbe({ repo, token, fetchImpl = fetch }) {
  return async (relPath) => {
    if (!repo || !token) return 0;
    const url = `${API_BASE}/repos/${repo}/contents/${relPath}?ref=${CONTENT_REF}`;
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
      console.warn(`[gate] probe ${relPath} failed: ${e?.message ?? e}`);
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

/* ------------------------------------------------------------------ */
/* Tape mode                                                           */
/* ------------------------------------------------------------------ */

function pad2n(n) {
  return String(n).padStart(2, "0");
}

/** `09:35` → 575 minutes since midnight. */
function slotMinutes(slot) {
  const [h, m] = String(slot).split(":").map((s) => parseInt(s, 10));
  return h * 60 + m;
}

/** Is `dateKey` Monday–Friday? Weekends have no session. */
export function isTradingWeekday(dateKey) {
  const dow = dayOfWeek(dateKey);
  return dow >= 1 && dow <= 5;
}

/**
 * Which capture slot is this tick for? `null` when it is not a capture tick.
 *
 * `graceMin` (default 20) is the catch-up window: the first tick at or after a
 * slot captures it, and later ticks inside `slot + grace` capture it again —
 * which is how a silently dropped scheduled trigger still gets a snapshot.
 * Past the grace the slot is left as a NAMED GAP instead of being written late:
 * a 15:05 file created at 16:40 would claim to describe 15:05 while carrying
 * 16:40 prices, and that lie is exactly what this store exists to avoid.
 */
export function dueTapeSlot(now, graceMin = 20) {
  if (!isTradingWeekday(now.date)) return null;
  const nowMin = now.hour * 60 + now.minute;
  let chosen = null;
  for (const slot of TAPE_SLOTS) {
    const m = slotMinutes(slot);
    if (nowMin < m) continue;
    if (nowMin > m + Math.max(0, graceMin)) continue;
    chosen = slot;
  }
  return chosen;
}

/**
 * Tape decision. Cheap by construction — at most ten Contents API probes per
 * tick, and only inside a session window, so the ordinary half hour costs
 * nothing.
 *
 * Existence oracle: `tape/<date>/<HHMM>.json` on gh-pages. Only a clean 200
 * means captured, same rule the edition gate uses. A `rev-N` sibling does not
 * count as "captured" for the base slot's *first* capture (the base file is
 * always written first), so probing the base name is sufficient.
 */
export async function decideTape({
  now,
  graceMin = 20,
  probe,
  forceSlot = "",
}) {
  const checks = [];
  if (forceSlot) {
    const slot = /^\d{2}:\d{2}$/.test(forceSlot)
      ? forceSlot
      : `${forceSlot.slice(0, 2)}:${forceSlot.slice(-2)}`;
    if (!TAPE_SLOTS.includes(slot)) {
      return {
        shouldRun: false,
        date: now.date,
        slot: "",
        reason: "slot-not-in-schedule",
        checks: [{ slot, status: null, skipped: "not a session slot" }],
      };
    }
    return {
      shouldRun: true,
      date: now.date,
      slot,
      reason: "forced",
      checks: [{ slot, status: null }],
    };
  }
  if (!isTradingWeekday(now.date)) {
    return { shouldRun: false, date: now.date, slot: "", reason: "weekend", checks };
  }

  const slot = dueTapeSlot(now, graceMin);
  if (!slot) {
    return { shouldRun: false, date: now.date, slot: "", reason: "outside-session-window", checks };
  }

  const key = slot.replace(":", "");
  const relPath = `tape/${now.date}/${key}.json`;
  let status;
  try {
    status = await probe(relPath);
  } catch {
    status = 0;
  }
  if (typeof status !== "number") status = 0;
  checks.push({ slot, status, path: relPath });
  if (status === 200) {
    return { shouldRun: false, date: now.date, slot, reason: "already-captured", checks };
  }
  return { shouldRun: true, date: now.date, slot, reason: "capture", checks };
}

function writeTapeOutputs(result) {
  const lines = [
    "tape-should-run=" + (result.shouldRun ? "true" : "false"),
    "tape-date=" + (result.shouldRun ? result.date : ""),
    "tape-slot=" + (result.shouldRun ? result.slot : ""),
    `tape-reason=${result.reason}`,
  ];
  const out = process.env.GITHUB_OUTPUT;
  if (out) fs.appendFileSync(out, `${lines.join("\n")}\n`);
  console.log(lines.join("\n"));

  const summary = process.env.GITHUB_STEP_SUMMARY;
  if (summary) {
    const rows = (result.checks || [])
      .map((c) =>
        c.skipped
          ? `| ${c.slot} | — | skipped (${c.skipped}) |`
          : `| ${c.slot} | ${c.status === 200 ? "captured" : `MISSING (HTTP ${c.status})`} |`,
      )
      .join("\n");
    fs.appendFileSync(
      summary,
      [
        `### Tape gate — ${result.shouldRun ? `${result.date} / ${result.slot} (${result.reason})` : `no capture (${result.reason})`}`,
        "",
        "| slot | state |",
        "| --- | --- |",
        rows || "| — | — |",
        "",
      ].join("\n"),
    );
  }
}

async function mainTape() {
  const tz = process.env.REPORT_TZ?.trim() || "Asia/Shanghai";
  const repo = process.env.GITHUB_REPOSITORY || "";
  const token = process.env.GH_TOKEN || process.env.GITHUB_TOKEN || "";
  const graceMin = intEnv("TAPE_GRACE_MIN", 20);
  const forceSlot = process.env.TAPE_SLOT?.trim() || "";

  const nowRaw = process.env.GATE_NOW?.trim();
  const nowDate = nowRaw ? new Date(nowRaw) : new Date();
  if (Number.isNaN(nowDate.getTime())) throw new Error(`GATE_NOW is not a date: "${nowRaw}"`);
  const now = civilNow(nowDate, tz);

  console.log(
    `[gate:tape] now ${now.date} ${pad2n(now.hour)}:${pad2n(now.minute)} ${tz} (dow ${now.dow}) ` +
      `grace=${graceMin}min force=${forceSlot || "none"} slots=${TAPE_SLOTS.length}`,
  );

  const result = await decideTape({
    now,
    graceMin,
    forceSlot,
    probe: makePathProbe({ repo, token }),
  });

  // Do not capture while an edition build is in flight.
  //
  // The edition job publishes its whole tree with `keep_files: false`, and it
  // restores `tape/` at job start — so a snapshot published *during* a build is
  // deleted by that build's push, and the tape would silently lose a tick it
  // reported as captured. The tick after the build finishes (still inside the
  // slot's grace window) captures it instead; past the window the slot stays a
  // named gap, which is the honest outcome. Reuses the edition gate's existing
  // guard rather than inventing a second one, and fails OPEN like it does: a
  // guard we cannot consult must not starve the tape.
  if (result.shouldRun && !forceSlot) {
    const guard = await hasBuildInFlight({
      repo,
      token,
      selfRunId: process.env.GITHUB_RUN_ID || "",
    });
    if (guard.inFlight) {
      console.log(`[gate:tape] edition build in flight (${guard.detail}) — deferring this capture`);
      result.shouldRun = false;
      result.reason = "build-in-flight";
    } else if (!guard.checked) {
      console.warn(`[gate:tape] in-flight guard unavailable (${guard.detail}) — capturing anyway`);
    }
  }

  if (result.shouldRun) {
    console.log(`[gate:tape] ↻ capture ${result.date}/${result.slot} (${result.reason})`);
  } else {
    console.log(`[gate:tape] ✗ no capture (${result.reason})`);
  }
  writeTapeOutputs(result);
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

/**
 * Decision for a `push` / `workflow_dispatch` event.
 *
 * A push or a dispatch has no slot of its own — it only means "somebody just
 * changed something, publish what is due". So:
 *
 *   - a slot is already due today → publish the latest one (the historical
 *     behaviour, and the reason a merge goes live);
 *   - NOTHING is due yet (`latestDueSlot` → null, i.e. before `hours[0]`) →
 *     fall through to the catchup scan instead of publishing the day's first
 *     slot early. That fall-through still heals a genuinely missing past slot;
 *     at 02:25 with everything published it yields `should-run=false`.
 *
 * Returning early with `hours[0]` here is what published `2026-11-14/06.json`
 * at 02:26 SH (run 43481490148) and permanently blocked the real 06:00 edition.
 *
 * Exported so the replays in `tests/golden/gate.test.ts` drive the real decision
 * rather than a copy of it.
 */
export async function decideTriggered({ now, hours, lookbackDays, daysSpec, probe, eventName }) {
  const hour = latestDueSlot(now, hours);
  if (hour !== null) {
    return {
      shouldRun: true,
      date: now.date,
      hour,
      reason: eventName === "push" ? "push" : "manual",
      checks: [],
      dueYet: true,
    };
  }
  const caught = await decideEdition({ now, hours, lookbackDays, daysSpec, probe });
  return { ...caught, dueYet: false };
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

  // How many past days a dispatch may heal. A dispatch/push has no "slot" of
  // its own, so when nothing is due yet it falls through to the catchup scan.
  let result;

  if (eventName === "workflow_dispatch" || eventName === "push") {
    result = await decideTriggered({ now, hours, lookbackDays, daysSpec, probe, eventName });
    if (result.dueYet) {
      // Unchanged from before this fix: a push/dispatch with a due slot
      // publishes it straight away and does NOT consult the in-flight guard.
      // A merge to main going live must never be suppressed by a concurrent
      // build; keep that behaviour exactly.
      console.log(`[gate] ${eventName} → latest due slot ${result.date}/${result.hour}`);
      writeOutputs(result);
      return;
    }
    // Nothing is due yet today. Publishing anyway would file the day's first
    // edition hours early under a later slot label — the 02:26 `06.json`
    // vintage error of run 43481490148 — and the real slot would then never
    // run, because its probe would find the premature file and call it met.
    //
    // The catchup scan above still heals a genuinely missing PAST slot; at
    // 02:25 with everything published it yields should-run=false.
    console.log(
      `[gate] ${eventName} before the first slot (${pad2(now.hour)}:${pad2(now.minute)} < ${pad2(Math.min(...hours))}:00) ` +
        `— nothing is due yet; used the catchup scan (${result.reason})`,
    );
  } else {
    result = await decideEdition({ now, hours, lookbackDays, daysSpec, probe });
  }

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
  // `--mode=tape` switches the same cheap gate script to the tape decision.
  // One entry point, two decisions, no second scheduler and no second copy of
  // the "only a 200 counts" rule.
  const tapeMode = process.argv.some(
    (a) => a === "--mode=tape" || a === "--tape",
  );
  const run = tapeMode ? mainTape : main;
  run().catch((e) => {
    console.error(`[gate] FAILED: ${e?.message ?? e}`);
    process.exit(1);
  });
}
