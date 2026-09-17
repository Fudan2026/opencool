/**
 * Expand watchlist for retail A-share / ETF focus.
 * Yahoo symbols: .SS Shanghai, .SZ Shenzhen. Failures are non-fatal per ticker.
 */

export type AssetGroup =
  | "china-ashare"
  | "china-etf"
  | "china-equity"
  | "us-equity"
  | "crypto"
  | "commodity-fx"
  | "macro";

export interface TickerDef {
  symbol: string;
  displayName: string;
  displayNameEn?: string;
  group: AssetGroup;
  /** Short aliases for event matching in Chinese headlines */
  aliases?: string[];
}

export function getDisplayName(t: TickerDef, locale: "zh" | "en"): string {
  return locale === "en" ? (t.displayNameEn ?? t.displayName) : t.displayName;
}

const ASSET_GROUP_LABELS_ZH: Record<AssetGroup, string> = {
  "china-ashare": "A 股蓝筹",
  "china-etf": "基金 / ETF",
  "china-equity": "中概 / 港股",
  "us-equity": "美股 / ETF",
  crypto: "加密货币",
  "commodity-fx": "商品 / 外汇",
  macro: "宏观信号",
};

const ASSET_GROUP_LABELS_EN: Record<AssetGroup, string> = {
  "china-ashare": "A-shares",
  "china-etf": "CN Funds / ETF",
  "china-equity": "China ADR / HK",
  "us-equity": "US Stocks / ETF",
  crypto: "Crypto",
  "commodity-fx": "Commodities / FX",
  macro: "Macro",
};

export function getAssetGroupLabels(
  locale: "zh" | "en",
): Record<AssetGroup, string> {
  return locale === "en" ? ASSET_GROUP_LABELS_EN : ASSET_GROUP_LABELS_ZH;
}

/** Default order: A-share first for retail CN audience. */
export const ASSET_GROUP_ORDER: AssetGroup[] = [
  "china-ashare",
  "china-etf",
  "macro",
  "china-equity",
  "us-equity",
  "crypto",
  "commodity-fx",
];

export const WATCHLIST: TickerDef[] = [
  // === A 股蓝筹 ===
  { symbol: "600519.SS", displayName: "贵州茅台", aliases: ["茅台", "600519"], group: "china-ashare" },
  { symbol: "300750.SZ", displayName: "宁德时代", aliases: ["宁德", "300750"], group: "china-ashare" },
  { symbol: "601318.SS", displayName: "中国平安", aliases: ["平安", "601318"], group: "china-ashare" },
  { symbol: "600036.SS", displayName: "招商银行", aliases: ["招行", "招商银行", "600036"], group: "china-ashare" },
  { symbol: "000858.SZ", displayName: "五粮液", aliases: ["五粮液", "000858"], group: "china-ashare" },
  { symbol: "002594.SZ", displayName: "比亚迪", aliases: ["比亚迪", "002594"], group: "china-ashare" },
  { symbol: "601012.SS", displayName: "隆基绿能", aliases: ["隆基", "601012"], group: "china-ashare" },
  { symbol: "000001.SZ", displayName: "平安银行", aliases: ["平安银行", "000001"], group: "china-ashare" },
  { symbol: "600276.SS", displayName: "恒瑞医药", aliases: ["恒瑞", "600276"], group: "china-ashare" },
  { symbol: "601888.SS", displayName: "中国中免", aliases: ["中免", "601888"], group: "china-ashare" },
  { symbol: "002475.SZ", displayName: "立讯精密", aliases: ["立讯", "002475"], group: "china-ashare" },
  { symbol: "300059.SZ", displayName: "东方财富", aliases: ["东财", "东方财富", "300059"], group: "china-ashare" },
  // === 基金 / ETF ===
  { symbol: "510300.SS", displayName: "沪深300ETF", aliases: ["沪深300", "510300"], group: "china-etf" },
  { symbol: "510500.SS", displayName: "中证500ETF", aliases: ["中证500", "510500"], group: "china-etf" },
  { symbol: "159915.SZ", displayName: "创业板ETF", aliases: ["创业板", "159915"], group: "china-etf" },
  { symbol: "588000.SS", displayName: "科创50ETF", aliases: ["科创50", "588000"], group: "china-etf" },
  { symbol: "512880.SS", displayName: "证券ETF", aliases: ["证券ETF", "512880"], group: "china-etf" },
  { symbol: "512480.SS", displayName: "半导体ETF", aliases: ["半导体", "512480"], group: "china-etf" },
  { symbol: "159919.SZ", displayName: "沪深300ETF(嘉实)", aliases: ["159919"], group: "china-etf" },
  // === 宏观指数（Yahoo）===
  { symbol: "000001.SS", displayName: "上证指数", aliases: ["上证", "大盘"], group: "macro" },
  { symbol: "399001.SZ", displayName: "深证成指", aliases: ["深成指"], group: "macro" },
  { symbol: "^VIX", displayName: "VIX 恐慌指数", displayNameEn: "VIX", group: "macro" },
  // === 中概 / 港股 ===
  { symbol: "BABA", displayName: "阿里巴巴 (BABA)", aliases: ["阿里", "阿里巴巴"], group: "china-equity" },
  { symbol: "PDD", displayName: "拼多多 (PDD)", aliases: ["拼多多", "PDD"], group: "china-equity" },
  { symbol: "0700.HK", displayName: "腾讯控股", aliases: ["腾讯"], group: "china-equity" },
  // === 美股精简 ===
  { symbol: "SPY", displayName: "S&P 500 ETF", group: "us-equity" },
  { symbol: "QQQ", displayName: "Nasdaq 100 ETF", group: "us-equity" },
  { symbol: "NVDA", displayName: "Nvidia", group: "us-equity" },
  // === 加密精简 ===
  { symbol: "BTC-USD", displayName: "Bitcoin", group: "crypto" },
  { symbol: "ETH-USD", displayName: "Ethereum", group: "crypto" },
  // === 商品 ===
  { symbol: "GC=F", displayName: "黄金期货", displayNameEn: "Gold", group: "commodity-fx" },
  { symbol: "USDCNY=X", displayName: "美元 / 人民币", group: "commodity-fx" },
];
