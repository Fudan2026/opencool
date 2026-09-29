import type { ArticleInput } from "../ai/pipeline";
import type { TickerAnalysis } from "../trading/signals";
import {
  countEventsByTicker,
  matchEvents,
  type EventHit,
  type TickerEventCount,
} from "./events";
import { fetchMarketOverview, type MarketOverview } from "./market-overview";
import { fetchFundFlows, type FundFlowSnapshot } from "./flows";
import { runToyBacktests, type ToyBacktestResult } from "./backtest";
import { scoreWatchlist, type PersonaScore } from "./personas";
import { RISK_GATES, BACKTEST_VERDICT_TEMPLATE, type RiskGate } from "./risk-gates";
import { SCHOOL_LESSONS, type Lesson } from "./school";
import { KNOWLEDGE, type KnowledgeEntry } from "./knowledge";

export interface QuantSection {
  generated_at: string;
  market?: MarketOverview | null;
  fundFlows?: FundFlowSnapshot | null;
  events: EventHit[];
  eventCounts: TickerEventCount[];
  personas: PersonaScore[];
  riskGates: RiskGate[];
  backtestTemplate: typeof BACKTEST_VERDICT_TEMPLATE;
  toyBacktests: ToyBacktestResult[];
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

  let fundFlows: FundFlowSnapshot | null = null;
  try {
    fundFlows = await fetchFundFlows();
  } catch {
    fundFlows = null;
  }

  const events = matchEvents(articles);
  return {
    generated_at: new Date().toISOString(),
    market,
    fundFlows,
    events,
    eventCounts: countEventsByTicker(events),
    personas: scoreWatchlist(tickers),
    riskGates: RISK_GATES,
    backtestTemplate: BACKTEST_VERDICT_TEMPLATE,
    toyBacktests: runToyBacktests(tickers),
    school: SCHOOL_LESSONS,
    knowledge: KNOWLEDGE,
  };
}
