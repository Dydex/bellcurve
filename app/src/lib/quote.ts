// Display-side port of the pool's quote (crates/bellcurve-math). Floats are fine here:
// the program's integer math is what executes trades.

export type Status = "open" | "closed" | "halted";

export interface Params {
  baseHalfSpreadBps: number;
  sigmaOpenBps: number;
  sigmaClosedBps: number;
  spreadZBps: number;
  maxHalfSpreadBps: number;
  inventorySkewBps: number;
  targetBaseWeightBps: number;
  impactBps: number;
  feeBps: number;
  bandOpenBps: number;
  bandClosedBps: number;
  minBaseWeightBps: number;
  maxBaseWeightBps: number;
  maxStalenessSecs: number;
}

export interface Market {
  status: Status;
  /** USD per share */
  refPrice: number;
  refTs: number;
  closeTs: number;
  /** shares */
  virtualBase: number;
  /** USD */
  virtualQuote: number;
}

export interface Reserves {
  /** shares */
  base: number;
  /** USD */
  quote: number;
}

/** base + z * sigma * sqrt(hours), capped. */
export function coneHalfSpreadBps(p: Params, hours: number, sigmaBps = p.sigmaClosedBps): number {
  const h = p.baseHalfSpreadBps + (p.spreadZBps / 1e4) * sigmaBps * Math.sqrt(Math.max(hours, 0));
  return Math.min(h, p.maxHalfSpreadBps);
}

export interface Quote {
  mid: number;
  bid: number;
  ask: number;
  halfSpreadBps: number;
  baseWeight: number;
  /** Hours since the last trusted price (open) or since the close (closed). */
  hours: number;
}

export interface Estimate {
  /** shares (buy) or USD (sell) */
  out: number;
  /** USD per share */
  price: number;
  vsRefBps: number;
  halfSpreadBps: number;
  /** Program error the trade would hit, if any. */
  refusal?: string;
}

/**
 * Preview of `swap` for the UI, mirroring bellcurve-math: linear impact while open,
 * x*y=k on the virtual reserves while closed, then the band and inventory checks.
 * `amount` is shares for a sell and USD for a buy.
 */
export function estimateSwap(p: Params, m: Market, r: Reserves, now: number, side: "sell" | "buy", amount: number): Estimate | null {
  if (!(amount > 0)) return null;
  const refuse = (refusal: string): Estimate => ({ out: 0, price: 0, vsRefBps: 0, halfSpreadBps: 0, refusal });
  if (m.status === "halted") return refuse("Halted");
  if (m.refPrice === 0) return refuse("NoPrice");
  if (m.status === "open" && now - m.refTs > p.maxStalenessSecs) return refuse("StalePrice");
  const q = quote(p, m, r, now);
  if (!q) return null;
  const fee = p.feeBps / 1e4;
  const h = q.halfSpreadBps / 1e4;
  const total = r.base * m.refPrice + r.quote;
  let out: number;
  let price: number;
  let after: Reserves;
  if (side === "sell") {
    let gross: number;
    if (m.status === "closed") {
      gross = ((m.virtualQuote * amount) / (m.virtualBase + amount)) * (1 - h);
    } else {
      const impact = ((p.impactBps / 1e4) * amount * q.bid) / total;
      gross = amount * q.bid * (1 - impact / 2);
    }
    price = gross / amount;
    out = gross * (1 - fee);
    after = { base: r.base + amount, quote: r.quote - out };
    if (out >= r.quote) return refuse("InsufficientLiquidity");
  } else {
    const net = amount * (1 - fee);
    if (m.status === "closed") {
      const dy = net * (1 - h);
      out = (m.virtualBase * dy) / (m.virtualQuote + dy);
    } else {
      const impact = ((p.impactBps / 1e4) * net) / total;
      out = net / (q.ask * (1 + impact / 2));
    }
    price = net / out;
    after = { base: r.base - out, quote: r.quote + amount };
    if (out >= r.base) return refuse("InsufficientLiquidity");
  }
  const band = m.status === "open" ? p.bandOpenBps : p.bandClosedBps;
  const vsRefBps = ((price - m.refPrice) / m.refPrice) * 1e4;
  if (Math.abs(vsRefBps) > band) return refuse("OutsideBand");
  const w = (after.base * m.refPrice) / (after.base * m.refPrice + after.quote);
  if (side === "sell" && w * 1e4 > p.maxBaseWeightBps) return refuse("InventoryLimit");
  if (side === "buy" && w * 1e4 < p.minBaseWeightBps) return refuse("InventoryLimit");
  return { out, price, vsRefBps, halfSpreadBps: q.halfSpreadBps };
}

/** Open market whose keeper price is older than the pool allows: the program refuses trades. */
export const isStale = (p: Params, m: Market, now: number) => m.status === "open" && now - m.refTs > p.maxStalenessSecs;

/** The pool's current quote, or null when the program would refuse to trade (halted, stale, no price). */
export function quote(p: Params, m: Market, r: Reserves, now: number): Quote | null {
  if (m.status === "halted" || m.refPrice === 0 || isStale(p, m, now)) return null;
  const total = r.base * m.refPrice + r.quote;
  const baseWeight = total > 0 ? (r.base * m.refPrice) / total : 0.5;
  if (m.status === "closed") {
    const hours = (now - m.closeTs) / 3600;
    const h = coneHalfSpreadBps(p, hours);
    const mid = m.virtualBase > 0 ? m.virtualQuote / m.virtualBase : m.refPrice;
    return { mid, bid: mid * (1 - h / 1e4), ask: mid * (1 + h / 1e4), halfSpreadBps: h, baseWeight, hours };
  }
  const hours = (now - m.refTs) / 3600;
  const h = coneHalfSpreadBps(p, hours, p.sigmaOpenBps);
  const target = p.targetBaseWeightBps / 1e4;
  const dev = baseWeight - target;
  const room = dev >= 0 ? 1 - target : target;
  const skew = room > 0 ? ((p.inventorySkewBps / 1e4) * dev) / room : 0;
  const mid = m.refPrice * (1 - skew);
  return { mid, bid: mid * (1 - h / 1e4), ask: mid * (1 + h / 1e4), halfSpreadBps: h, baseWeight, hours };
}
