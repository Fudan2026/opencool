/**
 * Trading-session schedule for the point-in-time tape.
 *
 * A-share continuous trading is 09:30–11:30 and 13:00–15:00 Asia/Shanghai,
 * Monday–Friday. We capture just *after* each half hour so the value the feed
 * reports is the move up to that point rather than the value at the bell:
 *
 *   09:35 10:05 10:35 11:05 11:35   morning session (last one right after 11:30)
 *   13:05 13:35 14:05 14:35 15:05   afternoon session (last one right after 15:00)
 *
 * Ten slots a day. Deliberately NOT 24x7: overnight the quote feed keeps
 * returning the previous close, so an overnight tick would add rows and no
 * information while spending a runner every half hour to record the same number.
 *
 * The slot list and the "which slot is due" decision live in `scripts/gate.mjs`
 * — that script is plain zero-dependency ESM and runs on the bare runner, so the
 * gate can decide a capture without `npm ci`. Re-exported here so the baker, the
 * tests and the workflow all read one list; duplicating it is how the gate and
 * the baker end up disagreeing about what "09:35" means.
 *
 * Weekends are excluded. Exchange holidays are not known offline: a holiday
 * capture writes a snapshot whose values equal the previous close, and the file
 * says so through its clocks instead of the baker pretending the market moved.
 */

export {
  TAPE_SLOTS,
  dueTapeSlot,
  isTradingWeekday,
} from "../../scripts/gate.mjs";

import { TAPE_SLOTS as SLOTS } from "../../scripts/gate.mjs";

/** Slots as `HHMM` filename stems. */
export function tapeSlotKeys(): string[] {
  return SLOTS.map((s: string) => s.replace(":", ""));
}

/** Minutes since midnight for a `HH:MM` slot. */
function slotMinutes(slot: string): number {
  const [h, m] = String(slot).split(":").map((s) => parseInt(s, 10));
  return h * 60 + m;
}

/** Every slot already due on `date` at `now` — the day's expected-so-far count. */
export function dueSlotsForDay(now: { hour: number; minute: number }): string[] {
  const nowMin = now.hour * 60 + now.minute;
  return SLOTS.filter((s: string) => slotMinutes(s) <= nowMin);
}

/** Previous weekday, for the "is this a holiday?" note in the bake log. */
export function previousWeekday(addDays: (d: string, n: number) => string, dateKey: string): string {
  let cursor = addDays(dateKey, -1);
  for (let i = 0; i < 10; i++) {
    const dow = new Date(`${cursor}T00:00:00Z`).getUTCDay();
    if (dow >= 1 && dow <= 5) return cursor;
    cursor = addDays(cursor, -1);
  }
  return cursor;
}
