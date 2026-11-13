/**
 * `/stories.html` — story threads, with the first-mover column.
 *
 * The ledger is the one artefact in this project that is genuinely
 * point-in-time: it records when *we* first saw a story, keeps every later
 * observation, and keeps both versions of a rewritten headline. This page is
 * the reading surface for it, and it has one job the JSON cannot do: stop a
 * reader from misreading a lead as a stopwatch.
 *
 * `leadBasis` is `"observed"`. Our granularity is the edition cadence (06/13/19),
 * so "led by 900 minutes" means "the morning fetch carried it while the
 * runner-up only showed up at the evening one". The badge and the note say that
 * in the UI, not only in the JSON.
 *
 * The ranking column is `contestedFirsts` — earliest *and* followed by another
 * wire — because on a real ledger the overwhelming majority of stories are
 * single-source and therefore trivially "first" for whoever carried them.
 * Ranking on that would measure publishing volume, not speed, so it is shown
 * as a secondary number and never as the headline.
 *
 * Every string here comes from the `STRINGS` table in `./render`, so a new key
 * is covered by `tests/golden/i18n-parity.test.ts` the moment it is added.
 */

import type { StoriesPayload, StoryRecord } from "../stories/ledger";
import { REPORT_LOCALE } from "../sources/registry";
import { isoWithOffset } from "../stories/time";
import { getReportTz } from "../utils";
import { esc, fill, STRINGS as R } from "./render";

export interface StoriesPageOptions {
  /** `null` when `daily_reports/stories.json` is missing or unparseable. */
  payload: StoriesPayload | null;
  /** Why the payload is unusable, for the named gap. */
  reason?: string;
  /** Per-wire display names, from the source registry. */
  sourceNames?: Readonly<Record<string, string>>;
  /** Cap on rendered threads; the ledger itself is untouched. */
  maxThreads?: number;
}

const DEFAULT_MAX_THREADS = 40;

const S = R;

/** `2026-11-13T19:12:04+08:00` → `11-13 19:12` in the ledger's zone. */
function shortStamp(iso: string, tz: string): string {
  const local = localStamp(iso, tz);
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/.exec(local);
  if (!m) return local;
  return `${m[2]}-${m[3]} ${m[4]}:${m[5]}`;
}

/**
 * Render an instant in the ledger's own timezone, with its offset.
 *
 * `publishedAt` is persisted as a bare UTC stamp (`…Z`) because it comes from
 * the feed; printing it raw mixes two conventions on one page — our clocks carry
 * `+08:00` and the wire's carried `Z` — which reads as if they were different
 * kinds of time. Both are absolute, so re-rendering the wire stamp in the report
 * zone is presentation, not a claim about the wire.
 */
function localStamp(iso: string, tz: string): string {
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return iso;
  return isoWithOffset(at, tz);
}

function fullStamp(iso: string, tz: string): string {
  const local = localStamp(iso, tz);
  const m = /^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2}:\d{2})([+-]\d{2}:\d{2})$/.exec(local);
  if (!m) return local;
  return `${m[1]} ${m[2]} ${m[3]}`;
}

function minutes(n: number | null): string {
  if (n === null || !Number.isFinite(n)) return "—";
  return n >= 0 ? n.toFixed(0) : `−${Math.abs(n).toFixed(0)}`;
}

function sourceName(sourceId: string, names: Readonly<Record<string, string>>): string {
  return names[sourceId] ?? sourceId;
}

