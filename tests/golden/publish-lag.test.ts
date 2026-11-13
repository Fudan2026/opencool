/**
 * Publish-lag assertion: the machine check that replaces watching the clock.
 *
 * The gate fires every 15 minutes; this test pins what "on time" means, that
 * a backfilled (补发) edition reports its lag without failing, that on-demand
 * publishes are not breaches, and that the workflow's single log line carries
 * date / slot / publish time / lag / verdict.
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  DEFAULT_LAG_LIMIT_MIN,
  evaluatePublishLag,
  formatInTz,
  formatLagLine,
  isBackfilledSidecar,
  minutesBetween,
  readSidecarGeneratedAt,
  resolvePublishedAt,
  zonedWallToInstant,
} from "../../scripts/assert-publish-lag.mjs";
import { judgeSidecarFreshness, PREMATURE_TOLERANCE_MIN } from "../../scripts/gate.mjs";

const SH = "Asia/Shanghai";

/** Slot 2026-11-13 06:00 Asia/Shanghai == 2026-11-12T22:00:00Z. */
const SLOT_06 = new Date("2026-11-12T22:00:00Z");

test("publish-lag: slot time resolves in Asia/Shanghai", async (t) => {
  await t.test("06:00 SH is 22:00Z the previous day", () => {
    assert.equal(zonedWallToInstant("2026-11-13", 6, SH).toISOString(), SLOT_06.toISOString());
  });

  await t.test("19:00 SH is 11:00Z the same day", () => {
    assert.equal(
      zonedWallToInstant("2026-11-13", 19, SH).toISOString(),
      "2026-11-13T11:00:00.000Z",
    );
  });

  await t.test("wall clock renders back in SH", () => {
    assert.equal(formatInTz(SLOT_06, SH), "2026-11-13 06:00");
  });

  await t.test("rejects a malformed slot date", () => {
    assert.throws(() => zonedWallToInstant("13-11-2026", 6, SH), /YYYY-MM-DD/);
  });

  await t.test("minutesBetween is signed", () => {
    assert.equal(minutesBetween(SLOT_06, new Date(SLOT_06.getTime() + 12 * 60_000)), 12);
    assert.equal(minutesBetween(SLOT_06, new Date(SLOT_06.getTime() - 5 * 60_000)), -5);
  });
});

test("publish-lag: verdicts", async (t) => {
  const base = { date: "2026-11-13", hour: "06", tz: SH };

  await t.test("publishes at the slot — ON TIME", () => {
    const r = evaluatePublishLag({ ...base, publishedAt: SLOT_06 });
    assert.equal(r.ok, true);
    assert.equal(r.lagMinutes, 0);
    assert.match(r.verdict, /ON TIME/);
  });

  await t.test("within the limit — ON TIME", () => {
    const r = evaluatePublishLag({
      ...base,
      publishedAt: new Date(SLOT_06.getTime() + 19 * 60_000),
    });
    assert.equal(r.lagMinutes, 19);
    assert.equal(r.ok, true);
  });

  await t.test("exactly the limit is still on time (strictly greater fails)", () => {
    const r = evaluatePublishLag({
      ...base,
      publishedAt: new Date(SLOT_06.getTime() + DEFAULT_LAG_LIMIT_MIN * 60_000),
    });
    assert.equal(r.lagMinutes, 20);
    assert.equal(r.ok, true);
  });

  await t.test("beyond the limit — LATE BREACH", () => {
    const r = evaluatePublishLag({
      ...base,
      publishedAt: new Date(SLOT_06.getTime() + 21 * 60_000),
    });
    assert.equal(r.lagMinutes, 21);
    assert.equal(r.ok, false);
    assert.match(r.verdict, /LATE BREACH/);
  });

  await t.test("hours late is reported with the real number", () => {
    const r = evaluatePublishLag({
      ...base,
      publishedAt: new Date(SLOT_06.getTime() + 305 * 60_000),
    });
    assert.equal(r.lagMinutes, 305);
    assert.equal(r.ok, false);
  });

  await t.test("backfilled (补发) reports lag but never fails", () => {
    const r = evaluatePublishLag({
      ...base,
      publishedAt: new Date(SLOT_06.getTime() + 600 * 60_000),
      backfilled: true,
    });
    assert.equal(r.lagMinutes, 600);
    assert.equal(r.ok, true);
    assert.match(r.verdict, /BACKFILL/);
  });

  await t.test("already-published republish is not a breach", () => {
    const r = evaluatePublishLag({
      ...base,
      publishedAt: new Date(SLOT_06.getTime() + 120 * 60_000),
      alreadyPublished: true,
    });
    assert.equal(r.ok, true);
    assert.match(r.verdict, /REPUBLISH/);
  });

  await t.test("push / manual publishing an already-live slot never breaches", () => {
    for (const trigger of ["push", "manual"]) {
      const r = evaluatePublishLag({
        ...base,
        publishedAt: new Date(SLOT_06.getTime() + 300 * 60_000),
        trigger,
        alreadyPublished: true,
      });
      assert.equal(r.ok, true, `${trigger} must not fail`);
      assert.match(r.verdict, /REPUBLISH/);
    }
  });

  await t.test("a push that is the FIRST publish of a late slot still breaches", () => {
    const r = evaluatePublishLag({
      ...base,
      publishedAt: new Date(SLOT_06.getTime() + 300 * 60_000),
      trigger: "push",
    });
    assert.equal(r.ok, false);
    assert.match(r.verdict, /LATE BREACH/);
  });

  await t.test("a push inside the limit is ON TIME", () => {
    const r = evaluatePublishLag({
      ...base,
      publishedAt: new Date(SLOT_06.getTime() + 3 * 60_000),
      trigger: "push",
    });
    assert.equal(r.ok, true);
    assert.match(r.verdict, /ON TIME/);
    assert.match(r.verdict, /push/);
  });

  await t.test("scheduled triggers keep the breach semantics", () => {
    for (const trigger of ["exact", "catchup", "backfill"]) {
      const r = evaluatePublishLag({
        ...base,
        publishedAt: new Date(SLOT_06.getTime() + 300 * 60_000),
        trigger,
      });
      assert.equal(r.ok, false, `${trigger} must still breach`);
    }
  });

  await t.test("custom limit is honoured", () => {
    const r = evaluatePublishLag({
      ...base,
      publishedAt: new Date(SLOT_06.getTime() + 31 * 60_000),
      limitMin: 45,
    });
    assert.equal(r.ok, true);
  });
});

