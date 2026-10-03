//! Preregistered analysis normalization. This is contract data, not an execution
//! permission; verification and retained input ownership live in the reader.
use super::{control_check, inference, json::*, statistics};
use hepta_legacy_compatibility::ProductionJsonValue as Json;
use serde_json::Value;
use std::{collections::BTreeSet, sync::atomic::AtomicBool, time::Instant};

fn nested<'a>(value: &'a Json, name: &str, keys: &[&str], code: &str) -> Result<&'a Json, String> {
    let value = get(value, name);
    ensure(exact(value, keys), code)?;
    Ok(value)
}
fn numeric(value: &Json, fields: &[&str]) -> Result<Json, String> {
    let Json::Object(values) = value else {
        return Err("analysis_protocol_numeric_object_invalid".into());
    };
    Ok(Json::Object(
        values
            .iter()
            .map(|(key, value)| {
                let value = if fields
                    .iter()
                    .any(|name| key.iter().copied().eq(name.encode_utf16()))
                {
                    Json::Number(number(value)?)
                } else {
                    value.clone()
                };
                Ok((key.clone(), value))
            })
            .collect::<Result<Vec<_>, String>>()?,
    ))
}
fn specifications(value: &Json, metrics: &[String]) -> Result<Json, String> {
    let Json::Object(fields) = value else {
        return Err("analysis_protocol_metric_specs_invalid".into());
    };
    ensure(
        fields.len() == metrics.len() && metrics.iter().all(|metric| has(value, metric)),
        "analysis_protocol_metric_specs_invalid",
    )?;
    let mut sorted = metrics.to_vec();
    sorted.sort_by(|a, b| a.encode_utf16().cmp(b.encode_utf16()));
    Ok(fields_object(
        sorted
            .iter()
            .map(|metric| {
                let spec = get(value, metric);
                ensure(
                    exact(spec, &["unit", "direction", "minimum", "maximum"])
                        && !or_string(get(spec, "unit"))?.is_empty()
                        && ["maximize", "minimize"]
                            .iter()
                            .any(|direction| eq(get(spec, "direction"), direction))
                        && bounded(get(spec, "minimum"), -1e12, 1e12)?
                        && bounded(get(spec, "maximum"), -1e12, 1e12)?
                        && number(get(spec, "minimum"))? <= number(get(spec, "maximum"))?,
                    "analysis_protocol_metric_spec_invalid",
                )?;
                Ok((
                    metric.clone(),
                    object([
                        ("unit", text(&string(get(spec, "unit"))?)),
                        ("direction", get(spec, "direction").clone()),
                        ("minimum", Json::Number(number(get(spec, "minimum"))?)),
                        ("maximum", Json::Number(number(get(spec, "maximum"))?)),
                    ]),
                ))
            })
            .collect::<Result<Vec<_>, String>>()?,
    ))
}

