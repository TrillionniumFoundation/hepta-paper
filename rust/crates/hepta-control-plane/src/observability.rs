use std::collections::{BTreeMap, BTreeSet};

use hepta_codex_protocol::Sha256Digest;
use serde::{Deserialize, Serialize};
use thiserror::Error;

use crate::{CalibrationSampleV1, canonical_hash_v1};

const MAXIMUM_SIGNALS: usize = 1_000_000;
const MAXIMUM_FIELDS: usize = 64;

/// Closed privacy-bounded telemetry category.
#[derive(Clone, Copy, Debug, Deserialize, Eq, Ord, PartialEq, PartialOrd, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum TelemetrySignalKindV1 {
    Snapshot,
    Plan,
    Reservation,
    Execution,
    PreparedResult,
    Verification,
    Commit,
    Prediction,
    Recovery,
}

/// Explicit retention/privacy class. No class accepts prompt, credential or manuscript bytes.
#[derive(Clone, Copy, Debug, Deserialize, Eq, Ord, PartialEq, PartialOrd, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum TelemetryRetentionClassV1 {
    Operational,
    Audit,
    Prediction,
}

/// Stable cross-plane identifiers and hashes. All optional string fields are identifiers,
/// never free-form payloads.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TelemetryCorrelationV1 {
    pub snapshot_hash: Sha256Digest,
    pub plan_hash: Option<Sha256Digest>,
    pub reservation_id: Option<String>,
    pub attempt_id: Option<String>,
    pub prepared_result_hash: Option<Sha256Digest>,
    pub verification_receipt_hash: Option<Sha256Digest>,
    pub commit_receipt_hash: Option<Sha256Digest>,
}

/// One bounded machine telemetry signal.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TelemetrySignalV1 {
    pub version: u16,
    pub signal_id: String,
    pub producer_id: String,
    pub producer_sequence: u64,
    pub signal_kind: TelemetrySignalKindV1,
    pub retention_class: TelemetryRetentionClassV1,
    pub observed_at_unix_ms: u64,
    pub retention_until_unix_ms: u64,
    pub module_id: Option<String>,
    pub module_version: Option<String>,
    pub correlation: TelemetryCorrelationV1,
    /// Bounded integer measurements with identifier keys.
    pub measurements: BTreeMap<String, u64>,
    /// Bounded identifier-only dimensions; free prose and path/environment dumps are invalid.
    pub identifiers: BTreeMap<String, String>,
    /// Bounded content identities for artifacts/configuration/evidence.
    pub digests: BTreeMap<String, Sha256Digest>,
    /// Safety violations are never normalized into a statistical success rate.
    pub zero_tolerance_violations: u32,
}

/// Privacy, retention and cardinality ceilings.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ObservabilityPolicyV1 {
    pub version: u16,
    pub maximum_signals: usize,
    pub maximum_cardinality: usize,
    pub maximum_fields_per_signal: usize,
    pub operational_retention_ms: u64,
    pub audit_retention_ms: u64,
    pub prediction_retention_ms: u64,
}

impl ObservabilityPolicyV1 {
    fn validate(&self) -> Result<(), ObservabilityError> {
        if self.version != 1
            || self.maximum_signals == 0
            || self.maximum_signals > MAXIMUM_SIGNALS
            || self.maximum_cardinality == 0
            || self.maximum_cardinality > MAXIMUM_SIGNALS
            || self.maximum_fields_per_signal == 0
            || self.maximum_fields_per_signal > MAXIMUM_FIELDS
            || self.operational_retention_ms == 0
            || self.audit_retention_ms == 0
            || self.prediction_retention_ms == 0
        {
            return Err(ObservabilityError::PolicyInvalid);
        }
        Ok(())
    }

    fn retention_ms(&self, class: TelemetryRetentionClassV1) -> u64 {
        match class {
            TelemetryRetentionClassV1::Operational => self.operational_retention_ms,
            TelemetryRetentionClassV1::Audit => self.audit_retention_ms,
            TelemetryRetentionClassV1::Prediction => self.prediction_retention_ms,
        }
    }
}

