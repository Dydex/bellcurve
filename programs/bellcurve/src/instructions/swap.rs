use anchor_lang::prelude::*;
use anchor_spl::token_interface::{self, Mint, TokenAccount, TokenInterface, TransferChecked};
use bellcurve_math::{Reserves, Side};

use crate::{
    constants::POOL_SEED,
    error::{math_err, ErrorCode},
    events::SwapExecuted,
    state::{MarketStatus, Pool, TraderPass},
    utils::{base_token, check_pass},
};

#[derive(Accounts)]
pub struct Swap<'info> {
    pub trader: Signer<'info>,
    #[account(
        mut,
        has_one = base_mint,
        has_one = quote_mint,
        has_one = base_vault,
        has_one = quote_vault
    )]
    pub pool: Box<Account<'info, Pool>>,
    pub base_mint: Box<InterfaceAccount<'info, Mint>>,
    pub quote_mint: Box<InterfaceAccount<'info, Mint>>,
    #[account(mut)]
    pub base_vault: Box<InterfaceAccount<'info, TokenAccount>>,
    #[account(mut)]
    pub quote_vault: Box<InterfaceAccount<'info, TokenAccount>>,
    #[account(mut, token::mint = base_mint, token::token_program = base_token_program)]
    pub trader_base: Box<InterfaceAccount<'info, TokenAccount>>,
    #[account(mut, token::mint = quote_mint, token::token_program = quote_token_program)]
    pub trader_quote: Box<InterfaceAccount<'info, TokenAccount>>,
    /// Required only when the pool is permissioned.
    pub trader_pass: Option<Account<'info, TraderPass>>,
    pub base_token_program: Interface<'info, TokenInterface>,
    pub quote_token_program: Interface<'info, TokenInterface>,
}

/// Exact-input swap. `side`: 0 = sell base for quote, 1 = buy base with quote.
pub fn handle_swap(ctx: Context<Swap>, side: u8, amount_in: u64, min_out: u64) -> Result<()> {
    let now = Clock::get()?.unix_timestamp;
    let side = match side {
        0 => Side::SellBase,
        1 => Side::BuyBase,
        _ => return err!(ErrorCode::InvalidSide),
    };
    let a = &ctx.accounts;
    let pool_key = a.pool.key();
    check_pass(&a.pool, pool_key, a.trader_pass.as_deref(), a.trader.key(), now)?;

    let tok = base_token(&a.base_mint.to_account_info(), a.base_mint.decimals, now)?;
    let reserves = Reserves { base: a.base_vault.amount, quote: a.quote_vault.amount };
    let params = a.pool.params.into();
    let market = a.pool.market.into();
    let res = bellcurve_math::swap(&params, &market, &tok, &reserves, now, side, amount_in)
        .map_err(math_err)?;
    require!(res.amount_out >= min_out, ErrorCode::SlippageExceeded);

    let trade_value = match side {
        Side::SellBase => res.amount_out.checked_add(res.fee).ok_or(ErrorCode::Overflow)?,
        Side::BuyBase => amount_in,
    };

    let base_mint_key = a.pool.base_mint;
    let quote_mint_key = a.pool.quote_mint;
    let bump = [a.pool.bump];
    let seeds: &[&[u8]] = &[POOL_SEED, base_mint_key.as_ref(), quote_mint_key.as_ref(), &bump];
    let signer = &[seeds];

    let (in_from, in_to, in_mint, in_program, in_decimals, out_from, out_to, out_mint, out_program, out_decimals) =
        match side {
            Side::SellBase => (
                a.trader_base.to_account_info(),
                a.base_vault.to_account_info(),
                a.base_mint.to_account_info(),
                a.base_token_program.key(),
                a.base_mint.decimals,
                a.quote_vault.to_account_info(),
                a.trader_quote.to_account_info(),
                a.quote_mint.to_account_info(),
                a.quote_token_program.key(),
                a.quote_mint.decimals,
            ),
            Side::BuyBase => (
                a.trader_quote.to_account_info(),
                a.quote_vault.to_account_info(),
                a.quote_mint.to_account_info(),
                a.quote_token_program.key(),
                a.quote_mint.decimals,
                a.base_vault.to_account_info(),
                a.trader_base.to_account_info(),
                a.base_mint.to_account_info(),
                a.base_token_program.key(),
                a.base_mint.decimals,
            ),
        };

    token_interface::transfer_checked(
        CpiContext::new(
            in_program,
            TransferChecked {
                from: in_from,
                mint: in_mint,
                to: in_to,
                authority: a.trader.to_account_info(),
            },
        ),
        amount_in,
        in_decimals,
    )?;
    token_interface::transfer_checked(
        CpiContext::new_with_signer(
            out_program,
            TransferChecked {
                from: out_from,
                mint: out_mint,
                to: out_to,
                authority: a.pool.to_account_info(),
            },
            signer,
        ),
        res.amount_out,
        out_decimals,
    )?;

    let trader = a.trader.key();
    let pool = &mut ctx.accounts.pool;
    pool.record_volume(now, trade_value)?;
    pool.total_fees = pool.total_fees.saturating_add(res.fee);
    if pool.market.status == MarketStatus::Closed {
        // The trade moved the closed-market curve; the next trade starts from here.
        (pool.market.virtual_base, pool.market.virtual_quote) = res.virtual_after;
    }

    emit!(SwapExecuted {
        pool: pool_key,
        trader,
        side: side as u8,
        amount_in,
        amount_out: res.amount_out,
        exec_price: res.exec_price,
        ref_price: pool.market.ref_price,
        fee: res.fee,
        half_spread_bps: res.quote.half_spread_bps,
        skew_bps: res.quote.skew_bps,
        impact_bps: res.impact_bps,
        status: pool.market.status,
        ts: now,
    });
    Ok(())
}
