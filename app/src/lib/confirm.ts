// Confirm a transaction by polling its status over plain HTTP. web3.js waits for a websocket
// notification instead, which some RPC providers (Alchemy on Solana) never deliver.
import type { Connection, TransactionError } from "@solana/web3.js";

export async function confirmByPolling(
  connection: Connection,
  signature: string,
  lastValidBlockHeight: number,
): Promise<{ err: TransactionError | null }> {
  for (;;) {
    const { value } = await connection.getSignatureStatuses([signature]);
    const status = value[0];
    if (status?.confirmationStatus === "confirmed" || status?.confirmationStatus === "finalized") {
      return { err: status.err };
    }
    if ((await connection.getBlockHeight("confirmed")) > lastValidBlockHeight) {
      throw new Error(`Signature ${signature} has expired: block height exceeded.`);
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
}
