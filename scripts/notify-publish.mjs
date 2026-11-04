#!/usr/bin/env node
/**
 * Optional publish notifier — push the new edition to Telegram or ntfy
 * (TrendRadar-style push, the survey's cheapest high-demand gap).
 * Fully opt-in; a clean no-op when no channel is configured, and it
 * NEVER fails the run (delivery problems are logged, not thrown).
 *
 * Env:
 *   EDITION_DATE / EDITION_HOUR / REPORT_TZ — which edition published
 *   GITHUB_SERVER_URL / GITHUB_REPOSITORY — Pages link base
 *   TELEGRAM_BOT_TOKEN + TELEGRAM_CHAT_ID — Telegram channel (secrets)
 *   NTFY_TOPIC — ntfy.sh topic (variable, e.g. opencool-<suffix>)
 */
import fs from "node:fs";
import path from "node:path";

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
const base = `${process.env.GITHUB_SERVER_URL || "https://github.com"}/${process.env.GITHUB_REPOSITORY || "Fudan2026/opencool"}`;
const pagesUrl = `https://fudan2026.github.io/opencool/${today}/${hour}.html`;

// Read the baked sidecar for a real headline (placeholder -> skip text).
let headline = `${today} ${hour}:00 edition published`;
try {
  const sidecar = path.join("daily_reports", today, `${hour}.json`);
  if (fs.existsSync(sidecar)) {
    const r = JSON.parse(fs.readFileSync(sidecar, "utf8"));
    if (r?.hero_headline) headline = `${r.hero_headline}`;
  }
} catch {
  /* keep the default headline */
}

const telegramToken = process.env.TELEGRAM_BOT_TOKEN || "";
const telegramChat = process.env.TELEGRAM_CHAT_ID || "";
const ntfyTopic = process.env.NTFY_TOPIC || "";

if (!telegramToken && !ntfyTopic) {
  console.log(
    "[notify-publish] no channel configured (TELEGRAM_BOT_TOKEN/CHAT_ID or NTFY_TOPIC) — skip",
  );
  process.exit(0);
}

const text = `📰 OpenCool ${today} ${hour}:00\n${headline}\n${pagesUrl}`;

async function sendTelegram() {
  const res = await fetch(`https://api.telegram.org/bot${telegramToken}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: telegramChat, text, disable_web_page_preview: false }),
    signal: AbortSignal.timeout(10_000),
  });
  console.log(`[notify-publish] telegram HTTP ${res.status}`);
}

async function sendNtfy() {
  const res = await fetch(`https://ntfy.sh/${ntfyTopic}`, {
    method: "POST",
    headers: {
      Title: `OpenCool ${today} ${hour}:00`,
      Tags: "newspaper",
    },
    body: `${headline}\n${pagesUrl}`,
    signal: AbortSignal.timeout(10_000),
  });
  console.log(`[notify-publish] ntfy HTTP ${res.status}`);
}

let delivered = 0;
const errors = [];
for (const [name, fn] of [
  ["telegram", telegramToken ? sendTelegram : null],
  ["ntfy", ntfyTopic ? sendNtfy : null],
]) {
  if (!fn) continue;
  try {
    await fn();
    delivered++;
  } catch (e) {
    // never fail the run on push problems
    errors.push(`${name}: ${e instanceof Error ? e.message : e}`);
  }
}
if (errors.length) console.warn(`[notify-publish] delivery errors: ${errors.join("; ")}`);
console.log(`[notify-publish] delivered to ${delivered} channel(s)`);
process.exit(0);
