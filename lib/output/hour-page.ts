/**
 * `/hour.html` — the intraday tape as prose.
 *
 * The rule this page exists to honour: **lead with the sentence, not the
 * number**. A cross-section of 496 boards is not interesting as a table; it is
 * interesting as "banks held up while everything else sold off, and four in five
 * boards fell". So every panel opens with a written sentence and the figures
 * follow as evidence. Nothing enters a sentence that is not a field in the
 * snapshot, and every adjective comes from `MOVE_THRESHOLDS` in
 * `lib/tape/reading.ts` — printed back to the reader as the 口径 block, so the
 * yardstick is checkable rather than implied.
 *
 * Two clocks are the product's claim, so they are not metadata: the market
 * clock (`asOf`) and our clock (`observedAt`) both appear in the header of every
 * slot, with a one-line explanation and an explicit callout when they diverge.
 *
 * Slots and days are all server-rendered; the only client script flips which
 * panel is visible. With JavaScript disabled the first slot of the newest day
 * is still fully readable, and every other slot is still in the HTML.
 */

import {
  MOVE_THRESHOLDS,
  READING_LIMITS,
  type BreadthTone,
  type MoveTone,
  type SlotReading,
  type StoryHit,
  type TapeDayView,
} from "../tape/reading";
import { REPORT_LOCALE } from "../sources/registry";
import { esc, fill, STRINGS as S } from "./render";

function pct(n: number): string {
  return `${n >= 0 ? "+" : ""}${n.toFixed(2)}%`;
}

function share(n: number): string {
  return `${Math.round(n * 100)}%`;
}

function money(n: number): string {
  return `${n >= 0 ? "+" : ""}${n.toFixed(2)}`;
}

function timeOf(iso: string): string {
  const m = /T(\d{2}:\d{2}:\d{2})/.exec(iso);
  return m ? m[1] : iso;
}

function dateTimeOf(iso: string): string {
  return iso.replace("T", " ").replace(/([+-]\d{2}:\d{2})$/, " $1");
}

function moveWord(tone: MoveTone): string {
  switch (tone) {
    case "severe-up":
      return S.hourMoveSevUp;
    case "big-up":
      return S.hourMoveBigUp;
    case "up":
      return S.hourMoveUp;
    case "down":
      return S.hourMoveDown;
    case "big-down":
      return S.hourMoveBigDown;
    case "severe-down":
      return S.hourMoveSevDown;
    default:
      return S.hourMoveFlat;
  }
}

function breadthWord(tone: BreadthTone): string {
  switch (tone) {
    case "strong-up":
      return S.hourBreadthStrongUp;
    case "lean-up":
      return S.hourBreadthLeanUp;
    case "lean-down":
      return S.hourBreadthLeanDown;
    case "strong-down":
      return S.hourBreadthStrongDown;
    default:
      return S.hourBreadthMixed;
  }
}

/**
 * Sentence 1 — the index. Built only from fields that exist: a missing index
 * row shortens the sentence rather than being papered over with a zero.
 */
function indexSentence(r: SlotReading): string | null {
  if (!r.index?.length) return null;
  const byName = (needle: string) => r.index?.find((i) => i.name.includes(needle)) ?? null;
  const sh = byName("上证");
  const sz = byName("深证");
  const cyb = byName("创业板");
  if (!sh || !sz || !cyb) return null;
  const toneOf = (n: number) => moveWord(indexToneOf(n));
  return fill(S.hourSentenceIndex, {
    shPrice: sh.price.toFixed(2),
    shMove: `${toneOf(sh.changePct)} ${pct(sh.changePct)}`,
    szMove: `${toneOf(sz.changePct)} ${pct(sz.changePct)}`,
    cybMove: `${toneOf(cyb.changePct)} ${pct(cyb.changePct)}`,
  });
}