/// Canonical bounded telemetry export.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TelemetryExportV1 {
    pub version: u16,
    pub source_policy_hash: Sha256Digest,
    pub first_index: usize,
    pub next_index: usize,
    pub signal_hashes: Vec<Sha256Digest>,
    pub signals: Vec<TelemetrySignalV1>,
    pub export_hash: Sha256Digest,
}

/// In-memory source ledger used by the control plane before a deployment-specific sink.
/// It stores only bounded machine fields and preserves per-producer sequence high-watermarks.
#[derive(Clone, Debug)]
pub struct ObservabilityLedgerV1 {
    policy: ObservabilityPolicyV1,
    policy_hash: Sha256Digest,
    signals: Vec<TelemetrySignalV1>,
    signal_hashes: BTreeMap<String, Sha256Digest>,
    producer_high_watermarks: BTreeMap<String, u64>,
    cardinality: BTreeSet<String>,
}

impl ObservabilityLedgerV1 {
    pub fn new(policy: ObservabilityPolicyV1) -> Result<Self, ObservabilityError> {
        policy.validate()?;
        let policy_hash = canonical_hash_v1(&policy).map_err(|_| ObservabilityError::Encoding)?;
        Ok(Self {
            policy,
            policy_hash,
            signals: Vec::new(),
            signal_hashes: BTreeMap::new(),
            producer_high_watermarks: BTreeMap::new(),
            cardinality: BTreeSet::new(),
        })
    }

    /// Inserts one exact signal. Exact retries are idempotent; conflicting identity reuse fails.
    pub fn ingest(&mut self, signal: TelemetrySignalV1) -> Result<bool, ObservabilityError> {
        validate_signal(&signal, &self.policy)?;
        let signal_hash = canonical_hash_v1(&signal).map_err(|_| ObservabilityError::Encoding)?;
        if let Some(existing) = self.signal_hashes.get(&signal.signal_id) {
            return if existing == &signal_hash {
                Ok(false)
            } else {
                Err(ObservabilityError::IdentityConflict)
            };
        }
        if self.signals.len() == self.policy.maximum_signals {
            return Err(ObservabilityError::CapacityExceeded);
        }
        let expected_sequence = self
            .producer_high_watermarks
            .get(&signal.producer_id)
            .copied()
            .unwrap_or_default()
            .checked_add(1)
            .ok_or(ObservabilityError::NumericOverflow)?;
        if signal.producer_sequence != expected_sequence {
            return Err(ObservabilityError::SequenceInvalid);
        }
        let cardinality_key = cardinality_key(&signal);
        if !self.cardinality.contains(&cardinality_key)
            && self.cardinality.len() == self.policy.maximum_cardinality
        {
            return Err(ObservabilityError::CardinalityExceeded);
        }
        self.cardinality.insert(cardinality_key);
        self.producer_high_watermarks
            .insert(signal.producer_id.clone(), signal.producer_sequence);
        self.signal_hashes
            .insert(signal.signal_id.clone(), signal_hash);
        self.signals.push(signal);
        Ok(true)
    }

    /// Removes signals only after their explicit retention boundary. Producer sequence
    /// high-watermarks remain monotonic after pruning.
    pub fn prune_expired(&mut self, now_unix_ms: u64) -> Result<usize, ObservabilityError> {
        let before = self.signals.len();
        self.signals
            .retain(|signal| signal.retention_until_unix_ms > now_unix_ms);
        self.signal_hashes = self
            .signals
            .iter()
            .map(|signal| {
                canonical_hash_v1(signal)
                    .map(|hash| (signal.signal_id.clone(), hash))
                    .map_err(|_| ObservabilityError::Encoding)
            })
            .collect::<Result<BTreeMap<_, _>, _>>()?;
        self.cardinality = self.signals.iter().map(cardinality_key).collect();
        Ok(before.saturating_sub(self.signals.len()))
    }

