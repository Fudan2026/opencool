/**
 * Deterministic article classifier (shadow mode) — two orthogonal axes.
 *
 * Zero network, zero LLM, zero randomness: weighted dictionary scans over the
 * title (×2) and the excerpt/summary (×1), mirroring the house style of
 * `lib/nlp/sentiment.ts`. Every article receives:
 *
 *   lane       "zh" | "external"   — Axis A: language of the content
 *   topic      one of six          — Axis B: what it is about, venue-free
 *   domestic   boolean             — secondary China-orientation tag
 *   confidence per axis            — plus `matched`, naming the terms that fired
 *
 * MIGRATION NOTE — `cn-finance` retired
 * ------------------------------------
 * The first cut of this module used one flat seven-topic list including
 * `cn-finance` / 国内财经. That key conflated *language* with *venue*: it
 * collected every Chinese-language finance item and therefore measured "66%
 * foreign" on a real edition — which was the language lane behaving correctly,
 * not a lane defect and not a routing bug. The owner's correction splits the
 * axes:
 *
 *   - `cn-finance` → `lane: "zh"`. The lane is a *language* lane; Chinese wires
 *     legitimately cover US markets, Japanese rates and European politics.
 *     The lane is therefore still 中文财经 and still primary.
 *   - Domestic-China finance is no longer a topic. It is `domestic: true` on
 *     top of whichever topic applies: a PBOC operation is `policy`, an A-share
 *     index print is `global-markets`, a domestic issuer action is `filings`.
 *   - `cn-finance`'s market vocabulary moved into `global-markets`; its
 *     central-bank instruments (逆回购/MLF/LPR/降准) moved into `policy`,
 *     because a central-bank operation is policy rather than a market print.
 *     Audit §3.3 reached the same conclusion when it filed 央行 1万亿买断式逆回购
 *     under 政务.
 *
 * Consumers holding a persisted `topic: "cn-finance"` translate via
 * `LEGACY_TOPIC_MIGRATION` in `./taxonomy.ts`. Nothing in this repository ever
 * persisted that key — it existed only inside this module's first draft.
 *
 * Two consequences of the axis split, both simplifications:
 *
 *   - **Offshore damping is gone.** It existed to stop foreign wire copy
 *     polluting a domestic *topic*. With `domestic` as a tag rather than a
 *     topic, that failure mode cannot occur: venue is recorded, not routed.
 *   - **The category fallback no longer needs to be script-aware**, because
 *     script is now the lane axis directly.
 *
 * Structural shapes (`发行人：回购…`, broker-prefixed notes) still boost, and
 * `TOPIC_TERMS` remains one exported table so a curated override or a
 * per-source `defaultTopic` (increment 2) can layer on without touching the
 * matching logic.
 */

import type { Category } from "../sources/types";
import {
  FALLBACK_DOMESTIC_BY_LANE,
  FALLBACK_TOPIC_BY_CATEGORY,
  FALLBACK_TOPIC_BY_SUBCATEGORY,
  TOPICS,
  type LaneKey,
  type TopicKey,
} from "./taxonomy";

export interface ClassifyInput {
  title: string;
  excerpt?: string;
  /** LLM summary wins over excerpt when present (same as sentiment.ts). */
  summary?: string;
  category?: Category;
  /** Source subcategory — the more specific fallback tier when provided. */
  subcategory?: string;
  /** Source content language; only used when the text itself is unreadable. */
  lang?: "zh" | "en";
}

export interface ClassifyResult {
  /** Axis A — language lane. Never null. */
  lane: LaneKey;
  laneConfidence: number;
  /** Axis B — topic. Never null. */
  topic: TopicKey;
  topicConfidence: number;
  /** Secondary tag: China-oriented content, on top of either axis. */
  domestic: boolean;
  domesticConfidence: number;
  /** Dictionary terms that fired, strongest first — transparency only. */
  matched: string[];
  /** True when no topic rule fired and the source tier decided. */
  fallback: boolean;
  /** True when `domestic` came from the lane default rather than evidence. */
  domesticFallback: boolean;
}

interface Term {
  /** ASCII terms match case-insensitively on word boundaries; CJK verbatim. */
  term: string;
  weight: number;
}

const T = (term: string, weight = 1): Term => ({ term, weight });

// ---------------------------------------------------------------------------
// Shared geography table
// ---------------------------------------------------------------------------

/**
 * Countries and regions — ONE table feeding three consumers: the `world`
 * lexicon, the foreign-anchor score, and the domestic/foreign comparison.
 *
 * These were separate literal lists in the first draft and immediately
 * drifted (`italy` in one, `italian` in the other), silently disabling
 * matching for demonyms. A single source with explicit per-use weights keeps
 * them consistent — add a country here and every consumer updates.
 *
 * `world` is deliberately weak (0.5 in practice, via the `world` column).
 * Naming a country is context, not a beat: the audit's rule 3 makes the
 * *market noun* decide between `global-markets` and `world`, so "韩国…KOSDAQ"
 * belongs to markets while "印尼副总统辞职" stays world copy. The `anchor`
 * column feeds the domestic/foreign comparison only.
 */
