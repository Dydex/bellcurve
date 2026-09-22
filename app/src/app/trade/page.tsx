import type { Metadata } from "next";
import BellCurve from "@/components/BellCurve";
import { MarketHeader, Protections, TradeTape } from "@/components/Market";
import TradeCard from "@/components/TradeCard";
import { gaps, sigmaClosed } from "@/lib/data";

export const metadata: Metadata = { title: "Trade · Bellcurve" };

export default function TradePage() {
  return (
    <main className="mx-auto max-w-7xl space-y-5 px-5 pt-6">
      <MarketHeader />
      <div className="grid gap-5 lg:grid-cols-[1fr_400px]">
        <div className="order-2 space-y-5 lg:order-1">
          <BellCurve gaps={gaps} sigmaClosed={sigmaClosed} fixedTicker="NVDA" title="Where the live quote sits" />
          <TradeTape />
        </div>
        <div className="order-1 space-y-5 lg:order-2">
          <TradeCard />
          <Protections />
        </div>
      </div>
    </main>
  );
}