/**
 * PREMATURE — the mirror of LATE, and the reason this suite grew a case.
 *
 * Run 43481490148 published `2026-11-14/06.json` at 02:26 SH, 3h34m before the
 * 06:00 slot, after `latestDueSlot()` fell back to `hours[0]` before any slot
 * was due. The lag assert printed `lag=-213m verdict=REPUBLISH` and stayed
 * green, so nothing anywhere reported it — and because the gate then probes
 * `06.json` and gets 200, the real 06:00 edition never runs.
 */
test("publish-lag: publishing EARLY is a breach, not a republish", async (t) => {
  // Replay of the real incident: slot 2026-11-14 06:00 SH, published 02:26 SH.
  // The slot instant is 22:00Z on 11-13, so the measured publish lands 3h34m
  // before it. The publish instant below is set to the incident's recorded lag
  // (-213m in the gate log) so the assertion pins the exact number.
  const incident = {
    date: "2026-11-14",
    hour: "06",
    tz: SH,
    publishedAt: new Date("2026-11-13T18:27:00Z"), // 02:27 SH on 11-14
  };

  await t.test("the measured -213m publish is a failing PREMATURE BREACH", () => {
    const r = evaluatePublishLag({ ...incident, trigger: "push" });
    assert.equal(r.lagMinutes, -213);
    assert.equal(r.ok, false);
    assert.equal(r.premature, true);
    assert.match(r.verdict, /PREMATURE BREACH/);
  });

  await t.test("the real 02:26:22 publish is a breach by more than the limit", () => {
    // Same incident at the exact sidecar instant — 213.6m early. Whichever
    // second it landed on, it is far beyond the 20m limit and must fail.
    const r = evaluatePublishLag({
      ...incident,
      publishedAt: new Date("2026-11-13T18:26:22Z"),
      trigger: "push",
    });
    assert.equal(r.ok, false);
    assert.equal(r.premature, true);
    assert.ok(Math.abs(r.lagMinutes) > DEFAULT_LAG_LIMIT_MIN);
  });

  await t.test("a premature file being 'already published' does not launder it", () => {
    // This is exactly the 43481490148 shape: the premature file exists, so the
    // next run sees ALREADY_PUBLISHED=true. That must not turn it green.
    for (const trigger of ["push", "manual", "exact", "catchup"]) {
      const r = evaluatePublishLag({
        ...incident,
        trigger,
        alreadyPublished: true,
      });
      assert.equal(r.ok, false, `${trigger} + alreadyPublished must still fail`);
      assert.equal(r.premature, true);
      assert.match(r.verdict, /PREMATURE BREACH/);
    }
  });

  await t.test("a backfilled early publish stays green (recovery, not a claim)", () => {
    const r = evaluatePublishLag({ ...incident, backfilled: true });
    assert.equal(r.ok, true);
    assert.equal(r.premature, false);
    assert.match(r.verdict, /BACKFILL/);
  });

  await t.test("exactly the limit early is still within limits", () => {
    const r = evaluatePublishLag({
      date: "2026-11-14",
      hour: "06",
      tz: SH,
      publishedAt: new Date(SLOT_06.getTime() + 86_400_000 - DEFAULT_LAG_LIMIT_MIN * 60_000),
    });
    assert.equal(r.lagMinutes, -DEFAULT_LAG_LIMIT_MIN);
    assert.equal(r.ok, true, "only strictly beyond the limit is a breach");
    assert.equal(r.premature, false);
  });

  await t.test("one minute beyond the limit early is a breach", () => {
    const r = evaluatePublishLag({
      date: "2026-11-14",
      hour: "06",
      tz: SH,
      publishedAt: new Date(SLOT_06.getTime() + 86_400_000 - (DEFAULT_LAG_LIMIT_MIN + 1) * 60_000),
    });
    assert.equal(r.lagMinutes, -(DEFAULT_LAG_LIMIT_MIN + 1));
    assert.equal(r.ok, false);
    assert.equal(r.premature, true);
  });

  await t.test("a custom limit widens the early tolerance too", () => {
    const r = evaluatePublishLag({
      date: "2026-11-14",
      hour: "06",
      tz: SH,
      limitMin: 240,
      publishedAt: new Date("2026-11-13T18:27:00Z"),
    });
    assert.equal(r.ok, true, "-213m is inside a 240m tolerance");
  });

  await t.test("the existing late / on-time / republish verdicts are unchanged", () => {
    const base = { date: "2026-11-13", hour: "06", tz: SH };
    assert.equal(evaluatePublishLag({ ...base, publishedAt: SLOT_06 }).ok, true);
    assert.match(
      evaluatePublishLag({ ...base, publishedAt: new Date(SLOT_06.getTime() + 21 * 60_000) }).verdict,
      /LATE BREACH/,
    );
    // A republish a long way LATE is still green: the slot was met earlier.
    const republish = evaluatePublishLag({
      ...base,
      publishedAt: new Date(SLOT_06.getTime() + 120 * 60_000),
      alreadyPublished: true,
    });
    assert.equal(republish.ok, true);
    assert.match(republish.verdict, /REPUBLISH/);
  });

  await t.test("the log line reports the premature verdict with its sign", () => {
    const line = formatLagLine(evaluatePublishLag({ ...incident, trigger: "push" }));
    assert.match(line, /lag=-213m/);
    assert.match(line, /PREMATURE BREACH/);
  });
});

