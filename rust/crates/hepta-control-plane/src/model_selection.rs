use hepta_codex_protocol::Sha256Digest;
use serde::{Deserialize, Serialize};
use thiserror::Error;

use crate::{CalibrationReportV1, canonical_hash_v1};

const PPM: u64 = 1_000_000;

/// Hard gates for champion/challenger predictor promotion.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PredictorPromotionPolicyV1 {
    /// Contract version, exactly one.
    pub version: u16,
    /// Minimum relative p95 error improvement required when the champion remains safe.
    pub minimum_improvement_ppm: u32,
    /// Maximum of duration/cost p95 relative error accepted for either predictor.
    pub maximum_p95_relative_error_ppm: u64,
    /// Maximum of duration/cost underestimate rates.
    pub maximum_underestimate_rate_ppm: u32,
    /// Minimum observed confidence across the calibration window.
    pub minimum_confidence_ppm: u32,
}

impl PredictorPromotionPolicyV1 {
    fn validate(&self) -> Result<(), PredictorSelectionError> {
        if self.version != 1
            || self.minimum_improvement_ppm > PPM as u32
            || self.maximum_p95_relative_error_ppm == 0
            || self.maximum_underestimate_rate_ppm > PPM as u32
            || self.minimum_confidence_ppm > PPM as u32
        {
            return Err(PredictorSelectionError::PolicyInvalid);
        }
        Ok(())
    }
}

/// Closed explanation for one deterministic promotion decision.
#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum PredictorSelectionReasonV1 {
    /// Challenger satisfies every safety gate and improves enough to replace a safe champion.
    ChallengerPromoted,
    /// Champion is no longer safe/current enough for promotion comparison and a safe challenger replaces it.
    UnsafeChampionReplaced,
    /// Challenger violates at least one hard calibration/safety threshold.
    ChallengerSafetyRejected,
    /// Both predictor reports violate the promotion safety envelope.
    BothUnsafe,
    /// Both are safe but the challenger improvement is below the minimum promotion margin.
    ImprovementInsufficient,
}

/// Canonical champion/challenger decision. This selects a source predictor identity;
/// it does not activate a deployment or alter external authority.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PredictorSelectionDecisionV1 {
    pub version: u16,
    pub workload_id: String,
    pub champion_predictor_version: String,
    pub challenger_predictor_version: String,
    pub champion_report_hash: Sha256Digest,
    pub challenger_report_hash: Sha256Digest,
    pub champion_safe: bool,
    pub challenger_safe: bool,
    pub champion_p95_error_ppm: u64,
    pub challenger_p95_error_ppm: u64,
    pub challenger_improvement_ppm: u32,
    pub selected_predictor_version: String,
    pub promoted: bool,
    pub reason: PredictorSelectionReasonV1,
    pub decided_at_unix_ms: u64,
    pub decision_hash: Sha256Digest,
}

