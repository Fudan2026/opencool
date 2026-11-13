#!/usr/bin/env node
/**
 * Publish-lag assertion — replaces a human or agent watching the clock.
 *
 * The edition gate fires every 15 minutes and builds the oldest missing due
 * slot. That makes "is the edition late?" a question a machine can answer:
 * compare the moment the edition actually published with the slot time it was
 * due at, and fail when the gap exceeds the limit.
 *
 * Usage:
 *   node scripts/assert-publish-lag.mjs [--at <ISO instant>]
 *
 * Env:
 *   EDITION_DATE        YYYY-MM-DD the edition belongs to (gate output)
 *   EDITION_HOUR        HH slot, e.g. 06 (gate output)
 *   REPORT_TZ           IANA zone for slot + publish wall clock (Asia/Shanghai)
 *   PUBLISH_LAG_LIMIT_MIN  minutes of tolerated lag (default 20)
 *   EDITION_TRIGGER     gate reason: exact | catchup | backfill | push | manual
 *   ALREADY_PUBLISHED   "true" when gh-pages already carried this sidecar
 *                       before the run — a republish, not a late first publish
 *   PUBLISH_AT          ISO instant override for "now" (tests / replays)
 *   ALERT_WEBHOOK_URL   forwarded to scripts/notify-failure.mjs on a breach
 *
 * "Published at" is the instant this step runs — the workflow places it
 * immediately after the gh-pages push, so that instant IS the publish moment.
 * `--at` / `PUBLISH_AT` replay another instant (tests).
 *
 * A backfilled edition (sidecar `backfilled: true`, i.e. 补发) is a recovery of
 * a past date, not a breach: its lag is still printed so the number is on
 * record, but it does not fail the run.
 *
 * Exit codes: 0 on time / not a breach, 1 on a lag breach, 2 on bad input.
 */
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

export const DEFAULT_LAG_LIMIT_MIN = 20;
export const DEFAULT_TZ = "Asia/Shanghai";

const MS_PER_MIN = 60_000;

function pad2(n) {
  return String(n).padStart(2, "0");
}

/** Offset of `tz` from UTC at a given instant, in ms (east of UTC is +). */
function tzOffsetMs(instant, tz) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(instant);
  const p = {};
  for (const part of parts) p[part.type] = part.value;
  const asUtc = Date.UTC(
    Number(p.year),
    Number(p.month) - 1,
    Number(p.day),
    Number(p.hour),
    Number(p.minute),
    Number(p.second),
  );
  return asUtc - instant.getTime();
}

/**
 * The instant at which wall clock $dateKey $hour:$minute occurs in `tz`.
 * Asia/Shanghai has no DST, but the second pass keeps the helper correct for
 * zones that do.
 *
 * @param {string} dateKey YYYY-MM-DD
 * @param {number} hour 0-23
 * @param {string} tz IANA zone
 * @param {number} [minute]
 * @returns {Date}
 */
export function zonedWallToInstant(dateKey, hour, tz, minute = 0) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(dateKey))) {
    throw new Error(`slot date must be YYYY-MM-DD, got "${dateKey}"`);
  }
  const [y, m, d] = String(dateKey).split("-").map(Number);
  if (!Number.isFinite(y) || !Number.isFinite(m) || !Number.isFinite(d)) {
    throw new Error(`slot date must be YYYY-MM-DD, got "${dateKey}"`);
  }
  const guess = Date.UTC(y, m - 1, d, hour, minute, 0);
  let instant = guess - tzOffsetMs(new Date(guess), tz);
  instant = guess - tzOffsetMs(new Date(instant), tz);
  return new Date(instant);
}

/** `YYYY-MM-DD HH:MM` for an instant, rendered in `tz`. */
export function formatInTz(instant, tz) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: tz,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).formatToParts(instant);
  const p = {};
  for (const part of parts) p[part.type] = part.value;
  return `${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute}`;
}

