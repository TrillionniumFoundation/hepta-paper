//! Actual bounded Codex invocation over previously authenticated durable requests.
//! Provider execution does not confer workspace integration or campaign-write authority.
use crate::dispatch_containment::{
    bind_containment, clear_containment_record, durable_create, validate_private_state,
};
use crate::output_schema::{validate_output, validate_schema};
use crate::{
    BrokerClockV1, BrokerJournalError, BrokerJournalStoreV1, FaultInjectionPointV1,
    load_persisted_request,
};
use hepta_codex_event_stream::{DecodedStream, StreamLimits, decode_stream};
use hepta_codex_journal::{OperationJournalV1, OperationState};
use hepta_codex_protocol::{AgentRole, CodexExecutionRequestV1, Sha256Digest, TerminalEventKind};
use hepta_codex_runtime::{
    BoundedProcessResultV1, CgroupV2OperationV1, CodexInvocationPolicyV1, CodexInvocationRequestV1,
    CodexInvocationV1, CodexRuntimeIdentityV1, DurableGatePolicyV1, ProcessContainmentModeV1,
    ProcessLimitsV1, ProcessTerminationReason, RestrictedEnvironmentV1, RuntimeIdentityPolicyV1,
    build_codex_invocation, inspect_codex_invocation_postflight, inspect_codex_runtime_identity,
    spawn_blocked_preexec_gate, verify_runtime_identity_unchanged,
};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{
    fs::{self, OpenOptions},
    io::{Cursor, Read},
    os::unix::fs::{MetadataExt, OpenOptionsExt},
    path::PathBuf,
    str::FromStr,
    sync::atomic::{AtomicBool, Ordering},
};
use thiserror::Error;

/// Deployment integration must verify accepted external qualification, current lease,
/// request input/workspace/mutation bindings, role-separated principal and home,
/// and budget authority. There is intentionally no permissive implementation.
/// Called before spawn, immediately before release, and before accepting output.
pub trait CodexDispatchAuthorityV1: Send + Sync {
    fn authorize(
        &self,
        request: &CodexExecutionRequestV1,
        runtime: &CodexRuntimeIdentityV1,
        invocation: &CodexInvocationV1,
        now_unix_ms: u64,
    ) -> Result<(), CodexDispatchError>;
}

/// Locally supplied control inputs. No executable/argv/environment is taken from a wire request.
/// The authority must resolve the immutable input and workspace hashes to this workspace.
pub struct CodexDispatchPlanV1<'a> {
    pub operation_id: String,
    pub role: AgentRole,
    pub runtime: &'a CodexRuntimeIdentityV1,
    pub runtime_identity_policy: &'a RuntimeIdentityPolicyV1,
    pub workspace: PathBuf,
    pub output_schema_path: PathBuf,
    pub output_last_message_path: PathBuf,
    pub parent_environment: RestrictedEnvironmentV1,
    pub model_child_environment: &'a RestrictedEnvironmentV1,
    pub prompt: Vec<u8>,
    pub invocation_policy: CodexInvocationPolicyV1,
    pub process_limits: ProcessLimitsV1,
    pub gate_policy: DurableGatePolicyV1,
    pub containment: ProcessContainmentModeV1,
    pub authority: &'a dyn CodexDispatchAuthorityV1,
    pub clock: &'a dyn BrokerClockV1,
    pub cancelled: &'a AtomicBool,
}

/// Actual provider evidence; the journal stops at SchemaValidated.
/// Caller must independently snapshot/validate mutations before ResultPrepared and acknowledgement.
#[derive(Debug)]
pub struct CodexDispatchResultV1 {
    pub journal: OperationJournalV1,
    pub process: BoundedProcessResultV1,
    pub event_stream: DecodedStream,
    pub output: Value,
    pub output_hash: Sha256Digest,
    pub validation_hash: Sha256Digest,
    pub durable_result_path: PathBuf,
}