const COUNTRIES: ReadonlyArray<{ term: string; world: number; anchor: number }> = [
  { term: "美国", world: 0.5, anchor: 1.5 },
  { term: "美方", world: 0.5, anchor: 1 },
  { term: "日本", world: 0.5, anchor: 1.5 },
  { term: "韩国", world: 0.5, anchor: 1.5 },
  { term: "朝鲜", world: 0.5, anchor: 1.5 },
  { term: "欧洲", world: 0.5, anchor: 1 },
  { term: "欧盟", world: 0.5, anchor: 1 },
  { term: "英国", world: 0.5, anchor: 1.5 },
  { term: "德国", world: 0.5, anchor: 1.5 },
  { term: "法国", world: 0.5, anchor: 1.5 },
  { term: "意大利", world: 0.5, anchor: 1.5 },
  { term: "印度", world: 0.5, anchor: 1.5 },
  { term: "印尼", world: 0.5, anchor: 1.5 },
  { term: "俄罗斯", world: 0.5, anchor: 1.5 },
  { term: "乌克兰", world: 0.5, anchor: 1.5 },
  { term: "土耳其", world: 0.5, anchor: 1.5 },
  { term: "沙特", world: 0.5, anchor: 1.5 },
  { term: "加拿大", world: 0.5, anchor: 1.5 },
  { term: "墨西哥", world: 0.5, anchor: 1.5 },
  { term: "巴西", world: 0.5, anchor: 1.5 },
  { term: "新加坡", world: 0.5, anchor: 1.5 },
  { term: "越南", world: 0.5, anchor: 1.5 },
  { term: "泰国", world: 0.5, anchor: 1.5 },
  { term: "澳大利亚", world: 0.5, anchor: 1.5 },
  { term: "海外", world: 0.5, anchor: 1 },
  { term: "pakistan", world: 0.5, anchor: 1.5 },
  { term: "afghanistan", world: 0.5, anchor: 1.5 },
  { term: "afghan", world: 0.5, anchor: 1.5 },
  { term: "myanmar", world: 0.5, anchor: 1.5 },
  { term: "bangladesh", world: 0.5, anchor: 1.5 },
  { term: "sri lanka", world: 0.5, anchor: 1.5 },
  { term: "nepal", world: 0.5, anchor: 1.5 },
  { term: "philippines", world: 0.5, anchor: 1.5 },
  { term: "thailand", world: 0.5, anchor: 1.5 },
  { term: "vietnam", world: 0.5, anchor: 1.5 },
  { term: "malaysia", world: 0.5, anchor: 1.5 },
  { term: "cambodia", world: 0.5, anchor: 1.5 },
  { term: "taiwan", world: 0.5, anchor: 1.5 },
  { term: "japan", world: 0.5, anchor: 1.5 },
  { term: "japanese", world: 0.5, anchor: 1.5 },
  { term: "korea", world: 0.5, anchor: 1.5 },
  { term: "korean", world: 0.5, anchor: 1.5 },
  { term: "india", world: 0.5, anchor: 1.5 },
  { term: "indian", world: 0.5, anchor: 1.5 },
  { term: "indonesia", world: 0.5, anchor: 1.5 },
  { term: "ethiopia", world: 0.5, anchor: 1.5 },
  { term: "ethiopia's", world: 0.5, anchor: 1.5 },
  { term: "kenya", world: 0.5, anchor: 1.5 },
  { term: "uganda", world: 0.5, anchor: 1.5 },
  { term: "uganda's", world: 0.5, anchor: 1.5 },
  { term: "nigeria", world: 0.5, anchor: 1.5 },
  { term: "sudan", world: 0.5, anchor: 1.5 },
  { term: "egypt", world: 0.5, anchor: 1.5 },
  { term: "iraq", world: 0.5, anchor: 1.5 },
  { term: "syria", world: 0.5, anchor: 1.5 },
  { term: "lebanon", world: 0.5, anchor: 1.5 },
  { term: "yemen", world: 0.5, anchor: 1.5 },
  { term: "qatar", world: 0.5, anchor: 1.5 },
  { term: "saudi arabia", world: 0.5, anchor: 1.5 },
  { term: "saudi", world: 0.5, anchor: 1.5 },
  { term: "colombia", world: 0.5, anchor: 1.5 },
  { term: "venezuela", world: 0.5, anchor: 1.5 },
  { term: "argentina", world: 0.5, anchor: 1.5 },
  { term: "chile", world: 0.5, anchor: 1.5 },
  { term: "bolivia", world: 0.5, anchor: 1.5 },
  { term: "cuba", world: 0.5, anchor: 1.5 },
  { term: "haiti", world: 0.5, anchor: 1.5 },
  { term: "peru", world: 0.5, anchor: 1.5 },
  { term: "belarus", world: 0.5, anchor: 1.5 },
  { term: "poland", world: 0.5, anchor: 1.5 },
  { term: "hungary", world: 0.5, anchor: 1.5 },
  { term: "serbia", world: 0.5, anchor: 1.5 },
  { term: "greece", world: 0.5, anchor: 1.5 },
  { term: "spain", world: 0.5, anchor: 1.5 },
  { term: "spanish", world: 0.5, anchor: 1.5 },
  { term: "portugal", world: 0.5, anchor: 1.5 },
  { term: "italy", world: 0.5, anchor: 1.5 },
  { term: "italian", world: 0.5, anchor: 1.5 },
  { term: "germany", world: 0.5, anchor: 1.5 },
  { term: "german", world: 0.5, anchor: 1.5 },
  { term: "france", world: 0.5, anchor: 1.5 },
  { term: "french", world: 0.5, anchor: 1.5 },
  { term: "britain", world: 0.5, anchor: 1.5 },
  { term: "british", world: 0.5, anchor: 1.5 },
  { term: "uk", world: 0.5, anchor: 1 },
  { term: "scotland", world: 0.5, anchor: 1.5 },
  { term: "ireland", world: 0.5, anchor: 1.5 },
  { term: "netherlands", world: 0.5, anchor: 1.5 },
  { term: "sweden", world: 0.5, anchor: 1.5 },
  { term: "norway", world: 0.5, anchor: 1.5 },
  { term: "denmark", world: 0.5, anchor: 1.5 },
  { term: "finland", world: 0.5, anchor: 1.5 },
  { term: "swiss", world: 0.5, anchor: 1.5 },
  { term: "australia", world: 0.5, anchor: 1.5 },
  { term: "australian", world: 0.5, anchor: 1.5 },
  { term: "new zealand", world: 0.5, anchor: 1.5 },
  { term: "mexico", world: 0.5, anchor: 1.5 },
  { term: "mexican", world: 0.5, anchor: 1.5 },
  { term: "brazil", world: 0.5, anchor: 1.5 },
  { term: "canada", world: 0.5, anchor: 1.5 },
  { term: "turkey", world: 0.5, anchor: 1.5 },
  { term: "turkish", world: 0.5, anchor: 1.5 },
  { term: "america", world: 0.5, anchor: 1.5 },
  { term: "american", world: 0.5, anchor: 1.5 },
  { term: "u.s.", world: 0.5, anchor: 1.5 },
  { term: "us", world: 0.5, anchor: 1 },
  { term: "europe", world: 0.5, anchor: 1 },
  { term: "european", world: 0.5, anchor: 1 },
  { term: "overseas", world: 0.5, anchor: 1 },
];

/**
 * Domestic (China-oriented) markers. Used ONLY for the `domestic` tag — never
 * for topic routing, which is the whole point of the axis split.
 */
const DOMESTIC_ANCHOR: Term[] = [
  T("中国", 2), T("我国", 2), T("国内", 1.5), T("内地", 1.5), T("全国", 1),
  T("A股", 2), T("沪指", 2), T("上证", 1.5), T("深成", 1.5), T("深证", 1.5),
  T("创业板", 1.5), T("科创板", 1.5), T("北交所", 1.5), T("沪深", 1.5),
  T("中证", 1.5), T("港股", 1.5), T("恒生", 1.5), T("恒指", 1.5),
  T("香港", 1.5), T("澳门", 1.5), T("台湾", 1.5),
  T("人民币", 2), T("在岸", 1.5), T("离岸人民币", 2), T("中间价", 1.5),
  T("央行", 2.5), T("人民银行", 3), T("证监会", 3), T("国务院", 3),
  T("财政部", 3), T("发改委", 3), T("商务部", 3), T("统计局", 3),
  T("工信部", 2.5), T("金融监管总局", 3), T("银保监", 2.5), T("外管局", 2.5),
  T("住建部", 2.5), T("能源局", 2.5), T("网信办", 2.5), T("政治局", 3),
  T("国常会", 3), T("人大", 2), T("政协", 2), T("最高法", 2.5),
  T("十五五", 2), T("双十一", 1.5), T("地方政府债", 2), T("专项债", 1.5),
  T("楼市", 1.5), T("房地产", 1.5), T("社融", 2), T("北向", 2), T("两融", 2),
  T("公募", 2), T("私募", 2), T("险资", 2),
  // Major Chinese issuers/platforms — enough to tag cross-border deals.
  T("京东", 2.5), T("阿里巴巴", 2.5), T("阿里", 2), T("腾讯", 2.5),
  T("美团", 2.5), T("茅台", 2.5), T("宁德时代", 2.5), T("比亚迪", 2.5),
  T("华为", 2.5), T("百度", 2.5), T("小米", 2.5), T("拼多多", 2.5),
  T("网易", 2), T("蔚来", 2), T("小鹏", 2), T("理想汽车", 2), T("中芯", 2.5),
  T("中信证券", 2.5), T("中金", 2), T("国泰君安", 2.5), T("华泰证券", 2.5),
  T("招商证券", 2.5), T("广发证券", 2.5), T("申万宏源", 2.5),
  // — en —
  T("china", 2.5), T("chinese", 2.5), T("beijing", 2), T("shanghai", 2),
  T("shenzhen", 2), T("pboc", 3), T("yuan", 2.5), T("renminbi", 2.5),
  T("a-shares", 2.5), T("csi 300", 2.5), T("hang seng", 2),
  T("hong kong", 1.5), T("onshore", 1.5), T("china's", 2),
  T("huawei", 2.5), T("alibaba", 2.5), T("tencent", 2.5), T("byd", 2.5),
  T("xiaomi", 2.5), T("baidu", 2.5), T("jd.com", 2.5), T("pinduoduo", 2.5),
  T("cnooc", 2.5), T("icbc", 2.5), T("smic", 2.5), T("catl", 2.5),
];