/** Whole minutes from `from` to `to` (negative = published early). */
export function minutesBetween(from, to) {
  return Math.round((to.getTime() - from.getTime()) / MS_PER_MIN);
}

/**
 * Decide the verdict for one edition.
 *
 * Enforcement rules, in order:
 *   - backfilled (补发) → lag reported, green: a past date recovered late is a
 *     recovery, not a missed slot;
 *   - already live before this run → REPUBLISH, green: the slot was met by an
 *     earlier run, and this build merely rewrote it;
 *   - otherwise → the lag limit applies. That includes a push/dispatch build
 *     that is the FIRST publish of a due slot: the edition was late, whoever
 *     happened to publish it.
 * A `push`/`manual` build whose slot is already live never reaches the limit
 * (it is a REPUBLISH), so routine merges cannot turn main red — the alarm
 * stays on genuine lateness.
 *
 * @param {{date: string, hour: string, publishedAt: Date, tz?: string,
 *   limitMin?: number, backfilled?: boolean, alreadyPublished?: boolean,
 *   trigger?: string}} input
 * @returns {{date: string, slot: string, slotInstant: Date, publishedAt: Date,
 *   publishedSh: string, lagMinutes: number, verdict: string, ok: boolean,
 *   notified: boolean}}
 */
export function evaluatePublishLag(input) {
  const tz = input.tz || DEFAULT_TZ;
  const limitMin = Number.isFinite(input.limitMin)
    ? Number(input.limitMin)
    : DEFAULT_LAG_LIMIT_MIN;
  const slotHour = String(input.hour).padStart(2, "0");
  const slotInstant = zonedWallToInstant(input.date, Number(slotHour), tz);
  const lagMinutes = minutesBetween(slotInstant, input.publishedAt);
  const late = lagMinutes > limitMin;
  const trigger = String(input.trigger ?? "").trim().toLowerCase();

  let verdict;
  let ok;
  if (input.backfilled) {
    verdict = "BACKFILL (补发 — recovery of a past date, not a breach)";
    ok = true;
  } else if (input.alreadyPublished) {
    verdict = "REPUBLISH (edition was already live; slot was met earlier)";
    ok = true;
  } else if (late) {
    verdict = `LATE BREACH (limit ${limitMin}m)`;
    ok = false;
  } else if (trigger === "push" || trigger === "manual") {
    verdict = `ON TIME (${trigger} publish of a due slot)`;
    ok = true;
  } else {
    verdict = "ON TIME";
    ok = true;
  }

  return {
    date: input.date,
    slot: `${slotHour}:00`,
    slotInstant,
    publishedAt: input.publishedAt,
    publishedSh: formatInTz(input.publishedAt, tz),
    lagMinutes,
    verdict,
    ok,
    notified: false,
  };
}

/** True when the sidecar for this edition carries the 补发 flag. */
export function isBackfilledSidecar(date, hour, root = "daily_reports") {
  const sidecar = path.join(root, date, `${hour}.json`);
  if (!fs.existsSync(sidecar)) return false;
  try {
    const parsed = JSON.parse(fs.readFileSync(sidecar, "utf8"));
    return parsed?.backfilled === true;
  } catch {
    return false;
  }
}

/**
 * When this edition was actually published.
 *
 * The step runs immediately after `peaceiris/actions-gh-pages` pushes the
 * tree, so the assertion instant IS the publish moment — measuring the
 * sidecar's mtime instead would understate the lag by however long the bakes
 * and the push took, which is exactly the delay this check exists to catch.
 * `--at` / `PUBLISH_AT` replay a different instant for tests and backtests.
 *
 * @param {{now?: Date, at?: string|null}} [opts]
 * @returns {{publishedAt: Date, source: "run"|"override"}}
 */
export function resolvePublishedAt(opts = {}) {
  const at = (opts.at ?? "").trim();
  if (at) {
    const parsed = new Date(at);
    if (Number.isNaN(parsed.getTime())) {
      throw new Error(`publish time is not a valid date: "${at}"`);
    }
    return { publishedAt: parsed, source: "override" };
  }
  return { publishedAt: opts.now ?? new Date(), source: "run" };
}