/// Executes only with production-eligible schema, immutable gate and real cgroup authority.
/// A source fixture, signed capability alone, or caller-provided hash never enables production.
pub fn run_reserved_codex_operation(
    store: &mut BrokerJournalStoreV1,
    plan: CodexDispatchPlanV1<'_>,
) -> Result<CodexDispatchResultV1, CodexDispatchError> {
    run_reserved_codex_operation_inner(store, plan, true)
}

fn run_reserved_codex_operation_inner(
    store: &mut BrokerJournalStoreV1,
    plan: CodexDispatchPlanV1<'_>,
    production: bool,
) -> Result<CodexDispatchResultV1, CodexDispatchError> {
    let _quiescence = crate::dispatch_backup::acquire_dispatch_lock(
        &plan.gate_policy.state_directory,
        plan.gate_policy.owner_uid,
        false,
    )?;
    let request = load_persisted_request(store, &plan.operation_id)?;
    let initial = store.load_journal(&plan.operation_id)?;
    if initial.current_state != OperationState::Reserved {
        return Err(CodexDispatchError::OperationNotReserved);
    }
    if plan.cancelled.load(Ordering::Acquire) {
        transition(
            store,
            &plan,
            OperationState::Reserved,
            OperationState::CancelledBeforeSpawn,
            None,
            Some("codex_cancelled_before_spawn"),
        )?;
        return Err(CodexDispatchError::Cancelled);
    }
    let preflight = (|| {
        validate_private_state(
            &plan.gate_policy.state_directory,
            plan.gate_policy.owner_uid,
        )?;
        if production
            && (!plan.invocation_policy.production_eligible()
                || !plan.gate_policy.production_eligible()
                || !plan.containment.production_eligible()?)
        {
            return Err(CodexDispatchError::ProductionAuthorityRequired);
        }
        let principal = fs::metadata("/proc/self")?;
        let uid = principal.uid();
        if plan.role != request.role
            || plan.runtime.identity_hash != request.codex_runtime_identity_hash
            || plan.runtime.model_selector != request.model_selector
            || uid != plan.invocation_policy.execution_uid
            || uid != plan.gate_policy.owner_uid
            || plan
                .invocation_policy
                .execution_gid
                .is_some_and(|gid| gid != principal.gid())
        {
            return Err(CodexDispatchError::InvalidBinding("role_runtime_principal"));
        }
        if production
            && (plan.runtime_identity_policy.binary_owner_uid == uid
                || plan.runtime_identity_policy.home_owner_uid != uid)
        {
            return Err(CodexDispatchError::ProductionAuthorityRequired);
        }
        check_deadline(&request, &plan)?;
        if now(&plan)? >= request.request_capability.expires_at_unix_ms {
            return Err(CodexDispatchError::Deadline);
        }
        let before = inspect_runtime(&plan)?;
        verify_runtime_identity_unchanged(plan.runtime, &before)?;
        let invocation = build_codex_invocation(CodexInvocationRequestV1 {
            runtime: &before,
            workspace: &plan.workspace,
            sandbox_policy: request.sandbox_policy,
            output_schema_path: &plan.output_schema_path,
            expected_output_schema_hash: &request.output_schema_hash,
            output_last_message_path: &plan.output_last_message_path,
            parent_environment: plan.parent_environment.clone(),
            model_child_environment: plan.model_child_environment,
            prompt: plan.prompt.clone(),
            policy: plan.invocation_policy,
        })?;
        if invocation.prompt_hash != request.prompt_envelope_hash {
            return Err(CodexDispatchError::InvalidBinding("prompt_envelope"));
        }
        let schema_bytes = read_bound_control(
            &invocation.output_schema_contract,
            plan.invocation_policy.maximum_output_schema_bytes,
        )?;
        if hash_bytes(&schema_bytes)? != request.output_schema_hash {
            return Err(CodexDispatchError::InvalidBinding("schema_preflight"));
        }
        let schema: Value = serde_json::from_slice(&schema_bytes)?;
        validate_schema(&schema).map_err(CodexDispatchError::Schema)?;
        plan.authority
            .authorize(&request, &before, &invocation, now(&plan)?)?;
        Ok((before, invocation, schema))
    })();
    let (before, invocation, schema) = match preflight {
        Ok(value) => value,
        Err(error) => {
            transition(
                store,
                &plan,
                OperationState::Reserved,
                OperationState::RejectedPreflight,
                None,
                Some("codex_preflight_rejected"),
            )?;
            return Err(error);
        }
    };
    transition(
        store,
        &plan,
        OperationState::Reserved,
        OperationState::RequestBound,
        None,
        None,
    )?;
    let mut limits = plan.process_limits;
    limits.timeout_ms = limits.timeout_ms.min(
        request
            .absolute_deadline_unix_ms
            .saturating_sub(now(&plan)?),
    );
    // Full JSONL evidence must fit in the bounded capture; a tail is never promoted to a stream.
    let stream_limit = request
        .maximum_output_bytes
        .min(limits.maximum_stdout_bytes)
        .min(limits.maximum_stderr_bytes)
        .min(limits.maximum_tail_bytes as u64);
    limits.maximum_stdout_bytes = stream_limit;
    limits.maximum_tail_bytes = usize::try_from(stream_limit)
        .map_err(|_| CodexDispatchError::InvalidBinding("output_limit"))?;
    let mut containment = match &plan.containment {
        ProcessContainmentModeV1::ProcessGroupOnly => None,
        ProcessContainmentModeV1::CgroupV2(policy) => {
            match CgroupV2OperationV1::create(policy.clone(), &plan.operation_id) {
                Ok(value) => Some(value),
                Err(error) => {
                    transition(
                        store,
                        &plan,
                        OperationState::RequestBound,
                        OperationState::FailedBeforeSpawn,
                        None,
                        Some("codex_containment_failed"),
                    )?;
                    return Err(error.into());
                }
            }
        }
    };
    let containment_record = if let (Some(operation), ProcessContainmentModeV1::CgroupV2(policy)) =
        (&containment, &plan.containment)
    {
        Some(bind_containment(
            store,
            &plan.operation_id,
            &plan.gate_policy.state_directory,
            policy,
            operation,
        )?)
    } else {
        None
    };
    let mut blocked =
        match spawn_blocked_preexec_gate(&invocation.process, limits, &plan.gate_policy) {
            Ok(blocked) => blocked,
            Err(error) => {
                cleanup_containment(&mut containment, containment_record.as_deref())?;
                transition(
                    store,
                    &plan,
                    OperationState::RequestBound,
                    OperationState::FailedBeforeSpawn,
                    None,
                    Some("codex_gate_failed"),
                )?;
                return Err(error.into());
            }
        };
    let identity_hash = blocked.identity().identity_hash.clone();
    if let Some(operation) = &containment {
        operation.attach_pid(blocked.identity().pid)?;
    }
    store.link_blocked_process(
        &plan.operation_id,
        now(&plan)?,
        blocked.identity(),
        FaultInjectionPointV1::None,
    )?;
    let release_check = (|| {
        if plan.cancelled.load(Ordering::Acquire) {
            return Err(CodexDispatchError::Cancelled);
        }
        check_deadline(&request, &plan)?;
        verify_runtime_identity_unchanged(&before, &inspect_runtime(&plan)?)?;
        if now(&plan)? >= request.request_capability.expires_at_unix_ms {
            return Err(CodexDispatchError::Deadline);
        }
        if inspect_codex_invocation_postflight(&invocation, false)?.output_message_bytes != 0 {
            return Err(CodexDispatchError::InvalidBinding(
                "output_not_empty_before_release",
            ));
        }
        plan.authority
            .authorize(&request, &before, &invocation, now(&plan)?)?;
        check_deadline(&request, &plan)?;
        blocked.restrict_execution_timeout(
            request
                .absolute_deadline_unix_ms
                .saturating_sub(now(&plan)?),
        )?;
        store.authorize_process_release(
            &plan.operation_id,
            &identity_hash,
            now(&plan)?,
            FaultInjectionPointV1::None,
        )?;
        Ok(())
    })();
    if let Err(error) = release_check {
        blocked.terminate_blocked()?;
        cleanup_containment(&mut containment, containment_record.as_deref())?;
        finish_failure(
            store,
            &plan,
            &identity_hash,
            OperationState::FailedAfterSpawn,
            "codex_release_rejected",
        )?;
        return Err(error);
    }
    let executed = blocked
        .release()
        .and_then(|gate| gate.supervise_with_cancellation(plan.cancelled));
    // Cgroup kill also removes children that escaped the original process group.
    let cleaned = cleanup_containment(&mut containment, containment_record.as_deref());
    let process = match (executed, cleaned) {
        (Ok((_, process)), Ok(())) => process,
        (Err(error), _) => {
            finish_failure(
                store,
                &plan,
                &identity_hash,
                OperationState::ResultAmbiguous,
                "codex_execution_ambiguous",
            )?;
            return Err(error.into());
        }
        (_, Err(error)) => {
            finish_failure(
                store,
                &plan,
                &identity_hash,
                OperationState::ResultAmbiguous,
                "codex_containment_cleanup_ambiguous",
            )?;
            return Err(error);
        }
    };
    if process.termination_reason != ProcessTerminationReason::Exited
        || process.exit_code != Some(0)
        || process.signal.is_some()
    {
        let state = if process.termination_reason == ProcessTerminationReason::TimedOut {
            OperationState::TimedOutAfterSpawn
        } else {
            OperationState::ResultAmbiguous
        };
        finish_failure(
            store,
            &plan,
            &identity_hash,
            state,
            "codex_process_not_successful",
        )?;
        return Err(CodexDispatchError::ProcessFailed(Box::new(process)));
    }
    let postflight = (|| {
        if plan.cancelled.load(Ordering::Acquire) {
            return Err(CodexDispatchError::Cancelled);
        }
        check_deadline(&request, &plan)?;
        let after = inspect_runtime(&plan)?;
        verify_runtime_identity_unchanged(&before, &after)?;
        let postflight = inspect_codex_invocation_postflight(&invocation, true)?;
        plan.authority
            .authorize(&request, &after, &invocation, now(&plan)?)?;
        if process.stdout_truncated || process.stdout_bytes != process.stdout_tail.len() as u64 {
            return Err(CodexDispatchError::InvalidBinding("complete_event_stream"));
        }
        let output_bytes = read_bound_control(
            &invocation.output_message_contract,
            request
                .maximum_output_bytes
                .min(plan.invocation_policy.maximum_output_message_bytes),
        )?;
        if hash_bytes(&output_bytes)? != postflight.output_message_hash {
            return Err(CodexDispatchError::InvalidBinding("output_postflight"));
        }
        // Fsync the actual output and immutable evidence before deterministic journal advancement.
        let evidence = serde_json::to_vec(
            &json!({"version":1,"operationId":request.operation_id,"requestHash":initial.request_hash,"runtimeIdentityHash":after.identity_hash,"argvHash":invocation.argv_hash,"outputHash":postflight.output_message_hash,"stdoutHash":process.stdout_hash,"stderrHash":process.stderr_hash,"stdoutHex":hex::encode(&process.stdout_tail),"outputHex":hex::encode(&output_bytes)}),
        )?;
        let result_path = plan
            .gate_policy
            .state_directory
            .join(format!("codex-result-{}.json", plan.operation_id));
        durable_create(&result_path, &evidence)?;
        Ok((output_bytes, postflight.output_message_hash, result_path))
    })();
    let (output_bytes, output_hash, durable_result_path) = match postflight {
        Ok(result) => result,
        Err(error) => {
            finish_failure(
                store,
                &plan,
                &identity_hash,
                OperationState::ResultAmbiguous,
                "codex_postflight_ambiguous",
            )?;
            return Err(error);
        }
    };
    store.finish_process_and_transition(
        &plan.operation_id,
        &identity_hash,
        OperationState::ProcessSpawned,
        OperationState::EventStreamStarted,
        now(&plan)?,
        None,
        None,
        "codex_process_completed",
        FaultInjectionPointV1::None,
    )?;
    let stream = decode_stream(
        Cursor::new(&process.stdout_tail),
        StreamLimits {
            maximum_total_bytes: limits.maximum_tail_bytes,
            maximum_line_bytes: limits.maximum_tail_bytes.min(1024 * 1024),
            maximum_event_count: usize::try_from(request.maximum_event_count)
                .map_err(|_| CodexDispatchError::InvalidBinding("event_count"))?,
        },
    );
    let event_stream = match stream {
        Ok(stream) if stream.raw_stream_hash == process.stdout_hash => stream,
        _ => {
            transition(
                store,
                &plan,
                OperationState::EventStreamStarted,
                OperationState::EventStreamInvalid,
                None,
                Some("codex_event_stream_invalid"),
            )?;
            return Err(CodexDispatchError::InvalidBinding("event_stream"));
        }
    };
    transition(
        store,
        &plan,
        OperationState::EventStreamStarted,
        OperationState::TerminalEventObserved,
        Some(event_stream.raw_stream_hash.clone()),
        None,
    )?;
    if event_stream.terminal_event_kind == TerminalEventKind::TurnFailed {
        transition(
            store,
            &plan,
            OperationState::TerminalEventObserved,
            OperationState::TerminalFailure,
            None,
            Some("codex_turn_failed"),
        )?;
        return Err(CodexDispatchError::InvalidBinding("terminal_event"));
    }
    transition(
        store,
        &plan,
        OperationState::TerminalEventObserved,
        OperationState::FinalOutputCaptured,
        Some(output_hash.clone()),
        None,
    )?;
    let output = serde_json::from_slice::<Value>(&output_bytes)
        .map_err(CodexDispatchError::Json)
        .and_then(|output| {
            validate_output(&schema, &output).map_err(CodexDispatchError::Schema)?;
            Ok(output)
        });
    let output = match output {
        Ok(output) => output,
        Err(error) => {
            transition(
                store,
                &plan,
                OperationState::FinalOutputCaptured,
                OperationState::OutputSchemaInvalid,
                None,
                Some("codex_output_schema_invalid"),
            )?;
            return Err(error);
        }
    };
    let validation_hash = hash_bytes(&serde_json::to_vec(
        &json!({"contract":"HeptaBoundedOutputValidationV1","schemaHash":request.output_schema_hash,"outputHash":output_hash}),
    )?)?;
    transition(
        store,
        &plan,
        OperationState::FinalOutputCaptured,
        OperationState::SchemaValidated,
        Some(validation_hash.clone()),
        None,
    )?;
    Ok(CodexDispatchResultV1 {
        journal: store.load_journal(&plan.operation_id)?,
        process,
        event_stream,
        output,
        output_hash,
        validation_hash,
        durable_result_path,
    })
}

