use anchor_lang::prelude::*;
use anchor_spl::token_interface::{Mint, TokenAccount};
use bellcurve_math::{virtual_reserves_at_close, Reserves};

use crate::{
    constants::MAX_FUTURE_SKEW_SECS,
    error::ErrorCode,
    events::MarketUpdated,
    state::{MarketStatus, Pool},
    utils::base_token,
};

#[derive(Accounts)]
pub struct UpdateMarket<'info> {
    pub keeper: Signer<'info>,
    #[account(mut, has_one = keeper, has_one = base_mint, has_one = base_vault, has_one = quote_vault)]
    pub pool: Account<'info, Pool>,
    pub base_mint: Box<InterfaceAccount<'info, Mint>>,
    pub base_vault: Box<InterfaceAccount<'info, TokenAccount>>,
    pub quote_vault: Box<InterfaceAccount<'info, TokenAccount>>,
}

/// Keeper report: the underlying market's status and (optionally) a new reference price.
///
/// `ref_price == 0` keeps the previous price, which is how a halt or a close is posted
/// without inventing a new price. Moving into `Closed` records the close time, which
/// drives the overnight/weekend spread, and sets the virtual reserves that price trades
/// until the reopen, starting exactly at the closing price.
pub fn handle_update_market(
    ctx: Context<UpdateMarket>,
    status: MarketStatus,
    ref_price: u64,
    observed_ts: i64,
) -> Result<()> {
    let now = Clock::get()?.unix_timestamp;
    let a = &ctx.accounts;
    let pool_key = a.pool.key();
    let tok = base_token(&a.base_mint.to_account_info(), a.base_mint.decimals, now)?;
    let reserves = Reserves { base: a.base_vault.amount, quote: a.quote_vault.amount };

    let market = &mut ctx.accounts.pool.market;
    require!(observed_ts <= now + MAX_FUTURE_SKEW_SECS, ErrorCode::InvalidTimestamp);
    require!(observed_ts >= market.ref_ts, ErrorCode::InvalidTimestamp);

    if ref_price > 0 {
        market.ref_price = ref_price;
        market.ref_ts = observed_ts;
    }
    if status == MarketStatus::Closed && market.status != MarketStatus::Closed {
        market.close_ts = observed_ts;
        // An empty pool gets its virtual reserves from its first deposit instead.
        (market.virtual_base, market.virtual_quote) =
            virtual_reserves_at_close(&tok, &reserves, market.ref_price).unwrap_or((0, 0));
    }
    market.status = status;

    emit!(MarketUpdated {
        pool: pool_key,
        status,
        ref_price: market.ref_price,
        ref_ts: market.ref_ts,
        close_ts: market.close_ts,
    });
    Ok(())
}
