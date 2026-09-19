//! End-to-end tests of the compiled program in LiteSVM.
//!
//! Run `anchor build` (or `cargo build-sbf`) first so `target/deploy/bellcurve.so` exists.

use {
    anchor_lang::{
        prelude::Pubkey,
        solana_program::{clock::Clock, instruction::Instruction, system_instruction, system_program},
        AccountDeserialize, InstructionData, ToAccountMetas,
    },
    anchor_spl::{
        associated_token::{
            get_associated_token_address_with_program_id as ata,
            spl_associated_token_account::instruction::create_associated_token_account,
        },
        token::spl_token,
        token_2022::spl_token_2022::{
            self,
            extension::{scaled_ui_amount, ExtensionType},
            state::{Account as TokenAccountState, Mint as MintState},
        },
    },
    anchor_lang::solana_program::program_pack::Pack,
    bellcurve::{state::*, POOL_SEED, LP_MINT_SEED, PASS_SEED},
    litesvm::LiteSVM,
    solana_keypair::Keypair,
    solana_message::{Message, VersionedMessage},
    solana_signer::Signer,
    solana_transaction::versioned::VersionedTransaction,
};

const USD: u64 = 1_000_000;
const SHARE: u64 = 100_000_000;
/// Friday 2026-09-18 20:00 UTC (16:00 New York), a market close.
const FRIDAY_CLOSE: i64 = 1_789_761_600;

