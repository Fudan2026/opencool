/**
 * Resolve the timezone used for date-keyed filenames AND for date strings
 * rendered in HTML. Defaults to the system local timezone — set
 * `REPORT_TZ` (any IANA name, e.g. "America/Los_Angeles", "Europe/Berlin",
 * "Asia/Shanghai", or "UTC") to override.
 *
 * Lazy on purpose: `scripts/daily.ts` loads `.env.local` AFTER its
 * imports execute, so capturing the value at module init would freeze it
 * before dotenv has run. Each call site reads `process.env` fresh.
 */
export function getReportTz(): string | undefined {
  return process.env.REPORT_TZ?.trim() || undefined;
}

const DATE_KEY_RE = /^\d{4}-\d{2}-\d{2}$/;

/** True only for a real calendar date written as `YYYY-MM-DD`. */
export function isValidDateKey(value: unknown): value is string {
  if (typeof value !== "string" || !DATE_KEY_RE.test(value)) return false;
  const [y, m, d] = value.split("-").map(Number);
  const probe = new Date(Date.UTC(y, m - 1, d));
  return (
    probe.getUTCFullYear() === y &&
    probe.getUTCMonth() === m - 1 &&
    probe.getUTCDate() === d
  );
}

/**
 * Resolve the edition date key.
 *
 * `EDITION_DATE` (validated `YYYY-MM-DD`) lets the Actions gate backfill a
 * PAST edition — the pipeline could never build one before, because
 * `todayKey()` only ever answered "now". It is deliberately narrow:
 *
 *   - unset / empty  → plain timezone-local today (the normal path, untouched);
 *   - malformed or impossible (2026-13-01, 2026-02-30, "tomorrow") → THROW.
 *     Silently falling back to today would publish yesterday's date folder
 *     under today's name, which is exactly the drift this exists to avoid;
 *   - a date in the future → THROW. There is no such edition to backfill.
 *
 * `today` here is the caller's civil date in REPORT_TZ, so the comparison
 * stays consistent with the gate's clock rather than the runner's UTC.
 */
export function resolveEditionDate(
  today: string,
  raw: string | undefined = process.env.EDITION_DATE,
): string {
  const override = raw?.trim();
  if (!override) return today;
  if (!isValidDateKey(override)) {
    throw new Error(
      `EDITION_DATE must be a real YYYY-MM-DD date, got "${raw}" — refusing to publish`,
    );
  }
  if (override > today) {
    throw new Error(
      `EDITION_DATE ${override} is in the future (today is ${today}) — refusing to publish`,
    );
  }
  return override;
}

/** `EDITION_DATE`-aware date key: the backfill override when set, else today. */
export function todayKey(d: Date = new Date()): string {
  return resolveEditionDate(naturalTodayKey(d));
}

/**
 * The un-overridden civil date in REPORT_TZ — what `todayKey()` would return
 * with `EDITION_DATE` unset. `daily.ts` uses it to tell a genuine edition
 * from a backfill (which fetches *now* for a past date folder).
 */
export function naturalTodayKey(d: Date = new Date()): string {
  const fmt = new Intl.DateTimeFormat("en-CA", {
    timeZone: getReportTz(),
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  return fmt.format(d);
}

/** Default OpenCool triple-brief slots (local hours in REPORT_TZ). */
export const DEFAULT_REPORT_HOURS = [6, 13, 19];

/**
 * Parse REPORT_HOUR env (comma-separated) into sorted unique hour ints.
 * Defaults to 6,13,19 (morning / noon / evening).
 */
export function parseReportHours(): number[] {
  const raw = process.env.REPORT_HOUR?.trim();
  const parts = (raw || "6,13,19")
    .split(",")
    .map((s) => parseInt(s.trim(), 10))
    .filter((n) => Number.isFinite(n) && n >= 0 && n <= 23);
  const uniq = [...new Set(parts.length ? parts : DEFAULT_REPORT_HOURS)];
  return uniq.sort((a, b) => a - b);
}

/** Current hour 0–23 in REPORT_TZ. */
export function nowHourInReportTz(d: Date = new Date()): number {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: getReportTz(),
    hour: "2-digit",
    hourCycle: "h23",
  }).formatToParts(d);
  const hour = parts.find((p) => p.type === "hour")?.value ?? "0";
  return parseInt(hour, 10);
}

/**
 * Resolve which edition slot to write.
 *
 * Priority:
 *   1. EDITION_HOUR env (set by Actions gate / manual override) — "6" or "06"
 *   2. Latest configured slot whose hour <= now (in REPORT_TZ)
 *   3. First slot if still before the earliest hour today
 */
export function editionHourKey(d: Date = new Date()): string {
  const override = process.env.EDITION_HOUR?.trim();
  if (override) {
    const n = parseInt(override, 10);
    if (Number.isFinite(n) && n >= 0 && n <= 23) {
      return String(n).padStart(2, "0");
    }
  }
  const hours = parseReportHours();
  const nowH = nowHourInReportTz(d);
  let chosen = hours[0];
  for (const h of hours) {
    if (h <= nowH) chosen = h;
  }
  return String(chosen).padStart(2, "0");
}

/** zh/en-agnostic short codes; UI maps them via render strings. */
export type EditionKind = "morning" | "noon" | "evening" | "edition";

export function editionKind(hourKey: string): EditionKind {
  const h = parseInt(hourKey, 10);
  if (h <= 9) return "morning";
  if (h <= 15) return "noon";
  if (h <= 22) return "evening";
  return "edition";
}
