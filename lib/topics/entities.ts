/**
 * Canonical story entities — the vocabulary the density cap counts with.
 *
 * Why this exists: the density rule is "at most two items per story cluster
 * per section". A cluster has to survive *re-wording*, because the failure it
 * exists to stop is not literal duplication (the dedupe pass removes that) but
 * one event relabelled fifteen ways — on 2026-11-13 the Nvidia story shipped
 * 36 external headlines and 17 Chinese ones, all legitimately different
 * sentences about one event.
 *
 * So the cluster identity is the *entity* the headline is about, not its
 * wording. Chinese and English aliases resolve to one id, which also makes the
 * cap work across the two language lanes: `英伟达…` and `Nvidia…` are the same
 * cluster, so the edition-wide budget cannot be dodged by switching language.
 *
 * Data only — no matching logic, no imports. Order is priority: when a
 * headline names several entities, the first one declared here wins, so a
 * headline about `Nvidia's Lutnick testimony` clusters as the Nvidia story
 * rather than as a Lutnick story.
 *
 * Deliberately excluded: bare country names (中国/美国/US) and generic beats
 * (市场/科技). They are context, not a story identity — capping on them would
 * collapse unrelated news into one bucket. Entities here are the *subjects* a
 * flood forms around.
 */

export interface StoryEntity {
  /** Stable cluster id. Never shown to readers. */
  id: string;
  /** Aliases as they appear in headlines. ASCII matches word-bounded. */
  aliases: readonly string[];
}

export const STORY_ENTITIES: readonly StoryEntity[] = [
  // — AI & semiconductors (the dominant flood source) —
  { id: "nvidia", aliases: ["英伟达", "黄仁勋", "nvidia", "jensen huang", "huang"] },
  { id: "microsoft", aliases: ["微软", "microsoft"] },
  { id: "openai", aliases: ["openai", "chatgpt", "奥特曼", "sam altman"] },
  { id: "anthropic", aliases: ["anthropic", "claude"] },
  { id: "deepseek", aliases: ["deepseek", "深度求索"] },
  { id: "apple", aliases: ["苹果公司", "苹果", "apple", "iphone"] },
  { id: "alphabet", aliases: ["谷歌", "alphabet", "google", "gemini"] },
  { id: "meta", aliases: ["meta platforms", "meta", "facebook", "扎克伯格"] },
  { id: "amazon", aliases: ["亚马逊", "amazon", "aws"] },
  { id: "tesla", aliases: ["特斯拉", "tesla", "马斯克", "musk", "spacex"] },
  { id: "tsmc", aliases: ["台积电", "tsmc"] },
  { id: "samsung", aliases: ["三星电子", "三星", "samsung"] },
  { id: "huawei", aliases: ["华为", "huawei"] },
  { id: "alibaba", aliases: ["阿里巴巴", "阿里", "alibaba"] },
  { id: "tencent", aliases: ["腾讯", "tencent"] },
  { id: "baidu", aliases: ["百度", "baidu"] },
  { id: "xiaomi", aliases: ["小米", "xiaomi"] },
  { id: "byd", aliases: ["比亚迪", "byd"] },
  { id: "catl", aliases: ["宁德时代", "catl"] },
  { id: "smic", aliases: ["中芯国际", "中芯", "smic"] },

  // — central banks & macro —
  { id: "fed", aliases: ["美联储", "鲍威尔", "federal reserve", "the fed", "fomc", "powell"] },
  { id: "ecb", aliases: ["欧洲央行", "ecb", "lagarde", "拉加德"] },
  { id: "boj", aliases: ["日本央行", "bank of japan", "boj", "植田和男"] },
  { id: "pboc", aliases: ["中国人民银行", "人民银行", "央行", "pboc"] },
  { id: "opec", aliases: ["欧佩克", "opec"] },
  { id: "imf", aliases: ["imf", "国际货币基金组织"] },

  // — geopolitics —
  { id: "trump", aliases: ["特朗普", "川普", "trump"] },
  { id: "putin", aliases: ["普京", "putin"] },
  { id: "zelensky", aliases: ["泽连斯基", "zelensky"] },
  { id: "ukraine", aliases: ["乌克兰", "ukraine"] },
  { id: "russia", aliases: ["俄罗斯", "russia", "kremlin", "克里姆林宫"] },
  { id: "iran", aliases: ["伊朗", "iran"] },
  { id: "israel", aliases: ["以色列", "israel", "netanyahu", "内塔尼亚胡"] },
  { id: "gaza", aliases: ["加沙", "gaza", "palestin", "巴勒斯坦"] },
  { id: "nato", aliases: ["北约", "nato"] },
  { id: "eu", aliases: ["欧盟", "european union"] },

  // — markets & assets —
  { id: "bitcoin", aliases: ["比特币", "bitcoin", "btc"] },
  { id: "gold", aliases: ["黄金", "gold", "bullion"] },
  { id: "oil", aliases: ["原油", "布伦特", "wti", "crude oil", "brent oil"] },
];
