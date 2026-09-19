//! Bellcurve backtest.
//!
//! Replays ~3 years of hourly stock data (regular + extended hours) at one-minute
//! resolution through pools that start with the same $100k, half in stock, half in USDC:
//!
//! - `cpmm_30bps` / `cpmm_100bps`: constant-product AMMs, the kind tokenized stocks trade on today
//! - `oracle_naive`: an oracle-priced pool with a fixed spread and no market-hours logic
//! - `bellcurve`: the exact pricing code that runs on-chain (`bellcurve-math`)
//!
//! True price path: inside each hourly bar the minute path is a Brownian bridge from the
//! bar's open to its close. While the underlying market is closed (overnight, weekends,
//! holidays) it is a Brownian bridge from the last print to the next open, i.e. informed
//! traders learn the gap gradually, the way 24/7 token markets discover it. Arbitrageurs
//! see the true price every minute and trade any mispriced pool as far as it pays.
//!
//! Two scenarios per stock:
//! - informed only: arbitrageurs alone, isolating what each pool loses to adverse selection
//! - with flow: uninformed traders also arrive at random and send identical orders to every
//!   pool, measuring what ordinary traders pay and what LPs net
//!
//! Usage: cargo run --release -p bellcurve-backtest -- [--seeds=3] [--flow-seeds=3]
//!        [--latency=2] [--threads=3] [--data=data/raw] [--out=results/backtest.json]

use std::{env, fmt::Write as _, fs, path::Path};

use bellcurve_math::{
    quote, swap, virtual_reserves_at_close, BaseToken, Market, MarketState, Params, Reserves, Side,
    MULTIPLIER_ONE,
};

const TICKERS: [&str; 6] = ["SPY", "QQQ", "NVDA", "TSLA", "AAPL", "MSTR"];
const STEP_SECS: i64 = 60;
const START_USD: f64 = 100_000.0;
const USD: f64 = 1e6;
const SHARE: f64 = 1e8;
const TOK: BaseToken = BaseToken { decimals: 8, multiplier_e9: MULTIPLIER_ONE };

// ---------------------------------------------------------------- data

struct Bar {
    ts: i64,
    open: f64,
    close: f64,
}

fn load_bars(path: &Path) -> Vec<Bar> {
    let text = fs::read_to_string(path).unwrap_or_else(|e| panic!("read {}: {e}", path.display()));
    text.lines()
        .skip(1)
        .filter_map(|line| {
            let mut f = line.split(',');
            let ts = f.next()?.parse().ok()?;
            let open = f.next()?.parse().ok()?;
            let close = f.next()?.parse().ok()?;
            Some(Bar { ts, open, close })
        })
        .collect()
}

struct Step {
    ts: i64,
    price: f64,
    /// A price is being printed somewhere (pre, regular or post session).
    open: bool,
    /// Start of the current closed period.
    close_ts: i64,
    /// Length of the current closed period (0 while open).
    gap_secs: i64,
}

const WEEKEND_SECS: i64 = 24 * 3600;

struct Calibration {
    /// Log-return volatility per sqrt(hour) while prices print.
    sigma_open: f64,
    /// Log-return volatility per sqrt(hour) of overnight/weekend gaps.
    sigma_closed: f64,
    weekends: usize,
}

fn bar_end(bars: &[Bar], i: usize) -> i64 {
    let end = bars[i].ts + 3600;
    bars.get(i + 1).map_or(end, |n| end.min(n.ts))
}

fn calibrate(bars: &[Bar]) -> Calibration {
    let mut open = Vec::new();
    let mut closed = Vec::new();
    let mut weekends = 0;
    for i in 0..bars.len() {
        let end = bar_end(bars, i);
        let hours = (end - bars[i].ts) as f64 / 3600.0;
        if hours > 0.0 {
            open.push((bars[i].close / bars[i].open).ln() / hours.sqrt());
        }
        if let Some(next) = bars.get(i + 1) {
            let gap = next.ts - end;
            if gap > STEP_SECS {
                closed.push((next.open / bars[i].close).ln() / (gap as f64 / 3600.0).sqrt());
                if gap > 24 * 3600 {
                    weekends += 1;
                }
            }
        }
    }
    Calibration { sigma_open: stdev(&open), sigma_closed: stdev(&closed), weekends }
}

