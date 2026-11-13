/**
 * The zero-token guarantee, pinned two ways.
 *
 * 1. `LLM_MODE=off` makes the dispatcher unreachable: `runLlm()` throws
 *    `LlmDisabledError` before touching any backend, so a call site that
 *    forgets its `isLlmOff()` branch fails loudly instead of spending tokens
 *    (the CI build job runs with the mode pinned off).
 * 2. `scripts/assert-zero-llm.mjs` is the post-run machine check the workflow
 *    runs: no `logs/llm-calls.jsonl` entry for the run means zero calls, and a
 *    missing file is the expected pass case.
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { LlmDisabledError, runLlm } from "../../lib/ai/llm";
import { isLlmOff } from "../../lib/ai/llm-mode";
import { assertZeroLlm, findLlmCalls } from "../../scripts/assert-zero-llm.mjs";

/** Run a body with LLM_MODE / LLM_BACKEND set, restoring them afterwards. */
async function withLlmMode<T>(
  mode: string,
  backend: string | undefined,
  body: () => Promise<T> | T,
): Promise<T> {
  const prevMode = process.env.LLM_MODE;
  const prevBackend = process.env.LLM_BACKEND;
  process.env.LLM_MODE = mode;
  if (backend === undefined) delete process.env.LLM_BACKEND;
  else process.env.LLM_BACKEND = backend;
  try {
    return await body();
  } finally {
    if (prevMode === undefined) delete process.env.LLM_MODE;
    else process.env.LLM_MODE = prevMode;
    if (prevBackend === undefined) delete process.env.LLM_BACKEND;
    else process.env.LLM_BACKEND = prevBackend;
  }
}

const PROMPT = { systemPrompt: "sys", userPrompt: "usr" };

test("zero-llm: LLM_MODE=off makes every backend unreachable", async (t) => {
  await t.test("isLlmOff() reports the disabled mode", async () => {
    await withLlmMode("off", "zhipu", () => {
      assert.equal(isLlmOff(), true);
    });
  });

  await t.test("runLlm() throws before any backend call, for every backend", async () => {
    for (const backend of [
      "claude-cli",
      "anthropic",
      "openai",
      "deepseek",
      "minimax",
      "zhipu",
    ]) {
      await withLlmMode("off", backend, async () => {
        await assert.rejects(
          () => runLlm(PROMPT),
          (err: unknown) => {
            assert.ok(err instanceof LlmDisabledError, `${backend}: wrong error ${String(err)}`);
            assert.match(String((err as Error).message), /LLM_MODE=off/);
            return true;
          },
          `${backend} must be unreachable in off mode`,
        );
      });
    }
  });

  await t.test("off mode wins over a provider key being present", async () => {
    // The workflow no longer relies on the secret being absent: an explicit
    // off must beat a configured key.
    const prevKey = process.env.ZHIPU_API_KEY;
    process.env.ZHIPU_API_KEY = "test-key-present";
    try {
      await withLlmMode("off", "zhipu", async () => {
        await assert.rejects(() => runLlm(PROMPT), LlmDisabledError);
      });
    } finally {
      if (prevKey === undefined) delete process.env.ZHIPU_API_KEY;
      else process.env.ZHIPU_API_KEY = prevKey;
    }
  });

  await t.test("a disabled run writes no llm-calls.jsonl entry", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "zero-llm-"));
    const cwd = process.cwd();
    // logLlmCall() writes relative to cwd: isolate it so the assertion below
    // cannot see a developer's own log.
    process.chdir(dir);
    try {
      await withLlmMode("off", "zhipu", async () => {
        await assert.rejects(() => runLlm(PROMPT), LlmDisabledError);
      });
      assert.deepEqual(findLlmCalls({ logPath: path.join(dir, "logs", "llm-calls.jsonl") }), {
        records: [],
        raw: [],
        missing: true,
      });
      assert.equal(assertZeroLlm({ logPath: path.join(dir, "logs", "llm-calls.jsonl") }).ok, true);
    } finally {
      process.chdir(cwd);
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

test("zero-llm assert: missing log is the expected pass case", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "zero-llm-assert-"));
  const cleanLog = path.join(dir, "llm-calls.jsonl");

  try {
    await t.test("absent file passes", () => {
      const r = assertZeroLlm({ logPath: cleanLog });
      assert.equal(r.ok, true);
      assert.equal(r.missing, true);
      assert.equal(r.count, 0);
    });

    await t.test("empty file passes", () => {
      fs.writeFileSync(cleanLog, "", "utf8");
      assert.equal(assertZeroLlm({ logPath: cleanLog }).ok, true);
    });

    await t.test("blank lines only passes", () => {
      fs.writeFileSync(cleanLog, "\n\n  \n", "utf8");
      assert.equal(assertZeroLlm({ logPath: cleanLog }).ok, true);
    });

    await t.test("a single recorded call fails", () => {
      fs.writeFileSync(
        cleanLog,
        JSON.stringify({
          ts: "2026-11-13T06:05:00.000Z",
          backend: "zhipu",
          model: "glm-4-flash",
          durationMs: 900,
          success: true,
          inputChars: 10,
          outputChars: 10,
          errorCategory: null,
          errorSnippet: null,
        }) + "\n",
        "utf8",
      );
      const r = assertZeroLlm({ logPath: cleanLog });
      assert.equal(r.ok, false);
      assert.equal(r.count, 1);
      assert.equal(r.records[0].backend, "zhipu");
    });

    await t.test("an unparseable append still counts as a call", () => {
      fs.writeFileSync(cleanLog, "{\"ts\":\"2026-11-13T06:05:00Z\"\nnot-json\n", "utf8");
      const r = assertZeroLlm({ logPath: cleanLog });
      assert.equal(r.ok, false);
      assert.equal(r.count, 2);
    });

    await t.test("--since excludes earlier runs but keeps this one", () => {
      fs.writeFileSync(
        cleanLog,
        [
          JSON.stringify({ ts: "2026-11-13T01:00:00.000Z", backend: "zhipu" }),
          JSON.stringify({ ts: "2026-11-13T06:05:00.000Z", backend: "zhipu" }),
        ].join("\n") + "\n",
        "utf8",
      );
      assert.equal(assertZeroLlm({ logPath: cleanLog, since: "2026-11-13T06:00:00Z" }).count, 1);
      assert.equal(assertZeroLlm({ logPath: cleanLog, since: "2026-11-13T07:00:00Z" }).count, 0);
    });

    await t.test("an entry without a timestamp is never excluded by --since", () => {
      fs.writeFileSync(cleanLog, JSON.stringify({ backend: "zhipu" }) + "\n", "utf8");
      assert.equal(assertZeroLlm({ logPath: cleanLog, since: "2030-01-01T00:00:00Z" }).count, 1);
    });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
