"use client";

import { coneHalfSpreadBps, quote, type Status } from "@/lib/quote";
import { useNow, usePool } from "@/lib/usePool";

const explorer = (path: string) => `https://explorer.solana.com/${path}?cluster=devnet`;

export function statusColor(s: Status) {
  return s === "open" ? "var(--open)" : s === "closed" ? "var(--closed)" : "var(--halted)";
}

function duration(secs: number) {
  const s = Math.max(0, Math.floor(secs));
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (d > 0) return `${d}d ${h}h ${m}m`;
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${s % 60}s`;
  return `${s}s`;
}

const usd = (n: number, digits = 2) =>
  n.toLocaleString("en-US", { style: "currency", currency: "USD", minimumFractionDigits: digits, maximumFractionDigits: digits });

export function StatusPill({ status }: { status: Status }) {
  const label = { open: "Market open", closed: "Market closed", halted: "Trading halted" }[status];
  return (
    <span
      className="inline-flex items-center gap-2 rounded-full border px-3 py-1 text-sm font-medium"
      style={{ borderColor: statusColor(status), color: statusColor(status) }}
    >
      <span className="live-dot h-2 w-2 rounded-full" style={{ background: statusColor(status) }} />
      {label}
    </span>
  );
}

function Stat({ label, value, sub }: { label: string; value: React.ReactNode; sub?: React.ReactNode }) {
  return (
    <div>
      <div className="eyebrow">{label}</div>
      <div className="num mt-1 text-xl text-text">{value}</div>
      {sub && <div className="mt-0.5 text-xs text-muted">{sub}</div>}
    </div>
  );
}

export default function LivePool() {
  const { pool, error } = usePool();
  const now = useNow();

  if (!pool) {
    return (
      <div className="panel p-6 text-muted">
        {error ? `Could not reach devnet: ${error}` : "Reading the pool from Solana devnet…"}
      </div>
    );
  }

  const { market, params, reserves } = pool;
  const q = quote(params, market, reserves, now);
  const tvl = reserves.base * market.refPrice + reserves.quote;
  const closedFor = now - market.closeTs;
  const mondayOpenBps = coneHalfSpreadBps(params, Math.max(56, closedFor / 3600));

  return (
    <div className="panel overflow-hidden">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-line px-6 py-4">
        <div className="flex items-center gap-3">
          <span className="text-lg font-semibold">{pool.ticker} / USDC</span>
          <span className="rounded-md bg-panel-2 px-2 py-0.5 text-xs text-muted">Solana devnet</span>
        </div>
        <StatusPill status={market.status} />
      </div>

      <div className="grid gap-6 px-6 py-6 sm:grid-cols-2 lg:grid-cols-4">
        <Stat
          label="Reference price"
          value={usd(market.refPrice)}
          sub={
            market.status === "closed"
              ? `last print, market closed ${duration(closedFor)} ago`
              : `${duration(now - market.refTs)} old`
          }
        />
        <Stat
          label="Pool bid / ask"
          value={q ? `${usd(q.bid)} / ${usd(q.ask)}` : "—"}
          sub={q ? `mid ${usd(q.mid)}` : "no trading while halted"}
        />
        <Stat
          label="Half-spread now"
          value={q ? `±${q.halfSpreadBps.toFixed(0)} bps` : "—"}
          sub={
            market.status === "closed"
              ? `grows with √time · ±${mondayOpenBps.toFixed(0)} bps by the reopen`
              : "tight: the exchange is discovering the price"
          }
        />
        <Stat label="Liquidity" value={usd(tvl, 0)} sub={`${usd(pool.totalVolume, 0)} traded · ${usd(pool.totalFees)} fees`} />
      </div>

      {q && (
        <div className="px-6 pb-6">
          <div className="mb-2 flex justify-between text-xs text-muted">
            <span>
              {reserves.base.toFixed(2)} {pool.ticker}
            </span>
            <span>inventory</span>
            <span>{usd(reserves.quote, 0)} USDC</span>
          </div>
          <div className="flex h-2 overflow-hidden rounded-full bg-panel-2">
            <div className="bg-bell" style={{ width: `${(q.baseWeight * 100).toFixed(1)}%` }} />
            <div className="flex-1 bg-closed/40" />
          </div>
        </div>
      )}

      <div className="border-t border-line px-6 py-5">
        <div className="eyebrow mb-3">On-chain trade tape</div>
        {pool.trades.length === 0 ? (
          <div className="text-sm text-muted">No trades yet.</div>
        ) : (
          <div className="overflow-x-auto">
            <table className="num w-full text-sm">
              <thead className="text-left text-xs text-dim">
                <tr>
                  <th className="pb-2 font-normal">Time</th>
                  <th className="pb-2 font-normal">Side</th>
                  <th className="pb-2 text-right font-normal">Shares</th>
                  <th className="pb-2 text-right font-normal">Price</th>
                  <th className="pb-2 text-right font-normal">vs ref</th>
                  <th className="pb-2 text-right font-normal">Market</th>
                  <th className="pb-2 text-right font-normal">Tx</th>
                </tr>
              </thead>
              <tbody>
                {pool.trades.slice(0, 8).map((t) => {
                  const bps = ((t.price - t.refPrice) / t.refPrice) * 1e4;
                  return (
                    <tr key={t.signature} className="border-t border-line/60">
                      <td className="py-2 text-muted">{duration(now - t.ts)} ago</td>
                      <td className="py-2" style={{ color: t.side === "buy" ? "var(--open)" : "var(--halted)" }}>
                        {t.side}
                      </td>
                      <td className="py-2 text-right">{t.shares.toFixed(4)}</td>
                      <td className="py-2 text-right">{usd(t.price)}</td>
                      <td className="py-2 text-right text-muted">
                        {bps > 0 ? "+" : ""}
                        {bps.toFixed(0)} bps
                      </td>
                      <td className="py-2 text-right" style={{ color: statusColor(t.status) }}>
                        {t.status}
                      </td>
                      <td className="py-2 text-right">
                        <a className="text-bell hover:underline" href={explorer(`tx/${t.signature}`)} target="_blank">
                          view
                        </a>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
        <div className="mt-4 flex flex-wrap gap-x-5 gap-y-1 text-xs text-dim">
          <a className="hover:text-muted" href={explorer(`address/${pool.programId}`)} target="_blank">
            Program {pool.programId.slice(0, 6)}…
          </a>
          <a className="hover:text-muted" href={explorer(`address/${pool.pool}`)} target="_blank">
            Pool {pool.pool.slice(0, 6)}…
          </a>
        </div>
      </div>
    </div>
  );
}
