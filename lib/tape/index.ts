/**
 * Point-in-time tape — public surface.
 *
 * One immutable snapshot per A-share half-hour session slot, each value
 * carrying both the market clock it describes (`asOf`) and the instant we
 * observed it (`observedAt`). See `store.ts` for the append-only rules and
 * `sections.ts` for how the two clocks are produced.
 */

export {
  TAPE_SECTIONS,
  assertTwoClocks,
  buildSection,
  captureBoardQuotes,
  captureSections,
  isOffsetIso,
  latestInstant,
  unavailableSection,
  type BoardQuotes,
  type BoardRecord,
  type CaptureOptions,
  type ClockViolation,
  type FlowRecord,
  type IndexRecord,
  type LimitRecord,
  type TapeSection,
  type TapeSectionName,
  type TapeSections,
  type ThemeRecord,
  type TimestampSource,
} from "./sections";

export {
  TAPE_SCHEMA_VERSION,
  changedSections,
  dayDir,
  listSnapshots,
  readSnapshot,
  tapeRoot,
  writeDayIndex,
  writeSnapshot,
  type RevisionEntry,
  type TapeIndex,
  type TapeIndexRow,
  type TapeSnapshot,
  type WriteOptions,
  type WriteResult,
} from "./store";

export {
  TAPE_SLOTS,
  dueSlotsForDay,
  dueTapeSlot,
  isTradingWeekday,
  previousWeekday,
  tapeSlotKeys,
} from "./schedule";

export {
  epochSecondsToIso,
  isoWithOffset,
  slotKey,
  slotMinutes,
  tzOffsetMinutes,
  type CivilNow,
} from "./time";

export { captureSnapshot, type CaptureResult, type BoardResolution } from "./capture";
