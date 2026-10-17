//! Installed maintenance composes existing migration and recovery kernels.
//! A root-owned, independently pinned profile restricts the host effects; it
//! does not confer research qualification, publication or submission authority.
mod authority_journal;
mod barrier;
mod cgroup;
mod control;
pub(in crate::online_schema_execution) mod execution;
pub mod installation;
mod journal;
mod original;
mod research_view;
pub(crate) mod systemd;

use super::plan::ObservedSchemaTransitionPlanV1;
use crate::sqlite_mutation_coordinator::{Result, error, sha};
use serde_json::json;
use std::path::PathBuf;

/// Internal subject for durable barriers. Neither JSON nor a CLI confirmation
/// can construct the physical system-manager/cgroup maintenance guard.
pub(crate) struct SchemaOperationIdentityV1 {
    pub(crate) runtime_root: PathBuf,
    pub(crate) transition_id: String,
    pub(crate) plan_hash: String,
    pub(crate) profile_sha256: String,
    pub(crate) barrier_root: PathBuf,
}
impl SchemaOperationIdentityV1 {
    pub(crate) fn for_plan(
        profile: &installation::ObservedInstalledSchemaProfileV1,
        plan: &ObservedSchemaTransitionPlanV1,
    ) -> Result<Self> {
        profile.assert_current()?;
        plan.assert_current()?;
        let transition_id = plan.value()["transitionId"].as_str().ok_or_else(invalid)?;
        let plan_hash = plan.value()["planHash"].as_str().ok_or_else(invalid)?;
        if plan.normalization_root() != profile.runtime_root() {
            return Err(invalid());
        }
        Self::from_pins(profile, transition_id, plan_hash)
    }
    pub(crate) fn from_pins(
        profile: &installation::ObservedInstalledSchemaProfileV1,
        transition_id: &str,
        plan_hash: &str,
    ) -> Result<Self> {
        profile.assert_current()?;
        if !sha(&json!(transition_id)) || !sha(&json!(plan_hash)) {
            return Err(invalid());
        }
        Ok(Self {
            runtime_root: profile.runtime_root().to_owned(),
            transition_id: transition_id.to_owned(),
            plan_hash: plan_hash.to_owned(),
            profile_sha256: profile.profile_sha256().to_owned(),
            barrier_root: PathBuf::from("/var/lib/hepta-paper-maintenance/schema-v1")
                .join(transition_id.trim_start_matches("sha256:")),
        })
    }
}
fn invalid() -> crate::sqlite_mutation_coordinator::SqliteMutationCoordinatorError {
    error("autonomous_research_installed_schema_operation_subject_invalid")
}
