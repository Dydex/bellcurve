"use client";

import { useMemo, useState } from "react";
import { coneHalfSpreadBps, type Params } from "@/lib/quote";
import { useNow, usePool } from "@/lib/usePool";

export interface Gap {
  closed: string;
  hours: number;
  move_bps: number;
}

interface Props {
  gaps: Record<string, Gap[]>;
  sigmaClosed: Record<string, number>;
}

const W = 760;
const H = 380;
const M = { l: 56, r: 20, t: 20, b: 44 };
const X_MAX = 84;

/** Default pricing parameters (the deployed pool's, with per-stock volatility). */
function paramsFor(sigmaClosedBps: number): Params {
  return {
    baseHalfSpreadBps: 5,
    sigmaOpenBps: 0,
    sigmaClosedBps,
    spreadZBps: 15_000,
    maxHalfSpreadBps: 1_500,
    inventorySkewBps: 10,
    targetBaseWeightBps: 5_000,
    impactBps: 20_000,
    feeBps: 5,
    bandOpenBps: 500,
    bandClosedBps: 2_000,
    minBaseWeightBps: 1_000,
    maxBaseWeightBps: 9_000,
    maxStalenessSecs: 300,
  };
}

export default function BellCurve({ gaps, sigmaClosed }: Props) {
  const tickers = Object.keys(gaps);
  const [ticker, setTicker] = useState("NVDA");
  const { pool } = usePool();
  const now = useNow();

  const p = useMemo(() => paramsFor(sigmaClosed[ticker]), [ticker, sigmaClosed]);
  const data = gaps[ticker];

  const { yMax, inside, coveredByFee } = useMemo(() => {
    const moves = data.map((g) => Math.abs(g.move_bps)).sort((a, b) => a - b);
    const p98 = moves[Math.floor(moves.length * 0.98)] ?? 100;
    const cone = coneHalfSpreadBps(p, X_MAX);
    const yMax = Math.ceil(Math.max(p98, cone) * 1.15 / 100) * 100;
    const inside = data.filter((g) => Math.abs(g.move_bps) <= coneHalfSpreadBps(p, g.hours)).length;
    const coveredByFee = data.filter((g) => Math.abs(g.move_bps) <= 30).length;
    return { yMax, inside, coveredByFee };
  }, [data, p]);

  const x = (h: number) => M.l + (Math.min(h, X_MAX) / X_MAX) * (W - M.l - M.r);
  const y = (bps: number) => M.t + ((yMax - Math.max(-yMax, Math.min(yMax, bps))) / (2 * yMax)) * (H - M.t - M.b);

  const cone = Array.from({ length: 85 }, (_, i) => i).map((h) => [h, coneHalfSpreadBps(p, h)] as const);
  const upper = cone.map(([h, b]) => `${x(h)},${y(b)}`).join(" ");
  const lower = cone
    .slice()
    .reverse()
    .map(([h, b]) => `${x(h)},${y(-b)}`)
    .join(" ");

  const liveHours =
    pool && pool.ticker === ticker && pool.market.status === "closed" ? (now - pool.market.closeTs) / 3600 : null;
  const yTicks = [-yMax, -yMax / 2, 0, yMax / 2, yMax];
  const xTicks = [0, 12, 24, 36, 48, 60, 72, 84];

  return (
    <div className="panel p-6">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <div className="eyebrow">Every weekend since Oct 2023</div>
          <h3 className="mt-1 text-xl font-semibold">The quote widens as the uncertainty does</h3>
        </div>
        <div className="flex flex-wrap gap-1">
          {tickers.map((t) => (
            <button
              key={t}
              onClick={() => setTicker(t)}
              className={`rounded-md px-3 py-1 text-sm transition ${
                t === ticker ? "bg-bell text-bg" : "bg-panel-2 text-muted hover:text-text"
              }`}
            >
              {t}
            </button>
          ))}
        </div>
      </div>

      <svg viewBox={`0 0 ${W} ${H}`} className="mt-5 w-full" role="img" aria-label={`${ticker} weekend moves versus Bellcurve's quote`}>
        {yTicks.map((t) => (
          <g key={t}>
            <line x1={M.l} x2={W - M.r} y1={y(t)} y2={y(t)} stroke="var(--line)" strokeDasharray={t === 0 ? "" : "2 4"} />
            <text x={M.l - 8} y={y(t) + 4} textAnchor="end" fontSize="11" fill="var(--dim)" className="num">
              {t > 0 ? "+" : ""}
              {(t / 100).toFixed(t % 100 === 0 ? 0 : 1)}%
            </text>
          </g>
        ))}
        {xTicks.map((t) => (
          <text key={t} x={x(t)} y={H - M.b + 18} textAnchor="middle" fontSize="11" fill="var(--dim)" className="num">
            {t}h
          </text>
        ))}
        <text x={(M.l + W - M.r) / 2} y={H - 6} textAnchor="middle" fontSize="11" fill="var(--muted)">
          hours since prices stopped printing (Friday 8pm New York)
        </text>

        <polygon points={`${upper} ${lower}`} fill="var(--bell)" fillOpacity="0.1" />
        <polyline points={upper} fill="none" stroke="var(--bell)" strokeWidth="2" />
        <polyline points={lower} fill="none" stroke="var(--bell)" strokeWidth="2" />

        <line x1={x(56)} x2={x(56)} y1={M.t} y2={H - M.b} stroke="var(--dim)" strokeDasharray="3 3" />
        <text x={x(56) + 6} y={M.t + 12} fontSize="11" fill="var(--muted)">
          Monday pre-market
        </text>

        {data.map((g) => {
          const ok = Math.abs(g.move_bps) <= coneHalfSpreadBps(p, g.hours);
          return (
            <circle key={g.closed} cx={x(g.hours)} cy={y(g.move_bps)} r="3.2" fill={ok ? "var(--cpmm)" : "var(--halted)"} fillOpacity={ok ? 0.55 : 0.9}>
              <title>{`${g.closed}: ${g.move_bps > 0 ? "+" : ""}${(g.move_bps / 100).toFixed(2)}% after ${g.hours}h`}</title>
            </circle>
          );
        })}

        {liveHours !== null && (
          <g>
            <line x1={x(liveHours)} x2={x(liveHours)} y1={M.t} y2={H - M.b} stroke="var(--closed)" strokeWidth="1.5" />
            <text x={x(liveHours) + 6} y={H - M.b - 8} fontSize="11" fill="var(--closed)">
              live pool now: ±{coneHalfSpreadBps(pool!.params, liveHours).toFixed(0)} bps
            </text>
          </g>
        )}
      </svg>

      <div className="mt-4 grid gap-4 text-sm sm:grid-cols-3">
        <p>
          <span className="num text-bell">{((inside / data.length) * 100).toFixed(0)}%</span>{" "}
          <span className="text-muted">
            of {data.length} weekends and holidays reopened inside Bellcurve&apos;s quote (±{(p.spreadZBps / 1e4).toFixed(1)}σ√t).
          </span>
        </p>
        <p>
          <span className="num text-halted">{(((data.length - coveredByFee) / data.length) * 100).toFixed(0)}%</span>{" "}
          <span className="text-muted">moved more than a normal pool&apos;s 0.30% fee, a free profit for whoever trades first.</span>
        </p>
        <p className="text-muted">
          Red dots are gaps beyond the quote; there the closed-market curve and the price band limit the damage.
        </p>
      </div>
    </div>
  );
}
