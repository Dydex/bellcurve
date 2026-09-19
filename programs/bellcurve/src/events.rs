use anchor_lang::prelude::*;

use crate::state::MarketStatus;

#[event]
pub struct MarketUpdated {
    pub pool: Pubkey,
    pub status: MarketStatus,
    pub ref_price: u64,
    pub ref_ts: i64,
    pub close_ts: i64,
}

/// Every trade is public: this is the venue's trade tape.
#[event]
pub struct SwapExecuted {
    pub pool: Pubkey,
    pub trader: Pubkey,
    /// 0 = sell base, 1 = buy base
    pub side: u8,
    pub amount_in: u64,
    pub amount_out: u64,
    pub exec_price: u64,
    pub ref_price: u64,
    pub fee: u64,
    pub half_spread_bps: u32,
    pub skew_bps: i32,
    pub impact_bps: u32,
    pub status: MarketStatus,
    pub ts: i64,
}

#[event]
pub struct LiquidityChanged {
    pub pool: Pubkey,
    pub owner: Pubkey,
    pub deposit: bool,
    pub base_amount: u64,
    pub quote_amount: u64,
    pub lp_amount: u64,
}
