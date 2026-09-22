"use client";

import { explorerTx, type SendResult } from "@/lib/solana";

export function Button({
  children,
  onClick,
  disabled,
  busy,
  variant = "primary",
  className = "",
}: {
  children: React.ReactNode;
  onClick?: () => void;
  disabled?: boolean;
  busy?: boolean;
  variant?: "primary" | "ghost" | "danger";
  className?: string;
}) {
  const styles = {
    primary: "bg-bell text-bg hover:brightness-110",
    ghost: "border border-line bg-panel-2 text-text hover:border-muted",
    danger: "border border-halted/50 bg-halted/10 text-halted hover:bg-halted/20",
  }[variant];
  return (
    <button
      onClick={onClick}
      disabled={disabled || busy}
      className={`rounded-lg px-3.5 py-2 text-sm font-medium transition disabled:cursor-not-allowed disabled:opacity-40 ${styles} ${className}`}
    >
      {busy ? "Sending…" : children}
    </button>
  );
}

export function NumberInput({
  value,
  onChange,
  suffix,
  placeholder,
}: {
  value: string;
  onChange: (v: string) => void;
  suffix?: string;
  placeholder?: string;
}) {
  return (
    <div className="flex items-center rounded-lg border border-line bg-panel-2 focus-within:border-muted">
      <input
        inputMode="decimal"
        value={value}
        placeholder={placeholder}
        onChange={(e) => onChange(e.target.value.replace(/[^0-9.]/g, ""))}
        className="num w-full min-w-0 bg-transparent px-3 py-2 text-text outline-none"
      />
      {suffix && <span className="pr-3 text-sm text-muted">{suffix}</span>}
    </div>
  );
}

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

export function Card({ title, eyebrow, children, className = "" }: { title?: string; eyebrow?: string; children: React.ReactNode; className?: string }) {
  return (
    <div className={`panel p-5 ${className}`}>
      {eyebrow && <div className="eyebrow">{eyebrow}</div>}
      {title && <h4 className="mt-1 mb-4 font-semibold">{title}</h4>}
      {children}
    </div>
  );
}
