"use client";

import { useEffect, useState } from "react";
import type { Halt } from "@/app/api/halts/route";

// Common Nasdaq halt reason codes.
const REASONS: Record<string, string> = {
  M: "Volatility pause (LULD)",
  LUDP: "Volatility pause (LULD)",
  T1: "News pending",
  T2: "News released",
  T12: "Info requested",
  H10: "SEC suspension",
  H11: "Regulatory concern",
  MWC1: "Market-wide circuit breaker",
};

export default function Halts() {
  const [halts, setHalts] = useState<Halt[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const load = () =>
      fetch("/api/halts")
        .then(async (r) => {
          const body = await r.json();
          if (!r.ok) throw new Error(body.error);
          setHalts(body);
        })
        .catch((e) => setError(e.message));
    load();
    const id = setInterval(load, 60_000);
    return () => clearInterval(id);
  }, []);

  const luld = halts?.filter((h) => h.reason === "M" || h.reason === "LUDP").length ?? 0;
  const active = halts?.filter((h) => !h.resumed) ?? [];

  return (
    <div className="panel p-6">
      <div className="eyebrow">Live from Nasdaq&apos;s trading-halt feed</div>
      <h3 className="mt-1 text-xl font-semibold">Stocks stop trading. 24/7 pools don&apos;t notice.</h3>
      {error ? (
        <p className="mt-4 text-sm text-muted">Halt feed unavailable: {error}</p>
      ) : !halts ? (
        <p className="mt-4 text-sm text-muted">Loading…</p>
      ) : (
        <>
          <div className="mt-5 grid grid-cols-3 gap-4">
            <div>
              <div className="num text-3xl text-halted">{halts.length}</div>
              <div className="text-xs text-muted">halts in the current feed</div>
            </div>
            <div>
              <div className="num text-3xl">{luld}</div>
              <div className="text-xs text-muted">volatility pauses (LULD)</div>
            </div>
            <div>
              <div className="num text-3xl">{active.length}</div>
              <div className="text-xs text-muted">not yet resumed</div>
            </div>
          </div>
          <div className="mt-5 max-h-64 overflow-y-auto">
            <table className="num w-full text-sm">
              <tbody>
                {halts.slice(0, 40).map((h, i) => (
                  <tr key={`${h.symbol}-${h.time}-${i}`} className="border-t border-line/60">
                    <td className="py-1.5 pr-3 font-semibold">{h.symbol}</td>
                    <td className="py-1.5 pr-3 text-muted">
                      {h.date} {h.time}
                    </td>
                    <td className="py-1.5 pr-3 font-sans text-muted">{REASONS[h.reason] ?? h.reason}</td>
                    <td className="py-1.5 text-right" style={{ color: h.resumed ? "var(--dim)" : "var(--halted)" }}>
                      {h.resumed ? `resumed ${h.resumed.slice(0, 5)}` : "halted"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="mt-4 text-xs text-dim">
            The feed drops resumed halts over time, so weekends show only long-running ones. On Friday, September 18 it
            listed 78 halts in a single session. Bellcurve&apos;s keeper reads this feed and posts <span className="num">Halted</span> on-chain; the program
            refuses swaps until trading resumes, the synchronized halt the SEC&apos;s new exemption asks tokenized-stock
            venues for.
          </p>
        </>
      )}
    </div>
  );
}
