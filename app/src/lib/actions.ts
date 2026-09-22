"use client";

// Instruction builders for any Bellcurve pool (the shared one or a sandbox).
import {
  TOKEN_2022_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  createAssociatedTokenAccountIdempotentInstruction,
  getAssociatedTokenAddressSync,
  getScaledUiAmountConfig,
  unpackAccount,
  unpackMint,
} from "@solana/spl-token";
import { PublicKey, type TransactionInstruction } from "@solana/web3.js";
import type { Market, Params, Reserves, Status } from "./quote";
import { PROGRAM_ID, SHARE, USD, bn, connection, program } from "./solana";

export interface PoolAddrs {
  pool: PublicKey;
  baseMint: PublicKey;
  quoteMint: PublicKey;
  lpMint: PublicKey;
  baseVault: PublicKey;
  quoteVault: PublicKey;
}

export function poolAddrs(baseMint: PublicKey, quoteMint: PublicKey): PoolAddrs {
  const pool = PublicKey.findProgramAddressSync([Buffer.from("pool"), baseMint.toBuffer(), quoteMint.toBuffer()], PROGRAM_ID)[0];
  return {
    pool,
    baseMint,
    quoteMint,
    lpMint: PublicKey.findProgramAddressSync([Buffer.from("lp"), pool.toBuffer()], PROGRAM_ID)[0],
    baseVault: getAssociatedTokenAddressSync(baseMint, pool, true, TOKEN_2022_PROGRAM_ID),
    quoteVault: getAssociatedTokenAddressSync(quoteMint, pool, true, TOKEN_PROGRAM_ID),
  };
}

export const passAddress = (pool: PublicKey, trader: PublicKey) =>
  PublicKey.findProgramAddressSync([Buffer.from("pass"), pool.toBuffer(), trader.toBuffer()], PROGRAM_ID)[0];

export function userAccounts(a: PoolAddrs, owner: PublicKey) {
  return {
    base: getAssociatedTokenAddressSync(a.baseMint, owner, false, TOKEN_2022_PROGRAM_ID),
    quote: getAssociatedTokenAddressSync(a.quoteMint, owner, false, TOKEN_PROGRAM_ID),
    lp: getAssociatedTokenAddressSync(a.lpMint, owner, false, TOKEN_PROGRAM_ID),
  };
}

/** Idempotent creation of the owner's three token accounts for a pool. */
export function ensureAccountsIxs(a: PoolAddrs, owner: PublicKey): TransactionInstruction[] {
  const u = userAccounts(a, owner);
  return [
    createAssociatedTokenAccountIdempotentInstruction(owner, u.base, owner, a.baseMint, TOKEN_2022_PROGRAM_ID),
    createAssociatedTokenAccountIdempotentInstruction(owner, u.quote, owner, a.quoteMint, TOKEN_PROGRAM_ID),
    createAssociatedTokenAccountIdempotentInstruction(owner, u.lp, owner, a.lpMint, TOKEN_PROGRAM_ID),
  ];
}

const tokenPrograms = {
  baseTokenProgram: TOKEN_2022_PROGRAM_ID,
  quoteTokenProgram: TOKEN_PROGRAM_ID,
};

export function swapIx(a: PoolAddrs, trader: PublicKey, side: "sell" | "buy", amount: number, pass: PublicKey | null) {
  const amountIn = side === "sell" ? Math.round(amount * SHARE) : Math.round(amount * USD);
  const u = userAccounts(a, trader);
  return program.methods
    .swap(side === "sell" ? 0 : 1, bn(amountIn), bn(0))
    .accountsPartial({
      trader,
      pool: a.pool,
      baseMint: a.baseMint,
      quoteMint: a.quoteMint,
      baseVault: a.baseVault,
      quoteVault: a.quoteVault,
      traderBase: u.base,
      traderQuote: u.quote,
      // Optional account: null when the pool is not permissioned.
      traderPass: pass as any,
      ...tokenPrograms,
    })
    .instruction();
}

function liquidityAccounts(a: PoolAddrs, owner: PublicKey, pass: PublicKey | null) {
  const u = userAccounts(a, owner);
  return {
    owner,
    pool: a.pool,
    baseMint: a.baseMint,
    quoteMint: a.quoteMint,
    lpMint: a.lpMint,
    baseVault: a.baseVault,
    quoteVault: a.quoteVault,
    ownerBase: u.base,
    ownerQuote: u.quote,
    ownerLp: u.lp,
    traderPass: pass as any,
    ...tokenPrograms,
    lpTokenProgram: TOKEN_PROGRAM_ID,
  };
}

export function depositIx(a: PoolAddrs, owner: PublicKey, shares: number, usdc: number, pass: PublicKey | null) {
  return program.methods
    .deposit(bn(Math.round(shares * SHARE)), bn(Math.round(usdc * USD)), bn(0))
    .accountsPartial(liquidityAccounts(a, owner, pass))
    .instruction();
}