/** One story: headline, first-mover column, every sighting, the revision trail. */
function thread(
  story: StoryRecord,
  names: Readonly<Record<string, string>>,
  tz: string,
): string {
  const fm = story.firstMover;
  const lead = fm.tied
    ? fill(S.storiesFirstMoverTied, {
        sources: fm.coFirstSourceIds.map((id) => sourceName(id, names)).join(" / "),
      })
    : fm.sourceId && fm.runnerUpSourceId
      ? fill(S.storiesFirstMoverSole, {
          sourceName: sourceName(fm.sourceId, names),
          runnerUp: sourceName(fm.runnerUpSourceId, names),
          minutes: minutes(fm.leadMinutes),
        })
      : fm.sourceId
        ? fill(S.storiesFirstMoverAlone, { sourceName: sourceName(fm.sourceId, names) })
        : "—";

  const sightings = story.sightings.length
    ? `<table class="sight-table" data-sightings="${story.sightings.length}">
        <thead><tr><th>${esc(S.storiesSourceCol)}</th><th>${esc(S.storiesObservedCol)}</th><th>${esc(
          S.storiesHeadlineCol,
        )}</th></tr></thead>
        <tbody>${story.sightings
          .map(
            (s) =>
              `<tr><td>${esc(sourceName(s.sourceId, names))}</td><td class="mono">${esc(
                shortStamp(s.observedAt, tz),
              )}</td><td>${esc(s.title)}</td></tr>`,
          )
          .join("")}</tbody></table>`
    : `<p class="muted small">${esc(S.storiesNoSightings)}</p>`;

  const revisions = story.headlineRevisions.length
    ? `<ol class="rev-list" data-revisions="${story.headlineRevisions.length}">${story.headlineRevisions
        .map(
          (r) =>
            `<li><span class="rev-when mono">${esc(shortStamp(r.at, tz))}</span>
              <span class="rev-wire">${esc(sourceName(r.sourceId, names))}</span>
              <div class="rev-pair"><span class="rev-from">${esc(S.storiesRevisionFrom)} · ${esc(
                r.from,
              )}</span><span class="rev-to">${esc(S.storiesRevisionTo)} · ${esc(r.to)}</span></div></li>`,
        )
        .join("")}</ol>`
    : `<p class="muted small">${esc(S.storiesNoRevisions)}</p>`;

  const lag =
    story.publishLagMinutes === null
      ? ""
      : `<span class="lag">${esc(
          fill(S.storiesPublishLag, { minutes: minutes(story.publishLagMinutes) }),
        )}</span>`;

  return `<article class="thread" data-story-id="${esc(story.id)}" data-sources="${story.sources.length}">
      <header class="thread-head">
        <h3 class="thread-title">${esc(story.title)}</h3>
        <p class="thread-meta">
          <span class="mono">${esc(S.storiesFirstSeen)} · ${esc(fullStamp(story.firstSeenAt, tz))}</span>
          ${story.publishedAt ? `<span class="mono">${esc(S.storiesPublished)} · ${esc(fullStamp(story.publishedAt, tz))}</span>` : ""}
          ${lag}
        </p>
      </header>
      <div class="first-mover" data-first-mover="${esc(fm.sourceId ?? (fm.tied ? "tied" : "alone"))}">
        <span class="fm-label">${esc(S.storiesFirstMoverCol)}</span>
        <span class="fm-value">${esc(lead)}</span>
        <span class="basis-badge">${esc(S.storiesLeadBasisBadge)}</span>
      </div>
      <h4 class="sub-head">${esc(S.storiesSightings)}</h4>
      ${sightings}
      <h4 class="sub-head">${esc(S.storiesRevisionTrail)}</h4>
      ${revisions}
    </article>`;
}

function rankingTable(
  payload: StoriesPayload,
  names: Readonly<Record<string, string>>,
): string {
  const wires = payload.firstMover.wires;
  if (!wires.length) {
    return `<p class="muted small" data-rank-empty="true">${esc(S.storiesRankEmpty)}</p>`;
  }
  return `<table class="rank-table" data-rank-basis="contested">
      <thead><tr>
        <th>${esc(S.storiesRankWire)}</th>
        <th>${esc(S.storiesRankContested)}</th>
        <th>${esc(S.storiesRankSole)}</th>
        <th>${esc(S.storiesRankCo)}</th>
        <th>${esc(S.storiesRankStories)}</th>
        <th>${esc(S.storiesRankMedianLead)}</th>
        <th>${esc(S.storiesRankSamples)}</th>
      </tr></thead>
      <tbody>${wires
        .slice(0, 20)
        .map(
          (w) =>
            `<tr><td>${esc(sourceName(w.sourceId, names))}</td><td class="num strong">${w.contestedFirsts}</td><td class="num">${w.soleFirsts}</td><td class="num">${w.coFirsts}</td><td class="num">${w.stories}</td><td class="num">${minutes(w.medianLeadMinutes)}</td><td class="num muted">${w.leadSamples}</td></tr>`,
        )
        .join("")}</tbody></table>`;
}

function revisionSection(payload: StoriesPayload, tz: string): string {
  const items = payload.revisionTrail.items;
  if (!items.length) {
    return `<p class="muted small" data-revisions-empty="true">${esc(S.storiesNoRevisions)}</p>`;
  }
  return `<section class="revision-trail" data-trail-stories="${payload.revisionTrail.storiesWithRevisions}" data-trail-total="${payload.revisionTrail.totalRevisions}">
      <ol class="trail-list">${items
        .slice(0, 8)
        .map(
          (item) => `<li data-trail-story="${esc(item.id)}">
            <p class="trail-title">${esc(item.title)} <span class="trail-count">${item.revisions}</span></p>
            <ol class="rev-list">${item.steps
              .map(
                (step) =>
                  `<li><span class="rev-when mono">${esc(shortStamp(step.at, tz))}</span>
                    <div class="rev-pair"><span class="rev-from">${esc(S.storiesRevisionFrom)} · ${esc(
                      step.from,
                    )}</span><span class="rev-to">${esc(S.storiesRevisionTo)} · ${esc(step.to)}</span></div>
                    ${
                      step.added.length || step.removed.length
                        ? `<div class="rev-delta">${
                            // Each side renders only when it has tokens: a bare
                            // "−" with nothing after it reads as a rendering
                            // bug, not as "nothing was removed".
                            step.added.length
                              ? `<span class="rev-added">+${esc(step.added.join(" "))}</span>`
                              : ""
                          }${
                            step.removed.length
                              ? `<span class="rev-removed">−${esc(step.removed.join(" "))}</span>`
                              : ""
                          }</div>`
                        : ""
                    }</li>`,
              )
              .join("")}</ol>
          </li>`,
        )
        .join("")}</ol>
    </section>`;
}