test("publish-lag: the gate and this assert agree on what PREMATURE means", async (t) => {
  /**
   * Two thresholds, one definition. The gate judges the FILE it finds (its own
   * `generated_at`, tolerance PREMATURE_TOLERANCE_MIN = 2m) because a stale file
   * silently blocks the real slot; this assert judges the PUBLISH instant
   * (limit 20m). They must never disagree in the harmful direction: publishing
   * always follows generating, so a publish-instant breach is always a gate
   * breach too.
   */
  const date = "2026-11-14";
  const hour = "06";

  await t.test("both use the gate's freshness verdict for generated_at", () => {
    const stale = evaluatePublishLag({
      date,
      hour,
      tz: SH,
      // Publish instant looks fine (06:01 SH) but the FILE is the 02:26 one.
      publishedAt: new Date("2026-11-13T22:01:00Z"),
      alreadyPublished: true,
      trigger: "push",
      generatedAt: "2026-11-13T18:26:22.326Z",
    });
    assert.equal(stale.freshness, "premature");
    assert.equal(stale.premature, true);
    assert.equal(stale.ok, false, "a stale file must breach even when the publish looked on time");
    assert.match(stale.verdict, /sidecar fetched 214m before its slot/);
  });

  await t.test("an honest file and an on-time publish are both green", () => {
    const r = evaluatePublishLag({
      date,
      hour,
      tz: SH,
      publishedAt: new Date("2026-11-13T22:04:00Z"),
      trigger: "exact",
      generatedAt: "2026-11-13T22:02:30Z",
    });
    assert.equal(r.freshness, "honest");
    assert.equal(r.ok, true);
  });

  await t.test("an absent/unreadable generated_at never breaches (frozen archive)", () => {
    for (const generatedAt of [null, undefined, "", "garbage"]) {
      const r = evaluatePublishLag({
        date,
        hour,
        tz: SH,
        publishedAt: new Date("2026-11-13T22:04:00Z"),
        trigger: "exact",
        generatedAt: generatedAt as string | null,
      });
      assert.equal(r.freshness, "unknown");
      assert.equal(r.ok, true);
      assert.equal(r.premature, false);
    }
  });

  await t.test("every publish-instant breach is ALSO a gate breach (dominance)", () => {
    // Publishing follows generating: generated_at <= publishedAt, so a publish
    // more than the assert's limit early is always a file the stricter gate
    // rejects. The converse does NOT hold by design — the gate flags 3m early,
    // the assert does not — which is the safe direction.
    const slot = Date.parse("2026-11-13T22:00:00Z"); // 2026-11-14 06:00 SH
    for (const earlyMin of [21, 25, 213, 600]) {
      const publishedAt = new Date(slot - earlyMin * 60_000);
      const lag = evaluatePublishLag({ date, hour, tz: SH, publishedAt, trigger: "push" });
      assert.equal(lag.premature, true, `${earlyMin}m early must breach here`);
      const gate = judgeSidecarFreshness({
        generatedAt: publishedAt.toISOString(),
        date,
        slot: hour,
      });
      assert.equal(gate.verdict, "premature", `${earlyMin}m early must breach at the gate`);
    }

    // The gate's extra strictness, shown explicitly: 3m early is a rebuild for
    // the gate and still an acceptable publish lag for the assert.
    const threeEarly = new Date(slot - 3 * 60_000);
    assert.equal(judgeSidecarFreshness({ generatedAt: threeEarly.toISOString(), date, slot: hour }).verdict, "premature");
    assert.equal(
      evaluatePublishLag({ date, hour, tz: SH, publishedAt: threeEarly, trigger: "push" }).premature,
      false,
    );
  });

  await t.test("the documented thresholds are 2m (gate) and 20m (assert)", () => {
    assert.equal(PREMATURE_TOLERANCE_MIN, 2);
    assert.equal(DEFAULT_LAG_LIMIT_MIN, 20);
    // The gate is the stricter one, on purpose: a stale file blocks a slot.
    assert.ok(PREMATURE_TOLERANCE_MIN < DEFAULT_LAG_LIMIT_MIN);
  });

  await t.test("a rebuild caused by a premature predecessor is judged as a first publish", () => {
    // The gate reason for this run is `premature`: the file it found was
    // premature, so the slot was NOT met earlier and this is its first honest
    // publish. It must not be laundered as "REPUBLISH — slot was met earlier",
    // and lateness must still count against it.
    const onTime = evaluatePublishLag({
      date,
      hour,
      tz: SH,
      publishedAt: new Date("2026-11-13T22:04:00Z"),
      alreadyPublished: true,
      trigger: "premature",
      generatedAt: "2026-11-13T22:02:30Z",
    });
    assert.equal(onTime.ok, true);
    assert.match(onTime.verdict, /slot was not met earlier/);
    assert.equal(onTime.verdict.includes("REPUBLISH"), false);

    const lateRebuild = evaluatePublishLag({
      date,
      hour,
      tz: SH,
      publishedAt: new Date("2026-11-13T22:40:00Z"), // 40m after the slot
      alreadyPublished: true,
      trigger: "premature",
      generatedAt: "2026-11-13T22:39:30Z",
    });
    assert.equal(lateRebuild.ok, false, "a late rebuild is still late");
    assert.match(lateRebuild.verdict, /never honestly met/);

    // An ordinary republish keeps the old wording.
    const ordinary = evaluatePublishLag({
      date,
      hour,
      tz: SH,
      publishedAt: new Date("2026-11-13T22:40:00Z"),
      alreadyPublished: true,
      trigger: "catchup",
      generatedAt: "2026-11-13T22:39:30Z",
    });
    assert.match(ordinary.verdict, /REPUBLISH/);
    assert.equal(ordinary.ok, true);
  });

  await t.test("a backfilled (补发) edition stays green in both readings", () => {
    const r = evaluatePublishLag({
      date,
      hour,
      tz: SH,
      publishedAt: new Date("2026-11-13T18:27:00Z"),
      backfilled: true,
      generatedAt: "2026-11-13T18:26:22.326Z",
    });
    assert.equal(r.ok, true);
    assert.equal(r.premature, false);
    assert.match(r.verdict, /BACKFILL/);
  });
});