/** Offshore venue markers — the counterpart to `DOMESTIC_ANCHOR`. */
const FOREIGN_ANCHOR: Term[] = [
  ...COUNTRIES.map((c) => T(c.term, c.anchor)),
  // Institutions, indices and figures that imply an offshore venue alone.
  T("美联储", 2.5), T("欧洲央行", 2.5), T("日本央行", 2.5), T("英国央行", 2.5),
  T("特朗普", 1.5), T("白宫", 1.5), T("普京", 2), T("泽连斯基", 2.5),
  T("KOSPI", 2), T("KOSDAQ", 2), T("LME", 1.5), T("Nikkei", 2),
  T("美股", 2.5), T("纳斯达克", 2.5), T("标普", 2.5), T("道琼斯", 2.5),
  T("美债", 2.5), T("美元", 1.5), T("欧股", 2.5), T("日经", 2),
  T("日元", 1.5), T("federal reserve", 2.5), T("the fed", 2),
  T("wall street", 2.5), T("nasdaq", 2.5), T("s&p", 2.5),
  // Foreign corporate anchors: a Chinese-language story about Nvidia or Apple
  // is about an offshore company, so `domestic` must not default to true.
  T("英伟达", 2), T("黄仁勋", 2.5), T("苹果", 2), T("微软", 2),
  T("谷歌", 2), T("特斯拉", 2), T("亚马逊", 2), T("台积电", 2.5),
  T("nvidia", 2), T("jensen huang", 2.5), T("openai", 2.5),
  T("anthropic", 2.5), T("apple", 2), T("microsoft", 2), T("google", 2),
  T("tesla", 2), T("amazon", 2), T("meta", 2), T("spacex", 2),
];

// ---------------------------------------------------------------------------
// Topic tables (Axis B) — six topics, venue-independent
// ---------------------------------------------------------------------------

/**
 * 全球市场 — indices, rates, FX, commodities, crypto, market structure.
 *
 * Absorbs the retired `cn-finance` market vocabulary: an A-share print and an
 * S&P print are the same kind of story, differing only by `domestic`.
 */
const GLOBAL_MARKETS: Term[] = [
  // — zh: offshore markets —
  T("美股", 3), T("纳斯达克", 3), T("标普", 2.5), T("道琼斯", 2.5),
  T("美债", 2.5), T("美元指数", 3), T("美债收益率", 3),
  T("10年期", 2), T("两年期", 1.5), T("收益率", 1.5), T("国债收益率", 2.5),
  T("美联储", 3), T("欧洲央行", 3), T("日本央行", 3), T("英国央行", 3),
  T("加息", 2), T("降息", 2), T("议息", 2), T("利率决议", 2.5),
  T("美股盘前", 3), T("隔夜", 1.5), T("欧股", 2.5), T("日经", 2.5),
  T("日元", 1.5), T("韩元", 1.5), T("印度股市", 2), T("欧元汇率", 2.5),
  T("KOSPI", 3), T("KOSDAQ", 3), T("Nikkei", 3), T("LME", 2.5),
  T("原油", 2), T("WTI", 2.5), T("布伦特", 2.5), T("油价", 2),
  T("黄金", 2), T("白银", 1.5), T("现货金", 2), T("铜价", 2),
  T("期货", 1.5), T("逼仓", 2.5), T("多头", 1.5), T("空头", 1.5),
  T("非农", 2.5), T("失业率", 2), T("通胀", 1.5), T("PCE", 2),
  T("成屋销售", 2.5), T("新屋开工", 2.5), T("初请", 2),
  T("比特币", 2.5), T("加密货币", 2.5), T("币安", 3), T("以太坊", 2),
  T("加密交易所", 3), T("全球市场", 2), T("海外市场", 2), T("避险", 1.5),
  // — zh: onshore market structure (the retired cn-finance vocabulary) —
  T("A股", 3), T("沪指", 3), T("上证指数", 3), T("上证", 2), T("深成指", 2),
  T("深证", 2), T("创业板", 2), T("科创板", 2), T("北交所", 2), T("沪深", 2),
  T("中证", 1.5), T("港股", 2), T("恒生指数", 2), T("恒指", 2), T("恒生", 1.5),
  T("涨停", 3), T("跌停", 3), T("北向资金", 3), T("北向", 2), T("南向", 2),
  T("两融", 2), T("社融", 2.5), T("M2", 2), T("社零", 2),
  T("成交额", 1.5), T("两市", 1.5), T("主力资金", 2), T("板块", 1),
  T("公募", 2), T("私募", 2), T("基金", 1), T("ETF", 2), T("险资", 2),
  T("银行", 1), T("保险", 1), T("券商", 1.5), T("股市", 2), T("救市", 3),
  T("楼市", 2), T("房地产", 2), T("房价", 2), T("土地出让", 2),
  T("新股", 1.5), T("打新", 2), T("破发", 2), T("中概股", 2),
  T("CPI", 1.5), T("PPI", 1.5), T("PMI", 1.5), T("社会消费品零售", 2),
  T("地方债", 2), T("国债", 1.5), T("汇率", 1.5), T("双十一", 1.5),
  T("内需", 1.5), T("出口", 1.5), T("进口", 1.5), T("贸易顺差", 2),
  T("制造业", 1.5), T("工业增加值", 2), T("养老金", 1.5),
  T("涨幅", 1.5), T("跌幅", 1.5), T("成交", 1.2), T("投资者", 1.2),
  T("散户", 1.5), T("市值", 1.5), T("股价", 2), T("净值", 1.2),
  T("收益率曲线", 2), T("信贷", 1.5), T("贷款", 1.5), T("存款", 1.2),
  T("地方政府债", 2), T("暂停交易", 2.5), T("恢复交易", 2),
  // — en: indices, rates, assets —
  T("wall street", 2.5), T("nasdaq", 2.5), T("s&p", 2.5), T("dow jones", 2.5),
  T("federal reserve", 3), T("the fed", 2), T("fed", 1.5), T("fomc", 2.5),
  T("ecb", 2.5), T("bank of japan", 2.5), T("treasury yield", 2.5),
  T("treasury yields", 2.5), T("bond yield", 2.5), T("bond yields", 2.5),
  T("yield", 1.5), T("crude", 2), T("brent", 2), T("wti", 2.5),
  T("oil price", 2), T("gold", 1.5), T("silver", 1.5), T("copper", 1.5),
  T("bitcoin", 2.5), T("crypto", 2.5), T("binance", 2), T("ethereum", 2),
  T("dollar", 1.5), T("euro", 1), T("yen", 1.5), T("commodities", 2),
  T("futures", 1.5), T("exchange", 1.5), T("trading venue", 2.5),
  T("sovereign debt", 2.5), T("debt holdings", 2.5), T("creditors", 2),
  T("bondholders", 2.5), T("markets wrap", 3), T("stocks gain", 2.5),
  T("stocks rise", 2.5), T("stocks fall", 2.5), T("stocks sink", 2.5),
  T("stock futures", 2.5), T("equities", 1.5), T("bull market", 2),
  T("bear market", 2), T("selloff", 2), T("rally", 1.5),
  T("payrolls", 2.5), T("jobless claims", 2.5), T("unemployment", 1.5),
  T("jobless", 1.5), T("central bank", 2), T("rate decision", 2.5),
  T("hedge funds", 2.5), T("hedge fund", 2.5), T("asset manager", 2),
  T("asset managers", 1.5), T("lenders", 1.5), T("economist", 2),
  T("economics", 1.5), T("macroeconomics", 2.5), T("monetary", 2),
  T("hierarchy of money", 3), T("money supply", 2.5), T("central banker", 2.5),
  T("financial services", 2.5), T("market talk", 2.5), T("roundup", 1.5),
  T("stock-picking", 2.5), T("stock pickers", 2.5), T("fund manager", 2),
  T("sale process", 2), T("puts itself up for sale", 3), T("rescue deal", 2.5),
  T("collapse", 1.2), T("luxury", 1.2), T("slump", 1.2), T("trade war", 2.5),
  T("rivalry", 1.5), T("tariffs", 2), T("supply chain", 2),
  T("reservations", 1.2), T("vehicle", 1), T("debt levels", 2),
  T("emerging markets", 1.5), T("banks", 1), T("insurance", 1),
  T("stock market", 1.5), T("shareholders", 1.5), T("bond market", 1.5),
  T("mortgage", 1.5), T("home sales", 2), T("homebuyers", 2), T("renters", 1.5),
  T("inflation", 1.5), T("consumer prices", 2), T("retail sales", 2),
  T("interest rate", 1.5), T("rate cut", 2), T("rate hike", 2),
  T("china stocks", 2.5), T("chinese stocks", 2.5), T("chinese investors", 2.5),
  T("china's economy", 2.5), T("china market", 1.5), T("china internet", 2),
  T("hong kong stocks", 2.5), T("hang seng", 2.5), T("blue-chip", 1.5),
  T("dividend", 1.5), T("a-shares", 3), T("shanghai composite", 3),
  T("csi 300", 3), T("yuan", 2), T("onshore", 2),
  // — weak generic economics: enough to route, never enough to dominate —
  T("economy", 1), T("economic", 1), T("economy grows", 2), T("gdp", 1.5),
  T("recession", 1.5), T("consumer", 0.8), T("spending", 0.8), T("wages", 1),
  T("jobs", 0.8), T("taxes", 0.8), T("wealth", 0.8), T("income", 0.8),
  T("savings", 1.2), T("pensions", 1), T("property", 1), T("housing", 1),
  T("rent", 0.8), T("debt", 1), T("budget", 1), T("trade", 0.8),
  T("exports", 1), T("imports", 1), T("manufacturing", 1.5), T("factory", 1),
  T("industries", 0.8), T("consumer goods", 1.5), T("retail", 1),
  T("groceries", 1.2), T("energy bills", 1.2), T("household", 0.8),
  // — en: personal-finance columns (MarketWatch / Yahoo signature shape) —
  T("inherited", 1.5), T("inheritance", 1.5), T("retirement", 1.5),
  T("retire", 1.2), T("401(k)", 2.5), T("ira", 1.5), T("portfolio", 1.5),
  T("investing", 1.2), T("investors", 1.2), T("investor", 1.2),
  T("college", 0.8), T("student loan", 1.5), T("credit card", 1.5),
  T("health insurance", 2), T("premiums", 1.2), T("overpaying", 1),
  T("worth it", 0.8), T("financial adviser", 1.5), T("net worth", 1.5),
  T("millionaire", 1.2), T("growth stocks", 2), T("stock picks", 2),
  T("dividend stocks", 2), T("upside", 1.2), T("returns", 0.8),
  T("valuation", 1.5),
];

