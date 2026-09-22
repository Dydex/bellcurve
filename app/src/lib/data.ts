// Bundled research data (see scripts/build_dashboard_data.py).
import type { BacktestData } from "@/components/Backtest";
import type { Gap } from "@/components/BellCurve";
import backtestJson from "@/data/backtest.json";
import gapsJson from "@/data/gaps.json";

export const backtest = backtestJson as unknown as BacktestData;
export const gaps = gapsJson as Record<string, Gap[]>;
export const sigmaClosed: Record<string, number> = Object.fromEntries(
  (backtestJson as any).tickers.map((t: any) => [t.ticker, Math.round(t.sigma_closed_bps)]),
);

/** Headline numbers for one stock. */
export function headline(ticker = "NVDA") {
  const t = backtest.tickers.find((x) => x.ticker === ticker)!;
  const informed = (n: string) => t.informed_only.find((v) => v.name === n)!;
  const flow = (n: string) => t.with_flow.find((v) => v.name === n)!;
  const weekends = gaps[ticker];
  return {
    years: t.years,
    bellLoss: informed("bellcurve").lp_vs_hodl_pct,
    cpmmLoss: informed("cpmm_30bps").lp_vs_hodl_pct,
    naiveLoss: informed("oracle_naive").lp_vs_hodl_pct,
    bellCostOpen: flow("bellcurve").cost_open_bps,
    cpmmCostOpen: flow("cpmm_30bps").cost_open_bps,
    weekendsBeyondFee: weekends.filter((g) => Math.abs(g.move_bps) > 30).length / weekends.length,
    weekendCount: weekends.length,
  };
}