fn cleanup_containment(
    containment: &mut Option<CgroupV2OperationV1>,
    record: Option<&std::path::Path>,
) -> Result<(), CodexDispatchError> {
    if let Some(operation) = containment.take() {
        operation.kill_and_cleanup()?;
    }
    if let Some(record) = record {
        clear_containment_record(record)?;
    }
    Ok(())
}
fn inspect_runtime(
    plan: &CodexDispatchPlanV1<'_>,
) -> Result<CodexRuntimeIdentityV1, CodexDispatchError> {
    Ok(inspect_codex_runtime_identity(
        plan.runtime.executable.canonical_path().as_os_str(),
        plan.runtime.home.canonical_path(),
        &plan.runtime.model_selector,
        plan.parent_environment.policy_hash.clone(),
        plan.runtime.transport_profile_hash.clone(),
        plan.parent_environment.as_map(),
        plan.runtime_identity_policy,
    )?)
}
fn now(plan: &CodexDispatchPlanV1<'_>) -> Result<u64, CodexDispatchError> {
    plan.clock
        .now_unix_ms()
        .map_err(|_| CodexDispatchError::Clock)
}
fn check_deadline(
    request: &CodexExecutionRequestV1,
    plan: &CodexDispatchPlanV1<'_>,
) -> Result<(), CodexDispatchError> {
    if now(plan)? >= request.absolute_deadline_unix_ms {
        Err(CodexDispatchError::Deadline)
    } else {
        Ok(())
    }
}
fn transition(
    store: &mut BrokerJournalStoreV1,
    plan: &CodexDispatchPlanV1<'_>,
    from: OperationState,
    to: OperationState,
    evidence: Option<Sha256Digest>,
    reason: Option<&str>,
) -> Result<(), CodexDispatchError> {
    store.append_transition(
        &plan.operation_id,
        from,
        to,
        now(plan)?,
        evidence,
        reason.map(str::to_owned),
        FaultInjectionPointV1::None,
    )?;
    Ok(())
}
fn finish_failure(
    store: &mut BrokerJournalStoreV1,
    plan: &CodexDispatchPlanV1<'_>,
    identity: &Sha256Digest,
    to: OperationState,
    reason: &str,
) -> Result<(), CodexDispatchError> {
    store.finish_process_and_transition(
        &plan.operation_id,
        identity,
        OperationState::ProcessSpawned,
        to,
        now(plan)?,
        None,
        Some(reason.to_owned()),
        reason,
        FaultInjectionPointV1::None,
    )?;
    Ok(())
}
fn read_bound_control(
    contract: &hepta_codex_runtime::CodexControlFileContractV1,
    maximum: u64,
) -> Result<Vec<u8>, CodexDispatchError> {
    let file = OpenOptions::new()
        .read(true)
        .custom_flags(nix::libc::O_NOFOLLOW)
        .open(&contract.canonical_path)?;
    let metadata = file.metadata()?;
    if !metadata.is_file()
        || metadata.dev() != contract.device
        || metadata.ino() != contract.inode
        || metadata.uid() != contract.uid
        || metadata.gid() != contract.gid
        || metadata.mode() != contract.mode
        || metadata.nlink() != contract.link_count
    {
        return Err(CodexDispatchError::InvalidBinding("control_file_identity"));
    }
    let mut bytes = Vec::new();
    (&file)
        .take(maximum.saturating_add(1))
        .read_to_end(&mut bytes)?;
    if bytes.len() as u64 > maximum {
        return Err(CodexDispatchError::InvalidBinding("file_byte_limit"));
    }
    file.sync_all()?;
    Ok(bytes)
}
pub(crate) fn hash_bytes(bytes: &[u8]) -> Result<Sha256Digest, CodexDispatchError> {
    Sha256Digest::from_str(&format!("sha256:{}", hex::encode(Sha256::digest(bytes))))
        .map_err(|_| CodexDispatchError::InvalidBinding("digest"))
}

