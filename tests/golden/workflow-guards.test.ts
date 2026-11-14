/**
 * GOLDEN: the workflow's zero-token and publish-lag guarantees.
 *
 * Owner directive: the scheduled / CI pipeline must never spend a token, and
 * "did it publish on time" must be a machine check rather than something a
 * human or agent watches. Both are structural properties of the workflow
 * YAML, so they are asserted against the files themselves — a future edit that
 * reintroduces `LLM_MODE=auto`, forwards a provider key, or drops the
 * assertions fails here instead of costing tokens or silent lateness.
 *
 * Since the watchdog split there are THREE files under test:
 *   - `daily-run.yml`  — the reusable pipeline (workflow_call): the whole job
 *     DAG and every guard live HERE, once, for both callers;
 *   - `daily.yml`      — thin caller: cron 4,19,34,49 + push + dispatch;
 *   - `watchdog.yml`   — second caller: cron 2,17,32,47 + dispatch, plus the
 *     edition-watch issue alert on a gate that had to act or a job that
 *     failed.
 * Job-level assertions read the runner; caller-shape assertions read both
 * callers; parseability/no-inline-script assertions read all three files.
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const WORKFLOWS_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../.github/workflows",
);
const RUNNER = path.join(WORKFLOWS_DIR, "daily-run.yml");
const DAILY = path.join(WORKFLOWS_DIR, "daily.yml");
const WATCHDOG = path.join(WORKFLOWS_DIR, "watchdog.yml");
const REPO_ROOT = path.resolve(WORKFLOWS_DIR, "../..");
const ALL_WORKFLOWS: [string, string][] = [
  ["daily.yml", DAILY],
  ["watchdog.yml", WATCHDOG],
  ["daily-run.yml", RUNNER],
];

const readWorkflow = (p: string): string => fs.readFileSync(p, "utf8");

/** The build job's text block (from its `build:` key to the next top-level job). */
function buildJobSource(): string {
  const src = readWorkflow(RUNNER);
  const start = src.indexOf("\n  build:");
  assert.ok(start >= 0, "build job not found in daily-run.yml");
  const rest = src.slice(start + 1);
  const next = rest.search(/\n {2}[a-z][\w-]*:/);
  return next >= 0 ? rest.slice(0, next) : rest;
}

/** Text of one job in a workflow (from its 2-space key to the next job). */
function jobSource(src: string, jobId: string): string {
  const start = src.indexOf(`\n  ${jobId}:`);
  assert.ok(start >= 0, `job "${jobId}" not found`);
  const rest = src.slice(start + 1);
  const next = rest.search(/\n {2}[a-z][\w-]*:/);
  return next >= 0 ? rest.slice(0, next) : rest;
}

