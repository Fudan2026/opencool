/**
 * Heuristic Chinese reading guides from excerpts — zero LLM.
 */

import { hasCjk } from "../sources/title-filters";

/** Split excerpt into up to 3 bullet points for 中文导读 mode. */
export function guideBullets(
  title: string,
  excerpt?: string,
  summary?: string,
): string[] {
  const text = (summary || excerpt || "").replace(/\s+/g, " ").trim();
  const bullets: string[] = [];
  if (!text) {
    if (hasCjk(title)) bullets.push(`标题要点：${title.slice(0, 40)}`);
    return bullets;
  }
  // Sentence-ish split for CJK and EN
  const parts = text
    .split(/(?<=[。！？.!?])\s*/)
    .map((s) => s.trim())
    .filter((s) => s.length >= 8);
  for (const p of parts.slice(0, 3)) {
    bullets.push(p.slice(0, 120));
  }
  if (bullets.length === 0) bullets.push(text.slice(0, 140));
  // Numbers highlight
  const nums = text.match(
    /(\d+(?:\.\d+)?\s*%|\$[\d,.]+亿?|[\d,.]+亿|涨停|跌停|降息|加息)/g,
  );
  if (nums && nums.length && !bullets.some((b) => nums.some((n) => b.includes(n)))) {
    bullets.push(`关键数字：${[...new Set(nums)].slice(0, 4).join(" · ")}`);
  }
  return bullets.slice(0, 3);
}

export function isLikelyEnglishTitle(title: string): boolean {
  if (hasCjk(title)) return false;
  return /[A-Za-z]{3,}/.test(title);
}
