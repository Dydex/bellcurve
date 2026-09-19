// Creates a test stock (Token-2022 with the Scaled UI Amount extension, like xStocks),
// a test USDC, a Bellcurve pool, posts the current market state and seeds liquidity.
//
// Usage: pnpm setup:devnet [TICKER] [LIQUIDITY_USD]

import {
  ExtensionType,
  TOKEN_2022_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  createAssociatedTokenAccountIdempotentInstruction,
  createInitializeMint2Instruction,
  createInitializeScaledUiAmountConfigInstruction,
  createMintToInstruction,
  getAssociatedTokenAddressSync,
  getMintLen,
} from "@solana/spl-token";
import { Keypair, PublicKey, SystemProgram, Transaction } from "@solana/web3.js";
import {
  CLUSTER,
  SHARE,
  STOCK_DECIMALS,
  USD,
  USDC_DECIMALS,
  bn,
  calibration,
  lpMintPda,
  makeProgram,
  poolParams,
  poolPda,
  statusArg,
  writeDeployment,
} from "./common.js";
import { lastClose, latestPrint, session } from "./market.js";

const ticker = process.argv[2] ?? "NVDA";
const liquidityUsd = Number(process.argv[3] ?? 100_000);

const program = makeProgram();
const provider = program.provider as any;
const connection = provider.connection;
const admin: Keypair = provider.wallet.payer;

async function send(tx: Transaction, signers: Keypair[] = []) {
  return provider.sendAndConfirm(tx, signers);
}

async function createStockMint(): Promise<PublicKey> {
  const mint = Keypair.generate();
  const len = getMintLen([ExtensionType.ScaledUiAmountConfig]);
  const tx = new Transaction().add(
    SystemProgram.createAccount({
      fromPubkey: admin.publicKey,
      newAccountPubkey: mint.publicKey,
      space: len,
      lamports: await connection.getMinimumBalanceForRentExemption(len),
      programId: TOKEN_2022_PROGRAM_ID,
    }),
    createInitializeScaledUiAmountConfigInstruction(mint.publicKey, admin.publicKey, 1.0, TOKEN_2022_PROGRAM_ID),
    createInitializeMint2Instruction(mint.publicKey, STOCK_DECIMALS, admin.publicKey, null, TOKEN_2022_PROGRAM_ID),
  );
  await send(tx, [mint]);
  return mint.publicKey;
}

async function createUsdcMint(): Promise<PublicKey> {
  const mint = Keypair.generate();
  const len = getMintLen([]);
  const tx = new Transaction().add(
    SystemProgram.createAccount({
      fromPubkey: admin.publicKey,
      newAccountPubkey: mint.publicKey,
      space: len,
      lamports: await connection.getMinimumBalanceForRentExemption(len),
      programId: TOKEN_PROGRAM_ID,
    }),
    createInitializeMint2Instruction(mint.publicKey, USDC_DECIMALS, admin.publicKey, null, TOKEN_PROGRAM_ID),
  );
  await send(tx, [mint]);
  return mint.publicKey;
}

