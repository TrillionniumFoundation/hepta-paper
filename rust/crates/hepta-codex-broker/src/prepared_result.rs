//! Durable post-provider preparation. Provider execution is not a prepared campaign result
//! until the exact pre-execution workspace, current workspace, mutation policy and output
//! evidence are revalidated and journaled without re-running the provider.
use crate::codex_dispatch::hash_bytes;
use crate::dispatch_containment::validate_private_state;
use crate::{
    BrokerJournalStoreV1, CodexDispatchError, FaultInjectionPointV1, load_persisted_request,
};
use hepta_codex_event_stream::{StreamLimits, decode_stream};
use hepta_codex_journal::{OperationJournalV1, OperationState};
use hepta_codex_protocol::{AgentRole, CodexExecutionRequestV1, Sha256Digest, TokenUsage};
use hepta_workspace::{
    AttemptWorkspaceV1, MutationManifestV1, MutationPolicyV1, PreparedWorkspaceResultV1,
    TreeInventoryV1, WorkspaceRootV1, mutation_policy_hash_v1,
    validate_prepared_workspace_result_v1, workspace_identity_hash_v1,
};
use serde::{Deserialize, Serialize};
use std::{
    fs::{self, File, OpenOptions},
    io::{Read, Write},
    os::unix::fs::{MetadataExt, OpenOptionsExt},
    path::{Path, PathBuf},
};

const MAXIMUM_SIDECAR_BYTES: u64 = 64 * 1024 * 1024;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
#[cfg_attr(not(test), allow(dead_code))]
pub(crate) enum PreparedResultFaultInjectionPointV1 {
    None,
    AfterWorkspaceSnapshotted,
    AfterMutationValidated,
    AfterPreparedReceiptPublication,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct WorkspaceBeforeV1 {
    version: u16,
    operation_id: String,
    request_hash: Sha256Digest,
    workspace_identity_hash: Sha256Digest,
    mutation_policy_hash: Sha256Digest,
    authority_evidence_hash: Sha256Digest,
    initial_inventory: TreeInventoryV1,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct DurableExecutionEvidenceV1 {
    version: u16,
    operation_id: String,
    request_hash: Sha256Digest,
    runtime_identity_hash: Sha256Digest,
    argv_hash: Sha256Digest,
    output_hash: Sha256Digest,
    stdout_hash: Sha256Digest,
    stderr_hash: Sha256Digest,
    stdout_hex: String,
    output_hex: String,
}

/// Exact broker-owned prepared receipt. This is provider evidence, not campaign-write authority.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct BrokerPreparedResultReceiptV1 {
    pub version: u16,
    pub operation_id: String,
    pub request_hash: Sha256Digest,
    pub campaign_id: String,
    pub node_id: String,
    pub attempt_id: String,
    pub lease_generation: u64,
    pub campaign_revision: u64,
    pub role: AgentRole,
    pub runtime_identity_hash: Sha256Digest,
    pub output_schema_hash: Sha256Digest,
    pub workspace_identity_hash: Sha256Digest,
    pub mutation_policy_hash: Sha256Digest,
    pub authority_evidence_hash: Sha256Digest,
    pub output_hash: Sha256Digest,
    pub schema_validation_hash: Sha256Digest,
    pub event_stream_hash: Sha256Digest,
    pub token_usage: Option<TokenUsage>,
    pub workspace_result: PreparedWorkspaceResultV1,
    pub mutation_validation_hash: Sha256Digest,
    pub execution_evidence_hash: Sha256Digest,
    pub prepared_receipt_hash: Sha256Digest,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct PreparedReceiptHashView<'a> {
    version: u16,
    operation_id: &'a str,
    request_hash: &'a Sha256Digest,
    campaign_id: &'a str,
    node_id: &'a str,
    attempt_id: &'a str,
    lease_generation: u64,
    campaign_revision: u64,
    role: AgentRole,
    runtime_identity_hash: &'a Sha256Digest,
    output_schema_hash: &'a Sha256Digest,
    workspace_identity_hash: &'a Sha256Digest,
    mutation_policy_hash: &'a Sha256Digest,
    authority_evidence_hash: &'a Sha256Digest,
    output_hash: &'a Sha256Digest,
    schema_validation_hash: &'a Sha256Digest,
    event_stream_hash: &'a Sha256Digest,
    token_usage: Option<TokenUsage>,
    workspace_result: &'a PreparedWorkspaceResultV1,
    mutation_validation_hash: &'a Sha256Digest,
    execution_evidence_hash: &'a Sha256Digest,
}

impl BrokerPreparedResultReceiptV1 {
    fn hash_view(&self) -> PreparedReceiptHashView<'_> {
        PreparedReceiptHashView {
            version: self.version,
            operation_id: &self.operation_id,
            request_hash: &self.request_hash,
            campaign_id: &self.campaign_id,
            node_id: &self.node_id,
            attempt_id: &self.attempt_id,
            lease_generation: self.lease_generation,
            campaign_revision: self.campaign_revision,
            role: self.role,
            runtime_identity_hash: &self.runtime_identity_hash,
            output_schema_hash: &self.output_schema_hash,
            workspace_identity_hash: &self.workspace_identity_hash,
            mutation_policy_hash: &self.mutation_policy_hash,
            authority_evidence_hash: &self.authority_evidence_hash,
            output_hash: &self.output_hash,
            schema_validation_hash: &self.schema_validation_hash,
            event_stream_hash: &self.event_stream_hash,
            token_usage: self.token_usage,
            workspace_result: &self.workspace_result,
            mutation_validation_hash: &self.mutation_validation_hash,
            execution_evidence_hash: &self.execution_evidence_hash,
        }
    }

