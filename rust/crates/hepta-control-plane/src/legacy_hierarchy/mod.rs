//! Preserved, incompatible historical hierarchy data contracts.
//!
//! Neither namespace is wired into [`crate::ControlPlaneV1`]. These mutable
//! in-memory models accept caller-provided observations and do not authorize
//! execution, settle unknown work, or recover charges across restart.
//! See `HANDOFF.md` for exact provenance and known failure limitations.

pub mod accounting_v1;
pub mod prepared_v1;

#[cfg(test)]
mod tests;