async function main() {
  console.log(`admin ${admin.publicKey.toBase58()} on ${CLUSTER}`);
  const baseMint = await createStockMint();
  const quoteMint = await createUsdcMint();
  console.log(`test ${ticker} (Token-2022) ${baseMint.toBase58()}\ntest USDC ${quoteMint.toBase58()}`);

  const pool = poolPda(program.programId, baseMint, quoteMint);
  const lpMint = lpMintPda(program.programId, pool);
  const baseVault = getAssociatedTokenAddressSync(baseMint, pool, true, TOKEN_2022_PROGRAM_ID);
  const quoteVault = getAssociatedTokenAddressSync(quoteMint, pool, true, TOKEN_PROGRAM_ID);
  const cal = calibration(ticker);

  await program.methods
    .initializePool(poolParams(cal.sigmaOpenBps, cal.sigmaClosedBps), admin.publicKey, admin.publicKey, false, bn(0))
    .accountsPartial({
      admin: admin.publicKey,
      pool,
      baseMint,
      quoteMint,
      lpMint,
      baseVault,
      quoteVault,
      baseTokenProgram: TOKEN_2022_PROGRAM_ID,
      quoteTokenProgram: TOKEN_PROGRAM_ID,
      lpTokenProgram: TOKEN_PROGRAM_ID,
    })
    .rpc();
  console.log(`pool ${pool.toBase58()} (sigma open ${cal.sigmaOpenBps} bps, closed ${cal.sigmaClosedBps} bps per sqrt hour)`);

  // Post the real market state.
  const print = await latestPrint(ticker);
  const closed = session(new Date()) === "closed";
  const observed = closed ? Math.floor(lastClose(new Date()).getTime() / 1000) : print.ts;
  await program.methods
    .updateMarket(statusArg(closed ? "closed" : "open"), bn(Math.round(print.price * USD)), bn(observed))
    .accountsPartial({ keeper: admin.publicKey, pool, baseMint, baseVault, quoteVault })
    .rpc();
  console.log(`market ${closed ? "closed" : "open"} at $${print.price.toFixed(2)}`);

  // Fund the admin and seed a balanced pool.
  const adminBase = getAssociatedTokenAddressSync(baseMint, admin.publicKey, false, TOKEN_2022_PROGRAM_ID);
  const adminQuote = getAssociatedTokenAddressSync(quoteMint, admin.publicKey, false, TOKEN_PROGRAM_ID);
  const adminLp = getAssociatedTokenAddressSync(lpMint, admin.publicKey, false, TOKEN_PROGRAM_ID);
  const shares = BigInt(Math.floor((liquidityUsd / 2 / print.price) * SHARE));
  await send(
    new Transaction().add(
      createAssociatedTokenAccountIdempotentInstruction(admin.publicKey, adminBase, admin.publicKey, baseMint, TOKEN_2022_PROGRAM_ID),
      createAssociatedTokenAccountIdempotentInstruction(admin.publicKey, adminQuote, admin.publicKey, quoteMint, TOKEN_PROGRAM_ID),
      createAssociatedTokenAccountIdempotentInstruction(admin.publicKey, adminLp, admin.publicKey, lpMint, TOKEN_PROGRAM_ID),
      createMintToInstruction(baseMint, adminBase, admin.publicKey, shares * 4n, [], TOKEN_2022_PROGRAM_ID),
      createMintToInstruction(quoteMint, adminQuote, admin.publicKey, BigInt(liquidityUsd * 2 * USD), [], TOKEN_PROGRAM_ID),
    ),
  );
  await program.methods
    .deposit(bn(shares), bn(Math.floor((liquidityUsd / 2) * USD)), bn(0))
    .accountsPartial({
      owner: admin.publicKey,
      pool,
      baseMint,
      quoteMint,
      lpMint,
      baseVault,
      quoteVault,
      ownerBase: adminBase,
      ownerQuote: adminQuote,
      ownerLp: adminLp,
      traderPass: null,
      baseTokenProgram: TOKEN_2022_PROGRAM_ID,
      quoteTokenProgram: TOKEN_PROGRAM_ID,
      lpTokenProgram: TOKEN_PROGRAM_ID,
    })
    .rpc();
  console.log(`seeded $${liquidityUsd.toLocaleString()} of liquidity`);

  writeDeployment({
    cluster: CLUSTER,
    ticker,
    programId: program.programId.toBase58(),
    pool: pool.toBase58(),
    baseMint: baseMint.toBase58(),
    quoteMint: quoteMint.toBase58(),
    lpMint: lpMint.toBase58(),
    baseVault: baseVault.toBase58(),
    quoteVault: quoteVault.toBase58(),
    admin: admin.publicKey.toBase58(),
  });
  console.log(`wrote deploy/${CLUSTER}.json`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