    /// Recomputes the domain-separated immutable receipt identity.
    pub fn verify_hash(&self) -> Result<(), CodexDispatchError> {
        if self.version != 1
            || hash_domain("HeptaBrokerPreparedResultV1", &self.hash_view())?
                != self.prepared_receipt_hash
        {
            return Err(CodexDispatchError::InvalidBinding("prepared_receipt_hash"));
        }
        Ok(())
    }
}

pub(crate) fn capture_workspace_before_dispatch(
    request: &CodexExecutionRequestV1,
    request_hash: &Sha256Digest,
    workspace: &Path,
    owner_uid: u32,
    state_directory: &Path,
    policy: &MutationPolicyV1,
    authority_evidence_hash: &Sha256Digest,
) -> Result<(), CodexDispatchError> {
    validate_private_state(state_directory, owner_uid)?;
    if mutation_policy_hash_v1(policy).map_err(workspace_error)? != request.mutation_policy_hash {
        return Err(CodexDispatchError::InvalidBinding("mutation_policy"));
    }
    let root = WorkspaceRootV1::open(workspace, owner_uid).map_err(workspace_error)?;
    let workspace_hash = workspace_identity_hash_v1(&root).map_err(workspace_error)?;
    if workspace_hash != request.workspace_identity_hash {
        return Err(CodexDispatchError::InvalidBinding("workspace_identity"));
    }
    let value = WorkspaceBeforeV1 {
        version: 1,
        operation_id: request.operation_id.clone(),
        request_hash: request_hash.clone(),
        workspace_identity_hash: workspace_hash,
        mutation_policy_hash: request.mutation_policy_hash.clone(),
        authority_evidence_hash: authority_evidence_hash.clone(),
        initial_inventory: root.inventory().map_err(workspace_error)?,
    };
    let bytes = serde_json::to_vec(&value)?;
    create_or_verify_sidecar(
        &workspace_before_path(state_directory, &request.operation_id),
        &bytes,
        owner_uid,
    )
}

/// Completes the already-defined local journal states after provider execution.
/// It never launches Codex. Re-entry after a crash recomputes the same evidence and
/// advances only missing local transitions.
pub fn finalize_codex_prepared_result(
    store: &mut BrokerJournalStoreV1,
    state_directory: &Path,
    operation_id: &str,
    workspace: &Path,
    owner_uid: u32,
    mutation_policy: &MutationPolicyV1,
    now_unix_ms: u64,
) -> Result<BrokerPreparedResultReceiptV1, CodexDispatchError> {
    finalize_codex_prepared_result_inner(
        store,
        state_directory,
        operation_id,
        workspace,
        owner_uid,
        mutation_policy,
        now_unix_ms,
        PreparedResultFaultInjectionPointV1::None,
    )
}