/** The single log line the workflow shows. */
export function formatLagLine(result) {
  return (
    `[publish-lag] date=${result.date} slot=${result.slot} SH ` +
    `published=${result.publishedSh} SH lag=${result.lagMinutes}m ` +
    `verdict=${result.verdict}`
  );
}

function envFlag(name) {
  const raw = String(process.env[name] ?? "").trim().toLowerCase();
  return raw === "true" || raw === "1" || raw === "yes";
}

function notifyBreach(result, detail) {
  const reason = `published ${result.lagMinutes}m late (slot ${result.date} ${result.slot} SH, published ${result.publishedSh} SH)`;
  // Mark the breach so the generic "Alert on job failure" step does not page
  // a second time for the same late edition.
  if (process.env.GITHUB_ENV) {
    try {
      fs.appendFileSync(process.env.GITHUB_ENV, "PUBLISH_LAG_NOTIFIED=true\n");
    } catch {
      // Non-fatal: worst case the run pages twice.
    }
  }
  const r = spawnSync(
    process.execPath,
    ["scripts/notify-failure.mjs", "--failure", "--reason", reason],
    { stdio: "inherit", env: process.env },
  );
  if (r.error) console.warn(`[publish-lag] notify failed: ${r.error.message}`);
  return { ...result, notified: true, detail };
}

function main() {
  const date = (process.env.EDITION_DATE || "").trim();
  const hour = (process.env.EDITION_HOUR || "").trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !/^\d{1,2}$/.test(hour)) {
    console.error(
      `::error::publish-lag needs EDITION_DATE (YYYY-MM-DD) and EDITION_HOUR (HH), got "${date}" / "${hour}"`,
    );
    process.exit(2);
  }

  const tz = process.env.REPORT_TZ?.trim() || DEFAULT_TZ;
  const rawLimit = process.env.PUBLISH_LAG_LIMIT_MIN?.trim();
  const limitMin = rawLimit ? Number(rawLimit) : DEFAULT_LAG_LIMIT_MIN;
  if (!Number.isFinite(limitMin) || limitMin < 0) {
    console.error(`::error::PUBLISH_LAG_LIMIT_MIN must be a non-negative number, got "${rawLimit}"`);
    process.exit(2);
  }

  const atArgIndex = process.argv.indexOf("--at");
  const atRaw =
    (atArgIndex >= 0 ? process.argv[atArgIndex + 1] : "") ||
    process.env.PUBLISH_AT ||
    "";
  let resolved;
  try {
    resolved = resolvePublishedAt({ at: atRaw });
  } catch (e) {
    console.error(`::error::${e?.message ?? e}`);
    process.exit(2);
  }

  const slotHour = pad2(hour);
  const publishedAt = resolved.publishedAt;
  console.log(
    `[publish-lag] publish time (${resolved.source}): ${publishedAt.toISOString()}`,
  );
  const result = evaluatePublishLag({
    date,
    hour: slotHour,
    publishedAt,
    tz,
    limitMin,
    backfilled: isBackfilledSidecar(date, slotHour),
    alreadyPublished: envFlag("ALREADY_PUBLISHED"),
    trigger: process.env.EDITION_TRIGGER,
  });

  console.log(formatLagLine(result));

  if (result.ok) {
    if (result.verdict.startsWith("BACKFILL")) {
      console.log(
        `[publish-lag] backfilled edition — lag reported for the record, run stays green`,
      );
    }
    return;
  }

  console.error(
    `::error::edition ${result.date}/${result.slot} published ${result.lagMinutes}m after its slot (limit ${limitMin}m)`,
  );
  notifyBreach(result, "publish lag");
  process.exit(1);
}

const invokedDirectly =
  process.argv[1] &&
  path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname);
if (invokedDirectly) main();
