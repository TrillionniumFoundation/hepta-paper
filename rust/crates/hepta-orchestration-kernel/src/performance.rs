use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::BTreeMap;
use thiserror::Error;

const MINIMUM_SAMPLES: usize = 7;
const MAXIMUM_SAMPLES: usize = 10_000;
const MAXIMUM_WORKLOADS: usize = 256;
const NANOS_PER_SECOND: u128 = 1_000_000_000;
const PARTS_PER_MILLION: u128 = 1_000_000;

/// Exact binary/configuration/host subject of one performance observation set.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PerformanceSubjectV1 {
    pub repository: String,
    pub commit: String,
    pub tree: String,
    pub binary_hash: String,
    pub configuration_hash: String,
    pub host_profile_hash: String,
}

/// Canonical workload and its accepted regression envelope.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CanonicalWorkloadV1 {
    pub workload_id: String,
    pub workload_hash: String,
    pub operations_per_sample: u64,
    pub baseline_median_duration_ns: u64,
    pub maximum_regression_ppm: u32,
    pub minimum_throughput_per_second: u64,
    pub maximum_p95_duration_ns: u64,
}

/// Raw retained sample durations for one workload.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PerformanceObservationV1 {
    pub workload_id: String,
    pub sample_durations_ns: Vec<u64>,
}

/// One deterministic workload decision.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WorkloadQualificationV1 {
    pub workload_id: String,
    pub sample_count: usize,
    pub median_duration_ns: u64,
    pub p95_duration_ns: u64,
    pub throughput_per_second: u64,
    pub regression_ppm: u32,
    pub accepted: bool,
}

/// Source/hosted performance receipt. It never represents target-host production
/// qualification unless the bound host profile is independently accepted.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PerformanceQualificationReceiptV1 {
    pub version: u16,
    pub subject: PerformanceSubjectV1,
    pub workload_policy_hash: String,
    pub workload_results: Vec<WorkloadQualificationV1>,
    pub all_workloads_accepted: bool,
    pub production_authority_granted: bool,
    pub receipt_hash: String,
}

/// Qualify a complete, exact canonical workload set using deterministic integer
/// statistics. Missing, duplicate and extra observations fail closed.
pub fn qualify_performance_v1(
    subject: PerformanceSubjectV1,
    mut workloads: Vec<CanonicalWorkloadV1>,
    observations: Vec<PerformanceObservationV1>,
) -> Result<PerformanceQualificationReceiptV1, PerformanceQualificationError> {
    validate_subject(&subject)?;
    if workloads.is_empty() || workloads.len() > MAXIMUM_WORKLOADS {
        return Err(PerformanceQualificationError::Contract);
    }
    workloads.sort_by(|left, right| left.workload_id.cmp(&right.workload_id));
    if workloads
        .windows(2)
        .any(|window| window[0].workload_id == window[1].workload_id)
    {
        return Err(PerformanceQualificationError::DuplicateWorkload);
    }
    for workload in &workloads {
        validate_workload(workload)?;
    }
    let mut observations_by_id = BTreeMap::new();
    for observation in observations {
        if !valid_identifier(&observation.workload_id, 256)
            || observation.sample_durations_ns.len() < MINIMUM_SAMPLES
            || observation.sample_durations_ns.len() > MAXIMUM_SAMPLES
            || observation
                .sample_durations_ns
                .iter()
                .any(|duration| *duration == 0)
            || observations_by_id
                .insert(observation.workload_id.clone(), observation)
                .is_some()
        {
            return Err(PerformanceQualificationError::ObservationInvalid);
        }
    }
    if observations_by_id.len() != workloads.len() {
        return Err(PerformanceQualificationError::ObservationSetMismatch);
    }

    let mut workload_results = Vec::with_capacity(workloads.len());
    for workload in &workloads {
        let observation = observations_by_id
            .remove(&workload.workload_id)
            .ok_or(PerformanceQualificationError::ObservationSetMismatch)?;
        let mut durations = observation.sample_durations_ns;
        durations.sort_unstable();
        let median_duration_ns = median(&durations)?;
        let p95_duration_ns = percentile_95(&durations)?;
        let throughput_per_second = throughput(
            workload.operations_per_sample,
            median_duration_ns,
        )?;
        let regression_ppm = regression_ppm(
            workload.baseline_median_duration_ns,
            median_duration_ns,
        )?;
        let accepted = regression_ppm <= workload.maximum_regression_ppm
            && throughput_per_second >= workload.minimum_throughput_per_second
            && p95_duration_ns <= workload.maximum_p95_duration_ns;
        workload_results.push(WorkloadQualificationV1 {
            workload_id: workload.workload_id.clone(),
            sample_count: durations.len(),
            median_duration_ns,
            p95_duration_ns,
            throughput_per_second,
            regression_ppm,
            accepted,
        });
    }
    if !observations_by_id.is_empty() {
        return Err(PerformanceQualificationError::ObservationSetMismatch);
    }
    let workload_policy_hash = canonical_hash("HeptaCanonicalPerformancePolicyV1", &workloads)?;
    let all_workloads_accepted = workload_results.iter().all(|result| result.accepted);
    let body = PerformanceReceiptBodyV1 {
        version: 1,
        subject: &subject,
        workload_policy_hash: &workload_policy_hash,
        workload_results: &workload_results,
        all_workloads_accepted,
        production_authority_granted: false,
    };
    let receipt_hash = canonical_hash("HeptaPerformanceQualificationReceiptV1", &body)?;
    Ok(PerformanceQualificationReceiptV1 {
        version: 1,
        subject,
        workload_policy_hash,
        workload_results,
        all_workloads_accepted,
        production_authority_granted: false,
        receipt_hash,
    })
}

