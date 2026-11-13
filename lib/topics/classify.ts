/**
 * Deterministic article → topic classifier (shadow mode).
 *
 * Zero network, zero LLM, zero randomness: a weighted dictionary scan over
 * the title (×2) and the excerpt/summary (×1), mirroring the house style of
 * `lib/nlp/sentiment.ts`. Every article gets exactly one topic from
 * `TOPICS` plus a confidence and the terms that fired, so a wrong route can
 * be debugged from `matched` instead of guessed at.
 *
 * Design notes
 * ------------
 * - **Weighted scoring, not first-match.** The audit's precedence list
 *   (filing shape → policy → foreign anchor → tech → domestic market →
 *   opinion) is encoded as weights plus two structural boosts (filing and
 *   opinion shape). A first-match if-chain lets one stray term (英伟达 inside
 *   a broker note) hijack a headline; scoring lets the structurally stronger
 *   signal win.
 * - **Foreign damping.** When foreign/offshore anchors fire and no domestic
 *   anchor does, `cn-finance` is scaled down. That is the direct fix for the
 *   财联社 failure mode: 66% of one 24-slot panel was foreign wire copy
 *   tagged as domestic finance.
 * - **Category is a fallback, never the router.** An article only lands on
 *   its source's declared category when no rule fires at all, so the
 *   registry stays the source of truth for sources without becoming the
 *   classifier.
 * - **Bilingual by construction.** Roughly two thirds of the fetched corpus
 *   is English (all `finance:wire` and `politics:world` sources), so every
 *   topic table carries both Chinese and English terms rather than treating
 *   English as an afterthought.
 * - `TOPIC_TERMS` is one exported table; a curated override or a per-source
 *   `defaultTopic` (increment 2) can layer on without touching this logic.
 */

import type { Category } from "../sources/types";
import {
  FALLBACK_TOPIC_BY_CATEGORY_AND_SCRIPT,
  FALLBACK_TOPIC_BY_SUBCATEGORY,
  TOPICS,
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
}

export interface ClassifyResult {
  topic: TopicKey;
  /** 0..1. Below `LOW_CONFIDENCE` means thin or contested evidence. */
  confidence: number;
  /** Dictionary terms that fired, strongest first — transparency only. */
  matched: string[];
  /** True when no rule fired and the category fallback decided. */
  fallback: boolean;
}

interface Term {
  /** ASCII terms match case-insensitively on word boundaries; CJK verbatim. */
  term: string;
  weight: number;
}

const T = (term: string, weight = 1): Term => ({ term, weight });

// ---------------------------------------------------------------------------
// Dictionary tables — the editable vocabulary surface.
// ---------------------------------------------------------------------------