fn stdev(xs: &[f64]) -> f64 {
    let n = xs.len() as f64;
    let mean = xs.iter().sum::<f64>() / n;
    (xs.iter().map(|x| (x - mean).powi(2)).sum::<f64>() / (n - 1.0)).sqrt()
}

/// Minute-by-minute true price path.
fn build_path(bars: &[Bar], cal: &Calibration, rng: &mut Rng) -> Vec<Step> {
    let open_vol = cal.sigma_open / 60f64.sqrt();
    let closed_vol = cal.sigma_closed / 60f64.sqrt();
    let mut steps = Vec::new();
    for i in 0..bars.len() {
        let end = bar_end(bars, i);
        let n = ((end - bars[i].ts) / STEP_SECS).max(1) as usize;
        for (k, price) in bridge(bars[i].open, bars[i].close, n, open_vol, rng).into_iter().enumerate() {
            let ts = bars[i].ts + k as i64 * STEP_SECS;
            steps.push(Step { ts, price, open: true, close_ts: 0, gap_secs: 0 });
        }
        if let Some(next) = bars.get(i + 1) {
            let gap = next.ts - end;
            if gap > STEP_SECS {
                let n = (gap / STEP_SECS) as usize;
                for (k, price) in bridge(bars[i].close, next.open, n, closed_vol, rng).into_iter().enumerate() {
                    let ts = end + k as i64 * STEP_SECS;
                    steps.push(Step { ts, price, open: false, close_ts: end, gap_secs: gap });
                }
            }
        }
    }
    steps
}

/// Brownian bridge in log space from `x0` (inclusive) to `x1` (exclusive) in `n` steps.
fn bridge(x0: f64, x1: f64, n: usize, step_vol: f64, rng: &mut Rng) -> Vec<f64> {
    let mut w = vec![0.0; n + 1];
    for k in 1..=n {
        w[k] = w[k - 1] + step_vol * rng.normal();
    }
    let (l0, l1) = (x0.ln(), x1.ln());
    (0..n)
        .map(|k| {
            let f = k as f64 / n as f64;
            (l0 + f * (l1 - l0) + w[k] - f * w[n]).exp()
        })
        .collect()
}

// ---------------------------------------------------------------- rng

struct Rng(u64);

impl Rng {
    fn next_u64(&mut self) -> u64 {
        // xorshift64*
        self.0 ^= self.0 >> 12;
        self.0 ^= self.0 << 25;
        self.0 ^= self.0 >> 27;
        self.0.wrapping_mul(0x2545_F491_4F6C_DD1D)
    }
    fn uniform(&mut self) -> f64 {
        (self.next_u64() >> 11) as f64 / (1u64 << 53) as f64
    }
    fn normal(&mut self) -> f64 {
        let u1 = self.uniform().max(1e-300);
        let u2 = self.uniform();
        (-2.0 * u1.ln()).sqrt() * (std::f64::consts::TAU * u2).cos()
    }
}

// ---------------------------------------------------------------- venues

trait Venue {
    fn value(&self, p: f64) -> f64;
    /// Informed arbitrage against the true price; returns the arbitrageur's profit in USD.
    fn arbitrage(&mut self, now: i64, p: f64) -> f64;
    /// An uninformed order; returns what it cost the trader versus the true price, or None if refused.
    fn noise(&mut self, now: i64, p: f64, buy: bool, usd: f64) -> Option<f64>;
    /// Keeper update at the start of the minute; `lag_z` is a standard normal draw for oracle lag.
    fn keeper(&mut self, _step: &Step, _lag_z: f64) {}
}

struct Cpmm {
    x: f64,
    y: f64,
    fee: f64,
}

impl Venue for Cpmm {
    fn value(&self, p: f64) -> f64 {
        self.x * p + self.y
    }

