#!/usr/bin/env node
/**
 * Optional failure / missing-edition notifier for GitHub Actions.
 *
 * Usage:
 *   node scripts/notify-failure.mjs [--missing-html] [--failure] [--reason "..."]
 *
 * Env:
 *   ALERT_WEBHOOK_URL  — if unset, exits 0 (no-op; zero-config forks OK)
 *   EDITION_DATE       — YYYY-MM-DD (defaults to Asia/Shanghai today)
 *   EDITION_HOUR       — HH slot e.g. 06
 *   GITHUB_SERVER_URL / GITHUB_REPOSITORY / GITHUB_RUN_ID — run URL
 *   REPORT_TZ          — for default date (default Asia/Shanghai)
 */
import fs from "node:fs";
import path from "node:path";

const args = process.argv.slice(2);
function flag(name) {
  return args.includes(name);
}
function opt(name, fallback = "") {
  const i = args.indexOf(name);
  if (i >= 0 && args[i + 1]) return args[i + 1];
  return fallback;
}

const webhook = process.env.ALERT_WEBHOOK_URL || "";

const tz = process.env.REPORT_TZ || "Asia/Shanghai";
const today =
  process.env.EDITION_DATE ||
  new Intl.DateTimeFormat("en-CA", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());

const hour = (process.env.EDITION_HOUR || "").padStart(2, "0");
const editionId = hour ? `${today}/${hour}` : today;
const runUrl =
  process.env.GITHUB_SERVER_URL &&
  process.env.GITHUB_REPOSITORY &&
  process.env.GITHUB_RUN_ID
    ? `${process.env.GITHUB_SERVER_URL}/${process.env.GITHUB_REPOSITORY}/actions/runs/${process.env.GITHUB_RUN_ID}`
    : "(local)";

let reason = opt("--reason", "");
// fatal = the edition is genuinely missing → exit 1 and turn the run red,
// webhook or not. Detection must not depend on ALERT_WEBHOOK_URL being set.
let fatal = false;
if (flag("--failure") && !reason) reason = "workflow step failure";
if (flag("--missing-html") && !reason) {
  const htmlPath = path.join(
    "daily_reports",
    today,
    hour ? `${hour}.html` : `${today}.html`,
  );
  const missing = !fs.existsSync(htmlPath);
  // A placeholder page (written by build-site.mjs for future slots) means
  // the edition was never generated — same as missing for alerting.
  const placeholder =
    !missing && fs.readFileSync(htmlPath, "utf8").includes("尚未更新");
  const empty = !missing && !placeholder && fs.statSync(htmlPath).size === 0;
  if (!missing && !placeholder && !empty) {
    console.log(`[notify] HTML ok: ${htmlPath}`);
    process.exit(0);
  }
  reason = missing
    ? `missing HTML ${htmlPath}`
    : placeholder
      ? `placeholder-only HTML — edition never generated: ${htmlPath}`
      : `empty HTML ${htmlPath}`;
  fatal = true;
}

if (!reason) {
  console.log("[notify] nothing to report");
  process.exit(0);
}

const body = {
  text: `OpenCool alert: ${editionId} — ${reason}\nrun: ${runUrl}`,
  edition: editionId,
  reason,
  run_url: runUrl,
};

if (!webhook) {
  if (fatal) {
    console.error(`[notify] ALERT (no webhook configured): ${editionId} — ${reason}`);
    process.exit(1);
  }
  console.log("[notify] ALERT_WEBHOOK_URL unset — skip");
  process.exit(0);
}

try {
  const res = await fetch(webhook, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(10_000),
  });
  console.log(`[notify] webhook HTTP ${res.status}`);
} catch (e) {
  console.warn(`[notify] webhook error: ${e instanceof Error ? e.message : e}`);
}
// Webhook delivery never changes the verdict: a detected missing/placeholder
// edition fails the run so the gap is visible (and catchup retries it).
process.exit(fatal ? 1 : 0);
