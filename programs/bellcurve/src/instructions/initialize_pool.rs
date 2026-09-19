use anchor_lang::prelude::*;
use anchor_spl::{
    associated_token::AssociatedToken,
    token_interface::{Mint, TokenAccount, TokenInterface},
};
use bellcurve_math::Params;

use crate::{
    constants::*,
    error::{math_err, ErrorCode},
    state::{MarketData, MarketStatus, Pool, PoolParams},
};

#[derive(Accounts)]
pub struct InitializePool<'info> {
    #[account(mut)]
    pub admin: Signer<'info>,
    #[account(
        init,
        payer = admin,
        space = 8 + Pool::INIT_SPACE,
        seeds = [POOL_SEED, base_mint.key().as_ref(), quote_mint.key().as_ref()],
        bump
    )]
    pub pool: Box<Account<'info, Pool>>,
    #[account(mint::token_program = base_token_program)]
    pub base_mint: Box<InterfaceAccount<'info, Mint>>,
    #[account(mint::token_program = quote_token_program)]
    pub quote_mint: Box<InterfaceAccount<'info, Mint>>,
    #[account(
        init,
        payer = admin,
        seeds = [LP_MINT_SEED, pool.key().as_ref()],
        bump,
        mint::decimals = LP_DECIMALS,
        mint::authority = pool,
        mint::token_program = lp_token_program
    )]
    pub lp_mint: Box<InterfaceAccount<'info, Mint>>,
    #[account(
        init,
        payer = admin,
        associated_token::mint = base_mint,
        associated_token::authority = pool,
        associated_token::token_program = base_token_program
    )]
    pub base_vault: Box<InterfaceAccount<'info, TokenAccount>>,
    #[account(
        init,
        payer = admin,
        associated_token::mint = quote_mint,
        associated_token::authority = pool,
        associated_token::token_program = quote_token_program
    )]
    pub quote_vault: Box<InterfaceAccount<'info, TokenAccount>>,
    pub base_token_program: Interface<'info, TokenInterface>,
    pub quote_token_program: Interface<'info, TokenInterface>,
    pub lp_token_program: Interface<'info, TokenInterface>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
}

pub fn handle_initialize_pool(
    ctx: Context<InitializePool>,
    params: PoolParams,
    keeper: Pubkey,
    gatekeeper: Pubkey,
    permissioned: bool,
    daily_volume_cap: u64,
) -> Result<()> {
    Params::from(params).validate().map_err(math_err)?;
    require!(ctx.accounts.base_mint.key() != ctx.accounts.quote_mint.key(), ErrorCode::InvalidParams);

    let pool = &mut ctx.accounts.pool;
    pool.admin = ctx.accounts.admin.key();
    pool.keeper = keeper;
    pool.gatekeeper = gatekeeper;
    pool.base_mint = ctx.accounts.base_mint.key();
    pool.quote_mint = ctx.accounts.quote_mint.key();
    pool.base_vault = ctx.accounts.base_vault.key();
    pool.quote_vault = ctx.accounts.quote_vault.key();
    pool.lp_mint = ctx.accounts.lp_mint.key();
    pool.params = params;
    // Nothing trades until the keeper's first report.
    pool.market = MarketData {
        status: MarketStatus::Halted,
        ref_price: 0,
        ref_ts: 0,
        close_ts: 0,
        virtual_base: 0,
        virtual_quote: 0,
    };
    pool.permissioned = permissioned;
    pool.daily_volume_cap = daily_volume_cap;
    pool.volume_day = 0;
    pool.volume_today = 0;
    pool.total_volume = 0;
    pool.total_fees = 0;
    pool.bump = ctx.bumps.pool;
    pool.lp_mint_bump = ctx.bumps.lp_mint;
    Ok(())
}
