use std::collections::{BTreeMap, BTreeSet};

use hepta_codex_protocol::Sha256Digest;
use serde::{Deserialize, Serialize};

use crate::{ControlPlaneError, canonical_hash_v1};

/// Stable telemetry signal family.
#[derive(Clone, Copy, Debug, Deserialize, Eq, Ord, PartialEq, PartialOrd, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum TelemetrySignalKindV1 {
    /// Required audit transition linked to an authoritative receipt.
    Audit,
    /// Integer operational metric.
    Metric,
    /// Bounded trace/span transition.
    Trace,
}

/// Data classification allowed in the bounded telemetry channel.
#[derive(Clone, Copy, Debug, Deserialize, Eq, Ord, PartialEq, PartialOrd, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum TelemetryPrivacyClassV1 {
    /// Public machine metadata.
    Public,
    /// Internal machine metadata with no manuscript/provider content.
    Internal,
    /// Restricted evidence identifiers; content bytes remain outside telemetry.
    RestrictedEvidence,
}

/// Versioned retention class; callers map these classes to deployment-specific durations.
#[derive(Clone, Copy, Debug, Deserialize, Eq, Ord, PartialEq, PartialOrd, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum TelemetryRetentionClassV1 {
    /// Short-lived operational metrics/traces.
    Operational,
    /// Required audit history.
    Audit,
    /// Restricted qualification evidence index.
    Qualification,
}

/// One low-cardinality, content-free telemetry signal.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TelemetrySignalV1 {
    /// Signal schema version.
    pub version: u16,
    /// Monotonic producer-local sequence.
    pub sequence: u64,
    /// Signal family.
    pub kind: TelemetrySignalKindV1,
    /// Stable metric/event name.
    pub name: String,
    /// Exact module identity.
    pub module_id: String,
    /// Exact subject/evidence identity.
    pub subject_hash: Sha256Digest,
    /// Optional integer value. Units are part of `name`/schema, never ambient.
    pub value: Option<i64>,
    /// Bounded allowlisted labels.
    pub labels: BTreeMap<String, String>,
    /// Privacy class.
    pub privacy_class: TelemetryPrivacyClassV1,
    /// Retention class.
    pub retention_class: TelemetryRetentionClassV1,
}

impl TelemetrySignalV1 {
    /// Canonical identity used for exact replay/idempotency.
    pub fn signal_hash(&self) -> Result<Sha256Digest, ControlPlaneError> {
        canonical_hash_v1(self)
    }
}

/// Fail-closed policy for telemetry cardinality and field surfaces.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ObservabilityPolicyV1 {
    /// Contract version.
    pub version: u16,
    /// Maximum retained signals in one bounded journal/export window.
    pub maximum_signals: usize,
    /// Maximum labels on one signal.
    pub maximum_labels_per_signal: usize,
    /// Maximum unique label key/value pairs in one journal/export window.
    pub maximum_unique_label_pairs: usize,
    /// Allowed signal names.
    pub allowed_signal_names: BTreeSet<String>,
    /// Allowed label keys.
    pub allowed_label_keys: BTreeSet<String>,
}

impl ObservabilityPolicyV1 {
    /// Validates explicit finite limits and non-empty allowlists.
    pub fn validate(&self) -> Result<(), ControlPlaneError> {
        if self.version != 1
            || self.maximum_signals == 0
            || self.maximum_signals > 1_000_000
            || self.maximum_labels_per_signal > 32
            || self.maximum_unique_label_pairs == 0
            || self.maximum_unique_label_pairs > 1_000_000
            || self.allowed_signal_names.is_empty()
            || self.allowed_label_keys.len() > 256
            || self
                .allowed_signal_names
                .iter()
                .any(|name| !valid_token(name))
            || self.allowed_label_keys.iter().any(|key| !valid_token(key))
        {
            return Err(ControlPlaneError::ObservabilitySignalInvalid);
        }
        Ok(())
    }
}

/// Deterministic bounded export artifact. It is telemetry, never qualification authority.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ObservabilityExportV1 {
    /// Contract version.
    pub version: u16,
    /// Exact policy identity.
    pub policy_hash: Sha256Digest,
    /// Signals in sequence order.
    pub signals: Vec<TelemetrySignalV1>,
    /// Canonical export identity.
    pub export_hash: Sha256Digest,
    /// This artifact never grants authority.
    pub grants_authority: bool,
}

/// In-memory deterministic ingestion journal enforcing replay and cardinality contracts.
#[derive(Clone, Debug)]
pub struct ObservabilityJournalV1 {
    policy: ObservabilityPolicyV1,
    policy_hash: Sha256Digest,
    signals: BTreeMap<u64, (Sha256Digest, TelemetrySignalV1)>,
    label_pairs: BTreeSet<(String, String)>,
}

impl ObservabilityJournalV1 {
    /// Creates an empty bounded journal.
    pub fn new(policy: ObservabilityPolicyV1) -> Result<Self, ControlPlaneError> {
        policy.validate()?;
        let policy_hash = canonical_hash_v1(&policy)?;
        Ok(Self {
            policy,
            policy_hash,
            signals: BTreeMap::new(),
            label_pairs: BTreeSet::new(),
        })
    }

