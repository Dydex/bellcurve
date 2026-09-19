use anchor_lang::prelude::*;
use bellcurve_math::{Market, MarketState, Params};

/// Tunable pricing parameters; mirrors `bellcurve_math::Params`.
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, Debug, PartialEq, Eq, InitSpace)]
pub struct PoolParams {
    pub base_half_spread_bps: u32,
    pub sigma_open_bps: u32,
    pub sigma_closed_bps: u32,
    pub spread_z_bps: u32,
    pub max_half_spread_bps: u32,
    pub inventory_skew_bps: u32,
    pub target_base_weight_bps: u32,
    pub impact_bps: u32,
    pub fee_bps: u32,
    pub band_open_bps: u32,
    pub band_closed_bps: u32,
    pub min_base_weight_bps: u32,
    pub max_base_weight_bps: u32,
    pub max_staleness_secs: u32,
}

impl From<PoolParams> for Params {
    fn from(p: PoolParams) -> Self {
        Params {
            base_half_spread_bps: p.base_half_spread_bps,
            sigma_open_bps: p.sigma_open_bps,
            sigma_closed_bps: p.sigma_closed_bps,
            spread_z_bps: p.spread_z_bps,
            max_half_spread_bps: p.max_half_spread_bps,
            inventory_skew_bps: p.inventory_skew_bps,
            target_base_weight_bps: p.target_base_weight_bps,
            impact_bps: p.impact_bps,
            fee_bps: p.fee_bps,
            band_open_bps: p.band_open_bps,
            band_closed_bps: p.band_closed_bps,
            min_base_weight_bps: p.min_base_weight_bps,
            max_base_weight_bps: p.max_base_weight_bps,
            max_staleness_secs: p.max_staleness_secs,
        }
    }
}

/// Market status as reported by the keeper.
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, Debug, PartialEq, Eq, InitSpace)]
pub enum MarketStatus {
    Open,
    Closed,
    Halted,
}

impl From<MarketStatus> for MarketState {
    fn from(s: MarketStatus) -> Self {
        match s {
            MarketStatus::Open => MarketState::Open,
            MarketStatus::Closed => MarketState::Closed,
            MarketStatus::Halted => MarketState::Halted,
        }
    }
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, Debug, PartialEq, Eq, InitSpace)]
pub struct MarketData {
    pub status: MarketStatus,
    pub ref_price: u64,
    pub ref_ts: i64,
    pub close_ts: i64,
    /// Virtual constant-product reserves that price trades while closed.
    pub virtual_base: u64,
    pub virtual_quote: u64,
}

impl From<MarketData> for Market {
    fn from(m: MarketData) -> Self {
        Market {
            state: m.status.into(),
            ref_price: m.ref_price,
            ref_ts: m.ref_ts,
            close_ts: m.close_ts,
            virtual_base: m.virtual_base,
            virtual_quote: m.virtual_quote,
        }
    }
}

#[account]
#[derive(InitSpace)]
pub struct Pool {
    pub admin: Pubkey,
    /// Posts reference prices, market open/close and trading halts.
    pub keeper: Pubkey,
    /// Issues trader passes when the pool is permissioned.
    pub gatekeeper: Pubkey,
    pub base_mint: Pubkey,
    pub quote_mint: Pubkey,
    pub base_vault: Pubkey,
    pub quote_vault: Pubkey,
    pub lp_mint: Pubkey,
    pub params: PoolParams,
    pub market: MarketData,
    /// When true every trader and LP needs a valid `TraderPass`.
    pub permissioned: bool,
    /// Maximum traded value per UTC day in quote units; 0 disables the cap.
    pub daily_volume_cap: u64,
    pub volume_day: i64,
    pub volume_today: u64,
    pub total_volume: u64,
    pub total_fees: u64,
    pub bump: u8,
    pub lp_mint_bump: u8,
}

/// Proof that the gatekeeper approved `trader` for this pool (KYC / eligibility done off-chain).
#[account]
#[derive(InitSpace)]
pub struct TraderPass {
    pub pool: Pubkey,
    pub trader: Pubkey,
    pub expires_at: i64,
    pub bump: u8,
}