/**
 * 政策政务 — ministries, regulators, rulemaking, courts, central-bank policy.
 *
 * PBOC instruments live here, not in markets: a 逆回购/MLF/LPR/降准 headline
 * is a policy action whose *effect* is on markets. The owner's test case makes
 * this explicit (`央行逆回购` → `policy`, `domestic: true`), and audit §3.3
 * classified 央行 1万亿买断式逆回购 under 政务 for the same reason.
 */
const POLICY: Term[] = [
  T("人民银行", 2), T("财政部", 3), T("发改委", 3), T("商务部", 3),
  T("证监会", 2.5), T("金融监管总局", 3), T("国务院", 3), T("工信部", 3),
  T("统计局", 3), T("市场监管总局", 3), T("网信办", 3), T("银保监", 3),
  T("外管局", 3), T("住建部", 3), T("能源局", 2.5), T("政治局", 3),
  T("国常会", 3), T("常务会议", 2.5), T("人大", 2), T("政协", 2),
  T("部委", 2), T("监管层", 2), T("央行", 2),
  // — zh: central-bank policy instruments —
  T("逆回购", 3), T("买断式逆回购", 3.5), T("MLF", 3), T("LPR", 3),
  T("降准", 3), T("降息", 1.5), T("存款准备金", 2.5), T("公开市场操作", 3),
  T("货币政策", 2.5), T("流动性投放", 2.5),
  // — zh: rulemaking & enforcement —
  T("印发", 2.5), T("部署", 1.5), T("约谈", 3), T("处罚", 1.5),
  T("惩处", 2.5), T("新规", 2.5), T("新规范", 2), T("征求意见", 2.5),
  T("试点", 1.5), T("十五五", 2.5), T("实施方案", 2), T("政策", 1.5),
  T("补贴", 1.5), T("反垄断", 2), T("立案调查", 2), T("座谈会", 1.5),
  T("签发", 2), T("批复", 2), T("偷逃税", 2.5), T("税务", 1.5),
  T("人事", 2), T("任免", 2.5), T("升任", 2), T("履新", 2), T("免职", 2.5),
  T("监管", 1.5), T("审批", 1.5), T("立法", 2), T("法案", 2),
  T("白皮书", 2), T("规划", 1),
  // — en —
  T("state council", 3), T("regulator", 2), T("regulators", 2),
  T("ministry", 2), T("policy switch", 2.5), T("policy", 1),
  T("treasury department", 2), T("congress", 1.5), T("lawmakers", 1.5),
  T("regulation", 1.5), T("antitrust", 1.5), T("subsidy", 1.5),
  T("subsidies", 1.5), T("civil servant", 2), T("ministers", 1.5),
  T("referendum", 1.5), T("tariff", 1.5), T("tax", 1), T("benefits", 1),
  T("jailed", 1.5), T("sentenced", 1.5), T("court rules", 1.5),
  T("sues", 1.5), T("probe", 1), T("lawsuit", 1), T("investigation", 1),
];