#[cfg(test)]
#[allow(clippy::too_many_arguments)]
pub(crate) fn finalize_codex_prepared_result_with_fault(
    store: &mut BrokerJournalStoreV1,
    state_directory: &Path,
    operation_id: &str,
    workspace: &Path,
    owner_uid: u32,
    mutation_policy: &MutationPolicyV1,
    now_unix_ms: u64,
    fault: PreparedResultFaultInjectionPointV1,
) -> Result<BrokerPreparedResultReceiptV1, CodexDispatchError> {
    finalize_codex_prepared_result_inner(
        store,
        state_directory,
        operation_id,
        workspace,
        owner_uid,
        mutation_policy,
        now_unix_ms,
        fault,
    )
}

#[allow(clippy::too_many_arguments)]
fn finalize_codex_prepared_result_inner(
    store: &mut BrokerJournalStoreV1,
    state_directory: &Path,
    operation_id: &str,
    workspace: &Path,
    owner_uid: u32,
    mutation_policy: &MutationPolicyV1,
    now_unix_ms: u64,
    fault: PreparedResultFaultInjectionPointV1,
) -> Result<BrokerPreparedResultReceiptV1, CodexDispatchError> {
    if now_unix_ms == 0 {
        return Err(CodexDispatchError::Clock);
    }
    let _lock = crate::dispatch_backup::acquire_dispatch_lock(state_directory, owner_uid, false)?;
    validate_private_state(state_directory, owner_uid)?;
    let request = load_persisted_request(store, operation_id)?;
    let initial_journal = store.load_journal(operation_id)?;
    let request_hash = initial_journal.request_hash.clone();
    let before_bytes = read_private_sidecar(
        &workspace_before_path(state_directory, operation_id),
        owner_uid,
        MAXIMUM_SIDECAR_BYTES,
    )?;
    let before: WorkspaceBeforeV1 = serde_json::from_slice(&before_bytes)?;
    if before.version != 1
        || before.operation_id != operation_id
        || before.request_hash != request_hash
        || before.workspace_identity_hash != request.workspace_identity_hash
        || before.mutation_policy_hash != request.mutation_policy_hash
        || mutation_policy_hash_v1(mutation_policy).map_err(workspace_error)?
            != request.mutation_policy_hash
    {
        return Err(CodexDispatchError::InvalidBinding(
            "workspace_before_binding",
        ));
    }

    let root = WorkspaceRootV1::open(workspace, owner_uid).map_err(workspace_error)?;
    if workspace_identity_hash_v1(&root).map_err(workspace_error)?
        != request.workspace_identity_hash
    {
        return Err(CodexDispatchError::InvalidBinding("workspace_identity"));
    }
    let after = root.inventory().map_err(workspace_error)?;
    let mutation =
        MutationManifestV1::between(&before.initial_inventory, &after).map_err(workspace_error)?;
    mutation_policy
        .validate_manifest(&mutation)
        .map_err(workspace_error)?;
    let attempt = AttemptWorkspaceV1 {
        attempt_id: request.attempt_id.clone(),
        canonical_path: workspace.to_owned(),
        initial_inventory: before.initial_inventory.clone(),
    };
    let workspace_result =
        PreparedWorkspaceResultV1::new(&attempt, &root, &after, &mutation, mutation_policy)
            .map_err(workspace_error)?;
    validate_prepared_workspace_result_v1(
        &workspace_result,
        &attempt,
        &root,
        &after,
        &mutation,
        mutation_policy,
    )
    .map_err(workspace_error)?;

    let execution_bytes = read_private_sidecar(
        &execution_result_path(state_directory, operation_id),
        owner_uid,
        MAXIMUM_SIDECAR_BYTES,
    )?;
    let execution: DurableExecutionEvidenceV1 = serde_json::from_slice(&execution_bytes)?;
    if execution.version != 1
        || execution.operation_id != operation_id
        || execution.request_hash != request_hash
        || execution.runtime_identity_hash != request.codex_runtime_identity_hash
    {
        return Err(CodexDispatchError::InvalidBinding(
            "execution_evidence_binding",
        ));
    }
    let output_bytes = hex::decode(&execution.output_hex)
        .map_err(|_| CodexDispatchError::InvalidBinding("execution_output_hex"))?;
    let stdout_bytes = hex::decode(&execution.stdout_hex)
        .map_err(|_| CodexDispatchError::InvalidBinding("execution_stdout_hex"))?;
    if hash_bytes(&output_bytes)? != execution.output_hash
        || hash_bytes(&stdout_bytes)? != execution.stdout_hash
    {
        return Err(CodexDispatchError::InvalidBinding(
            "execution_evidence_hash",
        ));
    }
    let decoded = decode_stream(
        std::io::Cursor::new(&stdout_bytes),
        StreamLimits {
            maximum_total_bytes: stdout_bytes.len().max(1),
            maximum_line_bytes: stdout_bytes.len().clamp(1, 1024 * 1024),
            maximum_event_count: usize::try_from(request.maximum_event_count)
                .map_err(|_| CodexDispatchError::InvalidBinding("event_count"))?,
        },
    )
    .map_err(|_| CodexDispatchError::InvalidBinding("execution_event_stream"))?;
    if decoded.raw_stream_hash != execution.stdout_hash {
        return Err(CodexDispatchError::InvalidBinding(
            "execution_event_stream_hash",
        ));
    }
    let journal = store.load_journal(operation_id)?;
    let terminal_event_hash = transition_evidence(&journal, OperationState::TerminalEventObserved)?;
    let final_output_hash = transition_evidence(&journal, OperationState::FinalOutputCaptured)?;
    let schema_validation_hash = transition_evidence(&journal, OperationState::SchemaValidated)?;
    let expected_schema_validation_hash = hash_bytes(&serde_json::to_vec(&serde_json::json!({
        "contract": "HeptaBoundedOutputValidationV1",
        "schemaHash": request.output_schema_hash,
        "outputHash": execution.output_hash,
    }))?)?;
    if terminal_event_hash != execution.stdout_hash
        || final_output_hash != execution.output_hash
        || schema_validation_hash != expected_schema_validation_hash
    {
        return Err(CodexDispatchError::InvalidBinding(
            "execution_journal_binding",
        ));
    }
    let mutation_validation_hash = hash_domain(
        "HeptaBrokerMutationValidationV1",
        &(
            &request.mutation_policy_hash,
            &mutation.manifest_hash,
            &workspace_result.prepared_result_hash,
        ),
    )?;
    let execution_evidence_hash = hash_bytes(&execution_bytes)?;
    let mut receipt = BrokerPreparedResultReceiptV1 {
        version: 1,
        operation_id: operation_id.to_owned(),
        request_hash,
        campaign_id: request.campaign_id.clone(),
        node_id: request.node_id.clone(),
        attempt_id: request.attempt_id.clone(),
        lease_generation: request.lease_generation,
        campaign_revision: request.campaign_revision,
        role: request.role,
        runtime_identity_hash: request.codex_runtime_identity_hash.clone(),
        output_schema_hash: request.output_schema_hash.clone(),
        workspace_identity_hash: request.workspace_identity_hash.clone(),
        mutation_policy_hash: request.mutation_policy_hash.clone(),
        authority_evidence_hash: before.authority_evidence_hash.clone(),
        output_hash: execution.output_hash.clone(),
        schema_validation_hash,
        event_stream_hash: decoded.raw_stream_hash,
        token_usage: decoded.usage,
        workspace_result,
        mutation_validation_hash,
        execution_evidence_hash,
        prepared_receipt_hash: hash_bytes(b"uninitialized")?,
    };
    receipt.prepared_receipt_hash =
        hash_domain("HeptaBrokerPreparedResultV1", &receipt.hash_view())?;
    receipt.verify_hash()?;

    advance_local_transition(
        store,
        operation_id,
        OperationState::SchemaValidated,
        OperationState::WorkspaceSnapshotted,
        receipt.workspace_result.prepared_result_hash.clone(),
        now_unix_ms,
    )?;
    inject_fault(
        fault,
        PreparedResultFaultInjectionPointV1::AfterWorkspaceSnapshotted,
    )?;
    advance_local_transition(
        store,
        operation_id,
        OperationState::WorkspaceSnapshotted,
        OperationState::MutationValidated,
        receipt.mutation_validation_hash.clone(),
        now_unix_ms,
    )?;
    inject_fault(
        fault,
        PreparedResultFaultInjectionPointV1::AfterMutationValidated,
    )?;
    let prepared_bytes = serde_json::to_vec(&receipt)?;
    create_or_verify_sidecar(
        &prepared_result_path(state_directory, operation_id),
        &prepared_bytes,
        owner_uid,
    )?;
    inject_fault(
        fault,
        PreparedResultFaultInjectionPointV1::AfterPreparedReceiptPublication,
    )?;
    advance_local_transition(
        store,
        operation_id,
        OperationState::MutationValidated,
        OperationState::ResultPrepared,
        receipt.prepared_receipt_hash.clone(),
        now_unix_ms,
    )?;
    let final_journal = store.load_journal(operation_id)?;
    if final_journal.current_state != OperationState::ResultPrepared
        || transition_evidence(&final_journal, OperationState::ResultPrepared)?
            != receipt.prepared_receipt_hash
    {
        return Err(CodexDispatchError::InvalidBinding("prepared_state"));
    }
    Ok(receipt)
}

