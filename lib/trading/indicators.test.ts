import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  atr,
  bollinger,
  kdj,
  maAlignment,
  sma,
  volumeSpike,
} from "./indicators";
import { yahooToEmSecid, isCnAshareOrEtf } from "./eastmoney-kline";
import { matchKeysForTicker } from "../invest/events";
import type { TickerDef } from "./watchlist";
import { runToyBacktests } from "../invest/backtest";
import type { TickerAnalysis } from "./signals";
import { SCHOOL_LESSONS } from "../invest/school";
import { KNOWLEDGE } from "../invest/knowledge";

describe("indicators", () => {
  it("sma matches known series", () => {
    const v = [1, 2, 3, 4, 5];
    assert.deepEqual(sma(v, 3), [2, 3, 4]);
  });

  it("bollinger mid equals sma and bands spread with volatility", () => {
    const closes = [10, 11, 12, 11, 10, 9, 10, 11, 12, 13, 14, 13, 12, 11, 10, 10, 11, 12, 13, 14, 15];
    const bb = bollinger(closes, 5, 2);
    const mid = sma(closes, 5);
    assert.equal(bb.mid.length, mid.length);
    assert.ok(bb.upper.every((u, i) => u >= bb.mid[i]));
    assert.ok(bb.lower.every((l, i) => l <= bb.mid[i]));
  });

  it("atr is positive on trending highs/lows", () => {
    const highs = [10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24];
    const lows = [9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23];
    const closes = [9.5, 10.5, 11.5, 12.5, 13.5, 14.5, 15.5, 16.5, 17.5, 18.5, 19.5, 20.5, 21.5, 22.5, 23.5];
    const a = atr(highs, lows, closes, 5);
    assert.ok(a.length > 0);
    assert.ok(a.every((x) => x > 0));
  });

  it("kdj produces finite K/D/J", () => {
    const highs = Array.from({ length: 30 }, (_, i) => 100 + (i % 5));
    const lows = highs.map((h) => h - 3);
    const closes = highs.map((h, i) => h - 1 + (i % 2));
    const r = kdj(highs, lows, closes, 9);
    assert.ok(r.k.length > 0);
    assert.equal(r.k.length, r.d.length);
    assert.equal(r.k.length, r.j.length);
    assert.ok(r.k.every(Number.isFinite));
  });

  it("volumeSpike detects 2x average", () => {
    const vols = Array(25).fill(100);
    vols[vols.length - 1] = 250;
    assert.equal(volumeSpike(vols, 20, 2), true);
    vols[vols.length - 1] = 150;
    assert.equal(volumeSpike(vols, 20, 2), false);
  });

  it("maAlignment classifies bull/bear/mixed", () => {
    assert.equal(maAlignment(120, 110, 100, 90), "bull");
    assert.equal(maAlignment(80, 90, 100, 110), "bear");
    assert.equal(maAlignment(105, 110, 100, 90), "mixed");
    assert.equal(maAlignment(100, null, 50, 40), "unknown");
  });
});

describe("eastmoney mapping", () => {
  it("maps SS/SZ to secid", () => {
    assert.equal(yahooToEmSecid("600519.SS"), "1.600519");
    assert.equal(yahooToEmSecid("000001.SZ"), "0.000001");
    assert.equal(yahooToEmSecid("SPY"), null);
    assert.equal(isCnAshareOrEtf("510300.SS"), true);
    assert.equal(isCnAshareOrEtf("BTC-USD"), false);
  });
});

describe("event aliases", () => {
  it("includes code and synonym keys", () => {
    const t: TickerDef = {
      symbol: "600519.SS",
      displayName: "贵州茅台",
      aliases: ["茅台", "600519"],
      group: "china-ashare",
    };
    const keys = matchKeysForTicker(t);
    assert.ok(keys.includes("茅台"));
    assert.ok(keys.includes("600519"));
    assert.ok(keys.includes("贵州茅台"));
  });
});

describe("school/knowledge expansion", () => {
  it("has at least 12 lessons and PE percentile / dragon-tiger terms", () => {
    assert.ok(SCHOOL_LESSONS.length >= 12);
    assert.ok(KNOWLEDGE.some((k) => k.id === "pe-percentile"));
    assert.ok(KNOWLEDGE.some((k) => k.id === "dragon-tiger"));
    assert.ok(KNOWLEDGE.some((k) => k.id === "roe"));
  });
});

describe("toy backtest", () => {
  it("returns labeled teaching rows for long series", () => {
    const closes = Array.from({ length: 260 }, (_, i) => 100 + Math.sin(i / 8) * 5 + i * 0.02);
    const t: TickerAnalysis = {
      symbol: "510300.SS",
      displayName: "沪深300ETF",
      group: "china-etf",
      currency: "CNY",
      exchangeName: "SSE",
      currentPrice: closes[closes.length - 1],
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
      closesFull: closes,
      dataStatus: "live",
    };
    const rows = runToyBacktests([t], 1);
    assert.ok(rows.length >= 2);
    assert.ok(rows.every((r) => /教学/.test(r.note)));
  });
});