test("publish-lag: the single log line carries every field", () => {
  const r = evaluatePublishLag({
    date: "2026-11-13",
    hour: "13",
    tz: SH,
    publishedAt: new Date("2026-11-13T05:07:00Z"),
  });
  const line = formatLagLine(r);
  assert.match(line, /date=2026-11-13/);
  assert.match(line, /slot=13:00 SH/);
  assert.match(line, /published=2026-11-13 13:07 SH/);
  assert.match(line, /lag=7m/);
  assert.match(line, /verdict=ON TIME/);
  assert.equal(line.split("\n").length, 1, "must print exactly one line");
});

test("publish-lag: publish instant resolution", async (t) => {
  await t.test("defaults to the assertion instant (the publish moment)", () => {
    const now = new Date("2026-11-13T06:12:00Z");
    const r = resolvePublishedAt({ now });
    assert.equal(r.source, "run");
    assert.equal(r.publishedAt.toISOString(), now.toISOString());
  });

  await t.test("--at replays another instant", () => {
    const r = resolvePublishedAt({ at: "2026-11-13T06:12:00Z" });
    assert.equal(r.source, "override");
    assert.equal(r.publishedAt.toISOString(), "2026-11-13T06:12:00.000Z");
  });

  await t.test("a malformed --at throws instead of silently using now", () => {
    assert.throws(() => resolvePublishedAt({ at: "yesterday" }), /not a valid date/);
  });
});

