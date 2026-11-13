/** Type surface for scripts/gate.mjs (zero-dep ESM, run directly by Node). */

export interface CivilNow {
  date: string;
  hour: number;
  minute: number;
  dow: number;
}

export interface GateCheck {
  date: string;
  slot: string;
  status: number | null;
  skipped?: string;
}

export interface GateDecision {
  shouldRun: boolean;
  date: string;
  hour: string;
  reason: string;
  checks: GateCheck[];
}

export interface DecideEditionOptions {
  now: CivilNow;
  hours: number[];
  lookbackDays: number;
  daysSpec: string;
  probe: (date: string, slot: string) => Promise<number>;
}

export function parseHours(raw?: string | null): number[];
export function addDays(dateKey: string, delta: number): string;
export function dayOfWeek(dateKey: string): number;
export function dayMatches(dateKey: string, daysSpec?: string | null): boolean;
export function dueSlots(now: CivilNow, dateKey: string, hours: number[]): string[];
export function civilNow(now: Date, tz: string): CivilNow;
export function decideEdition(opts: DecideEditionOptions): Promise<GateDecision>;
export function latestDueSlot(now: CivilNow, hours: number[]): string | null;
export function makeContentsProbe(opts: {
  repo: string;
  token: string;
  fetchImpl?: typeof fetch;
}): (date: string, slot: string) => Promise<number>;
export function makePathProbe(opts: {
  repo: string;
  token: string;
  fetchImpl?: typeof fetch;
}): (relPath: string) => Promise<number>;

/** Tape capture slots, `HH:MM` in REPORT_TZ. Ten per trading day. */
export const TAPE_SLOTS: string[];

export function isTradingWeekday(dateKey: string): boolean;

export function dueTapeSlot(now: CivilNow, graceMin?: number): string | null;

export interface TriggeredDecision extends GateDecision {
  /** True when a slot was already due and the trigger published it directly. */
  dueYet: boolean;
}

export function decideTriggered(opts: {
  now: CivilNow;
  hours: number[];
  lookbackDays: number;
  daysSpec: string;
  probe: (date: string, slot: string) => Promise<number>;
  eventName: string;
}): Promise<TriggeredDecision>;

export interface TapeDecision {
  shouldRun: boolean;
  date: string;
  slot: string;
  reason: string;
  checks: Array<{ slot: string; status: number | null; path?: string; skipped?: string }>;
}

export function decideTape(opts: {
  now: CivilNow;
  graceMin?: number;
  probe: (relPath: string) => Promise<number>;
  forceSlot?: string;
}): Promise<TapeDecision>;
export function hasBuildInFlight(opts: {
  repo: string;
  token: string;
  workflowFile?: string;
  selfRunId?: string;
  buildJobName?: string;
  fetchImpl?: typeof fetch;
}): Promise<{ inFlight: boolean; checked: boolean; detail?: string }>;
