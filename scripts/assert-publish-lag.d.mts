/** Type surface for scripts/assert-publish-lag.mjs (zero-dep ESM, run directly by Node). */

export const DEFAULT_LAG_LIMIT_MIN: number;
export const DEFAULT_TZ: string;

export interface PublishLagResult {
  date: string;
  slot: string;
  slotInstant: Date;
  publishedAt: Date;
  publishedSh: string;
  lagMinutes: number;
  verdict: string;
  ok: boolean;
  notified: boolean;
}

export function zonedWallToInstant(
  dateKey: string,
  hour: number,
  tz: string,
  minute?: number,
): Date;

export function formatInTz(instant: Date, tz: string): string;

export function minutesBetween(from: Date, to: Date): number;

export function evaluatePublishLag(input: {
  date: string;
  hour: string;
  publishedAt: Date;
  tz?: string;
  limitMin?: number;
  backfilled?: boolean;
  alreadyPublished?: boolean;
  trigger?: string;
}): PublishLagResult;

export function isBackfilledSidecar(date: string, hour: string, root?: string): boolean;

export function resolvePublishedAt(opts?: {
  now?: Date;
  at?: string | null;
}): { publishedAt: Date; source: "run" | "override" };

export function formatLagLine(result: PublishLagResult): string;
