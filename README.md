# Bellcurve


Bellcurve is a liquidity pool for tokenized stocks on Solana. It quotes tightly around the real price while the stock market is open, discovers the price itself with a widening spread while the market is closed, and stops trading when the exchange halts the stock.

- **Live demo:** _add the deployed URL_
- **Pitch video:** _add link_ · **Technical walkthrough:** _add link_
- **Program on devnet:** [`3z63RQjfsQ4Wx3fvTe1dyrwcXr6qZmv95QFDut44FJeF`](https://explorer.solana.com/address/3z63RQjfsQ4Wx3fvTe1dyrwcXr6qZmv95QFDut44FJeF?cluster=devnet)
- **Live NVDA pool on devnet:** [`AtW5Ydmez3DbBL1AhXicW38XfSGhX2xyjk5CfheaaD26`](https://explorer.solana.com/address/AtW5Ydmez3DbBL1AhXicW38XfSGhX2xyjk5CfheaaD26?cluster=devnet)

Built for Stocklana, the Solana Foundation's tokenized-stock hackathon.

---

## The problem

Tokenized stocks trade 24/7 on Solana. The stock market does not: its main session covers about a fifth of the week, and 63% of tokenized-stock volume on Solana happens after the closing bell.

Today these tokens trade in ordinary constant-product pools that set their price only from their own inventory. They do not know the real price, so they are always a step behind it. Every time the stock moves, a faster trader buys from the pool at the stale price and sells elsewhere at the real one. That profit comes out of the liquidity providers' pockets. It is worst at the Monday open, after two days of news the pool never saw.

The obvious fix, pricing from an oracle, breaks the moment the oracle goes dark at Friday's close. An oracle pool that keeps quoting Friday's price all weekend is drained by anyone who knows where Monday will open.

## How Bellcurve works

A keeper reports what the real market is doing. The program prices every trade according to that state.

| Market state | What the pool does |
|---|---|
| **Open** | The exchange discovers the price, so the pool quotes a tight spread around the keeper's reference price. There is nothing stale for arbitrageurs to pick off. |
| **Closed** | No exchange is discovering the price, so the pool does it itself: trades move along `x · y = k` on virtual reserves that start exactly at the closing price. The spread widens with `σ · √(hours since close)`, because uncertainty grows with time. |
| **Halted** | When Nasdaq halts the stock, the keeper posts the halt on-chain and the program refuses swaps. Withdrawals keep working. |

The half-spread is

```
half_spread = base + z · σ · √(hours since the last trusted price)      (capped)
```

where `σ` is calibrated per stock from three years of its own price history, separately for open and closed hours. The widening cone this draws over a weekend is the bell curve in the name.

Every trade also passes these checks, all enforced by the program rather than the website:

- **Stale-price guard:** while open, a reference price older than the limit blocks trading.
- **Price band:** a fill too far from the reference price is refused, in both directions, like Nasdaq's limit-up/limit-down bands.
- **Inventory limits:** trades that would leave the pool almost all stock or almost all cash are refused.
- **Deposits need a fresh price:** new deposits are valued at the reference price, so they wait for an open market. Withdrawals work in every state.
- **Role checks:** only the keeper posts prices, only the admin changes settings, only the gatekeeper issues trader passes.

### Tokenized-stock native

Issuers such as xStocks handle dividends and splits with the Token-2022 **Scaled UI Amount** extension: token balances stay fixed and a multiplier changes. Bellcurve reads that multiplier inside the program on every trade, so a dividend or a split never misprices the pool.

### Built for the SEC's tokenized-stock exemption

On September 17, 2026 the SEC granted a five-year exemption for trading tokenized US stocks through permissioned AMMs on public blockchains. The conditions include synchronized trading halts, symbol and volume limits, access restricted to eligible traders, and public disclosure of trading activity. Bellcurve already has the plumbing:

| Exemption condition | In Bellcurve |
|---|---|
| Halts synchronized with the primary exchange | Keeper reads Nasdaq's halt feed; the program refuses swaps while halted |
| Volume limits | Per-pool daily volume cap enforced on-chain |
| Eligible participants only | Optional permissioned mode with gatekeeper-issued trader passes |
| Public trading activity | Every swap emits an on-chain event |
| Public, auditable contracts on a permissionless chain | Anchor program on Solana, source in this repo |

## Results

A backtest replays about three years of hourly SPY, QQQ, NVDA, TSLA, AAPL and MSTR prices, regular and extended hours, at one-minute resolution. Four pools start with the same $100,000, half stock and half cash:

- constant-product pools with a 0.30% and a 1.00% fee, the kind tokenized stocks trade on today
- an oracle-priced pool with no market-hours logic
- Bellcurve, running the exact pricing crate the on-chain program uses

Arbitrageurs see the true price every minute and trade any mispriced pool as far as it pays. While the market is closed, the true price follows a Brownian bridge to the next open, so informed traders learn the gap gradually, as 24/7 token markets do.

**What liquidity providers lose to informed traders** (LP value minus simply holding, % of starting capital, 2.9 years, 3 seeds, 2 s oracle delay):

| Stock | Constant-product 0.30% | Constant-product 1.00% | Oracle, no market hours | **Bellcurve** |
|---|---|---|---|---|
| SPY | −4.7% | −4.6% | −8.0% | **+0.6%** |
| QQQ | −5.9% | −6.1% | −21.9% | **−0.2%** |
| NVDA | −53.6% | −61.0% | −165.8% | **−11.9%** |
| TSLA | **+13.1%** | +10.5% | −74.5% | −1.9% |
| AAPL | −3.8% | −4.0% | −1.8% | **−0.2%** |
| MSTR | −5.1% | −2.5% | −235.7% | **+20.6%** |

Bellcurve's worst single weekend was under 0.01% of the pool on every stock; the oracle pool without market hours lost up to 2.1% in one weekend.

**What an ordinary trader pays** (average cost versus the true price, with realistic uninformed order flow):

| | Constant-product 0.30% | **Bellcurve** |
|---|---|---|
| Market open | 108–170 bps | **38–70 bps** |
| Market closed | 103–161 bps | 172–400 bps |

Closed-market trades cost more on Bellcurve on purpose: that is the price of real uncertainty, paid to the liquidity providers who carry it.

**Where it does not win.** TSLA is the one stock where the 0.30% constant-product pool did better. And the edge depends on fresh prices: with a 60-second oracle delay instead of 2 seconds, Bellcurve falls behind the 0.30% pool on NVDA (−61.7% vs −53.6%) and TSLA, while still ahead on the other four. Pyth and Chainlink publish every Solana slot, so production should run far below that.

The backtest is simulated and says nothing about future returns. Full results are in [`results/`](results/).

## Try it on devnet

The site ([`app/`](app/)) has four pages:

- **Landing** — the live NVDA pool at a glance, the headline results and how Bellcurve maps to the SEC exemption.
- **Trade** — a swap and liquidity card on the shared devnet NVDA pool, the live quote plotted against three years of real weekend gaps, and the on-chain trade tape. The swap preview shows the fill, or which rule will refuse the trade, before you sign.
- **Lab** — create a private test stock, test USDC and pool, then play every role: **Keeper** (open, close, halt, freeze the price feed), **Issuer** (stock dividend, 2-for-1 split), **Compliance** (permissioned mode, trader passes, volume cap), **Trader** (swaps, oversized orders, deposits, withdrawals) and **Attacker** (post a fake price to the shared pool). A checklist ticks off each of 11 behaviors as it is verified on devnet. Lab pools run at 60× speed, so a minute of closed market widens the spread like an hour does.
- **Research** — the backtest, the weekend-gap chart for all six stocks and Nasdaq's live halt feed.

Click **Connect** for a demo wallet kept in the browser (or Phantom on devnet), then **Get test tokens** from the same menu.

## Repository layout

| Path | What it is |
|---|---|
| [`programs/bellcurve/`](programs/bellcurve/) | Anchor program: pools, keeper updates, swaps, liquidity, trader passes. LiteSVM tests in `tests/` |
| [`crates/bellcurve-math/`](crates/bellcurve-math/) | Integer-only pricing math, shared by the program and the backtester |
| [`crates/backtest/`](crates/backtest/) | The backtester |
| [`ts/`](ts/) | Devnet setup, keeper, configuration and swap scripts |
| [`app/`](app/) | Next.js dashboard |
| [`scripts/`](scripts/) | Price-data download and dashboard-data build |
| [`data/raw/`](data/raw/) | Hourly price history used by the backtest |
| [`results/`](results/) | Backtest outputs, including oracle-latency sensitivity |
| [`deploy/devnet.json`](deploy/devnet.json) | Deployed devnet addresses |

### Program instructions

| Instruction | Signer | Purpose |
|---|---|---|
| `initialize_pool` | admin | Create a pool for a stock/USDC pair with its parameters, keeper and gatekeeper |
| `update_config` | admin | Change parameters, keeper, gatekeeper, permissioned mode and the daily volume cap |
| `update_market` | keeper | Post Open (with a price), Closed or Halted. Moving to Closed records the close time and sets the virtual reserves |
| `issue_pass` / `revoke_pass` | gatekeeper | Approve or remove a trader for a permissioned pool |
| `deposit` / `withdraw` | LP | Add liquidity at the reference price (fresh open market only, except the first deposit) or remove it pro rata (always) |
| `swap` | trader | Exact-input swap in either direction, priced by the market state |

## Run it locally

Requirements: Rust, the Solana CLI (4.x), Anchor CLI (1.1+), Node 24 and pnpm.

```bash
# Build and test the program (18 pricing tests, 10 program tests in LiteSVM)
anchor build
cargo test -p bellcurve-math
cargo test -p bellcurve --test test_bellcurve

# Reproduce the backtest (about 15 minutes)
python3 scripts/fetch_data.py
cargo run --release -p bellcurve-backtest -- --seeds=3 --flow-seeds=2
cargo run --release -p bellcurve-backtest -- --seeds=1 --flow-seeds=0 --latency=15 --out=results/latency_15s.json
cargo run --release -p bellcurve-backtest -- --seeds=1 --flow-seeds=0 --latency=60 --out=results/latency_60s.json

# Deploy to devnet and create a pool with test tokens
anchor deploy --provider.cluster devnet
cd ts && pnpm install
pnpm exec tsx src/setup.ts NVDA 100000   # test stock, test USDC, pool, liquidity
pnpm exec tsx src/keeper.ts              # keep the pool in sync with the real market
pnpm exec tsx src/swap.ts buy 100        # trade from the terminal

# Dashboard
cd ../app && pnpm install
python3 ../scripts/build_dashboard_data.py
pnpm build && pnpm start
```

The dashboard's faucet signs with the admin key: `~/.config/solana/id.json` locally, or the `ADMIN_KEYPAIR` environment variable (a JSON byte array) when deployed. `RPC_URL` and `NEXT_PUBLIC_RPC_URL` point the server and the browser at a dedicated RPC endpoint; the public devnet endpoint rate-limits quickly.

## Limitations and next steps

- **Oracle.** The demo keeper reads Yahoo Finance prints once a minute. Production would read Pyth or Chainlink, which publish every slot, and could require a fresh price update in the swap transaction itself.
- **One keeper.** A single key reports market state. Production needs redundant keepers and on-chain checks of the oracle's own market-status flags.
- **Permissioned access.** Trader passes are issued by a gatekeeper key. They could instead be verified against Solana Attestation Service credentials, so traders pass KYC once and trade on any venue.
- **Parameters.** Volatility is calibrated per stock from history and set by the admin. It could adapt automatically, for example widening ahead of earnings.
- **Unaudited.** This is hackathon code running on devnet with test tokens.
