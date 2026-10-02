/**
 * Toy teaching backtests on ~1y daily closes already fetched.
 * Two rules only: SMA50/200 trend hold; RSI bounce. Hard-labeled as teaching.
 * No Python, no OpenBB, not investment advice.
 */

import { rsi, sma } from "../trading/indicators";
import type { TickerAnalysis } from "../trading/signals";

export interface ToyBacktestResult {
  symbol: string;
  displayName: string;
  rule: "sma-cross" | "rsi-bounce";
  ruleLabel: string;
  trades: number;
  winRate: number | null;
  /** Simple annualized return proxy from equity curve. */
  annualizedPct: number | null;
  maxDrawdownPct: number | null;
  note: string;
}

const TEACHING_NOTE =
  "教学示例 · 非投资建议 · 简化假设（信号次日按收盘近似成交）· 非正式回测引擎";

function equityStats(
  closes: number[],
  signals: ("long" | "flat")[],
): {
  trades: number;
  winRate: number | null;
  annualizedPct: number | null;
  maxDrawdownPct: number | null;
} {
  if (closes.length < 30 || signals.length !== closes.length) {
    return {
      trades: 0,
      winRate: null,
      annualizedPct: null,
      maxDrawdownPct: null,
    };
  }
  let cashEquity = 1;
  let peak = 1;
  let maxDd = 0;
  let position: "long" | "flat" = "flat";
  let entry = 0;
  let entryEquity = 1;
  let wins = 0;
  let trades = 0;

  for (let i = 1; i < closes.length; i++) {
    const want = signals[i - 1];
    if (position === "flat" && want === "long") {
      position = "long";
      entry = closes[i];
      entryEquity = cashEquity;
    } else if (position === "long" && want === "flat") {
      const ret = (closes[i] - entry) / entry;
      trades++;
      if (ret > 0) wins++;
      cashEquity = entryEquity * (1 + ret);
      position = "flat";
    }

    const marked =
      position === "long"
        ? entryEquity * (closes[i] / entry)
        : cashEquity;
    if (marked > peak) peak = marked;
    const dd = peak > 0 ? (marked - peak) / peak : 0;
    if (dd < maxDd) maxDd = dd;
  }

  if (position === "long") {
    const ret = (closes[closes.length - 1] - entry) / entry;
    trades++;
    if (ret > 0) wins++;
    cashEquity = entryEquity * (1 + ret);
  }

  const years = closes.length / 252;
  const annualizedPct =
    years > 0 && cashEquity > 0
      ? (Math.pow(cashEquity, 1 / years) - 1) * 100
      : null;

  return {
    trades,
    winRate: trades > 0 ? (wins / trades) * 100 : null,
    annualizedPct,
    maxDrawdownPct: maxDd * 100,
  };
}

function smaCrossSignals(closes: number[]): ("long" | "flat")[] {
  const s50 = sma(closes, 50);
  const s200 = sma(closes, 200);
  const out: ("long" | "flat")[] = closes.map(() => "flat");
  if (!s50.length || !s200.length) return out;
  const offset = closes.length - s200.length;
  const aligned50 = s50.slice(s50.length - s200.length);
  for (let i = 0; i < s200.length; i++) {
    out[offset + i] = aligned50[i] > s200[i] ? "long" : "flat";
  }
  return out;
}

function rsiBounceSignals(closes: number[]): ("long" | "flat")[] {
  const r = rsi(closes, 14);
  const out: ("long" | "flat")[] = closes.map(() => "flat");
  if (!r.length) return out;
  const offset = closes.length - r.length;
  let holding = false;
  for (let i = 1; i < r.length; i++) {
    if (!holding && r[i - 1] < 30 && r[i] >= 30) holding = true;
    if (holding && r[i - 1] > 70 && r[i] <= 70) holding = false;
    out[offset + i] = holding ? "long" : "flat";
  }
  return out;
}

function closesForTicker(t: TickerAnalysis): number[] | null {
  if (t.closesFull && t.closesFull.length >= 80) return t.closesFull;
  if (t.closesSpark && t.closesSpark.length >= 80) return t.closesSpark;
  return null;
}

/** Run toy rules on a few watchlist names (A-share / ETF preference). */
export function runToyBacktests(
  tickers: TickerAnalysis[],
  limit = 4,
): ToyBacktestResult[] {
  const focus = tickers.filter(
    (t) =>
      t.dataStatus !== "missing" &&
      (t.group === "china-ashare" ||
        t.group === "china-etf" ||
        t.group === "macro"),
  );
  const pick = (focus.length ? focus : tickers)
    .filter((t) => t.dataStatus !== "missing")
    .slice(0, limit);

  const out: ToyBacktestResult[] = [];
  for (const t of pick) {
    const closes = closesForTicker(t);
    if (!closes || closes.length < 80) continue;

    const smaStats = equityStats(closes, smaCrossSignals(closes));
    out.push({
      symbol: t.symbol,
      displayName: t.displayName,
      rule: "sma-cross",
      ruleLabel: "SMA50/200 多头持有",
      ...smaStats,
      note: TEACHING_NOTE,
    });

    const rsiStats = equityStats(closes, rsiBounceSignals(closes));
    out.push({
      symbol: t.symbol,
      displayName: t.displayName,
      rule: "rsi-bounce",
      ruleLabel: "RSI 超卖反弹→超买离场",
      ...rsiStats,
      note: TEACHING_NOTE,
    });
  }
  return out;
}