    fn arbitrage(&mut self, _now: i64, p: f64) -> f64 {
        let (x, y, g) = (self.x, self.y, 1.0 - self.fee);
        let k = x * y;
        if p > y / x / g {
            // Buy stock until the marginal price including the fee reaches p.
            let y_after = (k * g * p).sqrt();
            let dy = (y_after - y) / g;
            let x_after = k / y_after;
            let profit = (x - x_after) * p - dy;
            self.x = x_after;
            self.y = y + dy;
            profit
        } else if p < y / x * g {
            let x_after = (g * k / p).sqrt();
            let dx = (x_after - x) / g;
            let y_after = k / x_after;
            let profit = (y - y_after) - dx * p;
            self.x = x + dx;
            self.y = y_after;
            profit
        } else {
            0.0
        }
    }

    fn noise(&mut self, _now: i64, p: f64, buy: bool, usd: f64) -> Option<f64> {
        let (x, y, g) = (self.x, self.y, 1.0 - self.fee);
        let k = x * y;
        if buy {
            let x_after = k / (y + usd * g);
            let got = x - x_after;
            self.x = x_after;
            self.y = y + usd;
            Some(usd - got * p)
        } else {
            let dx = usd / p;
            let y_after = k / (x + dx * g);
            let got = y - y_after;
            self.x = x + dx;
            self.y = y_after;
            Some(usd - got)
        }
    }
}

struct Bell {
    params: Params,
    market: Market,
    res: Reserves,
    /// The keeper's price is this many seconds old when arbitrageurs trade against it.
    lag_secs: i64,
    /// Volatility of the price over `lag_secs`, in log terms.
    lag_vol: f64,
    /// False for the naive oracle pool: it never learns that the market closed.
    market_hours: bool,
}

fn to_price(p: f64) -> u64 {
    (p * USD).round() as u64
}

impl Bell {
    fn new(params: Params, p0: f64, t0: i64, cal: &Calibration, lag_secs: i64, market_hours: bool) -> Self {
        Bell {
            params,
            market: Market {
                state: MarketState::Open,
                ref_price: to_price(p0),
                ref_ts: t0,
                close_ts: t0,
                virtual_base: 0,
                virtual_quote: 0,
            },
            res: Reserves {
                base: (START_USD / 2.0 / p0 * SHARE) as u64,
                quote: (START_USD / 2.0 * USD) as u64,
            },
            lag_secs,
            lag_vol: cal.sigma_open / 60.0 * (lag_secs as f64).sqrt(),
            market_hours,
        }
    }

    fn try_swap(&self, now: i64, side: Side, amount: u64) -> Option<bellcurve_math::SwapResult> {
        swap(&self.params, &self.market, &TOK, &self.res, now, side, amount).ok()
    }

    /// Apply a swap the way the program does, including the closed-market curve.
    fn apply(&mut self, r: &bellcurve_math::SwapResult) {
        self.res = r.reserves_after;
        if self.market.state == MarketState::Closed {
            (self.market.virtual_base, self.market.virtual_quote) = r.virtual_after;
        }
    }

    fn profit(&self, now: i64, p: f64, side: Side, amount: u64) -> Option<f64> {
        let r = self.try_swap(now, side, amount)?;
        Some(match side {
            Side::SellBase => r.amount_out as f64 / USD - amount as f64 / SHARE * p,
            Side::BuyBase => r.amount_out as f64 / SHARE * p - amount as f64 / USD,
        })
    }

