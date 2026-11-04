import test from "node:test";
import assert from "node:assert/strict";

import { tokenize } from "./tokenize";
import { buildIndex, query, SEARCH_BUDGET_BYTES } from "./engine";

function edition(date: string, hour: string, hero: string, texts: string[] = [], keywords: string[] = []) {
  return { date, hour, hero, texts, keywords };
}

test("search tokenizer", async (t) => {
  await t.test("CJK bigrams + ascii words, deduped", () => {
    const toks = tokenize("央行MLF操作鸽派超预期");
    assert.ok(toks.includes("央行"));
    assert.ok(toks.includes("mlf"));
    assert.ok(toks.includes("超预期".slice(0, 2)));
    assert.ok(new Set(toks).size === toks.length);
  });

  await t.test("ascii words need 3+ chars, lowercased", () => {
    const toks = tokenize("The Fed cut rates by 25bp to 4.0%");
    assert.ok(toks.includes("fed"));
    assert.ok(toks.includes("rates"));
    assert.ok(!toks.includes("the"));
    assert.ok(!toks.includes("to"));
    // numerals are informative in finance headlines — kept as tokens
    assert.ok(toks.includes("25bp"));
  });
});

test("search engine", async (t) => {
  const index = buildIndex([
    edition("2026-11-01", "06", "央行开展 5000 亿元 MLF 操作", ["流动性投放超预期"], ["MLF"]),
    edition("2026-11-01", "19", "中国风电制造商为欧洲业务架设防火墙", ["风电出口增长"]),
    edition("2026-11-02", "13", "Polymarket 量化交易全过程", ["预测市场兴起"], ["polymarket"]),
  ]);

  await t.test("postings are ascending docIdx, docs chronological", () => {
    const docs = index.docs.map((d) => `${d.d} ${d.h}`);
    assert.deepEqual(docs, [
      "2026-11-01 06",
      "2026-11-01 19",
      "2026-11-02 13",
    ]);
    for (const list of Object.values(index.postings)) {
      const sorted = [...list].sort((a, b) => a - b);
      assert.deepEqual(list, sorted);
    }
  });

  await t.test("AND query matches all terms", () => {
    const res = query(index, "央行 MLF");
    assert.equal(res.length, 1);
    assert.equal(res[0].doc.d, "2026-11-01");
    assert.equal(res[0].terms, 2);
  });

  await t.test("OR fallback ranked by match count then recency", () => {
    const res = query(index, "MLF 防火墙 风电");
    // no doc contains all four tokens → OR: the wind-power doc matches
    // 防火/火墙/风电 (3 terms via bigrams), ranks first
    assert.ok(res.length >= 2);
    assert.equal(res[0].doc.h, "19");
    assert.equal(res[0].terms, 3);
  });

  await t.test("maxDocs caps to the newest window", () => {
    const capped = buildIndex(
      [
        edition("2026-10-01", "06", "十月旧闻"),
        edition("2026-11-01", "06", "十一月新闻"),
      ],
      { maxDocs: 1 },
    );
    assert.equal(capped.docs.length, 1);
    assert.equal(capped.docs[0].d, "2026-11-01");
  });

  await t.test("budget constant is the 2MB contract", () => {
    assert.equal(SEARCH_BUDGET_BYTES, 2097152);
  });
});
