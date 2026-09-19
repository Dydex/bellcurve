use anchor_lang::prelude::*;
use anchor_spl::token_interface::{
    self, Burn, Mint, MintTo, TokenAccount, TokenInterface, TransferChecked,
};
use bellcurve_math::{virtual_reserves_at_close, Reserves};

use crate::{
    constants::POOL_SEED,
    error::{math_err, ErrorCode},
    events::LiquidityChanged,
    state::{MarketStatus, Pool, TraderPass},
    utils::{base_token, check_pass},
};

#[derive(Accounts)]
pub struct Liquidity<'info> {
    pub owner: Signer<'info>,
    #[account(
        mut,
        has_one = base_mint,
        has_one = quote_mint,
        has_one = base_vault,
        has_one = quote_vault,
        has_one = lp_mint
    )]
    pub pool: Box<Account<'info, Pool>>,
    pub base_mint: Box<InterfaceAccount<'info, Mint>>,
    pub quote_mint: Box<InterfaceAccount<'info, Mint>>,
    #[account(mut)]
    pub lp_mint: Box<InterfaceAccount<'info, Mint>>,
    #[account(mut)]
    pub base_vault: Box<InterfaceAccount<'info, TokenAccount>>,
    #[account(mut)]
    pub quote_vault: Box<InterfaceAccount<'info, TokenAccount>>,
    #[account(mut, token::mint = base_mint, token::token_program = base_token_program)]
    pub owner_base: Box<InterfaceAccount<'info, TokenAccount>>,
    #[account(mut, token::mint = quote_mint, token::token_program = quote_token_program)]
    pub owner_quote: Box<InterfaceAccount<'info, TokenAccount>>,
    #[account(mut, token::mint = lp_mint, token::token_program = lp_token_program)]
    pub owner_lp: Box<InterfaceAccount<'info, TokenAccount>>,
    /// Required for deposits into a permissioned pool.
    pub trader_pass: Option<Account<'info, TraderPass>>,
    pub base_token_program: Interface<'info, TokenInterface>,
    pub quote_token_program: Interface<'info, TokenInterface>,
    pub lp_token_program: Interface<'info, TokenInterface>,
}

/// Deposit any mix of base and quote, valued at the reference price. Only allowed while
/// the underlying market is open with a fresh price, so nobody can deposit at a stale mark.
/// The very first deposit can happen any time: with no other LPs there is nobody to dilute.
pub fn handle_deposit(ctx: Context<Liquidity>, base_in: u64, quote_in: u64, min_lp_out: u64) -> Result<()> {
    let now = Clock::get()?.unix_timestamp;
    let a = &ctx.accounts;
    let pool_key = a.pool.key();
    check_pass(&a.pool, pool_key, a.trader_pass.as_deref(), a.owner.key(), now)?;

    let params = a.pool.params.into();
    let market: bellcurve_math::Market = a.pool.market.into();
    if a.lp_mint.supply > 0 {
        bellcurve_math::require_fresh_open(&params, &market, now).map_err(math_err)?;
    } else {
        require!(market.ref_price > 0, ErrorCode::NoPrice);
    }

    let tok = base_token(&a.base_mint.to_account_info(), a.base_mint.decimals, now)?;
    let reserves = Reserves { base: a.base_vault.amount, quote: a.quote_vault.amount };
    let shares = bellcurve_math::lp_shares_for_deposit(
        &tok,
        &reserves,
        market.ref_price,
        a.lp_mint.supply,
        base_in,
        quote_in,
    )
    .map_err(math_err)?;
    require!(shares > 0 && shares >= min_lp_out, ErrorCode::SlippageExceeded);

    if base_in > 0 {
        token_interface::transfer_checked(
            CpiContext::new(
                a.base_token_program.key(),
                TransferChecked {
                    from: a.owner_base.to_account_info(),
                    mint: a.base_mint.to_account_info(),
                    to: a.base_vault.to_account_info(),
                    authority: a.owner.to_account_info(),
                },
            ),
            base_in,
            a.base_mint.decimals,
        )?;
    }
    if quote_in > 0 {
        token_interface::transfer_checked(
            CpiContext::new(
                a.quote_token_program.key(),
                TransferChecked {
                    from: a.owner_quote.to_account_info(),
                    mint: a.quote_mint.to_account_info(),
                    to: a.quote_vault.to_account_info(),
                    authority: a.owner.to_account_info(),
                },
            ),
            quote_in,
            a.quote_mint.decimals,
        )?;
    }

    let bump = [a.pool.bump];
    let seeds: &[&[u8]] = &[POOL_SEED, a.pool.base_mint.as_ref(), a.pool.quote_mint.as_ref(), &bump];
    token_interface::mint_to(
        CpiContext::new_with_signer(
            a.lp_token_program.key(),
            MintTo {
                mint: a.lp_mint.to_account_info(),
                to: a.owner_lp.to_account_info(),
                authority: a.pool.to_account_info(),
            },
            &[seeds],
        ),
        shares,
    )?;

    let owner = a.owner.key();
    let bootstrap = a.lp_mint.supply == 0;
    let pool = &mut ctx.accounts.pool;
    if bootstrap && pool.market.status == MarketStatus::Closed {
        // A pool seeded while closed starts its closed-market curve from the seed.
        let seeded = Reserves { base: reserves.base + base_in, quote: reserves.quote + quote_in };
        (pool.market.virtual_base, pool.market.virtual_quote) =
            virtual_reserves_at_close(&tok, &seeded, pool.market.ref_price).map_err(math_err)?;
    }

    emit!(LiquidityChanged {
        pool: pool_key,
        owner,
        deposit: true,
        base_amount: base_in,
        quote_amount: quote_in,
        lp_amount: shares,
    });
    Ok(())
}

