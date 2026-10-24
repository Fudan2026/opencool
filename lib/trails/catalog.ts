/** Curated hiking trails for the OpenCool Trails page. */

export interface Trail {
  id: string;
  name: string;
  region: string;
  difficulty: "easy" | "moderate" | "hard";
  distanceKm: number;
  elevationM: number;
  summary: string;
}

export const TRAILS: Trail[] = [
  {
    id: "huangshan-west",
    name: "黄山西海大峡谷",
    region: "安徽 · 黄山",
    difficulty: "hard",
    distanceKm: 12.5,
    elevationM: 980,
    summary: "云海与石林交错的经典线，台阶多、落差大，适合体力充沛的一日穿越。",
  },
  {
    id: "wuyi-nine-bend",
    name: "武夷山九曲溪畔步道",
    region: "福建 · 南平",
    difficulty: "easy",
    distanceKm: 6.2,
    elevationM: 180,
    summary: "沿溪缓行，丹霞岩壁近在眼前，适合轻松半日徒步与拍照。",
  },
  {
    id: "qingcheng-front",
    name: "青城前山循环",
    region: "四川 · 都江堰",
    difficulty: "moderate",
    distanceKm: 8.4,
    elevationM: 520,
    summary: "道教名山前山环线，林荫密、台阶稳，兼顾风景与可走性。",
  },
  {
    id: "langyashan-loop",
    name: "琅琊山环城绿道",
    region: "安徽 · 滁州",
    difficulty: "easy",
    distanceKm: 5.0,
    elevationM: 210,
    summary: "城郊短线，欧阳修醉翁亭一带，适合周末晨练与家庭出游。",
  },
  {
    id: "huashan-north",
    name: "华山北峰索道衔接段",
    region: "陕西 · 华阴",
    difficulty: "hard",
    distanceKm: 4.8,
    elevationM: 760,
    summary: "险峻花岗岩脊与长台阶，视野极佳，需防滑与充足补水。",
  },
  {
    id: "moganshan-bamboo",
    name: "莫干山竹海慢行",
    region: "浙江 · 德清",
    difficulty: "moderate",
    distanceKm: 9.1,
    elevationM: 430,
    summary: "竹海与民宿村落穿插，坡度温和，适合两天一夜轻松徒步。",
  },
];

export const DIFFICULTY_LABEL: Record<Trail["difficulty"], string> = {
  easy: "轻松",
  moderate: "中等",
  hard: "挑战",
};