function indexToneOf(pctMove: number): MoveTone {
  const { big, severe } = MOVE_THRESHOLDS.index;
  if (pctMove >= severe) return "severe-up";
  if (pctMove >= big) return "big-up";
  if (pctMove > MOVE_THRESHOLDS.flatEps) return "up";
  if (pctMove < -severe) return "severe-down";
  if (pctMove < -big) return "big-down";
  if (pctMove < -MOVE_THRESHOLDS.flatEps) return "down";
  return "flat";
}

function breadthSentence(r: SlotReading): string | null {
  if (!r.breadth) return null;
  const b = r.breadth;
  return fill(S.hourSentenceBreadth, {
    total: b.total,
    up: b.up,
    down: b.down,
    flat: b.flat,
    upShare: share(b.upShare),
    breadthWord: breadthWord(b.tone),
  });
}

function extremesSentence(r: SlotReading): string | null {
  if (!r.boards?.best || !r.boards.worst) return null;
  const text = fill(S.hourSentenceExtremes, {
    bestName: r.boards.best.name,
    bestPct: pct(r.boards.best.changePct),
    worstName: r.boards.worst.name,
    worstPct: pct(r.boards.worst.changePct),
    upBig: r.boards.upBig,
    downBig: r.boards.downBig,
  });
  // The severe count is a separate sentence on purpose: it is only worth
  // saying when it is non-zero, and merging it would make a quiet day read as
  // if something violent happened.
  // Merged rather than concatenated: the severe-tail clause is a second
  // sentence, so it needs whatever separator the locale uses between sentences
  // (nothing in Chinese, a space in English) — kept in `hourSentenceJoin`.
  if (r.boards.upSevere === 0 && r.boards.downSevere === 0) return text;
  return `${text}${S.hourSentenceJoin}${fill(S.hourSentenceSevere, {
    upSevere: r.boards.upSevere,
    downSevere: r.boards.downSevere,
  })}`;
}

function flowsSentence(r: SlotReading): string | null {
  if (!r.flows?.best || !r.flows.worst) return null;
  return fill(S.hourSentenceFlows, {
    bestName: r.flows.best.name,
    bestYi: money(r.flows.best.yi),
    worstName: r.flows.worst.name,
    worstYi: money(r.flows.worst.yi),
  });
}

function themesSentence(r: SlotReading): string | null {
  if (!r.themes || !r.themes.best || !r.themes.worst) return null;
  return fill(S.hourSentenceThemes, {
    total: r.themes.total,
    quoted: r.themes.quoted,
    up: r.themes.up,
    bestName: r.themes.best.name,
    bestPct: pct(r.themes.best.changePct),
    worstName: r.themes.worst.name,
    worstPct: pct(r.themes.worst.changePct),
  });
}

function limitsSentence(r: SlotReading): string | null {
  if (!r.limits) return null;
  return fill(S.hourSentenceLimits, { up: r.limits.up, down: r.limits.down });
}

function storiesSentence(r: SlotReading): string | null {
  if (!r.stories || r.stories.unavailable) return null;
  const first = r.stories.inWindow[0];
  if (!first) return null;
  return fill(S.hourSentenceStories, {
    count: r.stories.inWindow.length,
    sourceName: first.sourceName,
    time: timeOf(first.firstSeenAt),
    title: first.title,
  });
}

/** Section → localized name, for the named gap rows. */
const SECTION_LABEL: Record<string, string> = {
  indices: "hourSectionIndices",
  industries: "hourSectionIndustries",
  themes: "hourSectionThemes",
  fundFlows: "hourSectionFundFlows",
  limitPool: "hourSectionLimitPool",
};

function sectionLabel(name: string): string {
  const key = SECTION_LABEL[name] as keyof typeof S | undefined;
  return key ? S[key] : name;
}

function gapChips(r: SlotReading): string {
  if (!r.gaps.length) return "";
  return `<ul class="gap-list" data-gaps="${r.gaps.length}">${r.gaps
    .map(
      (g) =>
        `<li class="gap-chip" data-gap-section="${esc(g.section)}">${esc(
          fill(S.hourSectionGap, { section: sectionLabel(g.section), reason: g.reason }),
        )}</li>`,
    )
    .join("")}</ul>`;
}

