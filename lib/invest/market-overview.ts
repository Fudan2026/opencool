/**
 * Free delayed A-share index snapshot via Eastmoney public API.
 * Failures return null — never fatal.
 */

export interface IndexSnap {
  code: string;
  name: string;
  price: number;
  changePct: number;
}

export interface MarketOverview {
  indices: IndexSnap[];
  fetchedAt: string;
  note: string;
}

async function fetchEmIndex(secid: string): Promise<IndexSnap | null> {
  try {
    const url = `https://push2.eastmoney.com/api/qt/stock/get?secid=${secid}&fields=f57,f58,f43,f169,f170,f46,f44,f45,f168,f47,f48,f60`;
    const res = await fetch(url, {
      headers: { "User-Agent": "OpenCool/1.0", Referer: "https://quote.eastmoney.com/" },
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) return null;
    const j = (await res.json()) as {
      data?: { f57?: string; f58?: string; f43?: number; f170?: number };
    };
    const d = j.data;
    if (!d?.f58 || d.f43 == null) return null;
    return {
      code: String(d.f57 ?? secid),
      name: d.f58,
      price: d.f43 / 100,
      changePct: (d.f170 ?? 0) / 100,
    };
  } catch {
    return null;
  }
}

/** 1.000001 上证 · 0.399001 深成指 · 0.399006 创业板 */
export async function fetchMarketOverview(): Promise<MarketOverview | null> {
  const pairs: [string, string][] = [
    ["1.000001", "上证指数"],
    ["0.399001", "深证成指"],
    ["0.399006", "创业板指"],
  ];
  const indices: IndexSnap[] = [];
  for (const [secid] of pairs) {
    const snap = await fetchEmIndex(secid);
    if (snap) indices.push(snap);
  }
  if (indices.length === 0) return null;
  return {
    indices,
    fetchedAt: new Date().toISOString(),
    note: "东方财富公开延时接口 · 非实时 · 仅供参考",
  };
}
