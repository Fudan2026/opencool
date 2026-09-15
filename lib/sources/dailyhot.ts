/**
 * Fetch social hot-rank lists via public DailyHot-compatible JSON APIs
 * (imsyy/DailyHotApi). Titles + links only — no login, no body scrape.
 *
 * OpenCool: keep only finance-relevant items (whitelist) and drop
 * entertainment noise (blacklist). Failures return [] so the pipeline continues.
 */

import type { RawArticle } from "./types";

interface HotItem {
  title?: string;
  name?: string;
  url?: string;
  mobileUrl?: string;
  hot?: string | number;
  desc?: string;
}

interface HotResponse {
  data?: HotItem[];
  title?: string;
}

const DEFAULT_BASES = [
  "https://api-hot.imsyy.top",
  "https://dailyhot-api.vercel.app",
];

/** Must match at least one to keep (after blacklist). */
const FINANCE_WHITELIST =
  /央行|美联储|降息|加息|加息|降准|国债|债券|股市|A股|港股|美股|纳斯达克|道琼斯|标普|沪深|创业板|科创板|北交所|期货|原油|黄金|白银|外汇|汇率|人民币|美元|欧元|日元|IPO|财报|营收|利润|市值|融资|并购|破产|违约|通胀|CPI|PPI|GDP|失业率|非农|财联社|金十|华尔街|券商|基金|私募|公募|ETF|期权|分红|回购|减持|增持|主力|北向|南向|两融|杠杆|做空|做多|牛市|熊市|崩盘|暴涨|暴跌|涨停|跌停|板块|概念股|茅台|宁德|比亚迪|腾讯|阿里|美团|京东|银行|保险|券商|地产|楼市|房价|利率|LPR|MLF|逆回购|财政|税收|关税|贸易战|制裁|油价|天然气|铜|铁矿|锂电|芯片股|半导体股|新能源车|光伏|储能|碳中和|碳交易|加密货币|比特币|以太坊|BTC|ETH|Fed|Powell|Treasury|yield|stock|market|earnings|inflation|recession|rate cut|rate hike|Nasdaq|S&P|Dow|Bitcoin|crypto|forex|commodity/i;

/** Drop immediately if matched (entertainment / celebrity noise). */
const ENTERTAINMENT_BLACKLIST =
  /综艺|明星|演员|歌手|偶像|追剧|剧综|恋综|选秀|粉丝|磕糖|官宣|分手|结婚|离婚|孕|生子|出轨|八卦|热搜榜首.*剧|电影票房(?!相关股)|短剧|网红|直播带货(?!监管)|美食探店|穿搭|护肤|彩妆|旅游攻略|游戏皮肤|电竞选手|演唱会|音乐节|脱口秀|相声|春晚|奥运会.*金牌(?!概念)|世界杯.*进球|足球明星|篮球明星|流量|塌房|翻车.*娱|恋情|绯闻/i;

async function fetchJson(url: string, timeoutMs = 15_000): Promise<HotResponse | null> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      signal: ctrl.signal,
      headers: {
        Accept: "application/json",
        "User-Agent": "OpenCool-DailyBrief/1.0",
      },
    });
    if (!res.ok) {
      console.warn(`[dailyhot] ${url} → HTTP ${res.status}`);
      return null;
    }
    return (await res.json()) as HotResponse;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.warn(`[dailyhot] ${url} failed: ${msg}`);
    return null;
  } finally {
    clearTimeout(timer);
  }
}

function bases(): string[] {
  const override = process.env.DAILYHOT_API_BASE?.trim();
  if (override) return [override.replace(/\/$/, "")];
  return DEFAULT_BASES;
}

function isFinanceHot(title: string): boolean {
  if (!title) return false;
  if (ENTERTAINMENT_BLACKLIST.test(title)) return false;
  return FINANCE_WHITELIST.test(title);
}

/**
 * `source.url` should be a DailyHot path like `/douyin` or a full URL.
 */
export async function fetchDailyHot(sourceId: string, url: string): Promise<RawArticle[]> {
  if (url.startsWith("http")) {
    const endpoint = new URL(url);
    if (!endpoint.searchParams.has("limit")) {
      endpoint.searchParams.set("limit", "40");
    }
    const body = await fetchJson(endpoint.toString());
    return mapItems(sourceId, body?.data ?? []);
  }

  const path = url.startsWith("/") ? url : `/${url}`;
  for (const base of bases()) {
    let endpoint: URL;
    try {
      endpoint = new URL(path, base.endsWith("/") ? base : `${base}/`);
    } catch {
      continue;
    }
    if (!endpoint.searchParams.has("limit")) {
      endpoint.searchParams.set("limit", "40");
    }
    const body = await fetchJson(endpoint.toString());
    const items = body?.data ?? [];
    if (items.length > 0) {
      const mapped = mapItems(sourceId, items);
      console.log(
        `[dailyhot] ${sourceId} via ${base} → ${items.length} raw, ${mapped.length} finance-kept`,
      );
      return mapped;
    }
  }
  return [];
}

function mapItems(sourceId: string, items: HotItem[]): RawArticle[] {
  return items
    .map((it, idx): RawArticle | null => {
      const title = (it.title || it.name || "").trim();
      const link = (it.url || it.mobileUrl || "").trim();
      if (!title || !link) return null;
      if (!isFinanceHot(title)) return null;
      const hot =
        it.hot !== undefined && it.hot !== null ? String(it.hot) : undefined;
      return {
        sourceId,
        title,
        url: link,
        excerpt: it.desc || (hot ? `热度 ${hot}` : undefined),
        publishedAt: new Date(),
        category: "politics",
        meta: hot ? `#${idx + 1} · 热度 ${hot}` : `#${idx + 1}`,
      };
    })
    .filter((x): x is RawArticle => x !== null);
}
