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

export function todayKey(d: Date = new Date()): string {
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