    /// Most profitable trade size for an arbitrageur who knows the true price `p`.
    ///
    /// Profit is concave in size, so the unconstrained optimum has a closed form (linear
    /// impact while open, `x * y = k` on the virtual reserves while closed); if the pool
    /// refuses that size (price band, inventory limit) the best feasible trade is the largest
    /// one it accepts, found by bisection.
    fn best_trade(&self, now: i64, p: f64, side: Side, bid: f64, ask: f64, h: f64) -> Option<(u64, f64)> {
        let keep = 1.0 - self.params.fee_bps as f64 / 1e4;
        let ideal = if self.market.state == MarketState::Closed {
            // Virtual reserves in raw base units and quote units; p in quote units per raw unit.
            let (vb, vq) = (self.market.virtual_base as f64, self.market.virtual_quote as f64);
            let p_raw = p * USD / SHARE;
            let k = keep * (1.0 - h);
            match side {
                // max k*vq*x/(vb+x) - p_raw*x
                Side::SellBase => (k * vq * vb / p_raw).sqrt() - vb,
                // max p_raw*vb*k*q/(vq+k*q) - q
                Side::BuyBase => ((p_raw * vb * vq * k).sqrt() - vq) / k,
            }
        } else {
            let total = self.value(p).max(1.0);
            let lambda = self.params.impact_bps as f64 / 1e4;
            match side {
                // d/dq [q*bid*keep*(1 - lambda*q*bid/(2V)) - q*p] = 0
                Side::SellBase => (1.0 - p / (bid * keep)) * total / (lambda * bid) * SHARE,
                // d/dq [q*keep*p / (ask*(1 + c*q)) - q] = 0 with c = lambda*keep/(2V)
                Side::BuyBase => {
                    let c = lambda * keep / (2.0 * total);
                    ((keep * p / ask).sqrt() - 1.0) / c * USD
                }
            }
        };
        if !(ideal >= 1_000.0) {
            return None;
        }
        let mut amount = ideal.min(u64::MAX as f64 / 2.0) as u64;
        if self.try_swap(now, side, amount).is_none() {
            let (mut lo, mut hi) = (0u64, amount);
            while hi - lo > (hi / 1_000).max(1) {
                let mid = lo + (hi - lo) / 2;
                if self.try_swap(now, side, mid).is_some() {
                    lo = mid;
                } else {
                    hi = mid;
                }
            }
            amount = lo;
        }
        let profit = self.profit(now, p, side, amount)?;
        (profit > 0.0).then_some((amount, profit))
    }
}

impl Venue for Bell {
    fn value(&self, p: f64) -> f64 {
        self.res.base as f64 / SHARE * p + self.res.quote as f64 / USD
    }

    fn arbitrage(&mut self, now: i64, p: f64) -> f64 {
        let Ok(q) = quote(&self.params, &self.market, &TOK, &self.res, now) else {
            return 0.0;
        };
        let fee = self.params.fee_bps as f64 / 1e4;
        let (bid, ask) = (q.bid as f64 / USD, q.ask as f64 / USD);
        let side = if p < bid * (1.0 - fee) {
            Side::SellBase
        } else if p > ask / (1.0 - fee) {
            Side::BuyBase
        } else {
            return 0.0;
        };
        match self.best_trade(now, p, side, bid, ask, q.half_spread_bps as f64 / 1e4) {
            Some((amount, profit)) => {
                if let Some(r) = self.try_swap(now, side, amount) {
                    self.apply(&r);
                }
                profit
            }
            None => 0.0,
        }
    }

    fn noise(&mut self, now: i64, p: f64, buy: bool, usd: f64) -> Option<f64> {
        let (side, amount) = if buy {
            (Side::BuyBase, (usd * USD) as u64)
        } else {
            (Side::SellBase, (usd / p * SHARE) as u64)
        };
        let r = self.try_swap(now, side, amount)?;
        self.apply(&r);
        Some(match side {
            Side::BuyBase => usd - r.amount_out as f64 / SHARE * p,
            Side::SellBase => usd - r.amount_out as f64 / USD,
        })
    }

    fn keeper(&mut self, step: &Step, lag_z: f64) {
        if step.open {
            // The oracle shows the price from `lag_secs` ago: the true price plus the move since then.
            self.market.state = MarketState::Open;
            self.market.ref_price = to_price(step.price * (self.lag_vol * lag_z).exp());
            self.market.ref_ts = step.ts - self.lag_secs;
        } else if self.market_hours && self.market.state != MarketState::Closed {
            self.market.state = MarketState::Closed;
            self.market.close_ts = step.close_ts;
            (self.market.virtual_base, self.market.virtual_quote) =
                virtual_reserves_at_close(&TOK, &self.res, self.market.ref_price).unwrap_or((0, 0));
        }
    }
}

