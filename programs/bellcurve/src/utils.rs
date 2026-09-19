use anchor_lang::prelude::*;
use anchor_spl::token_2022::spl_token_2022::{
    extension::{scaled_ui_amount::ScaledUiAmountConfig, BaseStateWithExtensions, StateWithExtensions},
    state::Mint as MintState,
};
use bellcurve_math::{BaseToken, MULTIPLIER_ONE};

use crate::{constants::SECONDS_PER_DAY, error::ErrorCode, state::{Pool, TraderPass}};

/// Share conversion for the base mint, including the Token-2022 Scaled UI Amount
/// multiplier that issuers such as xStocks use for dividends and splits.
pub fn base_token(mint: &AccountInfo, decimals: u8, now: i64) -> Result<BaseToken> {
    let plain = BaseToken { decimals, multiplier_e9: MULTIPLIER_ONE };
    if mint.owner != &anchor_spl::token_2022::ID {
        return Ok(plain);
    }
    let data = mint.try_borrow_data()?;
    let state = StateWithExtensions::<MintState>::unpack(&data)?;
    let Ok(config) = state.get_extension::<ScaledUiAmountConfig>() else {
        return Ok(plain);
    };
    let multiplier = if now >= i64::from(config.new_multiplier_effective_timestamp) {
        f64::from(config.new_multiplier)
    } else {
        f64::from(config.multiplier)
    };
    let scaled = multiplier * MULTIPLIER_ONE as f64;
    require!(scaled.is_finite() && scaled >= 1.0 && scaled <= u64::MAX as f64, ErrorCode::Overflow);
    Ok(BaseToken { decimals, multiplier_e9: scaled as u64 })
}

pub fn check_pass(pool: &Pool, pool_key: Pubkey, pass: Option<&TraderPass>, trader: Pubkey, now: i64) -> Result<()> {
    if !pool.permissioned {
        return Ok(());
    }
    let pass = pass.ok_or(ErrorCode::PassRequired)?;
    require!(
        pass.pool == pool_key && pass.trader == trader && pass.expires_at > now,
        ErrorCode::PassRequired
    );
    Ok(())
}

impl Pool {
    /// Adds a trade to today's volume and enforces the daily cap.
    pub fn record_volume(&mut self, now: i64, value: u64) -> Result<()> {
        let day = now.div_euclid(SECONDS_PER_DAY);
        if day != self.volume_day {
            self.volume_day = day;
            self.volume_today = 0;
        }
        let today = self.volume_today.checked_add(value).ok_or(ErrorCode::Overflow)?;
        require!(
            self.daily_volume_cap == 0 || today <= self.daily_volume_cap,
            ErrorCode::VolumeCapExceeded
        );
        self.volume_today = today;
        self.total_volume = self.total_volume.saturating_add(value);
        Ok(())
    }
}
