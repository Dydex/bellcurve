use anchor_lang::prelude::*;

use crate::{
    constants::PASS_SEED,
    state::{Pool, TraderPass},
};

#[derive(Accounts)]
#[instruction(trader: Pubkey)]
pub struct IssuePass<'info> {
    #[account(mut)]
    pub gatekeeper: Signer<'info>,
    #[account(has_one = gatekeeper)]
    pub pool: Account<'info, Pool>,
    #[account(
        init,
        payer = gatekeeper,
        space = 8 + TraderPass::INIT_SPACE,
        seeds = [PASS_SEED, pool.key().as_ref(), trader.as_ref()],
        bump
    )]
    pub pass: Account<'info, TraderPass>,
    pub system_program: Program<'info, System>,
}

/// The gatekeeper has checked eligibility off-chain (KYC, jurisdiction, sanctions).
pub fn handle_issue_pass(ctx: Context<IssuePass>, trader: Pubkey, expires_at: i64) -> Result<()> {
    let pass = &mut ctx.accounts.pass;
    pass.pool = ctx.accounts.pool.key();
    pass.trader = trader;
    pass.expires_at = expires_at;
    pass.bump = ctx.bumps.pass;
    Ok(())
}

#[derive(Accounts)]
pub struct RevokePass<'info> {
    #[account(mut)]
    pub gatekeeper: Signer<'info>,
    #[account(has_one = gatekeeper)]
    pub pool: Account<'info, Pool>,
    #[account(mut, has_one = pool, close = gatekeeper)]
    pub pass: Account<'info, TraderPass>,
}

pub fn handle_revoke_pass(_ctx: Context<RevokePass>) -> Result<()> {
    Ok(())
}
