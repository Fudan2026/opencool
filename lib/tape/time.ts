/**
 * Clock helpers for the point-in-time tape.
 *
 * Two clocks are recorded for every value we publish:
 *
 *   asOf        the market timestamp the value describes — taken from the
 *               upstream payload when the payload carries one (`f86` / `f124`
 *               are epoch seconds on the Eastmoney quote API), otherwise the
 *               fetch instant, flagged via `timestampSource: "fetch"`.
 *   observedAt  when we fetched it, ISO 8601 **with the market offset**
 *               (+08:00 under Asia/Shanghai) so a reader never has to guess
 *               the timezone of the record.
 *
 * The civil-clock helper is re-exported from `scripts/gate.mjs` rather than
 * reimplemented: the gate already owns "what wall clock is it in REPORT_TZ",
 * and two clocks that disagree by an hour would corrupt every tape filename.
 */

export { civilNow, type CivilNow } from "../../scripts/gate.mjs";

function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

/**
 * Offset of `tz` from UTC at instant `d`, in minutes (Asia/Shanghai → 480).
 * Derived from Intl rather than a table so DST-honouring zones stay correct.
 */
export function tzOffsetMinutes(d: Date, tz: string): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(d);
  const p: Record<string, string> = {};
  for (const part of parts) p[part.type] = part.value;
  const asUtc = Date.UTC(
    Number(p.year),
    Number(p.month) - 1,
    Number(p.day),
    Number(p.hour),
    Number(p.minute),
    Number(p.second),
  );
  // Seconds are truncated on both sides, so the difference is whole minutes.
  return Math.round((asUtc - Math.floor(d.getTime() / 1000) * 1000) / 60_000);
}

/** `2026-11-13T15:05:12+08:00` — ISO 8601 in the market's own offset. */
export function isoWithOffset(d: Date, tz: string): string {
  const offset = tzOffsetMinutes(d, tz);
  const sign = offset >= 0 ? "+" : "-";
  const abs = Math.abs(offset);
  const shifted = new Date(d.getTime() + offset * 60_000);
  return `${shifted.toISOString().slice(0, 19)}${sign}${pad2(Math.floor(abs / 60))}:${pad2(abs % 60)}`;
}

/** Epoch **seconds** (Eastmoney `f86` / `f124`) → ISO with the market offset. */
export function epochSecondsToIso(secs: unknown, tz: string): string | null {
  const n = Number(secs);
  if (!Number.isFinite(n) || n <= 0) return null;
  // Anything below ~2001 is a placeholder (0 / 1), not a quote time.
  if (n < 1_000_000_000) return null;
  return isoWithOffset(new Date(n * 1000), tz);
}

/** `09:35` → `0935`, the snapshot filename stem. */
export function slotKey(slot: string): string {
  const m = /^(\d{2}):(\d{2})$/.exec(String(slot ?? "").trim());
  if (!m) throw new Error(`tape slot must look like "HH:MM", got "${slot}"`);
  return `${m[1]}${m[2]}`;
}

/** `09:35` → 575 (minutes since midnight). */
export function slotMinutes(slot: string): number {
  const key = slotKey(slot);
  return Number(key.slice(0, 2)) * 60 + Number(key.slice(2));
}
