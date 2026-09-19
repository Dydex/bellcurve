//! Bellcurve pricing math.
//!
//! A tokenized-stock pool that knows the stock market's schedule.
//!
//! - Open: the stock exchange discovers the price, so the pool quotes tightly around
//!   the keeper's fresh reference price (a small inventory skew keeps it balanced).
//! - Closed: nobody discovers the price but the pool itself, so trades move along
//!   `x * y = k` on virtual reserves that start at the closing price, and the spread
//!   widens with `sigma * sqrt(time since close)` to cover the uncertainty.
//! - Halted: no trading.
//!
//! Everything is integer arithmetic so the on-chain program and the off-chain
//! backtester produce identical numbers.
//!
//! Units:
//! - prices are quote base-units per whole share (USDC with 6 decimals: 1_000_000 = $1)
//! - base amounts are raw token units; `BaseToken` converts them to shares using the
//!   mint decimals and the Token-2022 Scaled UI Amount multiplier (splits, dividends)
//! - rates are basis points (10_000 = 100%)

#![cfg_attr(not(test), no_std)]

pub const BPS: u128 = 10_000;
pub const MULTIPLIER_ONE: u64 = 1_000_000_000;
const SECS_PER_HOUR_SQRT: u128 = 60;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum MarketState {
    Open,
    Closed,
    Halted,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum MathError {
    Halted,
    StalePrice,
    NoPrice,
    OutsideBand,
    InventoryLimit,
    InsufficientLiquidity,
    ZeroAmount,
    EmptyPool,
    Overflow,
    InvalidParams,
}

pub type Result<T> = core::result::Result<T, MathError>;

/// Pool configuration. All rates in basis points.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Params {
    /// Minimum half-spread charged at all times.
    pub base_half_spread_bps: u32,
    /// Volatility per sqrt(hour) applied to reference-price staleness while open.
    pub sigma_open_bps: u32,
    /// Volatility per sqrt(hour) applied to time since the close while closed.
    pub sigma_closed_bps: u32,
    /// Confidence multiplier on the volatility term (10_000 = 1.0 sigma).
    pub spread_z_bps: u32,
    /// Upper bound on the half-spread.
    pub max_half_spread_bps: u32,
    /// Mid-price skew at maximum inventory imbalance while the market is open.
    pub inventory_skew_bps: u32,
    /// Base-value weight the pool tries to hold.
    pub target_base_weight_bps: u32,
    /// Price impact of a trade worth 100% of pool value.
    pub impact_bps: u32,
    pub fee_bps: u32,
    /// Max distance of an execution price from the reference while open (LULD-style band).
    pub band_open_bps: u32,
    /// Max distance of an execution price from the reference while closed.
    pub band_closed_bps: u32,
    /// Trades may not push the base weight outside [min, max].
    pub min_base_weight_bps: u32,
    pub max_base_weight_bps: u32,
    /// While open, a reference price older than this is refused.
    pub max_staleness_secs: u32,
}

impl Params {
    pub fn validate(&self) -> Result<()> {
        let bps = BPS as u32;
        let ok = self.base_half_spread_bps <= self.max_half_spread_bps
            && self.max_half_spread_bps < bps
            && self.fee_bps < bps
            && self.inventory_skew_bps < bps
            && self.band_open_bps < bps
            && self.band_closed_bps < bps
            && self.min_base_weight_bps < self.target_base_weight_bps
            && self.target_base_weight_bps < self.max_base_weight_bps
            && self.max_base_weight_bps <= bps
            && self.max_staleness_secs > 0;
        if ok {
            Ok(())
        } else {
            Err(MathError::InvalidParams)
        }
    }
}

/// What the keeper has told the pool about the underlying market.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Market {
    pub state: MarketState,
    /// Last trusted price of one share, in quote units.
    pub ref_price: u64,
    /// When `ref_price` was observed.
    pub ref_ts: i64,
    /// When the underlying market last closed.
    pub close_ts: i64,
    /// Virtual constant-product reserves that price trades while the market is closed
    /// (raw base units and quote units). Set at the close to a balanced pool worth the
    /// same as the real one at the closing price; every closed-hours trade moves them.
    pub virtual_base: u64,
    pub virtual_quote: u64,
}

