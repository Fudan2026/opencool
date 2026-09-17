/** Curated knowledge base entries for client-side search. */

export interface KnowledgeEntry {
  id: string;
  term: string;
  aliases?: string[];
  body: string;
  tags: string[];
}

export const KNOWLEDGE: KnowledgeEntry[] = [
  { id: "pe", term: "市盈率 PE", aliases: ["PE", "市盈率"], body: "股价除以每股收益。高 PE 可能反映高增长预期，也可能是泡沫；需结合行业与增长。", tags: ["估值"] },
  { id: "pb", term: "市净率 PB", aliases: ["PB"], body: "股价除以每股净资产。银行地产等重资产行业常用；成长股参考价值有限。", tags: ["估值"] },
  { id: "roe", term: "净资产收益率 ROE", aliases: ["ROE"], body: "净利润 / 净资产。持续高 ROE 常被视为盈利能力强的信号之一。", tags: ["财务"] },
  { id: "limit-up", term: "涨停", aliases: ["涨停板"], body: "A 股主板通常 ±10%（ST ±5%，科创/创业板 ±20%）。涨停不代表第二天继续涨。", tags: ["交易规则"] },
  { id: "northbound", term: "北向资金", aliases: ["北上资金", "沪股通", "深股通"], body: "境外投资者经互联互通买入 A 股的资金流向统计，是情绪参考，不是因果。", tags: ["资金"] },
  { id: "etf", term: "ETF", aliases: ["交易型开放式指数基金"], body: "可在交易所买卖的指数基金，费率通常低于主动基金，适合宽基配置。", tags: ["基金"] },
  { id: "macd", term: "MACD", body: "指数平滑异同移动平均线，用于观察动量转折；金叉死叉需结合趋势过滤假信号。", tags: ["技术"] },
  { id: "rsi", term: "RSI", body: "相对强弱指标，衡量超买超卖；极端区可能延续，不宜单独作为开仓依据。", tags: ["技术"] },
  { id: "sma", term: "均线 SMA", aliases: ["MA", "均线"], body: "简单移动平均。常用 20/50/200 观察短中长期趋势位置。", tags: ["技术"] },
  { id: "drawdown", term: "最大回撤", aliases: ["回撤"], body: "净值从高点到低点的最大跌幅。衡量策略或持仓能扛多大痛苦。", tags: ["风控"] },
  { id: "sharpe", term: "夏普比率", body: "超额收益 / 波动。越高表示单位风险回报越好，样本外更重要。", tags: ["风控"] },
  { id: "lookahead", term: "未来函数", body: "回测中误用未来信息导致曲线虚高。见学堂「什么是未来函数」。", tags: ["量化"] },
  { id: "paper-trade", term: "纸盘 / 模拟盘", body: "用虚拟资金按规则记录买卖，验证执行纪律，不涉及真金。", tags: ["纪律"] },
  { id: "position", term: "仓位管理", body: "决定买多少比买什么更影响存活。单票上限与留现金是基本功。", tags: ["风控"] },
  { id: "liquidity", term: "流动性", body: "能否以合理价格快速成交。小票日成交过低时滑点巨大。", tags: ["风控"] },
  { id: "dividend", term: "股息率", body: "每股分红 / 股价。高股息策略关注分红可持续性，而非只看当年数字。", tags: ["估值"] },
  { id: "turnover", term: "换手率", body: "成交量相对流通股本。异常放量需结合消息与位置解读。", tags: ["交易"] },
  { id: "margin", term: "融资融券", body: "借钱炒股或融券做空。杠杆放大收益也放大爆仓风险，散户慎用。", tags: ["交易规则"] },
  { id: "st", term: "ST 股票", body: "风险警示板，涨跌幅限制更严，财务或规范问题需额外谨慎。", tags: ["交易规则"] },
  { id: "convertible", term: "可转债", body: "可转成股票的债券，条款复杂；不了解强赎/下修前不要当普通债。", tags: ["固收"] },
  { id: "index-enhance", term: "指数增强", body: "在跟踪指数基础上试图获取超额收益，需看跟踪误差与费用。", tags: ["基金"] },
  { id: "sector", term: "板块轮动", body: "资金在行业间切换。追热点易买在高潮，可用 ETF 降个股风险。", tags: ["策略"] },
  { id: "grid", term: "网格交易", body: "区间内高抛低吸。单边行情会失效，需设定边界与总仓位。", tags: ["策略"] },
  { id: "dca", term: "定投", body: "定期定额买入。降低择时压力，不保证不亏，适合长周期宽基。", tags: ["策略"] },
  { id: "stop-loss", term: "止损", body: "预先设定可承受亏损退出。关键是执行，不是画线。", tags: ["纪律"] },
  { id: "alpha", term: "Alpha", body: "相对基准的超额收益。没有稳定 Alpha 时，低费 beta（指数）更诚实。", tags: ["量化"] },
  { id: "beta", term: "Beta", body: "相对市场的敏感度。Beta≈1 大致跟大盘同幅度波动。", tags: ["量化"] },
  { id: "volume", term: "成交量", body: "确认趋势的辅助。缩量上涨与放量下跌含义不同，忌教条。", tags: ["技术"] },
  { id: "gap", term: "跳空", body: "开盘相对昨收出现缺口。有的回补有的成为支撑/压力，需统计而非迷信。", tags: ["技术"] },
  { id: "ah-premium", term: "AH 溢价", body: "同公司 A 股与 H 股价差。反映两地流动性和投资者结构差异。", tags: ["市场"] },
  { id: "registration", term: "注册制", body: "发行审核更市场化，退市与波动可能加大，基本面研究更重要。", tags: ["制度"] },
  { id: "circuit", term: "熔断（历史）", body: "A 股曾试点指数熔断后暂停。了解制度史有助于理解监管对波动的态度。", tags: ["制度"] },
  { id: "qdii", term: "QDII", body: "合格境内机构投资者，可配置海外资产；额度与溢价折价需注意。", tags: ["基金"] },
  { id: "lof", term: "LOF", body: "上市型开放式基金，场内场外都能交易，注意溢价套利风险。", tags: ["基金"] },
  { id: "repo", term: "逆回购", body: "短期借出资金换取利息，常用作现金管理，注意交易时间与费率。", tags: ["固收"] },
];

export function searchKnowledge(q: string, limit = 12): KnowledgeEntry[] {
  const s = q.trim().toLowerCase();
  if (!s) return KNOWLEDGE.slice(0, limit);
  const scored = KNOWLEDGE.map((e) => {
    const bag = [e.term, ...(e.aliases ?? []), e.body, ...e.tags].join(" ").toLowerCase();
    let score = 0;
    if (e.term.toLowerCase().includes(s)) score += 5;
    if ((e.aliases ?? []).some((a) => a.toLowerCase().includes(s))) score += 4;
    if (bag.includes(s)) score += 2;
    return { e, score };
  })
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score);
  return scored.slice(0, limit).map((x) => x.e);
}
