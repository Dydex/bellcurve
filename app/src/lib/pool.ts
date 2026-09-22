// Server-side reader for the deployed devnet pool.
import { BorshCoder, EventParser } from "@anchor-lang/core";
import { Connection, PublicKey } from "@solana/web3.js";
import idl from "@/idl/bellcurve.json";
import deployment from "@/data/deployment.json";
import type { Market, Params, Reserves, Status } from "./quote";

const RPC_URL = process.env.RPC_URL ?? "https://api.devnet.solana.com";
const USD = 1e6;
const SHARE = 1e8;

const coder = new BorshCoder(idl as any);
const programId = new PublicKey(deployment.programId);
const poolKey = new PublicKey(deployment.pool);

export interface Trade {
  signature: string;
  side: "sell" | "buy";
  /** shares */
  shares: number;
  /** USD per share */
  price: number;
  refPrice: number;
  halfSpreadBps: number;
  status: Status;
  ts: number;
}

export interface PoolSnapshot {
  ticker: string;
  pool: string;
  programId: string;
  now: number;
  params: Params;
  market: Market;
  reserves: Reserves;
  totalVolume: number;
  totalFees: number;
  trades: Trade[];
}

const num = (v: any) => (typeof v === "number" ? v : Number(v.toString()));
const camel = (k: string) => k.replace(/_([a-z])/g, (_, c) => c.toUpperCase());
/** Enum variants decode as `{ Closed: {} }`. */
const variant = (v: any) => Object.keys(v)[0].toLowerCase() as Status;

// Parsed trades by signature, so each transaction is fetched once.
const tradeCache = new Map<string, Trade[]>();

const amount = (data: Buffer | undefined) => (data && data.length >= 72 ? Number(data.readBigUInt64LE(64)) : 0);

export async function readPool(): Promise<PoolSnapshot> {
  const connection = new Connection(RPC_URL, "confirmed");
  const [[account, baseVault, quoteVault], sigs] = await Promise.all([
    connection.getMultipleAccountsInfo([
      poolKey,
      new PublicKey(deployment.baseVault),
      new PublicKey(deployment.quoteVault),
    ]),
    connection.getSignaturesForAddress(poolKey, { limit: 12 }),
  ]);
  if (!account) throw new Error("pool account not found");
  const pool: any = coder.accounts.decode("Pool", account.data);

  const params = Object.fromEntries(Object.entries(pool.params).map(([k, v]) => [camel(k), num(v)])) as unknown as Params;
  const m = pool.market;
  const market: Market = {
    status: variant(m.status),
    refPrice: num(m.ref_price) / USD,
    refTs: num(m.ref_ts),
    closeTs: num(m.close_ts),
    virtualBase: num(m.virtual_base) / SHARE,
    virtualQuote: num(m.virtual_quote) / USD,
  };

  const ok = sigs.filter((s) => !s.err);
  const fresh = ok.filter((s) => !tradeCache.has(s.signature));
  if (fresh.length) {
    const txs = await connection.getTransactions(
      fresh.map((s) => s.signature),
      { maxSupportedTransactionVersion: 0, commitment: "confirmed" },
    );
    const parser = new EventParser(programId, coder);
    txs.forEach((tx, i) => {
      const trades: Trade[] = [];
      for (const ev of parser.parseLogs(tx?.meta?.logMessages ?? [])) {
        if (ev.name !== "SwapExecuted") continue;
        const d: any = ev.data;
        const sell = num(d.side) === 0;
        trades.push({
          signature: fresh[i].signature,
          side: sell ? "sell" : "buy",
          shares: (sell ? num(d.amount_in) : num(d.amount_out)) / SHARE,
          price: num(d.exec_price) / USD,
          refPrice: num(d.ref_price) / USD,
          halfSpreadBps: num(d.half_spread_bps),
          status: variant(d.status),
          ts: num(d.ts),
        });
      }
      if (tx) tradeCache.set(fresh[i].signature, trades);
    });
  }
  const trades = ok.flatMap((s) => tradeCache.get(s.signature) ?? []);

  return {
    ticker: deployment.ticker,
    pool: deployment.pool,
    programId: deployment.programId,
    now: Math.floor(Date.now() / 1000),
    params,
    market,
    reserves: { base: amount(baseVault?.data) / SHARE, quote: amount(quoteVault?.data) / USD },
    totalVolume: num(pool.total_volume) / USD,
    totalFees: num(pool.total_fees) / USD,
    trades,
  };
}
