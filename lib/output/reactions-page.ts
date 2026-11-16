/**
 * `/reactions.html` — the reaction windows as a public, honest table.
 *
 * `reactions.json` is already published and asserted
 * (`scripts/assert-reactions.mjs`), but a JSON file is not a reading surface.
 * This page renders it for humans with one rule above all: **every state is a
 * real answer**. `pending` ("could not check yet") and `insufficient`
 * (n below MIN_SAMPLE) stay visible as first-class states — collapsing either
 * into a quieter "no data" is the exact defect the four-state attribution
 * contract exists to prevent.
 *
 * Each +1h/+1d/+5d cell carries a SuPro review deep-link with its own
 * `utm_content` (`reactions-1h` / `reactions-1d` / `reactions-5d`) so the
 * sister site can attribute the page's traffic per horizon.
 *
 * Zero LLM, zero network: the payload is arithmetic over files the bakes
 * already produced.
 */

import { REPORT_LOCALE } from "../sources/registry";
import {
  HORIZONS,
  HEADLINE_METRIC,
  MIN_SAMPLE,
  type AggregateRow,
  type AttributionKind,
  type Distribution,
  type HorizonKey,
  type HorizonSample,
  type ReactionsPayload,
  type StoryReaction,
} from "../reactions/types";
import { esc, fill, STRINGS as S } from "./render";
import { suproUrl, SUPRO_LINK_ATTRS } from "./supro";
import { SITE_URL, socialMetaTags, jsonLdScript, webPageLd } from "./meta";

const REACTIONS_UTM: Record<HorizonKey, string> = {
  "1h": "reactions-1h",
  "1d": "reactions-1d",
  "5d": "reactions-5d",
};

function pct(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return "—";
  return `${n > 0 ? "+" : ""}${n.toFixed(2)}%`;
}

function dateTimeShort(iso: string): string {
  const m = /^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2})/.exec(iso);
  return m ? `${m[1]} ${m[2]}` : iso;
}

/** The review link every horizon cell carries — one utm_content per horizon. */
function reviewLink(key: HorizonKey): string {
  return ` <a class="supro-act" data-funnel="supro-reactions-${key}" href="${suproUrl(
    "paper",
    REACTIONS_UTM[key],
  )}" ${SUPRO_LINK_ATTRS}>${esc(S.reactionsReview)}</a>`;
}

function attributionChip(kind: AttributionKind | null): { cls: string; label: string } {
  switch (kind) {
    case "entity":
      return { cls: "attr-entity", label: S.reactionsChipEntity };
    case "topic":
      return { cls: "attr-topic", label: S.reactionsChipTopic };
    case "market":
      return { cls: "attr-market", label: S.reactionsChipMarket };
    case "pending":
      return { cls: "attr-pending", label: S.reactionsChipPending };
    default:
      return { cls: "attr-unmapped", label: S.reactionsChipUnmapped };
  }
}

function distributionCell(d: Distribution): string {
  if (d.status !== "ok") {
    // Insufficient is a published state with n and nothing else — rendering a
    // mean here would break MIN_SAMPLE, rendering nothing would hide it.
    return `<span class="d-insufficient">${esc(
      fill(S.reactionsAggInsufficient, { n: d.n, min: MIN_SAMPLE }),
    )}</span><br><span class="tiny">${esc(
      fill(S.reactionsAggExcluded, { pending: d.excluded.pending, gap: d.excluded.gap }),
    )}</span>`;
  }
  const hit =
    d.hitRate == null
      ? ""
      : `<br><span class="tiny">${esc(
          fill(S.reactionsAggHitRate, { rate: `${Math.round(d.hitRate * 100)}%` }),
        )}</span>`;
  return `${esc(
    fill(S.reactionsAggOk, {
      mean: pct(d.mean ?? null),
      median: pct(d.median ?? null),
      n: d.n,
    }),
  )}${hit}<br><span class="tiny">${esc(
    fill(S.reactionsAggExcluded, { pending: d.excluded.pending, gap: d.excluded.gap }),
  )}</span>`;
}

function aggregateTable(rows: AggregateRow[]): string {
  if (!rows.length) return `<p class="sent-muted">${esc(S.reactionsAggNone)}</p>`;
  const head = HORIZONS.map(
    (h) => `<th>${esc(fill(S.reactionsColHorizon, { label: h.label }))}</th>`,
  ).join("");
  const body = rows
    .map(
      (r) =>
        `<tr><td class="agg-key">${esc(r.label)}<span class="tiny"> ${esc(r.key)}</span></td>${HORIZONS.map(
          (h) => `<td>${distributionCell(r.horizons[h.key])}</td>`,
        ).join("")}</tr>`,
    )
    .join("");
  return `<table class="tape-table" data-table="aggregates">
<thead><tr><th></th>${head}</tr></thead>
<tbody>${body}</tbody>
</table>`;
}

