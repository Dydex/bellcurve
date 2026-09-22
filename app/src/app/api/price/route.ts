import { latestPrice } from "@/lib/server";

let cached: { at: number; data: { price: number; ts: number } } | null = null;

export async function GET() {
  try {
    if (!cached || Date.now() - cached.at > 30_000) {
      cached = { at: Date.now(), data: await latestPrice("NVDA") };
    }
    return Response.json(cached.data);
  } catch (e: any) {
    return Response.json({ error: e.message ?? "price unavailable" }, { status: 502 });
  }
}
