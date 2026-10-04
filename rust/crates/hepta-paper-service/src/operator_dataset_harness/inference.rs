//! The original inference policy is selected from a verified plugin registry.
use super::json::*;
use hepta_legacy_compatibility::ProductionJsonValue as Json;
use serde_json::Value;

pub(super) fn profile(family: &str, registry: &Value) -> Result<(Json, String, bool), String> {
    let selected = registry["profiles"]
        .as_array()
        .and_then(|profiles| {
            profiles
                .iter()
                .find(|profile| profile["benchmarkFamily"].as_str() == Some(family))
        })
        .ok_or("academic_analysis_inference_profile_family_unsupported")?;
    let clustered = selected["inferenceMode"] == "seed-cluster";
    ensure(
        clustered || selected["inferenceMode"] == "seed-repetition-cell",
        "academic_analysis_inference_profile_family_unsupported",
    )?;
    let mode = if clustered {
        "seed-cluster"
    } else {
        "seed-repetition-cell"
    };
    let difference = if clustered {
        "seed-cluster-mean-difference-v1"
    } else {
        "seed-repetition-cell-difference-v1"
    };
    let value = object([
        ("version", Json::Number(1.0)),
        ("kind", text("AcademicAnalysisInferenceProfile")),
        ("profileId", text(&format!("{family}:{mode}:v1"))),
        ("benchmarkFamily", text(family)),
        (
            "independentUnit",
            text(if clustered {
                "seed-cluster-v1"
            } else {
                "seed-repetition-cell-v1"
            }),
        ),
        (
            "withinSeedAggregation",
            text(if clustered {
                "arithmetic-mean-per-arm-metric-before-inference-v1"
            } else {
                "none-each-complete-seed-repetition-cell-v1"
            }),
        ),
        ("bootstrapUnit", text(difference)),
        ("signFlipUnit", text(difference)),
        (
            "powerCountingUnit",
            text(if clustered {
                "independent-seed-cluster-v1"
            } else {
                "independent-seed-repetition-cell-v1"
            }),
        ),
        (
            "balanceRequirements",
            object([
                (
                    "completeArms",
                    text("treatment-baseline-ablation-per-seed-repetition-v1"),
                ),
                (
                    "repetitionSchedule",
                    text("identical-repetition-index-set-across-seeds-v1"),
                ),
                (
                    "clusterSize",
                    text("equal-complete-repetition-count-per-seed-v1"),
                ),
                ("failureMode", text("fail-closed-v1")),
            ]),
        ),
        (
            "assumptions",
            object([
                (
                    "independentAcross",
                    text(if clustered {
                        "predeclared-seed-clusters-v1"
                    } else {
                        "predeclared-seed-repetition-cells-v1"
                    }),
                ),
                (
                    "dependenceWithinSeed",
                    text(if clustered {
                        "repetitions-may-be-dependent-and-are-not-independent-samples-v1"
                    } else {
                        "no-additional-within-seed-cluster-independence-claim-v1"
                    }),
                ),
                (
                    "resamplingExchangeability",
                    text(if clustered {
                        "exchangeable-seed-cluster-aggregates-v1"
                    } else {
                        "exchangeable-complete-seed-repetition-cells-v1"
                    }),
                ),
                (
                    "signSymmetry",
                    text(if clustered {
                        "seed-cluster-aggregate-differences-v1"
                    } else {
                        "seed-repetition-cell-differences-v1"
                    }),
                ),
            ]),
        ),
    ]);
    let digest = hash("AcademicAnalysisInferenceProfile", &value)?;
    Ok((value, digest, clustered))
}
pub(super) fn validate(
    value: &Json,
    family: &str,
    registry: &Value,
) -> Result<(Json, String, bool), String> {
    ensure(
        exact(
            value,
            &[
                "version",
                "kind",
                "profileId",
                "benchmarkFamily",
                "independentUnit",
                "withinSeedAggregation",
                "bootstrapUnit",
                "signFlipUnit",
                "powerCountingUnit",
                "balanceRequirements",
                "assumptions",
            ],
        ) && literal_number(get(value, "version"), 1.0)
            && eq(get(value, "kind"), "AcademicAnalysisInferenceProfile"),
        "academic_analysis_inference_profile_shape_invalid",
    )?;
    ensure(
        or_string(get(value, "benchmarkFamily"))? == family,
        "academic_analysis_inference_profile_family_mismatch",
    )?;
    let expected = profile(family, registry)?;
    ensure(
        hash("AcademicAnalysisInferenceProfileExpected", value)?
            == hash("AcademicAnalysisInferenceProfileExpected", &expected.0)?,
        "academic_analysis_inference_profile_policy_tampered",
    )?;
    Ok(expected)
}
