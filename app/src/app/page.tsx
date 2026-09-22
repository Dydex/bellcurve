import Link from "next/link";
import HeroCard from "@/components/HeroCard";
import { backtest, headline } from "@/lib/data";

const MODES = [
  {
    state: "Open",
    color: "var(--open)",
    title: "Tracks the exchange",
    body: "Quotes a few basis points around the live Nasdaq price. Nothing stale to pick off.",
  },
  {
    state: "Closed",
    color: "var(--closed)",
    title: "Finds the price itself",
    body: "Trades move the pool's own curve, and the spread widens with the square root of time.",
  },
  {
    state: "Halted",
    color: "var(--halted)",
    title: "Stops with the exchange",
    body: "Nasdaq halts the stock, the program refuses swaps. Withdrawals always work.",
  },
];

const SEC = [
  ["Halts synced with the exchange", "Keeper reads Nasdaq's halt feed"],
  ["Volume limits", "Daily cap enforced on-chain"],
  ["Eligible traders only", "Permissioned mode with trader passes"],
  ["Public trading activity", "Every swap is an on-chain event"],
  ["Public, auditable contracts", "Open-source Anchor program on Solana"],
];

const POOLS = [
  { name: "cpmm_30bps", label: "Constant-product 0.30%", color: "var(--cpmm)" },
  { name: "cpmm_100bps", label: "Constant-product 1.00%", color: "var(--cpmm100)" },
  { name: "oracle_naive", label: "Oracle pool, no market hours", color: "var(--naive)" },
  { name: "bellcurve", label: "Bellcurve", color: "var(--bell)" },
];

function Cta({ href, children, primary }: { href: string; children: React.ReactNode; primary?: boolean }) {
  return (
    <Link
      href={href}
      className={`rounded-xl px-6 py-3 font-semibold transition ${
        primary ? "bg-bell text-bg hover:brightness-110" : "border border-line bg-panel text-text hover:border-muted"
      }`}
    >
      {children}
    </Link>
  );
}

