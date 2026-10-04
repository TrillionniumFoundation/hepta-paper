//! Borrowed, non-authorizing recovery facts from the already audited journal.
//! In particular, the legacy mayAppend* diagnostic fields are never permits.
use super::json::*;
use hepta_legacy_compatibility::ProductionJsonValue as Json;

#[derive(Debug, PartialEq, Eq)]
pub(super) enum RecoveryState {
    Absent,
    HistoricalAuditOnly,
    BeforeProvider,
    ProviderOutcomeUnknown,
    CompletedCanaryWithoutInvocationAuthority,
    LaunchOutcomeUnknown,
    TerminalReplay,
}

/// Constructed only inside the retained journal projection. Neither the facts
/// nor the original V1 report can authorize a write or an external effect.
pub(super) struct ObservedRecoveryV1<'a> {
    state: RecoveryState,
    report: &'a Json,
}

impl<'a> ObservedRecoveryV1<'a> {
    pub(super) fn from_audited(report: &'a Json) -> Result<Self, String> {
        let state = if matches!(report, Json::Null) {
            RecoveryState::Absent
        } else if is_text(
            field(field(report, "recoveryDisposition"), "status"),
            "historical_audit_only",
        ) {
            RecoveryState::HistoricalAuditOnly
        } else {
            match text(field(report, "headPhase")).as_deref() {
                Some("attempt_reserved" | "preconditions_verified" | "prepare_verified") => {
                    RecoveryState::BeforeProvider
                }
                Some("provider_started") => RecoveryState::ProviderOutcomeUnknown,
                Some("provider_completed") => {
                    RecoveryState::CompletedCanaryWithoutInvocationAuthority
                }
                Some("launch_started") => RecoveryState::LaunchOutcomeUnknown,
                Some("terminal") => RecoveryState::TerminalReplay,
                _ => {
                    return Err("campaign_one_shot_attempt_journal_event_sequence_invalid".into());
                }
            }
        };
        Ok(Self { state, report })
    }

    #[cfg(test)]
    pub(super) fn state(&self) -> &RecoveryState {
        &self.state
    }

    pub(super) fn is_absent(&self) -> bool {
        self.state == RecoveryState::Absent
    }

    /// Return the exact original report, including its historical diagnostic
    /// spelling and reservation timestamp. No recovered state is advanced.
    pub(super) fn report(&self) -> &'a Json {
        self.report
    }
}
