//! Pure, closed native reconciliation epoch encoding. This is not admission:
//! typed State values and digests confer no authority. The owning callback must
//! supply the actual locked state and retained external enrollment, verify their
//! currentness, and separately bind the signed authorization and its receipt.
use crate::{
    automation_runtime_reconciliation::{
        LOCAL_RECONCILIATION_WRITER_ID_V1, RECONCILIATION_WRITER_SCOPE_V1,
    },
    sqlite_mutation_coordinator::{Result, error},
};
use hepta_codex_protocol::Sha256Digest;
use hepta_control_plane::canonical_hash_v1;
use hepta_cutover::{DurableCutoverModeV1, DurableCutoverPhaseV1, DurableCutoverStateV1};
use serde::Serialize;
use std::path::{Component, Path};

const MAX_SAFE_INTEGER: u64 = 9_007_199_254_740_991;
fn rejected() -> crate::sqlite_mutation_coordinator::SqliteMutationCoordinatorError {
    error("autonomous_research_online_native_durable_epoch_invalid")
}
fn identifier(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 128
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.' | b':'))
}
fn positive_safe(value: u64) -> bool {
    (1..=MAX_SAFE_INTEGER).contains(&value)
}
/// Lexical shape only: no filesystem observation, canonicalization or I/O is
/// permitted here. The genuine external-storage observer establishes provenance.
fn canonical_shape(path: &Path) -> Result<&str> {
    let text = path.to_str().ok_or_else(rejected)?;
    if !path.is_absolute()
        || text.contains('\0')
        || path
            .components()
            .any(|part| !matches!(part, Component::RootDir | Component::Normal(_)))
        || path
            .components()
            .collect::<std::path::PathBuf>()
            .as_os_str()
            != path.as_os_str()
    {
        return Err(rejected());
    }
    Ok(text)
}

/// Source-owned typed field order is part of the native digest contract.
/// Authorization/configuration hashes, activation receipts, expiry and caller
/// readiness are deliberately absent: configuration includes this epoch, and
/// the authorization signs that configuration plus this initial lease hash.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct NativeDurableEpochBodyV1<'a> {
    domain: &'static str,
    version: u16,
    cutover_id: &'a str,
    database_path: &'a str,
    external_storage_root: &'a str,
    external_storage_enrollment_hash: &'a Sha256Digest,
    mode: DurableCutoverModeV1,
    phase: DurableCutoverPhaseV1,
    old_writer_id: &'a str,
    new_writer_id: &'a str,
    writer_id: &'a str,
    generation: u64,
    token: &'a str,
    revision: u64,
    shadow_cases: u64,
    shadow_mismatches: u64,
    scope: &'static str,
}

/// Shared signer preview/runtime derivation, never a permission constructor.
/// Runtime callers must derive inside the existing external writer callback;
/// plain arguments cannot prove that a journal lock or genuine enrollment exists.
/// production_activation is a predicate only; the separately verified receipt
/// must be checked by the owning caller, avoiding a circular signed hash.
pub(super) fn native_reconciliation_durable_epoch_hash_v1(
    state: &DurableCutoverStateV1,
    external_root: &Path,
    external_enrollment_hash: &Sha256Digest,
) -> Result<Sha256Digest> {
    let writer = state.writer_id.as_deref().ok_or_else(rejected)?;
    if state.version != 1
        || state.mode != DurableCutoverModeV1::Production
        || state.phase != DurableCutoverPhaseV1::Canary
        || !state.production_activation
        || state.new_writer_id != LOCAL_RECONCILIATION_WRITER_ID_V1
        || writer != LOCAL_RECONCILIATION_WRITER_ID_V1
        || !identifier(&state.cutover_id)
        || !identifier(&state.old_writer_id)
        || state.old_writer_id == state.new_writer_id
        || !positive_safe(state.generation)
        || !positive_safe(state.revision)
        || state.token != format!("{}:{}", state.cutover_id, state.generation)
        || !positive_safe(state.shadow_cases)
        || state.shadow_mismatches != 0
        || state.canary_scopes.as_slice() != [RECONCILIATION_WRITER_SCOPE_V1]
    {
        return Err(rejected());
    }
    let database = Path::new(&state.database_path);
    let database_path = canonical_shape(database)?;
    let external_storage_root = canonical_shape(external_root)?;
    let database_parent = database.parent().ok_or_else(rejected)?;
    // Same disjoint namespace rule as the actual external-v2 enrollment.
    if external_root.starts_with(database_parent) || database_parent.starts_with(external_root) {
        return Err(rejected());
    }
    canonical_hash_v1(&NativeDurableEpochBodyV1 {
        domain: "HeptaNativeAutomationReconciliationDurableEpochV1",
        version: state.version,
        cutover_id: &state.cutover_id,
        database_path,
        external_storage_root,
        external_storage_enrollment_hash: external_enrollment_hash,
        mode: state.mode,
        phase: state.phase,
        old_writer_id: &state.old_writer_id,
        new_writer_id: &state.new_writer_id,
        writer_id: writer,
        generation: state.generation,
        token: &state.token,
        revision: state.revision,
        shadow_cases: state.shadow_cases,
        shadow_mismatches: state.shadow_mismatches,
        scope: RECONCILIATION_WRITER_SCOPE_V1,
    })
    .map_err(|_| rejected())
}

#[cfg(test)]
mod tests;
