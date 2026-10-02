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
if (!webhook) {
  console.log("[notify] ALERT_WEBHOOK_URL unset — skip");
  process.exit(0);
}

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
if (flag("--failure") && !reason) reason = "workflow step failure";
if (flag("--missing-html") && !reason) {
  const htmlPath = path.join(
    "daily_reports",
    today,
    hour ? `${hour}.html` : `${today}.html`,
  );
  const missing = !fs.existsSync(htmlPath);
  const empty =
    !missing && fs.statSync(htmlPath).size === 0;
  if (!missing && !empty) {
    console.log(`[notify] HTML ok: ${htmlPath}`);
    process.exit(0);
  }
  reason = missing
    ? `missing HTML ${htmlPath}`
    : `empty HTML ${htmlPath}`;
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

try {
  const res = await fetch(webhook, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(10_000),
  });
  console.log(`[notify] webhook HTTP ${res.status}`);
  // Never fail the job solely because the webhook is down
  process.exit(0);
} catch (e) {
  console.warn(`[notify] webhook error: ${e instanceof Error ? e.message : e}`);
  process.exit(0);
}