// Keep normalization in incumbent insertion order; order-sensitive mount
// bindings compare its complete JSON.stringify result, not semantic Value equality.
pub(super) fn validate(
    value: &Json,
    id: &str,
    family: &str,
    registry: &Value,
    c: &AtomicBool,
    d: Instant,
) -> Result<(Json, String, bool), String> {
    control_check(c, d)?;
    let claims = literal_number(get(value, "version"), 2.0);
    let mut keys = vec![
        "version",
        "kind",
        "protocolId",
        "benchmarkId",
        "benchmarkFamily",
        "requiredMetrics",
        "metricSpecs",
        "inferenceProfile",
        "inferenceProfileHash",
        "estimator",
        "assumptions",
        "pairedUnit",
        "missingness",
        "outlierSensitivity",
        "uncertainty",
        "hypotheses",
        "multiplicity",
        "power",
        "numericValidation",
        "assuranceScope",
    ];
    if claims {
        keys.extend(["empiricalClaimUniverseHash", "manuscriptCorpusHash"]);
    }
    ensure(
        exact(value, &keys)
            && (claims || literal_number(get(value, "version"), 1.0))
            && eq(get(value, "kind"), "AcademicAnalysisProtocol"),
        "analysis_protocol_shape_invalid",
    )?;
    ensure(
        !claims
            || (sha(get(value, "empiricalClaimUniverseHash"))?
                && sha(get(value, "manuscriptCorpusHash"))?),
        "analysis_protocol_empirical_claim_authority_invalid",
    )?;
    let protocol_id = or_string(get(value, "protocolId"))?;
    ensure(
        identifier(&protocol_id, 160, b"_.:-")
            && identifier(id, 160, b"_.:-")
            && or_string(get(value, "benchmarkId"))? == id
            && or_string(get(value, "benchmarkFamily"))? == family,
        "analysis_protocol_identity_invalid",
    )?;
    let (inference, inference_hash, clustered) =
        inference::validate(get(value, "inferenceProfile"), family, registry)
            .map_err(|_| "analysis_protocol_inference_profile_invalid".to_owned())?;
    ensure(
        sha(get(value, "inferenceProfileHash"))?
            && or_string(get(value, "inferenceProfileHash"))?.to_lowercase() == inference_hash,
        "analysis_protocol_inference_profile_hash_invalid",
    )?;
    let metrics = array(get(value, "requiredMetrics"))
        .iter()
        .map(string)
        .collect::<Result<Vec<_>, String>>()?;
    ensure(
        !metrics.is_empty()
            && metrics.len() <= 32
            && metrics.iter().collect::<BTreeSet<_>>().len() == metrics.len()
            && metrics
                .iter()
                .all(|metric| identifier(metric, 160, b"_.:-")),
        "analysis_protocol_required_metrics_invalid",
    )?;
    let specs = specifications(get(value, "metricSpecs"), &metrics)?;
    let estimator = nested(
        value,
        "estimator",
        &[
            "method",
            "treatmentArm",
            "controlArms",
            "directionNormalization",
        ],
        "analysis_protocol_estimator_invalid",
    )?;
    ensure(
        eq(
            get(estimator, "method"),
            if clustered {
                "seed-cluster-aggregate-arithmetic-mean-difference-v1"
            } else {
                "paired-arithmetic-mean-difference-v1"
            },
        ) && eq(get(estimator, "treatmentArm"), "treatment")
            && same(
                get(estimator, "controlArms"),
                &Json::Array(vec![text("baseline"), text("ablation")]),
            )?
            && eq(
                get(estimator, "directionNormalization"),
                "positive-is-treatment-improvement-v1",
            ),
        "analysis_protocol_estimator_invalid",
    )?;
    let assumptions = nested(
        value,
        "assumptions",
        &[
            "distribution",
            "exchangeability",
            "independenceScope",
            "finiteObservationsRequired",
            "symmetryDiagnostic",
            "maximumAbsoluteSkewness",
        ],
        "analysis_protocol_assumptions_invalid",
    )?;
    ensure(
        eq(
            get(assumptions, "distribution"),
            if clustered {
                "seed-cluster-mean-sign-symmetry-and-bootstrap-exchangeability-v1"
            } else {
                "paired-sign-symmetry-and-bootstrap-exchangeability-v1"
            },
        ) && eq(
            get(assumptions, "exchangeability"),
            if clustered {
                "operator-predeclared-fixed-seed-cluster-schedule-v1"
            } else {
                "operator-predeclared-fixed-cell-schedule-v1"
            },
        ) && eq(
            get(assumptions, "independenceScope"),
            if clustered {
                "independent-seed-clusters-dependent-within-seed-repetitions-v1"
            } else {
                "paired-schedule-unit-only-no-independent-machine-claim-v1"
            },
        ) && boolean(get(assumptions, "finiteObservationsRequired"), true)
            && eq(
                get(assumptions, "symmetryDiagnostic"),
                "sample-skewness-bound-v1",
            )
            && bounded(get(assumptions, "maximumAbsoluteSkewness"), 0.5, 20.0)?
            && eq(
                get(value, "pairedUnit"),
                if clustered {
                    "seed-after-within-seed-repetition-aggregation-v1"
                } else {
                    "seed-and-repetition-v1"
                },
            ),
        "analysis_protocol_assumptions_invalid",
    )?;
    let missing = nested(
        value,
        "missingness",
        &["method", "maximumMissingFraction"],
        "analysis_protocol_missingness_invalid",
    )?;
    ensure(
        eq(
            get(missing, "method"),
            "fail-closed-complete-paired-cells-v1",
        ) && literal_number(get(missing, "maximumMissingFraction"), 0.0),
        "analysis_protocol_missingness_invalid",
    )?;
    let outlier = nested(
        value,
        "outlierSensitivity",
        &[
            "method",
            "lowerQuantile",
            "upperQuantile",
            "requireWinsorizedDirection",
            "requireLeaveOneOutDirection",
        ],
        "analysis_protocol_outlier_sensitivity_invalid",
    )?;
    ensure(
        eq(
            get(outlier, "method"),
            "winsorized-and-leave-one-out-sensitivity-v1",
        ) && bounded(get(outlier, "lowerQuantile"), 0.0, 0.25)?
            && bounded(get(outlier, "upperQuantile"), 0.75, 1.0)?
            && number(get(outlier, "lowerQuantile"))? < number(get(outlier, "upperQuantile"))?
            && boolean(get(outlier, "requireWinsorizedDirection"), true)
            && boolean(get(outlier, "requireLeaveOneOutDirection"), true),
        "analysis_protocol_outlier_sensitivity_invalid",
    )?;
    let uncertainty = nested(
        value,
        "uncertainty",
        &[
            "method",
            "confidenceLevel",
            "resamples",
            "seed",
            "testMethod",
            "testDraws",
        ],
        "analysis_protocol_uncertainty_invalid",
    )?;
    let resamples = number(get(uncertainty, "resamples"))?;
    let draws = number(get(uncertainty, "testDraws"))?;
    let seed = number(get(uncertainty, "seed"))?;
    ensure(
        eq(
            get(uncertainty, "method"),
            if clustered {
                "deterministic-seed-cluster-percentile-bootstrap-v1"
            } else {
                "deterministic-paired-percentile-bootstrap-v1"
            },
        ) && eq(
            get(uncertainty, "testMethod"),
            if clustered {
                "deterministic-seed-cluster-sign-flip-v1"
            } else {
                "deterministic-paired-sign-flip-v1"
            },
        ) && bounded(get(uncertainty, "confidenceLevel"), 0.8, 0.999)?
            && safe(resamples)
            && (1000.0..=100000.0).contains(&resamples)
            && safe(draws)
            && (1000.0..=100000.0).contains(&draws)
            && safe(seed),
        "analysis_protocol_uncertainty_invalid",
    )?;
    let source_hypotheses = array(get(value, "hypotheses"));
    ensure(
        !source_hypotheses.is_empty() && source_hypotheses.len() <= 32,
        "analysis_protocol_hypotheses_invalid",
    )?;
    let mut hypothesis_keys = vec![
        "hypothesisId",
        "metric",
        "comparator",
        "alternative",
        "minimumEffect",
        "acceptanceRequired",
    ];
    if claims {
        hypothesis_keys.extend(["claimId", "manuscriptClaimHash", "proposalClaimRecordHash"]);
    }
    let mut seen = BTreeSet::new();
    let mut claim_ids = BTreeSet::new();
    let mut hypotheses = Vec::new();
    for item in source_hypotheses {
        control_check(c, d)?;
        ensure(
            exact(item, &hypothesis_keys),
            "analysis_protocol_hypothesis_shape_invalid",
        )?;
        let hypothesis_id = or_string(get(item, "hypothesisId"))?;
        let metric = or_string(get(item, "metric"))?;
        let claim_id = or_string(get(item, "claimId"))?;
        let comparator = or_string(get(item, "comparator"))?;
        let alternative = or_string(get(item, "alternative"))?;
        ensure(
            identifier(&hypothesis_id, 160, b"_.:-")
                && seen.insert(hypothesis_id.clone())
                && has(&specs, &metric)
                && ["baseline", "ablation"].contains(&comparator.as_str())
                && alternative
                    == if eq(get(get(&specs, &metric), "direction"), "maximize") {
                        "greater"
                    } else {
                        "less"
                    }
                && bounded(get(item, "minimumEffect"), 0.0, 1e12)?
                && matches!(get(item, "acceptanceRequired"), Json::Bool(_))
                && (!claims
                    || (identifier(&claim_id, 160, b"_.:-")
                        && claim_ids.insert(claim_id.clone())
                        && sha(get(item, "manuscriptClaimHash"))?
                        && (matches!(get(item, "proposalClaimRecordHash"), Json::Null)
                            || sha(get(item, "proposalClaimRecordHash"))?))),
            "analysis_protocol_hypothesis_invalid",
        )?;
        let mut fields = vec![("hypothesisId".into(), text(&hypothesis_id))];
        if claims {
            fields.extend([
                ("claimId".into(), text(&claim_id)),
                (
                    "manuscriptClaimHash".into(),
                    text(&or_string(get(item, "manuscriptClaimHash"))?.to_lowercase()),
                ),
                (
                    "proposalClaimRecordHash".into(),
                    if matches!(get(item, "proposalClaimRecordHash"), Json::Null) {
                        Json::Null
                    } else {
                        text(&or_string(get(item, "proposalClaimRecordHash"))?.to_lowercase())
                    },
                ),
            ]);
        }
        fields.extend([
            ("metric".into(), text(&metric)),
            ("comparator".into(), text(&comparator)),
            ("alternative".into(), text(&alternative)),
            (
                "minimumEffect".into(),
                Json::Number(number(get(item, "minimumEffect"))?),
            ),
            (
                "acceptanceRequired".into(),
                get(item, "acceptanceRequired").clone(),
            ),
        ]);
        hypotheses.push(fields_object(fields));
    }
    ensure(
        hypotheses
            .iter()
            .any(|item| boolean(get(item, "acceptanceRequired"), true)),
        "analysis_protocol_confirmatory_hypothesis_required",
    )?;
    let multiplicity = nested(
        value,
        "multiplicity",
        &["method", "familyAlpha", "family"],
        "analysis_protocol_multiplicity_invalid",
    )?;
    ensure(
        eq(get(multiplicity, "method"), "holm-bonferroni-v1")
            && bounded(get(multiplicity, "familyAlpha"), 0.0001, 0.2)?
            && eq(get(multiplicity, "family"), "all-predeclared-hypotheses-v1"),
        "analysis_protocol_multiplicity_invalid",
    )?;
    let power = nested(
        value,
        "power",
        &[
            "method",
            "targetPower",
            "minimumStandardizedEffect",
            "requiredPairedObservations",
        ],
        "analysis_protocol_power_invalid",
    )?;
    let count = number(get(power, "requiredPairedObservations"))?;
    ensure(
        eq(
            get(power, "method"),
            "predeclared-standardized-effect-normal-design-v1",
        ) && bounded(get(power, "targetPower"), 0.5, 0.999)?
            && bounded(get(power, "minimumStandardizedEffect"), 0.05, 10.0)?
            && safe(count)
            && (2.0..=100000.0).contains(&count),
        "analysis_protocol_power_invalid",
    )?;
    ensure(
        statistics::required_observations(
            number(get(multiplicity, "familyAlpha"))?,
            number(get(power, "targetPower"))?,
            number(get(power, "minimumStandardizedEffect"))?,
            hypotheses.len(),
        )
        .is_some_and(|required| required as f64 == count),
        "analysis_protocol_power_design_mismatch",
    )?;
    let validation = nested(
        value,
        "numericValidation",
        &[
            "residual",
            "convergence",
            "condition",
            "tolerances",
            "propertyOracle",
            "agentAggregatesAccepted",
        ],
        "analysis_protocol_numeric_validation_invalid",
    )?;
    let residual = nested(
        validation,
        "residual",
        &["method", "maximumAbsoluteResidual"],
        "analysis_protocol_numeric_validation_invalid",
    )?;
    let convergence = nested(
        validation,
        "convergence",
        &["method", "candidateClaimAccepted"],
        "analysis_protocol_numeric_validation_invalid",
    )?;
    let condition = nested(
        validation,
        "condition",
        &["method", "candidateClaimAccepted"],
        "analysis_protocol_numeric_validation_invalid",
    )?;
    let tolerances = nested(
        validation,
        "tolerances",
        &["absolute", "relative"],
        "analysis_protocol_numeric_validation_invalid",
    )?;
    let property = nested(
        validation,
        "propertyOracle",
        &["method", "required"],
        "analysis_protocol_numeric_validation_invalid",
    )?;
    ensure(
        eq(
            get(residual, "method"),
            "authority-recomputed-aggregate-residual-v1",
        ) && bounded(get(residual, "maximumAbsoluteResidual"), 0.0, 1.0)?
            && eq(
                get(convergence, "method"),
                "not-observable-no-candidate-convergence-claim-v1",
            )
            && boolean(get(convergence, "candidateClaimAccepted"), false)
            && eq(
                get(condition, "method"),
                "not-observable-no-candidate-condition-claim-v1",
            )
            && boolean(get(condition, "candidateClaimAccepted"), false)
            && bounded(get(tolerances, "absolute"), 0.0, 1.0)?
            && bounded(get(tolerances, "relative"), 0.0, 1.0)?
            && eq(
                get(property, "method"),
                "repository-hidden-oracle-event-recomputation-v1",
            )
            && boolean(get(property, "required"), true)
            && boolean(get(validation, "agentAggregatesAccepted"), false),
        "analysis_protocol_numeric_validation_invalid",
    )?;
    ensure(
        eq(
            get(value, "assuranceScope"),
            "operator-signed-preregistered-analysis-protocol-v1",
        ),
        "analysis_protocol_assurance_scope_invalid",
    )?;
    let mut fields = vec![
        ("version".into(), get(value, "version").clone()),
        ("kind".into(), text("AcademicAnalysisProtocol")),
        ("protocolId".into(), text(&protocol_id)),
        ("benchmarkId".into(), text(id)),
        ("benchmarkFamily".into(), text(family)),
    ];
    if claims {
        fields.extend([
            (
                "empiricalClaimUniverseHash".into(),
                text(&or_string(get(value, "empiricalClaimUniverseHash"))?.to_lowercase()),
            ),
            (
                "manuscriptCorpusHash".into(),
                text(&or_string(get(value, "manuscriptCorpusHash"))?.to_lowercase()),
            ),
        ]);
    }
    fields.extend([
        (
            "requiredMetrics".into(),
            Json::Array(metrics.iter().map(|metric| text(metric)).collect()),
        ),
        ("metricSpecs".into(), specs),
        ("inferenceProfile".into(), inference),
        ("inferenceProfileHash".into(), text(&inference_hash)),
        (
            "estimator".into(),
            object([
                ("method", get(estimator, "method").clone()),
                ("treatmentArm", get(estimator, "treatmentArm").clone()),
                ("controlArms", get(estimator, "controlArms").clone()),
                (
                    "directionNormalization",
                    get(estimator, "directionNormalization").clone(),
                ),
            ]),
        ),
        (
            "assumptions".into(),
            numeric(assumptions, &["maximumAbsoluteSkewness"])?,
        ),
        ("pairedUnit".into(), get(value, "pairedUnit").clone()),
        (
            "missingness".into(),
            object([
                ("method", get(missing, "method").clone()),
                ("maximumMissingFraction", Json::Number(0.0)),
            ]),
        ),
        (
            "outlierSensitivity".into(),
            object([
                ("method", get(outlier, "method").clone()),
                (
                    "lowerQuantile",
                    Json::Number(number(get(outlier, "lowerQuantile"))?),
                ),
                (
                    "upperQuantile",
                    Json::Number(number(get(outlier, "upperQuantile"))?),
                ),
                ("requireWinsorizedDirection", Json::Bool(true)),
                ("requireLeaveOneOutDirection", Json::Bool(true)),
            ]),
        ),
        (
            "uncertainty".into(),
            object([
                ("method", get(uncertainty, "method").clone()),
                (
                    "confidenceLevel",
                    Json::Number(number(get(uncertainty, "confidenceLevel"))?),
                ),
                ("resamples", Json::Number(resamples)),
                ("seed", Json::Number(seed)),
                ("testMethod", get(uncertainty, "testMethod").clone()),
                ("testDraws", Json::Number(draws)),
            ]),
        ),
        ("hypotheses".into(), Json::Array(hypotheses)),
        (
            "multiplicity".into(),
            object([
                ("method", get(multiplicity, "method").clone()),
                (
                    "familyAlpha",
                    Json::Number(number(get(multiplicity, "familyAlpha"))?),
                ),
                ("family", get(multiplicity, "family").clone()),
            ]),
        ),
        (
            "power".into(),
            object([
                ("method", get(power, "method").clone()),
                (
                    "targetPower",
                    Json::Number(number(get(power, "targetPower"))?),
                ),
                (
                    "minimumStandardizedEffect",
                    Json::Number(number(get(power, "minimumStandardizedEffect"))?),
                ),
                ("requiredPairedObservations", Json::Number(count)),
            ]),
        ),
        (
            "numericValidation".into(),
            object([
                (
                    "residual",
                    object([
                        ("method", get(residual, "method").clone()),
                        (
                            "maximumAbsoluteResidual",
                            Json::Number(number(get(residual, "maximumAbsoluteResidual"))?),
                        ),
                    ]),
                ),
                ("convergence", convergence.clone()),
                ("condition", condition.clone()),
                (
                    "tolerances",
                    object([
                        (
                            "absolute",
                            Json::Number(number(get(tolerances, "absolute"))?),
                        ),
                        (
                            "relative",
                            Json::Number(number(get(tolerances, "relative"))?),
                        ),
                    ]),
                ),
                ("propertyOracle", property.clone()),
                ("agentAggregatesAccepted", Json::Bool(false)),
            ]),
        ),
        (
            "assuranceScope".into(),
            get(value, "assuranceScope").clone(),
        ),
    ]);
    control_check(c, d)?;
    let result = fields_object(fields);
    let digest = hash("AcademicAnalysisProtocol", &result)?;
    control_check(c, d)?;
    Ok((result, digest, clustered))
}
