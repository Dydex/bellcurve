"use client";

import { quote } from "@/lib/quote";
import { useNow, usePool } from "@/lib/usePool";
import { StatusPill, duration, usd } from "./Market";

/** The live pool at a glance, over an animated quote cone. */
export default function HeroCard() {
  const { pool } = usePool();
  const now = useNow();
  const q = pool ? quote(pool.params, pool.market, pool.reserves, now) : null;
  const m = pool?.market;

  return (
    <div className="relative">
      <div className="absolute -inset-8 rounded-[40px] bg-[radial-gradient(closest-side,rgba(242,181,68,0.18),transparent)] blur-2xl" aria-hidden />
      <div className="panel relative overflow-hidden p-6">
        <div className="flex items-center justify-between">
          <div>
            <div className="text-xs text-muted">Live on devnet</div>
            <div className="text-lg font-semibold">NVDA / USDC</div>
          </div>
          {m && <StatusPill status={m.status} />}
        </div>

        <svg viewBox="0 0 400 170" className="mt-4 w-full" aria-hidden>
          <defs>
            <linearGradient id="cone" x1="0" x2="1">
              <stop offset="0" stopColor="var(--bell)" stopOpacity="0.02" />
              <stop offset="1" stopColor="var(--bell)" stopOpacity="0.22" />
            </linearGradient>
          </defs>
          <path d="M10 85 C 60 70, 150 40, 390 12 L 390 158 C 150 130, 60 100, 10 85 Z" fill="url(#cone)" />
          <path d="M10 85 C 60 70, 150 40, 390 12" fill="none" stroke="var(--bell)" strokeWidth="2" />
          <path d="M10 85 C 60 100, 150 130, 390 158" fill="none" stroke="var(--bell)" strokeWidth="2" />
          <line x1="10" x2="390" y1="85" y2="85" stroke="var(--line)" strokeDasharray="3 5" />
          <circle r="4" fill="var(--closed)">
            <animate attributeName="cx" values="10;390" dur="6s" repeatCount="indefinite" />
            <animate attributeName="cy" values="85;80;92;76;98;70;101;85" dur="6s" repeatCount="indefinite" />
          </circle>
          <text x="10" y="165" fontSize="10" fill="var(--dim)">Friday close</text>
          <text x="390" y="165" fontSize="10" fill="var(--dim)" textAnchor="end">
            Monday open
          </text>
        </svg>

        <div className="num mt-4 grid grid-cols-3 gap-3 text-sm">
          <div className="rounded-lg bg-panel-2 p-3">
            <div className="text-xs text-dim">Reference</div>
            {m ? usd(m.refPrice) : "…"}
          </div>
          <div className="rounded-lg bg-panel-2 p-3">
            <div className="text-xs text-dim">Spread</div>
            {q ? `±${q.halfSpreadBps.toFixed(0)} bps` : m?.status === "halted" ? "halted" : m ? "stale" : "…"}
          </div>
          <div className="rounded-lg bg-panel-2 p-3">
            <div className="text-xs text-dim">{m?.status === "closed" ? "Closed for" : "Price age"}</div>
            {m ? duration(m.status === "closed" ? now - m.closeTs : now - m.refTs) : "…"}
          </div>
        </div>
      </div>
    </div>
  );
}
