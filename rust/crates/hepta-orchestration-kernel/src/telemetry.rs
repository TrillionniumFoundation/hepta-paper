use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::BTreeMap;
use thiserror::Error;

const LATENCY_BUCKETS_MS: [u64; 10] = [1, 5, 10, 25, 50, 100, 250, 500, 1_000, u64::MAX];
const MAX_COUNTER_VALUE: u64 = i64::MAX as u64;

/// Fixed event vocabulary. Free-form operation or user identifiers are absent by design.
#[derive(Clone, Copy, Debug, Deserialize, Eq, Ord, PartialEq, PartialOrd, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum EventCodeV1 {
    Admission,
    PlanningSnapshot,
    CandidateRoute,
    ResourcePrepare,
    ResourceCommit,
    ResourceFinalize,
    Dispatch,
    PreparedResult,
    CampaignCommit,
    Recovery,
    Cutover,
    ExternalAuthority,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, Ord, PartialEq, PartialOrd, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ModuleClassV1 {
    ControlPlane,
    Broker,
    Workspace,
    Compatibility,
    CampaignWriter,
    ScientificEvidence,
    ReleaseBoundary,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, Ord, PartialEq, PartialOrd, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum OutcomeClassV1 {
    Accepted,
    RejectedPolicy,
    RejectedAuthority,
    RejectedIdentity,
    RejectedBudget,
    RetryableFailure,
    TerminalFailure,
    Ambiguous,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, Ord, PartialEq, PartialOrd, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum SeverityV1 {
    Info,
    Warning,
    Error,
    Critical,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, Ord, PartialEq, PartialOrd, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum LabelKeyV1 {
    AuthorityTier,
    ExecutionClass,
    RecoveryClass,
    ResourceClass,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, Ord, PartialEq, PartialOrd, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum LabelValueV1 {
    None,
    Source,
    Hosted,
    TargetHost,
    External,
    NativeRust,
    ReadOnlyLegacy,
    Prepared,
    Committed,
    Finalized,
    Cancelled,
    Ambiguous,
    Cpu,
    Gpu,
    Storage,
    Network,
}

/// One bounded observation. It intentionally has no free-form message, path,
/// campaign ID, attempt ID, account, host name, credential or artifact field.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ObservationInputV1 {
    pub event_code: EventCodeV1,
    pub module_class: ModuleClassV1,
    pub outcome_class: OutcomeClassV1,
    pub severity: SeverityV1,
    pub latency_ms: u64,
    pub observed_at_unix_ms: u64,
    pub labels: BTreeMap<LabelKeyV1, LabelValueV1>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CounterSampleV1 {
    pub event_code: EventCodeV1,
    pub module_class: ModuleClassV1,
    pub outcome_class: OutcomeClassV1,
    pub severity: SeverityV1,
    pub value: u64,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct HistogramSampleV1 {
    pub event_code: EventCodeV1,
    pub module_class: ModuleClassV1,
    pub outcome_class: OutcomeClassV1,
    pub upper_bound_ms: u64,
    pub value: u64,
}

/// Privacy-safe aggregate with deterministic ordering and identity.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TelemetrySnapshotV1 {
    pub version: u16,
    pub observation_count: u64,
    pub first_observed_at_unix_ms: u64,
    pub last_observed_at_unix_ms: u64,
    pub counters: Vec<CounterSampleV1>,
    pub latency_histogram: Vec<HistogramSampleV1>,
    pub snapshot_hash: String,
}

#[derive(Clone, Copy, Debug, Eq, Ord, PartialEq, PartialOrd)]
struct CounterKeyV1 {
    event_code: EventCodeV1,
    module_class: ModuleClassV1,
    outcome_class: OutcomeClassV1,
    severity: SeverityV1,
}

#[derive(Clone, Copy, Debug, Eq, Ord, PartialEq, PartialOrd)]
struct HistogramKeyV1 {
    event_code: EventCodeV1,
    module_class: ModuleClassV1,
    outcome_class: OutcomeClassV1,
    upper_bound_ms: u64,
}

/// In-memory aggregate. Durable persistence is owned by the campaign writer;
/// this type never stores raw events after aggregation.
#[derive(Clone, Debug, Default)]
pub struct TelemetryAggregatorV1 {
    observation_count: u64,
    first_observed_at_unix_ms: Option<u64>,
    last_observed_at_unix_ms: Option<u64>,
    counters: BTreeMap<CounterKeyV1, u64>,
    latency_histogram: BTreeMap<HistogramKeyV1, u64>,
}

impl TelemetryAggregatorV1 {
    pub fn record(&mut self, observation: ObservationInputV1) -> Result<(), TelemetryError> {
        if observation.observed_at_unix_ms == 0 || observation.labels.len() > 4 {
            return Err(TelemetryError::Contract);
        }
        if self
            .last_observed_at_unix_ms
            .is_some_and(|last| observation.observed_at_unix_ms < last)
        {
            return Err(TelemetryError::ClockRegression);
        }
        self.observation_count = self
            .observation_count
            .checked_add(1)
            .filter(|value| *value <= MAX_COUNTER_VALUE)
            .ok_or(TelemetryError::CounterOverflow)?;
        self.first_observed_at_unix_ms
            .get_or_insert(observation.observed_at_unix_ms);
        self.last_observed_at_unix_ms = Some(observation.observed_at_unix_ms);

        let counter_key = CounterKeyV1 {
            event_code: observation.event_code,
            module_class: observation.module_class,
            outcome_class: observation.outcome_class,
            severity: observation.severity,
        };
        increment(&mut self.counters, counter_key)?;
        let upper_bound_ms = LATENCY_BUCKETS_MS
            .iter()
            .copied()
            .find(|bound| observation.latency_ms <= *bound)
            .ok_or(TelemetryError::Invariant)?;
        let histogram_key = HistogramKeyV1 {
            event_code: observation.event_code,
            module_class: observation.module_class,
            outcome_class: observation.outcome_class,
            upper_bound_ms,
        };
        increment(&mut self.latency_histogram, histogram_key)?;
        Ok(())
    }

    pub fn snapshot(&self) -> Result<TelemetrySnapshotV1, TelemetryError> {
        let first_observed_at_unix_ms = self
            .first_observed_at_unix_ms
            .ok_or(TelemetryError::Empty)?;
        let last_observed_at_unix_ms = self
            .last_observed_at_unix_ms
            .ok_or(TelemetryError::Empty)?;
        let counters = self
            .counters
            .iter()
            .map(|(key, value)| CounterSampleV1 {
                event_code: key.event_code,
                module_class: key.module_class,
                outcome_class: key.outcome_class,
                severity: key.severity,
                value: *value,
            })
            .collect::<Vec<_>>();
        let latency_histogram = self
            .latency_histogram
            .iter()
            .map(|(key, value)| HistogramSampleV1 {
                event_code: key.event_code,
                module_class: key.module_class,
                outcome_class: key.outcome_class,
                upper_bound_ms: key.upper_bound_ms,
                value: *value,
            })
            .collect::<Vec<_>>();
        let body = TelemetrySnapshotBodyV1 {
            version: 1,
            observation_count: self.observation_count,
            first_observed_at_unix_ms,
            last_observed_at_unix_ms,
            counters: &counters,
            latency_histogram: &latency_histogram,
        };
        let snapshot_hash = canonical_hash("HeptaTelemetrySnapshotV1", &body)?;
        Ok(TelemetrySnapshotV1 {
            version: 1,
            observation_count: self.observation_count,
            first_observed_at_unix_ms,
            last_observed_at_unix_ms,
            counters,
            latency_histogram,
            snapshot_hash,
        })
    }
}

fn increment<K: Ord>(map: &mut BTreeMap<K, u64>, key: K) -> Result<(), TelemetryError> {
    let value = map.entry(key).or_insert(0);
    *value = value
        .checked_add(1)
        .filter(|count| *count <= MAX_COUNTER_VALUE)
        .ok_or(TelemetryError::CounterOverflow)?;
    Ok(())
}

fn canonical_hash<T: Serialize>(domain: &str, value: &T) -> Result<String, TelemetryError> {
    let bytes = serde_json::to_vec(value).map_err(|_| TelemetryError::Encoding)?;
    let mut hasher = Sha256::new();
    update_hash(&mut hasher, domain.as_bytes());
    update_hash(&mut hasher, &bytes);
    Ok(format!("sha256:{}", hex::encode(hasher.finalize())))
}

fn update_hash(hasher: &mut Sha256, value: &[u8]) {
    hasher.update(u64::try_from(value.len()).unwrap_or(u64::MAX).to_be_bytes());
    hasher.update(value);
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct TelemetrySnapshotBodyV1<'a> {
    version: u16,
    observation_count: u64,
    first_observed_at_unix_ms: u64,
    last_observed_at_unix_ms: u64,
    counters: &'a [CounterSampleV1],
    latency_histogram: &'a [HistogramSampleV1],
}

#[derive(Clone, Debug, Error, Eq, PartialEq)]
pub enum TelemetryError {
    #[error("telemetry observation is invalid")]
    Contract,
    #[error("telemetry clock regressed")]
    ClockRegression,
    #[error("telemetry aggregate is empty")]
    Empty,
    #[error("telemetry counter overflowed")]
    CounterOverflow,
    #[error("telemetry invariant failed")]
    Invariant,
    #[error("telemetry encoding failed")]
    Encoding,
}

#[cfg(test)]
mod tests {
    use super::*;

    fn observation(at: u64, outcome: OutcomeClassV1) -> ObservationInputV1 {
        ObservationInputV1 {
            event_code: EventCodeV1::Dispatch,
            module_class: ModuleClassV1::Broker,
            outcome_class: outcome,
            severity: SeverityV1::Info,
            latency_ms: 8,
            observed_at_unix_ms: at,
            labels: BTreeMap::from([(
                LabelKeyV1::ExecutionClass,
                LabelValueV1::NativeRust,
            )]),
        }
    }

    #[test]
    fn aggregate_contains_no_free_form_identity() {
        let mut aggregate = TelemetryAggregatorV1::default();
        assert!(aggregate.record(observation(10, OutcomeClassV1::Accepted)).is_ok());
        assert!(aggregate.record(observation(11, OutcomeClassV1::Accepted)).is_ok());
        match aggregate.snapshot() {
            Ok(snapshot) => {
                assert_eq!(snapshot.observation_count, 2);
                assert_eq!(snapshot.counters.len(), 1);
                assert_eq!(snapshot.latency_histogram.len(), 1);
            }
            other => assert!(false, "unexpected snapshot: {other:?}"),
        }
    }

    #[test]
    fn clock_regression_fails_closed() {
        let mut aggregate = TelemetryAggregatorV1::default();
        assert!(aggregate.record(observation(10, OutcomeClassV1::Accepted)).is_ok());
        assert_eq!(
            aggregate.record(observation(9, OutcomeClassV1::Accepted)),
            Err(TelemetryError::ClockRegression)
        );
    }
}
