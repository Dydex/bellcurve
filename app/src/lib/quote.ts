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

export function quote(p: Params, m: Market, r: Reserves, now: number): Quote | null {
  if (m.status === "halted" || m.refPrice === 0) return null;
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
