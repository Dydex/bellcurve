"use client";

// A private pool per visitor: they are its admin, keeper, gatekeeper and the stock's issuer.
import {
  ExtensionType,
  TOKEN_2022_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  createInitializeMint2Instruction,
  createInitializeScaledUiAmountConfigInstruction,
  createMintToInstruction,
  createUpdateMultiplierDataInstruction,
  getMintLen,
} from "@solana/spl-token";
import { Keypair, PublicKey, SystemProgram } from "@solana/web3.js";
import { depositIx, ensureAccountsIxs, poolAddrs, updateMarketIx, userAccounts, type PoolAddrs } from "./actions";
import type { Params } from "./quote";
import { SHARE, USD, bn, connection, program, send, type SendResult, type WalletSigner } from "./solana";

/**
 * The deployed NVDA parameters, but the closed-market volatility is scaled by sqrt(60) so a
 * minute of real time widens the spread like an hour does: a weekend plays out in an hour.
 * The keeper's price also goes stale after 30 s instead of 5 min, so the guard is easy to see.
 */
export const SANDBOX_PARAMS: Params = {
  baseHalfSpreadBps: 5,
  sigmaOpenBps: 106,
  sigmaClosedBps: Math.round(27 * Math.sqrt(60)),
  spreadZBps: 15_000,
  maxHalfSpreadBps: 1_500,
  inventorySkewBps: 10,
  targetBaseWeightBps: 5_000,
  impactBps: 20_000,
  feeBps: 5,
  bandOpenBps: 500,
  bandClosedBps: 2_000,
  minBaseWeightBps: 1_000,
  maxBaseWeightBps: 9_000,
  maxStalenessSecs: 30,
};

export const SEED_USD = 50_000;

export interface Sandbox {
  owner: string;
  baseMint: string;
  quoteMint: string;
  /** Cumulative split factor: the keeper posts the real price divided by this. */
  split: number;
}

const key = (owner: PublicKey) => `bellcurve-sandbox-${owner.toBase58()}`;

export function loadSandbox(owner: PublicKey): Sandbox | null {
  try {
    return JSON.parse(localStorage.getItem(key(owner)) ?? "null");
  } catch {
    return null;
  }
}

export function saveSandbox(s: Sandbox | null, owner: PublicKey) {
  try {
    if (s) localStorage.setItem(key(owner), JSON.stringify(s));
    else localStorage.removeItem(key(owner));
  } catch {}
}

export const sandboxAddrs = (s: Sandbox): PoolAddrs => poolAddrs(new PublicKey(s.baseMint), new PublicKey(s.quoteMint));

export async function realPrice(): Promise<number> {
  const res = await fetch("/api/price");
  const body = await res.json();
  if (!res.ok) throw new Error(body.error ?? "price unavailable");
  return body.price;
}

/** Four transactions: mints, pool, balances, then open the market and seed liquidity. */
export async function createSandbox(
  signer: WalletSigner,
  progress: (step: string) => void,
): Promise<{ sandbox?: Sandbox; result: SendResult }> {
  const owner = signer.publicKey;
  const stock = Keypair.generate();
  const usdc = Keypair.generate();
  const stockLen = getMintLen([ExtensionType.ScaledUiAmountConfig]);
  const usdcLen = getMintLen([]);

  progress("1/4 Creating your test stock (Token-2022, Scaled UI Amount) and test USDC");
  let r = await send(
    signer,
    [
      SystemProgram.createAccount({
        fromPubkey: owner,
        newAccountPubkey: stock.publicKey,
        space: stockLen,
        lamports: await connection.getMinimumBalanceForRentExemption(stockLen),
        programId: TOKEN_2022_PROGRAM_ID,
      }),
      createInitializeScaledUiAmountConfigInstruction(stock.publicKey, owner, 1.0, TOKEN_2022_PROGRAM_ID),
      createInitializeMint2Instruction(stock.publicKey, 8, owner, null, TOKEN_2022_PROGRAM_ID),
      SystemProgram.createAccount({
        fromPubkey: owner,
        newAccountPubkey: usdc.publicKey,
        space: usdcLen,
        lamports: await connection.getMinimumBalanceForRentExemption(usdcLen),
        programId: TOKEN_PROGRAM_ID,
      }),
      createInitializeMint2Instruction(usdc.publicKey, 6, owner, null, TOKEN_PROGRAM_ID),
    ],
    [stock, usdc],
  );
  if (!r.ok) return { result: r };

  const sandbox: Sandbox = { owner: owner.toBase58(), baseMint: stock.publicKey.toBase58(), quoteMint: usdc.publicKey.toBase58(), split: 1 };
  const a = sandboxAddrs(sandbox);

  progress("2/4 Creating your Bellcurve pool (you are admin, keeper and gatekeeper)");
  r = await send(signer, [
    await program.methods
      .initializePool(SANDBOX_PARAMS, owner, owner, false, bn(0))
      .accountsPartial({
        admin: owner,
        pool: a.pool,
        baseMint: a.baseMint,
        quoteMint: a.quoteMint,
        lpMint: a.lpMint,
        baseVault: a.baseVault,
        quoteVault: a.quoteVault,
        baseTokenProgram: TOKEN_2022_PROGRAM_ID,
        quoteTokenProgram: TOKEN_PROGRAM_ID,
        lpTokenProgram: TOKEN_PROGRAM_ID,
      })
      .instruction(),
  ]);
  if (!r.ok) return { result: r };

  const price = await realPrice();
  const shares = SEED_USD / 2 / price;
  const u = userAccounts(a, owner);
  progress("3/4 Minting yourself test stock and USDC");
  r = await send(signer, [
    ...ensureAccountsIxs(a, owner),
    createMintToInstruction(a.baseMint, u.base, owner, BigInt(Math.round(shares * 3 * SHARE)), [], TOKEN_2022_PROGRAM_ID),
    createMintToInstruction(a.quoteMint, u.quote, owner, BigInt(SEED_USD * 3 * USD), [], TOKEN_PROGRAM_ID),
  ]);
  if (!r.ok) return { result: r };

  progress(`4/4 Opening the market at the real NVDA price ($${price.toFixed(2)}) and seeding $${SEED_USD.toLocaleString()}`);
  r = await send(signer, [
    await updateMarketIx(a, owner, "open", price, Math.floor(Date.now() / 1000)),
    await depositIx(a, owner, shares, SEED_USD / 2, null),
  ]);
  if (!r.ok) return { result: r };
  saveSandbox(sandbox, owner);
  return { sandbox, result: { ...r, message: "Your sandbox pool is live on devnet." } };
}

/** Issuer action: change the Scaled UI Amount multiplier, effective now. */
export function multiplierIx(s: Sandbox, owner: PublicKey, multiplier: number) {
  return createUpdateMultiplierDataInstruction(
    new PublicKey(s.baseMint),
    owner,
    multiplier,
    BigInt(Math.floor(Date.now() / 1000)),
    [],
    TOKEN_2022_PROGRAM_ID,
  );
}
