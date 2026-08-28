use std::io::Cursor;

use hepta_codex_event_stream::{DecodedStream, StreamLimits, decode_stream};
use hepta_codex_journal::{OperationJournalV1, OperationState};
use hepta_codex_protocol::{Sha256Digest, TerminalEventKind};
use hepta_codex_runtime::{
    BoundedProcessError, BoundedProcessRequestV1, BoundedProcessResultV1, ProcessLimitsV1,
    ProcessTerminationReason, run_bounded_process_with_spawn_hook,
};
use thiserror::Error;

use crate::{BrokerJournalError, BrokerJournalStoreV1, FaultInjectionPointV1};

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct FakeExecutionTimelineV1 {
    pub request_bound_unix_ms: u64,
    pub process_spawned_unix_ms: u64,
    pub event_stream_started_unix_ms: u64,
    pub terminal_event_observed_unix_ms: u64,
    pub final_output_captured_unix_ms: u64,
    pub schema_validated_unix_ms: u64,
    pub workspace_snapshotted_unix_ms: u64,
    pub mutation_validated_unix_ms: u64,
    pub result_prepared_unix_ms: u64,
}

impl FakeExecutionTimelineV1 {
    fn validate(self) -> Result<Self, FakeBrokerExecutionError> {
        let values = [
            self.request_bound_unix_ms,
            self.process_spawned_unix_ms,
            self.event_stream_started_unix_ms,
            self.terminal_event_observed_unix_ms,
            self.final_output_captured_unix_ms,
            self.schema_validated_unix_ms,
            self.workspace_snapshotted_unix_ms,
            self.mutation_validated_unix_ms,
            self.result_prepared_unix_ms,
        ];
        if values[0] == 0 || !values.windows(2).all(|window| window[0] <= window[1]) {
            return Err(FakeBrokerExecutionError::InvalidPlan);
        }
        Ok(self)
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct FakeExecutionEvidenceV1 {
    pub process_start_identity_hash: Sha256Digest,
    pub final_output_hash: Sha256Digest,
    pub schema_validation_hash: Sha256Digest,
    pub workspace_snapshot_hash: Sha256Digest,
    pub mutation_validation_hash: Sha256Digest,
    pub prepared_receipt_hash: Sha256Digest,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct FakeExecutionFaultV1 {
    pub transition_to: OperationState,
    pub fault: FaultInjectionPointV1,
}

pub struct FakeBrokerExecutionPlanV1 {
    pub operation_id: String,
    pub process: BoundedProcessRequestV1,
    pub process_limits: ProcessLimitsV1,
    pub maximum_event_count: usize,
    pub maximum_jsonl_line_bytes: usize,
    pub timeline: FakeExecutionTimelineV1,
    pub evidence: FakeExecutionEvidenceV1,
    pub fault: Option<FakeExecutionFaultV1>,
}

#[derive(Clone, Debug)]
pub struct FakeBrokerPreparedResultV1 {
    pub journal: OperationJournalV1,
    pub process: BoundedProcessResultV1,
    pub event_stream: DecodedStream,
}

/// Executes only a caller-supplied local fake process and durably links each
/// deterministic observation to the broker operation journal.
pub fn run_reserved_fake_operation(
    store: &mut BrokerJournalStoreV1,
    plan: FakeBrokerExecutionPlanV1,
) -> Result<FakeBrokerPreparedResultV1, FakeBrokerExecutionError> {
    let timeline = plan.timeline.validate()?;
    if plan.operation_id.is_empty()
        || plan.maximum_event_count == 0
        || plan.maximum_jsonl_line_bytes == 0
    {
        return Err(FakeBrokerExecutionError::InvalidPlan);
    }
    let initial = store.load_journal(&plan.operation_id)?;
    if initial.current_state != OperationState::Reserved {
        return Err(FakeBrokerExecutionError::StateMismatch {
            expected: OperationState::Reserved,
            observed: initial.current_state,
        });
    }
    store.append_transition(
        &plan.operation_id,
        OperationState::Reserved,
        OperationState::RequestBound,
        timeline.request_bound_unix_ms,
        None,
        None,
        fault_for(&plan, OperationState::RequestBound),
    )?;

    let mut spawn_linked = false;
    let mut spawn_journal_error = None;
    let process = run_bounded_process_with_spawn_hook(&plan.process, plan.process_limits, |_| {
        match store.append_transition(
            &plan.operation_id,
            OperationState::RequestBound,
            OperationState::ProcessSpawned,
            timeline.process_spawned_unix_ms,
            Some(plan.evidence.process_start_identity_hash.clone()),
            None,
            fault_for(&plan, OperationState::ProcessSpawned),
        ) {
            Ok(_) => {
                spawn_linked = true;
                Ok(())
            }
            Err(error) => {
                spawn_journal_error = Some(error);
                Err(BoundedProcessError::SpawnHookRejected)
            }
        }
    });
    let process = match process {
        Ok(process) => process,
        Err(error) if spawn_journal_error.is_some() => {
            return Err(FakeBrokerExecutionError::SpawnJournalLinkFailed(
                spawn_journal_error.expect("checked spawn journal error"),
            ));
        }
        Err(error) => {
            let (from, to, reason) = if spawn_linked {
                (
                    OperationState::ProcessSpawned,
                    OperationState::FailedAfterSpawn,
                    "fake_process_failed_after_spawn",
                )
            } else {
                (
                    OperationState::RequestBound,
                    OperationState::FailedBeforeSpawn,
                    "fake_process_failed_before_spawn",
                )
            };
            let _ = store.append_transition(
                &plan.operation_id,
                from,
                to,
                timeline.process_spawned_unix_ms,
                None,
                Some(reason.to_owned()),
                fault_for(&plan, to),
            );
            return Err(FakeBrokerExecutionError::Process(error));
        }
    };

    if process.termination_reason != ProcessTerminationReason::Exited
        || process.exit_code != Some(0)
        || process.signal.is_some()
    {
        let (state, reason) = if process.termination_reason == ProcessTerminationReason::TimedOut {
            (OperationState::TimedOutAfterSpawn, "fake_process_timed_out")
        } else {
            (OperationState::FailedAfterSpawn, "fake_process_failed")
        };
        store.append_transition(
            &plan.operation_id,
            OperationState::ProcessSpawned,
            state,
            timeline.event_stream_started_unix_ms,
            None,
            Some(reason.to_owned()),
            fault_for(&plan, state),
        )?;
        return Err(FakeBrokerExecutionError::TerminalProcessFailure(process));
    }
    let stdout_len = usize::try_from(process.stdout_bytes)
        .map_err(|_| FakeBrokerExecutionError::IncompleteStdoutCapture)?;
    if process.stdout_truncated || stdout_len != process.stdout_tail.len() {
        store.append_transition(
            &plan.operation_id,
            OperationState::ProcessSpawned,
            OperationState::EventStreamInvalid,
            timeline.event_stream_started_unix_ms,
            None,
            Some("fake_stdout_incomplete".to_owned()),
            fault_for(&plan, OperationState::EventStreamInvalid),
        )?;
        return Err(FakeBrokerExecutionError::IncompleteStdoutCapture);
    }

    store.append_transition(
        &plan.operation_id,
        OperationState::ProcessSpawned,
        OperationState::EventStreamStarted,
        timeline.event_stream_started_unix_ms,
        Some(process.stdout_hash.clone()),
        None,
        fault_for(&plan, OperationState::EventStreamStarted),
    )?;
    let stream_limits = StreamLimits {
        maximum_total_bytes: stdout_len.max(1),
        maximum_line_bytes: plan.maximum_jsonl_line_bytes.min(stdout_len.max(1)),
        maximum_event_count: plan.maximum_event_count,
    };
    let event_stream = match decode_stream(Cursor::new(&process.stdout_tail), stream_limits) {
        Ok(stream) => stream,
        Err(error) => {
            store.append_transition(
                &plan.operation_id,
                OperationState::EventStreamStarted,
                OperationState::EventStreamInvalid,
                timeline.terminal_event_observed_unix_ms,
                None,
                Some("fake_event_stream_invalid".to_owned()),
                fault_for(&plan, OperationState::EventStreamInvalid),
            )?;
            return Err(FakeBrokerExecutionError::EventStream(error.to_string()));
        }
    };
    store.append_transition(
        &plan.operation_id,
        OperationState::EventStreamStarted,
        OperationState::TerminalEventObserved,
        timeline.terminal_event_observed_unix_ms,
        Some(event_stream.raw_stream_hash.clone()),
        None,
        fault_for(&plan, OperationState::TerminalEventObserved),
    )?;
    if event_stream.terminal_event_kind == TerminalEventKind::TurnFailed {
        store.append_transition(
            &plan.operation_id,
            OperationState::TerminalEventObserved,
            OperationState::TerminalFailure,
            timeline.final_output_captured_unix_ms,
            None,
            Some("fake_turn_failed".to_owned()),
            fault_for(&plan, OperationState::TerminalFailure),
        )?;
        return Err(FakeBrokerExecutionError::TerminalEventFailure);
    }

    append_success_transition(
        store,
        &plan,
        OperationState::TerminalEventObserved,
        OperationState::FinalOutputCaptured,
        timeline.final_output_captured_unix_ms,
        plan.evidence.final_output_hash.clone(),
    )?;
    append_success_transition(
        store,
        &plan,
        OperationState::FinalOutputCaptured,
        OperationState::SchemaValidated,
        timeline.schema_validated_unix_ms,
        plan.evidence.schema_validation_hash.clone(),
    )?;
    append_success_transition(
        store,
        &plan,
        OperationState::SchemaValidated,
        OperationState::WorkspaceSnapshotted,
        timeline.workspace_snapshotted_unix_ms,
        plan.evidence.workspace_snapshot_hash.clone(),
    )?;
    append_success_transition(
        store,
        &plan,
        OperationState::WorkspaceSnapshotted,
        OperationState::MutationValidated,
        timeline.mutation_validated_unix_ms,
        plan.evidence.mutation_validation_hash.clone(),
    )?;
    let journal = append_success_transition(
        store,
        &plan,
        OperationState::MutationValidated,
        OperationState::ResultPrepared,
        timeline.result_prepared_unix_ms,
        plan.evidence.prepared_receipt_hash.clone(),
    )?;
    Ok(FakeBrokerPreparedResultV1 {
        journal,
        process,
        event_stream,
    })
}

fn append_success_transition(
    store: &mut BrokerJournalStoreV1,
    plan: &FakeBrokerExecutionPlanV1,
    from: OperationState,
    to: OperationState,
    recorded_at_unix_ms: u64,
    evidence_hash: Sha256Digest,
) -> Result<OperationJournalV1, FakeBrokerExecutionError> {
    store
        .append_transition(
            &plan.operation_id,
            from,
            to,
            recorded_at_unix_ms,
            Some(evidence_hash),
            None,
            fault_for(plan, to),
        )
        .map_err(FakeBrokerExecutionError::Journal)
}

fn fault_for(plan: &FakeBrokerExecutionPlanV1, state: OperationState) -> FaultInjectionPointV1 {
    plan.fault.map_or(FaultInjectionPointV1::None, |fault| {
        if fault.transition_to == state {
            fault.fault
        } else {
            FaultInjectionPointV1::None
        }
    })
}

#[derive(Debug, Error)]
pub enum FakeBrokerExecutionError {
    #[error("fake broker execution plan is invalid")]
    InvalidPlan,
    #[error("fake broker operation state mismatch: expected {expected:?}, observed {observed:?}")]
    StateMismatch {
        expected: OperationState,
        observed: OperationState,
    },
    #[error("spawned fake process could not be durably linked to its operation journal")]
    SpawnJournalLinkFailed(BrokerJournalError),
    #[error("fake process execution failed: {0}")]
    Process(BoundedProcessError),
    #[error("fake process terminated unsuccessfully")]
    TerminalProcessFailure(BoundedProcessResultV1),
    #[error("fake process stdout was not captured completely")]
    IncompleteStdoutCapture,
    #[error("fake JSONL event stream is invalid: {0}")]
    EventStream(String),
    #[error("fake JSONL terminal event reported failure")]
    TerminalEventFailure,
    #[error(transparent)]
    Journal(#[from] BrokerJournalError),
}