fn median(values: &[u64]) -> Result<u64, PerformanceQualificationError> {
    let midpoint = values.len() / 2;
    if values.len() % 2 == 1 {
        return values
            .get(midpoint)
            .copied()
            .ok_or(PerformanceQualificationError::ObservationInvalid);
    }
    let left = values
        .get(midpoint.saturating_sub(1))
        .copied()
        .ok_or(PerformanceQualificationError::ObservationInvalid)?;
    let right = values
        .get(midpoint)
        .copied()
        .ok_or(PerformanceQualificationError::ObservationInvalid)?;
    left.checked_add(right)
        .map(|sum| sum / 2)
        .ok_or(PerformanceQualificationError::Arithmetic)
}

fn percentile_95(values: &[u64]) -> Result<u64, PerformanceQualificationError> {
    let rank = values
        .len()
        .checked_mul(95)
        .and_then(|value| value.checked_add(99))
        .map(|value| value / 100)
        .ok_or(PerformanceQualificationError::Arithmetic)?;
    values
        .get(rank.saturating_sub(1))
        .copied()
        .ok_or(PerformanceQualificationError::ObservationInvalid)
}

fn throughput(
    operations_per_sample: u64,
    duration_ns: u64,
) -> Result<u64, PerformanceQualificationError> {
    let value = u128::from(operations_per_sample)
        .checked_mul(NANOS_PER_SECOND)
        .ok_or(PerformanceQualificationError::Arithmetic)?
        / u128::from(duration_ns);
    u64::try_from(value).map_err(|_| PerformanceQualificationError::Arithmetic)
}

fn regression_ppm(
    baseline_duration_ns: u64,
    observed_duration_ns: u64,
) -> Result<u32, PerformanceQualificationError> {
    if observed_duration_ns <= baseline_duration_ns {
        return Ok(0);
    }
    let increase = u128::from(observed_duration_ns - baseline_duration_ns);
    let value = increase
        .checked_mul(PARTS_PER_MILLION)
        .ok_or(PerformanceQualificationError::Arithmetic)?
        / u128::from(baseline_duration_ns);
    u32::try_from(value).map_err(|_| PerformanceQualificationError::Arithmetic)
}

fn validate_subject(subject: &PerformanceSubjectV1) -> Result<(), PerformanceQualificationError> {
    if subject.repository != "TrillionniumFoundation/hepta-paper"
        || !valid_git_hash(&subject.commit)
        || !valid_git_hash(&subject.tree)
        || !valid_digest(&subject.binary_hash)
        || !valid_digest(&subject.configuration_hash)
        || !valid_digest(&subject.host_profile_hash)
    {
        return Err(PerformanceQualificationError::SubjectInvalid);
    }
    Ok(())
}

