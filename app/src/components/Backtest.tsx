"use client";

import { useState } from "react";

type Series = [number, number][];

interface InformedVenue {
  name: string;
  lp_vs_hodl_pct: number;
  lp_vs_hodl_pct_sd: number;
  per_year_pct: number;
  worst_weekend_pct: number;
  series: Series;
}

interface FlowVenue {
  name: string;
  lp_vs_hodl_pct: number;
  per_year_pct: number;
  fill_pct: number;
  cost_open_bps: number;
  cost_closed_bps: number;
}

interface TickerResult {
  ticker: string;
  years: number;
  informed_only: InformedVenue[];
  with_flow: FlowVenue[];
}

export interface BacktestData {
  seeds: number;
  oracle_latency_secs: number;
  start_usd: number;
  tickers: TickerResult[];
  latency_15s: Record<string, Record<string, number>>;
  latency_60s: Record<string, Record<string, number>>;
}

const VENUES: Record<string, { label: string; color: string }> = {
  cpmm_30bps: { label: "Constant-product, 0.30% fee", color: "var(--cpmm)" },
  cpmm_100bps: { label: "Constant-product, 1.00% fee", color: "var(--cpmm100)" },
  oracle_naive: { label: "Oracle pool, no market hours", color: "var(--naive)" },
  bellcurve: { label: "Bellcurve", color: "var(--bell)" },
};

const pct = (v: number, digits = 1) => `${v > 0 ? "+" : ""}${v.toFixed(digits)}%`;

function Bars({ venues }: { venues: InformedVenue[] }) {
  const max = Math.max(...venues.map((v) => Math.abs(v.lp_vs_hodl_pct)), 1);
  return (
    <div className="space-y-4">
      {venues.map((v) => {
        const w = (Math.abs(v.lp_vs_hodl_pct) / max) * 50;
        const neg = v.lp_vs_hodl_pct < 0;
        const meta = VENUES[v.name];
        return (
          <div key={v.name}>
            <div className="mb-1 flex justify-between text-sm">
              <span style={{ color: v.name === "bellcurve" ? "var(--bell)" : "var(--muted)" }}>{meta.label}</span>
              <span className="num">
                {pct(v.lp_vs_hodl_pct)}
                <span className="text-dim"> ±{v.lp_vs_hodl_pct_sd.toFixed(1)}</span>
              </span>
            </div>
            <div className="relative h-3 rounded-full bg-panel-2">
              <div className="absolute top-0 bottom-0 w-px bg-line" style={{ left: "50%" }} />
              <div
                className="absolute top-0 bottom-0 rounded-full"
                style={{
                  background: meta.color,
                  left: neg ? `${50 - w}%` : "50%",
                  width: `${Math.max(w, 0.5)}%`,
                }}
              />
            </div>
          </div>
        );
      })}
      <div className="flex justify-between text-xs text-dim">
        <span>LPs lose vs holding</span>
        <span>LPs gain</span>
      </div>
    </div>
  );
}

function Lines({ venues }: { venues: InformedVenue[] }) {
  const W = 520;
  const H = 240;
  const M = { l: 44, r: 10, t: 10, b: 24 };
  const shown = venues.filter((v) => v.name !== "cpmm_100bps");
  const all = shown.flatMap((v) => v.series);
  const [d0, d1] = [Math.min(...all.map((p) => p[0])), Math.max(...all.map((p) => p[0]))];
  const lo = Math.min(0, ...all.map((p) => p[1]));
  const hi = Math.max(0, ...all.map((p) => p[1]));
  const x = (d: number) => M.l + ((d - d0) / (d1 - d0)) * (W - M.l - M.r);
  const y = (v: number) => M.t + ((hi - v) / (hi - lo || 1)) * (H - M.t - M.b);
  const years = Array.from(new Set(all.map((p) => new Date(p[0] * 86400e3).getUTCFullYear())));
  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="w-full" role="img" aria-label="LP value versus holding over time">
      <line x1={M.l} x2={W - M.r} y1={y(0)} y2={y(0)} stroke="var(--line)" />
      {[lo, hi].map((v) => (
        <text key={v} x={M.l - 6} y={y(v) + 4} textAnchor="end" fontSize="10" fill="var(--dim)" className="num">
          {pct(v, 0)}
        </text>
      ))}
      {years.slice(1).map((yr) => {
        const d = Date.UTC(yr, 0, 1) / 86400e3;
        return (
          <g key={yr}>
            <line x1={x(d)} x2={x(d)} y1={M.t} y2={H - M.b} stroke="var(--line)" strokeDasharray="2 4" />
            <text x={x(d)} y={H - 6} textAnchor="middle" fontSize="10" fill="var(--dim)" className="num">
              {yr}
            </text>
          </g>
        );
      })}
      {shown.map((v) => (
        <polyline
          key={v.name}
          fill="none"
          stroke={VENUES[v.name].color}
          strokeWidth={v.name === "bellcurve" ? 2.4 : 1.4}
          points={v.series.map(([d, val]) => `${x(d)},${y(val)}`).join(" ")}
        />
      ))}
    </svg>
  );
}