/// Burn LP shares for a pro-rata slice of both reserves. Works in every market state,
/// including halts, so LPs can always exit.
pub fn handle_withdraw(ctx: Context<Liquidity>, shares: u64, min_base_out: u64, min_quote_out: u64) -> Result<()> {
    let a = &ctx.accounts;
    let reserves = Reserves { base: a.base_vault.amount, quote: a.quote_vault.amount };
    let (base_out, quote_out) =
        bellcurve_math::withdraw_amounts(&reserves, a.lp_mint.supply, shares).map_err(math_err)?;
    require!(
        base_out >= min_base_out && quote_out >= min_quote_out,
        ErrorCode::SlippageExceeded
    );

    token_interface::burn(
        CpiContext::new(
            a.lp_token_program.key(),
            Burn {
                mint: a.lp_mint.to_account_info(),
                from: a.owner_lp.to_account_info(),
                authority: a.owner.to_account_info(),
            },
        ),
        shares,
    )?;

    let bump = [a.pool.bump];
    let seeds: &[&[u8]] = &[POOL_SEED, a.pool.base_mint.as_ref(), a.pool.quote_mint.as_ref(), &bump];
    if base_out > 0 {
        token_interface::transfer_checked(
            CpiContext::new_with_signer(
                a.base_token_program.key(),
                TransferChecked {
                    from: a.base_vault.to_account_info(),
                    mint: a.base_mint.to_account_info(),
                    to: a.owner_base.to_account_info(),
                    authority: a.pool.to_account_info(),
                },
                &[seeds],
            ),
            base_out,
            a.base_mint.decimals,
        )?;
    }
    if quote_out > 0 {
        token_interface::transfer_checked(
            CpiContext::new_with_signer(
                a.quote_token_program.key(),
                TransferChecked {
                    from: a.quote_vault.to_account_info(),
                    mint: a.quote_mint.to_account_info(),
                    to: a.owner_quote.to_account_info(),
                    authority: a.pool.to_account_info(),
                },
                &[seeds],
            ),
            quote_out,
            a.quote_mint.decimals,
        )?;
    }

    let (pool_key, owner, supply) = (a.pool.key(), a.owner.key(), a.lp_mint.supply);
    let market = &mut ctx.accounts.pool.market;
    if market.status == MarketStatus::Closed {
        // The virtual curve shrinks with the pool so it never quotes more depth than exists.
        let keep = |v: u64| (v as u128 * (supply - shares) as u128 / supply as u128) as u64;
        market.virtual_base = keep(market.virtual_base);
        market.virtual_quote = keep(market.virtual_quote);
    }

    emit!(LiquidityChanged {
        pool: pool_key,
        owner,
        deposit: false,
        base_amount: base_out,
        quote_amount: quote_out,
        lp_amount: shares,
    });
    Ok(())
}