/// Selects a champion or challenger using only exact current calibration reports.
///
/// Reports must describe the same workload, distinct predictor versions, and be
/// current at `now_unix_ms`. A challenger can never be promoted through a weighted
/// score that hides p95 error, underestimate rate, confidence, calibration failure,
/// or expiry: every safety condition is an independent hard gate.
pub fn select_predictor_v1(
    champion: &CalibrationReportV1,
    challenger: &CalibrationReportV1,
    policy: &PredictorPromotionPolicyV1,
    now_unix_ms: u64,
) -> Result<PredictorSelectionDecisionV1, PredictorSelectionError> {
    policy.validate()?;
    validate_report(champion, now_unix_ms)?;
    validate_report(challenger, now_unix_ms)?;
    if champion.workload_id != challenger.workload_id
        || champion.predictor_version == challenger.predictor_version
    {
        return Err(PredictorSelectionError::ReportsIncomparable);
    }

    let champion_p95_error_ppm = report_p95_error(champion);
    let challenger_p95_error_ppm = report_p95_error(challenger);
    let champion_safe = report_safe(champion, policy);
    let challenger_safe = report_safe(challenger, policy);
    let challenger_improvement_ppm =
        improvement_ppm(champion_p95_error_ppm, challenger_p95_error_ppm)?;

    let (promoted, reason) = match (champion_safe, challenger_safe) {
        (false, true) => (true, PredictorSelectionReasonV1::UnsafeChampionReplaced),
        (false, false) => (false, PredictorSelectionReasonV1::BothUnsafe),
        (true, false) => (false, PredictorSelectionReasonV1::ChallengerSafetyRejected),
        (true, true)
            if challenger_improvement_ppm >= policy.minimum_improvement_ppm
                && challenger_p95_error_ppm < champion_p95_error_ppm =>
        {
            (true, PredictorSelectionReasonV1::ChallengerPromoted)
        }
        (true, true) => (false, PredictorSelectionReasonV1::ImprovementInsufficient),
    };
    let selected_predictor_version = if promoted {
        challenger.predictor_version.clone()
    } else {
        champion.predictor_version.clone()
    };
    let body = PredictorDecisionBodyV1 {
        version: 1,
        workload_id: champion.workload_id.clone(),
        champion_predictor_version: champion.predictor_version.clone(),
        challenger_predictor_version: challenger.predictor_version.clone(),
        champion_report_hash: champion.report_hash.clone(),
        challenger_report_hash: challenger.report_hash.clone(),
        champion_safe,
        challenger_safe,
        champion_p95_error_ppm,
        challenger_p95_error_ppm,
        challenger_improvement_ppm,
        selected_predictor_version: selected_predictor_version.clone(),
        promoted,
        reason,
        decided_at_unix_ms: now_unix_ms,
    };
    let decision_hash = canonical_hash_v1(&body).map_err(|_| PredictorSelectionError::Encoding)?;
    Ok(PredictorSelectionDecisionV1 {
        version: body.version,
        workload_id: body.workload_id,
        champion_predictor_version: body.champion_predictor_version,
        challenger_predictor_version: body.challenger_predictor_version,
        champion_report_hash: body.champion_report_hash,
        challenger_report_hash: body.challenger_report_hash,
        champion_safe: body.champion_safe,
        challenger_safe: body.challenger_safe,
        champion_p95_error_ppm: body.champion_p95_error_ppm,
        challenger_p95_error_ppm: body.challenger_p95_error_ppm,
        challenger_improvement_ppm: body.challenger_improvement_ppm,
        selected_predictor_version: body.selected_predictor_version,
        promoted: body.promoted,
        reason: body.reason,
        decided_at_unix_ms: body.decided_at_unix_ms,
        decision_hash,
    })
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct PredictorDecisionBodyV1 {
    version: u16,
    workload_id: String,
    champion_predictor_version: String,
    challenger_predictor_version: String,
    champion_report_hash: Sha256Digest,
    challenger_report_hash: Sha256Digest,
    champion_safe: bool,
    challenger_safe: bool,
    champion_p95_error_ppm: u64,
    challenger_p95_error_ppm: u64,
    challenger_improvement_ppm: u32,
    selected_predictor_version: String,
    promoted: bool,
    reason: PredictorSelectionReasonV1,
    decided_at_unix_ms: u64,
}

fn validate_report(
    report: &CalibrationReportV1,
    now_unix_ms: u64,
) -> Result<(), PredictorSelectionError> {
    if report.version != 1
        || now_unix_ms == 0
        || report.generated_at_unix_ms == 0
        || report.generated_at_unix_ms > now_unix_ms
        || report.expires_at_unix_ms <= now_unix_ms
        || report.expires_at_unix_ms <= report.generated_at_unix_ms
        || report.sample_count == 0
        || !valid_identifier(&report.workload_id)
        || !valid_identifier(&report.predictor_version)
        || report.duration_underestimate_rate_ppm > PPM as u32
        || report.cost_underestimate_rate_ppm > PPM as u32
        || report.minimum_confidence_ppm > PPM as u32
    {
        return Err(PredictorSelectionError::ReportInvalid);
    }
    Ok(())
}

fn report_safe(report: &CalibrationReportV1, policy: &PredictorPromotionPolicyV1) -> bool {
    report.calibrated
        && report_p95_error(report) <= policy.maximum_p95_relative_error_ppm
        && report
            .duration_underestimate_rate_ppm
            .max(report.cost_underestimate_rate_ppm)
            <= policy.maximum_underestimate_rate_ppm
        && report.minimum_confidence_ppm >= policy.minimum_confidence_ppm
}

fn report_p95_error(report: &CalibrationReportV1) -> u64 {
    report
        .duration_p95_relative_error_ppm
        .max(report.cost_p95_relative_error_ppm)
}

fn improvement_ppm(
    champion_error: u64,
    challenger_error: u64,
) -> Result<u32, PredictorSelectionError> {
    if challenger_error >= champion_error {
        return Ok(0);
    }
    if champion_error == 0 {
        return Ok(0);
    }
    let scaled = u128::from(champion_error - challenger_error)
        .checked_mul(u128::from(PPM))
        .ok_or(PredictorSelectionError::NumericOverflow)?
        / u128::from(champion_error);
    u32::try_from(scaled.min(u128::from(PPM))).map_err(|_| PredictorSelectionError::NumericOverflow)
}

fn valid_identifier(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 128
        && value.bytes().all(|byte| {
            byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.' | b':' | b'/')
        })
}

/// Promotion policy, calibration subject, arithmetic, or encoding failure.
#[derive(Clone, Copy, Debug, Error, Eq, PartialEq)]
pub enum PredictorSelectionError {
    #[error("predictor promotion policy is invalid")]
    PolicyInvalid,
    #[error("predictor calibration report is invalid or expired")]
    ReportInvalid,
    #[error("predictor reports are not comparable")]
    ReportsIncomparable,
    #[error("predictor promotion arithmetic overflow")]
    NumericOverflow,
    #[error("predictor promotion decision encoding failed")]
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

    fn report(
        version: &str,
        error: u64,
        underestimate: u32,
        confidence: u32,
    ) -> CalibrationReportV1 {
        CalibrationReportV1 {
            version: 1,
            workload_id: "workload:author".into(),
            predictor_version: version.into(),
            sample_count: 100,
            duration_p50_relative_error_ppm: error / 2,
            duration_p95_relative_error_ppm: error,
            cost_p50_relative_error_ppm: error / 2,
            cost_p95_relative_error_ppm: error,
            duration_underestimate_rate_ppm: underestimate,
            cost_underestimate_rate_ppm: underestimate,
            minimum_confidence_ppm: confidence,
            recommended_uncertainty_ppm: u32::try_from(error.min(PPM)).expect("bounded"),
            calibrated: true,
            generated_at_unix_ms: 9_000,
            expires_at_unix_ms: 11_000,
            report_hash: digest(version.chars().last().unwrap_or('a')),
        }
    }

    fn policy() -> PredictorPromotionPolicyV1 {
        PredictorPromotionPolicyV1 {
            version: 1,
            minimum_improvement_ppm: 100_000,
            maximum_p95_relative_error_ppm: 200_000,
            maximum_underestimate_rate_ppm: 100_000,
            minimum_confidence_ppm: 800_000,
        }
    }

    #[test]
    fn sufficiently_better_safe_challenger_is_promoted() {
        let decision = select_predictor_v1(
            &report("predictor:v1", 100_000, 50_000, 900_000),
            &report("predictor:v2", 80_000, 50_000, 900_000),
            &policy(),
            10_000,
        )
        .expect("selection");
        assert!(decision.promoted);
        assert_eq!(decision.challenger_improvement_ppm, 200_000);
        assert_eq!(
            decision.reason,
            PredictorSelectionReasonV1::ChallengerPromoted
        );
        assert_eq!(decision.selected_predictor_version, "predictor:v2");
    }

    #[test]
    fn unsafe_challenger_cannot_win_on_lower_p95_error() {
        let decision = select_predictor_v1(
            &report("predictor:v1", 100_000, 50_000, 900_000),
            &report("predictor:v2", 50_000, 200_000, 900_000),
            &policy(),
            10_000,
        )
        .expect("selection");
        assert!(!decision.promoted);
        assert_eq!(
            decision.reason,
            PredictorSelectionReasonV1::ChallengerSafetyRejected
        );
    }

    #[test]
    fn safe_challenger_replaces_unsafe_champion_without_hiding_the_reason() {
        let decision = select_predictor_v1(
            &report("predictor:v1", 300_000, 50_000, 900_000),
            &report("predictor:v2", 150_000, 50_000, 900_000),
            &policy(),
            10_000,
        )
        .expect("selection");
        assert!(decision.promoted);
        assert!(!decision.champion_safe);
        assert_eq!(
            decision.reason,
            PredictorSelectionReasonV1::UnsafeChampionReplaced
        );
    }

    #[test]
    fn expired_or_cross_workload_reports_fail_closed() {
        let champion = report("predictor:v1", 100_000, 50_000, 900_000);
        let mut challenger = report("predictor:v2", 80_000, 50_000, 900_000);
        challenger.workload_id = "workload:review".into();
        assert_eq!(
            select_predictor_v1(&champion, &challenger, &policy(), 10_000),
            Err(PredictorSelectionError::ReportsIncomparable)
        );
        assert_eq!(
            select_predictor_v1(
                &champion,
                &report("predictor:v2", 80_000, 50_000, 900_000),
                &policy(),
                12_000
            ),
            Err(PredictorSelectionError::ReportInvalid)
        );
    }
}
