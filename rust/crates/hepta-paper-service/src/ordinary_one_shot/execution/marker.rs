//! Ephemeral journal ownership only. No callback, worker dispatch, credential,
//! binding projection or caller-supplied JSON can manufacture this owner.
use super::*;
use std::cell::Cell;

const PERMIT_INVALID: &str = "campaign_one_shot_attempt_external_action_permit_invalid";
const PERMIT_STALE: &str = "campaign_one_shot_attempt_external_action_permit_stale";
const OWNER_INVALID: &str = "campaign_one_shot_attempt_external_action_owner_invalid";
const OWNER_STALE: &str = "campaign_one_shot_attempt_external_action_owner_stale";

pub(super) struct CommittedMarkerV1 {
    attempt_id: String,
    phase: String,
    event_hash: String,
    reservation_hash: String,
}
impl CommittedMarkerV1 {
    /// Called only after the exact newly appended event, acknowledged commit,
    /// current head and original filesystem epochs have all been verified.
    pub(super) fn from_committed_event(event: &Json) -> Result<Option<Self>, String> {
        let selected = text(field(event, "phase"));
        if !matches!(
            selected.as_deref(),
            Some("provider_started" | "launch_started")
        ) {
            return Ok(None);
        }
        let required = |name| text(field(event, name)).ok_or_else(|| PERMIT_INVALID.to_owned());
        Ok(Some(Self {
            attempt_id: required("attemptId")?,
            phase: required("phase")?,
            event_hash: required(record::EVENT_HASH)?,
            reservation_hash: required("reservationHash")?,
        }))
    }
    fn assert_current(&self, journal: &OneShotJournalV1<'_>, stale: &str) -> Result<(), String> {
        let current = journal.inspect(&self.attempt_id)?;
        if !is_text(field(&current, "headPhase"), &self.phase)
            || !is_text(field(&current, "headEventHash"), &self.event_hash)
            || !is_text(
                field(field(&current, "reservation"), record::RESERVATION_HASH),
                &self.reservation_hash,
            )
            || !matches!(field(&current, "terminalReceipt"), Json::Null)
        {
            return Err(stale.into());
        }
        journal.assert_current()
    }
}

/// A one-use, same-open-journal marker claim, followed by repeatable live checks.
/// This is one component of a future admitted native execution fence. It does
/// not verify immutable datasets, source, provider runtime, worker binding,
/// native-store writer admission, credentials, or scientific/release authority.
/// Ordinary execute remains closed until those owners are composed explicitly.
///
/// The value is not Clone/Serialize/Deserialize and has no public constructor.
/// Reopening the journal, replaying the append or copying inspection JSON cannot
/// restore it. Dropping this value never edits or deletes the durable marker.
///
/// ```compile_fail
/// use hepta_paper_service::ordinary_one_shot::execution::OneShotExternalActionMarkerV1;
/// let _: OneShotExternalActionMarkerV1 = serde_json::from_str("{}").unwrap();
/// ```
///
/// ```compile_fail
/// use hepta_paper_service::ordinary_one_shot::execution::OneShotExternalActionMarkerV1;
/// fn copy(marker: &OneShotExternalActionMarkerV1) -> OneShotExternalActionMarkerV1 {
///     marker.clone()
/// }
/// ```
///
/// ```compile_fail
/// use hepta_paper_service::ordinary_one_shot::execution::OneShotExternalActionMarkerV1;
/// let _ = OneShotExternalActionMarkerV1 {};
/// ```
pub struct OneShotExternalActionMarkerV1 {
    owner: Arc<()>,
    committed: CommittedMarkerV1,
    revoked: Cell<bool>,
}
impl OneShotExternalActionMarkerV1 {
    /// Project the exact provider-started subject for a future signed canary.
    /// The data is not a permit: the actual sender must retain this owner and
    /// recheck it with live runtime/configuration/lease admission at handoff.
    /// Launch markers and another attempt cannot be relabeled as a canary.
    pub fn provider_canary_subject_v1(
        &self,
        journal: &OneShotJournalV1<'_>,
        expected_attempt_id: &str,
    ) -> Result<hepta_codex_protocol::OneShotProviderCanarySubjectV1, String> {
        self.assert_current(journal)?;
        if self.committed.phase != "provider_started"
            || self.committed.attempt_id != expected_attempt_id
            || expected_attempt_id.len() > 128
        {
            return Err("one_shot_provider_canary_marker_scope_mismatch".into());
        }
        Ok(hepta_codex_protocol::OneShotProviderCanarySubjectV1 {
            version: 1,
            attempt_id: self.committed.attempt_id.clone(),
            phase: hepta_codex_protocol::OneShotProviderCanaryPhaseV1::ProviderStarted,
            reservation_hash: self
                .committed
                .reservation_hash
                .parse()
                .map_err(|_| OWNER_INVALID)?,
            marker_event_hash: self
                .committed
                .event_hash
                .parse()
                .map_err(|_| OWNER_INVALID)?,
        })
    }

    /// Checks the original journal owner, control budget, held/named filesystem
    /// identities, exact schema and complete audited head. Any failure on the
    /// originating journal permanently revokes this observation. A wrong-owner
    /// call cannot consume or revoke another journal's claim.
    pub fn assert_current(&self, journal: &OneShotJournalV1<'_>) -> Result<(), String> {
        if !Arc::ptr_eq(&self.owner, &journal.owner) || self.revoked.get() {
            return Err(OWNER_INVALID.into());
        }
        let result = self.committed.assert_current(journal, OWNER_STALE);
        if result.is_err() {
            self.revoked.set(true);
        }
        result
    }
}

impl OneShotJournalV1<'_> {
    /// Consumes only this original append's ephemeral marker claim. An exact
    /// replay, reservation, ordinary event, terminal, foreign journal or lost
    /// acknowledgment refuses. Consumption precedes live checks, so a failed
    /// check cannot later be retried as fresh authority. No external action is
    /// run, admitted or authorized by this operation.
    pub fn claim_external_action_marker(
        &self,
        mutation: &mut OneShotJournalMutationV1,
    ) -> Result<OneShotExternalActionMarkerV1, String> {
        if !Arc::ptr_eq(&self.owner, &mutation.owner) {
            return Err(PERMIT_INVALID.into());
        }
        let committed = mutation.marker.take().ok_or(PERMIT_INVALID)?;
        committed.assert_current(self, PERMIT_STALE)?;
        Ok(OneShotExternalActionMarkerV1 {
            owner: Arc::clone(&self.owner),
            committed,
            revoked: Cell::new(false),
        })
    }
}

#[cfg(test)]
mod native_tests;
#[cfg(test)]
mod tests;
