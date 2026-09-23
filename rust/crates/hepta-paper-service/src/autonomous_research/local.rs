//! Explicit local autonomous-research composition over the existing workflow owner.
//! No additional scheduler, writer, dispatch journal or credential authority.

use super::AutonomousResearchOptions;
use crate::WorkerBindingV1;
use crate::workflow::{
    LocalWorkflowV1, WorkflowActionV1, WorkflowAmendmentV1, WorkflowError,
    amend_local_workflow_with_clock_v1, initialize_local_workflow_v1, operate_local_workflow_v1,
    operate_local_workflow_with_clock_and_cancellation_v1, read_current_local_workflow_v1,
};
use hepta_control_plane::canonical_hash_v1;
use nix::fcntl::OFlag;
use serde_json::{Value, json};
use std::{
    fs::{self, Metadata, OpenOptions},
    io::Read,
    os::unix::fs::{MetadataExt, OpenOptionsExt},
    path::Path,
    sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
    },
    time::{SystemTime, UNIX_EPOCH},
};

const MAX_BYTES: u64 = 16 * 1024 * 1024;

fn same_file(a: &Metadata, b: &Metadata) -> bool {
    a.dev() == b.dev()
        && a.ino() == b.ino()
        && a.uid() == b.uid()
        && a.mode() == b.mode()
        && a.nlink() == b.nlink()
        && a.len() == b.len()
        && a.mtime() == b.mtime()
        && a.mtime_nsec() == b.mtime_nsec()
        && a.ctime() == b.ctime()
        && a.ctime_nsec() == b.ctime_nsec()
}

fn read_private_request<T: serde::de::DeserializeOwned>(path: &Path) -> Result<T, WorkflowError> {
    if !path.is_absolute() || fs::canonicalize(path).ok().as_deref() != Some(path) {
        return Err(WorkflowError::Filesystem);
    }
    let mut file = OpenOptions::new()
        .read(true)
        .custom_flags((OFlag::O_NOFOLLOW | OFlag::O_NONBLOCK).bits())
        .open(path)
        .map_err(|_| WorkflowError::Filesystem)?;
    let before = file.metadata().map_err(|_| WorkflowError::Filesystem)?;
    if !before.is_file()
        || before.nlink() != 1
        || before.uid() != nix::unistd::geteuid().as_raw()
        || before.mode() & 0o077 != 0
        || before.len() > MAX_BYTES
    {
        return Err(WorkflowError::Filesystem);
    }
    let mut bytes = Vec::new();
    Read::by_ref(&mut file)
        .take(MAX_BYTES + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| WorkflowError::Filesystem)?;
    let after = file.metadata().map_err(|_| WorkflowError::Filesystem)?;
    let named = fs::symlink_metadata(path).map_err(|_| WorkflowError::Filesystem)?;
    if bytes.len() as u64 != before.len()
        || !same_file(&before, &after)
        || !same_file(&after, &named)
        || fs::canonicalize(path).ok().as_deref() != Some(path)
    {
        return Err(WorkflowError::Filesystem);
    }
    serde_json::from_slice(&bytes).map_err(|_| WorkflowError::Definition)
}

fn now() -> Result<u64, WorkflowError> {
    let millis = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|_| WorkflowError::Conflict)?
        .as_millis();
    u64::try_from(millis).map_err(|_| WorkflowError::Conflict)
}

fn error_code(error: &WorkflowError) -> &'static str {
    match error {
        WorkflowError::Definition => "local_workflow_definition_rejected",
        WorkflowError::Filesystem => "local_workflow_filesystem_rejected",
        WorkflowError::Busy => "local_workflow_busy",
        WorkflowError::History => "local_workflow_history_rejected",
        WorkflowError::Conflict => "local_workflow_lifecycle_or_lease_conflict",
        WorkflowError::Reconciliation => "local_workflow_reconciliation_required",
        WorkflowError::GateRejected => "local_workflow_review_gate_rejected",
        WorkflowError::Service(_) => "local_workflow_service_requires_inspection",
    }
}

