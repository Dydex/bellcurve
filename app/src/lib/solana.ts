"use client";

// Browser-side Solana plumbing: one connection, an instruction builder for the program,
// and a sender that turns program failures into readable messages.
import "./buffer-polyfill";
import { AnchorProvider, BN, Program } from "@anchor-lang/core";
import {
  Connection,
  Keypair,
  PublicKey,
  SendTransactionError,
  Transaction,
  type TransactionInstruction,
} from "@solana/web3.js";
import idl from "@/idl/bellcurve.json";
import deployment from "@/data/deployment.json";
import { confirmByPolling } from "./confirm";

export const RPC_URL = process.env.NEXT_PUBLIC_RPC_URL ?? "https://api.devnet.solana.com";
export const connection = new Connection(RPC_URL, "confirmed");
export const PROGRAM_ID = new PublicKey(deployment.programId);
export const USD = 1e6;
export const SHARE = 1e8;

export const bn = (n: number | bigint) => new BN(n.toString());

export interface WalletSigner {
  kind: "demo" | "phantom";
  publicKey: PublicKey;
  signTransaction(tx: Transaction): Promise<Transaction>;
}

/** Program client used only to build instructions; signing happens in `send`. */
export const program = new Program(
  idl as any,
  new AnchorProvider(
    connection,
    {
      publicKey: PublicKey.default,
      signTransaction: async () => {
        throw new Error("read-only");
      },
      signAllTransactions: async () => {
        throw new Error("read-only");
      },
    } as any,
    { commitment: "confirmed" },
  ),
);

export const explorerTx = (sig: string) => `https://explorer.solana.com/tx/${sig}?cluster=devnet`;
export const explorerAddress = (a: string) => `https://explorer.solana.com/address/${a}?cluster=devnet`;

/** What each program error means, in the words a tester needs. */
export const ERRORS: Record<string, string> = {
  Halted: "Refused: trading is halted. The program blocks swaps until the keeper reports that trading resumed.",
  StalePrice:
    "Refused: no fresh open-market price. Either the keeper stopped updating, or the market is closed (new deposits need a fresh price).",
  NoPrice: "Refused: the keeper has not posted a price yet.",
  OutsideBand: "Refused: this trade would fill too far from the reference price (the price band, like Nasdaq's limit-up/limit-down).",
  InventoryLimit: "Refused: the pool would end up holding too much of one side (inventory limit).",
  InsufficientLiquidity: "Refused: not enough liquidity in the pool for this trade.",
  ZeroAmount: "Enter an amount greater than zero.",
  EmptyPool: "The pool has no liquidity yet.",
  SlippageExceeded: "Refused: the output fell below your minimum.",
  VolumeCapExceeded: "Refused: this pool's daily volume cap is reached.",
  PassRequired: "Refused: this pool is permissioned and your wallet has no valid trader pass.",
  InvalidTimestamp: "Refused: the keeper's timestamp is invalid.",
  ConstraintHasOne: "Refused: this wallet is not allowed to do that (wrong keeper, admin or gatekeeper).",
};

export interface SendResult {
  ok: boolean;
  signature?: string;
  /** Program error name when the program refused, e.g. "Halted". */
  code?: string;
  message: string;
}

function explain(e: any, logs: string[]): { code?: string; message: string } {
  const code = logs.map((l) => l.match(/Error Code: (\w+)/)?.[1]).find(Boolean);
  if (code) return { code, message: ERRORS[code] ?? code };
  if (logs.some((l) => l.includes("insufficient funds"))) return { message: "Not enough tokens in your wallet." };
  const msg: string = e?.message ?? String(e);
  if (/insufficient lamports|Attempt to debit an account/.test(msg)) {
    return { message: "Not enough devnet SOL for fees. Use the faucet first." };
  }
  return { message: msg.split("\n")[0] };
}

export async function send(
  signer: WalletSigner,
  ixs: TransactionInstruction[],
  extraSigners: Keypair[] = [],
): Promise<SendResult> {
  try {
    const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash("confirmed");
    const tx = new Transaction({ feePayer: signer.publicKey, blockhash, lastValidBlockHeight }).add(...ixs);
    if (extraSigners.length) tx.partialSign(...extraSigners);
    const signed = await signer.signTransaction(tx);
    const signature = await connection.sendRawTransaction(signed.serialize(), { preflightCommitment: "confirmed" });
    const res = await confirmByPolling(connection, signature, lastValidBlockHeight);
    if (res.err) {
      const tx = await connection.getTransaction(signature, { maxSupportedTransactionVersion: 0, commitment: "confirmed" });
      return { ok: false, signature, ...explain(res.err, tx?.meta?.logMessages ?? []) };
    }
    return { ok: true, signature, message: "Confirmed on devnet." };
  } catch (e: any) {
    let logs: string[] = e?.logs ?? [];
    if (!logs.length && e instanceof SendTransactionError) {
      logs = (await e.getLogs(connection).catch(() => [])) ?? [];
    }
    return { ok: false, ...explain(e, logs) };
  }
}
