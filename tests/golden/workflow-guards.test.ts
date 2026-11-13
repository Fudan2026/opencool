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

test("golden: daily.yml stays parseable — no inline multi-line scripts", async (t) => {
  /**
   * A workflow that does not parse fails the run before any step executes.
   * That is what happened when an inline `node -e '…'` block with an unquoted
   * `:` landed in the tape job: every push went red in 0s with "This run likely
   * failed because of a workflow file issue", and no test caught it because the
   * guards above only regex the text.
   *
   * The project ships zero dependencies, so there is no YAML parser here. The
   * hazard is specific and cheap to ban structurally: a multi-line quoted shell
   * body is the only construct in this file that can break YAML while still
   * looking correct. Scripts belong in `scripts/`, invoked by path.
   */
  const src = fs.readFileSync(WORKFLOW, "utf8");

  await t.test("the three jobs exist at two-space indent", () => {
    for (const job of ["gate", "build", "tape"]) {
      assert.match(src, new RegExp(`^  ${job}:$`, "m"), `job "${job}" must exist`);
    }
  });

  await t.test("no inline multi-line node block (the unparseable-YAML hazard)", () => {
    assert.deepEqual(
      [...src.matchAll(/run:\s*node\s+--input-type=module/g)].map((m) => m[0]),
      [],
      "move inline node -e bodies into scripts/ — a bare colon inside them breaks the YAML",
    );
    assert.deepEqual([...src.matchAll(/run:\s*node\s+-e\s/g)].map((m) => m[0]), []);
  });

  await t.test("every `run:` is a single-line command or a block scalar", () => {
    // `run: ` must be followed by either more text on the same line or `>` / `|`.
    for (const m of src.matchAll(/^ {8}run: (.*)$/gm)) {
      const rest = m[1].trim();
      assert.ok(rest.length > 0, "a run: key with no command and no block scalar is a parse error");
    }
  });
});

test("golden: the story ledger bake is wired into the build job", async (t) => {
  const job = buildJobSource();
  const names = stepNames(job);

  await t.test("the step exists and runs the npm script", () => {
    assert.ok(names.includes("Bake story ledger"), "missing story ledger bake step");
    assert.match(stepSource(job, "Bake story ledger"), /npm run stories:bake/);
  });

  await t.test("it runs before the publish step, so stories.json ships", () => {
    const bakeAt = names.indexOf("Bake story ledger");
    const publishAt = names.indexOf("Publish to gh-pages");
    assert.ok(bakeAt >= 0 && publishAt >= 0);
    assert.ok(bakeAt < publishAt, "the ledger must be written before publishing");
  });

  await t.test("it runs after the gh-pages restore, so the prior ledger is available", () => {
    const restoreAt = names.indexOf("Restore existing reports from gh-pages");
    const bakeAt = names.indexOf("Bake story ledger");
    assert.ok(restoreAt >= 0);
    assert.ok(
      restoreAt < bakeAt,
      "without the restore the ledger would restart from empty on every edition",
    );
  });

  await t.test("the bake step receives the report timezone", () => {
    // This is the regression that shipped: without REPORT_TZ the bake wrote
    // `timezone: "system"` and `+00:00` instants, and the run stayed green.
    const step = stepSource(job, "Bake story ledger");
    assert.match(step, /REPORT_TZ:/, "stories:bake must get REPORT_TZ");
    assert.match(step, /vars\.REPORT_TZ \|\| 'Asia\/Shanghai'/);
  });

  await t.test("an assert rejects a mis-stamped ledger before it publishes", () => {
    assert.ok(names.includes("Assert story ledger timezone"), "missing ledger timezone assert");
    const step = stepSource(job, "Assert story ledger timezone");
    assert.match(step, /daily_reports\/stories\.json/);
    assert.match(step, /process\.exit\(1\)/, "the assert must fail the run, not warn");
    assert.match(step, /REPORT_TZ:/);
    const assertAt = names.indexOf("Assert story ledger timezone");
    const publishAt = names.indexOf("Publish to gh-pages");
    assert.ok(assertAt < publishAt, "a bad ledger must not reach gh-pages");
  });
});