function horizonCell(key: HorizonKey, s: HorizonSample): string {
  const link = reviewLink(key);
  if (s.status === "ok") {
    const headline = pct(s.marketExcessPct);
    const cls = (s.marketExcessPct ?? 0) >= 0 ? "pos" : "neg";
    const raw = `<span class="tiny">${esc(
      fill(S.reactionsRawLine, {
        raw: pct(s.rawReturnPct ?? null),
        minutes: Math.round(s.windowMinutes ?? 0),
      }),
    )}</span>`;
    return `<td class="${cls}"><b>${headline}</b><br>${raw}${link}</td>`;
  }
  const state =
    s.status === "pending"
      ? `<span class="d-pending">${esc(S.reactionsStatusPending)}</span>`
      : `<span class="d-gap">${esc(S.reactionsStatusGap)}</span>`;
  const reason = s.reason
    ? `<br><span class="tiny">${esc(fill(S.reactionsStatusReason, { reason: s.reason }))}</span>`
    : "";
  return `<td class="d-muted">${state}${reason}${link}</td>`;
}

function observationRow(o: StoryReaction): string {
  const chip = attributionChip(o.attribution);
  const target = o.targetLabel || o.target || "—";
  return `<tr>
<td class="d-time" title="${esc(o.firstSeenAt)}">${esc(dateTimeShort(o.firstSeenAt))}</td>
<td class="d-story">${esc(o.id)}<span class="tiny"> ${esc(o.topic)}</span></td>
<td><span class="attr-chip ${chip.cls}" title="${esc(o.attributionReason)}">${esc(chip.label)}</span><span class="tiny"> ${esc(target)}</span></td>
${HORIZONS.map((h) => horizonCell(h.key, o.horizons[h.key])).join("")}
</tr>`;
}

function countsSection(p: ReactionsPayload): string {
  const a = p.counts.attributed;
  const horizons = HORIZONS.map((h) => {
    const c = p.counts.horizons[h.key];
    return `<li>${esc(
      fill(S.reactionsHorizonLine, { label: h.label, ok: c.ok, pending: c.pending, gap: c.gap }),
    )}</li>`;
  }).join("");
  return `<h2>${esc(S.reactionsCountsTitle)}</h2>
<ul>
<li>${esc(
    fill(S.reactionsCountsStories, {
      stories: p.counts.stories,
      measured: p.counts.observationsTotal,
      published: p.counts.observationsPublished,
    }),
  )}</li>
</ul>
<p class="agg-note">${esc(S.reactionsAttrHeading)}</p>
<ul>
<li>${esc(fill(S.reactionsAttrEntity, { n: a.entity }))}</li>
<li>${esc(fill(S.reactionsAttrTopic, { n: a.topic }))}</li>
<li>${esc(fill(S.reactionsAttrMarket, { n: a.market }))}</li>
<li>${esc(fill(S.reactionsAttrPending, { n: a.pending }))}</li>
<li>${esc(fill(S.reactionsAttrUnmapped, { n: a.unmapped }))}</li>
</ul>
<ul>${horizons}</ul>`;
}

function gapsSection(p: ReactionsPayload): string {
  if (!p.gaps.length)
    return `<h2>${esc(S.reactionsGapsTitle)}</h2><p class="sent-muted">${esc(S.reactionsGapsNone)}</p>`;
  const rows = p.gaps
    .map(
      (g) =>
        `<li class="gap-chip">${esc(
          fill(S.reactionsGapLine, { kind: g.kind, count: g.count ?? 1, detail: g.detail }),
        )}${g.file ? ` <span class="tiny">${esc(g.file)}</span>` : ""}</li>`,
    )
    .join("");
  return `<h2>${esc(S.reactionsGapsTitle)}</h2>
<ul class="gap-list" data-gaps="${p.gaps.length}">${rows}</ul>`;
}

export interface ReactionsPageOptions {
  /** The published payload, or null when the file exists but is unreadable. */
  payload: ReactionsPayload | null;
  /** Named gap when payload is null (missing/corrupt reactions.json). */
  reason: string;
}