/** 国际时政 — geopolitics, conflict, elections, courts, non-financial world. */
const WORLD: Term[] = [
  T("地缘", 2.5), T("冲突", 2), T("战争", 2.5), T("空袭", 2.5), T("停火", 2.5),
  T("导弹", 2), T("军演", 2), T("选举", 2), T("大选", 2.5), T("公投", 2),
  T("议会", 1.5), T("总统", 2), T("总理", 2), T("首相", 2),
  T("外交部", 2), T("联合国", 2), T("峰会", 1.5), T("制裁", 2),
  T("难民", 2), T("枪击", 2.5), T("判决", 1.5), T("抗议", 2),
  T("示威", 2), T("政变", 3), T("内阁", 2), T("执政", 1.5),
  T("特朗普", 1.5), T("白宫", 2), T("普京", 2), T("泽连斯基", 2.5),
  T("内塔尼亚胡", 2.5), T("伊朗", 2.5), T("乌克兰", 2.5), T("俄罗斯", 2),
  T("以色列", 2.5), T("加沙", 2.5), T("朝鲜", 2), T("中东", 2),
  T("台海", 2), T("南海", 2), T("欧盟", 1.5), T("北约", 2),
  T("间谍", 2), T("国安", 2), T("辞呈", 1.5), T("辞职", 1),
  T("外交", 2), T("军方", 2), T("袭击", 2), T("伤亡", 2),
  T("边境", 1.5), T("地震", 2), T("洪水", 2), T("台风", 1.5),
  T("难民危机", 2.5), T("主权", 2), T("领土", 2),
  // — en: countries & regions come from the shared COUNTRIES table —
  ...COUNTRIES.map((c) => T(c.term, c.world)),
  // — en: world-desk event vocabulary —
  T("geopolitics", 2.5), T("border", 1.5), T("refugee", 2), T("aid groups", 2),
  T("human rights", 2), T("rights groups", 2), T("activists", 2),
  T("crackdown", 2.5), T("restrictions", 1.5), T("ban", 1.5), T("banned", 1.5),
  T("police", 1.5), T("investigators", 1.5), T("arrested", 2), T("charged", 1.5),
  T("suspect", 1.5), T("missing", 1.5), T("rescued", 1.5), T("injured", 1.5),
  T("dispute", 2), T("tribunal", 2.5), T("legal battle", 2.5),
  T("territorial", 2.5), T("sovereignty claim", 3), T("diplomatic row", 2.5),
  T("earthquake", 2.5), T("flood", 2), T("storm", 1.5), T("wildfire", 2),
  T("hurricane", 2), T("typhoon", 2), T("disaster", 1.5), T("epidemic", 2),
  T("pandemic", 2), T("disease", 1.5), T("poisoning", 2), T("hoax", 2),
  T("evacuations", 2), T("embassy", 2), T("sovereignty", 2), T("blockade", 2),
  T("insurgents", 2.5), T("militants", 2.5), T("rebel", 2), T("militia", 2.5),
  T("coup", 3), T("dictator", 2.5), T("authoritarian", 2), T("regime", 1.5),
  T("immigration", 1.5), T("asylum", 2), T("deport", 2), T("border security", 2),
  // — en: conflict, diplomacy, politics, environment, justice —
  T("election", 2), T("ceasefire", 2.5), T("missile", 2), T("troops", 2),
  T("summit", 1.5), T("sanctions", 2), T("protest", 2), T("strike", 1),
  T("airstrike", 2.5), T("air strike", 2.5), T("war", 1.5), T("invasion", 2),
  T("gaza", 2.5), T("ukraine", 2.5), T("israel", 2.5), T("iran", 2.5),
  T("russia", 2), T("putin", 2), T("zelensky", 2.5), T("trump", 1.5),
  T("white house", 2), T("kremlin", 2.5), T("nato", 2), T("united nations", 2),
  T("diplomacy", 2), T("diplomatic", 2), T("envoy", 1.5), T("ambassador", 2),
  T("president", 1.5), T("prime minister", 1.5), T("parliament", 2),
  T("senate race", 2.5), T("midterms", 2.5), T("coalition", 1.5),
  T("military", 1.5), T("navy", 1.5), T("warship", 2.5), T("drone", 1.5),
  T("killed", 1.5), T("deadly", 1.5), T("shooting", 2), T("blast", 1.5),
  T("refugees", 2), T("humanitarian", 2), T("famine", 2), T("drought", 2),
  T("ebola", 2), T("virus", 1.5), T("outbreak", 1.5), T("climate", 1.5),
  T("court", 1.5), T("jailed", 1.5), T("verdict", 2), T("treason", 2.5),
  T("spy", 2), T("espionage", 2.5), T("resigns", 1.5),
  T("mosque", 2.5), T("palestine", 2.5), T("palestinian", 2.5),
  T("journalist", 2), T("press freedom", 2.5), T("news media", 2),
  T("armed groups", 2.5), T("armed group", 2.5), T("state loses ground", 2.5),
  T("houthis", 2.5), T("taliban", 2.5), T("export controls", 2),
  T("territory", 1.5), T("island", 1.2), T("memorial", 2), T("veterans", 2),
  T("military guard", 2.5), T("bomb hoax", 3), T("evacuated", 2),
  T("airport", 1.5), T("flight", 1.2), T("airline", 1.5),
  // — en: remaining general-news beats (politics, sport, culture, science) —
  T("senator", 2), T("senate", 2), T("governor", 1.5), T("mayor", 2),
  T("democrat", 2), T("democrats", 2), T("republican", 2), T("republicans", 2),
  T("labour party", 2.5), T("conservatives", 2), T("campaign", 1),
  T("nba", 2.5), T("nfl", 2.5), T("wta", 2.5), T("atp", 2.5), T("fifa", 2.5),
  T("olympics", 2.5), T("world cup", 2.5), T("cricket", 2.5), T("tennis", 2.5),
  T("football", 2), T("soccer", 2.5), T("basketball", 2.5), T("coach", 1.2),
  T("museum", 2), T("film", 1.5), T("movie", 1.5), T("album", 2), T("novel", 2),
  T("author", 1.2), T("artist", 1.5), T("festival", 1.5), T("podcast", 1.5),
  T("scientists", 2), T("researchers", 1.5), T("study finds", 2),
  T("species", 2), T("climate change", 2), T("emissions", 1.5),
  T("pollution", 1.5), T("wood-burning", 1.5), T("heat pump", 2),
  T("dementia", 2), T("memory care", 2.5), T("social security", 2),
  T("ponzi", 2.5), T("parenting", 1.5), T("school", 1), T("university", 1.2),
  T("students", 1.2), T("teachers", 1.5), T("curriculum", 2),
  T("汽车", 1.5), T("车企", 2), T("轿跑", 2), T("豪车", 2), T("车型", 1.5),
  T("风机", 2), T("航天", 2), T("卫星", 2), T("火箭", 2), T("天问", 2.5),
  T("高校", 1.5), T("大学", 1.5), T("校长", 2), T("教育", 1.5),
  T("影视", 2), T("电影", 2), T("剧集", 2), T("文化", 1.5),
  T("诈骗", 2), T("非法集资", 2.5), T("刑事案件", 2), T("最高法", 2.5),
  T("核污染", 2.5), T("排放", 1.5), T("生态", 1.5), T("环保", 1.5),
  T("降雨", 1.5), T("暴雨", 1.5), T("冷空气", 1.5),
];

/** 科技AI — AI capex, chips, model releases, platform giants. */
const TECH_AI: Term[] = [
  T("英伟达", 3), T("黄仁勋", 3), T("OpenAI", 3), T("Anthropic", 3),
  T("ChatGPT", 2.5), T("Claude", 2), T("Gemini", 2), T("DeepSeek", 3),
  T("大模型", 2.5), T("人工智能", 2.5), T("算力", 2.5), T("数据中心", 2),
  T("芯片", 2), T("半导体", 2), T("存储芯片", 2.5), T("晶圆", 2),
  T("光刻", 2), T("台积电", 2.5), T("GPU", 2.5), T("光模块", 2),
  T("光通信", 2), T("微软", 2), T("谷歌", 2), T("苹果", 1.5),
  T("特斯拉", 2), T("亚马逊", 1.5), T("SpaceX", 2), T("机器人", 2),
  T("人形机器人", 2.5), T("自动驾驶", 2.5), T("智能驾驶", 2.5),
  T("无人车", 2), T("量子", 2), T("智能体", 2), T("开源", 1.5),
  T("月之暗面", 2.5), T("长鑫", 2.5), T("大语言模型", 2.5),
  T("nvidia", 3), T("jensen huang", 3), T("openai", 3), T("anthropic", 3),
  T("chatgpt", 2.5), T("claude", 2), T("deepseek", 3), T("gemini", 2),
  T("cerebras", 2.5), T("coreweave", 2.5), T("nebius", 2.5), T("tsmc", 2.5),
  T("chipmaker", 2.5), T("chipmaking", 2.5), T("semiconductor", 2),
  T("semiconductors", 2), T("chips", 1.5), T("gpu", 2.5), T("data center", 2),
  T("data centre", 2), T("artificial intelligence", 2.5), T("a.i.", 2),
  T("ai", 1.5), T("chatbot", 2), T("llm", 2), T("model", 1),
  T("microsoft", 2), T("google", 2), T("apple", 1.5), T("tesla", 2),
  T("spacex", 2), T("meta", 1.5), T("amazon", 1.5), T("robotics", 2),
  T("robot", 1.5), T("autonomous", 2), T("self-driving", 2.5), T("quantum", 2),
  T("agentic", 2), T("open-weight", 2.5), T("open source", 1.5),
  T("cloud computing", 2), T("software", 1), T("startup", 1),
  // — crypto/web3 product copy (attentionvc-ai feeds it into finance) —
  T("mainnet", 3), T("testnet", 3), T("token", 1.5), T("tokens", 1.2),
  T("tokenized", 2), T("stablecoin", 2.5), T("stablecoins", 2.5),
  T("defi", 2.5), T("web3", 2.5), T("blockchain", 2), T("ledger", 1.2),
  T("wallet", 1.5), T("airdrop", 2.5), T("mint", 1.5), T("onchain", 2),
  T("protocol", 1), T("devnet", 2.5),
];

