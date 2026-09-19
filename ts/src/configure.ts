// Push the current pool parameters (see poolParams in common.ts) to the deployed pool.
//
// Usage: tsx src/configure.ts

import { PublicKey } from "@solana/web3.js";
import { bn, calibration, makeProgram, poolParams, readDeployment } from "./common.js";

const program = makeProgram();
const dep = readDeployment();
const pool = new PublicKey(dep.pool);

async function main() {
  const state: any = await (program.account as any).pool.fetch(pool);
  const cal = calibration(dep.ticker);
  const params = poolParams(cal.sigmaOpenBps, cal.sigmaClosedBps);
  const sig = await program.methods
    .updateConfig(params, state.keeper, state.gatekeeper, state.permissioned, state.dailyVolumeCap)
    .accountsPartial({ admin: program.provider.publicKey!, pool })
    .rpc();
  console.log(`updated ${dep.ticker} pool parameters: ${JSON.stringify(params)}\n${sig}`);
}

main().catch((e) => {
  console.error(e.message ?? e);
  process.exit(1);
});
