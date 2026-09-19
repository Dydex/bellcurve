use anchor_lang::prelude::*;
use bellcurve_math::MathError;

#[error_code]
pub enum ErrorCode {
    #[msg("Trading in the underlying stock is halted")]
    Halted,
    #[msg("Reference price is too old to trade against")]
    StalePrice,
    #[msg("No reference price has been posted yet")]
    NoPrice,
    #[msg("Execution price is outside the allowed price band")]
    OutsideBand,
    #[msg("Trade would push pool inventory past its limit")]
    InventoryLimit,
    #[msg("Not enough liquidity in the pool")]
    InsufficientLiquidity,
    #[msg("Amount must be greater than zero")]
    ZeroAmount,
    #[msg("Pool has no liquidity")]
    EmptyPool,
    #[msg("Arithmetic overflow")]
    Overflow,
    #[msg("Invalid pool parameters")]
    InvalidParams,
    #[msg("Output is below the minimum requested")]
    SlippageExceeded,
    #[msg("Daily volume cap reached")]
    VolumeCapExceeded,
    #[msg("This pool is permissioned and the trader pass is missing or expired")]
    PassRequired,
    #[msg("Observation timestamp is invalid")]
    InvalidTimestamp,
    #[msg("Invalid side")]
    InvalidSide,
}

impl From<MathError> for ErrorCode {
    fn from(e: MathError) -> Self {
        match e {
            MathError::Halted => ErrorCode::Halted,
            MathError::StalePrice => ErrorCode::StalePrice,
            MathError::NoPrice => ErrorCode::NoPrice,
            MathError::OutsideBand => ErrorCode::OutsideBand,
            MathError::InventoryLimit => ErrorCode::InventoryLimit,
            MathError::InsufficientLiquidity => ErrorCode::InsufficientLiquidity,
            MathError::ZeroAmount => ErrorCode::ZeroAmount,
            MathError::EmptyPool => ErrorCode::EmptyPool,
            MathError::Overflow => ErrorCode::Overflow,
            MathError::InvalidParams => ErrorCode::InvalidParams,
        }
    }
}

/// Lets handlers write `bellcurve_math::swap(..).map_err(math_err)?`.
pub fn math_err(e: MathError) -> Error {
    ErrorCode::from(e).into()
}