const CSS = `
  :root {
    --bg:#fff7ef; --fg:#241a13; --fg-soft:#4a3b32; --muted:#8a7364;
    --rule:#f0ddd0; --card:#fff; --accent:#c2410c; --accent-soft:#ffedd5;
    --gap-bg:#fff8e6; --gap-rule:#d9a441;
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
  main { max-width:920px; margin:0 auto; padding:2rem 1.35rem 4rem; }
  a { color:var(--accent); }
  .brand { font-family:"Fraunces","Noto Sans SC",serif; font-size:0.85rem;
    letter-spacing:0.14em; text-transform:uppercase; color:var(--accent); font-weight:700; }
  h1 { font-family:"Fraunces","Noto Sans SC",serif; font-size:clamp(1.7rem,4vw,2.4rem);
    margin:0.3rem 0 0.25rem; letter-spacing:-0.02em; }
  .subtitle { margin:0 0 0.5rem; color:var(--muted); font-size:0.95rem; }
  .counts { margin:0; color:var(--fg-soft); font-size:0.86rem; }
  .note { background:var(--accent-soft); border-left:3px solid var(--accent);
    border-radius:0 0.6rem 0.6rem 0; padding:0.7rem 0.95rem; margin:1.1rem 0 1.3rem;
    font-size:0.86rem; color:#7c2d12; }
  .note strong { display:block; font-size:0.74rem; text-transform:uppercase;
    letter-spacing:0.1em; margin-bottom:0.2rem; }
  .thread { background:var(--card); border:1px solid var(--rule); border-radius:1rem;
    padding:1.05rem 1.15rem 1.15rem; margin:0 0 1rem; box-shadow:0 10px 30px rgba(194,65,12,0.05); }
  .thread-title { font-family:"Fraunces","Noto Sans SC",serif; font-size:1.08rem;
    margin:0 0 0.3rem; line-height:1.45; }
  .thread-meta { margin:0 0 0.7rem; display:flex; flex-wrap:wrap; gap:0.75rem; }
  .thread-meta .mono { font-size:0.76rem; color:var(--muted); }
  .lag { font-size:0.76rem; color:var(--accent); font-weight:600; }
  .first-mover { display:flex; flex-wrap:wrap; align-items:baseline; gap:0.5rem;
    background:linear-gradient(90deg, rgba(255,237,213,0.8), rgba(255,237,213,0.15));
    border:1px solid var(--rule); border-radius:0.7rem; padding:0.5rem 0.8rem; margin:0 0 0.9rem; }
  .fm-label { font-size:0.7rem; text-transform:uppercase; letter-spacing:0.1em;
    color:var(--muted); font-weight:700; }
  .fm-value { font-size:0.9rem; font-weight:600; }
  .basis-badge { font-size:0.68rem; padding:0.05rem 0.5rem; border-radius:999px;
    background:#fff; border:1px dashed var(--muted); color:var(--muted); font-weight:600; }
  .sub-head { font-size:0.7rem; text-transform:uppercase; letter-spacing:0.11em;
    color:var(--muted); font-weight:700; margin:0.9rem 0 0.35rem; }
  table { width:100%; border-collapse:collapse; font-size:0.84rem; }
  th, td { text-align:left; padding:0.3rem 0.42rem; border-bottom:1px solid var(--rule); vertical-align:top; }
  th { font-size:0.7rem; text-transform:uppercase; letter-spacing:0.07em; color:var(--muted); }
  .rank-table td.num { text-align:right; font-variant-numeric:tabular-nums; }
  .rank-table td.strong { color:var(--accent); font-weight:700; }
  .mono { font-variant-numeric:tabular-nums; }
  .muted { color:var(--muted); }
  .small { font-size:0.82rem; }
  .rev-list { margin:0; padding-left:1.1rem; }
  .rev-list li { margin:0.25rem 0; font-size:0.84rem; }
  .rev-when { color:var(--muted); margin-right:0.4rem; }
  .rev-wire { font-weight:600; }
  .rev-pair { display:flex; flex-direction:column; gap:0.1rem; }
  .rev-from { color:var(--muted); text-decoration:line-through; }
  .rev-to { color:var(--fg); font-weight:600; }
  .trail-list { padding-left:1.1rem; margin:0; }
  .trail-list > li { margin:0 0 0.8rem; }
  .trail-title { margin:0 0 0.3rem; font-weight:600; font-size:0.9rem; }
  .trail-count { font-size:0.7rem; padding:0.02rem 0.45rem; border-radius:999px;
    background:var(--accent-soft); color:var(--accent); font-weight:700; }
  .rev-delta { display:flex; gap:0.6rem; font-size:0.76rem; margin-top:0.1rem; }
  .rev-added { color:#15803d; }
  .rev-removed { color:#b91c1c; text-decoration:line-through; }
  .gap-block { background:var(--gap-bg); border:1px dashed var(--gap-rule);
    border-radius:0.9rem; padding:1.3rem 1.2rem; }
  .gap-block h2 { margin:0 0 0.4rem; font-family:"Fraunces","Noto Sans SC",serif; font-size:1.2rem; }
  .gap-block p { margin:0.2rem 0; color:#6b4a10; font-size:0.9rem; }
  footer { margin-top:2.2rem; padding-top:0.9rem; border-top:1px solid var(--rule);
    color:var(--muted); font-size:0.78rem; }
  footer a { color:var(--accent); text-decoration:none; font-weight:600; }
`;

