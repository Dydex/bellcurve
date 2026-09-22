"use client";

import "./buffer-polyfill";
import { TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID, getAssociatedTokenAddressSync } from "@solana/spl-token";
import { Keypair, LAMPORTS_PER_SOL, PublicKey, type Transaction } from "@solana/web3.js";
import { createContext, useCallback, useContext, useEffect, useState } from "react";
import deployment from "@/data/deployment.json";
import { SHARE, USD, connection, type WalletSigner } from "./solana";

const DEMO_KEY = "bellcurve-demo-wallet";

export interface Balances {
  sol: number;
  /** shared pool's test stock, in shares */
  base: number;
  /** test USDC */
  quote: number;
  /** LP shares of the shared pool */
  lp: number;
}

interface WalletState {
  signer: WalletSigner | null;
  balances: Balances | null;
  useDemo(): void;
  connectPhantom(): Promise<void>;
  disconnect(): void;
  refresh(): Promise<void>;
  phantomAvailable: boolean;
}

const Ctx = createContext<WalletState | null>(null);

function demoSigner(): WalletSigner {
  let secret: number[] | null = null;
  try {
    secret = JSON.parse(localStorage.getItem(DEMO_KEY) ?? "null");
  } catch {}
  const kp = secret ? Keypair.fromSecretKey(Uint8Array.from(secret)) : Keypair.generate();
  try {
    localStorage.setItem(DEMO_KEY, JSON.stringify(Array.from(kp.secretKey)));
  } catch {}
  return {
    kind: "demo",
    publicKey: kp.publicKey,
    async signTransaction(tx: Transaction) {
      tx.partialSign(kp);
      return tx;
    },
  };
}

const phantom = () => (typeof window !== "undefined" ? (window as any).phantom?.solana : undefined);

/** Token amount from a raw token account (same layout in Token and Token-2022). */
function amountOf(data: Buffer | undefined, scale: number) {
  return data && data.length >= 72 ? Number(data.readBigUInt64LE(64)) / scale : 0;
}

export function WalletProvider({ children }: { children: React.ReactNode }) {
  const [signer, setSigner] = useState<WalletSigner | null>(null);
  const [balances, setBalances] = useState<Balances | null>(null);
  const [phantomAvailable, setPhantomAvailable] = useState(false);

  useEffect(() => {
    setPhantomAvailable(!!phantom()?.isPhantom);
    // Reuse a demo wallet from a previous visit.
    try {
      if (localStorage.getItem(DEMO_KEY)) setSigner(demoSigner());
    } catch {}
  }, []);

  const refresh = useCallback(async () => {
    if (!signer) return setBalances(null);
    const pk = signer.publicKey;
    const ata = (mint: string, program: PublicKey) => getAssociatedTokenAddressSync(new PublicKey(mint), pk, false, program);
    // One request for SOL and all three token balances.
    const infos = await connection
      .getMultipleAccountsInfo([
        pk,
        ata(deployment.baseMint, TOKEN_2022_PROGRAM_ID),
        ata(deployment.quoteMint, TOKEN_PROGRAM_ID),
        ata(deployment.lpMint, TOKEN_PROGRAM_ID),
      ])
      .catch(() => null);
    if (!infos) return;
    const [sol, base, quote, lp] = infos;
    setBalances({
      sol: (sol?.lamports ?? 0) / LAMPORTS_PER_SOL,
      base: amountOf(base?.data, SHARE),
      quote: amountOf(quote?.data, USD),
      lp: amountOf(lp?.data, USD),
    });
  }, [signer]);

  useEffect(() => {
    refresh();
    const id = setInterval(refresh, 20_000);
    return () => clearInterval(id);
  }, [refresh]);

  const value: WalletState = {
    signer,
    balances,
    phantomAvailable,
    refresh,
    useDemo: () => setSigner(demoSigner()),
    connectPhantom: async () => {
      const p = phantom();
      if (!p) throw new Error("Phantom is not installed");
      const { publicKey } = await p.connect();
      setSigner({
        kind: "phantom",
        publicKey: new PublicKey(publicKey.toString()),
        signTransaction: (tx: Transaction) => p.signTransaction(tx),
      });
    },
    disconnect: () => {
      if (signer?.kind === "phantom") phantom()?.disconnect?.();
      setSigner(null);
    },
  };
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useWallet() {
  const v = useContext(Ctx);
  if (!v) throw new Error("useWallet outside WalletProvider");
  return v;
}
