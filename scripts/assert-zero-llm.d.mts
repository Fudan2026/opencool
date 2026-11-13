/** Type surface for scripts/assert-zero-llm.mjs (zero-dep ESM, run directly by Node). */

export const DEFAULT_LOG_PATH: string;

export interface LlmCallRecordLoose {
  ts?: string;
  backend?: string;
  model?: string;
  success?: boolean;
  [key: string]: unknown;
}

export interface FindLlmCallsResult {
  records: LlmCallRecordLoose[];
  raw: string[];
  missing: boolean;
}

export function findLlmCalls(opts?: {
  logPath?: string;
  since?: string | null;
  readFile?: (path: string, encoding: string) => string;
  exists?: (path: string) => boolean;
}): FindLlmCallsResult;

export function assertZeroLlm(opts?: {
  logPath?: string;
  since?: string | null;
}): { ok: boolean; count: number; missing: boolean; records: LlmCallRecordLoose[] };