function clockBlock(r: SlotReading): string {
  const drift =
    r.driftMinutes === null
      ? S.hourClockSame
      : Math.abs(r.driftMinutes) > READING_LIMITS.clockDriftMinutes
        ? fill(S.hourClockDrift, { minutes: Math.abs(r.driftMinutes).toFixed(0) })
        : S.hourClockSame;
  return `<div class="two-clocks" data-asof="${esc(r.asOf)}" data-observed-at="${esc(r.observedAt)}">
      <p class="clock-line">${esc(
        fill(S.hourClockLine, {
          asOf: dateTimeOf(r.asOf),
          observedAt: dateTimeOf(r.observedAt),
        }),
      )}</p>
      <p class="clock-note" data-drift-minutes="${r.driftMinutes ?? ""}">${esc(drift)}</p>
    </div>`;
}

function storyItems(r: SlotReading): string {
  const sw = r.stories;
  if (!sw) return "";
  if (sw.unavailable) {
    return `<p class="gap-block" data-gap="ledger">${esc(
      fill(S.hourStoriesGap, { reason: sw.unavailable }),
    )}</p>`;
  }
  const row = (hit: StoryHit) => `<li class="story-hit" data-story="${esc(hit.id)}">
        ${
          // Attribution is the point: link the headline to the article it was
          // observed in, and never to a search engine — a search link would
          // look like a citation without being one.
          hit.url
            ? `<a href="${esc(hit.url)}" target="_blank" rel="noopener noreferrer">${esc(hit.title)}</a>`
            : `<span class="story-title">${esc(hit.title)}</span>`
        }
        <span class="story-meta">${esc(
          fill(S.hourLedgerAttribution, {
            sourceName: hit.sourceName,
            time: timeOf(hit.firstSeenAt),
          }),
        )}</span>
        ${hit.contested ? `<span class="badge">${esc(S.hourContestedBadge)}</span>` : ""}
      </li>`;
  const inWindow = sw.inWindow.length
    ? `<ul class="story-list">${sw.inWindow.map(row).join("")}</ul>`
    : // The window being empty is a fact about the tape, not about the world:
        // entries older than the window are still shown below as context, so
        // this line states only what is true — nothing entered *in this slot*.
        `<p class="sent-muted" data-stories-none="true">${esc(S.hourStoriesNone)}</p>`;
  const earlier = sw.earlier.length
    ? `<details class="earlier"><summary>${esc(S.hourStoriesEarlier)}</summary><ul class="story-list">${sw.earlier
        .map(row)
        .join("")}</ul></details>`
    : "";
  return `${inWindow}${earlier}`;
}

/** Prose block for one slot: sentences first, tables after. */
function slotBody(r: SlotReading): string {
  const sentences = [
    indexSentence(r),
    breadthSentence(r),
    extremesSentence(r),
    flowsSentence(r),
    themesSentence(r),
    limitsSentence(r),
    storiesSentence(r),
  ].filter((x): x is string => Boolean(x));

  const prose = sentences.length
    ? `<div class="prose">${sentences.map((s) => `<p>${esc(s)}</p>`).join("")}</div>`
    : `<p class="sent-muted">${esc(S.hourSectionGapHint)}</p>`;

  const indexTable = r.index?.length
    ? `<table class="tape-table" data-table="indices"><thead><tr><th>${
        esc(S.hourSectionIndices)
      }</th><th>%</th><th>asOf</th></tr></thead><tbody>${r.index
        .map(
          (i) =>
            `<tr><td>${esc(i.name)}</td><td class="${i.changePct >= 0 ? "pos" : "neg"}">${pct(
              i.changePct,
            )}</td><td class="muted tiny">${esc(timeOf(i.asOf ?? r.asOf))}</td></tr>`,
        )
        .join("")}</tbody></table>`
    : "";

  const clocks = `<table class="tape-table clocks" data-table="clocks"><thead><tr><th>section</th><th>asOf</th><th>observedAt</th><th>source</th></tr></thead><tbody>${r.clocks
    .map(
      (c) =>
        `<tr class="${c.unavailable ? "unavailable" : ""}"><td>${esc(sectionLabel(c.section))}</td><td class="muted tiny">${esc(
          dateTimeOf(c.asOf),
        )}</td><td class="muted tiny">${esc(dateTimeOf(c.observedAt))}</td><td class="muted tiny">${esc(c.source)}</td></tr>`,
    )
    .join("")}</tbody></table>`;

  return `${clockBlock(r)}
    ${gapChips(r)}
    ${prose}
    ${indexTable ? `<h3 class="sub-head">${esc(S.hourSectionIndices)}</h3>${indexTable}` : ""}
    <h3 class="sub-head">${esc(S.hourSectionClocks)}</h3>
    ${clocks}
    <h3 class="sub-head">${esc(S.navStories)}</h3>
    ${storyItems(r)}`;
}

