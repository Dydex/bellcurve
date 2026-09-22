import type { Metadata } from "next";
import Backtest from "@/components/Backtest";
import BellCurve from "@/components/BellCurve";
import Halts from "@/components/Halts";
import { backtest, gaps, sigmaClosed } from "@/lib/data";

export const metadata: Metadata = { title: "Research · Bellcurve" };

export default function ResearchPage() {
  return (
    <main className="mx-auto max-w-7xl space-y-8 px-5 pt-10">
      <div className="max-w-3xl">
        <div className="eyebrow">Research</div>
        <h1 className="mt-2 text-3xl font-semibold tracking-tight sm:text-4xl">The evidence</h1>
        <p className="mt-3 text-muted">
          Three years of real prices for six stocks, replayed minute by minute through today&apos;s pools and through
          Bellcurve, running the same pricing code as the on-chain program.
        </p>
      </div>
      <Backtest data={backtest} />
      <BellCurve gaps={gaps} sigmaClosed={sigmaClosed} />
      <Halts />
      <p className="max-w-4xl text-xs leading-relaxed text-dim">
        Method: hourly SPY, QQQ, NVDA, TSLA, AAPL and MSTR bars (regular and extended hours) replayed at one-minute
        resolution with Brownian-bridge paths between prints; while the market is closed the path bridges to the next open,
        so informed traders learn the gap gradually. Arbitrageurs trade every mispriced pool as far as it pays; uninformed
        orders are identical across pools. {backtest.seeds} seeds; {backtest.oracle_latency_secs}s oracle delay unless
        noted. Simulated, not a promise of future returns.
      </p>
    </main>
  );
}