/** 公司公告 — filings, corporate actions, results, deals. */
const FILINGS: Term[] = [
  T("回购", 2.5), T("增持", 2), T("减持", 2.5), T("定增", 2.5),
  T("可转债", 2), T("配股", 2), T("并购", 2.5), T("重组", 2), T("合并", 2),
  T("收购", 2), T("要约收购", 2.5), T("中标", 2.5), T("签署", 2),
  T("业绩预告", 3), T("业绩快报", 3), T("业绩", 1.5), T("财报", 2.5),
  T("季报", 2), T("年报", 1.5), T("营收", 1.5), T("净利润", 2),
  T("每股收益", 2.5), T("EPS", 1.5), T("分红", 2), T("派息", 2),
  T("停牌", 2.5), T("复牌", 2.5), T("过会", 2.5), T("招股", 2),
  T("IPO", 2), T("上市辅导", 2.5), T("股东大会", 2), T("董事会", 1.5),
  T("公告", 1.5), T("澄清", 1.5), T("问询函", 2.5), T("监管函", 2.5),
  T("股权激励", 2), T("质押", 1.5), T("解禁", 1.5), T("重大合同", 2.5),
  T("业绩指引", 2), T("上调全年", 2), T("下调全年", 2),
  T("earnings", 2), T("revenue", 1.5), T("buyback", 1.5), T("guidance", 1.5),
  T("quarterly results", 2.5), T("profit warning", 2.5), T("filing", 1.5),
  T("acquisition", 2), T("merger", 2), T("acquires", 2), T("takeover", 2),
  T("hostile bid", 2.5), T("stake sale", 2.5), T("takes a stake", 2.5),
  T("share sale", 2), T("stock offering", 2), T("places shares", 2.5),
  T("private placement", 2.5), T("raises $", 2), T("valuation", 1.5),
  T("ipo", 2), T("debut", 1.5), T("beats estimates", 2.5),
  T("misses estimates", 2.5), T("beats on", 2), T("tops estimates", 2.5),
  T("profit", 1), T("loss", 1), T("payout", 1.5), T("shares", 1),
  T("stock split", 2.5), T("resign", 1), T("steps down", 1.5),
  T("appointed", 1.5),
];

/** 观点解读 — broker notes, interviews, long-form analysis. */
const OPINION: Term[] = [
  T("研报", 3), T("评级", 2), T("目标价", 2.5), T("看好", 1.5),
  T("对话", 2.5), T("访谈", 2.5), T("展望", 1.5), T("解读", 2),
  T("深度", 1.5), T("专访", 2.5), T("观察", 1.5), T("评论", 2),
  T("社论", 2.5), T("专栏", 2), T("观点", 2), T("前瞻", 1.5),
  T("快评", 2), T("策略报告", 2.5), T("晨会", 2), T("中信证券", 2.5),
  T("中金", 2), T("国泰君安", 2.5), T("华泰证券", 2.5), T("招商证券", 2.5),
  T("广发证券", 2.5), T("申万宏源", 2.5), T("海通证券", 2.5),
  T("兴业证券", 2.5), T("民生证券", 2.5), T("天风证券", 2.5),
  T("长江证券", 2.5), T("高盛", 2), T("摩根士丹利", 2), T("摩根大通", 2),
  T("瑞银", 2), T("野村", 2), T("美银", 2), T("花旗", 2),
  T("analysis", 2), T("analysts", 1.5), T("analyst", 1.5),
  T("opinion", 2), T("commentary", 2), T("outlook", 1.5),
  T("explainer", 2), T("column", 2), T("what to know", 1.5),
  T("interview", 1.5), T("says", 1), T("warns", 1.5), T("argues", 1.5),
  T("editorial", 2.5), T("briefing", 1.5), T("lesson", 1),
  T("goldman", 2), T("morgan stanley", 2), T("jpmorgan", 2), T("ubs", 2),
  T("nomura", 2), T("citi", 2), T("hsbc", 2), T("barclays", 2),
  T("upgraded", 2), T("downgraded", 2), T("price target", 2.5),
  T("rating", 1.5), T("buy rating", 2.5), T("what it means", 2),
  T("here's what", 1.5), T("how to", 1.5), T("why", 1),
  T("the return of", 1.5), T("the future of", 1.5), T("the case for", 2),
  T("the case against", 2), T("what now", 1.5), T("what next", 1.5),
  T("is dead", 1.5), T("is over", 1.2), T("a warning", 1.5),
  T("lessons from", 2), T("why it matters", 2), T("the trouble with", 2),
  T("in defence of", 2), T("in defense of", 2), T("haunt", 1),
  T("weird", 0.8), T("absurdity", 1.5), T("serious reform", 2),
  T("shock", 1), T("crisis", 1), T("squeeze", 1), T("boom", 1.2),
  T("bubble", 1.5), T("inequality", 1.5),
];

export const TOPIC_TERMS: Readonly<Record<TopicKey, readonly Term[]>> = {
  "global-markets": GLOBAL_MARKETS,
  world: WORLD,
  "tech-ai": TECH_AI,
  policy: POLICY,
  filings: FILINGS,
  opinion: OPINION,
};

// ---------------------------------------------------------------------------
// Structural shapes
// ---------------------------------------------------------------------------

/** Verbs that make a 公司公告 filing recognizable by shape alone. */
const FILING_VERBS = [
  "回购", "增持", "减持", "定增", "可转债", "配股", "并购", "重组", "中标",
  "签署", "业绩预告", "业绩快报", "分红", "派息", "停牌", "复牌", "过会",
  "招股", "问询函", "监管函", "股权激励", "质押", "解禁", "收购", "澄清",
];

/** Corporate suffixes that make a `名称：` prefix an issuer, not a section. */
const ISSUER_SUFFIX = [
  "股份", "集团", "控股", "有限公司", "公司", "科技", "银行", "证券", "基金",
  "能源", "医药", "电气", "汽车", "电子", "实业", "资本",
];

/**
 * Section words that look like an issuer prefix but are editorial labels
 * (分析：…, 解读：…) and must not trigger the filing boost.
 */
const SECTION_PREFIX = new Set([
  "分析", "观点", "解读", "观察", "深度", "研报", "图解", "专题", "快讯",
  "早报", "晨报", "要闻", "数据", "评论", "焦点", "专访", "独家", "重磅",
  "突发", "注意", "最新", "快评", "社论", "专栏", "前瞻", "策略", "盘前",
  "盘中", "盘后", "午评", "收评", "财经", "国际", "国内", "全球", "市场",
  "美股", "A股", "港股", "公司", "行业", "宏观", "今日", "昨日", "会员",
]);

/** Broker names used for the opinion-shape boost. */
const BROKERS = [
  "中信证券", "中金公司", "中金", "国泰君安", "华泰证券", "招商证券",
  "广发证券", "申万宏源", "海通证券", "兴业证券", "民生证券", "天风证券",
  "长江证券", "东方证券", "光大证券", "高盛", "摩根士丹利", "摩根大通",
  "瑞银", "野村", "美银", "花旗",
];

// ---------------------------------------------------------------------------
// Matching primitives
// ---------------------------------------------------------------------------

/**
 * Strip wire prefixes that poison keyword matching and title dedupe:
 * `【财联社11月13日电】`, `财联社11月13日电，`, `金十数据…`, and a bare
 * leading `11月13日`. Deliberately conservative — only leading positions are
 * touched, so a date inside a headline stays intact.
 */