/** The gate job (everything before `build:`) of the reusable pipeline. */
function gateSource(): string {
  const src = readWorkflow(RUNNER);
  const gate = src.slice(0, src.indexOf("\n  build:"));
  assert.ok(gate.includes("  gate:"), "gate job not found in daily-run.yml");
  return gate;
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

test("golden: the pipeline is one reusable workflow with two thin callers", async (t) => {
  const runner = readWorkflow(RUNNER);
  const daily = readWorkflow(DAILY);
  const watchdog = readWorkflow(WATCHDOG);

  await t.test("daily-run.yml is a workflow_call reusable pipeline", () => {
    assert.match(runner, /^on:\n {2}workflow_call:$/m);
    assert.doesNotMatch(runner, /^ {2}schedule:/m, "the runner must not schedule itself — only callers trigger");
  });

  await t.test("daily.yml keeps its triggers and calls the pipeline", () => {
    assert.match(daily, /cron: '4,19,34,49 \* \* \* \*'/, "daily.yml must keep its historical cron offsets");
    assert.match(daily, /push:\n {4}branches: \[main\]/);
    assert.match(daily, /workflow_dispatch:/);
    assert.match(daily, /uses: \.\/\.github\/workflows\/daily-run\.yml/);
    assert.match(daily, /secrets: inherit/);
  });

  await t.test("watchdog.yml interleaves its own schedule, two minutes early", () => {
    assert.match(watchdog, /cron: '2,17,32,47 \* \* \* \*'/);
    assert.equal(
      /cron: '4,19,34,49/.test(watchdog),
      false,
      "the watchdog must NOT reuse daily.yml's offsets — identical crons correlate the drops",
    );
    assert.match(watchdog, /workflow_dispatch:/, "the owner must be able to click the watchdog");
    assert.equal(/push:/.test(watchdog), false, "daily.yml owns the push trigger");
    assert.match(watchdog, /uses: \.\/\.github\/workflows\/daily-run\.yml/);
    assert.match(watchdog, /secrets: inherit/);
  });

  await t.test("the runner forwards the gate's decision outputs to its callers", () => {
    for (const out of [
      "should-run",
      "edition-date",
      "edition-hour",
      "reason",
      "tape-should-run",
      "tape-date",
      "tape-slot",
      "tape-reason",
    ]) {
      assert.match(
        runner,
        new RegExp(`^ {6}${out}:\n {8}value: \\$\\{\\{ jobs\\.gate\\.outputs\\.${out} \\}\\}$`, "m"),
        `workflow_call output "${out}" must map the gate job's output`,
      );
    }
  });

  await t.test("both callers grant the permissions the pipeline needs", () => {
    for (const src of [daily, watchdog]) {
      assert.match(src, /^ {2}contents: write$/m);
      assert.match(src, /^ {2}actions: read$/m);
    }
    assert.match(watchdog, /^ {2}issues: write$/m, "the watchdog alert job needs issues: write");
    assert.doesNotMatch(runner, /^ {2}issues: write$/m, "the pipeline itself must not need the issue scope");
  });

  await t.test("neither caller gates the pipeline call", () => {
    for (const [name, job] of [
      ["daily.yml", jobSource(daily, "daily")],
      ["watchdog.yml", jobSource(watchdog, "pipeline")],
    ] as [string, string][]) {
      assert.doesNotMatch(
        job,
        /^ {4}if:/m,
        `${name} must let every tick reach the gate — a caller-side if: would skip editions`,
      );
    }
  });

  await t.test("the tape-slot dispatch input is plumbed through both callers", () => {
    for (const [name, src] of [
      ["daily.yml", daily],
      ["watchdog.yml", watchdog],
    ] as [string, string][]) {
      assert.match(src, /tape_slot:/, `${name} must expose the tape_slot dispatch input`);
      assert.match(src, /tape_slot: \$\{\{ inputs\.tape_slot \|\| '' \}\}/, `${name} must forward tape_slot to the pipeline`);
    }
    const gateTape = stepSource(gateSource(), "Check tape schedule");
    assert.match(gateTape, /TAPE_SLOT: \$\{\{ inputs\.tape_slot/, "the gate must read the workflow_call input");
  });

  await t.test("the build job keeps its cross-caller concurrency group", () => {
    // The group NAME is repo-global: whichever caller's tick wins it, the
    // other queues or cancels — never a double publish.
    const job = buildJobSource();
    assert.match(job, /group: daily-brief-build/);
    assert.match(job, /cancel-in-progress: true/);
    for (const src of [daily, watchdog]) {
      assert.doesNotMatch(src, /concurrency:/, "callers must not add a workflow-level concurrency that could queue-block gates");
    }
  });
});

test("golden: the runner keeps every bake/assert step, in order, for both callers", async (t) => {
  // The callers share this ONE job graph, so a dropped or reordered guard
  // regresses BOTH schedules at once. The exact ordered step lists freeze the
  // DAG as it was extracted from the monolithic daily.yml.
  const expectedSteps: [string, string[]][] = [
    [
      "gate",
      ["Checkout gate script", "Check schedule", "Check tape schedule"],
    ],
    [
      "build",
      [
        "Checkout code",
        "Setup Node",
        "Install dependencies",
        "Record run start",
        "Typecheck",
        "Test suite (quality gate)",
        "Validate source config",
        "Restore existing reports from gh-pages",
        "Note whether this edition was already live",
        "Bake pre-market tips",
        "Bake dragon-tiger list",
        "Generate edition report",
        "Build trails page (favorites)",
        "Bake keyword heat (7d)",
        "Bake weekly review (7d)",
        "Bake theme heat",
        "Bake story ledger",
        "Assert story ledger timezone",
        "Bake reaction windows",
        "Assert reaction windows are honest",
        "Assert theme boards resolved",
        "Bake trend periods",
        "Bake search index",
        "Build reading pages (hour + stories)",
        "Bake v1 namespace and integrity page",
        "Assert v1 contract",
        "Build static site (index + archive)",
        "Assert zero LLM calls",
        "Alert if edition HTML missing or empty",
        "Capture the published archive snapshot",
        "Publish to gh-pages",
        "Assert archive survived publish",
        "Assert publish lag",
        "Push new edition (opt-in)",
        "Alert on job failure",
      ],
    ],
    [
      "tape",
      [
        "Checkout code",
        "Setup Node",
        "Install dependencies",
        "Record run start",
        "Restore existing tape from gh-pages",
        "Capture snapshot",
        "Rebuild intraday page",
        "Assert zero LLM calls",
        "Assert snapshot integrity",
        "Publish tape to gh-pages",
        "Alert on tape failure",
      ],
    ],
    [
      "pages",
      [
        "Checkout code",
        "Setup Node",
        "Install dependencies",
        "Record run start",
        "Restore tape, ledger and editions from gh-pages",
        "Build reading pages",
        "Assert zero LLM calls",
        "Assert both pages exist",
        "Bake reaction windows",
        "Assert reaction windows are honest",
        "Bake v1 namespace and integrity page",
        "Assert v1 contract",
        "Publish reading pages and tape",
        "Alert on pages failure",
      ],
    ],
  ];

  const src = readWorkflow(RUNNER);
  for (const [jobId, steps] of expectedSteps) {
    await t.test(`${jobId} job: exact step order`, () => {
      assert.deepEqual(stepNames(jobSource(src, jobId)), steps);
    });
  }
});

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
    assert.match(gateSource(), /reason: \$\{\{ steps\.check\.outputs\.reason \}\}/, "gate must expose its reason");
  });

  await t.test("a lag breach does not double-page with the generic failure alert", () => {
    const failure = stepSource(job, "Alert on job failure");
    assert.match(failure, /PUBLISH_LAG_NOTIFIED/);
  });
});

