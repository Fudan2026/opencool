import test from "node:test";
import assert from "node:assert/strict";

import {
  THEME_CATALOG,
  themeArticleHits,
  resolveBoard,
} from "./catalog";

test("theme catalog", async (t) => {
  await t.test("catalog shape: key/name/aliases/boardHints all present", () => {
    assert.ok(THEME_CATALOG.length >= 20, `too few themes: ${THEME_CATALOG.length}`);
    const keys = new Set(THEME_CATALOG.map((x) => x.key));
    assert.equal(keys.size, THEME_CATALOG.length, "duplicate keys");
    for (const th of THEME_CATALOG) {
      assert.ok(th.name.length >= 2, `${th.key} name too short`);
      assert.ok(th.aliases.length >= 1, `${th.key} needs aliases`);
      assert.ok(th.boardHints.length >= 1, `${th.key} needs boardHints`);
    }
  });

  await t.test("article matching counts alias occurrences", () => {
    const th = THEME_CATALOG.find((x) => x.key === "ai")!;
    const { hits, matched } = themeArticleHits(
      ["AI大模型发布会", "大模型落地加速", "无关新闻"],
      th,
    );
    assert.ok(hits >= 2, `hits=${hits}`);
    assert.ok(matched.some((m) => m.includes("大模型") || m.includes("AI")));
  });

  await t.test("board resolution: exact beats substring, miss -> null", () => {
    const boards = [
      { code: "BK0001", name: "半导体" },
      { code: "BK0002", name: "半导体设备" },
      { code: "BK0003", name: "汽车整车" },
    ];
    const th = THEME_CATALOG.find((x) => x.key === "semiconductor")!;
    assert.equal(resolveBoard(th, boards)!.code, "BK0001"); // exact first
    const ev = THEME_CATALOG.find((x) => x.key === "ev")!; // hints 新能源汽车
    assert.equal(resolveBoard(ev, boards), null); // no match -> null
  });
});
