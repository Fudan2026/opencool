import {
  atr as atrFn,
  bollinger as bollingerFn,
  detectRecentCross,
  kdj as kdjFn,
  last,
  maAlignment,
  macd as macdFn,
  rsi as rsiFn,
  sma,
  volumeSpike,
  type MaAlignment,
} from "./indicators";
import type { TickerRawData } from "./yahoo";
import { getDisplayName, type TickerDef } from "./watchlist";
import { REPORT_LOCALE } from "../sources/registry";

export type SignalType =
  | "golden-cross" // SMA50 crosses above SMA200 — bullish trend confirmation
  | "death-cross" // SMA50 crosses below SMA200 — bearish trend confirmation
  | "macd-bull-cross" // MACD crosses above signal — momentum turning up
  | "macd-bear-cross" // MACD crosses below signal — momentum turning down
  | "rsi-overbought" // RSI > 70
  | "rsi-oversold" // RSI < 30
  | "near-52w-high" // within 3% of 52-week high
  | "near-52w-low" // within 3% of 52-week low
  | "above-sma50-sma200" // price > both SMAs, classic uptrend
  | "below-sma50-sma200" // price < both SMAs, classic downtrend
  | "bb-upper-touch" // close near/above upper Bollinger
  | "bb-lower-touch" // close near/below lower Bollinger
  | "volume-spike" // volume ≥ 2× 20d MA
  | "kdj-overbought"
  | "kdj-oversold";

export interface Signal {
  type: SignalType;
  label: string;
  daysAgo?: number;
}

export type DataStatus = "live" | "stale" | "missing";

export interface AnalyzeOpts {
  dataStatus?: DataStatus;
  dataNote?: string;
}

export interface TickerAnalysis {
  symbol: string;
  displayName: string;
  group: string;
  currency: string;
  exchangeName: string;
  currentPrice: number;
  pct1Day: number;
  pct5Day: number;
  pct52WeekHigh: number;
  pct52WeekLow: number;
  sma20: number | null;
  sma50: number | null;
  sma200: number | null;
  rsi14: number | null;
  macd: number | null;
  macdSignal: number | null;
  macdHistogram: number | null;
  /** Bollinger mid / upper / lower (latest). */
  bbMid: number | null;
  bbUpper: number | null;
  bbLower: number | null;
  /** ATR(14) latest. */
  atr14: number | null;
  /** KDJ J latest (compact single field for UI). */
  kdjJ: number | null;
  volumeSpike: boolean;
  maAlign: MaAlignment;
  trend: "bullish" | "bearish" | "neutral";
  rsiState: "overbought" | "oversold" | "normal";
  signals: Signal[];
  closesSpark?: number[];
  /** Full close series for teaching backtests (when available). */
  closesFull?: number[];
  dataStatus?: DataStatus;
  dataNote?: string;
}

const SIGNAL_LABELS: Record<SignalType, string> = {
  "golden-cross": "金叉(SMA50↑SMA200)",
  "death-cross": "死叉(SMA50↓SMA200)",
  "macd-bull-cross": "MACD 金叉",
  "macd-bear-cross": "MACD 死叉",
  "rsi-overbought": "RSI 超买",
  "rsi-oversold": "RSI 超卖",
  "near-52w-high": "接近 52 周高",
  "near-52w-low": "接近 52 周低",
  "above-sma50-sma200": "多头排列",
  "below-sma50-sma200": "空头排列",
  "bb-upper-touch": "触及布林上轨",
  "bb-lower-touch": "触及布林下轨",
  "volume-spike": "放量",
  "kdj-overbought": "KDJ 超买",
  "kdj-oversold": "KDJ 超卖",
};

function emptyAnalysis(
  def: TickerDef,
  opts?: AnalyzeOpts,
): TickerAnalysis {
  return {
    symbol: def.symbol,
    displayName: getDisplayName(def, REPORT_LOCALE),
    group: def.group,
    currency: "",
    exchangeName: "",
    currentPrice: 0,
    pct1Day: 0,
    pct5Day: 0,
    pct52WeekHigh: 0,
    pct52WeekLow: 0,
    sma20: null,
    sma50: null,
    sma200: null,
    rsi14: null,
    macd: null,
    macdSignal: null,
    macdHistogram: null,
    bbMid: null,
    bbUpper: null,
    bbLower: null,
    atr14: null,
    kdjJ: null,
    volumeSpike: false,
    maAlign: "unknown",
    trend: "neutral",
    rsiState: "normal",
    signals: [],
    closesSpark: [],
    closesFull: [],
    dataStatus: opts?.dataStatus ?? "missing",
    dataNote: opts?.dataNote ?? "数据暂缺",
  };
}

