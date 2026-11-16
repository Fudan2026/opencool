/**
 * Dev-time alias curation tables, shared by the baker and the tests.
 *
 * These tables define the *policy* of `scripts/bake-board-atlas.ts` — which
 * short forms may ship, which are too generic, which board-name exclusions
 * are mistakes — and the atlas tests assert the shipped file honours them.
 * They live beside `atlas.ts` so the policy is reviewable in one place and
 * can never drift between the baker and its verification.
 *
 * Nothing in the runtime attribution path imports this module: matching
 * reads only the committed `board-atlas.json`.
 */

/**
 * Colloquial short forms that do NOT appear inside the company's own name, so
 * no rule could ever generate them (`工行` is not a substring of `工商银行`).
 * Each entry names the *stem* that must identify exactly one fetched member;
 * an entry that matches zero or several companies is dropped, loudly.
 */
export const COLLOQUIAL: Readonly<Record<string, string>> = {
  工行: "工商银行",
  建行: "建设银行",
  中行: "中国银行",
  农行: "农业银行",
  交行: "交通银行",
  招行: "招商银行",
  邮储: "邮储银行",
  茅台: "贵州茅台",
  国寿: "中国人寿",
  格力: "格力电器",
  三一: "三一重工",
  万华: "万华化学",
  爱尔: "爱尔眼科",
  顺丰: "顺丰控股",
  兴业: "兴业银行",
  海尔: "海尔智家",
  汇顶: "汇顶科技",
  京东方: "京东方A",
};

/**
 * Short forms that would map headlines about something else to a company.
 * Sector words that appear inside a registry board name are excluded by the
 * board-name guard; this list covers the ones it cannot catch (common nouns,
 * celebrity names, an operator's generic word) plus anything the strip rule
 * would produce that no headline safely owns.
 *
 * Theme aliases are deliberately NOT part of this vocabulary: several are
 * company names the theme engine borrowed (茅台, 五粮液), and when a headline
 * uses one the company mapping is the stronger, more specific claim.
 */
export const GENERIC_BLOCKLIST: readonly string[] = [
  "移动", "电信", "建筑", "软件", "传媒", "金融", "基金", "集团", "控股",
  "科技", "数字", "智能", "巨石", "民生", "银河",
];

/**
 * Aliases the board-name guard excluded by mistake: a concept board named
 * after the company (`东方财富热股` BK1637) is not a sector word, and the
 * company's own name in a headline means the company. Every entry is
 * re-validated against the fetched membership before it ships.
 */
export const NOT_GENERIC: Readonly<Record<string, string>> = {
  东方财富: "东方财富",
};