/// Converts raw base-token units to shares: `shares = raw * multiplier / 10^decimals`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct BaseToken {
    pub decimals: u8,
    /// Scaled UI Amount multiplier, 1e9 = 1.0.
    pub multiplier_e9: u64,
}

impl BaseToken {
    fn scale(&self) -> Result<u128> {
        10u128
            .checked_pow(self.decimals as u32)
            .and_then(|d| d.checked_mul(MULTIPLIER_ONE as u128))
            .ok_or(MathError::Overflow)
    }

    /// Quote value of `raw` base units at `price`, rounded down.
    pub fn value(&self, raw: u64, price: u64) -> Result<u128> {
        let scale = self.scale()?;
        (raw as u128)
            .checked_mul(self.multiplier_e9 as u128)
            .and_then(|v| v.checked_mul(price as u128))
            .map(|v| v / scale)
            .ok_or(MathError::Overflow)
    }

    /// Raw base units worth `value` at `price`, rounded down.
    pub fn raw_for_value(&self, value: u128, price: u64) -> Result<u64> {
        let denom = (self.multiplier_e9 as u128)
            .checked_mul(price as u128)
            .ok_or(MathError::Overflow)?;
        if denom == 0 {
            return Err(MathError::NoPrice);
        }
        let raw = value.checked_mul(self.scale()?).ok_or(MathError::Overflow)? / denom;
        u64::try_from(raw).map_err(|_| MathError::Overflow)
    }

