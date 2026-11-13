/**
 * Editorial lead override — the editor (repo owner) may pin a headline
 * for a given date, but ONLY when the day's own sources ground it:
 * `groundOn` must appear in at least one fetched article title. No
 * grounding → the lead is refused (zero fabrication, the project's
 * first invariant).
 */

import type { ArticleInput } from "../ai/pipeline";

export interface EditorialLead {
  /** Applies to every slot of this date when hour omitted. */
  date: string;
  hour?: string;
  /** Substring that must appear in a fetched article title. */
  groundOn: string;
  /** The pinned headline (should quote/track the sourced title). */
  title: string;
  url?: string;
  source?: string;
  note?: string;
}

export interface AppliedLead {
  title: string;
  url?: string;
  source?: string;
  note?: string;
  groundedBy: string;
}

export function loadLeadConfig(
  file: string,
  readFile: (p: string) => string,
): EditorialLead | null {
  try {
    const raw = readFile(file);
    const j = JSON.parse(raw) as Partial<EditorialLead>;
    if (
      typeof j.date !== "string" ||
      typeof j.groundOn !== "string" ||
      typeof j.title !== "string" ||
      !j.date ||
      !j.groundOn ||
      !j.title
    ) {
      return null;
    }
    return j as EditorialLead;
  } catch {
    return null;
  }
}

export function applyLead(
  articles: ArticleInput[],
  lead: EditorialLead,
  today: string,
  hour: string,
): AppliedLead | null {
  if (lead.date !== today) return null;
  if (lead.hour && lead.hour !== hour) return null;
  const grounded = articles.find((a) => (a.title ?? "").includes(lead.groundOn));
  if (!grounded) return null;
  return {
    title: lead.title,
    url: lead.url || grounded.url,
    source: lead.source || grounded.source,
    note: lead.note,
    groundedBy: grounded.title,
  };
}