    /// Exports a deterministic retained range with hashes for independent verification.
    pub fn export(
        &self,
        first_index: usize,
        maximum_count: usize,
    ) -> Result<TelemetryExportV1, ObservabilityError> {
        if maximum_count == 0 || first_index > self.signals.len() {
            return Err(ObservabilityError::RangeInvalid);
        }
        let next_index = first_index.saturating_add(maximum_count).min(self.signals.len());
        let signals = self
            .signals
            .get(first_index..next_index)
            .ok_or(ObservabilityError::RangeInvalid)?
            .to_vec();
        let signal_hashes = signals
            .iter()
            .map(|signal| canonical_hash_v1(signal).map_err(|_| ObservabilityError::Encoding))
            .collect::<Result<Vec<_>, _>>()?;
        let body = TelemetryExportBodyV1 {
            version: 1,
            source_policy_hash: &self.policy_hash,
            first_index,
            next_index,
            signal_hashes: &signal_hashes,
            signals: &signals,
        };
        let export_hash = canonical_hash_v1(&body).map_err(|_| ObservabilityError::Encoding)?;
        Ok(TelemetryExportV1 {
            version: body.version,
            source_policy_hash: self.policy_hash.clone(),
            first_index,
            next_index,
            signal_hashes,
            signals,
            export_hash,
        })
    }

    /// Extracts fresh calibration samples for one exact module and predictor identity.
    pub fn calibration_samples(
        &self,
        module_id: &str,
        module_version: &str,
        workload_id: &str,
        predictor_version: &str,
    ) -> Result<Vec<CalibrationSampleV1>, ObservabilityError> {
        if !valid_module_id(module_id)
            || !valid_identifier(module_version)
            || !valid_identifier(workload_id)
            || !valid_identifier(predictor_version)
        {
            return Err(ObservabilityError::SignalInvalid);
        }
        self.signals
            .iter()
            .filter(|signal| {
                signal.signal_kind == TelemetrySignalKindV1::Prediction
                    && signal.module_id.as_deref() == Some(module_id)
                    && signal.module_version.as_deref() == Some(module_version)
                    && signal.identifiers.get("workload_id").map(String::as_str)
                        == Some(workload_id)
                    && signal
                        .identifiers
                        .get("predictor_version")
                        .map(String::as_str)
                        == Some(predictor_version)
            })
            .map(prediction_sample)
            .collect()
    }

    #[must_use]
    pub fn signals(&self) -> &[TelemetrySignalV1] {
        &self.signals
    }
}

fn validate_signal(
    signal: &TelemetrySignalV1,
    policy: &ObservabilityPolicyV1,
) -> Result<(), ObservabilityError> {
    let field_count = signal
        .measurements
        .len()
        .checked_add(signal.identifiers.len())
        .and_then(|count| count.checked_add(signal.digests.len()))
        .ok_or(ObservabilityError::NumericOverflow)?;
    if signal.version != 1
        || !valid_identifier(&signal.signal_id)
        || !valid_identifier(&signal.producer_id)
        || signal.producer_sequence == 0
        || signal.observed_at_unix_ms == 0
        || signal.retention_until_unix_ms <= signal.observed_at_unix_ms
        || signal.retention_until_unix_ms
            > signal
                .observed_at_unix_ms
                .saturating_add(policy.retention_ms(signal.retention_class))
        || field_count > policy.maximum_fields_per_signal
        || signal
            .measurements
            .keys()
            .chain(signal.identifiers.keys())
            .chain(signal.digests.keys())
            .any(|key| !valid_identifier(key))
        || signal.identifiers.values().any(|value| !valid_identifier(value))
        || signal.module_id.is_some() != signal.module_version.is_some()
        || signal
            .module_id
            .as_deref()
            .is_some_and(|module| !valid_module_id(module))
        || signal
            .module_version
            .as_deref()
            .is_some_and(|version| !valid_identifier(version))
        || signal
            .correlation
            .reservation_id
            .as_deref()
            .is_some_and(|value| !valid_identifier(value))
        || signal
            .correlation
            .attempt_id
            .as_deref()
            .is_some_and(|value| !valid_identifier(value))
    {
        return Err(ObservabilityError::SignalInvalid);
    }
    match signal.signal_kind {
        TelemetrySignalKindV1::Verification | TelemetrySignalKindV1::Commit => {
            if signal.retention_class != TelemetryRetentionClassV1::Audit {
                return Err(ObservabilityError::SignalInvalid);
            }
        }
        TelemetrySignalKindV1::Prediction => {
            if signal.retention_class != TelemetryRetentionClassV1::Prediction {
                return Err(ObservabilityError::SignalInvalid);
            }
            require_prediction_fields(signal)?;
        }
        _ => {}
    }
    Ok(())
}

