use anchor_lang::prelude::*;

#[constant]
pub const POOL_SEED: &[u8] = b"pool";

#[constant]
pub const LP_MINT_SEED: &[u8] = b"lp";

#[constant]
pub const PASS_SEED: &[u8] = b"pass";

/// LP mint decimals; one LP share is minted per quote unit of first-deposit value.
pub const LP_DECIMALS: u8 = 6;

/// How far in the future a keeper observation may be stamped (clock skew allowance).
pub const MAX_FUTURE_SKEW_SECS: i64 = 30;

pub const SECONDS_PER_DAY: i64 = 86_400;
