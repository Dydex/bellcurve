// US equity market clock and free public data sources for the keeper.
//
// Prices: Yahoo Finance chart API (pre, regular and post sessions).
// Halts:  Nasdaq Trader's public trading-halts RSS feed.
// A production keeper would read Pyth or Chainlink instead of Yahoo; the program
// does not care where prices come from, only that the keeper signs them.

export type Session = "pre" | "regular" | "post" | "closed";

// NYSE full-day closures.
const HOLIDAYS = new Set([
  "2026-01-01", "2026-01-19", "2026-02-16", "2026-04-03", "2026-05-25", "2026-06-19",
  "2026-07-03", "2026-09-07", "2026-11-26", "2026-12-25",
  "2027-01-01", "2027-01-18", "2027-02-15", "2027-03-26", "2027-05-31", "2027-06-18",
  "2027-07-05", "2027-09-06", "2027-11-25", "2027-12-24",
]);

const fmt = new Intl.DateTimeFormat("en-US", {
  timeZone: "America/New_York",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  weekday: "short",
  hourCycle: "h23",
});

function nyParts(d: Date) {
  const p = Object.fromEntries(fmt.formatToParts(d).map((x) => [x.type, x.value]));
  return {
    date: `${p.year}-${p.month}-${p.day}`,
    weekday: p.weekday as string,
    minutes: Number(p.hour) * 60 + Number(p.minute),
  };
}

export function isTradingDay(d: Date): boolean {
  const { date, weekday } = nyParts(d);
  return weekday !== "Sat" && weekday !== "Sun" && !HOLIDAYS.has(date);
}

/** Prices print from 04:00 to 20:00 New York time on trading days. */
export function session(d: Date): Session {
  if (!isTradingDay(d)) return "closed";
  const m = nyParts(d).minutes;
  if (m < 4 * 60 || m >= 20 * 60) return "closed";
  if (m < 9 * 60 + 30) return "pre";
  if (m < 16 * 60) return "regular";
  return "post";
}

/** The most recent moment prices stopped printing (20:00 NY on the last trading day). */
export function lastClose(d: Date): Date {
  const t = new Date(d);
  t.setUTCSeconds(0, 0);
  for (let i = 0; i < 60 * 24 * 7; i++) {
    const prev = new Date(t.getTime() - 60_000);
    if (session(prev) !== "closed" && session(t) === "closed") return t;
    t.setTime(prev.getTime());
  }
  throw new Error("no close found in the last week");
}

export interface Print {
  price: number;
  /** Unix seconds of the print. */
  ts: number;
}

/** Latest one-minute print including extended hours. */
export async function latestPrint(ticker: string): Promise<Print> {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${ticker}?range=5d&interval=1m&includePrePost=true`;
  const res = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0" } });
  if (!res.ok) throw new Error(`yahoo ${res.status}`);
  const body = await res.json();
  const r = body.chart.result[0];
  const ts: number[] = r.timestamp;
  const close: (number | null)[] = r.indicators.quote[0].close;
  for (let i = ts.length - 1; i >= 0; i--) {
    if (close[i] != null) {
      // A one-minute bar is stamped at its start; its close printed up to a minute later.
      return { price: close[i]!, ts: Math.min(ts[i] + 60, Math.floor(Date.now() / 1000)) };
    }
  }
  throw new Error(`no prints for ${ticker}`);
}

/** True when Nasdaq lists an open (not yet resumed) trading halt for `ticker`. */
export async function isHalted(ticker: string): Promise<boolean> {
  const res = await fetch("https://www.nasdaqtrader.com/rss.aspx?feed=tradehalts", {
    headers: { "User-Agent": "Mozilla/5.0" },
  });
  if (!res.ok) throw new Error(`nasdaq halts ${res.status}`);
  const xml = await res.text();
  for (const item of xml.split("<item>").slice(1)) {
    const symbol = item.match(/<ndaq:IssueSymbol>([^<]*)</)?.[1]?.trim();
    if (symbol !== ticker) continue;
    const resumed = item.match(/<ndaq:ResumptionTradeTime>([^<]*)</)?.[1]?.trim();
    if (!resumed) return true;
  }
  return false;
}
