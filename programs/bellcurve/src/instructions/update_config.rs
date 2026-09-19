use anchor_lang::prelude::*;
use bellcurve_math::Params;

use crate::{
    error::math_err,
    state::{Pool, PoolParams},
};

#[derive(Accounts)]
pub struct UpdateConfig<'info> {
    pub admin: Signer<'info>,
    #[account(mut, has_one = admin)]
    pub pool: Account<'info, Pool>,
}

pub fn handle_update_config(
    ctx: Context<UpdateConfig>,
    params: PoolParams,
    keeper: Pubkey,
    gatekeeper: Pubkey,
    permissioned: bool,
    daily_volume_cap: u64,
) -> Result<()> {
    Params::from(params).validate().map_err(math_err)?;
    let pool = &mut ctx.accounts.pool;
    pool.params = params;
    pool.keeper = keeper;
    pool.gatekeeper = gatekeeper;
    pool.permissioned = permissioned;
    pool.daily_volume_cap = daily_volume_cap;
    Ok(())
}