/**
 * The reaction bake joins the tape and the ledger and publishes a number whose
 * whole value is that it can be trusted. Its wiring is therefore asserted
 * structurally: it must sit after both inputs exist, before the publish, and
 * before the zero-token assert — and it must be guarded by the honesty check,
 * because a green run publishing an unmeasurable mean is the exact failure this
 * repo has shipped twice.
 */
test("golden: reaction windows bake is wired between the ledger and the guards", async (t) => {
  const job = buildJobSource();
  const names = stepNames(job);

  await t.test("the bake step exists and runs the npm script", () => {
    assert.ok(names.includes("Bake reaction windows"), "missing reaction bake step");
    assert.match(stepSource(job, "Bake reaction windows"), /npm run reactions:bake/);
  });

  await t.test("it runs after the story ledger it reads", () => {
    const ledgerAt = names.indexOf("Bake story ledger");
    const bakeAt = names.indexOf("Bake reaction windows");
    assert.ok(ledgerAt >= 0 && bakeAt >= 0);
    assert.ok(ledgerAt < bakeAt, "reactions read stories.json, so the ledger must be baked first");
  });

  await t.test("it runs after the gh-pages restore, so prior tape history is on disk", () => {
    const restoreAt = names.indexOf("Restore existing reports from gh-pages");
    const bakeAt = names.indexOf("Bake reaction windows");
    assert.ok(restoreAt >= 0 && restoreAt < bakeAt);
  });

  await t.test("it runs before the zero-token assert", () => {
    const bakeAt = names.indexOf("Bake reaction windows");
    const assertAt = names.indexOf("Assert zero LLM calls");
    assert.ok(bakeAt >= 0 && assertAt >= 0 && bakeAt < assertAt);
  });

  await t.test("it runs before publishing, so reactions.json ships", () => {
    const bakeAt = names.indexOf("Bake reaction windows");
    const publishAt = names.indexOf("Publish to gh-pages");
    assert.ok(bakeAt < publishAt);
  });

  await t.test("an honesty assert runs a real script, before publishing", () => {
    assert.ok(names.includes("Assert reaction windows are honest"), "missing reactions honesty assert");
    const step = stepSource(job, "Assert reaction windows are honest");
    assert.match(step, /node scripts\/assert-reactions\.mjs/);
    assert.ok(
      names.indexOf("Assert reaction windows are honest") < names.indexOf("Publish to gh-pages"),
      "a dishonest reactions.json must not reach gh-pages",
    );
  });

  await t.test("the bake is zero-token by construction", () => {
    // The job-level pin covers it, and the bake may not opt out of it.
    assert.equal(
      /LLM_MODE:\s*(?!'off')/.test(stepSource(job, "Bake reaction windows")),
      false,
      "the reaction bake must not set any LLM_MODE other than off",
    );
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

/**
 * The tape job is held to the same zero-token rule as the build job, and must
 * not be able to disturb the edition path. Both are structural properties of
 * `daily.yml`, so they are asserted against the file: a future edit that drops
 * the pin, forwards a key, or reshapes the edition publish fails here.
 */
test("golden: tape job is zero-token and cannot disturb the edition path", async (t) => {
  const src = fs.readFileSync(WORKFLOW, "utf8");
  const start = src.indexOf("\n  tape:");
  assert.ok(start >= 0, "tape job not found in daily.yml");
  const rest = src.slice(start + 1);
  const next = rest.search(/\n {2}[a-z][\w-]*:/);
  const job = next >= 0 ? rest.slice(0, next) : rest;

  await t.test("LLM_MODE is pinned to off at job level", () => {
    const jobEnv = job.slice(0, job.indexOf("    steps:"));
    assert.match(
      jobEnv,
      /^ {4}env:\n(?: {6}.+\n)*? {6}LLM_MODE: 'off'$/m,
      "the tape job must set LLM_MODE: 'off' in its job-level env",
    );
  });

  await t.test("the capture step also pins off explicitly", () => {
    assert.match(stepSource(job, "Capture snapshot"), /LLM_MODE: 'off'/);
  });

  await t.test("no provider key is forwarded to any tape step", () => {
    for (const name of ["ZHIPU_API_KEY", "ANTHROPIC_API_KEY", "OPENAI_API_KEY", "DEEPSEEK_API_KEY", "MINIMAX_API_KEY"]) {
      assert.equal(new RegExp(`${name}:\\s*\\$\\{\\{`).test(job), false, `${name} must not reach the tape job`);
    }
  });

  await t.test("a zero-call assert runs, scoped to the run, before publish", () => {
    const names = stepNames(job);
    assert.ok(names.includes("Assert zero LLM calls"), "missing zero-LLM assert in the tape job");
    const step = stepSource(job, "Assert zero LLM calls");
    assert.match(step, /node scripts\/assert-zero-llm\.mjs/);
    assert.match(step, /--since/);
    assert.match(job, /LLM_LOG_SINCE=/, "run start must export LLM_LOG_SINCE");
    assert.ok(
      names.indexOf("Assert zero LLM calls") < names.indexOf("Publish tape to gh-pages"),
      "a logged call must fail before the tape is published",
    );
  });

  await t.test("the tape publish never deletes what the edition job wrote", () => {
    // `keep_files: false` in the tape job would wipe every edition on gh-pages.
    const publish = stepSource(job, "Publish tape to gh-pages");
    assert.match(publish, /keep_files: true/);
  });

  await t.test("the integrity assert runs a real script, before publish", () => {
    const names = stepNames(job);
    const step = stepSource(job, "Assert snapshot integrity");
    assert.match(step, /node scripts\/assert-tape-snapshot\.mjs/);
    assert.match(step, /--date/);
    assert.match(step, /--slot/);
    assert.ok(
      names.indexOf("Assert snapshot integrity") < names.indexOf("Publish tape to gh-pages"),
      "an unreadable snapshot must fail before it is published",
    );
  });

  await t.test("the edition publish is untouched", () => {
    // The edition job restores and publishes the whole tree; both behaviours
    // are load-bearing and predate the tape.
    const build = buildJobSource();
    assert.match(stepSource(build, "Publish to gh-pages"), /keep_files: false/);
    assert.match(stepSource(build, "Restore existing reports from gh-pages"), /checkout origin\/gh-pages -- \./);
  });

  await t.test("the tape job consumes only the gate's tape outputs", () => {
    assert.match(job, /needs\.gate\.outputs\.tape-slot/);
    assert.match(job, /needs\.gate\.outputs\.tape-date/);
    assert.equal(job.includes("needs.gate.outputs.should-run"), false, "the tape job must not key on the edition decision");
    assert.equal(job.includes("needs.gate.outputs.edition-date"), false);
  });

  await t.test("the gate exposes the tape outputs and runs the tape decision", () => {
    const gate = src.slice(0, src.indexOf("\n  build:"));
    for (const out of ["tape-should-run", "tape-date", "tape-slot", "tape-reason"]) {
      assert.match(gate, new RegExp(`^ {6}${out}: \\$\\{\\{ steps\\.tape\\.outputs\\.${out} \\}\\}$`, "m"));
    }
    const step = stepSource(gate, "Check tape schedule");
    assert.match(step, /node scripts\/gate\.mjs --mode=tape/);
  });

  await t.test("the gate job stays cheap: no npm ci, no setup-node", () => {
    const gate = src.slice(0, src.indexOf("\n  build:"));
    assert.equal(
      /uses: actions\/setup-node/.test(gate),
      false,
      "the gate must not set up Node",
    );
    assert.equal(/run: npm ci/.test(gate), false, "the gate must not install dependencies");
    // …and the tape decision reuses the single sparse checkout of gate.mjs
    // instead of adding a second checkout.
    assert.equal(
      (src.match(/sparse-checkout: \|/g) ?? []).length,
      1,
      "the tape decision must reuse the gate's one sparse checkout, not add another",
    );
  });

  await t.test("a tape tick does not cancel an in-flight capture", () => {
    assert.match(job, /cancel-in-progress: false/);
  });
});
