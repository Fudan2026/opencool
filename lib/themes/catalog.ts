/**
 * Theme catalog — the curated 题材 dictionary (one-time curation, the
 * documented maintenance surface for the theme engine).
 *
 * Design: themes map to Eastmoney concept boards BY NAME at bake time,
 * NOT by hardcoded BK codes — board codes drift, names are stable.
 * `boardHints` are name substrings tried in order against the live
 * board list (f14); the first exact match wins, then substring.
 */

export interface ThemeDef {
  /** Stable key (ascii) used in JSON outputs. */
  key: string;
  /** Display name (zh). */
  name: string;
  /** Article-title substrings counted as theme hits. */
  aliases: string[];
  /** Eastmoney concept-board name hints (first match wins). */
  boardHints: string[];
}

export const THEME_CATALOG: readonly ThemeDef[] = [
  { key: "ai", name: "人工智能", aliases: ["人工智能", "AI", "大模型", "ChatGPT"], boardHints: ["人工智能"] },
  { key: "ai-compute", name: "算力", aliases: ["算力", "数据中心", "GPU", "英伟达"], boardHints: ["算力"] },
  { key: "semiconductor", name: "半导体", aliases: ["半导体", "芯片", "晶圆", "光刻"], boardHints: ["半导体"] },
  { key: "ev", name: "新能源车", aliases: ["新能源车", "电动汽车", "锂电", "宁德"], boardHints: ["新能源汽车"] },
  { key: "solar", name: "光伏", aliases: ["光伏", "硅片", "组件"], boardHints: ["光伏"] },
  { key: "pharma", name: "创新药", aliases: ["创新药", "医药", "临床试验", "CXO"], boardHints: ["创新药"] },
  { key: "liquor", name: "白酒", aliases: ["白酒", "茅台", "五粮液"], boardHints: ["白酒"] },
  { key: "defense", name: "军工", aliases: ["军工", "国防", "导弹", "航空航天"], boardHints: ["军工", "国防军工"] },
  { key: "bank", name: "银行", aliases: ["银行", "信贷", "LPR"], boardHints: ["银行"] },
  { key: "brokerage", name: "券商", aliases: ["券商", "证券", "保险", "非银"], boardHints: ["证券", "保险"] },
  { key: "realestate", name: "房地产", aliases: ["房地产", "地产", "楼市"], boardHints: ["房地产开发", "房地产服务"] },
  { key: "coal", name: "煤炭", aliases: ["煤炭", "动力煤", "焦煤"], boardHints: ["煤炭"] },
  { key: "metals", name: "有色金属", aliases: ["有色", "黄金", "铜", "稀土"], boardHints: ["贵金属", "工业金属", "小金属"] },
  { key: "oil", name: "石油石化", aliases: ["石油", "原油", "油价"], boardHints: ["油气开采"] },
  { key: "agriculture", name: "农业", aliases: ["农业", "种业", "粮食", "生猪"], boardHints: ["种植业", "养殖业"] },
  { key: "consumer-elec", name: "消费电子", aliases: ["消费电子", "手机", "折叠屏", "苹果链"], boardHints: ["消费电子"] },
  { key: "robotics", name: "机器人", aliases: ["机器人", "人形机器人", "减速器"], boardHints: ["机器人"] },
  { key: "quantum", name: "量子科技", aliases: ["量子"], boardHints: ["量子科技"] },
  { key: "comms", name: "通信", aliases: ["6G", "通信", "光模块", "卫星"], boardHints: ["通信设备", "通信服务"] },
  { key: "gaming", name: "游戏", aliases: ["游戏", "版号"], boardHints: ["游戏"] },
  { key: "media", name: "传媒", aliases: ["传媒", "影视", "短剧"], boardHints: ["传媒"] },
  { key: "steel", name: "钢铁", aliases: ["钢铁", "特钢"], boardHints: ["钢铁行业", "特钢"] },
  { key: "infra", name: "基建", aliases: ["基建", "一带一路", "中字头"], boardHints: ["基础建设"] },
  { key: "travel", name: "旅游酒店", aliases: ["旅游", "酒店", "免税"], boardHints: ["旅游酒店", "旅游景点"] },
];

/**
 * Pure article-matching: count how many of the theme's aliases appear
 * in a text. Substring counting, capped at 3 per alias (same cap
 * philosophy as lib/nlp/sentiment.ts).
 */
export function themeArticleHits(
  texts: string[],
  theme: ThemeDef,
): { hits: number; matched: string[] } {
  const hay = texts.join("\n");
  let hits = 0;
  const matched: string[] = [];
  for (const alias of theme.aliases) {
    let count = 0;
    let idx = hay.indexOf(alias);
    while (idx >= 0 && count < 3) {
      count++;
      idx = hay.indexOf(alias, idx + alias.length);
    }
    if (count > 0) {
      hits += count;
      matched.push(alias);
    }
  }
  return { hits, matched };
}

/**
 * Resolve a theme to a live Eastmoney board: exact f14 match first,
 * then hint-substring containment. Returns null when no board matches
 * (theme keeps article heat, board fields null — honest degradation).
 */
export function resolveBoard<T extends { code: string; name: string }>(
  theme: ThemeDef,
  boards: T[],
): T | null {
  for (const hint of theme.boardHints) {
    const exact = boards.find((b) => b.name === hint);
    if (exact) return exact;
  }
  for (const hint of theme.boardHints) {
    const partial = boards.find((b) => b.name.includes(hint));
    if (partial) return partial;
  }
  return null;
}