test("golden: all three workflow files stay parseable — no inline multi-line scripts", async (t) => {
  /**
   * A workflow that does not parse fails the run before any step executes.
   * That is what happened when an inline `node -e '…'` block with an unquoted
   * `:` landed in the tape job: every push went red in 0s with "This run likely
   * failed because of a workflow file issue", and no test caught it because
   * the guards above only regex the text.
   *
   * The project ships zero dependencies, so there is no YAML parser here. The
   * hazard is specific and cheap to ban structurally: a multi-line quoted shell
   * body is the only construct that can break YAML while still looking
   * correct. Scripts belong in `scripts/`, invoked by path.
   */
  await t.test("the four pipeline jobs exist at two-space indent in the runner", () => {
    const src = readWorkflow(RUNNER);
    for (const job of ["gate", "build", "tape", "pages"]) {
      assert.match(src, new RegExp(`^ {2}${job}:$`, "m"), `job "${job}" must exist in daily-run.yml`);
    }
  });

  for (const [name, file] of ALL_WORKFLOWS) {
    await t.test(`${name}: no inline multi-line node block (the unparseable-YAML hazard)`, () => {
      const src = readWorkflow(file);
      assert.deepEqual(
        [...src.matchAll(/run:\s*node\s+--input-type=module/g)].map((m) => m[0]),
        [],
        "move inline node -e bodies into scripts/ — a bare colon inside them breaks the YAML",
      );
      assert.deepEqual([...src.matchAll(/run:\s*node\s+-e\s/g)].map((m) => m[0]), []);
    });

    await t.test(`${name}: every \`run:\` is a single-line command or a block scalar`, () => {
      // `run: ` must be followed by either more text on the same line or `>` / `|`.
      const src = readWorkflow(file);
      for (const m of src.matchAll(/^ {8}run: (.*)$/gm)) {
        const rest = m[1].trim();
        assert.ok(rest.length > 0, "a run: key with no command and no block scalar is a parse error");
      }
    });
  }
});

