"use client";

import { createContext, useCallback, useContext, useState } from "react";
import { explorerTx, type SendResult } from "./solana";

interface Toast extends SendResult {
  id: number;
  title: string;
}

const Ctx = createContext<(title: string, result: SendResult) => void>(() => {});

export function ToastProvider({ children }: { children: React.ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const push = useCallback((title: string, result: SendResult) => {
    const id = Date.now() + Math.random();
    setToasts((t) => [...t.slice(-3), { id, title, ...result }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), 8_000);
  }, []);
  return (
    <Ctx.Provider value={push}>
      {children}
      <div className="pointer-events-none fixed right-4 bottom-4 z-50 flex w-[min(380px,calc(100vw-2rem))] flex-col gap-2">
        {toasts.map((t) => (
          <div
            key={t.id}
            className={`pointer-events-auto rounded-xl border bg-panel/95 p-4 shadow-2xl backdrop-blur ${
              t.ok ? "border-open/40" : "border-halted/40"
            }`}
          >
            <div className="flex items-center gap-2 text-sm font-semibold">
              <span className={t.ok ? "text-open" : "text-halted"}>{t.ok ? "✓" : "✕"}</span>
              {t.title}
              {t.code && <span className="num rounded bg-halted/15 px-1.5 py-0.5 text-xs text-halted">{t.code}</span>}
            </div>
            <p className="mt-1 text-sm text-muted">{t.message}</p>
            {t.signature && (
              <a className="mt-1 inline-block text-xs text-bell hover:underline" href={explorerTx(t.signature)} target="_blank">
                View on Solana Explorer ↗
              </a>
            )}
          </div>
        ))}
      </div>
    </Ctx.Provider>
  );
}

export const useToast = () => useContext(Ctx);