export function renderReactionsPage(opts: ReactionsPageOptions): string {
  const { payload: p, reason } = opts;

  const body = p
    ? `<p class="subtitle">${esc(
        fill(S.reactionsDataThrough, {
          dataThrough: p.dataThrough ?? S.reactionsDataThroughNone,
          tz: p.timezone,
        }),
      )}</p>
  <section class="method">
    <h2>${esc(S.reactionsHeadlineTitle)}</h2>
    <p>${esc(fill(S.reactionsMethodSummary, { metric: HEADLINE_METRIC }))}</p>
    <details><summary>${esc(S.reactionsMethodNote)}</summary><p class="tiny">${esc(
      p.headlineReason,
    )}</p></details>
  </section>
  ${countsSection(p)}
  <h2>${esc(S.reactionsAggTopic)}</h2>
  ${aggregateTable(p.aggregates.byTopic)}
  <h2>${esc(S.reactionsAggEntity)}</h2>
  ${aggregateTable(p.aggregates.byEntity)}
  <h2>${esc(S.reactionsObsTitle)}</h2>
  ${
    p.observations.length
      ? `<p class="sent-muted">${esc(
          fill(S.reactionsObsPublished, {
            published: p.counts.observationsPublished,
            total: p.counts.observationsTotal,
          }),
        )}</p>
  <div class="table-wrap"><table class="tape-table obs" data-table="observations" data-rows="${p.observations.length}">
<thead><tr><th>${esc(S.reactionsColFirstSeen)}</th><th>${esc(S.reactionsColStory)}</th><th>${esc(
          S.reactionsColTarget,
        )}</th>${HORIZONS.map(
          (h) => `<th>${esc(fill(S.reactionsColHorizon, { label: h.label }))}</th>`,
        ).join("")}</tr></thead>
<tbody>${p.observations.map(observationRow).join("")}</tbody>
</table></div>`
      : `<p class="sent-muted">${esc(S.reactionsObsNone)}</p>`
  }
  ${gapsSection(p)}
  <p class="sent-muted">${esc(S.reactionsDataLink)}</p>`
    : `<p class="subtitle">${esc(S.reactionsMissingBody)}</p>
  <div class="gap-block" data-gap="reactions">
    <p class="gap-title">${esc(S.reactionsMissingTitle)}</p>
    <p>${esc(fill(S.reactionsMissingReason, { reason }))}</p>
  </div>`;

  const title = `${S.reactionsTitle} · ${S.siteTitle}`;
  const description = p ? S.reactionsSubtitle : S.reactionsMissingBody;

  return `<!doctype html>
<html lang="${REPORT_LOCALE === "en" ? "en" : "zh-CN"}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>
${socialMetaTags({
  title,
  description,
  url: `${SITE_URL}/reactions.html`,
})}
${jsonLdScript(webPageLd(title, `${SITE_URL}/reactions.html`, description))}
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=DM+Sans:wght@500;700&family=Fraunces:opsz,wght@9..144,600;9..144,700&family=Noto+Sans+SC:wght@400;500;700&display=swap" rel="stylesheet">
<style>${CSS}</style>
</head>
<body>
<main>
  <header class="page-head">
    <div class="brand">${esc(S.siteTitle)}</div>
    <h1>${esc(S.reactionsTitle)}</h1>
  </header>
  ${body}
  <footer>
    <p>${esc(S.reactionsFooter)}</p>
    <p><a href="./index.html">${esc(S.siteTitle)}</a> · <a href="./archive.html">${esc(
      S.archiveLink,
    )}</a> · <a href="./hour.html">${esc(S.navHour)}</a> · <a href="./stories.html">${esc(
      S.navStories,
    )}</a> · <a href="./integrity.html">${esc(S.navIntegrity)}</a> · <a href="./supro.html">${esc(
      S.navSupro,
    )}</a></p>
  </footer>
</main>
</body>
</html>
`;
}