/// `allow_mutation` is supplied only by the two existing command entry functions.
/// Inspect never acquires a writer or initializes state, even with forged options.
pub(super) fn run(
    options: &AutonomousResearchOptions,
    allow_mutation: bool,
    cancelled: &Arc<AtomicBool>,
) -> Value {
    let campaign = options.campaign_id.clone().or_else(|| {
        options
            .paper_id
            .as_ref()
            .map(|id| format!("autonomous-research:{id}"))
    });
    let mut report = json!({
        "version": 1,
        "kind": "AutonomousResearchLocalWorkflowReport",
        "action": options.action,
        "launchMode": options.launch_mode,
        "paperId": options.paper_id,
        "campaignId": campaign,
        "ready": false,
        "readinessScope": "local_workflow_operation_only",
        "fullResearchReady": false,
        "productionActivation": false,
        "scientificAcceptance": false,
        "nodeRetirementVerified": false,
        "campaignPersisted": null,
        "providerExecutionPerformed": false,
        "externalActionPerformed": false,
        "networkActionPerformed": false,
        "networkIsolationEnforced": false,
        "externalActionMayHaveStarted": false,
        "reconciliationRequired": false,
        "cancellationScope": "signal_process_group_and_commit_boundaries",
        "interruptionRequested": false,
        "rustBoundary": "existing_local_workflow_owner"
    });
    // Validate direct API inputs as well as parser-created options. Full research
    // readiness or production/golden admission cannot be satisfied by this path.
    if options.help || options.launch_mode != "local-run" || options.require_full_ready {
        report["error"] = json!("local_workflow_cannot_grant_requested_authority");
        return report;
    }
    let read_only = matches!(options.action.as_str(), "prepare" | "status");
    if !read_only && !allow_mutation {
        report["error"] = json!("local_workflow_inspection_cannot_mutate");
        return report;
    }
    let mut execution_invoked = false;
    let observe = || {
        if cancelled.load(Ordering::Acquire) {
            return Err(WorkflowError::Conflict);
        }
        now()
    };
    let result = (|| -> Result<(), WorkflowError> {
        let expected = campaign
            .as_deref()
            .filter(|id| !id.is_empty())
            .ok_or(WorkflowError::Definition)?;
        if let Some(paper) = &options.paper_id
            && expected != format!("autonomous-research:{paper}")
        {
            return Err(WorkflowError::Definition);
        }
        // Direct callers must satisfy the same closed mode grammar as the CLI.
        let persisted = options.workflow_root.is_some();
        if persisted != options.definition_hash.is_some()
            || (persisted && options.workflow_file.is_some())
            || (persisted && options.action == "prepare")
            || (options.action == "amend"
                && (!persisted
                    || options.amendment_file.is_none()
                    || options.through_steps.is_some()
                    || options.expected_revision.is_some()))
            || (options.action != "amend" && options.amendment_file.is_some())
        {
            return Err(WorkflowError::Definition);
        }
        let definition: LocalWorkflowV1 = if let Some(root) = &options.workflow_root {
            // Recover the real current definition rather than asking the caller
            // to reconstruct private writer/lease fields from an amendment receipt.
            read_current_local_workflow_v1(root)?
        } else {
            read_private_request(
                options
                    .workflow_file
                    .as_deref()
                    .ok_or(WorkflowError::Definition)?,
            )?
        };
        definition.validate()?;
        if definition.template.snapshot.campaign_id != expected {
            return Err(WorkflowError::Definition);
        }
        let current_digest =
            canonical_hash_v1(&definition).map_err(|_| WorkflowError::Definition)?;
        let digest = options
            .definition_hash
            .clone()
            .unwrap_or(current_digest.clone());
        let root = &definition.template.state_directory;
        if options.action == "amend" {
            let amendment: WorkflowAmendmentV1 = read_private_request(
                options
                    .amendment_file
                    .as_deref()
                    .ok_or(WorkflowError::Definition)?,
            )?;
            // Do not pre-reject an old hash or expired original lease here:
            // the existing owner authenticates exact replay first, without a
            // new budget debit, renewed expiry, or clock observation. New writes
            // still require the CURRENT hash/revision and live previous lease.
            let receipt =
                amend_local_workflow_with_clock_v1(root, &digest, amendment, &mut || {
                    observe()
                        .map_err(|_| hepta_control_plane::ControlPlaneError::PersistenceInvalid)
                })?;
            report["definitionHash"] = json!(receipt.definition_hash);
            report["amendment"] =
                serde_json::to_value(receipt).map_err(|_| WorkflowError::History)?;
            report["campaignPersisted"] = json!(true);
            report["status"] = json!("local_workflow_operation_completed");
            return Ok(());
        }
        if digest != current_digest {
            return Err(WorkflowError::Definition);
        }
        let through_steps = options.through_steps.unwrap_or(definition.steps.len());
        let lifecycle = matches!(options.action.as_str(), "pause" | "resume" | "cancel");
        if (read_only && (options.through_steps.is_some() || options.expected_revision.is_some()))
            || (lifecycle
                && (options.through_steps.is_some() || options.expected_revision.is_none()))
            || (!lifecycle && options.expected_revision.is_some())
            || through_steps == 0
            || through_steps > definition.steps.len()
        {
            return Err(WorkflowError::Definition);
        }
        let action = match options.action.as_str() {
            "prepare" | "status" => WorkflowActionV1::Status,
            "launch" | "converge" => WorkflowActionV1::Advance { through_steps },
            "pause" => WorkflowActionV1::Pause {
                expected_revision: options.expected_revision.ok_or(WorkflowError::Definition)?,
            },
            "resume" => WorkflowActionV1::Resume {
                expected_revision: options.expected_revision.ok_or(WorkflowError::Definition)?,
            },
            "cancel" => WorkflowActionV1::Cancel {
                expected_revision: options.expected_revision.ok_or(WorkflowError::Definition)?,
            },
            _ => return Err(WorkflowError::Definition),
        };
        report["definitionHash"] = json!(digest);
        report["totalSteps"] = json!(definition.steps.len());
        if options.action == "prepare" {
            // No existing root is observed or adopted by prepare.
            report["status"] = json!("local_workflow_definition_validated");
            return Ok(());
        }
        let observed_at = if read_only { 0 } else { observe()? };
        if !read_only
            && (observed_at < definition.template.observed_at_unix_ms
                || observed_at >= definition.template.writer_lease.expires_at_unix_ms)
        {
            return Err(WorkflowError::Conflict);
        }
        if options.action == "launch" {
            match fs::symlink_metadata(root) {
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                    // The existing initializer refuses aliases/existing roots and
                    // retains partial initialization; never overwrite or clean it.
                    let initialized = initialize_local_workflow_v1(definition.clone())?;
                    if initialized != digest {
                        return Err(WorkflowError::History);
                    }
                }
                Err(_) => return Err(WorkflowError::Filesystem),
                Ok(_) => (),
            }
        }
        // Bind an existing root under its owner's lock before any mutation.
        // The owner repeats all definition/history checks for the action itself.
        operate_local_workflow_v1(root, &digest, WorkflowActionV1::Status, 0)?;
        report["campaignPersisted"] = json!(true);
        if matches!(action, WorkflowActionV1::Advance { .. }) {
            execution_invoked = true;
            if definition
                .template
                .workers
                .values()
                .any(|binding| matches!(binding, WorkerBindingV1::Process { .. }))
            {
                // Declared network policy and a worker's JSON are not physical
                // isolation or independent observation of arbitrary local code.
                report["providerExecutionPerformed"] = Value::Null;
                report["externalActionPerformed"] = Value::Null;
                report["networkActionPerformed"] = Value::Null;
                report["externalActionMayHaveStarted"] = json!(true);
            }
        }
        let progress = operate_local_workflow_with_clock_and_cancellation_v1(
            root,
            &digest,
            action,
            &mut || {
                observe().map_err(|_| hepta_control_plane::ControlPlaneError::PersistenceInvalid)
            },
            Arc::clone(cancelled),
        )?;
        report["workflow"] = serde_json::to_value(progress).map_err(|_| WorkflowError::History)?;
        report["status"] = json!("local_workflow_operation_completed");
        Ok(())
    })();
    match result {
        Ok(()) => report["ready"] = json!(true),
        Err(error) => {
            report["error"] = json!(error_code(&error));
            report["reconciliationRequired"] = json!(execution_invoked);
        }
    }
    report["interruptionRequested"] = json!(cancelled.load(Ordering::Acquire));
    // A late signal can race a real COMMIT. Do not rewrite a successful durable
    // observation into a claim that no work committed. Failed invocations retain
    // their existing bounded error and reconciliation disposition.
    report
}
