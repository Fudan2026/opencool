/**
 * GOLDEN: the workflow's zero-token and publish-lag guarantees.
 *
 * Owner directive: the scheduled / CI pipeline must never spend a token, and
 * "did it publish on time" must be a machine check rather than something a
 * human or agent watches. Both are structural properties of
 * `.github/workflows/daily.yml`, so they are asserted against the file itself —
 * a future edit that reintroduces `LLM_MODE=auto`, forwards a provider key, or
 * drops the assertions fails here instead of costing tokens or silent lateness.
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const WORKFLOW = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../.github/workflows/daily.yml",
);

/** The build job's text block (from its `build:` key to the next top-level job). */
function buildJobSource(): string {
  const src = fs.readFileSync(WORKFLOW, "utf8");
  const start = src.indexOf("\n  build:");
  assert.ok(start >= 0, "build job not found in daily.yml");
  const rest = src.slice(start + 1);
  const next = rest.search(/\n {2}[a-z][\w-]*:/);
  return next >= 0 ? rest.slice(0, next) : rest;
}

function stepNames(job: string): string[] {
  return [...job.matchAll(/^ {6}- name: (.+)$/gm)].map((m) => m[1].trim());
}

/** Text of one step, from its `- name:` line to the next step or block end. */
function stepSource(job: string, name: string): string {
  const start = job.indexOf(`- name: ${name}`);
  assert.ok(start >= 0, `step "${name}" not found`);
  const rest = job.slice(start + 1);
  const next = rest.search(/\n {6}- /);
  return next >= 0 ? rest.slice(0, next) : rest;
}

test("golden: build job is structurally zero-token", async (t) => {
  const job = buildJobSource();

  await t.test("LLM_MODE is pinned to off at job level", () => {
    // Job-level env applies to every step, including future ones.
    const jobEnv = job.slice(0, job.indexOf("    steps:"));
    assert.match(
      jobEnv,
      /^ {4}env:\n(?: {6}.+\n)*? {6}LLM_MODE: 'off'$/m,
      "the build job must set LLM_MODE: 'off' in its job-level env",
    );
  });

  await t.test("the report step also pins off explicitly", () => {
    const step = stepSource(job, "Generate edition report");
    assert.match(step, /LLM_MODE: 'off'/, "report step must pin LLM_MODE: 'off'");
  });

  await t.test("no LLM_MODE=auto default survives in the build job", () => {
    assert.equal(
      /LLM_MODE:\s*\$\{\{[^}]*'auto'/.test(job),
      false,
      "LLM_MODE must not fall back to vars.*'auto' in the build job",
    );
  });

  await t.test("no provider API key is forwarded to any step", () => {
    for (const name of [
      "ZHIPU_API_KEY",
      "ANTHROPIC_API_KEY",
      "OPENAI_API_KEY",
      "DEEPSEEK_API_KEY",
      "MINIMAX_API_KEY",
      "LLM_API_KEY",
      "LLM_BACKEND",
      "LLM_MODEL",
    ]) {
      assert.equal(
        new RegExp(`${name}:\\s*\\$\\{\\{`).test(job),
        false,
        `${name} must not be wired into the build job`,
      );
    }
  });

  await t.test("a post-run zero-call assert exists and runs the script", () => {
    const names = stepNames(job);
    assert.ok(names.includes("Assert zero LLM calls"), "missing zero-LLM assert step");
    const step = stepSource(job, "Assert zero LLM calls");
    assert.match(step, /node scripts\/assert-zero-llm\.mjs/);
  });

  await t.test("the zero-call assert is scoped to this run", () => {
    const step = stepSource(job, "Assert zero LLM calls");
    assert.match(step, /--since/, "assert must count only this run's records");
    // The scope value must actually be produced by an earlier step.
    assert.match(job, /LLM_LOG_SINCE=/, "run start must export LLM_LOG_SINCE");
  });

  await t.test("the zero-call assert runs before the publish step", () => {
    const names = stepNames(job);
    const assertAt = names.indexOf("Assert zero LLM calls");
    const publishAt = names.indexOf("Publish to gh-pages");
    assert.ok(assertAt >= 0 && publishAt >= 0);
    assert.ok(
      assertAt < publishAt,
      "a call must fail the run before the edition is published",
    );
  });
});

test("golden: publish-lag assertion is wired and cannot deadlock the slot", async (t) => {
  const job = buildJobSource();
  const names = stepNames(job);

  await t.test("the assert step exists and runs the script", () => {
    assert.ok(names.includes("Assert publish lag"), "missing publish-lag assert step");
    assert.match(stepSource(job, "Assert publish lag"), /node scripts\/assert-publish-lag\.mjs/);
  });

  await t.test("it receives the gate's date, slot and timezone", () => {
    const step = stepSource(job, "Assert publish lag");
    assert.match(step, /EDITION_DATE: \$\{\{ needs\.gate\.outputs\.edition-date \}\}/);
    assert.match(step, /EDITION_HOUR: \$\{\{ needs\.gate\.outputs\.edition-hour \}\}/);
    assert.match(step, /REPORT_TZ:/);
    assert.match(step, /PUBLISH_LAG_LIMIT_MIN:/);
  });

  await t.test("it forwards the failure webhook secret", () => {
    const step = stepSource(job, "Assert publish lag");
    assert.match(step, /ALERT_WEBHOOK_URL:/);
  });

  await t.test("it runs AFTER publishing, so a late edition still goes live", () => {
    const assertAt = names.indexOf("Assert publish lag");
    const publishAt = names.indexOf("Publish to gh-pages");
    assert.ok(assertAt > publishAt, "lag assert must follow the gh-pages push");
  });

  await t.test("the gate reason reaches the assert as the trigger", () => {
    assert.match(stepSource(job, "Assert publish lag"), /EDITION_TRIGGER:/);
    const gate = fs.readFileSync(WORKFLOW, "utf8").slice(0, fs.readFileSync(WORKFLOW, "utf8").indexOf("\n  build:"));
    assert.match(gate, /reason: \$\{\{ steps\.check\.outputs\.reason \}\}/, "gate must expose its reason");
  });

  await t.test("a lag breach does not double-page with the generic failure alert", () => {
    const failure = stepSource(job, "Alert on job failure");
    assert.match(failure, /PUBLISH_LAG_NOTIFIED/);
  });
});

test("golden: a missing llm-calls.jsonl is the documented pass case", () => {
  const src = fs.readFileSync(
    path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../scripts/assert-zero-llm.mjs"),
    "utf8",
  );
  assert.match(src, /missing: true/, "absent log must be a first-class result");
  assert.match(src, /records\.length === 0/, "pass is defined as zero records");
});