    /// Price per share implied by `value` quote units for `raw` base units, rounded down.
    pub fn price_of(&self, raw: u64, value: u128) -> Result<u128> {
        let denom = (raw as u128)
            .checked_mul(self.multiplier_e9 as u128)
            .ok_or(MathError::Overflow)?;
        if denom == 0 {
            return Err(MathError::NoPrice);
        }
        Ok(value.checked_mul(self.scale()?).ok_or(MathError::Overflow)? / denom)
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Reserves {
    pub base: u64,
    pub quote: u64,
}

/// The pool's current two-sided quote.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Quote {
    pub mid: u64,
    pub bid: u64,
    pub ask: u64,
    pub half_spread_bps: u32,
    /// How far the mid sits below the reference price: inventory skew while open,
    /// price discovered by the virtual curve while closed.
    pub skew_bps: i32,
    pub base_weight_bps: u32,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Side {
    /// Trader pays base, receives quote.
    SellBase,
    /// Trader pays quote, receives base.
    BuyBase,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct SwapResult {
    pub amount_out: u64,
    /// Fee kept by the pool, in quote units.
    pub fee: u64,
    pub exec_price: u64,
    pub impact_bps: u32,
    pub quote: Quote,
    pub reserves_after: Reserves,
    /// Virtual reserves after the trade (unchanged while the market is open).
    pub virtual_after: (u64, u64),
}

pub fn isqrt(n: u128) -> u128 {
    if n < 2 {
        return n;
    }
    let mut x = 1u128 << ((128 - n.leading_zeros()).div_ceil(2));
    loop {
        let y = (x + n / x) / 2;
        if y >= x {
            return x;
        }
        x = y;
    }
}

fn mul_div(a: u128, b: u128, d: u128) -> Result<u128> {
    if d == 0 {
        return Err(MathError::Overflow);
    }
    a.checked_mul(b).map(|v| v / d).ok_or(MathError::Overflow)
}

fn mul_div_up(a: u128, b: u128, d: u128) -> Result<u128> {
    if d == 0 {
        return Err(MathError::Overflow);
    }
    a.checked_mul(b)
        .map(|v| v.div_ceil(d))
        .ok_or(MathError::Overflow)
}

fn to_u64(v: u128) -> Result<u64> {
    u64::try_from(v).map_err(|_| MathError::Overflow)
}

/// Half-spread for the current market state:
/// `base + z * sigma * sqrt(hours since the last trusted price)`, capped.
pub fn half_spread_bps(p: &Params, m: &Market, now: i64) -> Result<u32> {
    if m.ref_price == 0 {
        return Err(MathError::NoPrice);
    }
    let (tau, sigma) = match m.state {
        MarketState::Halted => return Err(MathError::Halted),
        MarketState::Open => {
            let tau = now.saturating_sub(m.ref_ts).max(0) as u128;
            if tau > p.max_staleness_secs as u128 {
                return Err(MathError::StalePrice);
            }
            (tau, p.sigma_open_bps)
        }
        MarketState::Closed => (now.saturating_sub(m.close_ts).max(0) as u128, p.sigma_closed_bps),
    };
    // sqrt(tau / 3600) = sqrt(tau) / 60, and isqrt(tau * 1e8) = sqrt(tau) * 1e4.
    let sqrt_tau_e4 = isqrt(tau.checked_mul(100_000_000).ok_or(MathError::Overflow)?);
    let vol_term = (sigma as u128)
        .checked_mul(p.spread_z_bps as u128)
        .and_then(|v| v.checked_mul(sqrt_tau_e4))
        .ok_or(MathError::Overflow)?
        / (BPS * BPS * SECS_PER_HOUR_SQRT);
    let h = (p.base_half_spread_bps as u128 + vol_term).min(p.max_half_spread_bps as u128);
    Ok(h as u32)
}

/// Share of pool value held in base, valued at `price`.
pub fn base_weight_bps(tok: &BaseToken, r: &Reserves, price: u64) -> Result<u32> {
    let base_value = tok.value(r.base, price)?;
    let total = base_value + r.quote as u128;
    if total == 0 {
        return Err(MathError::EmptyPool);
    }
    Ok(mul_div(base_value, BPS, total)? as u32)
}

/// Mid-price skew while open: scales linearly from 0 at the target weight to
/// `inventory_skew_bps` at an all-base (or all-quote) pool.
pub fn skew_bps(p: &Params, weight_bps: u32) -> i32 {
    let target = p.target_base_weight_bps as i64;
    let dev = weight_bps as i64 - target;
    let room = if dev >= 0 { BPS as i64 - target } else { target };
    if room == 0 {
        return 0;
    }
    (p.inventory_skew_bps as i64 * dev / room) as i32
}

pub fn band_bps(p: &Params, state: MarketState) -> u32 {
    match state {
        MarketState::Open => p.band_open_bps,
        _ => p.band_closed_bps,
    }
}

/// Balanced virtual reserves worth the pool's value at the closing price. Set at the close,
/// they start the closed-market curve exactly at the closing price, so the mid is continuous.
pub fn virtual_reserves_at_close(tok: &BaseToken, r: &Reserves, price: u64) -> Result<(u64, u64)> {
    let half = pool_value(tok, r, price)? / 2;
    Ok((tok.raw_for_value(half, price)?, to_u64(half)?))
}

/// Mid price while the market is closed: the marginal price of the virtual constant-product
/// pool. Selling stock into the pool lowers it and buying raises it, so the pool discovers
/// the price while no exchange does.
pub fn closed_mid(tok: &BaseToken, m: &Market) -> Result<u128> {
    if m.virtual_base == 0 || m.virtual_quote == 0 {
        return Err(MathError::NoPrice);
    }
    tok.price_of(m.virtual_base, m.virtual_quote as u128)
}

pub fn quote(p: &Params, m: &Market, tok: &BaseToken, r: &Reserves, now: i64) -> Result<Quote> {
    let h = half_spread_bps(p, m, now)?;
    let weight = base_weight_bps(tok, r, m.ref_price)?;
    let price = m.ref_price as u128;
    let mid = match m.state {
        MarketState::Closed => closed_mid(tok, m)?,
        _ => mul_div(price, (BPS as i128 - skew_bps(p, weight) as i128) as u128, BPS)?,
    };
    // Report how far the mid sits below the reference, whichever rule set it.
    let skew = ((price as i128 - mid as i128) * BPS as i128 / price as i128) as i32;
    let bid = mul_div(mid, BPS - h as u128, BPS)?;
    let ask = mul_div_up(mid, BPS + h as u128, BPS)?;
    Ok(Quote {
        mid: to_u64(mid)?,
        bid: to_u64(bid)?,
        ask: to_u64(ask)?,
        half_spread_bps: h,
        skew_bps: skew,
        base_weight_bps: weight,
    })
}

pub fn pool_value(tok: &BaseToken, r: &Reserves, price: u64) -> Result<u128> {
    Ok(tok.value(r.base, price)? + r.quote as u128)
}

/// Execute an exact-input swap.
///
/// Open market: the trade fills at the bid (or ask) moved by linear price impact
/// `impact_bps * trade_value / pool_value`, averaged over the trade.
/// Closed market: the trade moves along `x * y = k` on the virtual reserves, then pays the
/// uncertainty spread; the virtual reserves carry the discovered price to the next trade.
///
/// Either way the trade is refused if it fills outside the price band around the reference
/// (in both directions) or pushes inventory past its limits.
pub fn swap(
    p: &Params,
    m: &Market,
    tok: &BaseToken,
    r: &Reserves,
    now: i64,
    side: Side,
    amount_in: u64,
) -> Result<SwapResult> {
    if amount_in == 0 {
        return Err(MathError::ZeroAmount);
    }
    let q = quote(p, m, tok, r, now)?;
    let total = pool_value(tok, r, m.ref_price)?;
    if total == 0 {
        return Err(MathError::EmptyPool);
    }
    let price = m.ref_price as u128;
    let band = mul_div(price, band_bps(p, m.state) as u128, BPS)?;
    let h = q.half_spread_bps as u128;
    let closed = m.state == MarketState::Closed;
    let (vb, vq) = (m.virtual_base as u128, m.virtual_quote as u128);
    let unchanged = (m.virtual_base, m.virtual_quote);

    let (amount_out, fee, exec, impact, after, virtual_after) = match side {
        Side::SellBase => {
            // Quote value of the trade before the fee.
            let (gross, virtual_after) = if closed {
                let dx = amount_in as u128;
                let curve = mul_div(vq, dx, vb + dx)?;
                (mul_div(curve, BPS - h, BPS)?, (to_u64(vb + dx)?, to_u64(vq - curve)?))
            } else {
                let trade_value = tok.value(amount_in, q.bid)?;
                let impact = mul_div(p.impact_bps as u128, trade_value, total)?;
                if impact >= 2 * BPS {
                    return Err(MathError::InsufficientLiquidity);
                }
                let exec = mul_div(q.bid as u128, 2 * BPS - impact, 2 * BPS)?;
                (tok.value(amount_in, to_u64(exec)?)?, unchanged)
            };
            let exec = tok.price_of(amount_in, gross)?;
            if price.abs_diff(exec) > band {
                return Err(MathError::OutsideBand);
            }
            let fee = mul_div_up(gross, p.fee_bps as u128, BPS)?;
            let out = gross.saturating_sub(fee);
            if out >= r.quote as u128 {
                return Err(MathError::InsufficientLiquidity);
            }
            let after = Reserves {
                base: r.base.checked_add(amount_in).ok_or(MathError::Overflow)?,
                quote: r.quote - out as u64,
            };
            if base_weight_bps(tok, &after, m.ref_price)? > p.max_base_weight_bps {
                return Err(MathError::InventoryLimit);
            }
            let impact = mul_div((q.bid as u128).saturating_sub(exec), BPS, (q.bid as u128).max(1))?;
            (to_u64(out)?, to_u64(fee)?, exec, impact, after, virtual_after)
        }
        Side::BuyBase => {
            let fee = mul_div_up(amount_in as u128, p.fee_bps as u128, BPS)?;
            let net = amount_in as u128 - fee;
            let (out, virtual_after) = if closed {
                let dy = mul_div(net, BPS - h, BPS)?;
                let curve = mul_div(vb, dy, vq + dy)?;
                (to_u64(curve)?, (to_u64(vb - curve)?, to_u64(vq + dy)?))
            } else {
                let impact = mul_div(p.impact_bps as u128, net, total)?;
                let exec = mul_div_up(q.ask as u128, 2 * BPS + impact, 2 * BPS)?;
                (tok.raw_for_value(net, to_u64(exec)?)?, unchanged)
            };
            if out == 0 {
                return Err(MathError::ZeroAmount);
            }
            let exec = tok.price_of(out, net)?;
            if price.abs_diff(exec) > band {
                return Err(MathError::OutsideBand);
            }
            if out >= r.base {
                return Err(MathError::InsufficientLiquidity);
            }
            let after = Reserves {
                base: r.base - out,
                quote: r.quote.checked_add(amount_in).ok_or(MathError::Overflow)?,
            };
            if base_weight_bps(tok, &after, m.ref_price)? < p.min_base_weight_bps {
                return Err(MathError::InventoryLimit);
            }
            let impact = mul_div(exec.saturating_sub(q.ask as u128), BPS, (q.ask as u128).max(1))?;
            (out, to_u64(fee)?, exec, impact, after, virtual_after)
        }
    };

    Ok(SwapResult {
        amount_out,
        fee,
        exec_price: to_u64(exec)?,
        impact_bps: to_u64(impact)? as u32,
        quote: q,
        reserves_after: after,
        virtual_after,
    })
}

/// Deposits are valued at the reference price, so they are only allowed while the
/// underlying market is open and the price is fresh.
pub fn require_fresh_open(p: &Params, m: &Market, now: i64) -> Result<()> {
    match m.state {
        MarketState::Open => half_spread_bps(p, m, now).map(|_| ()),
        MarketState::Halted => Err(MathError::Halted),
        MarketState::Closed => Err(MathError::StalePrice),
    }
}

/// LP shares minted for a deposit. The first deposit mints one share per quote unit of value.
pub fn lp_shares_for_deposit(
    tok: &BaseToken,
    r: &Reserves,
    price: u64,
    lp_supply: u64,
    base_in: u64,
    quote_in: u64,
) -> Result<u64> {
    let deposit_value = tok.value(base_in, price)? + quote_in as u128;
    if deposit_value == 0 {
        return Err(MathError::ZeroAmount);
    }
    if lp_supply == 0 {
        return to_u64(deposit_value);
    }
    let total = pool_value(tok, r, price)?;
    if total == 0 {
        return Err(MathError::EmptyPool);
    }
    to_u64(mul_div(deposit_value, lp_supply as u128, total)?)
}

/// Pro-rata withdrawal of both reserves. Needs no price, so it works in every market state.
pub fn withdraw_amounts(r: &Reserves, lp_supply: u64, shares: u64) -> Result<(u64, u64)> {
    if shares == 0 {
        return Err(MathError::ZeroAmount);
    }
    if lp_supply == 0 || shares > lp_supply {
        return Err(MathError::InsufficientLiquidity);
    }
    let base = mul_div(r.base as u128, shares as u128, lp_supply as u128)?;
    let quote = mul_div(r.quote as u128, shares as u128, lp_supply as u128)?;
    Ok((to_u64(base)?, to_u64(quote)?))
}

#[cfg(test)]
mod tests {
    use super::*;

    const USD: u64 = 1_000_000;
    // xStocks use 8 decimals.
    const SHARE: u64 = 100_000_000;
    const TOK: BaseToken = BaseToken { decimals: 8, multiplier_e9: MULTIPLIER_ONE };

    fn params() -> Params {
        Params {
            base_half_spread_bps: 10,
            sigma_open_bps: 100,
            sigma_closed_bps: 60,
            spread_z_bps: 10_000,
            max_half_spread_bps: 1_000,
            inventory_skew_bps: 200,
            target_base_weight_bps: 5_000,
            impact_bps: 10_000,
            fee_bps: 5,
            band_open_bps: 500,
            band_closed_bps: 1_500,
            min_base_weight_bps: 1_000,
            max_base_weight_bps: 9_000,
            max_staleness_secs: 120,
        }
    }

    fn open_at(price: u64, now: i64) -> Market {
        Market { state: MarketState::Open, ref_price: price, ref_ts: now, close_ts: 0, virtual_base: 0, virtual_quote: 0 }
    }

    fn closed_since(price: u64, close_ts: i64) -> Market {
        // Virtual reserves as set at the close of the balanced pool below.
        let (virtual_base, virtual_quote) = virtual_reserves_at_close(&TOK, &balanced(), price).unwrap();
        Market { state: MarketState::Closed, ref_price: price, ref_ts: close_ts, close_ts, virtual_base, virtual_quote }
    }

    /// 100 shares at $200 plus $20,000: a balanced $40,000 pool.
    fn balanced() -> Reserves {
        Reserves { base: 100 * SHARE, quote: 20_000 * USD }
    }

    #[test]
    fn isqrt_matches_floor_sqrt() {
        for n in [0u128, 1, 2, 3, 4, 15, 16, 17, 99, 100, 10_000_000_000, u64::MAX as u128] {
            let r = isqrt(n);
            assert!(r * r <= n && (r + 1) * (r + 1) > n, "isqrt({n}) = {r}");
        }
    }

    #[test]
    fn value_conversion_respects_decimals_and_multiplier() {
        assert_eq!(TOK.value(SHARE, 200 * USD).unwrap(), 200 * USD as u128);
        assert_eq!(TOK.raw_for_value(200 * USD as u128, 200 * USD).unwrap(), SHARE);
        // A 0.5% stock dividend paid through the multiplier makes each raw unit worth more.
        let after_dividend = BaseToken { decimals: 8, multiplier_e9: 1_005_000_000 };
        assert_eq!(after_dividend.value(SHARE, 200 * USD).unwrap(), 201 * USD as u128);
        // A 10-for-1 split: price falls 10x, multiplier rises 10x, value unchanged.
        let after_split = BaseToken { decimals: 8, multiplier_e9: 10 * MULTIPLIER_ONE };
        assert_eq!(after_split.value(SHARE, 20 * USD).unwrap(), 200 * USD as u128);
    }

    #[test]
    fn spread_grows_with_sqrt_of_time_since_close() {
        let p = params();
        let h = |hours: i64| half_spread_bps(&p, &closed_since(200 * USD, 0), hours * 3600).unwrap();
        // base 10 bps + 60 bps * sqrt(hours)
        assert_eq!(h(0), 10);
        assert_eq!(h(1), 70);
        assert_eq!(h(4), 130);
        assert_eq!(h(16), 250);
        // 64 hours (Friday close to Monday open) = 10 + 60 * 8
        assert_eq!(h(64), 490);
        // capped
        assert_eq!(h(1_000), p.max_half_spread_bps);
    }

    #[test]
    fn halted_and_stale_markets_refuse_to_quote() {
        let p = params();
        let halted = Market { state: MarketState::Halted, ..open_at(200 * USD, 0) };
        assert_eq!(half_spread_bps(&p, &halted, 0), Err(MathError::Halted));
        let stale = open_at(200 * USD, 0);
        assert_eq!(half_spread_bps(&p, &stale, 121), Err(MathError::StalePrice));
        assert!(half_spread_bps(&p, &stale, 120).is_ok());
        let no_price = open_at(0, 0);
        assert_eq!(half_spread_bps(&p, &no_price, 0), Err(MathError::NoPrice));
    }

    #[test]
    fn skew_leans_against_inventory() {
        let p = params();
        assert_eq!(skew_bps(&p, 5_000), 0);
        assert_eq!(skew_bps(&p, 10_000), 200);
        assert_eq!(skew_bps(&p, 0), -200);
        assert_eq!(skew_bps(&p, 7_500), 100);

        // Base-heavy pool: mid below the reference, so buying base is cheaper.
        let heavy = Reserves { base: 150 * SHARE, quote: 10_000 * USD };
        let q = quote(&p, &open_at(200 * USD, 0), &TOK, &heavy, 0).unwrap();
        assert_eq!(q.base_weight_bps, 7_500);
        assert!(q.mid < 200 * USD);
        assert!(q.bid < q.mid && q.mid < q.ask);
    }

    /// Applies a swap result to the market, as the program does.
    fn after(m: &Market, s: &SwapResult) -> Market {
        Market { virtual_base: s.virtual_after.0, virtual_quote: s.virtual_after.1, ..*m }
    }

    #[test]
    fn closed_market_discovers_price_along_a_constant_product_curve() {
        let p = params();
        let mut m = closed_since(200 * USD, 0);
        assert_eq!(closed_mid(&TOK, &m).unwrap(), 200 * USD as u128);

        // Selling five shares into the closed pool moves its price the way x*y=k does:
        // virtual (100 shares, $20k) -> (105 shares, $19,048), mid ~$181.4.
        let mut r = balanced();
        for _ in 0..5 {
            let s = swap(&p, &m, &TOK, &r, 3_600, Side::SellBase, SHARE).unwrap();
            r = s.reserves_after;
            m = after(&m, &s);
        }
        let q_closed = quote(&p, &m, &TOK, &r, 3_600).unwrap();
        assert!(q_closed.mid > 181 * USD && q_closed.mid < 182 * USD, "closed mid {}", q_closed.mid);
        // The same inventory while open is priced off the reference.
        let q_open = quote(&p, &open_at(200 * USD, 3_600), &TOK, &r, 3_600).unwrap();
        assert!(q_open.mid > 199 * USD, "open mid {}", q_open.mid);
    }

    #[test]
    fn closed_price_is_continuous_across_the_close() {
        // Whatever inventory the pool ends the day with, the virtual curve starts at the close.
        let heavy = Reserves { base: 140 * SHARE, quote: 12_000 * USD };
        let (virtual_base, virtual_quote) = virtual_reserves_at_close(&TOK, &heavy, 200 * USD).unwrap();
        let m = Market { virtual_base, virtual_quote, ..closed_since(200 * USD, 0) };
        assert_eq!(quote(&params(), &m, &TOK, &heavy, 60).unwrap().mid, 200 * USD);
    }

    #[test]
    fn closed_round_trips_never_make_money() {
        // Sell into the closed pool, then immediately buy back with the proceeds, at many sizes
        // and after the curve has already moved. The trader always ends with less stock.
        let p = params();
        // Up to 6 prior sells (~11% down); more would hit the 15% closed band, which is tested below.
        for pre in [0u64, 3, 6] {
            let mut m = closed_since(200 * USD, 0);
            let mut r = balanced();
            for _ in 0..pre {
                let s = swap(&p, &m, &TOK, &r, 7_200, Side::SellBase, SHARE).unwrap();
                r = s.reserves_after;
                m = after(&m, &s);
            }
            for shares in [SHARE / 100, SHARE, 5 * SHARE, 15 * SHARE] {
                let Ok(sell) = swap(&p, &m, &TOK, &r, 7_200, Side::SellBase, shares) else { continue };
                let m2 = after(&m, &sell);
                let buy = swap(&p, &m2, &TOK, &sell.reserves_after, 7_200, Side::BuyBase, sell.amount_out).unwrap();
                assert!(buy.amount_out < shares, "pre {pre}, size {shares}: got back {}", buy.amount_out);
            }
        }
    }

    #[test]
    fn band_rejects_mispricing_in_both_directions() {
        // A closed curve that has drifted to $150 would sell stock far below the $200 reference;
        // the band refuses that just like it refuses selling far above.
        let p = params();
        let m = Market { virtual_base: 100 * SHARE, virtual_quote: 15_000 * USD, ..closed_since(200 * USD, 0) };
        assert_eq!(swap(&p, &m, &TOK, &balanced(), 60, Side::BuyBase, 100 * USD), Err(MathError::OutsideBand));
        let m = Market { virtual_base: 100 * SHARE, virtual_quote: 26_000 * USD, ..closed_since(200 * USD, 0) };
        assert_eq!(swap(&p, &m, &TOK, &balanced(), 60, Side::SellBase, SHARE), Err(MathError::OutsideBand));
    }

    #[test]
    fn open_market_quotes_tightly_around_reference() {
        let p = params();
        let q = quote(&p, &open_at(200 * USD, 0), &TOK, &balanced(), 0).unwrap();
        assert_eq!(q.mid, 200 * USD);
        assert_eq!(q.half_spread_bps, 10);
        assert_eq!(q.bid, 199_800_000);
        assert_eq!(q.ask, 200_200_000);
    }

    #[test]
    fn round_trip_never_makes_money() {
        let p = params();
        for m in [open_at(200 * USD, 0), closed_since(200 * USD, -7_200)] {
            let r0 = balanced();
            let sell = swap(&p, &m, &TOK, &r0, 0, Side::SellBase, SHARE).unwrap();
            let buy = swap(&p, &after(&m, &sell), &TOK, &sell.reserves_after, 0, Side::BuyBase, sell.amount_out)
                .unwrap();
            assert!(buy.amount_out < SHARE, "round trip returned {} raw", buy.amount_out);
        }
    }

    #[test]
    fn sell_pays_bid_minus_impact_and_fee() {
        let p = params();
        let r = swap(&p, &open_at(200 * USD, 0), &TOK, &balanced(), 0, Side::SellBase, SHARE)
            .unwrap();
        // Selling $199.8 into a $40,000 pool moves the price 49 bps by the end of the trade,
        // so on average it fills ~24 bps below the bid.
        assert_eq!(r.impact_bps, 24);
        assert!(r.exec_price < 199_800_000);
        assert!(r.amount_out < 199_800_000);
        assert_eq!(r.reserves_after.base, 101 * SHARE);
    }

    #[test]
    fn band_blocks_trades_far_from_reference() {
        let p = params();
        // Selling 40% of the pool's base: impact ~20% average, beyond the 5% open band.
        let res = swap(&p, &open_at(200 * USD, 0), &TOK, &balanced(), 0, Side::SellBase, 40 * SHARE);
        assert_eq!(res, Err(MathError::OutsideBand));
    }

    #[test]
    fn inventory_limit_stops_one_sided_drain() {
        let mut p = params();
        p.band_open_bps = 9_000;
        p.impact_bps = 100;
        // Keep selling base into the pool until it refuses.
        let m = open_at(200 * USD, 0);
        let mut r = balanced();
        let mut refused = None;
        for _ in 0..200 {
            match swap(&p, &m, &TOK, &r, 0, Side::SellBase, 5 * SHARE) {
                Ok(s) => r = s.reserves_after,
                Err(e) => {
                    refused = Some(e);
                    break;
                }
            }
        }
        assert_eq!(refused, Some(MathError::InventoryLimit));
        assert!(base_weight_bps(&TOK, &r, 200 * USD).unwrap() <= p.max_base_weight_bps);
    }

    #[test]
    fn weekend_spread_protects_against_monday_gap() {
        // Friday close at $200; Sunday night (58h later) the pool's bid already sits
        // hundreds of bps below the close, so dumping into it is expensive.
        let p = params();
        let m = closed_since(200 * USD, 0);
        let q = quote(&p, &m, &TOK, &balanced(), 58 * 3600).unwrap();
        assert!(q.half_spread_bps > 450);
        assert!(q.bid < 191 * USD);
    }

    #[test]
    fn deposits_and_withdrawals_are_pro_rata() {
        let r = balanced();
        let first = lp_shares_for_deposit(&TOK, &Reserves { base: 0, quote: 0 }, 200 * USD, 0, 100 * SHARE, 20_000 * USD)
            .unwrap();
        assert_eq!(first, 40_000 * USD);
        let more = lp_shares_for_deposit(&TOK, &r, 200 * USD, first, 0, 4_000 * USD).unwrap();
        assert_eq!(more, 4_000 * USD);
        let (b, q) = withdraw_amounts(&r, first, first / 4).unwrap();
        assert_eq!((b, q), (25 * SHARE, 5_000 * USD));
    }

    #[test]
    fn deposits_need_an_open_fresh_market() {
        let p = params();
        assert!(require_fresh_open(&p, &open_at(200 * USD, 0), 10).is_ok());
        assert_eq!(require_fresh_open(&p, &closed_since(200 * USD, 0), 10), Err(MathError::StalePrice));
        let halted = Market { state: MarketState::Halted, ..open_at(200 * USD, 0) };
        assert_eq!(require_fresh_open(&p, &halted, 10), Err(MathError::Halted));
    }

    #[test]
    fn params_validation() {
        assert!(params().validate().is_ok());
        let mut bad = params();
        bad.min_base_weight_bps = 6_000;
        assert_eq!(bad.validate(), Err(MathError::InvalidParams));
    }
}