fn require_prediction_fields(signal: &TelemetrySignalV1) -> Result<(), ObservabilityError> {
    for key in ["workload_id", "predictor_version"] {
        if !signal.identifiers.contains_key(key) {
            return Err(ObservabilityError::SignalInvalid);
        }
    }
    for key in [
        "predicted_duration_ms",
        "actual_duration_ms",
        "predicted_cost_microusd",
        "actual_cost_microusd",
        "confidence_ppm",
    ] {
        if !signal.measurements.contains_key(key) {
            return Err(ObservabilityError::SignalInvalid);
        }
    }
    if signal
        .measurements
        .get("confidence_ppm")
        .is_none_or(|value| *value > 1_000_000)
    {
        return Err(ObservabilityError::SignalInvalid);
    }
    Ok(())
}

fn prediction_sample(signal: &TelemetrySignalV1) -> Result<CalibrationSampleV1, ObservabilityError> {
    let measurement = |key: &str| {
        signal
            .measurements
            .get(key)
            .copied()
            .ok_or(ObservabilityError::SignalInvalid)
    };
    let identifier = |key: &str| {
        signal
            .identifiers
            .get(key)
            .cloned()
            .ok_or(ObservabilityError::SignalInvalid)
    };
    Ok(CalibrationSampleV1 {
        workload_id: identifier("workload_id")?,
        predictor_version: identifier("predictor_version")?,
        observed_at_unix_ms: signal.observed_at_unix_ms,
        predicted_duration_ms: measurement("predicted_duration_ms")?,
        actual_duration_ms: measurement("actual_duration_ms")?,
        predicted_cost_microusd: measurement("predicted_cost_microusd")?,
        actual_cost_microusd: measurement("actual_cost_microusd")?,
        confidence_ppm: u32::try_from(measurement("confidence_ppm")?)
            .map_err(|_| ObservabilityError::SignalInvalid)?,
    })
}

fn cardinality_key(signal: &TelemetrySignalV1) -> String {
    format!(
        "{:?}:{}:{}:{}",
        signal.signal_kind,
        signal.module_id.as_deref().unwrap_or("none"),
        signal.module_version.as_deref().unwrap_or("none"),
        signal.producer_id
    )
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct TelemetryExportBodyV1<'a> {
    version: u16,
    source_policy_hash: &'a Sha256Digest,
    first_index: usize,
    next_index: usize,
    signal_hashes: &'a [Sha256Digest],
    signals: &'a [TelemetrySignalV1],
}

fn valid_identifier(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 128
        && value.bytes().all(|byte| {
            byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b'-' | b':' | b'/')
        })
}

fn valid_module_id(value: &str) -> bool {
    value.starts_with("module.") && valid_identifier(value)
}

