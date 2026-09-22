"use client";

import { explorerTx, type SendResult } from "@/lib/solana";

export interface LogEntry {
  id: number;
  at: number;
  action: string;
  result: SendResult;
}

export function ResultLine({ result }: { result: SendResult }) {
  return (
    <div
      className={`rounded-lg border px-3 py-2 text-sm ${
        result.ok ? "border-open/40 bg-open/5 text-open" : "border-halted/40 bg-halted/5 text-halted"
      }`}
    >
      <span className="mr-1">{result.ok ? "✓" : "✕"}</span>
      {result.code && <span className="num mr-1.5 font-semibold">{result.code}</span>}
      <span className={result.ok ? "" : "text-text/90"}>{result.message}</span>
      {result.signature && (
        <a className="ml-2 whitespace-nowrap text-bell hover:underline" href={explorerTx(result.signature)} target="_blank">
          view tx ↗
        </a>
      )}
    </div>
  );
}

export function ActionLog({ entries }: { entries: LogEntry[] }) {
  if (entries.length === 0) return <p className="text-sm text-dim">Actions you take appear here, with their on-chain result.</p>;
  return (
    <ul className="space-y-2">
      {entries.map((e) => (
        <li key={e.id} className="text-sm">
          <div className="mb-1 flex justify-between text-xs text-dim">
            <span>{e.action}</span>
            <span className="num">{new Date(e.at).toLocaleTimeString()}</span>
          </div>
          <ResultLine result={e.result} />
        </li>
      ))}
    </ul>
  );
}