fn validate_workload(
    workload: &CanonicalWorkloadV1,
) -> Result<(), PerformanceQualificationError> {
    if !valid_identifier(&workload.workload_id, 256)
        || !valid_digest(&workload.workload_hash)
        || workload.operations_per_sample == 0
        || workload.baseline_median_duration_ns == 0
        || workload.maximum_regression_ppm > 10_000_000
        || workload.minimum_throughput_per_second == 0
        || workload.maximum_p95_duration_ns < workload.baseline_median_duration_ns
    {
        return Err(PerformanceQualificationError::Contract);
    }
    Ok(())
}

fn valid_identifier(value: &str, maximum: usize) -> bool {
    !value.is_empty()
        && value.len() <= maximum
        && value.bytes().all(|byte| {
            byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.' | b':' | b'/')
        })
}

fn valid_git_hash(value: &str) -> bool {
    value.len() == 40
        && value
            .bytes()
            .all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase())
}

fn valid_digest(value: &str) -> bool {
    value.len() == 71
        && value.starts_with("sha256:")
        && value[7..]
            .bytes()
            .all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase())
}

fn canonical_hash<T: Serialize>(
    domain: &str,
    value: &T,
) -> Result<String, PerformanceQualificationError> {
    let bytes = serde_json::to_vec(value).map_err(|_| PerformanceQualificationError::Encoding)?;
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
struct PerformanceReceiptBodyV1<'a> {
    version: u16,
    subject: &'a PerformanceSubjectV1,
    workload_policy_hash: &'a str,
    workload_results: &'a [WorkloadQualificationV1],
    all_workloads_accepted: bool,
    production_authority_granted: bool,
}

#[derive(Clone, Debug, Error, Eq, PartialEq)]
pub enum PerformanceQualificationError {
    #[error("performance qualification contract is invalid")]
    Contract,
    #[error("performance subject is invalid")]
    SubjectInvalid,
    #[error("canonical workload is duplicated")]
    DuplicateWorkload,
    #[error("performance observation is invalid")]
    ObservationInvalid,
    #[error("performance observation set does not match the workload set")]
    ObservationSetMismatch,
    #[error("performance arithmetic overflowed")]
    Arithmetic,
    #[error("performance qualification encoding failed")]
    Encoding,
}

#[cfg(test)]
mod tests {
    use super::*;

    fn digest(byte: char) -> String {
        format!("sha256:{}", byte.to_string().repeat(64))
    }

    fn subject() -> PerformanceSubjectV1 {
        PerformanceSubjectV1 {
            repository: "TrillionniumFoundation/hepta-paper".to_owned(),
            commit: "a".repeat(40),
            tree: "b".repeat(40),
            binary_hash: digest('c'),
            configuration_hash: digest('d'),
            host_profile_hash: digest('e'),
        }
    }

    fn workload() -> CanonicalWorkloadV1 {
        CanonicalWorkloadV1 {
            workload_id: "workload:route".to_owned(),
            workload_hash: digest('f'),
            operations_per_sample: 100,
            baseline_median_duration_ns: 1_000,
            maximum_regression_ppm: 100_000,
            minimum_throughput_per_second: 50_000_000,
            maximum_p95_duration_ns: 1_500,
        }
    }

    #[test]
    fn canonical_samples_are_accepted() {
        let result = qualify_performance_v1(
            subject(),
            vec![workload()],
            vec![PerformanceObservationV1 {
                workload_id: "workload:route".to_owned(),
                sample_durations_ns: vec![900, 950, 980, 1_000, 1_010, 1_020, 1_050],
            }],
        );
        match result {
            Ok(receipt) => {
                assert!(receipt.all_workloads_accepted);
                assert!(!receipt.production_authority_granted);
                assert_eq!(receipt.workload_results[0].median_duration_ns, 1_000);
            }
            other => assert!(false, "unexpected qualification: {other:?}"),
        }
    }

    #[test]
    fn missing_or_regressed_workload_fails_closed() {
        assert_eq!(
            qualify_performance_v1(subject(), vec![workload()], Vec::new()),
            Err(PerformanceQualificationError::ObservationSetMismatch)
        );
        let result = qualify_performance_v1(
            subject(),
            vec![workload()],
            vec![PerformanceObservationV1 {
                workload_id: "workload:route".to_owned(),
                sample_durations_ns: vec![2_000; 7],
            }],
        );
        match result {
            Ok(receipt) => assert!(!receipt.all_workloads_accepted),
            other => assert!(false, "unexpected qualification: {other:?}"),
        }
    }
}
