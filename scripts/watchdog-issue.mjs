#!/usr/bin/env node
/**
 * Edition watchdog issue filer — the watchdog's alert surface.
 *
 * The watchdog exists because GitHub's cron fires the Daily Brief ~8x/day
 * against a 96x/day schedule (measured: 92% of triggers dropped, editions
 * 3h+ late or never published). When a watchdog tick had to cover a slot the
 * Daily Brief's own schedule should have published (gate should-run=true), or
 * when a pipeline job failed, that must be VISIBLE — but as ONE durable
 * tracking surface, not a fresh issue per event.
 *
 * So this script maintains exactly ONE open issue labelled `edition-watch`:
 *   - no open issue with the label → create it (label auto-created if
 *     missing) and the first event is its body;
 *   - open issue exists → append the event as a comment.
 *
 * Anti-spam: every comment ends with a hidden machine marker
 * `<!-- watchdog-event: <kind> <slot> <reason> <result> -->`. If the newest
 * comment already carries the exact same marker, the tick says nothing — a
 * failing slot pings once, not four times an hour, and the recovery
 * (result changes to success) pings again.
 *
 * Usage:  node scripts/watchdog-issue.mjs
 * Env:
 *   GH_TOKEN               required — the alert job's GITHUB_TOKEN (issues: write)
 *   GITHUB_REPOSITORY      auto — owner/repo
 *   GITHUB_RUN_ID          auto — the watchdog run
 *   GITHUB_SERVER_URL      auto — run URL base
 *   WATCHDOG_SHOULD_RUN    'true' when the gate found a due slot missing/premature
 *   WATCHDOG_REASON        gate reason (catchup/backfill/exact/premature/…)
 *   WATCHDOG_EDITION_DATE  gate edition-date (may be empty)
 *   WATCHDOG_EDITION_HOUR  gate edition-hour (may be empty)
 *   WATCHDOG_RESULT        pipeline job result (success|failure|cancelled|…)
 *
 * Exits 0 when there is nothing to report or the report landed; exits 1 only
 * when filing itself failed, so a broken alert path is loud, never silent.
 */
import fs from "node:fs";
import { pathToFileURL } from "node:url";

const API_BASE = "https://api.github.com";
const LABEL = "edition-watch";

function env(name, fallback = "") {
  const v = process.env[name];
  return v === undefined || v === null ? fallback : v;
}

async function api({ path, token, method = "GET", body }) {
  const res = await fetch(`${API_BASE}/repos/${env("GITHUB_REPOSITORY")}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "opencool-edition-watchdog",
      ...(body ? { "Content-Type": "application/json" } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(15_000),
  });
  const parsed = res.status === 204 ? null : await res.json().catch(() => null);
  return { status: res.status, body: parsed };
}

/** What happened on this tick, or null when the tick has nothing to report. */
export function composeEvent() {
  const shouldRun = env("WATCHDOG_SHOULD_RUN").trim() === "true";
  const result = env("WATCHDOG_RESULT").trim() || "unknown";
  const reason = env("WATCHDOG_REASON").trim();
  const date = env("WATCHDOG_EDITION_DATE").trim();
  const hour = env("WATCHDOG_EDITION_HOUR").trim();

  if (!shouldRun && result !== "failure" && result !== "cancelled") return null;

  const slot = date && hour ? `${date}/${hour}` : "-";
  const runUrl =
    env("GITHUB_SERVER_URL") && env("GITHUB_REPOSITORY") && env("GITHUB_RUN_ID")
      ? `${env("GITHUB_SERVER_URL")}/${env("GITHUB_REPOSITORY")}/actions/runs/${env("GITHUB_RUN_ID")}`
      : "(local)";

  if (shouldRun) {
    return {
      kind: "edition-built",
      heading: "Watchdog covered a due edition slot",
      lines: [
        `- **Slot:** \`${slot}\` (Asia/Shanghai)`,
        `- **Gate reason:** \`${reason || "?"}\` — the sidecar was missing/premature at tick time; the Daily Brief schedule (cron \`4,19,34,49\`) should have published it`,
        `- **What this run did:** ran the full pipeline via \`daily-run.yml\` — **${result}**${outcomeNote(result)}`,
        `- **Run:** ${runUrl}`,
      ],
      marker: `watchdog-event: edition-built ${slot} ${reason || "-"} ${result}`,
    };
  }
  return {
    kind: "pipeline-failure",
    heading: "Watchdog pipeline job failed",
    lines: [
      `- **Gate reason at the time:** \`${reason || "-"}\` (no edition build was started by this tick)`,
      `- **What this run did:** a pipeline job failed with result **${result}**${outcomeNote(result)}`,
      `- **Run:** ${runUrl}`,
    ],
    marker: `watchdog-event: pipeline-failure ${slot} ${reason || "-"} ${result}`,
  };
}