export function withdrawIx(a: PoolAddrs, owner: PublicKey, lpShares: number) {
  return program.methods
    .withdraw(bn(Math.floor(lpShares * USD)), bn(0), bn(0))
    .accountsPartial(liquidityAccounts(a, owner, null))
    .instruction();
}

export function updateMarketIx(a: PoolAddrs, keeper: PublicKey, status: Status, price: number, observedTs: number) {
  return program.methods
    .updateMarket({ [status]: {} }, bn(Math.round(price * USD)), bn(observedTs))
    .accountsPartial({ keeper, pool: a.pool, baseMint: a.baseMint, baseVault: a.baseVault, quoteVault: a.quoteVault })
    .instruction();
}

export function updateConfigIx(
  a: PoolAddrs,
  admin: PublicKey,
  params: Params,
  permissioned: boolean,
  dailyVolumeCapUsd: number,
) {
  return program.methods
    .updateConfig(params, admin, admin, permissioned, bn(Math.round(dailyVolumeCapUsd * USD)))
    .accountsPartial({ admin, pool: a.pool })
    .instruction();
}

export function issuePassIx(a: PoolAddrs, gatekeeper: PublicKey, trader: PublicKey, expiresAt: number) {
  return program.methods
    .issuePass(trader, bn(expiresAt))
    .accountsPartial({ gatekeeper, pool: a.pool, pass: passAddress(a.pool, trader) })
    .instruction();
}

export function revokePassIx(a: PoolAddrs, gatekeeper: PublicKey, trader: PublicKey) {
  return program.methods
    .revokePass()
    .accountsPartial({ gatekeeper, pool: a.pool, pass: passAddress(a.pool, trader) })
    .instruction();
}

export interface PoolState {
  params: Params;
  market: Market;
  reserves: Reserves;
  permissioned: boolean;
  dailyVolumeCap: number;
  volumeToday: number;
  lpSupply: number;
  multiplier: number;
  /** Whether `passFor`'s trader pass exists (false when no trader was given). */
  passExists: boolean;
}

const n = (v: any) => Number(v.toString());

function decodePool(data: Buffer): any {
  try {
    return program.coder.accounts.decode("pool", data);
  } catch {
    return program.coder.accounts.decode("Pool", data);
  }
}

/**
 * Read a pool, its vaults, LP supply, the stock's Scaled UI multiplier and optionally a
 * trader pass, all in one RPC request (public devnet endpoints rate-limit hard).
 */
export async function readPoolState(a: PoolAddrs, passFor?: PublicKey): Promise<PoolState | null> {
  const keys = [a.pool, a.baseVault, a.quoteVault, a.lpMint, a.baseMint];
  if (passFor) keys.push(passAddress(a.pool, passFor));
  const [poolInfo, baseInfo, quoteInfo, lpInfo, mintInfo, passInfo] = await connection.getMultipleAccountsInfo(keys);
  if (!poolInfo) return null;
  const acc = decodePool(poolInfo.data);
  const vault = (info: typeof baseInfo, key: PublicKey, programId: PublicKey) =>
    info ? Number(unpackAccount(key, info, programId).amount) : 0;
  const mint = mintInfo ? unpackMint(a.baseMint, mintInfo, TOKEN_2022_PROGRAM_ID) : null;
  const scaled = mint ? getScaledUiAmountConfig(mint) : null;
  let multiplier = 1;
  if (scaled) {
    multiplier = Date.now() / 1000 >= Number(scaled.newMultiplierEffectiveTimestamp) ? scaled.newMultiplier : scaled.multiplier;
  }
  const params = Object.fromEntries(Object.entries(acc.params).map(([k, v]) => [camel(k), n(v)])) as unknown as Params;
  const m = acc.market;
  const f = (o: any, k: string) => o[k] ?? o[snake(k)];
  return {
    params,
    market: {
      status: Object.keys(m.status)[0].toLowerCase() as Status,
      refPrice: n(f(m, "refPrice")) / USD,
      refTs: n(f(m, "refTs")),
      closeTs: n(f(m, "closeTs")),
      virtualBase: (n(f(m, "virtualBase")) / SHARE) * multiplier,
      virtualQuote: n(f(m, "virtualQuote")) / USD,
    },
    // Reserves in shares: raw units times the multiplier.
    reserves: {
      base: (vault(baseInfo, a.baseVault, TOKEN_2022_PROGRAM_ID) / SHARE) * multiplier,
      quote: vault(quoteInfo, a.quoteVault, TOKEN_PROGRAM_ID) / USD,
    },
    permissioned: acc.permissioned,
    dailyVolumeCap: n(f(acc, "dailyVolumeCap")) / USD,
    volumeToday: n(f(acc, "volumeToday")) / USD,
    lpSupply: lpInfo ? Number(unpackMint(a.lpMint, lpInfo, TOKEN_PROGRAM_ID).supply) / USD : 0,
    multiplier,
    passExists: !!passInfo,
  };
}

const camel = (k: string) => k.replace(/_([a-z])/g, (_, c) => c.toUpperCase());
const snake = (k: string) => k.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`);