fn inject_fault(
    actual: PreparedResultFaultInjectionPointV1,
    expected: PreparedResultFaultInjectionPointV1,
) -> Result<(), CodexDispatchError> {
    if actual == expected {
        return Err(CodexDispatchError::InvalidBinding(
            "prepared_result_fault_injected",
        ));
    }
    Ok(())
}

/// Loads exact provider output only for a hash-verified prepared receipt.
pub fn read_codex_prepared_output(
    state_directory: &Path,
    receipt: &BrokerPreparedResultReceiptV1,
    owner_uid: u32,
) -> Result<Vec<u8>, CodexDispatchError> {
    receipt.verify_hash()?;
    let prepared = read_private_sidecar(
        &prepared_result_path(state_directory, &receipt.operation_id),
        owner_uid,
        MAXIMUM_SIDECAR_BYTES,
    )?;
    let persisted: BrokerPreparedResultReceiptV1 = serde_json::from_slice(&prepared)?;
    if persisted != *receipt {
        return Err(CodexDispatchError::InvalidBinding("prepared_receipt_bytes"));
    }
    let execution = read_private_sidecar(
        &execution_result_path(state_directory, &receipt.operation_id),
        owner_uid,
        MAXIMUM_SIDECAR_BYTES,
    )?;
    let evidence: DurableExecutionEvidenceV1 = serde_json::from_slice(&execution)?;
    if hash_bytes(&execution)? != receipt.execution_evidence_hash
        || evidence.output_hash != receipt.output_hash
        || evidence.request_hash != receipt.request_hash
    {
        return Err(CodexDispatchError::InvalidBinding(
            "prepared_output_binding",
        ));
    }
    let bytes = hex::decode(&evidence.output_hex)
        .map_err(|_| CodexDispatchError::InvalidBinding("prepared_output_hex"))?;
    if hash_bytes(&bytes)? != receipt.output_hash {
        return Err(CodexDispatchError::InvalidBinding("prepared_output_hash"));
    }
    Ok(bytes)
}

