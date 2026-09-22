"use client";

import { useEffect, useRef, useState } from "react";
import { explorerAddress } from "@/lib/solana";
import { useToast } from "@/lib/toast";
import { useWallet } from "@/lib/wallet";

/** Ask the faucet for test SOL, NVDA and USDC. */
export function useFaucet() {
  const { signer, refresh } = useWallet();
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const request = async () => {
    if (!signer) return;
    setBusy(true);
    try {
      const res = await fetch("/api/faucet", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ wallet: signer.publicKey.toBase58() }),
      });
      const body = await res.json();
      toast(
        "Test tokens",
        res.ok
          ? { ok: true, signature: body.signature, message: `Received ${body.sol} SOL, ${body.shares} NVDA and $${body.usdc.toLocaleString()} USDC.` }
          : { ok: false, message: body.error },
      );
      await refresh();
    } finally {
      setBusy(false);
    }
  };
  return { request, busy };
}

export default function WalletButton() {
  const { signer, balances, useDemo, connectPhantom, disconnect, phantomAvailable } = useWallet();
  const { request, busy } = useFaucet();
  const toast = useToast();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const close = (e: MouseEvent) => ref.current && !ref.current.contains(e.target as Node) && setOpen(false);
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, []);

  const address = signer?.publicKey.toBase58();
  return (
    <div ref={ref} className="relative">
      <button
        onClick={() => setOpen((o) => !o)}
        className={`rounded-full px-4 py-2 text-sm font-semibold transition ${
          signer ? "border border-line bg-panel-2 text-text hover:border-muted" : "bg-bell text-bg hover:brightness-110"
        }`}
      >
        {signer ? (
          <span className="num">
            {address!.slice(0, 4)}…{address!.slice(-4)}
            <span className="ml-2 text-muted">{balances ? `${balances.sol.toFixed(2)} SOL` : ""}</span>
          </span>
        ) : (
          "Connect"
        )}
      </button>

      {open && (
        <div className="absolute right-0 z-40 mt-2 w-72 rounded-xl border border-line bg-panel p-3 shadow-2xl">
          {!signer ? (
            <div className="space-y-2">
              <button
                onClick={() => {
                  useDemo();
                  setOpen(false);
                }}
                className="w-full rounded-lg bg-panel-2 px-3 py-2.5 text-left hover:bg-line"
              >
                <div className="text-sm font-semibold">Demo wallet</div>
                <div className="text-xs text-muted">No install. A devnet key kept in this browser.</div>
              </button>
              <button
                disabled={!phantomAvailable}
                onClick={() =>
                  connectPhantom()
                    .then(() => setOpen(false))
                    .catch((e) => toast("Phantom", { ok: false, message: e.message }))
                }
                className="w-full rounded-lg bg-panel-2 px-3 py-2.5 text-left hover:bg-line disabled:opacity-40"
              >
                <div className="text-sm font-semibold">Phantom</div>
                <div className="text-xs text-muted">{phantomAvailable ? "Switch Phantom to devnet first." : "Not installed in this browser."}</div>
              </button>
            </div>
          ) : (
            <div>
              <div className="flex items-center justify-between">
                <span className="eyebrow">{signer.kind === "demo" ? "Demo wallet" : "Phantom"} · devnet</span>
                <a className="text-xs text-bell hover:underline" href={explorerAddress(address!)} target="_blank">
                  explorer ↗
                </a>
              </div>
              <div className="num mt-3 grid grid-cols-2 gap-2 text-sm">
                {[
                  ["SOL", balances?.sol.toFixed(3)],
                  ["NVDA", balances?.base.toFixed(4)],
                  ["USDC", balances?.quote.toFixed(2)],
                  ["LP", balances?.lp.toFixed(2)],
                ].map(([k, v]) => (
                  <div key={k} className="rounded-lg bg-panel-2 px-3 py-2">
                    <div className="text-xs text-dim">{k}</div>
                    {v ?? "…"}
                  </div>
                ))}
              </div>
              <button
                onClick={request}
                disabled={busy}
                className="mt-3 w-full rounded-lg bg-bell px-3 py-2 text-sm font-semibold text-bg hover:brightness-110 disabled:opacity-50"
              >
                {busy ? "Sending…" : "Get test tokens"}
              </button>
              <button onClick={disconnect} className="mt-2 w-full text-xs text-dim hover:text-muted">
                Disconnect
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