fn bellcurve_params(cal: &Calibration) -> Params {
    Params {
        base_half_spread_bps: 5,
        sigma_open_bps: (cal.sigma_open * 1e4).round() as u32,
        sigma_closed_bps: (cal.sigma_closed * 1e4).round() as u32,
        // 1.5 sigma: at 1 sigma about a third of weekends would move past the quote.
        spread_z_bps: 15_000,
        max_half_spread_bps: 1_500,
        inventory_skew_bps: 10,
        target_base_weight_bps: 5_000,
        impact_bps: 20_000,
        fee_bps: 5,
        band_open_bps: 500,
        band_closed_bps: 2_000,
        min_base_weight_bps: 1_000,
        max_base_weight_bps: 9_000,
        max_staleness_secs: 120,
    }
}

/// Same machinery with the market-hours logic switched off: a flat spread around the last price.
fn naive_params(cal: &Calibration) -> Params {
    Params {
        sigma_open_bps: 0,
        sigma_closed_bps: 0,
        inventory_skew_bps: 0,
        band_closed_bps: 9_000,
        max_staleness_secs: u32::MAX,
        ..bellcurve_params(cal)
    }
}

// ---------------------------------------------------------------- simulation

/// Uninformed order flow: Poisson arrivals, log-normal sizes.
#[derive(Clone, Copy)]
struct Flow {
    rate_per_min: f64,
    median_usd: f64,
    log_sd: f64,
    cap_usd: f64,
}

/// About 29 orders a day with a $250 median: roughly 15% of the pool's value traded daily.
const REALISTIC_FLOW: Flow = Flow { rate_per_min: 0.02, median_usd: 250.0, log_sd: 1.0, cap_usd: 5_000.0 };

#[derive(Default, Clone)]
struct Stats {
    /// LP value minus buy-and-hold value at the end, % of starting capital.
    final_vs_hodl: f64,
    arb_total: f64,
    arb_closed: f64,
    noise_tried: u64,
    noise_filled: u64,
    noise_cost_open: f64,
    noise_usd_open: f64,
    noise_cost_closed: f64,
    noise_usd_closed: f64,
    /// Largest arbitrage loss over one weekend plus the hour after it reopens, % of starting capital.
    worst_weekend: f64,
    /// (day, LP value minus buy-and-hold value, % of starting capital)
    series: Vec<(i64, f64)>,
}

const VENUES: [&str; 4] = ["cpmm_30bps", "cpmm_100bps", "oracle_naive", "bellcurve"];