#[derive(Clone, Copy, Debug, Error, Eq, PartialEq)]
pub enum ObservabilityError {
    #[error("observability policy is invalid")]
    PolicyInvalid,
    #[error("telemetry signal is invalid")]
    SignalInvalid,
    #[error("telemetry identity is reused with different content")]
    IdentityConflict,
    #[error("telemetry producer sequence is invalid")]
    SequenceInvalid,
    #[error("telemetry capacity is exhausted")]
    CapacityExceeded,
    #[error("telemetry cardinality budget is exhausted")]
    CardinalityExceeded,
    #[error("telemetry export range is invalid")]
    RangeInvalid,
    #[error("telemetry arithmetic overflow")]
    NumericOverflow,
    #[error("telemetry canonical encoding failed")]
    Encoding,
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
            maximum_signals: 16,
            maximum_cardinality: 8,
            maximum_fields_per_signal: 16,
            operational_retention_ms: 1_000,
            audit_retention_ms: 10_000,
            prediction_retention_ms: 5_000,
        }
    }

    fn prediction_signal(sequence: u64) -> TelemetrySignalV1 {
        TelemetrySignalV1 {
            version: 1,
            signal_id: format!("signal:{sequence}"),
            producer_id: "producer:control".into(),
            producer_sequence: sequence,
            signal_kind: TelemetrySignalKindV1::Prediction,
            retention_class: TelemetryRetentionClassV1::Prediction,
            observed_at_unix_ms: 100 + sequence,
            retention_until_unix_ms: 1_000,
            module_id: Some("module.scheduler-core".into()),
            module_version: Some("v1".into()),
            correlation: TelemetryCorrelationV1 {
                snapshot_hash: digest('a'),
                plan_hash: Some(digest('b')),
                reservation_id: None,
                attempt_id: None,
                prepared_result_hash: None,
                verification_receipt_hash: None,
                commit_receipt_hash: None,
            },
            measurements: BTreeMap::from([
                ("predicted_duration_ms".into(), 100),
                ("actual_duration_ms".into(), 110),
                ("predicted_cost_microusd".into(), 1_000),
                ("actual_cost_microusd".into(), 1_100),
                ("confidence_ppm".into(), 900_000),
            ]),
            identifiers: BTreeMap::from([
                ("workload_id".into(), "workload:author".into()),
                ("predictor_version".into(), "predictor:v1".into()),
            ]),
            digests: BTreeMap::new(),
            zero_tolerance_violations: 0,
        }
    }

    #[test]
    fn exact_retry_is_idempotent_and_conflicting_reuse_fails() {
        let mut ledger = ObservabilityLedgerV1::new(policy()).expect("ledger");
        let signal = prediction_signal(1);
        assert!(ledger.ingest(signal.clone()).expect("insert"));
        assert!(!ledger.ingest(signal.clone()).expect("exact retry"));
        let mut conflict = signal;
        conflict.measurements.insert("actual_duration_ms".into(), 111);
        assert_eq!(
            ledger.ingest(conflict),
            Err(ObservabilityError::IdentityConflict)
        );
    }

    #[test]
    fn prediction_records_produce_module_version_scoped_calibration_samples() {
        let mut ledger = ObservabilityLedgerV1::new(policy()).expect("ledger");
        ledger.ingest(prediction_signal(1)).expect("signal");
        let samples = ledger
            .calibration_samples(
                "module.scheduler-core",
                "v1",
                "workload:author",
                "predictor:v1",
            )
            .expect("samples");
        assert_eq!(samples.len(), 1);
        assert_eq!(samples[0].actual_duration_ms, 110);
    }

    #[test]
    fn export_is_hashed_and_retention_pruning_preserves_sequence_high_watermark() {
        let mut ledger = ObservabilityLedgerV1::new(policy()).expect("ledger");
        ledger.ingest(prediction_signal(1)).expect("signal");
        let export = ledger.export(0, 10).expect("export");
        assert_eq!(export.signals.len(), 1);
        assert!(export.export_hash.as_str().starts_with("sha256:"));
        assert_eq!(ledger.prune_expired(1_001).expect("prune"), 1);
        let mut next = prediction_signal(2);
        next.observed_at_unix_ms = 1_002;
        next.retention_until_unix_ms = 2_000;
        assert!(ledger.ingest(next).expect("next sequence"));
    }

    #[test]
    fn audit_kind_requires_audit_retention_and_free_text_is_rejected() {
        let mut ledger = ObservabilityLedgerV1::new(policy()).expect("ledger");
        let mut signal = prediction_signal(1);
        signal.signal_kind = TelemetrySignalKindV1::Commit;
        signal.retention_class = TelemetryRetentionClassV1::Operational;
        signal.identifiers.insert("note".into(), "free text".into());
        assert_eq!(
            ledger.ingest(signal),
            Err(ObservabilityError::SignalInvalid)
        );
    }
}