function slotGapBody(time: string): string {
  return `<div class="gap-block" data-gap="slot">
      <p class="gap-title">${esc(fill(S.hourSlotGapTitle, { time }))}</p>
      <p>${esc(S.hourSlotGapBody)}</p>
    </div>`;
}

export interface HourPageOptions {
  days: TapeDayView[];
  /** One reading per day/slot; key is `<date>/<time>`. */
  readings: Map<string, SlotReading>;
  /** Timezone shown in the header when no capture exists to state one. */
  timezone: string;
  /** Slots expected per day (the session schedule), in order. */
  expectedSlots: readonly string[];
  /** True when the tape tree holds nothing at all. */
  empty: boolean;
}

const CSS = `
  :root {
    --bg:#fff7ef; --fg:#241a13; --fg-soft:#4a3b32; --muted:#8a7364;
    --rule:#f0ddd0; --card:#fff; --accent:#c2410c; --accent-soft:#ffedd5;
    --pos:#b91c1c; --neg:#0f766e; --gap-bg:#fff8e6; --gap-rule:#d9a441;
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
  main { max-width:900px; margin:0 auto; padding:2rem 1.35rem 4rem; }
  a { color:var(--accent); }
  .page-head { margin-bottom:1.4rem; }
  .brand { font-family:"Fraunces","Noto Sans SC",serif; font-size:0.85rem;
    letter-spacing:0.14em; text-transform:uppercase; color:var(--accent); font-weight:700; }
  h1 { font-family:"Fraunces","Noto Sans SC",serif; font-size:clamp(1.7rem,4vw,2.4rem);
    margin:0.3rem 0 0.25rem; letter-spacing:-0.02em; }
  .subtitle { margin:0; color:var(--muted); font-size:0.95rem; }
  .pickers { display:flex; flex-direction:column; gap:0.55rem; margin:1.1rem 0 1.3rem; }
  .picker-label { font-size:0.72rem; text-transform:uppercase; letter-spacing:0.12em;
    color:var(--muted); font-weight:700; margin:0 0 0.2rem; }
  .chips { display:flex; flex-wrap:wrap; gap:0.35rem; }
  .chip { display:inline-flex; align-items:baseline; gap:0.3rem; padding:0.3rem 0.7rem;
    border:1px solid var(--rule); border-radius:999px; background:rgba(255,255,255,0.75);
    color:var(--fg-soft); font-size:0.82rem; font-weight:600; text-decoration:none; cursor:pointer;
    font-family:inherit; }
  .chip.active { border-color:var(--accent); background:var(--accent-soft); color:var(--accent); }
  .chip .dot { width:0.42rem; height:0.42rem; border-radius:50%; background:var(--rule); }
  .chip.has-data .dot { background:var(--accent); }
  .chip.is-empty .dot { background:transparent; border:1px dashed var(--muted); }
  .day-panel, .slot-panel { display:none; }
  .day-panel.active, .slot-panel.active { display:block; }
  .card { background:var(--card); border:1px solid var(--rule); border-radius:1rem;
    padding:1.1rem 1.15rem; margin:0 0 1rem; box-shadow:0 10px 30px rgba(194,65,12,0.06); }
  .slot-head { display:flex; flex-wrap:wrap; align-items:baseline; gap:0.5rem; margin:0 0 0.6rem; }
  .slot-time { font-family:"Fraunces","Noto Sans SC",serif; font-size:1.3rem; font-weight:700; }
  .slot-date { color:var(--muted); font-size:0.85rem; }
  .revnote { font-size:0.75rem; color:var(--accent); background:var(--accent-soft);
    border-radius:999px; padding:0.05rem 0.5rem; font-weight:600; }
  .two-clocks { border-left:3px solid var(--accent); padding:0.35rem 0 0.35rem 0.75rem;
    margin:0.4rem 0 0.9rem; background:linear-gradient(90deg, rgba(255,237,213,0.55), transparent 70%); }
  .clock-line { margin:0; font-size:0.86rem; color:var(--fg-soft); }
  .clock-note { margin:0.2rem 0 0; font-size:0.82rem; color:var(--muted); }
  .prose p { margin:0 0 0.6rem; font-size:1rem; line-height:1.75; }
  .prose p:last-child { margin-bottom:0.9rem; }
  .sent-muted { color:var(--muted); font-size:0.88rem; }
  .gap-list { list-style:none; padding:0; margin:0 0 0.85rem; display:flex; flex-wrap:wrap; gap:0.35rem; }
  .gap-chip { font-size:0.76rem; padding:0.15rem 0.6rem; border-radius:999px;
    background:var(--gap-bg); border:1px dashed var(--gap-rule); color:#8a5a09; }
  .gap-block { background:var(--gap-bg); border:1px dashed var(--gap-rule);
    border-radius:0.75rem; padding:0.85rem 1rem; margin:0 0 0.9rem; }
  .gap-block p { margin:0.15rem 0; font-size:0.9rem; color:#6b4a10; }
  .gap-title { font-weight:700; }
  .sub-head { font-size:0.72rem; text-transform:uppercase; letter-spacing:0.12em;
    color:var(--muted); font-weight:700; margin:1.2rem 0 0.45rem; }
  .tape-table { width:100%; border-collapse:collapse; font-size:0.85rem; margin:0 0 0.4rem; }
  .tape-table th, .tape-table td { text-align:left; padding:0.33rem 0.45rem;
    border-bottom:1px solid var(--rule); }
  .tape-table th { font-size:0.74rem; text-transform:uppercase; letter-spacing:0.08em; color:var(--muted); }
  .tape-table tr.unavailable td { color:var(--muted); font-style:italic; }
  .pos { color:var(--pos); font-weight:600; }
  .neg { color:var(--neg); font-weight:600; }
  .muted { color:var(--muted); }
  .tiny { font-size:0.76rem; }
  .story-list { list-style:none; padding:0; margin:0 0 0.5rem; }
  .story-hit { padding:0.45rem 0; border-bottom:1px solid var(--rule); font-size:0.9rem; }
  .story-hit:last-child { border-bottom:0; }
  .story-hit a { text-decoration:none; font-weight:600; }
  .story-hit a:hover { text-decoration:underline; }
  .story-meta { display:block; font-size:0.78rem; color:var(--muted); }
  .badge { display:inline-block; font-size:0.7rem; padding:0.02rem 0.45rem; border-radius:999px;
    background:var(--accent-soft); color:var(--accent); font-weight:700; }
  .earlier { margin-top:0.4rem; }
  .earlier summary { cursor:pointer; font-size:0.82rem; color:var(--muted); font-weight:600; }
  .method { background:rgba(255,255,255,0.6); border:1px solid var(--rule);
    border-radius:0.9rem; padding:0.9rem 1.05rem; margin-top:1.4rem; }
  .method h2 { font-size:0.82rem; text-transform:uppercase; letter-spacing:0.12em;
    color:var(--muted); margin:0 0 0.4rem; }
  .method ul { margin:0; padding-left:1.1rem; }
  .method li { font-size:0.82rem; color:var(--fg-soft); margin:0.2rem 0; }
  .waiting { background:var(--card); border:1px dashed var(--rule); border-radius:1rem;
    padding:1.6rem 1.4rem; text-align:center; }
  .waiting h2 { font-family:"Fraunces","Noto Sans SC",serif; margin:0 0 0.5rem; font-size:1.25rem; }
  .waiting p { color:var(--fg-soft); font-size:0.92rem; margin:0 auto; max-width:38rem; }
  .waiting .wf { display:inline-block; margin-top:0.9rem; font-size:0.75rem; letter-spacing:0.1em;
    text-transform:uppercase; color:var(--accent); font-weight:700; }
  footer { margin-top:2.2rem; padding-top:0.9rem; border-top:1px solid var(--rule);
    color:var(--muted); font-size:0.78rem; }
  footer a { color:var(--accent); text-decoration:none; font-weight:600; }
`;