export default function Home() {
  const h = headline("NVDA");
  const nvda = backtest.tickers.find((t) => t.ticker === "NVDA")!;
  const max = Math.max(...nvda.informed_only.map((v) => Math.abs(v.lp_vs_hodl_pct)));

  return (
    <main>
      <section className="mx-auto grid max-w-7xl items-center gap-14 px-5 pt-16 pb-20 lg:grid-cols-[1.1fr_1fr] lg:pt-24">
        <div>
          <span className="inline-flex items-center gap-2 rounded-full border border-line bg-panel px-3 py-1 text-xs text-muted">
            <span className="live-dot h-1.5 w-1.5 rounded-full bg-open" /> Live on Solana devnet · built for Stocklana
          </span>
          <h1 className="mt-6 text-5xl leading-[1.05] font-semibold tracking-tight sm:text-6xl">
            The AMM that knows when Wall Street is <span className="text-bell">closed</span>.
          </h1>
          <p className="mt-6 max-w-xl text-lg text-muted">
            Tokenized stocks trade 24/7. The stock market doesn&apos;t. Bellcurve prices every trade by what the real
            market is doing: open, closed or halted.
          </p>
          <div className="mt-8 flex flex-wrap gap-3">
            <Cta href="/trade" primary>
              Launch app
            </Cta>
            <Cta href="/lab">Try the lab</Cta>
          </div>
          <p className="mt-6 text-sm text-dim">Exchange-synced halts · Token-2022 native · built for the SEC&apos;s tokenized-stock exemption</p>
        </div>
        <HeroCard />
      </section>

      <section className="border-y border-line bg-panel/40">
        <div className="mx-auto grid max-w-7xl gap-8 px-5 py-10 sm:grid-cols-2 lg:grid-cols-4">
          {[
            [`${h.bellLoss.toFixed(0)}%`, `vs ${h.cpmmLoss.toFixed(0)}%`, "NVDA liquidity providers' loss to faster traders over 3 years"],
            [`${h.bellCostOpen.toFixed(0)} bps`, `vs ${h.cpmmCostOpen.toFixed(0)} bps`, "What a trade costs during market hours"],
            [`${Math.round(h.weekendsBeyondFee * 100)}%`, "of weekends", "moved past a normal pool's fee: free money for arbitrageurs"],
            ["63%", "after the bell", "of tokenized-stock volume on Solana trades while Wall Street is closed"],
          ].map(([big, small, label]) => (
            <div key={label}>
              <div className="num text-3xl text-bell">
                {big} <span className="text-base text-dim">{small}</span>
              </div>
              <p className="mt-2 text-sm text-muted">{label}</p>
            </div>
          ))}
        </div>
      </section>

      <section className="mx-auto max-w-7xl px-5 pt-24">
        <div className="max-w-2xl">
          <div className="eyebrow">How it works</div>
          <h2 className="mt-2 text-3xl font-semibold tracking-tight">One pool, three market states</h2>
        </div>
        <div className="mt-10 grid gap-5 md:grid-cols-3">
          {MODES.map((m) => (
            <div key={m.state} className="panel p-6">
              <span className="num rounded-full border px-2.5 py-0.5 text-xs font-semibold" style={{ borderColor: m.color, color: m.color }}>
                {m.state}
              </span>
              <h3 className="mt-4 text-lg font-semibold">{m.title}</h3>
              <p className="mt-2 text-sm leading-relaxed text-muted">{m.body}</p>
            </div>
          ))}
        </div>
      </section>

      <section className="mx-auto grid max-w-7xl items-center gap-12 px-5 pt-24 lg:grid-cols-2">
        <div>
          <div className="eyebrow">Proof</div>
          <h2 className="mt-2 text-3xl font-semibold tracking-tight">Same money, same prices, same traders</h2>
          <p className="mt-4 text-muted">
            Three years of real NVDA prices replayed minute by minute through four pools, each starting with $100,000.
            Faster traders always know the true price. Bellcurve runs the exact code deployed on-chain.
          </p>
          <div className="mt-6">
            <Cta href="/research">See the research</Cta>
          </div>
        </div>
        <div className="panel p-6">
          <div className="text-sm text-muted">NVDA · liquidity providers vs simply holding</div>
          <div className="mt-5 space-y-4">
            {POOLS.map((p) => {
              const v = nvda.informed_only.find((x) => x.name === p.name)!.lp_vs_hodl_pct;
              return (
                <div key={p.name}>
                  <div className="mb-1 flex justify-between text-sm">
                    <span className={p.name === "bellcurve" ? "font-semibold text-bell" : "text-muted"}>{p.label}</span>
                    <span className="num">{v.toFixed(1)}%</span>
                  </div>
                  <div className="h-3 rounded-full bg-panel-2">
                    <div className="h-3 rounded-full" style={{ width: `${Math.max((Math.abs(v) / max) * 100, 1.5)}%`, background: p.color }} />
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      </section>

      <section className="mx-auto max-w-7xl px-5 pt-24">
        <div className="panel grid gap-10 p-8 lg:grid-cols-[1fr_1.3fr]">
          <div>
            <div className="eyebrow">Regulation-ready</div>
            <h2 className="mt-2 text-3xl font-semibold tracking-tight">Built for the SEC&apos;s new exemption</h2>
            <p className="mt-4 text-muted">
              On September 17, 2026 the SEC opened tokenized US stocks to permissioned AMMs on public blockchains, with
              conditions attached. Bellcurve already meets them in code.
            </p>
          </div>
          <ul className="grid gap-3 sm:grid-cols-2">
            {SEC.map(([cond, how]) => (
              <li key={cond} className="rounded-xl border border-line bg-panel-2 p-4">
                <div className="flex items-center gap-2 text-sm font-semibold">
                  <span className="text-open">✓</span>
                  {cond}
                </div>
                <div className="mt-1 text-sm text-muted">{how}</div>
              </li>
            ))}
          </ul>
        </div>
      </section>

      <section className="mx-auto max-w-7xl px-5 pt-24 text-center">
        <h2 className="text-3xl font-semibold tracking-tight sm:text-4xl">Trade the live pool, or break your own.</h2>
        <p className="mx-auto mt-3 max-w-xl text-muted">
          A demo wallet and test tokens in one click. Every action is a real transaction on Solana devnet.
        </p>
        <div className="mt-8 flex justify-center gap-3">
          <Cta href="/trade" primary>
            Launch app
          </Cta>
          <Cta href="/lab">Open the lab</Cta>
        </div>
      </section>
    </main>
  );
}
