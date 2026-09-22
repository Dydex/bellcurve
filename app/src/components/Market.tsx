"use client";

import { isStale, quote, type Status } from "@/lib/quote";
import { explorerAddress, explorerTx } from "@/lib/solana";
import { useNow, usePool } from "@/lib/usePool";

export const statusColor = (s: Status) => (s === "open" ? "var(--open)" : s === "closed" ? "var(--closed)" : "var(--halted)");
const LABEL: Record<Status, string> = { open: "Market open", closed: "Market closed", halted: "Trading halted" };

export function StatusPill({ status }: { status: Status }) {
  return (
    <span
      className="inline-flex items-center gap-2 rounded-full border px-3 py-1 text-sm font-medium"
      style={{ borderColor: statusColor(status), color: statusColor(status) }}
    >
      <span className="live-dot h-2 w-2 rounded-full" style={{ background: statusColor(status) }} />
      {LABEL[status]}
    </span>
  );
}

export function duration(secs: number) {
  const s = Math.max(0, Math.floor(secs));
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m`;
  return `${s}s`;
}

export const usd = (n: number, digits = 2) =>
  n.toLocaleString("en-US", { style: "currency", currency: "USD", minimumFractionDigits: digits, maximumFractionDigits: digits });

function Metric({ label, value, sub }: { label: string; value: React.ReactNode; sub?: React.ReactNode }) {
  return (
    <div>
      <div className="text-xs text-muted">{label}</div>
      <div className="num mt-0.5 text-lg text-text">{value}</div>
      {sub && <div className="text-xs text-dim">{sub}</div>}
    </div>
  );
}

export function MarketHeader() {
  const { pool, error } = usePool();
  const now = useNow();
  if (!pool) return <div className="panel p-5 text-sm text-muted">{error ? `Devnet unavailable: ${error}` : "Loading the live pool…"}</div>;
  const { market, params, reserves } = pool;
  const q = quote(params, market, reserves, now);
  const stale = isStale(params, market, now);
  return (
    <div className="panel flex flex-wrap items-center gap-x-10 gap-y-4 p-5">
      <div className="flex items-center gap-3">
        <div className="flex -space-x-2">
          <span className="h-8 w-8 rounded-full border-2 border-panel bg-open/70" />
          <span className="h-8 w-8 rounded-full border-2 border-panel bg-closed/70" />
        </div>
        <div>
          <div className="text-lg font-semibold">{pool.ticker} / USDC</div>
          <a className="text-xs text-dim hover:text-muted" href={explorerAddress(pool.pool)} target="_blank">
            pool {pool.pool.slice(0, 6)}… ↗
          </a>
        </div>
      </div>
      <StatusPill status={market.status} />
      <Metric
        label="Reference"
        value={usd(market.refPrice)}
        sub={market.status === "closed" ? `closed ${duration(now - market.closeTs)} ago` : `${duration(now - market.refTs)} old`}
      />
      <Metric label="Bid / Ask" value={q ? `${q.bid.toFixed(2)} / ${q.ask.toFixed(2)}` : "—"} />
      <Metric
        label="Spread"
        value={q ? `±${q.halfSpreadBps.toFixed(0)} bps` : stale ? "stale" : "halted"}
        sub={stale ? "keeper silent: trades refused" : market.status === "closed" ? "widening with √time" : market.status === "halted" ? "trades refused" : "tracking the exchange"}
      />
      <Metric label="Liquidity" value={usd(reserves.base * market.refPrice + reserves.quote, 0)} />
      <Metric label="Volume" value={usd(pool.totalVolume, 0)} sub={`${usd(pool.totalFees)} fees`} />
    </div>
  );
}

export function TradeTape() {
  const { pool } = usePool();
  const now = useNow();
  return (
    <div className="panel p-5">
      <div className="mb-3 flex items-baseline justify-between">
        <h3 className="font-semibold">Recent trades</h3>
        <span className="text-xs text-dim">every swap is a public on-chain event</span>
      </div>
      {!pool || pool.trades.length === 0 ? (
        <p className="text-sm text-muted">No trades yet.</p>
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
                <th className="pb-2 text-right font-normal" />
              </tr>
            </thead>
            <tbody>
              {pool.trades.slice(0, 10).map((t) => {
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
                      <a className="text-bell hover:underline" href={explorerTx(t.signature)} target="_blank">
                        ↗
                      </a>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

export function Protections() {
  const { pool } = usePool();
  const p = pool?.params;
  const rows: [string, string][] = p
    ? [
        ["Halt sync", "Nasdaq halts stop swaps"],
        ["Stale price", `refused after ${p.maxStalenessSecs}s`],
        ["Price band", `±${p.bandOpenBps / 100}% open · ±${p.bandClosedBps / 100}% closed`],
        ["Inventory", `${p.minBaseWeightBps / 100}–${p.maxBaseWeightBps / 100}% stock`],
        ["Fee", `${p.feeBps / 100}% + spread`],
        ["Deposits", "open market only"],
        ["Withdrawals", "always"],
      ]
    : [];
  return (
    <div className="panel p-5">
      <h3 className="mb-3 font-semibold">Protections on this pool</h3>
      <ul className="space-y-2 text-sm">
        {rows.map(([k, v]) => (
          <li key={k} className="flex justify-between gap-3">
            <span className="flex items-center gap-2 text-muted">
              <span className="text-open">✓</span>
              {k}
            </span>
            <span className="num text-right text-text/90">{v}</span>
          </li>
        ))}
      </ul>
      <p className="mt-3 text-xs text-dim">Enforced by the program on every transaction, not by this website.</p>
    </div>
  );
}