fn run(bars: &[Bar], cal: &Calibration, seed: u64, flow: Option<Flow>, lag_secs: i64) -> Vec<Stats> {
    let mut rng = Rng(seed.wrapping_mul(0x9E37_79B9_7F4A_7C15) | 1);
    let steps = build_path(bars, cal, &mut rng);
    let mut orders = Rng(seed.wrapping_add(0xD1B5_4A32_D192_ED03) | 1);
    let mut lag = Rng(seed.wrapping_add(0x8CB9_2BA7_2F3D_8DD7) | 1);

    let p0 = steps[0].price;
    let t0 = steps[0].ts;
    let x0 = START_USD / 2.0 / p0;
    let mut venues: Vec<Box<dyn Venue>> = vec![
        Box::new(Cpmm { x: x0, y: START_USD / 2.0, fee: 0.003 }),
        Box::new(Cpmm { x: x0, y: START_USD / 2.0, fee: 0.01 }),
        Box::new(Bell::new(naive_params(cal), p0, t0, cal, lag_secs, false)),
        Box::new(Bell::new(bellcurve_params(cal), p0, t0, cal, lag_secs, true)),
    ];
    let mut stats = vec![Stats::default(); venues.len()];
    // Arbitrage taken over each weekend plus the first hour after it reopens.
    let mut weekend_loss = vec![0.0; venues.len()];
    let mut in_weekend = false;
    let mut reopen_end = i64::MAX;
    let mut last_day = i64::MIN;

    for step in &steps {
        let p = step.price;
        if !step.open && step.gap_secs > WEEKEND_SECS {
            in_weekend = true;
            reopen_end = i64::MAX;
        } else if in_weekend {
            if reopen_end == i64::MAX {
                reopen_end = step.ts + 3600;
            }
            if step.ts >= reopen_end {
                for (s, loss) in stats.iter_mut().zip(weekend_loss.iter_mut()) {
                    s.worst_weekend = s.worst_weekend.max(*loss / START_USD * 100.0);
                    *loss = 0.0;
                }
                in_weekend = false;
            }
        }

        // The keeper posts first; its price lags the truth by `lag_secs`.
        let lag_z = lag.normal();
        for v in venues.iter_mut() {
            v.keeper(step, lag_z);
        }

        for (i, v) in venues.iter_mut().enumerate() {
            let profit = v.arbitrage(step.ts, p);
            stats[i].arb_total += profit;
            if !step.open {
                stats[i].arb_closed += profit;
            }
            if in_weekend {
                weekend_loss[i] += profit;
            }
        }

        if let Some(f) = flow {
            if orders.uniform() < f.rate_per_min {
                let buy = orders.uniform() < 0.5;
                let usd = (f.median_usd.ln() + f.log_sd * orders.normal()).exp().min(f.cap_usd);
                for (i, v) in venues.iter_mut().enumerate() {
                    stats[i].noise_tried += 1;
                    if let Some(cost) = v.noise(step.ts, p, buy, usd) {
                        stats[i].noise_filled += 1;
                        if step.open {
                            stats[i].noise_cost_open += cost;
                            stats[i].noise_usd_open += usd;
                        } else {
                            stats[i].noise_cost_closed += cost;
                            stats[i].noise_usd_closed += usd;
                        }
                    }
                }
            }
        }

        let day = step.ts.div_euclid(86_400);
        if day != last_day {
            last_day = day;
            let hodl = x0 * p + START_USD / 2.0;
            for (i, v) in venues.iter().enumerate() {
                stats[i].series.push((day, (v.value(p) - hodl) / START_USD * 100.0));
            }
        }
    }

    let p_end = steps.last().unwrap().price;
    let hodl = x0 * p_end + START_USD / 2.0;
    for (i, v) in venues.iter().enumerate() {
        stats[i].final_vs_hodl = (v.value(p_end) - hodl) / START_USD * 100.0;
    }
    stats
}

// ---------------------------------------------------------------- output

fn mean_sd(xs: &[f64]) -> (f64, f64) {
    let n = xs.len() as f64;
    let m = xs.iter().sum::<f64>() / n;
    let sd = if xs.len() > 1 {
        (xs.iter().map(|x| (x - m).powi(2)).sum::<f64>() / (n - 1.0)).sqrt()
    } else {
        0.0
    };
    (m, sd)
}

struct TickerRun {
    ticker: &'static str,
    bars: usize,
    from: i64,
    to: i64,
    cal: Calibration,
    /// [seed][venue]
    informed: Vec<Vec<Stats>>,
    with_flow: Vec<Vec<Stats>>,
}

fn simulate(ticker: &'static str, cfg: &Config) -> TickerRun {
    let bars = load_bars(&Path::new(&cfg.data_dir).join(format!("{ticker}_1h.csv")));
    let cal = calibrate(&bars);
    let informed = (1..=cfg.seeds).map(|s| run(&bars, &cal, s, None, cfg.lag_secs)).collect();
    let with_flow = (1..=cfg.flow_seeds)
        .map(|s| run(&bars, &cal, s, Some(REALISTIC_FLOW), cfg.lag_secs))
        .collect();
    TickerRun {
        ticker,
        bars: bars.len(),
        from: bars.first().unwrap().ts,
        to: bars.last().unwrap().ts,
        cal,
        informed,
        with_flow,
    }
}