fn advance_local_transition(
    store: &mut BrokerJournalStoreV1,
    operation_id: &str,
    from: OperationState,
    to: OperationState,
    evidence: Sha256Digest,
    now_unix_ms: u64,
) -> Result<(), CodexDispatchError> {
    let journal = store.load_journal(operation_id)?;
    if journal.current_state == from {
        let recorded = journal
            .transitions
            .last()
            .map_or(now_unix_ms, |row| row.recorded_at_unix_ms.max(now_unix_ms));
        store.append_transition(
            operation_id,
            from,
            to,
            recorded,
            Some(evidence),
            None,
            FaultInjectionPointV1::None,
        )?;
    } else {
        let observed = transition_evidence(&journal, to)?;
        if observed != evidence {
            return Err(CodexDispatchError::InvalidBinding(
                "prepared_transition_evidence",
            ));
        }
    }
    Ok(())
}

fn transition_evidence(
    journal: &OperationJournalV1,
    state: OperationState,
) -> Result<Sha256Digest, CodexDispatchError> {
    journal
        .transitions
        .iter()
        .find(|row| row.to == state)
        .and_then(|row| row.evidence_hash.clone())
        .ok_or(CodexDispatchError::InvalidBinding("journal_evidence"))
}

fn workspace_before_path(state: &Path, operation_id: &str) -> PathBuf {
    state.join(format!("codex-result-{operation_id}.before.json"))
}
fn execution_result_path(state: &Path, operation_id: &str) -> PathBuf {
    state.join(format!("codex-result-{operation_id}.json"))
}
fn prepared_result_path(state: &Path, operation_id: &str) -> PathBuf {
    state.join(format!("codex-result-{operation_id}.prepared.json"))
}

