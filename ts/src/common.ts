import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { AnchorProvider, BN, Program, Wallet } from "@anchor-lang/core";
import { Connection, Keypair, PublicKey, Transaction, type TransactionInstruction } from "@solana/web3.js";

export const ROOT = path.resolve(import.meta.dirname, "../..");
export const RPC_URL = process.env.RPC_URL ?? "https://api.devnet.solana.com";
export const CLUSTER = process.env.CLUSTER ?? (RPC_URL.includes("devnet") ? "devnet" : "localnet");

export const USD = 1_000_000;
export const SHARE = 100_000_000;
export const STOCK_DECIMALS = 8;
export const USDC_DECIMALS = 6;

export function loadKeypair(file = process.env.WALLET ?? path.join(os.homedir(), ".config/solana/id.json")): Keypair {
  return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(file, "utf8"))));
}

/** A key passed as a JSON byte array in an env var (for servers), else the local wallet file. */
export function keypairFromEnv(name: string): Keypair {
  const raw = process.env[name];
  return raw ? Keypair.fromSecretKey(Uint8Array.from(JSON.parse(raw))) : loadKeypair();
}

export function makeProgram(wallet = loadKeypair()) {
  // Fresh build output when present, else the copy committed for the web app.
  const built = path.join(ROOT, "target/idl/bellcurve.json");
  const idlFile = fs.existsSync(built) ? built : path.join(ROOT, "app/src/idl/bellcurve.json");
  const idl = JSON.parse(fs.readFileSync(idlFile, "utf8"));
  const connection = new Connection(RPC_URL, "confirmed");
  const provider = new AnchorProvider(connection, new Wallet(wallet), { commitment: "confirmed" });
  return new Program(idl, provider);
}

/**
 * Send and confirm by polling the status over plain HTTP. Anchor's .rpc() waits for a
 * websocket notification instead, which some RPC providers (Alchemy on Solana) never deliver.
 */
export async function sendPolled(program: Program, ix: TransactionInstruction): Promise<string> {
  const provider = program.provider as AnchorProvider;
  const { connection, wallet } = provider;
  const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash("confirmed");
  const tx = await wallet.signTransaction(new Transaction({ feePayer: wallet.publicKey, blockhash, lastValidBlockHeight }).add(ix));
  const signature = await connection.sendRawTransaction(tx.serialize(), { preflightCommitment: "confirmed" });
  for (;;) {
    const status = (await connection.getSignatureStatuses([signature])).value[0];
    if (status?.confirmationStatus === "confirmed" || status?.confirmationStatus === "finalized") {
      if (status.err) throw new Error(`transaction ${signature} failed: ${JSON.stringify(status.err)}`);
      return signature;
    }
    if ((await connection.getBlockHeight("confirmed")) > lastValidBlockHeight) throw new Error(`transaction ${signature} expired`);
    await new Promise((r) => setTimeout(r, 1000));
  }
}

export interface Deployment {
  cluster: string;
  ticker: string;
  programId: string;
  pool: string;
  baseMint: string;
  quoteMint: string;
  lpMint: string;
  baseVault: string;
  quoteVault: string;
  admin: string;
}

const deploymentFile = () => path.join(ROOT, "deploy", `${CLUSTER}.json`);

export function readDeployment(): Deployment {
  return JSON.parse(fs.readFileSync(deploymentFile(), "utf8"));
}

export function writeDeployment(d: Deployment) {
  fs.mkdirSync(path.dirname(deploymentFile()), { recursive: true });
  fs.writeFileSync(deploymentFile(), JSON.stringify(d, null, 2) + "\n");
}

export function poolPda(programId: PublicKey, base: PublicKey, quote: PublicKey) {
  return PublicKey.findProgramAddressSync([Buffer.from("pool"), base.toBuffer(), quote.toBuffer()], programId)[0];
}

export function lpMintPda(programId: PublicKey, pool: PublicKey) {
  return PublicKey.findProgramAddressSync([Buffer.from("lp"), pool.toBuffer()], programId)[0];
}

export function passPda(programId: PublicKey, pool: PublicKey, trader: PublicKey) {
  return PublicKey.findProgramAddressSync([Buffer.from("pass"), pool.toBuffer(), trader.toBuffer()], programId)[0];
}

/** Pricing parameters. Volatilities are calibrated per stock from 3 years of hourly data by the backtest. */
export function poolParams(sigmaOpenBps: number, sigmaClosedBps: number) {
  return {
    baseHalfSpreadBps: 5,
    sigmaOpenBps,
    sigmaClosedBps,
    // 1.5 sigma: at 1 sigma about a third of weekends would move past the quote.
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
    // Yahoo prints once a minute; a production keeper on Pyth or Chainlink can use seconds.
    maxStalenessSecs: 300,
  };
}

/** Per-ticker volatility calibration written by the backtest, if it has been run. */
export function calibration(ticker: string): { sigmaOpenBps: number; sigmaClosedBps: number } {
  const file = path.join(ROOT, "results/backtest.json");
  if (fs.existsSync(file)) {
    const t = JSON.parse(fs.readFileSync(file, "utf8")).tickers.find((x: any) => x.ticker === ticker);
    if (t) return { sigmaOpenBps: Math.round(t.sigma_open_bps), sigmaClosedBps: Math.round(t.sigma_closed_bps) };
  }
  return { sigmaOpenBps: 100, sigmaClosedBps: 60 };
}

export const bn = (n: number | bigint) => new BN(n.toString());

export type Status = "open" | "closed" | "halted";
export const statusArg = (s: Status) => ({ [s]: {} });
