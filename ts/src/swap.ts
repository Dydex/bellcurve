// Swap against the deployed pool with the local wallet.
//
// Usage: tsx src/swap.ts sell <shares> | buy <usdc>

import { TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID, getAssociatedTokenAddressSync } from "@solana/spl-token";
import { PublicKey } from "@solana/web3.js";
import { SHARE, USD, bn, makeProgram, readDeployment } from "./common.js";

const [sideArg, amountArg] = process.argv.slice(2);
if (!["sell", "buy"].includes(sideArg) || !amountArg) {
  console.error("usage: tsx src/swap.ts sell <shares> | buy <usdc>");
  process.exit(1);
}

const program = makeProgram();
const dep = readDeployment();
const trader = program.provider.publicKey!;
const baseMint = new PublicKey(dep.baseMint);
const quoteMint = new PublicKey(dep.quoteMint);
const traderBase = getAssociatedTokenAddressSync(baseMint, trader, false, TOKEN_2022_PROGRAM_ID);
const traderQuote = getAssociatedTokenAddressSync(quoteMint, trader, false, TOKEN_PROGRAM_ID);
const connection = program.provider.connection;

async function balances() {
  const [b, q] = await Promise.all([
    connection.getTokenAccountBalance(traderBase),
    connection.getTokenAccountBalance(traderQuote),
  ]);
  return { base: Number(b.value.amount), quote: Number(q.value.amount) };
}

async function main() {
  const sell = sideArg === "sell";
  const amountIn = sell ? Math.round(Number(amountArg) * SHARE) : Math.round(Number(amountArg) * USD);
  const before = await balances();
  const sig = await program.methods
    .swap(sell ? 0 : 1, bn(amountIn), bn(0))
    .accountsPartial({
      trader,
      pool: new PublicKey(dep.pool),
      baseMint,
      quoteMint,
      baseVault: new PublicKey(dep.baseVault),
      quoteVault: new PublicKey(dep.quoteVault),
      traderBase,
      traderQuote,
      traderPass: null,
      baseTokenProgram: TOKEN_2022_PROGRAM_ID,
      quoteTokenProgram: TOKEN_PROGRAM_ID,
    })
    .rpc();
  const after = await balances();
  const pool: any = await (program.account as any).pool.fetch(new PublicKey(dep.pool));
  const ref = Number(pool.market.refPrice) / USD;
  if (sell) {
    const got = (after.quote - before.quote) / USD;
    const price = got / Number(amountArg);
    console.log(`sold ${amountArg} ${dep.ticker} for $${got.toFixed(2)} ($${price.toFixed(2)}/share, ${(((price - ref) / ref) * 1e4).toFixed(0)} bps vs reference $${ref.toFixed(2)})`);
  } else {
    const got = (after.base - before.base) / SHARE;
    const price = Number(amountArg) / got;
    console.log(`bought ${got.toFixed(6)} ${dep.ticker} for $${amountArg} ($${price.toFixed(2)}/share, ${(((price - ref) / ref) * 1e4).toFixed(0)} bps vs reference $${ref.toFixed(2)})`);
  }
  console.log(`market ${Object.keys(pool.market.status)[0]}, tx https://explorer.solana.com/tx/${sig}?cluster=devnet`);
}

main().catch((e) => {
  console.error(e.message ?? e);
  process.exit(1);
});
