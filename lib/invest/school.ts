/** Static retail school lessons — embedded at render time. */

export interface Lesson {
  id: string;
  title: string;
  level: string;
  body: string;
}

export const SCHOOL_LESSONS: Lesson[] = [
  {
    id: "kline",
    title: "看懂 K 线（散户入门）",
    level: "L1",
    body: `一根 K 线记录一段时间内的开、高、低、收。阳线收盘高于开盘，阴线相反。影线代表试探高低点。先看收盘价相对均线的位置，再看单根形态，避免只凭「锤子线」臆测。本站迷你图用收盘价折线，帮助建立位置感，不是交易信号。`,
  },
  {
    id: "ma-rsi",
    title: "均线与 RSI",
    level: "L1",
    body: `均线平滑价格噪音：价格在 SMA50/SMA200 上方且短均线在长均线上方，常称多头排列。RSI 衡量超买超卖，>70 偏热，<30 偏冷——都不是自动买卖点。金叉/死叉是均线交叉的俗称，需结合成交与大盘环境。`,
  },
  {
    id: "no-lookahead",
    title: "什么是未来函数",
    level: "L2",
    body: `用「当时还不知道」的信息做信号，回测会虚高。规则：指标只用 ≤ 当日收盘的数据；信号与成交不要同一根 K 线「看见收盘又按收盘价成交」而不说明假设。本站指标均按收盘序列计算，遵守无未来函数纪律。`,
  },
  {
    id: "paper",
    title: "纸盘纪律：只出清单不下单",
    level: "L2",
    body: `量化上手先从「明日关注清单」开始：每天收盘后记录观察池与理由，不自动下单。连续执行两周再谈实盘。蒸馏自 daily-ops Skill：默认 dry-run，真金需额外确认。`,
  },
  {
    id: "risk",
    title: "仓位与熔断",
    level: "L2",
    body: `单票仓位、日亏损熔断、连续亏损停手，是散户存活的硬门槛。详见「风控与纪律」页的红黄绿条款。目标不是暴富，是活得够久。`,
  },
  {
    id: "etf",
    title: "先从宽基 ETF 练手",
    level: "L1",
    body: `沪深300 / 中证500 / 创业板 ETF 比个股噪音小，适合练习看趋势与定投节奏。个股研究需要财务与行业功课，本站「大师视角」只是规则化对照，不是荐股。`,
  },
];