export function normalizeTitle(raw: string): string {
  let s = (raw ?? "").trim();
  for (let i = 0; i < 4; i++) {
    const before = s;
    s = s.replace(/^[【\[][^】\]]{0,40}[】\]]\s*/, "");
    s = s.replace(
      /^(财联社|金十数据|金十快讯|金十|华尔街见闻快讯|华尔街见闻|第一财经|东方财富快讯|东方财富|快讯)\s*/,
      "",
    );
    s = s.replace(/^\d{1,2}月\d{1,2}日(电|讯|消息|报道)?\s*[，,：:、]?\s*/, "");
    if (s === before) break;
  }
  return s.trim();
}

const ASCII_START = /^[A-Za-z]/;
const ASCII_END = /[A-Za-z0-9]$/;
const CJK_GLOBAL = /[\u4e00-\u9fff]/g;

function cjkCount(text: string): number {
  return (text.match(CJK_GLOBAL) ?? []).length;
}

function isWordChar(ch: string | undefined): boolean {
  return ch !== undefined && /[A-Za-z0-9]/.test(ch);
}

interface SurfaceHit {
  term: string;
  weight: number;
  score: number;
}

/**
 * Longest-term-first scan of one table over one surface. Occurrences falling
 * inside an already-matched longer term are absorbed (芯片 inside 存储芯片
 * doesn't double-count). ASCII terms match case-insensitively on word
 * boundaries so `ai` doesn't fire inside `said`.
 */
function scanTable(table: readonly Term[], hay: string, surfaceWeight: number): SurfaceHit[] {
  const spans: Array<[number, number]> = [];
  const out: SurfaceHit[] = [];
  for (const { term, weight } of table) {
    const ascii = ASCII_START.test(term);
    const needle = ascii ? term.toLowerCase() : term;
    let from = 0;
    let hits = 0;
    while (hits < 3) {
      const idx = hay.indexOf(needle, from);
      if (idx < 0) break;
      const end = idx + needle.length;
      const inside = spans.some(([s, e]) => idx >= s && end <= e);
      const okLeft = !ascii || !isWordChar(hay[idx - 1]);
      const okRight = !ASCII_END.test(term) || !isWordChar(hay[end]);
      if (!inside && okLeft && okRight) {
        spans.push([idx, end]);
        hits++;
      }
      from = end;
    }
    if (hits > 0) out.push({ term, weight, score: weight * hits * surfaceWeight });
  }
  return out;
}

/** Sum of distinct anchor weights present on a surface (anchors don't stack). */
function anchorWeight(terms: readonly Term[], hay: string): number {
  let total = 0;
  for (const { term, weight } of terms) {
    const ascii = ASCII_START.test(term);
    const needle = ascii ? term.toLowerCase() : term;
    if (!hay.includes(needle)) continue;
    // ASCII anchors must sit on a word boundary, so `us` doesn't fire inside
    // `thus` and `ban` doesn't fire inside `urban`.
    if (ascii) {
      let from = 0;
      let found = false;
      while (!found) {
        const idx = hay.indexOf(needle, from);
        if (idx < 0) break;
        const end = idx + needle.length;
        if (!isWordChar(hay[idx - 1]) && !isWordChar(hay[end])) found = true;
        else from = end;
      }
      if (!found) continue;
    }
    total += weight;
  }
  return total;
}

// ---------------------------------------------------------------------------
// Axis A — lane
// ---------------------------------------------------------------------------

/**
 * Lane is a *language* axis, decided by the script of the article's own text,
 * not by the source's country of interest. A Chinese-language story about the
 * S&P 500 is `zh`; an English-language Bloomberg story about the PBOC is
 * `external`.
 *
 * Script is preferred over the source's declared `lang` because a single feed
 * can carry both (财新 publishes EN items, DW 中文 publishes Chinese), and what
 * the reader experiences is decided by the words on the page.
 */
function detectLane(
  title: string,
  body: string,
  langHint?: "zh" | "en",
): { lane: LaneKey; confidence: number } {
  const titleCjk = cjkCount(title);
  const bodyCjk = cjkCount(body);
  if (titleCjk >= 2) return { lane: "zh", confidence: 0.97 };
  if (titleCjk === 1) return { lane: "zh", confidence: 0.8 };
  if (bodyCjk >= 4) return { lane: "zh", confidence: 0.7 };
  if (title.trim() || body.trim()) return { lane: "external", confidence: 0.9 };
  // No readable text at all — fall back to the source's declared language.
  if (langHint === "zh") return { lane: "zh", confidence: 0.35 };
  return { lane: "external", confidence: 0.35 };
}

// ---------------------------------------------------------------------------
// Axis B — topic, plus the domestic tag
// ---------------------------------------------------------------------------

