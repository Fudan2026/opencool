import type { ArticleInput } from "../ai/pipeline";
import type { TickerAnalysis } from "../trading/signals";
import { matchEvents, type EventHit } from "./events";
import { fetchMarketOverview, type MarketOverview } from "./market-overview";
import { scoreWatchlist, type PersonaScore } from "./personas";
import { RISK_GATES, BACKTEST_VERDICT_TEMPLATE, type RiskGate } from "./risk-gates";
import { SCHOOL_LESSONS, type Lesson } from "./school";
import { KNOWLEDGE, type KnowledgeEntry } from "./knowledge";

export interface QuantSection {
  generated_at: string;
  market?: MarketOverview | null;
  events: EventHit[];
  personas: PersonaScore[];
  riskGates: RiskGate[];
  backtestTemplate: typeof BACKTEST_VERDICT_TEMPLATE;
  school: Lesson[];
  knowledge: KnowledgeEntry[];
}

export async function buildQuantSection(
  tickers: TickerAnalysis[],
  articles: ArticleInput[],
): Promise<QuantSection> {
  let market: MarketOverview | null = null;
  try {
    market = await fetchMarketOverview();
  } catch {
    market = null;
  }
  return {
    generated_at: new Date().toISOString(),
    market,
    events: matchEvents(articles),
    personas: scoreWatchlist(tickers),
    riskGates: RISK_GATES,
    backtestTemplate: BACKTEST_VERDICT_TEMPLATE,
    school: SCHOOL_LESSONS,
    knowledge: KNOWLEDGE,
  };
}
