// Keeper: tells the pool what the real stock market is doing.
//
// Every few seconds it decides the market status from the NYSE calendar and Nasdaq's halt
// feed, reads the latest print, and posts `update_market` when something changed:
//   open   -> fresh reference price (pre, regular and post sessions)
//   halted -> Nasdaq lists an unresolved halt for the symbol
//   closed -> no prices print; the close time drives the widening spread
//
// Usage: pnpm keeper [--once]
// Env: KEEPER_KEYPAIR (JSON byte array; defaults to the local wallet), KEEPER_RUN_SECS (exit after
// this long, so a scheduled CI job can hand over to the next one).

import { PublicKey } from "@solana/web3.js";
import { bn, keypairFromEnv, makeProgram, sendPolled, readDeployment, statusArg, type Status, USD } from "./common.js";
import { isHalted, lastClose, latestPrint, session } from "./market.js";

const INTERVAL_MS = Number(process.env.KEEPER_INTERVAL_MS ?? 15_000);
// Re-post an unchanged open price this often so it never goes stale on-chain.
const REFRESH_SECS = 60;
const RUN_SECS = Number(process.env.KEEPER_RUN_SECS ?? 0);

const program = makeProgram(keypairFromEnv("KEEPER_KEYPAIR"));
const dep = readDeployment();
const pool = new PublicKey(dep.pool);

async function tick() {
  const now = new Date();
  const state: any = await (program.account as any).pool.fetch(pool);
  const onchain: Status = Object.keys(state.market.status)[0] as Status;
  const refTs = Number(state.market.refTs);

  let status: Status;
  let price = 0;
  let observed: number;

  if (session(now) === "closed") {
    status = "closed";
    observed = Math.max(Math.floor(lastClose(now).getTime() / 1000), refTs);
    if (onchain === "closed") return log(`closed since ${new Date(Number(state.market.closeTs) * 1000).toISOString()}, nothing to do`);
    // Record the last print as the closing reference.
    const print = await latestPrint(dep.ticker);
    if (print.ts > refTs) price = Math.round(print.price * USD);
  } else {
    const print = await latestPrint(dep.ticker);
    const halted = await isHalted(dep.ticker).catch((e) => {
      log(`halt feed unavailable (${e.message}); assuming not halted`);
      return false;
    });
    status = halted ? "halted" : "open";
    observed = Math.max(print.ts, refTs);
    price = print.ts > refTs ? Math.round(print.price * USD) : 0;
    const age = Math.floor(now.getTime() / 1000) - refTs;
    if (status === onchain && price === 0 && age < REFRESH_SECS) return log(`${status}, price unchanged`);
    if (status === onchain && price === 0) {
      // Same print, but refresh the timestamp so the reference does not go stale.
      price = Number(state.market.refPrice);
      observed = Math.floor(now.getTime() / 1000);
    }
  }

  const ix = await program.methods
    .updateMarket(statusArg(status), bn(price), bn(observed))
    .accountsPartial({
      keeper: program.provider.publicKey!,
      pool,
      baseMint: new PublicKey(dep.baseMint),
      baseVault: new PublicKey(dep.baseVault),
      quoteVault: new PublicKey(dep.quoteVault),
    })
    .instruction();
  const sig = await sendPolled(program, ix);
  log(`${onchain} -> ${status} price=${price ? (price / USD).toFixed(2) : "kept"} observed=${new Date(observed * 1000).toISOString()} ${sig}`);
}

function log(msg: string) {
  console.log(`[${new Date().toISOString()}] ${dep.ticker} ${msg}`);
}

async function main() {
  log(`keeper ${program.provider.publicKey!.toBase58()} for pool ${pool.toBase58()} on ${dep.cluster}`);
  const stopAt = RUN_SECS ? Date.now() + RUN_SECS * 1000 : Infinity;
  do {
    try {
      await tick();
    } catch (e: any) {
      log(`error: ${e.message ?? e}`);
    }
    if (process.argv.includes("--once") || Date.now() >= stopAt) break;
    await new Promise((r) => setTimeout(r, INTERVAL_MS));
  } while (true);
}

main();
