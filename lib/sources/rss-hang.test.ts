/**
 * Regression guard for the post-completion hang (survey defect #1).
 *
 * `rss-parser` rejects on timeout but never destroys the request it opened,
 * leaving a referenced socket behind. The pipeline then stays alive after
 * "[daily] done." — measured at ~6m15s per run, which burned roughly 45% of
 * the 25-minute CI job budget and got one finished edition (13:00 on
 * 2026-11-13) cancelled after its files were already written.
 *
 * The assertion is a socket count rather than "wait for exit" on purpose: a
 * leaked handle would keep the test file itself alive, turning a red test
 * into a stuck CI job. Counting handles fails immediately instead.
 */
import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";

import { parseUrlWithCleanup } from "./rss";

/** Sockets currently keeping the event loop referenced. */
function refdSockets(): number {
  return process
    .getActiveResourcesInfo()
    .filter((r) => r === "TCPSocketWrap").length;
}

const settle = () => new Promise((r) => setTimeout(r, 200));

/**
 * If the fix regresses, the leaked socket would also keep *this* test file
 * alive after the assertion fails — a red test must not become a stuck CI
 * job. `unref` every open socket once the file is done so a failure still
 * exits promptly; the assertion has already recorded the verdict by then.
 */
test.after(() => {
  const handles = (
    process as unknown as { _getActiveHandles(): Array<{ unref?: () => void }> }
  )._getActiveHandles();
  for (const h of handles) h?.unref?.();
});

test("parseUrlWithCleanup releases the socket when a feed times out", async () => {
  // Accepts the connection and never answers, so the client can only escape
  // through the parser timeout — the exact production failure shape.
  const silent = http.createServer(() => {});
  await new Promise<void>((r) => silent.listen(0, "127.0.0.1", r));
  const { port } = silent.address() as AddressInfo;

  await settle();
  const before = refdSockets();

  try {
    await assert.rejects(
      parseUrlWithCleanup(`http://127.0.0.1:${port}/feed`, 150),
      /timed out/i,
    );
  } finally {
    silent.close();
  }

  await settle();
  assert.ok(
    refdSockets() <= before,
    `timed-out feed parse left ${refdSockets() - before} referenced socket(s) — ` +
      `the pipeline will hang after "[daily] done."`,
  );
});

test("parseUrlWithCleanup releases the agent on a connection error", async () => {
  await settle();
  const before = refdSockets();

  await assert.rejects(parseUrlWithCleanup("http://127.0.0.1:1/feed", 200));

  await settle();
  assert.ok(
    refdSockets() <= before,
    "failed feed parse left a referenced socket behind",
  );
});
