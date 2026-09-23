//! Actual-source, completed resident-prerequisite diagnostics.
//! No returned report authorizes dispatch, recovery, activation or publication.
mod collect;
mod evaluate;
mod inspection;
mod qualification;
#[cfg(test)]
mod tests;
mod value;

use serde_json::Value;
use std::{collections::BTreeMap, path::Path};

/// Inputs select actual sources. No report, public key or ready flag is accepted.
pub struct ResidentPrerequisiteInspectionOptions<'a> {
    pub runtime_root: &'a Path,
    pub repository_root: &'a Path,
    pub working_directory: &'a Path,
    pub environment: &'a BTreeMap<String, String>,
    pub external_qualification_config: Option<&'a Path>,
    pub external_action_recovery_config: Option<&'a Path>,
    pub now_millis: i64,
}

#[derive(Clone, Debug, PartialEq, Eq, thiserror::Error)]
#[error("{code}")]
pub struct Error {
    code: String,
}
impl Error {
    fn new(code: impl Into<String>) -> Self {
        Self { code: code.into() }
    }
    #[must_use]
    pub fn code(&self) -> &str {
        &self.code
    }
}
pub type Result<T> = std::result::Result<T, Error>;

/// Observe actual V3 configuration, stored qualification evidence, runtime status,
/// current code and recovery configuration, then derive the original diagnostic.
/// All retained configuration files close before any private SQLite snapshot.
/// Call before acquiring caller-owned business SQLite or database descriptors.
/// Source observations are sequential, not an atomic or continuing snapshot.
/// The inherited V3 observer hashes credential-root bytes; use only appropriate
/// actual configurations and do not mistake this for a public-data-only scanner.
pub fn inspect_autonomous_research_resident_prerequisites_v1(
    options: &ResidentPrerequisiteInspectionOptions<'_>,
) -> Result<Value> {
    let observation = collect::observe(options)?;
    evaluate::evaluate(&observation, options.now_millis)
}