fn create_or_verify_sidecar(
    path: &Path,
    bytes: &[u8],
    owner_uid: u32,
) -> Result<(), CodexDispatchError> {
    match OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(0o600)
        .custom_flags(nix::libc::O_NOFOLLOW)
        .open(path)
    {
        Ok(mut file) => {
            file.write_all(bytes)?;
            file.sync_all()?;
            File::open(
                path.parent()
                    .ok_or(CodexDispatchError::InvalidBinding("sidecar_parent"))?,
            )?
            .sync_all()?;
        }
        Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {
            if read_private_sidecar(path, owner_uid, MAXIMUM_SIDECAR_BYTES)? != bytes {
                return Err(CodexDispatchError::InvalidBinding("sidecar_conflict"));
            }
        }
        Err(error) => return Err(error.into()),
    }
    let metadata = fs::symlink_metadata(path)?;
    if !metadata.is_file()
        || metadata.file_type().is_symlink()
        || metadata.uid() != owner_uid
        || metadata.nlink() != 1
        || metadata.mode() & 0o7777 != 0o600
    {
        return Err(CodexDispatchError::InvalidBinding("sidecar_identity"));
    }
    Ok(())
}

fn read_private_sidecar(
    path: &Path,
    owner_uid: u32,
    maximum: u64,
) -> Result<Vec<u8>, CodexDispatchError> {
    let file = OpenOptions::new()
        .read(true)
        .custom_flags(nix::libc::O_NOFOLLOW)
        .open(path)?;
    let before = file.metadata()?;
    if !before.is_file()
        || before.uid() != owner_uid
        || before.nlink() != 1
        || before.mode() & 0o7777 != 0o600
        || before.len() == 0
        || before.len() > maximum
    {
        return Err(CodexDispatchError::InvalidBinding("sidecar_identity"));
    }
    let mut bytes = Vec::new();
    (&file)
        .take(maximum.saturating_add(1))
        .read_to_end(&mut bytes)?;
    let after = file.metadata()?;
    if bytes.len() as u64 != before.len()
        || before.dev() != after.dev()
        || before.ino() != after.ino()
        || before.mtime() != after.mtime()
        || before.mtime_nsec() != after.mtime_nsec()
        || before.ctime() != after.ctime()
        || before.ctime_nsec() != after.ctime_nsec()
    {
        return Err(CodexDispatchError::InvalidBinding("sidecar_changed"));
    }
    Ok(bytes)
}

fn hash_domain<T: Serialize>(domain: &str, value: &T) -> Result<Sha256Digest, CodexDispatchError> {
    let bytes = serde_json::to_vec(&(domain, value))?;
    hash_bytes(&bytes)
}

fn workspace_error(_: hepta_workspace::WorkspaceError) -> CodexDispatchError {
    CodexDispatchError::InvalidBinding("workspace")
}
