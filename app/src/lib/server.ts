// Server-only helpers: the admin key that funds the faucet, and live prices.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Connection, Keypair } from "@solana/web3.js";

export const RPC_URL = process.env.RPC_URL ?? "https://api.devnet.solana.com";

export function connection() {
  return new Connection(RPC_URL, "confirmed");
}

/**
 * The faucet's key: mint authority of the test tokens, funded with devnet SOL, and nothing else.
 * FAUCET_KEYPAIR (JSON byte array) when deployed; ~/.config/solana/bellcurve-faucet.json locally.
 */
export function faucetKeypair(): Keypair {
  const raw =
    process.env.FAUCET_KEYPAIR ?? fs.readFileSync(path.join(os.homedir(), ".config/solana/bellcurve-faucet.json"), "utf8");
  return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(raw)));
}

/** Latest one-minute print including extended hours (Yahoo Finance). */
export async function latestPrice(ticker: string): Promise<{ price: number; ts: number }> {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${ticker}?range=5d&interval=1m&includePrePost=true`;
  const res = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0" } });
  if (!res.ok) throw new Error(`price source ${res.status}`);
  const r = (await res.json()).chart.result[0];
  const ts: number[] = r.timestamp;
  const close: (number | null)[] = r.indicators.quote[0].close;
  for (let i = ts.length - 1; i >= 0; i--) {
    if (close[i] != null) return { price: close[i]!, ts: ts[i] };
  }
  throw new Error(`no prints for ${ticker}`);
}