fn params() -> PoolParams {
    PoolParams {
        base_half_spread_bps: 5,
        sigma_open_bps: 100,
        sigma_closed_bps: 60,
        spread_z_bps: 10_000,
        max_half_spread_bps: 1_500,
        inventory_skew_bps: 100,
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

struct Env {
    svm: LiteSVM,
    admin: Keypair,
    keeper: Keypair,
    gatekeeper: Keypair,
    trader: Keypair,
    base_mint: Pubkey,
    quote_mint: Pubkey,
    pool: Pubkey,
    lp_mint: Pubkey,
}

impl Env {
    /// Pool for a Token-2022 stock with a Scaled UI Amount multiplier and a classic-token USDC.
    fn new(multiplier: f64, permissioned: bool, daily_volume_cap: u64) -> Self {
        let mut svm = LiteSVM::new();
        let bytes = include_bytes!(concat!(env!("CARGO_TARGET_TMPDIR"), "/../deploy/bellcurve.so"));
        svm.add_program(bellcurve::id(), bytes).unwrap();
        let (admin, keeper, gatekeeper, trader) = (Keypair::new(), Keypair::new(), Keypair::new(), Keypair::new());
        for k in [&admin, &keeper, &gatekeeper, &trader] {
            svm.airdrop(&k.pubkey(), 100_000_000_000).unwrap();
        }
        let mut env = Env {
            svm,
            admin,
            keeper,
            gatekeeper,
            trader,
            base_mint: Pubkey::default(),
            quote_mint: Pubkey::default(),
            pool: Pubkey::default(),
            lp_mint: Pubkey::default(),
        };
        env.set_time(FRIDAY_CLOSE - 3_600);
        env.base_mint = env.create_stock_mint(multiplier);
        env.quote_mint = env.create_usdc_mint();
        env.pool = Pubkey::find_program_address(
            &[POOL_SEED, env.base_mint.as_ref(), env.quote_mint.as_ref()],
            &bellcurve::id(),
        )
        .0;
        env.lp_mint = Pubkey::find_program_address(&[LP_MINT_SEED, env.pool.as_ref()], &bellcurve::id()).0;

        let ix = Instruction::new_with_bytes(
            bellcurve::id(),
            &bellcurve::instruction::InitializePool {
                params: params(),
                keeper: env.keeper.pubkey(),
                gatekeeper: env.gatekeeper.pubkey(),
                permissioned,
                daily_volume_cap,
            }
            .data(),
            bellcurve::accounts::InitializePool {
                admin: env.admin.pubkey(),
                pool: env.pool,
                base_mint: env.base_mint,
                quote_mint: env.quote_mint,
                lp_mint: env.lp_mint,
                base_vault: ata(&env.pool, &env.base_mint, &spl_token_2022::ID),
                quote_vault: ata(&env.pool, &env.quote_mint, &spl_token::ID),
                base_token_program: spl_token_2022::ID,
                quote_token_program: spl_token::ID,
                lp_token_program: spl_token::ID,
                associated_token_program: anchor_spl::associated_token::ID,
                system_program: system_program::ID,
            }
            .to_account_metas(None),
        );
        env.send(&[ix], &[&env.admin.insecure_clone()]).unwrap();

        // Admin and trader get token accounts and balances.
        for owner in [env.admin.pubkey(), env.trader.pubkey()] {
            env.create_ata(&owner, &env.base_mint.clone(), &spl_token_2022::ID);
            env.create_ata(&owner, &env.quote_mint.clone(), &spl_token::ID);
            env.create_ata(&owner, &env.lp_mint.clone(), &spl_token::ID);
            env.mint(&env.base_mint.clone(), &spl_token_2022::ID, &owner, 1_000 * SHARE);
            env.mint(&env.quote_mint.clone(), &spl_token::ID, &owner, 1_000_000 * USD);
        }
        env
    }

    fn set_time(&mut self, ts: i64) {
        let mut clock: Clock = self.svm.get_sysvar();
        clock.unix_timestamp = ts;
        clock.slot += 1;
        self.svm.set_sysvar(&clock);
        self.svm.expire_blockhash();
    }

    fn send(&mut self, ixs: &[Instruction], signers: &[&Keypair]) -> Result<(), String> {
        // A fresh blockhash per transaction, so identical swaps are not deduplicated.
        self.svm.expire_blockhash();
        let payer = signers[0].pubkey();
        let msg = Message::new_with_blockhash(ixs, Some(&payer), &self.svm.latest_blockhash());
        let tx = VersionedTransaction::try_new(VersionedMessage::Legacy(msg), signers).unwrap();
        self.svm.send_transaction(tx).map(|_| ()).map_err(|e| format!("{:?}\n{}", e.err, e.meta.logs.join("\n")))
    }

    fn create_stock_mint(&mut self, multiplier: f64) -> Pubkey {
        let mint = Keypair::new();
        let len = ExtensionType::try_calculate_account_len::<MintState>(&[ExtensionType::ScaledUiAmount]).unwrap();
        let admin = self.admin.insecure_clone();
        let ixs = [
            system_instruction::create_account(
                &admin.pubkey(),
                &mint.pubkey(),
                self.svm.minimum_balance_for_rent_exemption(len),
                len as u64,
                &spl_token_2022::ID,
            ),
            scaled_ui_amount::instruction::initialize(&spl_token_2022::ID, &mint.pubkey(), Some(admin.pubkey()), multiplier)
                .unwrap(),
            spl_token_2022::instruction::initialize_mint2(&spl_token_2022::ID, &mint.pubkey(), &admin.pubkey(), None, 8)
                .unwrap(),
        ];
        self.send(&ixs, &[&admin, &mint]).unwrap();
        mint.pubkey()
    }

    fn create_usdc_mint(&mut self) -> Pubkey {
        let mint = Keypair::new();
        let admin = self.admin.insecure_clone();
        let ixs = [
            system_instruction::create_account(
                &admin.pubkey(),
                &mint.pubkey(),
                self.svm.minimum_balance_for_rent_exemption(MintState::LEN),
                MintState::LEN as u64,
                &spl_token::ID,
            ),
            spl_token::instruction::initialize_mint2(&spl_token::ID, &mint.pubkey(), &admin.pubkey(), None, 6).unwrap(),
        ];
        self.send(&ixs, &[&admin, &mint]).unwrap();
        mint.pubkey()
    }

    fn create_ata(&mut self, owner: &Pubkey, mint: &Pubkey, program: &Pubkey) {
        let admin = self.admin.insecure_clone();
        let ix = create_associated_token_account(&admin.pubkey(), owner, mint, program);
        self.send(&[ix], &[&admin]).unwrap();
    }

    fn mint(&mut self, mint: &Pubkey, program: &Pubkey, owner: &Pubkey, amount: u64) {
        let admin = self.admin.insecure_clone();
        let ix = spl_token_2022::instruction::mint_to(program, mint, &ata(owner, mint, program), &admin.pubkey(), &[], amount)
            .unwrap();
        self.send(&[ix], &[&admin]).unwrap();
    }

    fn balance(&self, owner: &Pubkey, mint: &Pubkey, program: &Pubkey) -> u64 {
        let acc = self.svm.get_account(&ata(owner, mint, program)).unwrap();
        TokenAccountState::unpack_from_slice(&acc.data[..TokenAccountState::LEN]).unwrap().amount
    }

    fn pool_state(&self) -> Pool {
        let acc = self.svm.get_account(&self.pool).unwrap();
        Pool::try_deserialize(&mut acc.data.as_slice()).unwrap()
    }

    fn update_market_accounts(&self, keeper: Pubkey) -> bellcurve::accounts::UpdateMarket {
        bellcurve::accounts::UpdateMarket {
            keeper,
            pool: self.pool,
            base_mint: self.base_mint,
            base_vault: ata(&self.pool, &self.base_mint, &spl_token_2022::ID),
            quote_vault: ata(&self.pool, &self.quote_mint, &spl_token::ID),
        }
    }

    fn update_market(&mut self, status: MarketStatus, ref_price: u64, observed_ts: i64) -> Result<(), String> {
        let ix = Instruction::new_with_bytes(
            bellcurve::id(),
            &bellcurve::instruction::UpdateMarket { status, ref_price, observed_ts }.data(),
            self.update_market_accounts(self.keeper.pubkey()).to_account_metas(None),
        );
        let keeper = self.keeper.insecure_clone();
        self.send(&[ix], &[&keeper])
    }

    fn liquidity_accounts(&self, owner: &Pubkey, pass: Option<Pubkey>) -> bellcurve::accounts::Liquidity {
        bellcurve::accounts::Liquidity {
            owner: *owner,
            pool: self.pool,
            base_mint: self.base_mint,
            quote_mint: self.quote_mint,
            lp_mint: self.lp_mint,
            base_vault: ata(&self.pool, &self.base_mint, &spl_token_2022::ID),
            quote_vault: ata(&self.pool, &self.quote_mint, &spl_token::ID),
            owner_base: ata(owner, &self.base_mint, &spl_token_2022::ID),
            owner_quote: ata(owner, &self.quote_mint, &spl_token::ID),
            owner_lp: ata(owner, &self.lp_mint, &spl_token::ID),
            trader_pass: pass,
            base_token_program: spl_token_2022::ID,
            quote_token_program: spl_token::ID,
            lp_token_program: spl_token::ID,
        }
    }

    fn deposit(&mut self, owner: &Keypair, base_in: u64, quote_in: u64, pass: Option<Pubkey>) -> Result<(), String> {
        let ix = Instruction::new_with_bytes(
            bellcurve::id(),
            &bellcurve::instruction::Deposit { base_in, quote_in, min_lp_out: 0 }.data(),
            self.liquidity_accounts(&owner.pubkey(), pass).to_account_metas(None),
        );
        self.send(&[ix], &[owner])
    }

    fn withdraw(&mut self, owner: &Keypair, shares: u64) -> Result<(), String> {
        let ix = Instruction::new_with_bytes(
            bellcurve::id(),
            &bellcurve::instruction::Withdraw { shares, min_base_out: 0, min_quote_out: 0 }.data(),
            self.liquidity_accounts(&owner.pubkey(), None).to_account_metas(None),
        );
        self.send(&[ix], &[owner])
    }

    fn pass_address(&self, trader: &Pubkey) -> Pubkey {
        Pubkey::find_program_address(&[PASS_SEED, self.pool.as_ref(), trader.as_ref()], &bellcurve::id()).0
    }

    fn issue_pass(&mut self, trader: &Pubkey, expires_at: i64) {
        let ix = Instruction::new_with_bytes(
            bellcurve::id(),
            &bellcurve::instruction::IssuePass { trader: *trader, expires_at }.data(),
            bellcurve::accounts::IssuePass {
                gatekeeper: self.gatekeeper.pubkey(),
                pool: self.pool,
                pass: self.pass_address(trader),
                system_program: system_program::ID,
            }
            .to_account_metas(None),
        );
        let gk = self.gatekeeper.insecure_clone();
        self.send(&[ix], &[&gk]).unwrap();
    }

    /// Swap as the trader; returns the amount received.
    fn swap(&mut self, side: u8, amount_in: u64, pass: Option<Pubkey>) -> Result<u64, String> {
        let trader = self.trader.insecure_clone();
        let (out_mint, out_program) = if side == 0 {
            (self.quote_mint, spl_token::ID)
        } else {
            (self.base_mint, spl_token_2022::ID)
        };
        let before = self.balance(&trader.pubkey(), &out_mint, &out_program);
        let ix = Instruction::new_with_bytes(
            bellcurve::id(),
            &bellcurve::instruction::Swap { side, amount_in, min_out: 0 }.data(),
            bellcurve::accounts::Swap {
                trader: trader.pubkey(),
                pool: self.pool,
                base_mint: self.base_mint,
                quote_mint: self.quote_mint,
                base_vault: ata(&self.pool, &self.base_mint, &spl_token_2022::ID),
                quote_vault: ata(&self.pool, &self.quote_mint, &spl_token::ID),
                trader_base: ata(&trader.pubkey(), &self.base_mint, &spl_token_2022::ID),
                trader_quote: ata(&trader.pubkey(), &self.quote_mint, &spl_token::ID),
                trader_pass: pass,
                base_token_program: spl_token_2022::ID,
                quote_token_program: spl_token::ID,
            }
            .to_account_metas(None),
        );
        self.send(&[ix], &[&trader])?;
        Ok(self.balance(&trader.pubkey(), &out_mint, &out_program) - before)
    }

    /// Market open at $200 with a balanced $40k pool from the admin.
    fn seeded(multiplier: f64, permissioned: bool, cap: u64) -> Self {
        let mut env = Env::new(multiplier, permissioned, cap);
        let now = FRIDAY_CLOSE - 3_600;
        env.update_market(MarketStatus::Open, 200 * USD, now).unwrap();
        let admin = env.admin.insecure_clone();
        if permissioned {
            env.issue_pass(&admin.pubkey(), now + 86_400 * 30);
        }
        let pass = permissioned.then(|| env.pass_address(&admin.pubkey()));
        // 100 shares (at the multiplier) and $20k.
        let base = (100.0 * SHARE as f64 / multiplier) as u64;
        env.deposit(&admin, base, 20_000 * USD, pass).unwrap();
        env
    }
}

fn assert_err(res: Result<u64, String>, needle: &str) {
    match res {
        Ok(v) => panic!("expected {needle}, got Ok({v})"),
        Err(e) => assert!(e.contains(needle), "expected {needle}, got {e}"),
    }
}

#[test]
fn open_market_swaps_both_ways_near_reference() {
    let mut env = Env::seeded(1.0, false, 0);
    // Sell one share: bid is $200 less 5 bps base spread and the staleness term, less impact and fee.
    let got = env.swap(0, SHARE, None).unwrap();
    assert!(got > 198 * USD && got < 200 * USD, "sell 1 share got {got}");
    // Buy with $200: slightly under one share.
    let got = env.swap(1, 200 * USD, None).unwrap();
    assert!(got > 98 * SHARE / 100 && got < SHARE, "buy $200 got {got}");
    let pool = env.pool_state();
    assert!(pool.total_volume > 398 * USD);
    assert!(pool.total_fees > 0);
}

#[test]
fn halted_market_rejects_swaps() {
    let mut env = Env::seeded(1.0, false, 0);
    env.set_time(FRIDAY_CLOSE - 3_000);
    env.update_market(MarketStatus::Halted, 0, FRIDAY_CLOSE - 3_000).unwrap();
    assert_err(env.swap(0, SHARE, None), "Halted");
    env.set_time(FRIDAY_CLOSE - 2_900);
    env.update_market(MarketStatus::Open, 201 * USD, FRIDAY_CLOSE - 2_900).unwrap();
    assert!(env.swap(0, SHARE, None).is_ok());
}

#[test]
fn stale_reference_price_is_refused() {
    let mut env = Env::seeded(1.0, false, 0);
    env.set_time(FRIDAY_CLOSE - 3_600 + 121);
    assert_err(env.swap(0, SHARE, None), "StalePrice");
}

#[test]
fn weekend_spread_widens_with_time_since_close() {
    let mut env = Env::seeded(1.0, false, 0);
    env.set_time(FRIDAY_CLOSE);
    env.update_market(MarketStatus::Closed, 200 * USD, FRIDAY_CLOSE).unwrap();

    env.set_time(FRIDAY_CLOSE + 3_600);
    let one_hour = env.swap(0, SHARE, None).unwrap();
    env.set_time(FRIDAY_CLOSE + 36 * 3_600);
    let saturday = env.swap(0, SHARE, None).unwrap();
    env.set_time(FRIDAY_CLOSE + 60 * 3_600);
    let sunday_night = env.swap(0, SHARE, None).unwrap();

    assert!(one_hour > saturday && saturday > sunday_night, "{one_hour} {saturday} {sunday_night}");
    // 60h after close: 5 + 60 * sqrt(60) = ~470 bps half-spread, so well under $191.
    assert!(sunday_night < 191 * USD, "sunday night bid {sunday_night}");
}

#[test]
fn deposits_are_refused_while_closed_but_withdrawals_always_work() {
    let mut env = Env::seeded(1.0, false, 0);
    env.set_time(FRIDAY_CLOSE);
    env.update_market(MarketStatus::Closed, 0, FRIDAY_CLOSE).unwrap();
    env.set_time(FRIDAY_CLOSE + 7_200);
    let admin = env.admin.insecure_clone();
    let err = env.deposit(&admin, 0, 1_000 * USD, None).unwrap_err();
    assert!(err.contains("StalePrice"), "{err}");

    let lp = env.balance(&admin.pubkey(), &env.lp_mint.clone(), &spl_token::ID);
    env.update_market(MarketStatus::Halted, 0, FRIDAY_CLOSE + 7_200).unwrap();
    env.withdraw(&admin, lp / 2).unwrap();
    assert_eq!(env.balance(&admin.pubkey(), &env.lp_mint.clone(), &spl_token::ID), lp - lp / 2);
}

#[test]
fn first_deposit_can_bootstrap_a_pool_while_closed() {
    let mut env = Env::new(1.0, false, 0);
    env.set_time(FRIDAY_CLOSE + 7_200);
    env.update_market(MarketStatus::Closed, 200 * USD, FRIDAY_CLOSE).unwrap();
    assert_eq!(env.pool_state().market.close_ts, FRIDAY_CLOSE);
    let admin = env.admin.insecure_clone();
    env.deposit(&admin, 100 * SHARE, 20_000 * USD, None).unwrap();
    // A second LP would be valued at a stale mark, so it has to wait for the open.
    let err = env.deposit(&admin, 0, 1_000 * USD, None).unwrap_err();
    assert!(err.contains("StalePrice"), "{err}");
}

#[test]
fn permissioned_pool_requires_a_valid_pass() {
    let mut env = Env::seeded(1.0, true, 0);
    assert_err(env.swap(0, SHARE, None), "PassRequired");

    let trader = env.trader.pubkey();
    env.issue_pass(&trader, FRIDAY_CLOSE + 86_400);
    let pass = env.pass_address(&trader);
    assert!(env.swap(0, SHARE, Some(pass)).is_ok());

    // Someone else's pass does not work.
    let admin_pass = env.pass_address(&env.admin.pubkey());
    assert_err(env.swap(0, SHARE, Some(admin_pass)), "PassRequired");
}

#[test]
fn scaled_ui_multiplier_prices_raw_units_as_shares() {
    // After a 2-for-1 split style multiplier, one raw "share" of token is two real shares.
    let mut env = Env::seeded(2.0, false, 0);
    let got = env.swap(0, SHARE / 2, None).unwrap();
    assert!(got > 198 * USD && got < 200 * USD, "half a raw share at 2x should fetch ~one share of value, got {got}");
}

#[test]
fn daily_volume_cap_is_enforced() {
    let mut env = Env::seeded(1.0, false, 500 * USD);
    env.swap(0, SHARE, None).unwrap();
    env.swap(0, SHARE, None).unwrap();
    assert_err(env.swap(0, SHARE, None), "VolumeCapExceeded");
    // Next UTC day the counter resets.
    env.set_time(FRIDAY_CLOSE - 3_600 + 86_400);
    env.update_market(MarketStatus::Open, 200 * USD, FRIDAY_CLOSE - 3_600 + 86_400).unwrap();
    assert!(env.swap(0, SHARE, None).is_ok());
}

#[test]
fn only_the_keeper_can_move_the_market() {
    let mut env = Env::seeded(1.0, false, 0);
    let ix = Instruction::new_with_bytes(
        bellcurve::id(),
        &bellcurve::instruction::UpdateMarket { status: MarketStatus::Open, ref_price: 1, observed_ts: FRIDAY_CLOSE - 3_600 }
            .data(),
        env.update_market_accounts(env.trader.pubkey()).to_account_metas(None),
    );
    let trader = env.trader.insecure_clone();
    let err = env.send(&[ix], &[&trader]).unwrap_err();
    assert!(err.contains("ConstraintHasOne") || err.contains("has one"), "{err}");
    assert_eq!(env.pool_state().market.ref_price, 200 * USD);
}