const CSS = `
  :root {
    --bg:#fff7ef; --fg:#241a13; --fg-soft:#4a3b32; --muted:#8a7364;
    --rule:#f0ddd0; --card:#fff; --accent:#c2410c; --accent-soft:#ffedd5;
    --pos:#b91c1c; --neg:#0f766e; --gap-bg:#fff8e6; --gap-rule:#d9a441; --navy:#1e3a8a;
  }
  * { box-sizing:border-box; }
  body {
    margin:0; min-height:100vh; color:var(--fg);
    background:
      radial-gradient(ellipse 90% 55% at 0% -5%, #ffd8a8 0%, transparent 55%),
      radial-gradient(ellipse 70% 45% at 100% 0%, #ffc9de 0%, transparent 50%),
      var(--bg);
    font-family:"Noto Sans SC","DM Sans",system-ui,sans-serif;
    line-height:1.65; -webkit-font-smoothing:antialiased;
  }
  main { max-width:1000px; margin:0 auto; padding:2rem 1.35rem 4rem; }
  a { color:var(--accent); }
  .page-head { margin-bottom:1.4rem; }
  .brand { font-family:"Fraunces","Noto Sans SC",serif; font-size:0.85rem;
    letter-spacing:0.14em; text-transform:uppercase; color:var(--accent); font-weight:700; }
  h1 { font-family:"Fraunces","Noto Sans SC",serif; font-size:clamp(1.7rem,4vw,2.4rem);
    margin:0.3rem 0 0.25rem; letter-spacing:-0.02em; }
  h2 { font-size:0.78rem; text-transform:uppercase; letter-spacing:0.12em;
    color:var(--muted); font-weight:700; margin:1.6rem 0 0.5rem; }
  .subtitle { margin:0; color:var(--muted); font-size:0.95rem; }
  .method { background:rgba(255,255,255,0.6); border:1px solid var(--rule);
    border-radius:0.9rem; padding:0.9rem 1.05rem; margin-top:1.2rem; }
  .method h2 { margin-top:0.2rem; }
  .method p { margin:0.25rem 0; font-size:0.88rem; color:var(--fg-soft); }
  .method details { margin-top:0.4rem; }
  .method summary { cursor:pointer; font-size:0.82rem; color:var(--muted); font-weight:600; }
  .tape-table { width:100%; border-collapse:collapse; font-size:0.85rem; margin:0 0 0.4rem; }
  .tape-table th, .tape-table td { text-align:left; padding:0.33rem 0.45rem;
    border-bottom:1px solid var(--rule); vertical-align:top; }
  .tape-table th { font-size:0.74rem; text-transform:uppercase; letter-spacing:0.08em; color:var(--muted); }
  .table-wrap { overflow-x:auto; }
  .obs td { font-size:0.82rem; }
  .d-time { white-space:nowrap; color:var(--fg-soft); }
  .d-story { font-family:"DM Sans",sans-serif; font-size:0.78rem; }
  .agg-key { font-weight:600; }
  .pos { color:var(--pos); font-weight:600; }
  .neg { color:var(--neg); font-weight:600; }
  .d-muted { color:var(--muted); }
  .d-insufficient { color:#8a5a09; font-weight:600; }
  .d-pending { color:var(--muted); font-weight:600; }
  .d-gap { color:var(--neg); font-weight:600; }
  .tiny { font-size:0.76rem; color:var(--muted); }
  .sent-muted { color:var(--muted); font-size:0.88rem; }
  .agg-note { font-weight:600; font-size:0.85rem; margin:0.6rem 0 0.2rem; }
  ul { margin:0.25rem 0 0.6rem; padding-left:1.2rem; }
  li { font-size:0.85rem; margin:0.18rem 0; color:var(--fg-soft); }
  .gap-list { list-style:none; padding:0; display:flex; flex-wrap:wrap; gap:0.35rem; }
  .gap-chip { font-size:0.76rem; padding:0.15rem 0.6rem; border-radius:999px;
    background:var(--gap-bg); border:1px dashed var(--gap-rule); color:#8a5a09; }
  .gap-block { background:var(--gap-bg); border:1px dashed var(--gap-rule);
    border-radius:0.75rem; padding:0.85rem 1rem; margin:0 0 0.9rem; }
  .gap-block p { margin:0.15rem 0; font-size:0.9rem; color:#6b4a10; }
  .gap-title { font-weight:700; }
  .attr-chip { display:inline-block; font-size:0.7rem; padding:0.02rem 0.45rem; border-radius:999px;
    font-weight:700; }
  .attr-entity { background:var(--accent-soft); color:var(--accent); }
  .attr-topic { background:#ccfbf1; color:#0f766e; }
  .attr-market { background:#e0e7ff; color:#3730a3; }
  .attr-pending { background:var(--gap-bg); color:#8a5a09; }
  .attr-unmapped { background:#f3f4f6; color:#6b7280; }
  .supro-act { white-space:nowrap; font-weight:600; font-size:0.78rem; text-decoration:none; }
  .supro-act:hover { text-decoration:underline; }
  footer { margin-top:2.2rem; padding-top:0.9rem; border-top:1px solid var(--rule);
    color:var(--muted); font-size:0.78rem; }
  footer a { color:var(--accent); text-decoration:none; font-weight:600; }
`;