test("golden: every workflow file pins zero-token wherever LLM_MODE appears", async (t) => {
  // The callers cannot set env on a `uses:` job, so the pin lives once in the
  // runner and covers BOTH callers structurally. This sweep makes sure no
  // file anywhere sets any other mode and no provider key leaks anywhere.
  for (const [name, file] of ALL_WORKFLOWS) {
    await t.test(`${name}: every LLM_MODE occurrence is 'off'`, () => {
      const src = readWorkflow(file);
      const occurrences = [...src.matchAll(/LLM_MODE:\s*(.+)$/gm)].map((m) => m[1].trim());
      if (file === RUNNER) {
        assert.ok(occurrences.length >= 3, "the runner must pin LLM_MODE in build, tape and pages");
      }
      for (const v of occurrences) {
        assert.equal(v, "'off'", `${name} sets LLM_MODE: ${v} — only 'off' is allowed in CI`);
      }
    });

    await t.test(`${name}: no provider key is wired into the workflow`, () => {
      const src = readWorkflow(file);
      for (const key of [
        "ZHIPU_API_KEY",
        "ANTHROPIC_API_KEY",
        "OPENAI_API_KEY",
        "DEEPSEEK_API_KEY",
        "MINIMAX_API_KEY",
        "LLM_API_KEY",
      ]) {
        assert.equal(new RegExp(`${key}:\\s*\\$\\{\\{`).test(src), false, `${key} must not reach ${name}`);
      }
    });
  }
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

/**
 * The reading pages must publish on a day with NO edition due — that is the
 * exact failure this job exists to prevent. After the feature merged on a
 * Saturday, the gate answered `all-published`, the build job was skipped, and
 * /hour.html and /stories.html 404'd for days while the code was on main. The
 * `tape` job could not cover it either: it is gated on a capture being due, and
 * a weekend never captures.
 *
 * So these assertions are about UNCONDITIONALITY: the job must run when every
 * other job was skipped, must not depend on an edition or a capture, and must
 * publish with `keep_files: true` so it cannot delete what it did not write.
 */
test("golden: reading pages publish even when no edition is due", async (t) => {
  const src = readWorkflow(RUNNER);
  const job = jobSource(src, "pages");

  await t.test("the job exists and is not gated on should-run or a tape capture", () => {
    const ifLine = /^ {4}if: (.+)$/m.exec(job);
    assert.ok(ifLine, "the pages job must declare an if:");
    assert.equal(ifLine[1].trim(), "always() && !cancelled()", "pages must run unconditionally");
    // Belt and braces: neither the `if:` expression nor the job body may consult
    // a gating output. The v1 namespace now lives here too, so a re-gate would
    // take the integrity surface offline with it.
    assert.equal(
      /needs\.gate\.outputs\./.test(ifLine[1]),
      false,
      "the pages if: must not consult a gate output",
    );
    assert.equal(
      /needs\.gate\.outputs\.(should-run|tape-should-run)/.test(job),
      false,
      "the pages job must not key on an edition or tape decision",
    );
  });

  await t.test("it can run after skipped dependencies", () => {
    // `needs: [gate, build, tape]` + `always()` is what lets it run when build
    // and tape were skipped, which is the normal weekend case.
    assert.match(job, /needs: \[gate, build, tape\]/);
  });

  await t.test("it builds both pages and asserts they exist before publishing", () => {
    const names = stepNames(job);
    assert.ok(names.includes("Build reading pages"));
    assert.match(stepSource(job, "Build reading pages"), /npm run reading:pages/);
    assert.ok(names.includes("Assert both pages exist"));
    const assertStep = stepSource(job, "Assert both pages exist");
    assert.match(assertStep, /node scripts\/assert-reading-pages\.mjs/);
    assert.ok(
      names.indexOf("Assert both pages exist") < names.indexOf("Publish reading pages and tape"),
      "an empty page must fail before it is published",
    );
  });

  /**
   * The `/v1` namespace and `/integrity.html` hit the identical failure: they
   * shipped inside `build`, the first post-merge run was a Saturday, the gate
   * answered `all-published`, and every URL 404'd while the suite was green.
   * A coverage surface that only publishes when an edition happens to build
   * cannot report its own gaps, so its publication must be unconditional too.
   */
  await t.test("the v1 bake lives in this job, before the publish step", () => {
    const names = stepNames(job);
    assert.ok(names.includes("Bake v1 namespace and integrity page"), "missing v1 bake step");
    assert.match(
      stepSource(job, "Bake v1 namespace and integrity page"),
      /npm run v1:bake/,
      "the pages job must run the v1 bake, not a copy of it",
    );
    assert.ok(names.includes("Assert v1 contract"), "missing v1 contract assert");
    assert.match(stepSource(job, "Assert v1 contract"), /npm run assert:v1/);

    const bakeAt = names.indexOf("Bake v1 namespace and integrity page");
    const assertAt = names.indexOf("Assert v1 contract");
    const publishAt = names.indexOf("Publish reading pages and tape");
    assert.ok(publishAt >= 0);
    assert.ok(bakeAt < assertAt, "the assert must check what the bake wrote");
    assert.ok(assertAt < publishAt, "a broken v1 file must not reach gh-pages");
  });

  await t.test("the v1 bake gets the report timezone and no provider key", () => {
    const step = stepSource(job, "Bake v1 namespace and integrity page");
    assert.match(step, /REPORT_TZ:/, "v1 clocks carry the market offset");
    assert.equal(/API_KEY:\s*\$\{\{/.test(step), false, "the v1 bake is arithmetic over local files");
    assert.equal(/LLM_MODE:\s*'auto'/.test(step), false);
  });

  await t.test("it restores every input the v1 re-exports read", () => {
    const step = stepSource(job, "Restore tape, ledger and editions from gh-pages");
    // stories.json and themes.json are re-exported verbatim; reactions.json is
    // optional (absent until its own bake ships) so its restore is `|| true`.
    // Only inputs are restored — restoring the previous `v1/` tree would be
    // pointless: `keep_files: true` merges directories on the remote, so a
    // locally pruned file cannot be removed from gh-pages from here anyway.
    assert.match(step, /checkout origin\/gh-pages -- stories\.json/);
    assert.match(step, /checkout origin\/gh-pages -- themes\.json/);
    assert.match(step, /checkout origin\/gh-pages -- reactions\.json \|\| true/);
  });

  await t.test("it restores the edition sidecars so integrity.html keeps the real lag table", () => {
    // The honesty defect: this job's v1 bake re-renders integrity.html every
    // tick, and assert:v1 requires it on disk — with only tape/ledger
    // restored, the publish-lag table rendered the named no-measurement
    // state and OVERWROTE the build job's real 14-day table ~40s after every
    // edition publish. The sidecars must be in the tree the bake reads.
    const step = stepSource(job, "Restore tape, ledger and editions from gh-pages");
    assert.match(
      step,
      /checkout origin\/gh-pages -- '2\*' \|\| true/,
      "the pages job must restore the edition dirs for the v1 publish-lag table",
    );
  });

  await t.test("it publishes only additively, so it cannot delete an edition", () => {
    // `keep_files: true` makes peaceiris clone gh-pages and SKIP its `git rm`
    // before copying the top-level entries of publish_dir over the clone. The
    // job's tree now also carries `v1/` and `integrity.html`, which are files
    // and a directory the clone does not have — additions, never deletions.
    // Verified against the action source (src/git-utils.ts `setRepo`) and
    // reproduced locally: an edition directory present only on gh-pages
    // survives a pages-only publish.
    const publish = stepSource(job, "Publish reading pages and tape");
    assert.match(publish, /keep_files: true/);
    assert.match(publish, /publish_dir: \.\/daily_reports/);
    assert.equal(
      /keep_files: false/.test(publish),
      false,
      "keep_files: false here would wipe every edition on gh-pages",
    );
    // No destination_dir: the whole tree merges at the branch root, so `v1/`
    // and `integrity.html` land where the URLs expect them.
    assert.equal(/destination_dir:/.test(publish), false);
    assert.equal(/exclude_assets:/.test(publish), false);
  });

  await t.test("the reaction bake lives in this job, after the restore and before publish", () => {
    // Same defect class as `/v1` and `/integrity.html` above: `/reactions.json`
    // was baked only inside `build`, so a run with the gate answering
    // `all-published` simply never published the file.
    const names = stepNames(job);
    assert.ok(names.includes("Bake reaction windows"), "missing reaction bake in the pages job");
    assert.match(
      stepSource(job, "Bake reaction windows"),
      /npm run reactions:bake/,
      "the pages job must run the real bake, not a copy of it",
    );

    const restoreAt = names.indexOf("Restore tape, ledger and editions from gh-pages");
    const bakeAt = names.indexOf("Bake reaction windows");
    const assertAt = names.indexOf("Assert reaction windows are honest");
    const v1At = names.indexOf("Bake v1 namespace and integrity page");
    const publishAt = names.indexOf("Publish reading pages and tape");
    assert.ok(restoreAt >= 0 && publishAt >= 0 && v1At >= 0);
    assert.ok(
      restoreAt < bakeAt,
      "the bake reads tape/ and stories.json, which the restore supplies",
    );
    assert.ok(assertAt > bakeAt, "the honesty assert must check what the bake wrote");
    assert.ok(assertAt < publishAt, "an unmeasurable mean must not reach gh-pages");
    assert.ok(
      bakeAt < v1At,
      "the v1 manifest re-exports reactions.json, so it must exist before the v1 bake runs",
    );
  });

  await t.test("the reaction bake gets the report timezone and no provider key", () => {
    const step = stepSource(job, "Bake reaction windows");
    assert.match(step, /REPORT_TZ:/, "reaction instants are compared against market clocks");
    assert.match(step, /vars\.REPORT_TZ \|\| 'Asia\/Shanghai'/);
    assert.equal(/API_KEY:\s*\$\{\{/.test(step), false, "the bake is arithmetic over local files");
    assert.equal(/LLM_MODE:\s*'auto'/.test(step), false);
  });

  await t.test("the honesty assert runs a real script before publishing", () => {
    const step = stepSource(job, "Assert reaction windows are honest");
    assert.match(step, /node scripts\/assert-reactions\.mjs/);
  });

  await t.test("it restores the tape and ledger it renders", () => {
    const step = stepSource(job, "Restore tape, ledger and editions from gh-pages");
    assert.match(step, /checkout origin\/gh-pages -- tape/);
    assert.match(step, /checkout origin\/gh-pages -- stories\.json/);
  });

  await t.test("it is zero-token and scoped like the other jobs", () => {
    const jobEnv = job.slice(0, job.indexOf("    steps:"));
    assert.match(jobEnv, /^ {6}LLM_MODE: 'off'$/m);
    const names = stepNames(job);
    assert.ok(names.includes("Assert zero LLM calls"));
    assert.match(stepSource(job, "Assert zero LLM calls"), /--since/);
    assert.ok(
      names.indexOf("Assert zero LLM calls") < names.indexOf("Publish reading pages and tape"),
    );
  });

  await t.test("no inline multi-line node body was introduced", () => {
    assert.deepEqual([...job.matchAll(/run:\s*node\s+-e\s/g)].map((m) => m[0]), []);
  });
});

test("golden: the assert script rejects an absent or empty page", async () => {
  const { checkPage } = (await import("../../scripts/assert-reading-pages.mjs")) as {
    checkPage: (dir: string, spec: { file: string; markers: string[]; minBytes: number }) => string[];
  };
  const fsMod = await import("node:fs");
  const os = await import("node:os");
  const pathMod = await import("node:path");
  const dir = fsMod.mkdtempSync(pathMod.join(os.tmpdir(), "assert-pages-"));

  // Absent.
  assert.ok(checkPage(dir, { file: "hour.html", markers: ["盘中逐时报"], minBytes: 100 }).length);

  // Present but empty.
  fsMod.writeFileSync(pathMod.join(dir, "hour.html"), "<!doctype html><html></html>", "utf8");
  assert.ok(checkPage(dir, { file: "hour.html", markers: ["盘中逐时报"], minBytes: 100 }).length);

  // A leaked placeholder is a failure even when long enough.
  const big = `<!doctype html><html><body>盘中逐时报 ${"x".repeat(200)} 来源 {sourceName}</body></html>`;
  fsMod.writeFileSync(pathMod.join(dir, "hour.html"), big, "utf8");
  const problems = checkPage(dir, { file: "hour.html", markers: ["盘中逐时报"], minBytes: 100 });
  assert.ok(problems.some((p: string) => p.includes("placeholder")));

  fsMod.rmSync(dir, { recursive: true, force: true });
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
 * the pipeline, so they are asserted against the file: a future edit that drops
 * the pin, forwards a key, or reshapes the edition publish fails here.
 */
test("golden: tape job is zero-token and cannot disturb the edition path", async (t) => {
  const src = readWorkflow(RUNNER);
  const job = jobSource(src, "tape");

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
    const gate = gateSource();
    for (const out of ["tape-should-run", "tape-date", "tape-slot", "tape-reason"]) {
      assert.match(gate, new RegExp(`^ {6}${out}: \\$\\{\\{ steps\\.tape\\.outputs\\.${out} \\}\\}$`, "m"));
    }
    const step = stepSource(gate, "Check tape schedule");
    assert.match(step, /node scripts\/gate\.mjs --mode=tape/);
  });

  await t.test("the gate job stays cheap: no npm ci, no setup-node", () => {
    const gate = gateSource();
    assert.equal(
      /uses: actions\/setup-node/.test(gate),
      false,
      "the gate must not set up Node",
    );
    assert.equal(/run: npm ci/.test(gate), false, "the gate must not install dependencies");
    // …and the tape decision reuses the single sparse checkout of gate.mjs
    // instead of adding a second checkout.
    assert.equal(
      (readWorkflow(RUNNER).match(/sparse-checkout: \|/g) ?? []).length,
      1,
      "the tape decision must reuse the gate's one sparse checkout, not add another",
    );
  });

  await t.test("a tape tick does not cancel an in-flight capture", () => {
    assert.match(job, /cancel-in-progress: false/);
  });

  await t.test("the intraday page is rebuilt from the capture before publish", () => {
    // Without this the page the tape job publishes would describe the previous
    // capture, and the newest slot would be missing from /hour.html until the
    // next edition build hours later.
    const names = stepNames(job);
    assert.ok(names.includes("Rebuild intraday page"), "missing intraday page rebuild");
    const step = stepSource(job, "Rebuild intraday page");
    assert.match(step, /npm run reading:pages/);
    assert.match(step, /--only=hour/, "must not rebuild stories.html from a partial tree");
    assert.ok(
      names.indexOf("Capture snapshot") < names.indexOf("Rebuild intraday page"),
      "the page must be rebuilt after the capture it describes",
    );
    assert.ok(
      names.indexOf("Rebuild intraday page") < names.indexOf("Publish tape to gh-pages"),
      "the page must exist before the publish step runs",
    );
  });

  await t.test("the intraday rebuild is still covered by the zero-token assert", () => {
    // The assert is scoped `--since` this run and must run after the last
    // generating step; a new step added below it would be unguarded.
    const names = stepNames(job);
    assert.ok(
      names.indexOf("Rebuild intraday page") < names.indexOf("Assert zero LLM calls"),
      "a generating step must precede the zero-token assert",
    );
  });

  await t.test("the tape job restores the ledger the intraday page reads", () => {
    // The hour page embeds stories that entered the ledger in the slot window;
    // without the restore that column renders as a gap on every intraday
    // refresh.
    assert.match(
      stepSource(job, "Restore existing tape from gh-pages"),
      /stories\.json/,
      "the ledger must be restored alongside tape/",
    );
  });
});

/**
 * The two reading pages are products over point-in-time artifacts. If a build
 * step stops running they still render — as an empty state — which is exactly
 * the kind of failure that stays green while the site loses a page. These
 * assertions pin the wiring, and pin the page names the publish tree needs.
 */
test("golden: the reading pages are wired into the edition build", async (t) => {
  const job = buildJobSource();
  const names = stepNames(job);

  await t.test("the page build step exists and runs the npm script", () => {
    assert.ok(names.includes("Build reading pages (hour + stories)"), "missing reading-page build step");
    assert.match(stepSource(job, "Build reading pages (hour + stories)"), /npm run reading:pages/);
  });

  await t.test("it runs before build-site, which rewrites the nav for the homepage", () => {
    assert.ok(
      names.indexOf("Build reading pages (hour + stories)") <
        names.indexOf("Build static site (index + archive)"),
      "build-site rewrites ./hour.html links for the root, so the pages must exist first",
    );
  });

  await t.test("it runs after the ledger bake it reads", () => {
    assert.ok(
      names.indexOf("Bake story ledger") < names.indexOf("Build reading pages (hour + stories)"),
      "stories.html must be built from the current ledger",
    );
  });

  await t.test("the pages ship before the zero-token assert and the publish", () => {
    const at = names.indexOf("Build reading pages (hour + stories)");
    assert.ok(at < names.indexOf("Assert zero LLM calls"));
    assert.ok(at < names.indexOf("Publish to gh-pages"));
  });

  await t.test("it receives the report timezone and locale", () => {
    const step = stepSource(job, "Build reading pages (hour + stories)");
    assert.match(step, /REPORT_TZ:/);
    assert.match(step, /REPORT_LOCALE:/);
  });

  await t.test("no inline multi-line node body was added for the pages", () => {
    const src = readWorkflow(RUNNER);
    assert.deepEqual([...src.matchAll(/run:\s*node\s+-e\s/g)].map((m) => m[0]), []);
  });
});

/**
 * The `/v1` namespace and `/integrity.html` are the surfaces a consumer pins, so
 * two properties of the build job are load-bearing and asserted here:
 *
 *   - the bake runs INSIDE the build job, before the publish step (a v1 file
 *     written after `peaceiris` pushes the tree simply never ships);
 *   - an assertion runs before the publish, because a manifest that advertises
 *     an endpoint with no file behind it is the exact broken promise the
 *     namespace exists to prevent.
 *
 * Also re-asserted: the v1 bake is zero-token. It reads local files and does
 * arithmetic; if it ever grows an LLM call the existing post-run assert would
 * catch it, but pinning it here makes the intent explicit.
 */
test("golden: the v1 namespace bake is wired before publish and guarded", async (t) => {
  const job = buildJobSource();
  const names = stepNames(job);

  await t.test("the bake step exists and runs the npm script", () => {
    assert.ok(names.includes("Bake v1 namespace and integrity page"), "missing v1 bake step");
    assert.match(stepSource(job, "Bake v1 namespace and integrity page"), /npm run v1:bake/);
  });

  await t.test("it runs before the static site build, so nav links can be emitted", () => {
    const bakeAt = names.indexOf("Bake v1 namespace and integrity page");
    const siteAt = names.indexOf("Build static site (index + archive)");
    assert.ok(bakeAt >= 0 && siteAt >= 0);
    assert.ok(bakeAt < siteAt, "build-site links integrity.html only when it exists");
  });

  await t.test("it runs before the publish step", () => {
    const bakeAt = names.indexOf("Bake v1 namespace and integrity page");
    const publishAt = names.indexOf("Publish to gh-pages");
    assert.ok(bakeAt >= 0 && publishAt >= 0);
    assert.ok(bakeAt < publishAt, "a v1 file written after the push never ships");
  });

  await t.test("the contract assert runs a real script, before publish", () => {
    assert.ok(names.includes("Assert v1 contract"), "missing v1 contract assert");
    const step = stepSource(job, "Assert v1 contract");
    assert.match(step, /npm run assert:v1/);
    const assertAt = names.indexOf("Assert v1 contract");
    const publishAt = names.indexOf("Publish to gh-pages");
    assert.ok(assertAt < publishAt, "a broken v1 file must not reach gh-pages");
  });

  await t.test("it runs after the story ledger and theme bakes, so their inputs exist", () => {
    const storiesAt = names.indexOf("Bake story ledger");
    const themesAt = names.indexOf("Bake theme heat");
    const bakeAt = names.indexOf("Bake v1 namespace and integrity page");
    assert.ok(storiesAt >= 0 && themesAt >= 0 && bakeAt >= 0);
    assert.ok(storiesAt < bakeAt, "v1 re-exports the ledger");
    assert.ok(themesAt < bakeAt, "v1 re-exports the theme board");
  });

  await t.test("the bake step is zero-token by construction", () => {
    const step = stepSource(job, "Bake v1 namespace and integrity page");
    assert.equal(
      /API_KEY:\s*\$\{\{/.test(step),
      false,
      "the v1 bake reads local files; it must not receive a provider key",
    );
    // Job-level LLM_MODE=off already covers it, and the post-run assert counts
    // any call, but the step must not re-enable a backend.
    assert.equal(/LLM_MODE:\s*'auto'/.test(step), false);
  });

  await t.test("the v1 bake receives REPORT_TZ so its clocks carry the market offset", () => {
    const step = stepSource(job, "Bake v1 namespace and integrity page");
    assert.match(step, /REPORT_TZ:/);
    assert.match(step, /vars\.REPORT_TZ \|\| 'Asia\/Shanghai'/);
  });
});

/**
 * The watchdog exists because GitHub's cron drops 92% of this repo's scheduled
 * triggers. Its alert is the accountability surface: whenever the watchdog HAD
 * to act (its gate found a due slot missing/premature — daily.yml's schedule
 * should have covered it) or a pipeline job failed, ONE pinned issue labelled
 * `edition-watch` is opened or updated. These assertions pin that contract.
 */
test("golden: watchdog files exactly one tracking issue when it had to act", async (t) => {
  const watchdog = readWorkflow(WATCHDOG);

  await t.test("the alert job runs after the pipeline, whatever its result", () => {
    const job = jobSource(watchdog, "alert");
    assert.match(job, /^ {4}needs: pipeline$/m);
    assert.match(job, /if: always\(\) &&/);
  });

  await t.test("it fires when the watchdog covered a slot OR a job failed/cancelled", () => {
    const job = jobSource(watchdog, "alert");
    assert.match(job, /needs\.pipeline\.outputs\.should-run == 'true'/);
    assert.match(job, /needs\.pipeline\.result == 'failure'/);
    assert.match(job, /needs\.pipeline\.result == 'cancelled'/);
  });

  await t.test("it runs the issue-filer script, never an inline body", () => {
    const job = jobSource(watchdog, "alert");
    assert.match(job, /node scripts\/watchdog-issue\.mjs/);
    assert.doesNotMatch(job, /run:\s*node\s+-e\s/);
  });

  await t.test("it passes the gate outputs and the pipeline result to the script", () => {
    const job = jobSource(watchdog, "alert");
    for (const name of [
      "WATCHDOG_SHOULD_RUN",
      "WATCHDOG_REASON",
      "WATCHDOG_EDITION_DATE",
      "WATCHDOG_EDITION_HOUR",
      "WATCHDOG_RESULT",
    ]) {
      assert.match(job, new RegExp(`${name}:`), `env ${name} must be wired`);
    }
  });

  await t.test("the issue filer is watchdog-only", () => {
    assert.doesNotMatch(readWorkflow(DAILY), /watchdog-issue/);
    assert.doesNotMatch(readWorkflow(RUNNER), /watchdog-issue/);
  });

  await t.test("the script maintains one issue, deduplicated, not one issue per event", () => {
    const scriptSrc = fs.readFileSync(path.join(REPO_ROOT, "scripts", "watchdog-issue.mjs"), "utf8");
    assert.match(scriptSrc, /edition-watch/, "the tracking label is edition-watch");
    assert.match(scriptSrc, /state=open/, "it must search for the existing open issue first");
    assert.match(scriptSrc, /watchdog-event:/, "comments carry a dedupe marker");
    // and it must no-op on a healthy tick (nothing to report), so the issue
    // only ever carries real events.
    assert.match(scriptSrc, /nothing to report/);
  });
});

/**
 * The build job restores gh-pages with `|| true` and publishes with
 * `keep_files: false`: a partial restore would silently DELETE every unrestored
 * old edition on the next publish, and the run would stay green (forensics:
 * missing-19s-forensics). The archive-survival steps bracket the publish so a
 * wipe is impossible to miss: capture the fetched tree's sidecars before the
 * push, assert every one survived right after it.
 */
test("golden: the build publish cannot silently wipe the archive", async (t) => {
  const job = buildJobSource();
  const names = stepNames(job);

  await t.test("the publish is bracketed by a capture and a survival assert", () => {
    const captureAt = names.indexOf("Capture the published archive snapshot");
    const publishAt = names.indexOf("Publish to gh-pages");
    const assertAt = names.indexOf("Assert archive survived publish");
    assert.ok(captureAt >= 0 && publishAt >= 0 && assertAt >= 0);
    assert.ok(captureAt < publishAt, "the snapshot must be taken BEFORE the keep_files:false publish");
    assert.equal(assertAt, publishAt + 1, "the survival assert is the first thing after the publish");
  });

  await t.test("both steps run the real script with their phase flag", () => {
    assert.match(
      stepSource(job, "Capture the published archive snapshot"),
      /node scripts\/assert-archive-survival\.mjs --capture/,
    );
    assert.match(
      stepSource(job, "Assert archive survived publish"),
      /node scripts\/assert-archive-survival\.mjs --assert/,
    );
  });

  await t.test("the script exists and reads the FETCHED tree, not the possibly-partial checkout", () => {
    const scriptSrc = fs.readFileSync(
      path.join(REPO_ROOT, "scripts", "assert-archive-survival.mjs"),
      "utf8",
    );
    assert.match(scriptSrc, /git ls-tree -r --name-only origin\/gh-pages/);
    assert.match(scriptSrc, /RUNNER_TEMP/, "the capture list must live outside the publish dir");
  });

  const { checkSurvival, filterSidecarPaths } = (await import("../../scripts/assert-archive-survival.mjs")) as {
    checkSurvival: (opts: { listFile: string; publishDir?: string }) => Promise<{
      listed: number;
      missing: string[];
    }>;
    filterSidecarPaths: (paths: string[]) => string[];
  };
  const os = await import("node:os");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "assert-archive-"));
  const publishDir = path.join(dir, "daily_reports");
  const sidecars = ["2026-11-13/06.json", "2026-11-13/19.json", "2026-11-14/06.json"];
  for (const rel of sidecars) {
    fs.mkdirSync(path.join(publishDir, path.dirname(rel)), { recursive: true });
    fs.writeFileSync(path.join(publishDir, rel), "{}");
  }
  const listFile = path.join(dir, "gh-pages-sidecars.txt");
  fs.writeFileSync(listFile, sidecars.join("\n") + "\n");

  await t.test("the filter keeps only date/slot sidecars", () => {
    assert.deepEqual(
      filterSidecarPaths([
        "2026-11-13/06.json",
        "2026-11-13/06.html",
        "tape/2026-11-13/0935.json",
        "stories.json",
        "2026-11-13/19.json",
        "index.html",
      ]),
      ["2026-11-13/06.json", "2026-11-13/19.json"],
    );
  });

  await t.test("mutation: all-present passes", async () => {
    const r = await checkSurvival({ listFile, publishDir });
    assert.equal(r.listed, sidecars.length);
    assert.deepEqual(r.missing, []);
  });

  await t.test("mutation: a present-file-missing fails the assert", async () => {
    // The partial-restore mutation: one restored sidecar disappears from the
    // publish tree. The assert must name exactly that file.
    fs.rmSync(path.join(publishDir, "2026-11-13", "19.json"));
    const r = await checkSurvival({ listFile, publishDir });
    assert.deepEqual(r.missing, ["2026-11-13/19.json"]);
  });

  await t.test("a missing capture list throws, never passes", async () => {
    await assert.rejects(() =>
      checkSurvival({ listFile: path.join(dir, "absent.txt"), publishDir }),
    );
  });

  fs.rmSync(dir, { recursive: true, force: true });
});

/**
 * A reusable workflow's job graph is NOT addressable from the caller: callers
 * see only the calling job's `outputs` and `result`. Conversely a job inside the
 * runner must not key on outputs that belong to a different workflow. This
 * sweep enforces both directions: every `needs.<id>.` reference must name a job
 * declared in the SAME file — which is exactly the "no workflow accidentally
 * keys on another job's should-run" rule for the two-caller shape.
 */
test("golden: no workflow keys on a job it does not own", async (t) => {
  for (const [name, file] of ALL_WORKFLOWS) {
    await t.test(`${name}: every needs.<id> names a job in the same file`, () => {
      const src = readWorkflow(file);
      const jobsAt = src.indexOf("\njobs:");
      assert.ok(jobsAt >= 0, `${name} must declare jobs`);
      const jobIds = [...src.slice(jobsAt).matchAll(/^ {2}([\w-]+):$/gm)].map((m) => m[1]);
      assert.ok(jobIds.length > 0);
      for (const ref of src.matchAll(/needs\.([\w-]+)\./g)) {
        assert.ok(
          jobIds.includes(ref[1]),
          `${name} references needs.${ref[1]}.* — a job may only key on its own workflow's jobs`,
        );
      }
    });
  }
});
