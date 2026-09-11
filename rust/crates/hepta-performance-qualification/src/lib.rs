//! Read-only, exact-subject performance and calibration aggregation.
//!
//! This crate turns bounded raw measurements into deterministic integer-only
//! summaries. It never discovers host truth, activates a module, or grants
//! deployment authority; callers must independently authenticate every subject
//! hash and retain the raw measurements used to construct the request.

#![forbid(unsafe_code)]

use hepta_codex_protocol::Sha256Digest;
use hepta_control_plane::{
    CalibrationObservationV1, CalibrationPolicyV1, CalibrationReportV1, PerformanceAssessmentV1,
    PerformanceBudgetV1, PerformanceSampleV1, assess_calibration_v1, assess_performance_v1,
    canonical_hash_v1,
};
use serde::{Deserialize, Serialize};
use thiserror::Error;

/// Maximum accepted encoded request size for the command process.
pub const MAXIMUM_QUALIFICATION_REQUEST_BYTES_V1: u64 = 16 * 1024 * 1024;

/// Exact immutable subject whose measurements are being aggregated.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PerformanceQualificationSubjectV1 {
    /// Exact source-tree identity.
    pub source_hash: Sha256Digest,
    /// Exact executable or image identity.
    pub binary_hash: Sha256Digest,
    /// Exact runtime configuration identity.
    pub configuration_hash: Sha256Digest,
    /// Independently produced host identity.
    pub host_identity_hash: Sha256Digest,
    /// Exact canonical workload identity.
    pub workload_hash: Sha256Digest,
    /// Exact measurement-method identity.
    pub measurement_method_hash: Sha256Digest,
    /// Exact SLO/threshold-version identity.
    pub threshold_version_hash: Sha256Digest,
    /// Exact cold/warm-cache policy identity.
    pub warm_cold_policy_hash: Sha256Digest,
}

impl PerformanceQualificationSubjectV1 {
    /// Canonical identity of the complete measurement subject.
    pub fn subject_hash(&self) -> Result<Sha256Digest, PerformanceQualificationError> {
        canonical_hash_v1(self).map_err(|_| PerformanceQualificationError::EncodingInvalid)
    }
}

/// Bounded read-only qualification request.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PerformanceQualificationRequestV1 {
    /// Contract version, exactly one.
    pub version: u16,
    /// Exact measurement subject.
    pub subject: PerformanceQualificationSubjectV1,
    /// Versioned performance budget.
    pub performance_budget: PerformanceBudgetV1,
    /// Raw bounded performance samples.
    pub performance_samples: Vec<PerformanceSampleV1>,
    /// Optional scheduler/calibration policy.
    pub calibration_policy: Option<CalibrationPolicyV1>,
    /// Raw calibration observations. Must be empty when no policy is supplied.
    pub calibration_observations: Vec<CalibrationObservationV1>,
}

/// Deterministic qualification aggregation. It is evidence content, not evidence authority.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PerformanceQualificationReceiptV1 {
    /// Contract version.
    pub version: u16,
    /// Exact subject identity.
    pub subject_hash: Sha256Digest,
    /// Deterministic SLO assessment.
    pub performance: PerformanceAssessmentV1,
    /// Optional deterministic scheduler calibration assessment.
    pub calibration: Option<CalibrationReportV1>,
    /// True only when all requested numeric policies passed.
    pub accepted: bool,
    /// Always false: this process cannot grant deployment or production authority.
    pub grants_authority: bool,
    /// Canonical receipt identity excluding this field.
    pub receipt_hash: Sha256Digest,
}

