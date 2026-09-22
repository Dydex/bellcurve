// Hand the keeper role to a dedicated key, so the always-on keeper server only holds a key
// that can post market updates and never the admin key. Other pool settings stay as they are.
//
// Usage: tsx src/set-keeper.ts <keeper-public-key>

import { PublicKey } from "@solana/web3.js";
import { makeProgram, readDeployment } from "./common.js";

const keeper = new PublicKey(process.argv[2] ?? "");
const program = makeProgram();
const dep = readDeployment();
const pool = new PublicKey(dep.pool);

const state: any = await (program.account as any).pool.fetch(pool);
const sig = await program.methods
  .updateConfig(state.params, keeper, state.gatekeeper, state.permissioned, state.dailyVolumeCap)
  .accountsPartial({ admin: program.provider.publicKey!, pool })
  .rpc();
console.log(`keeper of the ${dep.ticker} pool is now ${keeper.toBase58()}\n${sig}`);
