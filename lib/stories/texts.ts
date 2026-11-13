/**
 * Bilingual labels for the story-ledger surfaces (zh/en parity).
 *
 * Same convention as `lib/output/render.ts` `TEXTS_ZH` / `TEXTS_EN` and
 * `lib/topics/taxonomy.ts` `TOPICS`: both languages declared side by side, one
 * picked at read time, and a test that fails when a key exists in only one
 * table. Kept out of `render.ts` on purpose — the ledger is a data product with
 * its own consumers, and importing the renderer to get a label would drag the
 * whole page template into a JSON bake.
 */

export type StoryLocale = "zh" | "en";

export const TEXTS_ZH = {
  /** Panel title. */
  panelTitle: "故事账本",
  panelSubtitle: "同一事件的最早观测、修订轨迹与首发媒体",
  coverageStories: "故事",
  coverageMultiSighting: "多源跟进",
  coverageRevisions: "含修订",
  firstMoverTitle: "谁最先报道",
  firstMoverSole: "独家首发",
  firstMoverCo: "并列首发",
  firstMoverLead: "领先分钟（中位）",
  firstMoverSamples: "样本",
  firstMoverWindow: "滚动窗口",
  firstMoverTiedNote: "同一轮抓取中多条线报同时到达时记为并列首发，不计算领先。",
  firstSeenAt: "首次观测",
  publishedAt: "来源发布时间",
  publishLag: "观测滞后（分钟）",
  sightings: "后续观测",
  sources: "来源",
  revisionTrailTitle: "消息修订史",
  revisionFrom: "原文",
  revisionTo: "改后",
  revisionRemoved: "删除词",
  revisionAdded: "新增词",
  noRevisions: "窗口内暂无标题修订。",
  generatedAt: "生成时间",
  skippedRecords: "无法解析而被跳过的记录",
};

export const TEXTS_EN: typeof TEXTS_ZH = {
  panelTitle: "Story ledger",
  panelSubtitle: "First observation, revision trail and first movers per wire",
  coverageStories: "Stories",
  coverageMultiSighting: "Multi-wire",
  coverageRevisions: "Revised",
  firstMoverTitle: "Who reported first",
  firstMoverSole: "Sole firsts",
  firstMoverCo: "Co-firsts",
  firstMoverLead: "Lead minutes (median)",
  firstMoverSamples: "Samples",
  firstMoverWindow: "Rolling window",
  firstMoverTiedNote:
    "Wires first observed in the same fetch are recorded as co-firsts — no lead is claimed.",
  firstSeenAt: "First seen",
  publishedAt: "Wire timestamp",
  publishLag: "Observation lag (min)",
  sightings: "Later observations",
  sources: "Wires",
  revisionTrailTitle: "Headline revision trail",
  revisionFrom: "Before",
  revisionTo: "After",
  revisionRemoved: "Removed",
  revisionAdded: "Added",
  noRevisions: "No headline revisions in the window.",
  generatedAt: "Generated",
  skippedRecords: "Unparseable records skipped",
};

export function storyTexts(locale: StoryLocale = "zh"): typeof TEXTS_ZH {
  return locale === "en" ? TEXTS_EN : TEXTS_ZH;
}
