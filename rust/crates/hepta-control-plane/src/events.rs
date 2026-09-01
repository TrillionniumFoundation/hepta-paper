use std::collections::BTreeSet;

use hepta_codex_protocol::Sha256Digest;
use serde::{Deserialize, Serialize};

use crate::{ControlPlaneError, canonical_hash_v1};

/// Privacy-bounded control-plane event vocabulary.
#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ControlPlaneEventKindV1 {
    /// Snapshot accepted.
    SnapshotFrozen,
    /// Candidate frontier accepted.
    FrontierValidated,
    /// Plan certificate emitted.
    PlanSelected,
    /// Resource reservation admitted.
    ResourceReserved,
    /// Batch execution returned a prepared result.
    ResultPrepared,
    /// Independent contract verifier accepted a result.
    ResultVerified,
    /// Single writer integrated a verified result.
    ResultCommitted,
    /// Reservation was reconciled and released.
    ResourceReleased,
}

/// One bounded low-cardinality event. It carries hashes and IDs, not content.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ControlPlaneEventV1 {
    /// Monotonic event ordinal.
    pub ordinal: u64,
    /// Event kind.
    pub kind: ControlPlaneEventKindV1,
    /// Exact snapshot hash.
    pub snapshot_hash: Sha256Digest,
    /// Exact plan hash when available.
    pub plan_hash: Option<Sha256Digest>,
    /// Stable candidate ID when available.
    pub candidate_id: Option<String>,
    /// Stable module ID when available.
    pub module_id: Option<String>,
    /// Reservation ID when available.
    pub reservation_id: Option<String>,
    /// Exact subject/evidence hash for the transition.
    pub subject_hash: Sha256Digest,
}

/// Event buffer with explicit event-count and unique-subject budgets.
#[derive(Clone, Debug)]
pub struct BoundedEventLogV1 {
    maximum_events: usize,
    maximum_unique_subjects: usize,
    events: Vec<ControlPlaneEventV1>,
    subjects: BTreeSet<Sha256Digest>,
}

impl BoundedEventLogV1 {
    /// Creates an empty event buffer.
    pub fn new(
        maximum_events: usize,
        maximum_unique_subjects: usize,
    ) -> Result<Self, ControlPlaneError> {
        if maximum_events == 0
            || maximum_events > 100_000
            || maximum_unique_subjects == 0
            || maximum_unique_subjects > maximum_events
        {
            return Err(ControlPlaneError::ObservabilityBudgetExceeded);
        }
        Ok(Self {
            maximum_events,
            maximum_unique_subjects,
            events: Vec::new(),
            subjects: BTreeSet::new(),
        })
    }

    /// Appends one event if both cardinality budgets remain satisfied.
    pub fn push(&mut self, mut event: ControlPlaneEventV1) -> Result<(), ControlPlaneError> {
        if self.events.len() == self.maximum_events {
            return Err(ControlPlaneError::ObservabilityBudgetExceeded);
        }
        let is_new_subject = !self.subjects.contains(&event.subject_hash);
        if is_new_subject && self.subjects.len() == self.maximum_unique_subjects {
            return Err(ControlPlaneError::ObservabilityBudgetExceeded);
        }
        event.ordinal = u64::try_from(self.events.len())
            .ok()
            .and_then(|value| value.checked_add(1))
            .ok_or(ControlPlaneError::ObservabilityBudgetExceeded)?;
        self.subjects.insert(event.subject_hash.clone());
        self.events.push(event);
        Ok(())
    }

    /// Returns the immutable events in emission order.
    #[must_use]
    pub fn events(&self) -> &[ControlPlaneEventV1] {
        &self.events
    }

    /// Returns the canonical hash of the complete bounded event list.
    pub fn event_log_hash(&self) -> Result<Sha256Digest, ControlPlaneError> {
        canonical_hash_v1(&self.events)
    }
}
