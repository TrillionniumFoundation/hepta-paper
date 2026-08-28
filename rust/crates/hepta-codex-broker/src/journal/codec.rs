use std::str::FromStr;

use hepta_codex_journal::OperationState;
use hepta_codex_protocol::Sha256Digest;
use sha2::{Digest, Sha256};

use super::store::BrokerJournalError;

pub(super) fn state_to_db(state: OperationState) -> &'static str {
    match state {
        OperationState::Reserved => "reserved",
        OperationState::RequestBound => "request_bound",
        OperationState::ProcessSpawned => "process_spawned",
        OperationState::EventStreamStarted => "event_stream_started",
        OperationState::TerminalEventObserved => "terminal_event_observed",
        OperationState::FinalOutputCaptured => "final_output_captured",
        OperationState::SchemaValidated => "schema_validated",
        OperationState::WorkspaceSnapshotted => "workspace_snapshotted",
        OperationState::MutationValidated => "mutation_validated",
        OperationState::ResultPrepared => "result_prepared",
        OperationState::Acknowledged => "acknowledged",
        OperationState::RejectedPreflight => "rejected_preflight",
        OperationState::FailedBeforeSpawn => "failed_before_spawn",
        OperationState::CancelledBeforeSpawn => "cancelled_before_spawn",
        OperationState::FailedAfterSpawn => "failed_after_spawn",
        OperationState::TimedOutAfterSpawn => "timed_out_after_spawn",
        OperationState::TerminalFailure => "terminal_failure",
        OperationState::EventStreamInvalid => "event_stream_invalid",
        OperationState::OutputSchemaInvalid => "output_schema_invalid",
        OperationState::MutationPolicyViolated => "mutation_policy_violated",
        OperationState::ResultAmbiguous => "result_ambiguous",
    }
}

pub(super) fn state_from_db(value: &str) -> Result<OperationState, BrokerJournalError> {
    match value {
        "reserved" => Ok(OperationState::Reserved),
        "request_bound" => Ok(OperationState::RequestBound),
        "process_spawned" => Ok(OperationState::ProcessSpawned),
        "event_stream_started" => Ok(OperationState::EventStreamStarted),
        "terminal_event_observed" => Ok(OperationState::TerminalEventObserved),
        "final_output_captured" => Ok(OperationState::FinalOutputCaptured),
        "schema_validated" => Ok(OperationState::SchemaValidated),
        "workspace_snapshotted" => Ok(OperationState::WorkspaceSnapshotted),
        "mutation_validated" => Ok(OperationState::MutationValidated),
        "result_prepared" => Ok(OperationState::ResultPrepared),
        "acknowledged" => Ok(OperationState::Acknowledged),
        "rejected_preflight" => Ok(OperationState::RejectedPreflight),
        "failed_before_spawn" => Ok(OperationState::FailedBeforeSpawn),
        "cancelled_before_spawn" => Ok(OperationState::CancelledBeforeSpawn),
        "failed_after_spawn" => Ok(OperationState::FailedAfterSpawn),
        "timed_out_after_spawn" => Ok(OperationState::TimedOutAfterSpawn),
        "terminal_failure" => Ok(OperationState::TerminalFailure),
        "event_stream_invalid" => Ok(OperationState::EventStreamInvalid),
        "output_schema_invalid" => Ok(OperationState::OutputSchemaInvalid),
        "mutation_policy_violated" => Ok(OperationState::MutationPolicyViolated),
        "result_ambiguous" => Ok(OperationState::ResultAmbiguous),
        _ => Err(BrokerJournalError::CorruptDatabaseValue("operation_state")),
    }
}

pub(super) fn sha256_digest(bytes: &[u8]) -> Result<Sha256Digest, BrokerJournalError> {
    let mut hasher = Sha256::new();
    hasher.update(bytes);
    let value = format!("sha256:{}", hex::encode(hasher.finalize()));
    Sha256Digest::from_str(&value).map_err(|_| BrokerJournalError::DigestConstruction)
}

pub(super) fn to_i64(value: u64) -> Result<i64, BrokerJournalError> {
    i64::try_from(value).map_err(|_| BrokerJournalError::NumericOverflow)
}

pub(super) fn from_i64(value: i64) -> Result<u64, BrokerJournalError> {
    u64::try_from(value)
        .map_err(|_| BrokerJournalError::CorruptDatabaseValue("negative_integer"))
}
