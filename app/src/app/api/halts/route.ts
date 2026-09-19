// Nasdaq's public trading-halts feed, parsed server-side (the feed does not allow CORS).

export interface Halt {
  symbol: string;
  name: string;
  date: string;
  time: string;
  reason: string;
  resumed: string | null;
}

let cached: { at: number; data: Halt[] } | null = null;

const tag = (item: string, name: string) =>
  item.match(new RegExp(`<ndaq:${name}>([^<]*)</ndaq:${name}>`))?.[1]?.trim() || null;

export async function GET() {
  try {
    if (!cached || Date.now() - cached.at > 60_000) {
      const res = await fetch("https://www.nasdaqtrader.com/rss.aspx?feed=tradehalts", {
        headers: { "User-Agent": "Mozilla/5.0" },
      });
      if (!res.ok) throw new Error(`nasdaq ${res.status}`);
      const xml = await res.text();
      const data = xml
        .split("<item>")
        .slice(1)
        .map((item) => ({
          symbol: tag(item, "IssueSymbol") ?? "?",
          name: tag(item, "IssueName") ?? "",
          date: tag(item, "HaltDate") ?? "",
          time: (tag(item, "HaltTime") ?? "").slice(0, 8),
          reason: tag(item, "ReasonCode") ?? "",
          resumed: tag(item, "ResumptionTradeTime"),
        }));
      cached = { at: Date.now(), data };
    }
    return Response.json(cached.data);
  } catch (e: any) {
    return Response.json({ error: e.message ?? "failed to read halts" }, { status: 502 });
  }
}