fn series_json(stats: &Stats) -> String {
    // Weekly points keep the file small enough for the dashboard.
    let pts: Vec<String> = stats
        .series
        .iter()
        .step_by(7)
        .map(|(d, v)| format!("[{d},{v:.3}]"))
        .collect();
    pts.join(",")
}

fn report(r: &TickerRun, json: &mut String) {
    let years = (r.to - r.from) as f64 / 31_557_600.0;
    println!(
        "\n{}: {} bars over {:.1} years, sigma_open {:.0} bps/sqrt(h), sigma_closed {:.0} bps/sqrt(h), {} weekends/holidays",
        r.ticker,
        r.bars,
        years,
        r.cal.sigma_open * 1e4,
        r.cal.sigma_closed * 1e4,
        r.cal.weekends
    );
    let _ = write!(
        json,
        "    {{\"ticker\": \"{}\", \"bars\": {}, \"from\": {}, \"to\": {}, \"years\": {years:.3}, \"sigma_open_bps\": {:.1}, \"sigma_closed_bps\": {:.1}, \"weekends\": {},\n",
        r.ticker,
        r.bars,
        r.from,
        r.to,
        r.cal.sigma_open * 1e4,
        r.cal.sigma_closed * 1e4,
        r.cal.weekends
    );

    println!("  informed traders only (losses to adverse selection)");
    println!("  {:<14} {:>16} {:>12} {:>14} {:>16}", "venue", "LP vs hodl %", "per year %", "closed-hours %", "worst weekend %");
    json.push_str("     \"informed_only\": [");
    for (vi, name) in VENUES.iter().enumerate() {
        let col = |f: &dyn Fn(&Stats) -> f64| mean_sd(&r.informed.iter().map(|s| f(&s[vi])).collect::<Vec<_>>());
        let (lp, lp_sd) = col(&|s| s.final_vs_hodl);
        let (arb, _) = col(&|s| s.arb_total);
        let (closed_share, _) = col(&|s| if s.arb_total > 0.0 { s.arb_closed / s.arb_total * 100.0 } else { 0.0 });
        let (worst, _) = col(&|s| s.worst_weekend);
        println!(
            "  {:<14} {:>9.2} ±{:<5.2} {:>12.2} {:>14.0} {:>16.2}",
            name, lp, lp_sd, lp / years, closed_share, worst
        );
        let _ = write!(
            json,
            "{}{{\"name\": \"{name}\", \"lp_vs_hodl_pct\": {lp:.4}, \"lp_vs_hodl_pct_sd\": {lp_sd:.4}, \"per_year_pct\": {:.4}, \"arb_profit_usd\": {arb:.2}, \"closed_hours_share_pct\": {closed_share:.2}, \"worst_weekend_pct\": {worst:.4}, \"series\": [{}]}}",
            if vi == 0 { "" } else { ", " },
            lp / years,
            series_json(&r.informed[0][vi])
        );
    }
    json.push_str("],\n");

    if r.with_flow.is_empty() {
        json.push_str("     \"with_flow\": []}");
        return;
    }
    println!("  with realistic uninformed flow");
    println!(
        "  {:<14} {:>16} {:>12} {:>10} {:>14} {:>14}",
        "venue", "LP vs hodl %", "per year %", "fill %", "cost open bps", "cost closed bps"
    );
    json.push_str("     \"with_flow\": [");
    for (vi, name) in VENUES.iter().enumerate() {
        let col = |f: &dyn Fn(&Stats) -> f64| mean_sd(&r.with_flow.iter().map(|s| f(&s[vi])).collect::<Vec<_>>());
        let (lp, lp_sd) = col(&|s| s.final_vs_hodl);
        let (fill, _) = col(&|s| s.noise_filled as f64 / s.noise_tried.max(1) as f64 * 100.0);
        let (cost_open, _) = col(&|s| s.noise_cost_open / s.noise_usd_open.max(1.0) * 1e4);
        let (cost_closed, _) = col(&|s| s.noise_cost_closed / s.noise_usd_closed.max(1.0) * 1e4);
        println!(
            "  {:<14} {:>9.2} ±{:<5.2} {:>12.2} {:>10.1} {:>14.1} {:>14.1}",
            name, lp, lp_sd, lp / years, fill, cost_open, cost_closed
        );
        let _ = write!(
            json,
            "{}{{\"name\": \"{name}\", \"lp_vs_hodl_pct\": {lp:.4}, \"lp_vs_hodl_pct_sd\": {lp_sd:.4}, \"per_year_pct\": {:.4}, \"fill_pct\": {fill:.2}, \"cost_open_bps\": {cost_open:.2}, \"cost_closed_bps\": {cost_closed:.2}, \"series\": [{}]}}",
            if vi == 0 { "" } else { ", " },
            lp / years,
            series_json(&r.with_flow[0][vi])
        );
    }
    json.push_str("]}");
}

