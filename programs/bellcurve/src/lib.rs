pub mod constants;
pub mod error;
pub mod events;
pub mod instructions;
pub mod state;
pub mod utils;

use anchor_lang::prelude::*;

pub use constants::*;
pub use instructions::*;
pub use state::*;

declare_id!("3z63RQjfsQ4Wx3fvTe1dyrwcXr6qZmv95QFDut44FJeF");

/// Bellcurve: a market-hours-aware AMM for tokenized stocks.
#[program]
pub mod bellcurve {
    use super::*;

    pub fn initialize_pool(
        ctx: Context<InitializePool>,
        params: PoolParams,
        keeper: Pubkey,
        gatekeeper: Pubkey,
        permissioned: bool,
        daily_volume_cap: u64,
    ) -> Result<()> {
        instructions::initialize_pool::handle_initialize_pool(
            ctx,
            params,
            keeper,
            gatekeeper,
            permissioned,
            daily_volume_cap,
        )
    }

    pub fn update_config(
        ctx: Context<UpdateConfig>,
        params: PoolParams,
        keeper: Pubkey,
        gatekeeper: Pubkey,
        permissioned: bool,
        daily_volume_cap: u64,
    ) -> Result<()> {
        instructions::update_config::handle_update_config(
            ctx,
            params,
            keeper,
            gatekeeper,
            permissioned,
            daily_volume_cap,
        )
    }

    pub fn update_market(
        ctx: Context<UpdateMarket>,
        status: MarketStatus,
        ref_price: u64,
        observed_ts: i64,
    ) -> Result<()> {
        instructions::update_market::handle_update_market(ctx, status, ref_price, observed_ts)
    }

    pub fn issue_pass(ctx: Context<IssuePass>, trader: Pubkey, expires_at: i64) -> Result<()> {
        instructions::pass::handle_issue_pass(ctx, trader, expires_at)
    }

    pub fn revoke_pass(ctx: Context<RevokePass>) -> Result<()> {
        instructions::pass::handle_revoke_pass(ctx)
    }

    pub fn deposit(ctx: Context<Liquidity>, base_in: u64, quote_in: u64, min_lp_out: u64) -> Result<()> {
        instructions::liquidity::handle_deposit(ctx, base_in, quote_in, min_lp_out)
    }

    pub fn withdraw(ctx: Context<Liquidity>, shares: u64, min_base_out: u64, min_quote_out: u64) -> Result<()> {
        instructions::liquidity::handle_withdraw(ctx, shares, min_base_out, min_quote_out)
    }

    pub fn swap(ctx: Context<Swap>, side: u8, amount_in: u64, min_out: u64) -> Result<()> {
        instructions::swap::handle_swap(ctx, side, amount_in, min_out)
    }
}