/**
 * Countries and regions — ONE table feeding both the `world` lexicon and the
 * offshore-damping anchors.
 *
 * These were separate literal lists during development and immediately
 * drifted (`italy` sat in the anchor list while `italian` sat in the world
 * list), which silently disabled damping for any headline using the demonym.
 * A single source with an explicit world weight and anchor weight keeps the
 * two uses consistent — add a country here and both behaviours update.
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

/** 国内财经 — onshore market plumbing, A-share structure, RMB, domestic macro. */
const CN_FINANCE: Term[] = [
  T("A股", 3), T("沪指", 3), T("上证指数", 3), T("上证", 2), T("深成指", 2),
  T("深证", 2), T("创业板", 2), T("科创板", 2), T("北交所", 2), T("沪深", 2),
  T("中证", 1.5), T("港股", 2), T("恒生指数", 2), T("恒指", 2), T("恒生", 1.5),
  T("涨停", 3), T("跌停", 3), T("北向资金", 3), T("北向", 2), T("南向", 2),
  T("两融", 2), T("社融", 2.5), T("M2", 2), T("LPR", 2.5), T("MLF", 2.5),
  T("逆回购", 2.5), T("降准", 2.5), T("存款准备金", 2), T("社零", 2),
  T("人民币", 2), T("中间价", 2), T("在岸", 1.5), T("离岸人民币", 1.5),
  T("成交额", 1.5), T("两市", 1.5), T("主力资金", 2), T("板块", 1),
  T("公募", 2), T("私募", 2), T("基金", 1), T("ETF", 2), T("险资", 2),
  T("银行", 1), T("保险", 1), T("券商", 1.5), T("股市", 2), T("救市", 3),
  T("楼市", 2), T("房地产", 2), T("房价", 2), T("土地出让", 2),
  T("新股", 1.5), T("打新", 2), T("破发", 2), T("中概股", 2),
  T("CPI", 1.5), T("PPI", 1.5), T("PMI", 1.5), T("社会消费品零售", 2),
  T("专项债", 2), T("地方债", 2), T("国债", 1.5), T("汇率", 1.5),
  T("双十一", 1.5), T("内需", 1.5), T("出口", 1.5), T("进口", 1.5),
  T("贸易顺差", 2), T("制造业", 1.5), T("工业增加值", 2), T("养老金", 1.5),
  T("社保", 1), T("地方债发行", 2),
  // — en: onshore market plumbing —
  T("a-shares", 3), T("shanghai composite", 3), T("csi 300", 3),
  T("china stocks", 2.5), T("chinese stocks", 2.5), T("chinese investors", 2.5),
  T("china's economy", 2.5), T("china market", 1.5), T("china internet", 2),
  T("hong kong stocks", 2.5), T("hang seng", 2.5), T("pboc", 3),
  T("yuan", 2), T("onshore", 2), T("dividend", 1.5), T("blue-chip", 1.5),
  T("stock market", 1.5), T("shareholders", 1.5), T("bond market", 1.5),
  T("mortgage", 1.5), T("home sales", 2), T("homebuyers", 2), T("renters", 1.5),
  T("inflation", 1.5), T("consumer prices", 2), T("retail sales", 2),
  T("interest rate", 1.5), T("rate cut", 2), T("rate hike", 2),
  T("asset managers", 1.5), T("lenders", 1.5),
  // — en: macro commentary / financial-sector beat (Economist, FT, WSJ) —
  T("economist", 2), T("economics", 1.5), T("macroeconomics", 2.5),
  T("monetary", 2), T("hierarchy of money", 3), T("money supply", 2.5),
  T("central banker", 2.5),   T("financial services", 2.5), T("market talk", 2.5),
  T("roundup", 1.5), T("stock-picking", 2.5), T("stock pickers", 2.5),
  T("fund manager", 2), T("sale process", 2),
  T("puts itself up for sale", 3), T("rescue deal", 2.5), T("collapse", 1.2),
  T("luxury", 1.2), T("slump", 1.2), T("trade war", 2.5),
  T("rivalry", 1.5), T("tariffs", 2), T("supply chain", 2),
  T("reservations", 1.2), T("vehicle", 1), T("debt levels", 2),
  T("emerging markets", 1.5), T("banks", 1), T("insurance", 1),
  // — weak generic economics: enough to route, never enough to dominate —
  T("economy", 1), T("economic", 1), T("economy grows", 2),
  T("gdp", 1.5), T("recession", 1.5), T("consumer", 0.8),
  T("spending", 0.8), T("wages", 1), T("jobs", 0.8), T("taxes", 0.8),
  T("wealth", 0.8), T("income", 0.8), T("savings", 1), T("pensions", 1),
  T("property", 1), T("housing", 1), T("rent", 0.8), T("debt", 1),
  T("budget", 1),   T("trade", 0.8), T("exports", 1), T("imports", 1),
  T("manufacturing", 1.5), T("factory", 1), T("industries", 0.8),
  // — zh: market microstructure that appears in wire copy —
  T("地方政府债", 2), T("地方政府债券", 2), T("暂停交易", 2.5), T("恢复交易", 2),
  T("上市公司", 2), T("股份", 1), T("涨幅", 1.5), T("跌幅", 1.5),
  T("成交", 1.2), T("投资者", 1.2), T("散户", 1.5), T("市值", 1.5),
  T("股价", 2), T("净值", 1.2), T("收益率曲线", 2), T("资产", 1),
  T("货币", 1), T("信贷", 1.5), T("贷款", 1.5), T("存款", 1.2),  T("consumer goods", 1.5), T("retail", 1), T("groceries", 1.2),
  T("energy bills", 1.2), T("household", 0.8),
  // — en: personal-finance columns (MarketWatch / Yahoo signature shape) —
  T("inherited", 1.5), T("inheritance", 1.5), T("retirement", 1.5),
  T("retire", 1.2), T("401(k)", 2.5), T("ira", 1.5), T("portfolio", 1.5),
  T("investing", 1.2), T("investors", 1.2), T("investor", 1.2),
  T("savings", 1.2), T("college", 0.8), T("student loan", 1.5),
  T("credit card", 1.5), T("health insurance", 2), T("premiums", 1.2),
  T("overpaying", 1), T("worth it", 0.8), T("financial adviser", 1.5),
  T("net worth", 1.5), T("millionaire", 1.2), T("growth stocks", 2),
  T("stock picks", 2), T("dividend stocks", 2), T("upside", 1.2),
  T("returns", 0.8), T("yield", 0.8), T("valuation", 1.2),
];

