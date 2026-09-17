/**
 * Rule-based investment personas (distilled checklists — zero LLM).
 * Scores are educational heuristics from public price/trend fields only.
 */

import type { TickerAnalysis } from "../trading/signals";

export interface Persona {
  id: string;
  name: string;
  blurb: string;
  /** Weight keywords for display */
  style: string[];
}

export interface PersonaScore {
  personaId: string;
  personaName: string;
  symbol: string;
  displayName: string;
  score: number; // 0–100
  verdict: "绿" | "黄" | "红";
  notes: string[];
}

export const PERSONAS: Persona[] = [
  {
    id: "graham",
    name: "格雷厄姆 · 安全边际",
    blurb: "偏好低估与安全边际；本站用「距52周低」与趋势中性作粗糙代理（无完整财务，仅教学）。",
    style: ["安全边际", "低估", "防守"],
  },
  {
    id: "buffett",
    name: "巴菲特 · 长期持有",
    blurb: "偏好多头排列与稳定趋势；用 SMA 多头与非超买作代理。",
    style: ["长期", "护城河", "复利"],
  },
  {
    id: "lynch",
    name: "彼得·林奇 · 成长可懂",
    blurb: "关注动量与常识故事；用 5 日涨幅适中与非极端 RSI 作代理。",
    style: ["成长", "常识", "十倍股"],
  },
  {
    id: "duanyongping",
    name: "段永平 · 买股票是买公司",
    blurb: "强调不做短期博弈；惩罚频繁信号噪音与超买追高。",
    style: ["本分", "长期", "不博弈"],
  },
  {
    id: "dalio",
    name: "达利欧 · 风险平价直觉",
    blurb: "偏好波动可控；用距52周高低适中、趋势中性偏多作代理。",
    style: ["分散", "风险平价", "宏观"],
  },
  {
    id: "retail-discipline",
    name: "散户纪律官",
    blurb: "蒸馏自风控 Skill：忌追高、忌报复交易；超买/逼近52周高扣分。",
    style: ["纪律", "仓位", "止损意识"],
  },
];

function clamp(n: number, lo = 0, hi = 100) {
  return Math.max(lo, Math.min(hi, n));
}

function verdict(score: number): "绿" | "黄" | "红" {
  if (score >= 65) return "绿";
  if (score >= 40) return "黄";
  return "红";
}

export function scorePersona(p: Persona, t: TickerAnalysis): PersonaScore {
  const notes: string[] = [];
  let score = 50;

  if (p.id === "graham") {
    if (t.pct52WeekLow <= 15) {
      score += 20;
      notes.push("相对接近阶段低位（粗糙代理）");
    } else {
      score -= 10;
      notes.push("距阶段低位偏远");
    }
    if (t.trend === "bearish") {
      score += 5;
      notes.push("下跌趋势中更强调安全边际");
    }
  } else if (p.id === "buffett") {
    if (t.trend === "bullish") {
      score += 25;
      notes.push("多头排列");
    }
    if (t.rsiState === "overbought") {
      score -= 15;
      notes.push("RSI 超买，不宜追高");
    }
    if (t.rsiState === "normal") score += 5;
  } else if (p.id === "lynch") {
    if (t.pct5Day > 0 && t.pct5Day < 8) {
      score += 15;
      notes.push("近5日温和上涨");
    }
    if (t.pct5Day > 15) {
      score -= 10;
      notes.push("短期涨幅过大");
    }
    if (t.rsiState !== "overbought") score += 5;
  } else if (p.id === "duanyongping") {
    if (t.signals.length > 4) {
      score -= 10;
      notes.push("信号过多，易陷入博弈");
    }
    if (t.trend === "bullish" && t.rsiState === "normal") {
      score += 20;
      notes.push("趋势向上且未极端");
    }
    if (t.rsiState === "overbought") {
      score -= 20;
      notes.push("拒绝追高");
    }
  } else if (p.id === "dalio") {
    const mid =
      Math.abs(t.pct52WeekHigh) > 8 && t.pct52WeekLow > 8;
    if (mid) {
      score += 15;
      notes.push("处于区间中部，波动相对可控");
    }
    if (t.trend === "neutral") score += 5;
  } else if (p.id === "retail-discipline") {
    if (t.rsiState === "overbought" || t.pct52WeekHigh >= -3) {
      score -= 25;
      notes.push("靠近高位/超买：纪律建议观望");
    }
    if (t.rsiState === "oversold") {
      score += 10;
      notes.push("超卖区可记观察池，非立即满仓");
    }
    if (t.trend === "bearish") {
      score -= 5;
      notes.push("空头排列：降低仓位意识");
    }
  }

  score = clamp(score);
  if (notes.length === 0) notes.push("字段有限，仅供教学对照");
  return {
    personaId: p.id,
    personaName: p.name,
    symbol: t.symbol,
    displayName: t.displayName,
    score,
    verdict: verdict(score),
    notes,
  };
}

export function scoreWatchlist(
  tickers: TickerAnalysis[],
  maxPerPersona = 4,
): PersonaScore[] {
  const focus = tickers.filter(
    (t) =>
      t.group === "china-ashare" ||
      t.group === "china-etf" ||
      t.group === "china-equity",
  );
  const pool = focus.length ? focus : tickers;
  const out: PersonaScore[] = [];
  for (const p of PERSONAS) {
    const ranked = pool
      .map((t) => scorePersona(p, t))
      .sort((a, b) => b.score - a.score)
      .slice(0, maxPerPersona);
    out.push(...ranked);
  }
  return out;
}
