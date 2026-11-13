/**
 * Instants for the story ledger, written as ISO-8601 **with an explicit
 * offset** (`2026-11-13T19:12:04+08:00`).
 *
 * Why an offset and not a `Z` stamp: the ledger's whole claim is "what we knew,
 * and when". A bare UTC instant is correct but unreadable for the editor and
 * ambiguous for a consumer comparing against a Shanghai session boundary.
 * Persisting the offset makes `firstSeenAt` self-describing.
 *
 * The timezone is `REPORT_TZ` (see `lib/utils.ts`) — nothing here hardcodes
 * Asia/Shanghai, so a fork running `REPORT_TZ=UTC` gets `+00:00` through the
 * same code path. Shanghai has no DST, but the arithmetic below is generic: it
 * asks Intl for the wall clock and diffs it against the instant.
 */

import { getReportTz } from "../utils";

/** Wall-clock parts of one instant in a timezone. */
function localParts(d: Date, tz?: string): Record<string, string> {
  const fmt = new Intl.DateTimeFormat("en-CA", {
    timeZone: tz,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
  const out: Record<string, string> = {};
  for (const p of fmt.formatToParts(d)) {
    if (p.type !== "literal") out[p.type] = p.value;
  }
  return out;
}

/**
 * Offset east of UTC **in minutes** at one instant, e.g. `480` for +08:00.
 *
 * Derived by rendering the instant in `tz`, reading that wall clock back as if
 * it were UTC, and diffing. Milliseconds are dropped first so a sub-second
 * instant cannot produce a fractional offset.
 */
export function offsetMinutes(d: Date, tz: string | undefined = getReportTz()): number {
  const p = localParts(d, tz);
  const asUtc = Date.UTC(
    Number(p.year),
    Number(p.month) - 1,
    Number(p.day),
    Number(p.hour),
    Number(p.minute),
    Number(p.second),
  );
  return Math.round((asUtc - (d.getTime() - d.getMilliseconds())) / 60_000);
}

/** `2026-11-13T19:12:04+08:00`, or `""` for an unparseable instant. */
export function isoWithOffset(
  d: Date | null | undefined,
  tz: string | undefined = getReportTz(),
): string {
  if (!(d instanceof Date) || Number.isNaN(d.getTime())) return "";
  const p = localParts(d, tz);
  const off = offsetMinutes(d, tz);
  const sign = off < 0 ? "-" : "+";
  const abs = Math.abs(off);
  const hh = String(Math.floor(abs / 60)).padStart(2, "0");
  const mm = String(abs % 60).padStart(2, "0");
  return `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}:${p.second}${sign}${hh}:${mm}`;
}

/** Civil date key (`2026-11-13`) of an instant in the report timezone. */
export function civilDate(d: Date, tz?: string): string {
  const p = localParts(d, tz);
  return `${p.year}-${p.month}-${p.day}`;
}

/** Shift a `YYYY-MM-DD` key by whole days (UTC arithmetic — keys are date-only). */
export function shiftDateKey(key: string, days: number): string {
  const [y, m, d] = key.split("-").map(Number);
  const probe = new Date(Date.UTC(y, m - 1, d + days));
  return probe.toISOString().slice(0, 10);
}

/** `Date` from a `Date`, ISO string, or epoch ms; null when unreadable. */
export function parseInstant(value: unknown): Date | null {
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? null : value;
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    const d = new Date(value);
    return Number.isNaN(d.getTime()) ? null : d;
  }
  if (typeof value === "string" && value.trim()) {
    const d = new Date(value.trim());
    return Number.isNaN(d.getTime()) ? null : d;
  }
  return null;
}

/** Whole minutes between two instants, one decimal place. Sign is preserved. */
export function minutesBetween(from: Date, to: Date): number {
  return Math.round(((to.getTime() - from.getTime()) / 60_000) * 10) / 10;
}