struct Config {
    data_dir: String,
    out: String,
    /// Seeds for the informed-only scenario.
    seeds: u64,
    /// Seeds for the scenario with uninformed flow (0 skips it).
    flow_seeds: u64,
    /// Oracle latency in seconds.
    lag_secs: i64,
    threads: usize,
}

impl Config {
    fn from_args() -> Self {
        let mut cfg = Config {
            data_dir: "data/raw".into(),
            out: "results/backtest.json".into(),
            seeds: 3,
            flow_seeds: 3,
            lag_secs: 2,
            threads: 3,
        };
        for arg in env::args().skip(1) {
            let (key, value) = arg.split_once('=').unwrap_or_else(|| panic!("expected --key=value, got {arg}"));
            match key {
                "--data" => cfg.data_dir = value.into(),
                "--out" => cfg.out = value.into(),
                "--seeds" => cfg.seeds = value.parse().expect("--seeds"),
                "--flow-seeds" => cfg.flow_seeds = value.parse().expect("--flow-seeds"),
                "--latency" => cfg.lag_secs = value.parse().expect("--latency"),
                "--threads" => cfg.threads = value.parse().expect("--threads"),
                _ => panic!("unknown option {key}"),
            }
        }
        cfg
    }
}

fn main() {
    let cfg = Config::from_args();

    // Each ticker is independent; run a few at a time to bound memory.
    let mut runs = Vec::new();
    for chunk in TICKERS.chunks(cfg.threads) {
        let done: Vec<TickerRun> = std::thread::scope(|s| {
            let handles: Vec<_> = chunk.iter().map(|t| s.spawn(|| simulate(t, &cfg))).collect();
            handles.into_iter().map(|h| h.join().expect("simulation thread")).collect()
        });
        runs.extend(done);
    }

    let f = REALISTIC_FLOW;
    let out = &cfg.out;
    let mut json = String::from("{\n");
    let _ = writeln!(json, "  \"seeds\": {},", cfg.seeds);
    let _ = writeln!(json, "  \"flow_seeds\": {},", cfg.flow_seeds);
    let _ = writeln!(json, "  \"oracle_latency_secs\": {},", cfg.lag_secs);
    let _ = writeln!(json, "  \"start_usd\": {START_USD},");
    let _ = writeln!(
        json,
        "  \"flow\": {{\"rate_per_min\": {}, \"median_usd\": {}, \"log_sd\": {}, \"cap_usd\": {}}},",
        f.rate_per_min, f.median_usd, f.log_sd, f.cap_usd
    );
    json.push_str("  \"tickers\": [\n");
    for (i, r) in runs.iter().enumerate() {
        report(r, &mut json);
        json.push_str(if i + 1 == runs.len() { "\n" } else { ",\n" });
    }
    json.push_str("  ]\n}\n");

    if let Some(dir) = Path::new(out).parent() {
        fs::create_dir_all(dir).expect("create output dir");
    }
    fs::write(out, json).expect("write results");
    println!("\nwrote {out}");
}
