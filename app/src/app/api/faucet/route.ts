// Devnet faucet: SOL for fees plus test NVDA and USDC for the shared pool.
import {
  TOKEN_2022_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  createAssociatedTokenAccountIdempotentInstruction,
  createMintToInstruction,
  getAssociatedTokenAddressSync,
} from "@solana/spl-token";
import { LAMPORTS_PER_SOL, PublicKey, SystemProgram, Transaction, sendAndConfirmTransaction } from "@solana/web3.js";
import deployment from "@/data/deployment.json";
import { adminKeypair, connection } from "@/lib/server";

const SOL = 0.06; // fees plus rent for one sandbox pool
const SHARES = 5;
const USDC = 2_000;
const COOLDOWN_MS = 10 * 60_000;

const lastByWallet = new Map<string, number>();
const lastByIp = new Map<string, number>();

export async function POST(req: Request) {
  let wallet: PublicKey;
  try {
    wallet = new PublicKey((await req.json()).wallet);
  } catch {
    return Response.json({ error: "invalid wallet address" }, { status: 400 });
  }
  const ip = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? "local";
  const now = Date.now();
  const since = Math.min(now - (lastByWallet.get(wallet.toBase58()) ?? 0), now - (lastByIp.get(ip) ?? 0));
  if (since < COOLDOWN_MS) {
    return Response.json({ error: `faucet cooldown: try again in ${Math.ceil((COOLDOWN_MS - since) / 60_000)} min` }, { status: 429 });
  }

  try {
    const admin = adminKeypair();
    const base = new PublicKey(deployment.baseMint);
    const quote = new PublicKey(deployment.quoteMint);
    const lp = new PublicKey(deployment.lpMint);
    const userBase = getAssociatedTokenAddressSync(base, wallet, false, TOKEN_2022_PROGRAM_ID);
    const userQuote = getAssociatedTokenAddressSync(quote, wallet, false, TOKEN_PROGRAM_ID);
    const userLp = getAssociatedTokenAddressSync(lp, wallet, false, TOKEN_PROGRAM_ID);
    const tx = new Transaction().add(
      SystemProgram.transfer({ fromPubkey: admin.publicKey, toPubkey: wallet, lamports: SOL * LAMPORTS_PER_SOL }),
      createAssociatedTokenAccountIdempotentInstruction(admin.publicKey, userBase, wallet, base, TOKEN_2022_PROGRAM_ID),
      createAssociatedTokenAccountIdempotentInstruction(admin.publicKey, userQuote, wallet, quote, TOKEN_PROGRAM_ID),
      createAssociatedTokenAccountIdempotentInstruction(admin.publicKey, userLp, wallet, lp, TOKEN_PROGRAM_ID),
      createMintToInstruction(base, userBase, admin.publicKey, SHARES * 1e8, [], TOKEN_2022_PROGRAM_ID),
      createMintToInstruction(quote, userQuote, admin.publicKey, USDC * 1e6, [], TOKEN_PROGRAM_ID),
    );
    const signature = await sendAndConfirmTransaction(connection(), tx, [admin], { commitment: "confirmed" });
    lastByWallet.set(wallet.toBase58(), now);
    lastByIp.set(ip, now);
    return Response.json({ signature, sol: SOL, shares: SHARES, usdc: USDC });
  } catch (e: any) {
    return Response.json({ error: e.message ?? "faucet failed" }, { status: 500 });
  }
}