export default function Backtest({ data }: { data: BacktestData }) {
  const [ticker, setTicker] = useState("NVDA");
  const t = data.tickers.find((x) => x.ticker === ticker)!;
  const bell = t.informed_only.find((v) => v.name === "bellcurve")!;
  const cpmm = t.informed_only.find((v) => v.name === "cpmm_30bps")!;

  return (
    <div className="panel p-6">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <div className="eyebrow">Backtest · {t.years.toFixed(1)} years of real hourly prices, minute-level replay</div>
          <h3 className="mt-1 text-xl font-semibold">What liquidity providers lose to informed traders</h3>
        </div>
        <div className="flex flex-wrap gap-1">
          {data.tickers.map((x) => (
            <button
              key={x.ticker}
              onClick={() => setTicker(x.ticker)}
              className={`rounded-md px-3 py-1 text-sm transition ${
                x.ticker === ticker ? "bg-bell text-bg" : "bg-panel-2 text-muted hover:text-text"
              }`}
            >
              {x.ticker}
            </button>
          ))}
        </div>
      </div>

      <div className="mt-6 grid gap-8 lg:grid-cols-2">
        <div>
          <Bars venues={t.informed_only} />
          <p className="mt-5 text-sm text-muted">
            Same $100k pool, same price path, arbitrageurs who know the true price every minute. Bellcurve:{" "}
            <span className="num text-bell">{pct(bell.per_year_pct)}</span>/yr vs{" "}
            <span className="num text-cpmm">{pct(cpmm.per_year_pct)}</span>/yr for a 0.30% constant-product pool. Worst
            single weekend: <span className="num text-bell">{bell.worst_weekend_pct.toFixed(2)}%</span> of the pool.
          </p>
        </div>
        <div>
          <div className="eyebrow mb-2">LP value minus buy-and-hold, % of starting capital</div>
          <Lines venues={t.informed_only} />
          <div className="mt-2 flex flex-wrap gap-4 text-xs text-muted">
            {["cpmm_30bps", "oracle_naive", "bellcurve"].map((n) => (
              <span key={n} className="flex items-center gap-1.5">
                <span className="h-0.5 w-4" style={{ background: VENUES[n].color }} />
                {VENUES[n].label}
              </span>
            ))}
          </div>
        </div>
      </div>

      <div className="mt-8 grid gap-8 lg:grid-cols-2">
        <div>
          <div className="eyebrow mb-3">With ordinary traders: what a trade costs vs the true price</div>
          <table className="num w-full text-sm">
            <thead className="text-left text-xs text-dim">
              <tr>
                <th className="pb-2 font-normal">Pool</th>
                <th className="pb-2 text-right font-normal">Market open</th>
                <th className="pb-2 text-right font-normal">Closed</th>
                <th className="pb-2 text-right font-normal">LP / yr</th>
              </tr>
            </thead>
            <tbody>
              {t.with_flow.map((v) => (
                <tr key={v.name} className="border-t border-line/60" style={{ color: v.name === "bellcurve" ? "var(--bell)" : undefined }}>
                  <td className="py-2 font-sans">{VENUES[v.name].label}</td>
                  <td className="py-2 text-right">{v.cost_open_bps.toFixed(0)} bps</td>
                  <td className="py-2 text-right">{v.cost_closed_bps.toFixed(0)} bps</td>
                  <td className="py-2 text-right">{pct(v.per_year_pct, 0)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="mt-3 text-xs text-dim">
            Closed-market trades cost more on Bellcurve on purpose: that is the price of real uncertainty, paid to the LPs
            who carry it.
          </p>
        </div>
        <div>
          <div className="eyebrow mb-3">Robustness: slower oracle, same informed traders</div>
          <table className="num w-full text-sm">
            <thead className="text-left text-xs text-dim">
              <tr>
                <th className="pb-2 font-normal">Oracle delay</th>
                <th className="pb-2 text-right font-normal">0.30% pool</th>
                <th className="pb-2 text-right font-normal">Bellcurve</th>
              </tr>
            </thead>
            <tbody>
              {[
                ["2 s", cpmm.lp_vs_hodl_pct, bell.lp_vs_hodl_pct],
                ["15 s", data.latency_15s[ticker].cpmm_30bps, data.latency_15s[ticker].bellcurve],
                ["60 s", data.latency_60s[ticker].cpmm_30bps, data.latency_60s[ticker].bellcurve],
              ].map(([label, c, b]) => (
                <tr key={label as string} className="border-t border-line/60">
                  <td className="py-2 font-sans">{label}</td>
                  <td className="py-2 text-right text-muted">{pct(c as number)}</td>
                  <td className="py-2 text-right" style={{ color: (b as number) >= (c as number) ? "var(--bell)" : "var(--halted)" }}>
                    {pct(b as number)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="mt-3 text-xs text-dim">
            Pyth and Chainlink update every Solana slot; at a minute of delay Bellcurve loses its edge on the most volatile
            names, so fresh prices matter.
          </p>
        </div>
      </div>
    </div>
  );
}