/// Aggregates one exact bounded measurement request.
pub fn qualify_performance_v1(
    request: &PerformanceQualificationRequestV1,
) -> Result<PerformanceQualificationReceiptV1, PerformanceQualificationError> {
    if request.version != 1
        || request.performance_samples.is_empty()
        || request.performance_samples.len() > 1_000_000
        || request.calibration_observations.len() > 1_000_000
        || (request.calibration_policy.is_none() && !request.calibration_observations.is_empty())
    {
        return Err(PerformanceQualificationError::RequestInvalid);
    }
    let subject_hash = request.subject.subject_hash()?;
    let performance = assess_performance_v1(
        &request.performance_budget,
        request.performance_samples.as_slice(),
    )
    .map_err(|_| PerformanceQualificationError::MeasurementInvalid)?;
    let calibration = match &request.calibration_policy {
        Some(policy) => Some(
            assess_calibration_v1(policy, request.calibration_observations.as_slice())
                .map_err(|_| PerformanceQualificationError::MeasurementInvalid)?,
        ),
        None => None,
    };
    let accepted = performance.accepted
        && calibration
            .as_ref()
            .is_none_or(|assessment| assessment.accepted);
    let body = PerformanceQualificationReceiptBodyV1 {
        version: 1,
        subject_hash: subject_hash.clone(),
        performance: performance.clone(),
        calibration: calibration.clone(),
        accepted,
        grants_authority: false,
    };
    let receipt_hash = canonical_hash_v1(&body)
        .map_err(|_| PerformanceQualificationError::EncodingInvalid)?;
    Ok(PerformanceQualificationReceiptV1 {
        version: body.version,
        subject_hash,
        performance,
        calibration,
        accepted,
        grants_authority: false,
        receipt_hash,
    })
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct PerformanceQualificationReceiptBodyV1 {
    version: u16,
    subject_hash: Sha256Digest,
    performance: PerformanceAssessmentV1,
    calibration: Option<CalibrationReportV1>,
    accepted: bool,
    grants_authority: bool,
}

/// Fail-closed qualification-process error.
#[derive(Clone, Copy, Debug, Error, Eq, PartialEq)]
pub enum PerformanceQualificationError {
    /// Request shape, version, or optional-field relationship is invalid.
    #[error("performance qualification request is invalid")]
    RequestInvalid,
    /// One or more raw measurements are invalid or insufficient.
    #[error("performance qualification measurements are invalid")]
    MeasurementInvalid,
    /// Canonical encoding failed.
    #[error("performance qualification encoding failed")]
    EncodingInvalid,
}

#[cfg(test)]
mod tests {
    use super::*;

    fn digest(byte: char) -> Sha256Digest {
        format!("sha256:{}", byte.to_string().repeat(64))
            .parse()
            .expect("digest")
    }

    fn request() -> PerformanceQualificationRequestV1 {
        PerformanceQualificationRequestV1 {
            version: 1,
            subject: PerformanceQualificationSubjectV1 {
                source_hash: digest('a'),
                binary_hash: digest('b'),
                configuration_hash: digest('c'),
                host_identity_hash: digest('d'),
                workload_hash: digest('e'),
                measurement_method_hash: digest('f'),
                threshold_version_hash: digest('1'),
                warm_cold_policy_hash: digest('2'),
            },
            performance_budget: PerformanceBudgetV1 {
                version: 1,
                workload_id: "workload.control".to_owned(),
                maximum_p95_latency_micros: 200,
                maximum_p99_latency_micros: 300,
                maximum_peak_memory_bytes: 4096,
                maximum_queue_age_micros: 500,
                maximum_failure_ppm: 100_000,
            },
            performance_samples: vec![PerformanceSampleV1 {
                workload_id: "workload.control".to_owned(),
                latency_micros: 100,
                operations: 10,
                failures: 0,
                peak_memory_bytes: 1024,
                queue_age_micros: 10,
            }],
            calibration_policy: None,
            calibration_observations: Vec::new(),
        }
    }

    #[test]
    fn receipt_binds_exact_subject_and_never_grants_authority() {
        let request = request();
        let receipt = qualify_performance_v1(&request).expect("receipt");
        assert!(receipt.accepted);
        assert!(!receipt.grants_authority);
        assert_eq!(receipt.subject_hash, request.subject.subject_hash().expect("hash"));
    }

    #[test]
    fn observations_without_calibration_policy_fail_closed() {
        let mut request = request();
        request.calibration_observations.push(CalibrationObservationV1 {
            observation_id: "obs".to_owned(),
            predicted_duration_micros: 1,
            actual_duration_micros: 1,
            predicted_cost_microusd: 1,
            actual_cost_microusd: 1,
        });
        assert_eq!(
            qualify_performance_v1(&request),
            Err(PerformanceQualificationError::RequestInvalid)
        );
    }
}
