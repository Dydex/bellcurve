"use client";

import { useState } from "react";
import { explorerAddress, type SendResult } from "@/lib/solana";
import { useWallet } from "@/lib/wallet";
import { Button, ResultLine } from "./ui";

export default function WalletCard() {
  const { signer, balances, useDemo, connectPhantom, disconnect, refresh, phantomAvailable } = useWallet();
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<SendResult | null>(null);

  const faucet = async () => {
    if (!signer) return;
    setBusy(true);
    try {
      const res = await fetch("/api/faucet", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ wallet: signer.publicKey.toBase58() }),
      });
      const body = await res.json();
      setResult(
        res.ok
          ? { ok: true, signature: body.signature, message: `Received ${body.sol} SOL, ${body.shares} test NVDA and $${body.usdc.toLocaleString()} test USDC.` }
          : { ok: false, message: body.error },
      );
      await refresh();
    } finally {
      setBusy(false);
    }
  };

  if (!signer) {
    return (
      <div className="panel p-5">
        <div className="eyebrow">Step 1</div>
        <h4 className="mt-1 font-semibold">Get a devnet wallet</h4>
        <p className="mt-2 mb-4 text-sm text-muted">
          The demo wallet is a key kept in this browser: no extension, no real money. Everything runs on Solana devnet.
        </p>
        <div className="flex flex-wrap gap-2">
          <Button onClick={useDemo}>Use a demo wallet</Button>
          {phantomAvailable && (
            <Button variant="ghost" onClick={() => connectPhantom().catch((e) => setResult({ ok: false, message: e.message }))}>
              Connect Phantom (devnet)
            </Button>
          )}
        </div>
        {result && <div className="mt-3"><ResultLine result={result} /></div>}
      </div>
    );
  }

  const empty = balances && balances.sol < 0.005;
  const address = signer.publicKey.toBase58();
  return (
    <div className="panel p-5">
      <div className="flex items-start justify-between gap-3">
        <div>
          <div className="eyebrow">{signer.kind === "demo" ? "Demo wallet" : "Phantom"} · devnet</div>
          <a className="num mt-1 block text-sm text-text hover:text-bell" href={explorerAddress(address)} target="_blank">
            {address.slice(0, 6)}…{address.slice(-6)} ↗
          </a>
        </div>
        <button className="text-xs text-dim hover:text-muted" onClick={disconnect}>
          disconnect
        </button>
      </div>

      <div className="num mt-4 grid grid-cols-4 gap-3 text-sm">
        {[
          ["SOL", balances?.sol.toFixed(3)],
          ["NVDA", balances?.base.toFixed(4)],
          ["USDC", balances?.quote.toFixed(2)],
          ["LP", balances?.lp.toFixed(2)],
        ].map(([k, v]) => (
          <div key={k}>
            <div className="text-xs text-dim">{k}</div>
            <div>{v ?? "…"}</div>
          </div>
        ))}
      </div>

      <div className="mt-4 flex flex-wrap items-center gap-2">
        <Button onClick={faucet} busy={busy} variant={empty ? "primary" : "ghost"}>
          Get test tokens
        </Button>
        <span className="text-xs text-dim">0.06 SOL for fees, 5 test NVDA, $2,000 test USDC</span>
      </div>
      {result && <div className="mt-3"><ResultLine result={result} /></div>}
    </div>
  );
}
