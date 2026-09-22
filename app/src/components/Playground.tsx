"use client";

import { PublicKey } from "@solana/web3.js";
import { useState } from "react";
import deployment from "@/data/deployment.json";
import { depositIx, ensureAccountsIxs, poolAddrs, swapIx, withdrawIx } from "@/lib/actions";
import { estimateSwap } from "@/lib/quote";
import { ERRORS, send, type SendResult } from "@/lib/solana";
import { useNow, usePool } from "@/lib/usePool";
import { useWallet } from "@/lib/wallet";
import { ActionLog, Button, NumberInput, ResultLine, type LogEntry } from "./ui";
import WalletCard from "./WalletCard";

const shared = poolAddrs(new PublicKey(deployment.baseMint), new PublicKey(deployment.quoteMint));
const usd = (n: number) => `$${n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

export default function Playground() {
  const { signer, balances, refresh } = useWallet();
  const { pool } = usePool();
  const now = useNow();
  const [side, setSide] = useState<"buy" | "sell">("buy");
  const [amount, setAmount] = useState("100");
  const [depShares, setDepShares] = useState("0.5");
  const [depUsd, setDepUsd] = useState("100");
  const [busy, setBusy] = useState<string | null>(null);
  const [log, setLog] = useState<LogEntry[]>([]);

  const record = (action: string, result: SendResult) =>
    setLog((l) => [{ id: Date.now(), at: Date.now(), action, result }, ...l].slice(0, 8));

  const run = async (label: string, build: () => Promise<any[]>) => {
    if (!signer) return;
    setBusy(label);
    try {
      const result = await send(signer, await build());
      record(label, result);
      await refresh();
    } finally {
      setBusy(null);
    }
  };

  const est = pool ? estimateSwap(pool.params, pool.market, pool.reserves, now, side, Number(amount)) : null;
  const lpShare = balances && balances.lp > 0 ? balances.lp : 0;

  return (
    <div className="grid gap-4 lg:grid-cols-[1fr_1.15fr]">
      <div className="space-y-4">
        <WalletCard />
        <div className="panel p-5">
          <div className="eyebrow">Your actions</div>
          <div className="mt-3">
            <ActionLog entries={log} />
          </div>
        </div>
      </div>

      <div className="space-y-4">
        <div className="panel p-5">
          <div className="flex items-center justify-between">
            <div>
              <div className="eyebrow">Step 2 · shared NVDA pool</div>
              <h4 className="mt-1 font-semibold">Swap</h4>
            </div>
            <div className="flex rounded-lg bg-panel-2 p-1 text-sm">
              {(["buy", "sell"] as const).map((s) => (
                <button
                  key={s}
                  onClick={() => {
                    setSide(s);
                    setAmount(s === "buy" ? "100" : "0.5");
                  }}
                  className={`rounded-md px-4 py-1 capitalize ${side === s ? "bg-panel text-text" : "text-muted"}`}
                >
                  {s}
                </button>
              ))}
            </div>
          </div>
          <div className="mt-4">
            <NumberInput value={amount} onChange={setAmount} suffix={side === "buy" ? "USDC to spend" : "NVDA to sell"} />
          </div>

          <div className="mt-3 rounded-lg bg-panel-2 px-3 py-3 text-sm">
            {!est ? (
              <span className="text-dim">Enter an amount to preview the trade.</span>
            ) : est.refusal ? (
              <span className="text-halted">
                The program would refuse this: <span className="num font-semibold">{est.refusal}</span>. {ERRORS[est.refusal]}
              </span>
            ) : (
              <div className="num grid grid-cols-3 gap-2">
                <div>
                  <div className="text-xs text-dim">You get about</div>
                  {side === "buy" ? `${est.out.toFixed(4)} NVDA` : usd(est.out)}
                </div>
                <div>
                  <div className="text-xs text-dim">Price</div>
                  {usd(est.price)}
                </div>
                <div>
                  <div className="text-xs text-dim">vs reference</div>
                  {est.vsRefBps > 0 ? "+" : ""}
                  {est.vsRefBps.toFixed(0)} bps
                </div>
              </div>
            )}
          </div>

          <div className="mt-3 flex items-center gap-3">
            <Button
              disabled={!signer}
              busy={busy === "swap"}
              onClick={() =>
                run("swap", async () => [
                  ...ensureAccountsIxs(shared, signer!.publicKey),
                  await swapIx(shared, signer!.publicKey, side, Number(amount), null),
                ])
              }
            >
              {side === "buy" ? "Buy NVDA" : "Sell NVDA"}
            </Button>
            <span className="text-xs text-dim">
              {pool?.market.status === "closed"
                ? "Market closed: trades move the pool's own price, and the spread widens with time."
                : pool?.market.status === "halted"
                  ? "Trading halted: expect a refusal."
                  : "Market open: quotes track the exchange."}
            </span>
          </div>
        </div>

        <div className="panel p-5">
          <div className="eyebrow">Step 3 · shared NVDA pool</div>
          <h4 className="mt-1 font-semibold">Provide liquidity</h4>
          <p className="mt-1 text-sm text-muted">
            Deposits are valued at the reference price, so they only go through while the market is open with a fresh
            price. Withdrawals work in every state.
          </p>
          <div className="mt-4 grid grid-cols-2 gap-2">
            <NumberInput value={depShares} onChange={setDepShares} suffix="NVDA" />
            <NumberInput value={depUsd} onChange={setDepUsd} suffix="USDC" />
          </div>
          <div className="mt-3 flex flex-wrap gap-2">
            <Button
              variant="ghost"
              disabled={!signer}
              busy={busy === "deposit"}
              onClick={() =>
                run("deposit", async () => [
                  ...ensureAccountsIxs(shared, signer!.publicKey),
                  await depositIx(shared, signer!.publicKey, Number(depShares), Number(depUsd), null),
                ])
              }
            >
              Deposit
            </Button>
            <Button
              variant="ghost"
              disabled={!signer || lpShare === 0}
              busy={busy === "withdraw all"}
              onClick={() => run("withdraw all", async () => [await withdrawIx(shared, signer!.publicKey, lpShare)])}
            >
              Withdraw all ({lpShare.toFixed(2)} LP)
            </Button>
          </div>
          {log[0] && (log[0].action === "deposit" || log[0].action === "withdraw all") && (
            <div className="mt-3">
              <ResultLine result={log[0].result} />
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
