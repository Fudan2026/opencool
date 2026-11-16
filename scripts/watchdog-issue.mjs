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
 * `<!-- watchdog-event: <kind> <slot> <reason> <result> [state] -->`. If the
 * newest comment already carries the exact same marker, the tick says nothing — a
 * failing slot pings once, not four times an hour, and the recovery
 * (result changes to success) pings again.
 *
 * FAILURE ENTRIES ARE PROBED, NOT ASSUMED (weekend-of-11-14 lesson): the two
 * red runs that created issue #73 both said "the slot is still missing" while
 * the slot had in fact PUBLISHED — the run went red on the publish-lag assert,
 * which by design fails the run AFTER the gh-pages push. A failure that is a
 * lag breach means "late, but live"; only a genuine build failure means
 * missing. So on failure/cancelled the filer probes the sidecar on gh-pages
 * (200-only rule, same as the gate) and writes what is actually true, with the
 * probe state appended to the marker so a state change (missing → live)
 * re-pings instead of being deduped away.
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

/**
 * Is the slot's sidecar live on gh-pages? 200-only rule, same as the gate:
 * a clean 200 (with or without a readable generated_at) is the only "live";
 * 404 is "missing"; anything else (403/429/5xx/network) is "unknown" — a
 * probe that cannot tell must not claim either way in the issue comment.
 */
export async function probeSidecarLive({ repo, token, date, hour, fetchImpl = fetch }) {
  if (!repo || !token || !date || !hour) return { status: "unknown", generatedAt: null };
  const relPath = `${date}/${hour.padStart(2, "0")}.json`;
  let res;
  try {
    res = await fetchImpl(`${API_BASE}/repos/${repo}/contents/${relPath}?ref=gh-pages`, {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        "User-Agent": "opencool-edition-watchdog",
      },
      signal: AbortSignal.timeout(15_000),
    });
  } catch (e) {
    console.warn(`[watchdog] probe ${relPath} failed: ${e?.message ?? e}`);
    return { status: "unknown", generatedAt: null };
  }
  if (res.status === 404) return { status: "missing", generatedAt: null };
  if (res.status !== 200) {
    console.warn(`[watchdog] probe ${relPath}: HTTP ${res.status} — treating as unknown`);
    return { status: "unknown", generatedAt: null };
  }
  let generatedAt = null;
  try {
    const body = await res.json();
    if (body && typeof body.content === "string" && body.content.length) {
      const text = Buffer.from(body.content, body.encoding === "base64" ? "base64" : "utf8").toString("utf8");
      const parsed = JSON.parse(text);
      const raw = parsed?.fetch_health?.generated_at;
      generatedAt = typeof raw === "string" && raw.trim() ? raw.trim() : null;
    }
  } catch {
    // A 200 is live even when the generated_at is unreadable — same
    // convention as the gate: a file we cannot interpret is not missing.
  }
  return { status: "live", generatedAt };
}

/** What happened on this tick, or null when the tick has nothing to report. */
export function composeEvent(slotProbe = null) {
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
        `- **What this run did:** ran the full pipeline via \`daily-run.yml\` — **${result}**${outcomeNote(result, slotProbe)}`,
        `- **Run:** ${runUrl}`,
      ],
      marker: `watchdog-event: edition-built ${slot} ${reason || "-"} ${result}${slotProbe ? ` ${slotProbe.status}` : ""}`,
    };
  }
  return {
    kind: "pipeline-failure",
    heading: "Watchdog pipeline job failed",
    lines: [
      `- **Gate reason at the time:** \`${reason || "-"}\` (no edition build was started by this tick)`,
      `- **What this run did:** a pipeline job failed with result **${result}**${outcomeNote(result, null)}`,
      `- **Run:** ${runUrl}`,
    ],
    marker: `watchdog-event: pipeline-failure ${slot} ${reason || "-"} ${result}`,
  };
}

/**
 * The outcome clause. `slotProbe` is the sidecar probe result taken at comment
 * time (null when no slot was named or the run succeeded — a green run's
 * "rebuilt and published" is already the pipeline's own claim).
 *
 * The failure branch is the weekend-of-11-14 fix: a red run is NOT proof the
 * slot is missing — the publish-lag assert fails the run AFTER the gh-pages
 * push, so "late but live" is the common failure. The note must say what the
 * probe saw, and "unknown" stays hedged rather than guessing.
 */
export function outcomeNote(result, slotProbe = null) {
  if (result === "success") return " — the slot was rebuilt and published";
  if (result === "failure") {
    if (slotProbe?.status === "live") {
      const at = slotProbe.generatedAt ? `, sidecar \`fetch_health.generated_at = ${slotProbe.generatedAt}\`` : "";
      return ` — the slot DID publish${at}; the run went red on a later step, typically the publish-lag assert flagging the lateness (a late edition publishes first, then turns the run red — by design). The next tick's gate will see the slot as met`;
    }
    if (slotProbe?.status === "missing") {
      return " — the slot is still missing after this run; the next ticks keep retrying (see the run log)";
    }
    if (slotProbe?.status === "unknown") {
      return " — the slot state could not be verified from here (sidecar probe failed); check the run log and the archive";
    }
    return " — a pipeline job failed after this tick; check the run log for whether the slot published";
  }
  if (result === "cancelled") {
    const probe = slotProbe?.status === "live" ? "; the slot is live as of this comment" : slotProbe?.status === "missing" ? "; the slot is still missing as of this comment" : "";
    return ` — most likely a concurrent Daily Brief build took over via the build concurrency group${probe}`;
  }
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

  // Probe the sidecar BEFORE composing: on failure/cancelled with a named
  // slot, the comment must state what is actually in the archive, not what
  // the run's colour implies (a lag-breach failure is "late, but live").
  const shouldRun = env("WATCHDOG_SHOULD_RUN").trim() === "true";
  const result = env("WATCHDOG_RESULT").trim() || "unknown";
  const date = env("WATCHDOG_EDITION_DATE").trim();
  const hour = env("WATCHDOG_EDITION_HOUR").trim();
  let slotProbe = null;
  if (shouldRun && date && hour && (result === "failure" || result === "cancelled")) {
    slotProbe = await probeSidecarLive({
      repo: env("GITHUB_REPOSITORY"),
      token,
      date,
      hour,
    });
    console.log(`[watchdog] sidecar probe: ${slotProbe.status}${slotProbe.generatedAt ? ` (generated_at ${slotProbe.generatedAt})` : ""}`);
  }

  const event = composeEvent(slotProbe);
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
      "A **success** entry needs no action — it records that GitHub's scheduler dropped the Daily Brief's own tick and the watchdog published the edition instead. A **failure** entry means a pipeline job failed on that tick — the comment says what the sidecar probe saw: a publish-lag breach fails the run AFTER the edition goes live (\"late, but live\"), and only a genuinely missing slot keeps retrying on later ticks.",
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