const SCRIPT = `
(function () {
  document.querySelectorAll('.day-chip').forEach(function (btn) {
    btn.addEventListener('click', function () {
      var day = btn.getAttribute('data-day');
      document.querySelectorAll('.day-chip').forEach(function (b) {
        b.classList.toggle('active', b === btn);
      });
      document.querySelectorAll('.day-panel').forEach(function (p) {
        p.classList.toggle('active', p.getAttribute('data-day-panel') === day);
      });
    });
  });
  document.querySelectorAll('.slot-chip').forEach(function (btn) {
    btn.addEventListener('click', function () {
      var slot = btn.getAttribute('data-slot');
      var panel = btn.closest('.day-panel');
      if (!panel) return;
      panel.querySelectorAll('.slot-chip').forEach(function (b) {
        b.classList.toggle('active', b === btn);
      });
      panel.querySelectorAll('.slot-panel').forEach(function (p) {
        p.classList.toggle('active', p.getAttribute('data-slot-panel') === slot);
      });
    });
  });
})();
`;

export function renderHourPage(opts: HourPageOptions): string {
  const { days, readings, timezone, expectedSlots, empty } = opts;
  const latest = days[0] ?? null;

  const dayChips = days.length
    ? `<div class="chips" role="group" aria-label="${esc(S.hourDayPicker)}">${days
        .map((d) => {
          const has = d.slots.some((s) => s.snapshot);
          return `<button type="button" class="day-chip chip ${has ? "has-data" : "is-empty"}${
            d.date === latest?.date ? " active" : ""
          }" data-day="${esc(d.date)}"><span class="dot"></span>${esc(d.date)}</button>`;
        })
        .join("")}</div>`
    : "";

  const dayPanels = days
    .map((day) => {
      const hasAny = day.slots.some((s) => s.snapshot);
      // The default view is the newest slot that actually has a capture: landing
      // on 09:35 with a gap message when 14:35 has real prose is the page
      // telling the reader "nothing happened" about the one thing it does have.
      // When the day is entirely empty, the first slot stays selected so the
      // gap explanation is what is visible.
      const defaultSlot =
        [...day.slots].reverse().find((s) => s.snapshot)?.time ?? day.slots[0]?.time;

      const slotChips = `<div class="chips" role="group" aria-label="${esc(S.hourSlotNav)}">${day.slots
        .map(
          (s) =>
            `<button type="button" class="slot-chip chip ${s.snapshot ? "has-data" : "is-empty"}${
              s.time === defaultSlot ? " active" : ""
            }" data-slot="${esc(s.time)}"><span class="dot"></span>${esc(s.time)}</button>`,
        )
        .join("")}</div>`;

      const slotPanels = day.slots
        .map((s) => {
          const reading = readings.get(`${day.date}/${s.time}`);
          let body: string;
          if (!s.snapshot || !reading) {
            body = slotGapBody(s.time);
          } else {
            const rev = s.revision > 0 ? `<span class="revnote">${esc(fill(S.hourRevisionNote, { n: s.revision }))}</span>` : "";
            body = `<div class="card" data-slot-reading="${esc(day.date)}/${esc(s.time)}">
              <div class="slot-head">
                <span class="slot-time">${esc(s.time)}</span>
                <span class="slot-date">${esc(day.date)} · ${esc(reading.timezone)}</span>
                ${rev}
              </div>
              ${slotBody(reading)}
            </div>`;
          }
          return `<section class="slot-panel${s.time === defaultSlot ? " active" : ""}" data-slot-panel="${esc(s.time)}">${body}</section>`;
        })
        .join("");

      const dayGap = hasAny
        ? ""
        : `<div class="gap-block" data-gap="day"><p class="gap-title">${esc(
            S.hourDayGapTitle,
          )}</p><p>${esc(fill(S.hourDayGapBody, { date: day.date }))}</p></div>`;

      // A run of nine "no cross-section at HH:MM" lines is noise, not a named
      // gap — the individual gaps are already visible on each slot chip and in
      // each slot's own panel. This line states the count once.
      const missingNote = day.missing.length
        ? `<p class="sent-muted" data-missing-slots="${day.missing.length}">${esc(
            fill(S.hourMissingSlots, {
              missing: day.missing.length,
              total: day.slots.length,
              slots: day.missing.join(" · "),
            }),
          )}</p>`
        : "";

      return `<div class="day-panel${day.date === latest?.date ? " active" : ""}" data-day-panel="${esc(day.date)}">
        ${dayGap}
        <div class="pickers">
          <div><p class="picker-label">${esc(S.hourSlotNav)}</p>${slotChips}</div>
        </div>
        ${slotPanels}
        ${missingNote}
      </div>`;
    })
    .join("");

  const emptyBlock = `<div class="waiting" data-empty-state="tape">
      <h2>${esc(S.hourEmptyTitle)}</h2>
      <p>${esc(S.hourEmptyBody)}</p>
      <span class="wf">${esc(S.hourEmptyWaitingFor)} · ${esc(expectedSlots[0] ?? "09:35")} ${esc(
        timezone,
      )} · 2026-11-16</span>
    </div>`;

  const method = `<section class="method">
      <h2>${esc(S.hourMethodTitle)}</h2>
      <ul>
        <li>${esc(S.hourMethodBoard)}</li>
        <li>${esc(S.hourMethodBreadth)}</li>
        <li>${esc(S.hourMethodIndex)}</li>
        <li>${esc(S.hourMethodClock)}</li>
        <li>${esc(S.hourMethodStories)}</li>
      </ul>
    </section>`;

  return `<!doctype html>
<html lang="${REPORT_LOCALE === "en" ? "en" : "zh-CN"}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(S.hourTitle)} · ${esc(S.siteTitle)}</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=DM+Sans:wght@500;700&family=Fraunces:opsz,wght@9..144,600;9..144,700&family=Noto+Sans+SC:wght@400;500;700&display=swap" rel="stylesheet">
<style>${CSS}</style>
</head>
<body>
<main>
  <header class="page-head">
    <div class="brand">${esc(S.siteTitle)}</div>
    <h1>${esc(S.hourTitle)}</h1>
    <p class="subtitle">${esc(S.hourSubtitle)}</p>
  </header>
  ${
    empty || !days.length
      ? emptyBlock
      : `<div class="pickers">
          <div><p class="picker-label">${esc(S.hourDayPicker)}</p>${dayChips}</div>
        </div>
        ${dayPanels}`
  }
  ${method}
  <footer>
    <p>${esc(S.hourFooter)}</p>
    <p><a href="./index.html">${esc(S.siteTitle)}</a> · <a href="./archive.html">${esc(
      S.archiveLink,
    )}</a> · <a href="./stories.html">${esc(S.navStories)}</a></p>
  </footer>
</main>
<script>${SCRIPT}</script>
</body>
</html>
`;
}