    /// Ingests one signal. Exact sequence/hash replay is idempotent; conflicting reuse fails.
    pub fn ingest(&mut self, signal: TelemetrySignalV1) -> Result<Sha256Digest, ControlPlaneError> {
        self.validate_signal(&signal)?;
        let signal_hash = signal.signal_hash()?;
        if let Some((existing_hash, _)) = self.signals.get(&signal.sequence) {
            return if existing_hash == &signal_hash {
                Ok(signal_hash)
            } else {
                Err(ControlPlaneError::ObservabilitySignalInvalid)
            };
        }
        if self.signals.len() >= self.policy.maximum_signals {
            return Err(ControlPlaneError::ObservabilityBudgetExceeded);
        }
        let mut next_pairs = self.label_pairs.clone();
        for (key, value) in &signal.labels {
            next_pairs.insert((key.clone(), value.clone()));
        }
        if next_pairs.len() > self.policy.maximum_unique_label_pairs {
            return Err(ControlPlaneError::ObservabilityBudgetExceeded);
        }
        self.label_pairs = next_pairs;
        self.signals
            .insert(signal.sequence, (signal_hash.clone(), signal));
        Ok(signal_hash)
    }

    /// Builds a canonical bounded export without promoting evidence or authority.
    pub fn export(&self) -> Result<ObservabilityExportV1, ControlPlaneError> {
        let signals = self
            .signals
            .values()
            .map(|(_, signal)| signal.clone())
            .collect::<Vec<_>>();
        let body = ObservabilityExportBodyV1 {
            version: 1,
            policy_hash: self.policy_hash.clone(),
            signals: signals.clone(),
            grants_authority: false,
        };
        let export_hash = canonical_hash_v1(&body)?;
        Ok(ObservabilityExportV1 {
            version: body.version,
            policy_hash: body.policy_hash,
            signals: body.signals,
            export_hash,
            grants_authority: body.grants_authority,
        })
    }

    /// Number of accepted unique signals.
    #[must_use]
    pub fn len(&self) -> usize {
        self.signals.len()
    }

    /// Returns true when no signal has been accepted.
    #[must_use]
    pub fn is_empty(&self) -> bool {
        self.signals.is_empty()
    }

    fn validate_signal(&self, signal: &TelemetrySignalV1) -> Result<(), ControlPlaneError> {
        if signal.version != 1
            || signal.sequence == 0
            || !self.policy.allowed_signal_names.contains(&signal.name)
            || !valid_module_id(&signal.module_id)
            || signal.labels.len() > self.policy.maximum_labels_per_signal
            || signal.labels.iter().any(|(key, value)| {
                !self.policy.allowed_label_keys.contains(key)
                    || !valid_token(key)
                    || !valid_label_value(value)
            })
            || matches!(signal.kind, TelemetrySignalKindV1::Audit) && signal.value.is_some()
        {
            return Err(ControlPlaneError::ObservabilitySignalInvalid);
        }
        Ok(())
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ObservabilityExportBodyV1 {
    version: u16,
    policy_hash: Sha256Digest,
    signals: Vec<TelemetrySignalV1>,
    grants_authority: bool,
}

fn valid_module_id(value: &str) -> bool {
    value.starts_with("module.") && valid_token(value)
}

fn valid_token(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 128
        && value.bytes().all(|byte| {
            byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b'-' | b':' | b'/')
        })
}

fn valid_label_value(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 128
        && value.bytes().all(|byte| {
            byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b'-' | b':' | b'/')
        })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn digest(byte: char) -> Sha256Digest {
        format!("sha256:{}", byte.to_string().repeat(64))
            .parse()
            .expect("digest")
    }

    fn policy() -> ObservabilityPolicyV1 {
        ObservabilityPolicyV1 {
            version: 1,
            maximum_signals: 4,
            maximum_labels_per_signal: 2,
            maximum_unique_label_pairs: 3,
            allowed_signal_names: [
                "scheduler.queue_age_micros".to_owned(),
                "audit.commit".to_owned(),
            ]
            .into_iter()
            .collect(),
            allowed_label_keys: ["campaign".to_owned()].into_iter().collect(),
        }
    }

    fn metric(sequence: u64, campaign: &str) -> TelemetrySignalV1 {
        TelemetrySignalV1 {
            version: 1,
            sequence,
            kind: TelemetrySignalKindV1::Metric,
            name: "scheduler.queue_age_micros".to_owned(),
            module_id: "module.scheduler-core".to_owned(),
            subject_hash: digest('a'),
            value: Some(10),
            labels: [("campaign".to_owned(), campaign.to_owned())]
                .into_iter()
                .collect(),
            privacy_class: TelemetryPrivacyClassV1::Internal,
            retention_class: TelemetryRetentionClassV1::Operational,
        }
    }

    #[test]
    fn exact_replay_is_idempotent_but_conflict_fails() {
        let mut journal = ObservabilityJournalV1::new(policy()).expect("journal");
        let signal = metric(1, "campaign-a");
        let first = journal.ingest(signal.clone()).expect("first");
        let replay = journal.ingest(signal).expect("replay");
        assert_eq!(first, replay);
        assert_eq!(journal.len(), 1);

        let conflict = metric(1, "campaign-b");
        assert_eq!(
            journal.ingest(conflict),
            Err(ControlPlaneError::ObservabilitySignalInvalid)
        );
    }

    #[test]
    fn export_is_non_authorizing_and_cardinality_is_bounded() {
        let mut journal = ObservabilityJournalV1::new(policy()).expect("journal");
        journal.ingest(metric(1, "a")).expect("a");
        journal.ingest(metric(2, "b")).expect("b");
        journal.ingest(metric(3, "c")).expect("c");
        assert_eq!(
            journal.ingest(metric(4, "d")),
            Err(ControlPlaneError::ObservabilityBudgetExceeded)
        );
        let export = journal.export().expect("export");
        assert!(!export.grants_authority);
        assert_eq!(export.signals.len(), 3);
    }
}
