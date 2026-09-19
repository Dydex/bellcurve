import Backtest, { type BacktestData } from "@/components/Backtest";
import BellCurve, { type Gap } from "@/components/BellCurve";
import Halts from "@/components/Halts";
import LivePool from "@/components/LivePool";
import backtestJson from "@/data/backtest.json";
import gapsJson from "@/data/gaps.json";

const backtest = backtestJson as unknown as BacktestData;
const gaps = gapsJson as Record<string, Gap[]>;
const sigmaClosed = Object.fromEntries(
  (backtestJson as any).tickers.map((t: any) => [t.ticker, Math.round(t.sigma_closed_bps)]),
);

const REPO = "https://github.com/Dydex/bellcurve";

function headline() {
  const t = backtest.tickers.find((x) => x.ticker === "NVDA")!;
  const bell = t.informed_only.find((v) => v.name === "bellcurve")!;
  const cpmm = t.informed_only.find((v) => v.name === "cpmm_30bps")!;
  const flow = t.with_flow;
  const openCost = (n: string) => flow.find((v) => v.name === n)!.cost_open_bps;
  return { bell, cpmm, t, bellOpen: openCost("bellcurve"), cpmmOpen: openCost("cpmm_30bps") };
}

const MODES = [
  {
    name: "Open",
    color: "var(--open)",
    title: "Follow the exchange",
    body: "While NYSE and Nasdaq print prices, the pool quotes a tight spread around the keeper's reference price, like Solana's oracle-driven prop AMMs. Arbitrageurs have nothing stale to pick off.",
  },
  {
    name: "Closed",
    color: "var(--closed)",
    title: "Discover the price, carefully",
    body: "When the exchange goes dark the pool becomes the price-discovery venue: trades move along x·y=k on virtual reserves that start at the closing price, and the spread widens with σ·√(time since close).",
  },
  {
    name: "Halted",
    color: "var(--halted)",
    title: "Stop when the exchange stops",
    body: "When Nasdaq halts the stock (news pending, a limit-up/limit-down pause) the keeper posts it on-chain and the program refuses swaps. Withdrawals always work.",
  },
];