export function analyzeTicker(
  def: TickerDef,
  raw: TickerRawData,
  opts?: AnalyzeOpts,
): TickerAnalysis {
  const closes = raw.candles.map((c) => c.close);
  const highs = raw.candles.map((c) => c.high);
  const lows = raw.candles.map((c) => c.low);
  const volumes = raw.candles.map((c) => c.volume);
  const n = closes.length;

  if (n < 2) {
    return emptyAnalysis(def, opts);
  }

  const currentPrice = raw.regularMarketPrice || closes[n - 1];
  const prev1 = closes[n - 2];
  const prev5 = closes[n - 6];
  const pct1Day = prev1 ? ((currentPrice - prev1) / prev1) * 100 : 0;
  const pct5Day = prev5 ? ((currentPrice - prev5) / prev5) * 100 : 0;
  const pct52WeekHigh = raw.fiftyTwoWeekHigh
    ? ((currentPrice - raw.fiftyTwoWeekHigh) / raw.fiftyTwoWeekHigh) * 100
    : 0;
  const pct52WeekLow = raw.fiftyTwoWeekLow
    ? ((currentPrice - raw.fiftyTwoWeekLow) / raw.fiftyTwoWeekLow) * 100
    : 0;

  const sma20arr = sma(closes, 20);
  const sma50arr = sma(closes, 50);
  const sma200arr = sma(closes, 200);
  const rsiArr = rsiFn(closes, 14);
  const m = macdFn(closes);
  const bb = bollingerFn(closes, 20, 2);
  const atrArr = atrFn(highs, lows, closes, 14);
  const kdjArr = kdjFn(highs, lows, closes);
  const spike = volumeSpike(volumes, 20, 2);

  const sma20Val = last(sma20arr) ?? null;
  const sma50Val = last(sma50arr) ?? null;
  const sma200Val = last(sma200arr) ?? null;
  const rsi14 = last(rsiArr) ?? null;
  const macdVal = last(m.macd) ?? null;
  const macdSignal = last(m.signal) ?? null;
  const macdHistogram = last(m.histogram) ?? null;
  const bbMid = last(bb.mid) ?? null;
  const bbUpper = last(bb.upper) ?? null;
  const bbLower = last(bb.lower) ?? null;
  const atr14 = last(atrArr) ?? null;
  const kdjJ = last(kdjArr.j) ?? null;
  const align = maAlignment(currentPrice, sma20Val, sma50Val, sma200Val);

  const trend: TickerAnalysis["trend"] =
    sma50Val && sma200Val
      ? currentPrice > sma50Val && sma50Val > sma200Val
        ? "bullish"
        : currentPrice < sma50Val && sma50Val < sma200Val
          ? "bearish"
          : "neutral"
      : "neutral";

  const rsiState: TickerAnalysis["rsiState"] =
    rsi14 != null
      ? rsi14 > 70
        ? "overbought"
        : rsi14 < 30
          ? "oversold"
          : "normal"
      : "normal";

  const signals: Signal[] = [];

  if (sma50arr.length && sma200arr.length) {
    const aligned50 = sma50arr.slice(sma50arr.length - sma200arr.length);
    const cross = detectRecentCross(aligned50, sma200arr, 10);
    if (cross) {
      signals.push({
        type: cross.direction === "up" ? "golden-cross" : "death-cross",
        label: SIGNAL_LABELS[
          cross.direction === "up" ? "golden-cross" : "death-cross"
        ],
        daysAgo: cross.daysAgo,
      });
    }
  }

  if (m.macd.length && m.signal.length) {
    const alignedMacd = m.macd.slice(m.macd.length - m.signal.length);
    const cross = detectRecentCross(alignedMacd, m.signal, 5);
    if (cross) {
      signals.push({
        type: cross.direction === "up" ? "macd-bull-cross" : "macd-bear-cross",
        label: SIGNAL_LABELS[
          cross.direction === "up" ? "macd-bull-cross" : "macd-bear-cross"
        ],
        daysAgo: cross.daysAgo,
      });
    }
  }

  if (rsiState === "overbought") {
    signals.push({
      type: "rsi-overbought",
      label: SIGNAL_LABELS["rsi-overbought"],
    });
  } else if (rsiState === "oversold") {
    signals.push({
      type: "rsi-oversold",
      label: SIGNAL_LABELS["rsi-oversold"],
    });
  }

  if (pct52WeekHigh >= -3) {
    signals.push({
      type: "near-52w-high",
      label: SIGNAL_LABELS["near-52w-high"],
    });
  } else if (pct52WeekLow <= 3) {
    signals.push({
      type: "near-52w-low",
      label: SIGNAL_LABELS["near-52w-low"],
    });
  }

  if (trend === "bullish") {
    signals.push({
      type: "above-sma50-sma200",
      label: SIGNAL_LABELS["above-sma50-sma200"],
    });
  } else if (trend === "bearish") {
    signals.push({
      type: "below-sma50-sma200",
      label: SIGNAL_LABELS["below-sma50-sma200"],
    });
  }

  // Bollinger touch (within 0.5% of band)
  if (bbUpper != null && currentPrice >= bbUpper * 0.995) {
    signals.push({
      type: "bb-upper-touch",
      label: SIGNAL_LABELS["bb-upper-touch"],
    });
  } else if (bbLower != null && currentPrice <= bbLower * 1.005) {
    signals.push({
      type: "bb-lower-touch",
      label: SIGNAL_LABELS["bb-lower-touch"],
    });
  }

  if (spike) {
    signals.push({
      type: "volume-spike",
      label: SIGNAL_LABELS["volume-spike"],
    });
  }

  if (kdjJ != null && kdjJ >= 100) {
    signals.push({
      type: "kdj-overbought",
      label: SIGNAL_LABELS["kdj-overbought"],
    });
  } else if (kdjJ != null && kdjJ <= 0) {
    signals.push({
      type: "kdj-oversold",
      label: SIGNAL_LABELS["kdj-oversold"],
    });
  }

  return {
    symbol: def.symbol,
    displayName: getDisplayName(def, REPORT_LOCALE),
    group: def.group,
    currency: raw.currency,
    exchangeName: raw.exchangeName,
    currentPrice,
    pct1Day,
    pct5Day,
    pct52WeekHigh,
    pct52WeekLow,
    sma20: sma20Val,
    sma50: sma50Val,
    sma200: sma200Val,
    rsi14,
    macd: macdVal,
    macdSignal,
    macdHistogram,
    bbMid,
    bbUpper,
    bbLower,
    atr14,
    kdjJ,
    volumeSpike: spike,
    maAlign: align,
    trend,
    rsiState,
    signals,
    closesSpark: closes.slice(-60),
    closesFull: closes,
    dataStatus: opts?.dataStatus ?? "live",
    dataNote: opts?.dataNote,
  };
}
