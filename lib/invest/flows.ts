/**
 * Free delayed East Money sector fund-flow snapshot.
 * Failures return null — never fatal. Label as unofficial / delayed.
 */

import { fetchJson } from "./http-json";

export interface SectorFlow {
  name: string;
  changePct: number;
  /** Net inflow in 亿元. */
  netInflowYi: number;
}

export interface FundFlowSnapshot {
  sectors: SectorFlow[];
  fetchedAt: string;
  note: string;
}

interface EmBoardRow {
  f12?: string;
  f14?: string;
  f3?: number;
  f62?: number;
}

const NOTE =
  "东方财富公开延时板块资金流 · 非官方 · 非实时 · 仅供参考 · 不构成投资建议";

async function fetchClist(fs: string): Promise<SectorFlow[] | null> {
  const urls = [
    "https://push2.eastmoney.com",
    "https://push2delay.eastmoney.com",
  ].map(
    (host) =>
      `${host}/api/qt/clist/get` +
      `?pn=1&pz=12&po=1&np=1&fltt=2&invt=2` +
      `&fid=f62&fs=${encodeURIComponent(fs)}` +
      `&fields=f12,f14,f3,f62`,
  );

  const j = await fetchJson<{ data?: { diff?: EmBoardRow[] } }>(urls, {
    headers: {
      Referer: "https://data.eastmoney.com/bkzj/hy.html",
      Accept: "application/json,text/plain,*/*",
    },
    timeoutMs: 10_000,
  });
  const rows = j?.data?.diff;
  if (!rows?.length) return null;

  const sectors: SectorFlow[] = [];
  for (const r of rows) {
    if (!r.f14 || r.f3 == null || r.f62 == null) continue;
    sectors.push({
      name: String(r.f14),
      changePct: Number(r.f3) || 0,
      netInflowYi: (Number(r.f62) || 0) / 1e8,
    });
  }
  return sectors.length ? sectors : null;
}

/**
 * Sector board fund flow (东方财富行业板块). Optional concept fallback.
 * Any failure → null (panel omitted).
 */
export async function fetchFundFlows(): Promise<FundFlowSnapshot | null> {
  // m:90+t:2 industry boards; m:90+t:3 concepts
  const sectors =
    (await fetchClist("m:90+t:2")) ?? (await fetchClist("m:90+t:3"));
  if (!sectors?.length) return null;
  return {
    sectors,
    fetchedAt: new Date().toISOString(),
    note: NOTE,
  };
}