#[derive(Debug, Error)]
pub enum CodexDispatchError {
    #[error("Codex dispatch requires accepted production authority and containment")]
    ProductionAuthorityRequired,
    #[error("Codex dispatch denied by deployment authority")]
    AuthorityDenied,
    #[error("Codex operation is already dispatched; never replay provider execution")]
    OperationNotReserved,
    #[error("Codex dispatch binding failed: {0}")]
    InvalidBinding(&'static str),
    #[error("Codex request deadline expired")]
    Deadline,
    #[error("Codex dispatch cancelled")]
    Cancelled,
    #[error("Codex dispatch clock unavailable")]
    Clock,
    #[error("Codex process did not complete successfully")]
    ProcessFailed(Box<BoundedProcessResultV1>),
    #[error("Codex output schema failed: {0}")]
    Schema(String),
    #[error(transparent)]
    Journal(#[from] BrokerJournalError),
    #[error(transparent)]
    Filesystem(#[from] std::io::Error),
    #[error(transparent)]
    Json(#[from] serde_json::Error),
    #[error(transparent)]
    Gate(#[from] hepta_codex_runtime::DurableGateError),
    #[error(transparent)]
    Containment(#[from] hepta_codex_runtime::CgroupV2Error),
    #[error(transparent)]
    Invocation(#[from] hepta_codex_runtime::CodexInvocationError),
    #[error(transparent)]
    RuntimeIdentity(#[from] hepta_codex_runtime::RuntimeIdentityError),
    #[error(transparent)]
    RuntimeDrift(#[from] hepta_codex_runtime::RuntimeQualificationError),
}

#[cfg(test)]
mod tests;