function issuerPrefix(title: string): string | null {
  const m = title.match(/^([^：:｜|]{2,12})[：:]/);
  if (!m) return null;
  const prefix = m[1].trim();
  if (SECTION_PREFIX.has(prefix)) return null;
  if (ISSUER_SUFFIX.some((s) => prefix.endsWith(s))) return prefix;
  if (/^[A-Z][A-Za-z.&' -]{1,12}$/.test(prefix)) return prefix;
  return null;
}

function hasStockCode(title: string): boolean {
  return (
    /(^|[^\d])\d{6}([^\d]|$)/.test(title) ||
    /\((sh|sz|hk)?\d{4,6}(\.\w{2})?\)/i.test(title)
  );
}

/** 公司公告 shape: `发行人：<filing verb>`, or a stock code plus a filing verb. */
function filingShapeScore(title: string): number {
  const hasVerb = FILING_VERBS.some((v) => title.includes(v));
  const prefix = issuerPrefix(title);
  const code = hasStockCode(title);
  if (hasVerb && prefix) return 6;
  if (hasVerb && code) return 4;
  if (prefix && /公告|披露|声明/.test(title)) return 3;
  return 0;
}

/** 观点解读 shape: broker-prefixed note, or an editorial long-form marker. */
function opinionShapeScore(title: string): number {
  let score = 0;
  const m = title.match(/^([^：:｜|]{2,12})[：:]/);
  if (m && BROKERS.some((b) => m[1].includes(b))) score += 8;
  if (/^(图解|解读|深度|研报|专访|观察|评论|社论|专栏|快评|晨会|策略|前瞻|对话)/.test(title)) {
    score += 3;
  }
  if (/^(analysis|opinion|commentary|explainer|column)\b/i.test(title)) score += 3;
  if (/观察[｜|：:]/.test(title)) score += 2;
  return score;
}

// ---------------------------------------------------------------------------
// Classifier
// ---------------------------------------------------------------------------

/** Below this, a win is thin evidence rather than a confident route. */
export const LOW_CONFIDENCE = 0.5;

/**
 * Weight of the source-metadata prior. Deliberately small: one strong title
 * term (weight ≥2, ×2 title multiplier) already outranks it, so the prior
 * only decides headlines that carry no dictionary evidence at all. This is
 * what keeps the source registry a fallback rather than the router.
 */
export const SOURCE_PRIOR_WEIGHT = 2;

const TOPIC_KEYS_RUNTIME: readonly TopicKey[] = TOPICS.map((t) => t.key);

const SORTED_TABLES = Object.fromEntries(
  TOPIC_KEYS_RUNTIME.map((k) => [
    k,
    [...TOPIC_TERMS[k]].sort((a, b) => b.term.length - a.term.length),
  ]),
) as Record<TopicKey, Term[]>;

function round3(n: number): number {
  return Math.round(n * 1000) / 1000;
}

/** Fallback when no topic rule fires: most specific source metadata wins. */
function fallbackTopic(input: ClassifyInput): TopicKey {
  try {
    const sub = input.subcategory ? FALLBACK_TOPIC_BY_SUBCATEGORY[input.subcategory] : undefined;
    return sub ?? FALLBACK_TOPIC_BY_CATEGORY[input.category ?? "finance"];
  } catch {
    return FALLBACK_TOPIC_BY_CATEGORY.finance;
  }
}

function emptyScores(): Record<TopicKey, number> {
  const out = {} as Record<TopicKey, number>;
  for (const k of TOPIC_KEYS_RUNTIME) out[k] = 0;
  return out;
}

/**
 * Classify one article on both axes. Never throws: on any internal failure it
 * returns source-metadata fallbacks, so a caller can stay non-fatal.
 */
export function classifyArticle(input: ClassifyInput): ClassifyResult {
  try {
    return classifyInner(input);
  } catch {
    const lane: LaneKey = input?.lang === "zh" ? "zh" : "external";
    return {
      lane,
      laneConfidence: 0,
      topic: fallbackTopic(input ?? { title: "" }),
      topicConfidence: 0,
      domestic: FALLBACK_DOMESTIC_BY_LANE[lane],
      domesticConfidence: 0,
      matched: [],
      fallback: true,
      domesticFallback: true,
    };
  }
}

function classifyInner(input: ClassifyInput): ClassifyResult {
  const title = normalizeTitle(input.title ?? "");
  const body = (input.summary || input.excerpt || "").slice(0, 500);
  const titleHay = title.toLowerCase();
  const bodyHay = body.toLowerCase();

  // ---- Axis A: lane -------------------------------------------------------
  const { lane, confidence: laneConfidence } = detectLane(title, body, input.lang);

  // ---- Axis B: topic ------------------------------------------------------
  const scores = emptyScores();
  const matchedByScore = new Map<string, number>();

  for (const key of TOPIC_KEYS_RUNTIME) {
    const table = SORTED_TABLES[key];
    for (const h of [
      ...scanTable(table, titleHay, 2),
      ...scanTable(table, bodyHay, 1),
    ]) {
      scores[key] += h.score;
      matchedByScore.set(h.term, (matchedByScore.get(h.term) ?? 0) + h.score);
    }
  }

  scores.filings += filingShapeScore(title);
  scores.opinion += opinionShapeScore(title);

  // Evidence from real signals, before the source prior is added. Used to
  // decide whether this article was genuinely rule-classified.
  const evidenceScore = Math.max(...TOPIC_KEYS_RUNTIME.map((k) => scores[k]));

  // Source prior: a weak tie-breaker for headlines with no lexical evidence.
  const prior = fallbackTopic(input);
  scores[prior] += SOURCE_PRIOR_WEIGHT;

  // Winner: highest score; ties break toward the earlier declared topic.
  let best: TopicKey = TOPIC_KEYS_RUNTIME[0];
  let bestScore = -1;
  let secondScore = 0;
  for (const key of TOPIC_KEYS_RUNTIME) {
    const s = scores[key];
    if (s > bestScore) {
      secondScore = Math.max(bestScore, secondScore);
      bestScore = s;
      best = key;
    } else if (s > secondScore) {
      secondScore = s;
    }
  }

  const matched = [...matchedByScore.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, 8)
    .map(([t]) => t);

  // ---- domestic tag -------------------------------------------------------
  // Venue is a tag, not a route: weigh China-oriented evidence against
  // offshore evidence and let the stronger side win. With no geographic
  // evidence at all, fall back to the lane default — Chinese-language copy is
  // domestic unless it names an offshore venue, and vice versa.
  const domesticScore =
    anchorWeight(DOMESTIC_ANCHOR, titleHay) * 2 + anchorWeight(DOMESTIC_ANCHOR, bodyHay);
  const foreignScore =
    anchorWeight(FOREIGN_ANCHOR, titleHay) * 2 + anchorWeight(FOREIGN_ANCHOR, bodyHay);
  // A 6-digit A-share code is itself a domestic-issuer signal — the ticker
  // only exists on the Shanghai/Shenzhen exchanges, whatever else the
  // headline mentions.
  const codeBonus = hasStockCode(title) ? 8 : 0;
  const issuerBonus = issuerPrefix(title) ? 5 : 0;
  const domesticEvidence = domesticScore + codeBonus + issuerBonus;
  const geoTotal = domesticEvidence + foreignScore;
  const tie = domesticEvidence === foreignScore;
  const domestic = tie
    ? FALLBACK_DOMESTIC_BY_LANE[lane]
    : domesticEvidence > foreignScore;
  const domesticFallback = geoTotal === 0 || tie;
  const domesticConfidence = round3(
    geoTotal === 0
      ? 0.2
      : Math.min(0.95, 0.4 + (0.6 * Math.abs(domesticEvidence - foreignScore)) / geoTotal),
  );

  // ---- topic confidence ---------------------------------------------------
  if (evidenceScore <= 0) {
    return {
      lane,
      laneConfidence,
      topic: prior,
      topicConfidence: 0.15,
      domestic,
      domesticConfidence,
      matched,
      fallback: true,
      domesticFallback,
    };
  }

  const strength = 1 - Math.exp(-evidenceScore / 6);
  const dominance = (bestScore - secondScore) / bestScore;
  let topicConfidence = 0.55 * strength + 0.45 * dominance;
  if (evidenceScore < 3) topicConfidence = Math.min(topicConfidence, LOW_CONFIDENCE);
  topicConfidence = Math.max(0.05, Math.min(0.99, round3(topicConfidence)));

  return {
    lane,
    laneConfidence,
    topic: best,
    topicConfidence,
    domestic,
    domesticConfidence,
    matched,
    fallback: false,
    domesticFallback,
  };
}

/**
 * Defensive shallow copy. `{...a}` runs getters, so a hostile object can throw
 * during the copy itself — which would then throw again inside the caller's
 * catch. Copying through a guarded, key-by-key loop keeps the failure
 * contained to the one field we cannot read.
 */
function safeCopy<T extends object>(a: T): T {
  try {
    return { ...a };
  } catch {
    const out = {} as Record<string, unknown>;
    try {
      for (const k of Object.keys(a)) {
        try {
          out[k] = (a as Record<string, unknown>)[k];
        } catch {
          // unreadable field — omit it rather than lose the whole article
        }
      }
    } catch {
      // unenumerable object — return whatever we managed to read
    }
    return out as T;
  }
}

/** The six fields this module adds to an article. */
export interface TopicTag {
  lane: LaneKey;
  laneConfidence: number;
  topic: TopicKey;
  topicConfidence: number;
  domestic: boolean;
  domesticConfidence: number;
}

/**
 * Batch helper — one bad article can never abort the caller's run.
 *
 * `subcategoryOf` is a resolver rather than a field on the article: the
 * source's subcategory is classifier input, never sidecar output, so it must
 * not leak into the tagged objects.
 */
export function classifyAll<
  T extends {
    title: string;
    excerpt?: string;
    summary?: string;
    category?: Category;
    subcategory?: string;
    sourceId?: string;
    lang?: "zh" | "en";
  },
>(articles: T[], subcategoryOf?: (a: T) => string | undefined): Array<T & TopicTag> {
  return articles.map((a) => {
    const copy = safeCopy(a);
    try {
      const sub = copy.subcategory ?? subcategoryOf?.(copy);
      const r = classifyArticle({ ...copy, subcategory: sub });
      return {
        ...copy,
        lane: r.lane,
        laneConfidence: r.laneConfidence,
        topic: r.topic,
        topicConfidence: r.topicConfidence,
        domestic: r.domestic,
        domesticConfidence: r.domesticConfidence,
      };
    } catch {
      return {
        ...copy,
        lane: "external" as LaneKey,
        laneConfidence: 0,
        topic: "global-markets" as TopicKey,
        topicConfidence: 0,
        domestic: false,
        domesticConfidence: 0,
      };
    }
  });
}