/** 政策政务 — ministries, regulators, rulemaking, courts, personnel. */
const POLICY: Term[] = [
  T("人民银行", 2), T("财政部", 3), T("发改委", 3), T("商务部", 3),
  T("证监会", 2.5), T("金融监管总局", 3), T("国务院", 3), T("工信部", 3),
  T("统计局", 3), T("市场监管总局", 3), T("网信办", 3), T("银保监", 3),
  T("外管局", 3), T("住建部", 3), T("能源局", 2.5), T("政治局", 3),
  T("国常会", 3), T("常务会议", 2.5), T("人大", 2), T("政协", 2),
  T("部委", 2), T("监管层", 2), T("央行", 1.5),
  T("印发", 2.5), T("部署", 1.5), T("约谈", 3), T("处罚", 1.5),
  T("惩处", 2.5), T("新规", 2.5), T("新规范", 2), T("征求意见", 2.5),
  T("试点", 1.5), T("十五五", 2.5), T("实施方案", 2), T("政策", 1.5),
  T("补贴", 1.5), T("反垄断", 2), T("立案调查", 2), T("座谈会", 1.5),
  T("签发", 2), T("批复", 2), T("偷逃税", 2.5), T("税务", 1.5),
  T("人事", 2), T("任免", 2.5), T("升任", 2), T("履新", 2), T("免职", 2.5),
  T("监管", 1.5), T("审批", 1.5), T("立法", 2), T("法案", 2), T("白皮书", 2),
  T("规划", 1),
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

/** 全球市场 — offshore rates, indices, FX, commodities, crypto. */
const GLOBAL_MARKETS: Term[] = [
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
  T("比特币", 2.5), T("加密货币", 2.5), T("币安", 3), T("以太坊", 2), T("加密交易所", 3),
  T("全球市场", 2), T("海外市场", 2), T("避险", 1.5), T("美债收益率", 3),
  // — en: indices, rates, assets —
  T("wall street", 2.5), T("nasdaq", 2.5), T("s&p", 2.5), T("dow jones", 2.5),
  T("federal reserve", 3), T("the fed", 2), T("fed", 1.5), T("fomc", 2.5), T("ecb", 2.5),
  T("bank of japan", 2.5), T("treasury yield", 2.5), T("treasury yields", 2.5),
  T("bond yield", 2.5), T("bond yields", 2.5),
  T("yield", 1.5), T("crude", 2), T("brent", 2), T("wti", 2.5),
  T("oil price", 2), T("gold", 1.5), T("silver", 1.5), T("copper", 1.5),
  T("bitcoin", 2.5), T("crypto", 2.5), T("binance", 2), T("ethereum", 2),
  T("dollar", 1.5), T("euro", 1), T("yen", 1.5), T("commodities", 2),
  T("futures", 1.5), T("markets wrap", 3), T("stocks gain", 2.5),
  T("exchange", 1.5), T("trading venue", 2.5), T("sovereign debt", 2.5),
  T("debt holdings", 2.5), T("creditors", 2), T("bondholders", 2.5),
  T("hedge funds", 2.5), T("hedge fund", 2.5), T("asset manager", 2),
  T("stocks rise", 2.5), T("stocks fall", 2.5), T("stocks sink", 2.5),
  T("stock futures", 2.5), T("equities", 1.5), T("bull market", 2),
  T("bear market", 2), T("selloff", 2), T("rally", 1.5),
  T("payrolls", 2.5), T("jobless claims", 2.5), T("unemployment", 1.5),
  T("jobless", 1.5), T("central bank", 2), T("rate decision", 2.5),
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
  // — en —
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
  // — en: crypto/web3 product copy (attentionvc-ai feeds it into finance) —
  T("mainnet", 3), T("testnet", 3), T("token", 1.5), T("tokens", 1.2),
  T("tokenized", 2), T("stablecoin", 2.5), T("stablecoins", 2.5),
  T("defi", 2.5), T("web3", 2.5), T("blockchain", 2), T("ledger", 1.2),
  T("wallet", 1.5), T("airdrop", 2.5), T("mint", 1.5), T("onchain", 2),
  T("protocol", 1), T("mainnet launch", 3), T("devnet", 2.5),
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
  // — en: results, deals, corporate actions —
  T("earnings", 2), T("revenue", 1.5), T("buyback", 1.5), T("guidance", 1.5),
  T("quarterly results", 2.5), T("profit warning", 2.5), T("filing", 1.5),
  T("acquisition", 2), T("merger", 2), T("acquires", 2), T("takeover", 2),
  T("hostile bid", 2.5), T("stake sale", 2.5), T("takes a stake", 2.5),
  T("share sale", 2),
  T("stock offering", 2), T("places shares", 2.5), T("private placement", 2.5),
  T("raises $", 2), T("valuation", 1.5), T("ipo", 2), T("debut", 1.5),
  T("beats estimates", 2.5), T("misses estimates", 2.5), T("beats on", 2),
  T("tops estimates", 2.5), T("profit", 1), T("loss", 1),
  T("dividend", 2), T("payout", 1.5), T("shares", 1), T("stock split", 2.5),
  T("resign", 1), T("steps down", 1.5), T("appointed", 1.5),
];

/** 观点解读 — broker notes, interviews, long-form analysis. */
const OPINION: Term[] = [
  T("研报", 3), T("评级", 2), T("目标价", 2.5), T("看好", 1.5),
  T("对话", 2.5), T("访谈", 2.5),
  T("展望", 1.5), T("解读", 2), T("深度", 1.5), T("专访", 2.5),
  T("观察", 1.5), T("评论", 2), T("社论", 2.5), T("专栏", 2),
  T("观点", 2), T("前瞻", 1.5), T("快评", 2), T("策略报告", 2.5),
  T("晨会", 2), T("中信证券", 2.5), T("中金", 2), T("国泰君安", 2.5),
  T("华泰证券", 2.5), T("招商证券", 2.5), T("广发证券", 2.5),
  T("申万宏源", 2.5), T("海通证券", 2.5), T("兴业证券", 2.5),
  T("民生证券", 2.5), T("天风证券", 2.5), T("长江证券", 2.5),
  T("高盛", 2), T("摩根士丹利", 2), T("摩根大通", 2), T("瑞银", 2),
  T("野村", 2), T("美银", 2), T("花旗", 2),
  // — en: research, columns, explainers —
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
  // — en: essay/long-read titles are the Economist/FT signature shape —
  T("the return of", 1.5), T("the future of", 1.5), T("the case for", 2),
  T("the case against", 2), T("what now", 1.5), T("what next", 1.5),
  T("is dead", 1.5), T("is over", 1.2), T("a warning", 1.5),
  T("lessons from", 2), T("why it matters", 2), T("the trouble with", 2),
  T("in defence of", 2), T("in defense of", 2), T("haunt", 1),
  T("weird", 0.8), T("absurdity", 1.5), T("serious reform", 2),
  T("shock", 1), T("crisis", 1), T("squeeze", 1), T("boom", 1.2),
  T("bubble", 1.5), T("inequality", 1.5),
];

/** 国际时政 — geopolitics, conflict, elections, courts, non-financial world. */
const WORLD: Term[] = [
  T("地缘", 2), T("冲突", 1.5), T("战争", 2), T("空袭", 2.5), T("停火", 2.5),
  T("导弹", 2), T("军演", 2), T("选举", 2), T("大选", 2.5), T("公投", 2),
  T("议会", 1.5), T("总统", 2), T("总理", 2), T("首相", 2),
  T("外交部", 1.5), T("联合国", 2), T("峰会", 1.5), T("制裁", 2),
  T("难民", 2), T("枪击", 2.5), T("判决", 1.5), T("抗议", 2),
  T("示威", 2), T("政变", 3), T("内阁", 2), T("执政", 1.5),
  T("特朗普", 1.5), T("白宫", 2), T("普京", 2), T("泽连斯基", 2.5),
  T("内塔尼亚胡", 2.5), T("伊朗", 2.5), T("乌克兰", 2.5), T("俄罗斯", 2),
  T("以色列", 2.5), T("加沙", 2.5), T("朝鲜", 2), T("中东", 2),
  T("台海", 2), T("南海", 2), T("欧盟", 1.5), T("北约", 2),
  T("间谍", 2), T("国安", 2), T("辞呈", 1.5), T("辞职", 1),
  T("外交", 1.5), T("军方", 2), T("袭击", 2), T("伤亡", 2),
  T("边境", 1.5), T("地震", 2), T("洪水", 2), T("台风", 1.5), T("难民危机", 2.5),
  // — en: countries & regions come from the shared COUNTRIES table below —
  ...COUNTRIES.map((c) => T(c.term, c.world)),
  // — en: world-desk event vocabulary —
  T("geopolitics", 2.5), T("border", 1.5), T("refugee", 2), T("aid groups", 2),
  T("human rights", 2), T("rights groups", 2), T("activists", 2),
  T("crackdown", 2.5), T("restrictions", 1.5), T("ban", 1.5), T("banned", 1.5),
  T("police", 1.5), T("investigators", 1.5), T("arrested", 2), T("charged", 1.5),
  T("dispute", 2), T("tribunal", 2.5), T("legal battle", 2.5), T("territorial", 2.5),
  T("sovereignty claim", 3), T("diplomatic row", 2.5),
  T("suspect", 1.5), T("missing", 1.5), T("rescued", 1.5), T("injured", 1.5),
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
  T("militants", 2.5), T("houthis", 2.5), T("taliban", 2.5),
  T("export controls", 2), T("territory", 1.5), T("island", 1.2),
  T("memorial", 2), T("veterans", 2), T("military guard", 2.5),
  T("bomb hoax", 3), T("hoax", 2), T("evacuated", 2), T("airport", 1.5),
  T("flight", 1.2), T("airline", 1.5),
  // — en: the remaining general-news beats (politics, sport, culture, science,
  //   society). They carry real traffic through politics:world and would
  //   otherwise all fall through to the source prior; routing them to `world`
  //   keeps the financial topics clean instead of absorbing this copy.
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
  // — zh: remaining beats —
  T("汽车", 1.5), T("车企", 2), T("轿跑", 2), T("豪车", 2), T("车型", 1.5),
  T("风机", 2), T("航天", 2), T("卫星", 2), T("火箭", 2), T("天问", 2.5),
  T("高校", 1.5), T("大学", 1.5), T("校长", 2), T("教育", 1.5),
  T("影视", 2), T("电影", 2), T("剧集", 2), T("文化", 1.5),
  T("诈骗", 2), T("非法集资", 2.5), T("刑事案件", 2), T("最高法", 2.5),
  T("核污染", 2.5), T("排放", 1.5), T("生态", 1.5), T("环保", 1.5),
  T("降雨", 1.5), T("暴雨", 1.5), T("冷空气", 1.5),
];

export const TOPIC_TERMS: Readonly<Record<TopicKey, readonly Term[]>> = {
  "cn-finance": CN_FINANCE,
  "global-markets": GLOBAL_MARKETS,
  policy: POLICY,
  "tech-ai": TECH_AI,
  filings: FILINGS,
  opinion: OPINION,
  world: WORLD,
};

// ---------------------------------------------------------------------------
// Damping anchors
// ---------------------------------------------------------------------------


// ---------------------------------------------------------------------------
// Damping anchors
// ---------------------------------------------------------------------------


/** Derived views over COUNTRIES — declared after WORLD so both are in scope. */
const FOREIGN_ANCHOR: Term[] = [
  ...COUNTRIES.map((c) => T(c.term, c.anchor)),
  // Institutions and figures that imply an offshore venue on their own.
  T("美联储", 2), T("特朗普", 1.5), T("白宫", 1.5), T("KOSPI", 2),
  T("KOSDAQ", 2), T("LME", 1.5), T("hong kong", 1.5), T("foreign", 1),
];

/** Onshore markers that cancel the damping. */
const DOMESTIC_ANCHOR: Term[] = [
  T("A股", 1), T("沪指", 1), T("上证", 1), T("深成", 1), T("创业板", 1),
  T("科创板", 1), T("北交所", 1), T("沪深", 1), T("中证", 1), T("港股", 1),
  T("恒生", 1), T("人民币", 1), T("央行", 1), T("证监会", 1), T("国务院", 1),
  T("财政部", 1), T("发改委", 1), T("商务部", 1), T("国内", 1), T("我国", 1),
  T("中国", 1), T("内地", 1),
  T("a-shares", 1), T("pboc", 1), T("china", 1), T("chinese", 1),
  T("shanghai", 1), T("shenzhen", 1), T("yuan", 1), T("beijing", 1),
];

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
 * boundaries so `ai` doesn't fire inside `said` and `yen` doesn't fire
 * inside `yen's` neighbours.
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
// Structural shapes
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
  if (/^(图解|解读|深度|研报|专访|观察|评论|社论|专栏|快评|晨会|策略|前瞻)/.test(title)) {
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

/** Two-tier fallback: most specific source metadata wins, then category. */
function fallbackTopic(input: ClassifyInput): TopicKey {
  try {
    const sub = input.subcategory ? FALLBACK_TOPIC_BY_SUBCATEGORY[input.subcategory] : undefined;
    if (sub) return sub;
    const category = input.category ?? "finance";
    const title = input.title ?? "";
    const script = /[\u4e00-\u9fff]/.test(title) ? "cjk" : "latin";
    return FALLBACK_TOPIC_BY_CATEGORY_AND_SCRIPT[category][script];
  } catch {
    // Unreadable input (throwing getter, unexpected shape) — no signal is
    // better than no topic, so land on the neutral domestic-finance default.
    return FALLBACK_TOPIC_BY_CATEGORY_AND_SCRIPT.finance.cjk;
  }
}

function emptyScores(): Record<TopicKey, number> {
  const out = {} as Record<TopicKey, number>;
  for (const k of TOPIC_KEYS_RUNTIME) out[k] = 0;
  return out;
}

/**
 * Classify one article. Never throws: on any internal failure it returns the
 * source-metadata fallback, so a caller in the pipeline can stay non-fatal.
 */
export function classifyArticle(input: ClassifyInput): ClassifyResult {
  try {
    return classifyInner(input);
  } catch {
    return { topic: fallbackTopic(input ?? {}), confidence: 0, matched: [], fallback: true };
  }
}

function classifyInner(input: ClassifyInput): ClassifyResult {
  const title = normalizeTitle(input.title ?? "");
  const body = (input.summary || input.excerpt || "").slice(0, 500);
  const titleHay = title.toLowerCase();
  const bodyHay = body.toLowerCase();

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
  // Added BEFORE the winner pick so a blank headline still lands somewhere
  // sensible, but small enough that any real term (≥2 × 2 title multiplier)
  // outranks it — the registry stays a fallback, not the router.
  const prior = fallbackTopic(input);
  scores[prior] += SOURCE_PRIOR_WEIGHT;

  // Offshore damping — the 财联社 guard. When offshore anchors fire and no
  // onshore anchor does, the domestic score is *transferred* rather than
  // duplicated: the finance lexicon that produced it (banks, home sales, tax)
  // is real evidence of the wrong venue, so `global-markets` inherits part of
  // it. Countries themselves carry only a weak `world` weight, which is what
  // makes "韩国…KOSDAQ" a markets item while "印尼副总统辞职" stays world copy.
  const foreign =
    anchorWeight(FOREIGN_ANCHOR, titleHay) * 2 + anchorWeight(FOREIGN_ANCHOR, bodyHay);
  const domestic =
    anchorWeight(DOMESTIC_ANCHOR, titleHay) * 2 + anchorWeight(DOMESTIC_ANCHOR, bodyHay);
  if (foreign >= 2 && domestic === 0) {
    const domesticScore = scores["cn-finance"];
    scores["cn-finance"] = domesticScore * 0.2;
    scores["global-markets"] += domesticScore * 0.5;
  }

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

  if (evidenceScore <= 0) {
    return {
      topic: fallbackTopic(input),
      confidence: 0.15,
      matched,
      fallback: true,
    };
  }

  // Confidence: absolute lexical evidence × dominance over the runner-up.
  // `evidenceScore` (pre-prior) drives the first term, so a headline routed
  // purely by source metadata can never look confident.
  const strength = 1 - Math.exp(-evidenceScore / 6);
  const dominance = (bestScore - secondScore) / bestScore;
  let confidence = 0.55 * strength + 0.45 * dominance;
  if (evidenceScore < 3) confidence = Math.min(confidence, LOW_CONFIDENCE);
  confidence = Math.max(0.05, Math.min(0.99, round3(confidence)));

  return { topic: best, confidence, matched, fallback: false };
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
  },
>(
  articles: T[],
  subcategoryOf?: (a: T) => string | undefined,
): Array<T & { topic: TopicKey; topicConfidence: number }> {
  return articles.map((a) => {
    const copy = safeCopy(a);
    try {
      const sub = copy.subcategory ?? subcategoryOf?.(copy);
      const r = classifyArticle({ ...copy, subcategory: sub });
      return { ...copy, topic: r.topic, topicConfidence: r.confidence };
    } catch {
      return { ...copy, topic: "cn-finance" as TopicKey, topicConfidence: 0 };
    }
  });
}
