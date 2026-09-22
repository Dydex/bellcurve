import { readPool, type PoolSnapshot } from "@/lib/pool";

// Public devnet RPC is rate limited; share one read across visitors for a few seconds.
let cached: { at: number; data: PoolSnapshot } | null = null;

export async function GET() {
  try {
    if (!cached || Date.now() - cached.at > 8_000) {
      cached = { at: Date.now(), data: await readPool() };
    }
    return Response.json(cached.data);
  } catch (e: any) {
    // Devnet hiccup: serve the last good snapshot rather than an error.
    if (cached) return Response.json(cached.data);
    return Response.json({ error: e.message ?? "failed to read pool" }, { status: 502 });
  }
}