function outcomeNote(result) {
  if (result === "success") return " — the slot was rebuilt and published";
  if (result === "failure") return " — the slot is still missing; the next ticks keep retrying (see the run log)";
  if (result === "cancelled") return " — most likely a concurrent Daily Brief build took over via the build concurrency group";
  return "";
}

function commentBody(event) {
  return [`### ${event.heading}`, "", ...event.lines, "", `<!-- ${event.marker} -->`].join("\n");
}

async function findTrackingIssue(token) {
  const r = await api({ path: `/issues?labels=${LABEL}&state=open&per_page=5`, token });
  if (r.status !== 200 || !Array.isArray(r.body)) {
    throw new Error(`issue search HTTP ${r.status}`);
  }
  // The search endpoint also returns PRs; the label is ours, but be precise.
  return (r.body.find((x) => !x.pull_request) ?? null);
}

async function ensureLabel(token) {
  const r = await api({
    path: "/labels",
    token,
    method: "POST",
    body: { name: LABEL, color: "5319e7", description: "auto-maintained by the Edition watchdog workflow" },
  });
  // 422 = already exists; anything else non-2xx is surfaced by the issue POST.
  if (r.status !== 201 && r.status !== 422) {
    console.warn(`[watchdog] label upsert HTTP ${r.status} — continuing (issue creation will fail loudly if real)`);
  }
}

async function main() {
  const token = env("GH_TOKEN");
  if (!token || !env("GITHUB_REPOSITORY")) {
    console.error("::error::watchdog-issue.mjs needs GH_TOKEN and GITHUB_REPOSITORY");
    process.exit(1);
  }

  const event = composeEvent();
  if (!event) {
    console.log(
      `[watchdog] nothing to report (should-run=${env("WATCHDOG_SHOULD_RUN") || "-"} result=${env("WATCHDOG_RESULT") || "-"})`,
    );
    process.exit(0);
  }
  console.log(`[watchdog] event: ${event.marker}`);

  let issue = await findTrackingIssue(token);

  if (!issue) {
    await ensureLabel(token);
    const body = [
      "This issue is auto-maintained by the **Edition watchdog** workflow (`.github/workflows/watchdog.yml`) as its single tracking log. It stays open: every watchdog tick that had to cover a due edition slot, or that saw a pipeline job fail, appends one comment here, deduplicated per slot/reason/outcome so a repeating failure does not spam.",
      "",
      "A **success** entry needs no action — it records that GitHub's scheduler dropped the Daily Brief's own tick and the watchdog published the edition instead. A **failure** entry means the slot was still missing after the watchdog tried; later ticks keep retrying.",
      "",
      "---",
      "",
      commentBody(event),
    ].join("\n");
    const created = await api({
      path: "/issues",
      token,
      method: "POST",
      body: { title: "Edition watchdog — missed slots & pipeline failures", body, labels: [LABEL] },
    });
    if (created.status !== 201) {
      if (created.status === 403 || created.status === 404) {
        console.error(
          `::error::cannot open the ${LABEL} issue (HTTP ${created.status}) — the watchdog needs \`issues: write\` in its workflow permissions`,
        );
      } else {
        console.error(`::error::issue creation HTTP ${created.status}: ${JSON.stringify(created.body?.message ?? "")}`);
      }
      process.exit(1);
    }
    console.log(`[watchdog] opened tracking issue #${created.body.number}: ${created.body.html_url}`);
    process.exit(0);
  }

  // Dedupe against the newest comment's marker: same slot/reason/result → silent.
  const newest = await api({ path: `/issues/${issue.number}/comments?per_page=1&sort=created&direction=desc`, token });
  if (newest.status === 200 && Array.isArray(newest.body) && newest.body.length) {
    const m = /<!--\s*watchdog-event:\s*(.+?)\s*-->/.exec(newest.body[0].body ?? "");
    if (m && m[1] === event.marker) {
      console.log(`[watchdog] newest comment already reports this exact event — not commenting`);
      process.exit(0);
    }
  }

  const comment = await api({
    path: `/issues/${issue.number}/comments`,
    token,
    method: "POST",
    body: { body: commentBody(event) },
  });
  if (comment.status !== 201) {
    console.error(`::error::comment on #${issue.number} HTTP ${comment.status}: ${JSON.stringify(comment.body?.message ?? "")}`);
    process.exit(1);
  }
  console.log(`[watchdog] updated tracking issue #${issue.number}: ${comment.body.html_url}`);
}

const invokedDirectly =
  process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url;
if (invokedDirectly) {
  main().catch((e) => {
    console.error(`[watchdog] FAILED: ${e?.message ?? e}`);
    process.exit(1);
  });
}