export default function Home() {
  const h = headline();
  return (
    <main className="mx-auto max-w-6xl px-5 pb-24">
      <header className="flex items-center justify-between py-6">
        <div className="flex items-center gap-2.5">
          <svg width="26" height="26" viewBox="0 0 26 26" aria-hidden>
            <path d="M2 21 C 8 21, 9 5, 13 5 S 18 21, 24 21" fill="none" stroke="var(--bell)" strokeWidth="2.4" strokeLinecap="round" />
          </svg>
          <span className="text-lg font-semibold tracking-tight">Bellcurve</span>
        </div>
        <nav className="flex items-center gap-5 text-sm text-muted">
          <a href="#live" className="hover:text-text">Live pool</a>
          <a href="#backtest" className="hover:text-text">Backtest</a>
          <a href="#how" className="hover:text-text">How it works</a>
          <a href={REPO} className="hover:text-text" target="_blank">GitHub</a>
        </nav>
      </header>

      <section className="pt-10 pb-14">
        <div className="eyebrow">A tokenized-stock AMM for Solana</div>
        <h1 className="mt-3 max-w-3xl text-4xl font-semibold leading-tight tracking-tight sm:text-5xl">
          The AMM that knows when Wall Street is <span className="text-bell">closed</span>.
        </h1>
        <p className="mt-5 max-w-2xl text-lg text-muted">
          Tokenized stocks trade 24/7, but the stock market doesn&apos;t. Today&apos;s pools price NVDAx like a memecoin, so
          liquidity providers get picked off every time the real price moves first. Bellcurve follows the exchange while
          it&apos;s open, discovers the price with a widening spread while it&apos;s closed, and stops when trading halts.
        </p>

        <div className="mt-10 grid gap-4 sm:grid-cols-3">
          <div className="panel p-5">
            <div className="num text-3xl text-bell">
              {h.bell.lp_vs_hodl_pct.toFixed(0)}% <span className="text-lg text-dim">vs</span>{" "}
              <span className="text-cpmm">{h.cpmm.lp_vs_hodl_pct.toFixed(0)}%</span>
            </div>
            <p className="mt-2 text-sm text-muted">
              NVDA liquidity providers&apos; loss to informed traders over {h.t.years.toFixed(1)} years, Bellcurve vs a
              0.30% constant-product pool.
            </p>
          </div>
          <div className="panel p-5">
            <div className="num text-3xl text-bell">
              {h.bellOpen.toFixed(0)} <span className="text-lg text-dim">vs</span>{" "}
              <span className="text-cpmm">{h.cpmmOpen.toFixed(0)}</span>
              <span className="text-lg text-dim"> bps</span>
            </div>
            <p className="mt-2 text-sm text-muted">
              What an NVDA trade costs during market hours, because quotes track the exchange instead of lagging it.
            </p>
          </div>
          <div className="panel p-5">
            <div className="num text-3xl text-bell">{h.bell.worst_weekend_pct.toFixed(2)}%</div>
            <p className="mt-2 text-sm text-muted">
              Worst single weekend for Bellcurve LPs, versus up to 2% of the pool for an oracle pool that ignores market
              hours.
            </p>
          </div>
        </div>
      </section>

      <section id="live" className="scroll-mt-6 space-y-6">
        <LivePool />
        <BellCurve gaps={gaps} sigmaClosed={sigmaClosed} />
      </section>

      <section id="backtest" className="scroll-mt-6 pt-14">
        <Backtest data={backtest} />
        <p className="mt-4 max-w-4xl text-xs leading-relaxed text-dim">
          Method: hourly SPY, QQQ, NVDA, TSLA, AAPL and MSTR bars (regular and extended hours) replayed at one-minute
          resolution with Brownian-bridge paths between prints; while the market is closed the path bridges to the next
          open, so informed traders learn the gap gradually. Arbitrageurs trade every mispriced pool as far as it pays;
          uninformed orders are identical across pools. Bellcurve runs the exact pricing crate the on-chain program uses.{" "}
          {backtest.seeds} seeds; {backtest.oracle_latency_secs}s oracle delay unless noted. Simulated, not a promise of
          future returns.
        </p>
      </section>

      <section id="how" className="scroll-mt-6 pt-14">
        <div className="eyebrow">How it works</div>
        <h2 className="mt-1 text-2xl font-semibold">Three market states, one program</h2>
        <div className="mt-6 grid gap-4 md:grid-cols-3">
          {MODES.map((m) => (
            <div key={m.name} className="panel p-5">
              <span className="num text-xs font-semibold uppercase tracking-wider" style={{ color: m.color }}>
                {m.name}
              </span>
              <h3 className="mt-2 font-semibold">{m.title}</h3>
              <p className="mt-2 text-sm leading-relaxed text-muted">{m.body}</p>
            </div>
          ))}
        </div>
        <div className="mt-6 grid gap-4 md:grid-cols-2">
          <div className="panel p-5 text-sm leading-relaxed text-muted">
            <h3 className="mb-2 font-semibold text-text">Built for the SEC&apos;s new tokenized-stock exemption</h3>
            On September 17, 2026 the SEC let tokenized US stocks trade through permissioned AMMs on public chains, with
            synchronized halts, volume caps and real shareholder rights. Bellcurve already has the plumbing: keeper-synced
            halts, price bands, per-day volume caps, and optional trader passes for permissioned pools.
          </div>
          <div className="panel p-5 text-sm leading-relaxed text-muted">
            <h3 className="mb-2 font-semibold text-text">Tokenized-stock native</h3>
            Reads the Token-2022 Scaled UI Amount multiplier that issuers like xStocks use for dividends and splits, so a
            corporate action never misprices the pool. Deposits are only valued against a fresh open-market price;
            withdrawals work in every state.
          </div>
        </div>
      </section>

      <section className="pt-14">
        <Halts />
      </section>

      <footer className="mt-16 border-t border-line pt-6 text-xs text-dim">
        Bellcurve · built for Stocklana on Solana · devnet demo with test tokens, not investment advice ·{" "}
        <a href={REPO} className="hover:text-muted">source</a>
      </footer>
    </main>
  );
}
