"use client";

import { PublicKey } from "@solana/web3.js";
import { useState } from "react";
import deployment from "@/data/deployment.json";
import { depositIx, ensureAccountsIxs, poolAddrs, swapIx, withdrawIx } from "@/lib/actions";
import { estimateSwap } from "@/lib/quote";
import { ERRORS, send } from "@/lib/solana";
import { useToast } from "@/lib/toast";
import { useNow, usePool } from "@/lib/usePool";
import { useWallet } from "@/lib/wallet";
import { useFaucet } from "./WalletButton";

const shared = poolAddrs(new PublicKey(deployment.baseMint), new PublicKey(deployment.quoteMint));
const usd = (n: number) => `$${n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

function TokenBox({
  label,
  token,
  balance,
  value,
  onChange,
  readOnly,
}: {
  label: string;
  token: string;
  balance?: number;
  value: string;
  onChange?: (v: string) => void;
  readOnly?: boolean;
}) {
  return (
    <div className="rounded-xl border border-line bg-panel-2 p-4">
      <div className="flex justify-between text-xs text-muted">
        <span>{label}</span>
        {balance !== undefined && (
          <button className="hover:text-text" onClick={() => onChange?.(String(Math.floor(balance * 1e4) / 1e4))} disabled={readOnly}>
            Balance {balance.toLocaleString("en-US", { maximumFractionDigits: 4 })}
          </button>
        )}
      </div>
      <div className="mt-2 flex items-center gap-3">
        <input
          value={value}
          readOnly={readOnly}
          inputMode="decimal"
          placeholder="0"
          onChange={(e) => onChange?.(e.target.value.replace(/[^0-9.]/g, ""))}
          className="num w-full min-w-0 bg-transparent text-2xl text-text outline-none placeholder:text-dim"
        />
        <span className="flex shrink-0 items-center gap-2 rounded-full bg-panel px-3 py-1.5 text-sm font-semibold">
          <span className={`h-5 w-5 rounded-full ${token === "NVDA" ? "bg-open/70" : "bg-closed/70"}`} />
          {token}
        </span>
      </div>
    </div>
  );
}

export default function TradeCard() {
  const { signer, balances, refresh, useDemo } = useWallet();
  const { request, busy: faucetBusy } = useFaucet();
  const toast = useToast();
  const { pool } = usePool();
  const now = useNow();
  const [tab, setTab] = useState<"swap" | "liquidity">("swap");
  const [side, setSide] = useState<"buy" | "sell">("buy");
  const [amount, setAmount] = useState("100");
  const [depShares, setDepShares] = useState("0.5");
  const [depUsd, setDepUsd] = useState("100");
  const [busy, setBusy] = useState<string | null>(null);

  const run = async (label: string, title: string, build: () => Promise<any[]>) => {
    if (!signer) return;
    setBusy(label);
    try {
      toast(title, await send(signer, await build()));
      await refresh();
    } finally {
      setBusy(null);
    }
  };

  const est = pool ? estimateSwap(pool.params, pool.market, pool.reserves, now, side, Number(amount)) : null;
  const needsTokens = signer && balances && (balances.sol < 0.003 || (side === "buy" ? balances.quote : balances.base) === 0);
  const lp = balances?.lp ?? 0;

  const cta = () => {
    if (!signer) return <PrimaryButton onClick={useDemo}>Connect a demo wallet</PrimaryButton>;
    if (needsTokens)
      return (
        <PrimaryButton onClick={request} busy={faucetBusy}>
          Get test tokens
        </PrimaryButton>
      );
    return (
      <PrimaryButton
        busy={busy === "swap"}
        disabled={!est || !!est.refusal}
        onClick={() =>
          run("swap", side === "buy" ? "Buy NVDA" : "Sell NVDA", async () => [
            ...ensureAccountsIxs(shared, signer.publicKey),
            await swapIx(shared, signer.publicKey, side, Number(amount), null),
          ])
        }
      >
        {est?.refusal ? `Refused: ${est.refusal}` : side === "buy" ? "Buy NVDA" : "Sell NVDA"}
      </PrimaryButton>
    );
  };

  return (
    <div className="panel p-4">
      <div className="mb-4 flex gap-1 rounded-lg bg-panel-2 p-1 text-sm">
        {(["swap", "liquidity"] as const).map((t) => (
          <button
            key={t}
            onClick={() => setTab(t)}
            className={`flex-1 rounded-md py-1.5 capitalize transition ${tab === t ? "bg-panel text-text" : "text-muted hover:text-text"}`}
          >
            {t}
          </button>
        ))}
      </div>

      {tab === "swap" ? (
        <>
          <TokenBox
            label="You pay"
            token={side === "buy" ? "USDC" : "NVDA"}
            balance={signer ? (side === "buy" ? balances?.quote : balances?.base) : undefined}
            value={amount}
            onChange={setAmount}
          />
          <div className="relative z-10 -my-2.5 flex justify-center">
            <button
              aria-label="Switch direction"
              onClick={() => {
                setSide(side === "buy" ? "sell" : "buy");
                setAmount(side === "buy" ? "0.5" : "100");
              }}
              className="rounded-lg border border-line bg-panel px-2.5 py-1 text-muted hover:text-text"
            >
              ↓↑
            </button>
          </div>
          <TokenBox
            label="You receive (estimated)"
            token={side === "buy" ? "NVDA" : "USDC"}
            value={est && !est.refusal ? (side === "buy" ? est.out.toFixed(4) : est.out.toFixed(2)) : ""}
            readOnly
          />

          <div className="num mt-3 space-y-1.5 px-1 text-sm">
            {est?.refusal ? (
              <p className="font-sans text-halted">{ERRORS[est.refusal]}</p>
            ) : (
              <>
                <Row label="Price" value={est ? usd(est.price) : "—"} />
                <Row
                  label="vs reference"
                  value={est ? `${est.vsRefBps > 0 ? "+" : ""}${est.vsRefBps.toFixed(0)} bps` : "—"}
                />
                <Row label="Quote spread" value={est ? `±${est.halfSpreadBps.toFixed(0)} bps` : "—"} />
                <Row label="Market" value={pool ? pool.market.status : "—"} />
              </>
            )}
          </div>
          <div className="mt-4">{cta()}</div>
        </>
      ) : (
        <>
          <p className="mb-3 px-1 text-sm text-muted">
            Deposits are valued at the reference price, so they need an open market with a fresh price. Withdrawals always
            work.
          </p>
          <TokenBox label="NVDA" token="NVDA" balance={signer ? balances?.base : undefined} value={depShares} onChange={setDepShares} />
          <div className="h-2" />
          <TokenBox label="USDC" token="USDC" balance={signer ? balances?.quote : undefined} value={depUsd} onChange={setDepUsd} />
          <div className="mt-4 grid grid-cols-2 gap-2">
            <PrimaryButton
              disabled={!signer}
              busy={busy === "deposit"}
              onClick={() =>
                run("deposit", "Deposit", async () => [
                  ...ensureAccountsIxs(shared, signer!.publicKey),
                  await depositIx(shared, signer!.publicKey, Number(depShares), Number(depUsd), null),
                ])
              }
            >
              Deposit
            </PrimaryButton>
            <button
              disabled={!signer || lp === 0 || busy === "withdraw"}
              onClick={() => run("withdraw", "Withdraw", async () => [await withdrawIx(shared, signer!.publicKey, lp)])}
              className="rounded-xl border border-line bg-panel-2 py-3 text-sm font-semibold hover:border-muted disabled:opacity-40"
            >
              {busy === "withdraw" ? "Sending…" : `Withdraw ${lp.toFixed(2)} LP`}
            </button>
          </div>
        </>
      )}
    </div>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex justify-between">
      <span className="font-sans text-muted">{label}</span>
      <span>{value}</span>
    </div>
  );
}

function PrimaryButton({
  children,
  onClick,
  busy,
  disabled,
}: {
  children: React.ReactNode;
  onClick?: () => void;
  busy?: boolean;
  disabled?: boolean;
}) {
  return (
    <button
      onClick={onClick}
      disabled={disabled || busy}
      className="w-full rounded-xl bg-bell py-3 text-base font-semibold text-bg transition hover:brightness-110 disabled:cursor-not-allowed disabled:bg-panel-2 disabled:text-muted"
    >
      {busy ? "Sending…" : children}
    </button>
  );
}