test("publish-lag: sidecar 补发 flag is read from the written edition", async (t) => {  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "publish-lag-"));
  try {
    await t.test("missing sidecar is not a backfill", () => {
      assert.equal(isBackfilledSidecar("2026-11-13", "06", dir), false);
    });

    await t.test("sidecar without the flag is not a backfill", () => {
      fs.mkdirSync(path.join(dir, "2026-11-13"), { recursive: true });
      fs.writeFileSync(path.join(dir, "2026-11-13", "06.json"), JSON.stringify({ a: 1 }));
      assert.equal(isBackfilledSidecar("2026-11-13", "06", dir), false);
    });

    await t.test("sidecar carrying backfilled:true is a backfill", () => {
      fs.writeFileSync(
        path.join(dir, "2026-11-13", "06.json"),
        JSON.stringify({ backfilled: true }),
      );
      assert.equal(isBackfilledSidecar("2026-11-13", "06", dir), true);
    });

    await t.test("unparseable sidecar does not crash the check", () => {
      fs.writeFileSync(path.join(dir, "2026-11-13", "06.json"), "{not json");
      assert.equal(isBackfilledSidecar("2026-11-13", "06", dir), false);
    });

    await t.test("readSidecarGeneratedAt reads the written fetch instant", () => {
      fs.writeFileSync(
        path.join(dir, "2026-11-13", "06.json"),
        JSON.stringify({ fetch_health: { generated_at: "2026-11-12T22:04:11.086Z" } }),
      );
      assert.equal(
        readSidecarGeneratedAt("2026-11-13", "06", dir),
        "2026-11-12T22:04:11.086Z",
      );
    });

    await t.test("readSidecarGeneratedAt is null when it cannot tell", () => {
      // Missing file, no fetch_health, a non-string value, unparseable JSON:
      // all mean "unknown", which the assert treats as not-premature.
      assert.equal(readSidecarGeneratedAt("2026-11-13", "19", dir), null);
      fs.writeFileSync(path.join(dir, "2026-11-13", "06.json"), JSON.stringify({ a: 1 }));
      assert.equal(readSidecarGeneratedAt("2026-11-13", "06", dir), null);
      fs.writeFileSync(
        path.join(dir, "2026-11-13", "06.json"),
        JSON.stringify({ fetch_health: { generated_at: 42 } }),
      );
      assert.equal(readSidecarGeneratedAt("2026-11-13", "06", dir), null);
      fs.writeFileSync(path.join(dir, "2026-11-13", "06.json"), "{not json");
      assert.equal(readSidecarGeneratedAt("2026-11-13", "06", dir), null);
    });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
