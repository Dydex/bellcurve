// Hand the test tokens' mint authority to a dedicated faucet key, so the public site only
// needs that key and never the admin key that controls the program and the pool.
//
// Usage: tsx src/faucet-authority.ts <faucet-public-key>

import { AuthorityType, TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID, createSetAuthorityInstruction } from "@solana/spl-token";
import { PublicKey, Transaction } from "@solana/web3.js";
import { makeProgram, readDeployment } from "./common.js";

const faucet = new PublicKey(process.argv[2] ?? "");
const program = makeProgram();
const provider = program.provider as any;
const admin = provider.wallet.publicKey as PublicKey;
const dep = readDeployment();

const tx = new Transaction().add(
  createSetAuthorityInstruction(new PublicKey(dep.baseMint), admin, AuthorityType.MintTokens, faucet, [], TOKEN_2022_PROGRAM_ID),
  createSetAuthorityInstruction(new PublicKey(dep.quoteMint), admin, AuthorityType.MintTokens, faucet, [], TOKEN_PROGRAM_ID),
);
const sig = await provider.sendAndConfirm(tx);
console.log(`mint authority of test ${dep.ticker} and USDC is now ${faucet.toBase58()}\n${sig}`);