export function renderStoriesPage(opts: StoriesPageOptions): string {
  const names = opts.sourceNames ?? {};
  const payload = opts.payload;
  // The ledger states the zone its instants were written in; that is the right
  // zone to *render* them in, and it keeps the page consistent with the JSON a
  // consumer reads. `getReportTz()` is the fallback for the empty/gap state.
  const tz = payload?.timezone || getReportTz() || "UTC";

  const body = payload
    ? `<p class="counts">${esc(
        fill(S.storiesCounts, {
          stories: payload.counts.stories,
          sightings: payload.counts.sightings,
          revised: payload.counts.storiesWithRevisions,
          revisions: payload.revisionTrail.totalRevisions,
        }),
      )}</p>
      <p class="counts">${esc(
        fill(S.storiesWindow, {
          from: payload.firstMover.from,
          to: payload.firstMover.to,
          days: payload.firstMover.windowDays,
        }),
      )}</p>
      <section class="note" data-lead-basis="${esc(payload.firstMover.leadBasis)}">
        <strong>${esc(S.storiesFirstMoverTitle)} · ${esc(S.storiesLeadBasisBadge)}</strong>
        ${esc(S.storiesFirstMoverNote)}
        <br>${esc(S.storiesRankBasis)}
      </section>
      ${rankingTable(payload, names)}
      <h2 class="sub-head" style="margin-top:1.4rem">${esc(S.storiesRevisionTrailHeading)}</h2>
      ${revisionSection(payload, tz)}
      <h2 class="sub-head" style="margin-top:1.4rem">${esc(S.storiesThreadHeading)}</h2>
      ${
        payload.stories.length
          ? payload.stories
              .slice(0, opts.maxThreads ?? DEFAULT_MAX_THREADS)
              .map((s) => thread(s, names, tz))
              .join("")
          : `<p class="muted small">${esc(S.storiesThreadEmpty)}</p>`
      }`
    : `<div class="gap-block" data-gap="ledger">
        <h2>${esc(S.storiesEmptyTitle)}</h2>
        <p>${esc(fill(S.storiesGap, { reason: opts.reason ?? "stories.json missing" }))}</p>
        <p>${esc(S.storiesEmptyBody)}</p>
      </div>`;

  return `<!doctype html>
<html lang="${REPORT_LOCALE === "en" ? "en" : "zh-CN"}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(S.storiesTitle)} · ${esc(S.siteTitle)}</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=DM+Sans:wght@500;700&family=Fraunces:opsz,wght@9..144,600;9..144,700&family=Noto+Sans+SC:wght@400;500;700&display=swap" rel="stylesheet">
<style>${CSS}</style>
</head>
<body>
<main>
  <header>
    <div class="brand">${esc(S.siteTitle)}</div>
    <h1>${esc(S.storiesTitle)}</h1>
    <p class="subtitle">${esc(S.storiesSubtitle)}</p>
  </header>
  ${body}
  <footer>
    <p>${esc(S.storiesFooter)}</p>
    <p><a href="./index.html">← ${esc(S.navHome)}</a> · <a href="./archive.html">${esc(
      S.archiveLink,
    )}</a> · <a href="./hour.html">${esc(S.navHour)}</a></p>
  </footer>
</main>
</body>
</html>
`;
}
