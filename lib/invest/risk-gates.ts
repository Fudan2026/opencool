/**
 * Retail risk-gate teaching panel — distilled from quant-risk-gates skill.
 * Not live trading enforcement.
 */

export interface RiskGate {
  id: string;
  title: string;
  threshold: string;
  why: string;
  level: "绿" | "黄" | "红";
}

export const RISK_GATES: RiskGate[] = [
  {
    id: "whitelist",
    title: "白名单交易",
    threshold: "只做预先列入观察池的标的",
    why: "散户亏损常来自临时起意的陌生票。",
    level: "绿",
  },
  {
    id: "max-position",
    title: "单票仓位上限",
    threshold: "建议 ≤ 20% 总资金（教学默认）",
    why: "避免一票决定命运；蒸馏自 capital.max_position_pct 思路。",
    level: "黄",
  },
  {
    id: "daily-loss",
    title: "日亏损熔断",
    threshold: "单日浮亏 ≥ 3% 停止新开仓",
    why: "情绪交易放大器；见 quant-risk-gates。",
    level: "红",
  },
  {
    id: "consecutive-loss",
    title: "连续亏损熔断",
    threshold: "连续 3 笔亏损后强制复盘一天",
    why: "打断报复性交易循环。",
    level: "红",
  },
  {
    id: "liquidity",
    title: "流动性地板",
    threshold: "避开日均成交过低的小票（教学）",
    why: "滑点与无法成交是隐形成本。",
    level: "黄",
  },
  {
    id: "paper-first",
    title: "先纸盘后实盘",
    threshold: "策略至少纸盘验证后再考虑真金",
    why: "蒸馏 daily-ops：默认只出清单、不下单。",
    level: "绿",
  },
];

export const BACKTEST_VERDICT_TEMPLATE = {
  title: "策略复盘红黄绿（模板）",
  fields: [
    "结论：红 | 黄 | 绿",
    "样本外摘要",
    "最大回撤 / 胜率 / 盈亏比",
    "主要风险",
    "下一步：继续纸盘 | 缩小仓位 | 停用",
  ],
  note: "本站不提供回测引擎结果；请在自有脚本产出 CSV 后套用此模板。",
};
