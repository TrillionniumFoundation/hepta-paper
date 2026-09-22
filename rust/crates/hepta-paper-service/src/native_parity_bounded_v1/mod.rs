//! Explicit strict normalized-input contracts recovered during branch consolidation.
//!
//! These pure APIs have narrower input domains than the existing Node-parity
//! entrypoints. They do not replace those entrypoints or grant execution authority.
//! See HANDOFF.md for input bounds, source provenance, and test obligations.

pub mod campaign_policy;
pub mod campaign_slo;
pub mod inference;
