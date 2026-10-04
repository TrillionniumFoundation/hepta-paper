//! Complete normalized dataset-envelope bindings. Normalized contract data
//! alone cannot authorize a worker, a provider, publication, or submission.
use super::{analysis, control_check, inference, json::*};
use hepta_legacy_compatibility::ProductionJsonValue as Json;
use serde_json::Value;
use std::{collections::BTreeSet, sync::atomic::AtomicBool, time::Instant};

pub(super) const LOCAL_SCOPE: &str = "local-operator-golden-runtime-only-v1";
pub(super) const LOCAL_EVIDENCE: &str = "local_operator_dataset_authority";
pub(super) const LOCAL_ROLE: &str = "local_golden_dataset_operator";
pub(super) const LOCAL_PURPOSE: &str = "local-golden-dataset-authority-v1";
pub(super) struct DatasetContract {
    pub authority: Json,
    pub authority_hash: String,
    pub splits: Json,
    pub split_hash: String,
    pub definition: Json,
    pub definition_hash: String,
    pub analysis: Json,
    pub analysis_hash: Option<String>,
    pub local: bool,
    pub legacy: bool,
}
fn family<'a>(family: &str, registry: &'a Value) -> Result<&'a Value, String> {
    registry["profiles"]
        .as_array()
        .and_then(|profiles| {
            profiles
                .iter()
                .find(|profile| profile["benchmarkFamily"].as_str() == Some(family))
        })
        .ok_or_else(|| "operator_dataset_harness_identity_invalid".into())
}
fn semantics(value: &Json) -> Result<Json, String> {
    ensure(
        exact(
            value,
            &[
                "version",
                "kind",
                "population",
                "variables",
                "intervention",
                "comparator",
                "estimands",
                "datasetConstraints",
                "eligibleSplits",
            ],
        ) && literal_number(get(value, "version"), 1.0)
            && eq(get(value, "kind"), "OperatorDatasetResearchSemantics"),
        "operator_dataset_research_semantics_shape_invalid",
    )?;
    let variables = semantic_list(get(value, "variables"), 128)?
        .ok_or("operator_dataset_research_semantics_invalid")?;
    let estimands = semantic_list(get(value, "estimands"), 128)?
        .ok_or("operator_dataset_research_semantics_invalid")?;
    let constraints = semantic_list(get(value, "datasetConstraints"), 128)?
        .ok_or("operator_dataset_research_semantics_invalid")?;
    let splits = semantic_list(get(value, "eligibleSplits"), 4)?
        .ok_or("operator_dataset_research_semantics_invalid")?;
    ensure(
        array(&splits).iter().all(|split| {
            ["train", "validation", "public"]
                .iter()
                .any(|name| eq(split, name))
        }),
        "operator_dataset_research_semantics_invalid",
    )?;
    Ok(object([
        ("version", Json::Number(1.0)),
        ("kind", text("OperatorDatasetResearchSemantics")),
        (
            "population",
            semantic_text(get(value, "population"))?
                .ok_or("operator_dataset_research_semantics_invalid")?,
        ),
        ("variables", variables),
        (
            "intervention",
            semantic_text(get(value, "intervention"))?
                .ok_or("operator_dataset_research_semantics_invalid")?,
        ),
        (
            "comparator",
            semantic_text(get(value, "comparator"))?
                .ok_or("operator_dataset_research_semantics_invalid")?,
        ),
        ("estimands", estimands),
        ("datasetConstraints", constraints),
        ("eligibleSplits", splits),
    ]))
}
fn runtime_scope(value: &Json) -> Result<Json, String> {
    ensure(
        exact(
            value,
            &["version", "kind", "isolationId", "runtimeRootHash"],
        ) && literal_number(get(value, "version"), 1.0)
            && eq(get(value, "kind"), "LocalGoldenDatasetRuntimeScope")
            && identifier(&or_string(get(value, "isolationId"))?, 128, b"_.-")
            && sha(get(value, "runtimeRootHash"))?,
        "local_golden_dataset_runtime_scope_invalid",
    )?;
    Ok(object([
        ("version", Json::Number(1.0)),
        ("kind", text("LocalGoldenDatasetRuntimeScope")),
        ("isolationId", text(&string(get(value, "isolationId"))?)),
        (
            "runtimeRootHash",
            text(&string(get(value, "runtimeRootHash"))?.to_lowercase()),
        ),
    ]))
}
fn authority(
    value: &Json,
    dataset_name: &str,
    manifest: &str,
    registry: &Value,
) -> Result<(Json, String, bool, bool), String> {
    let legacy = literal_number(get(value, "version"), 1.0);
    let local = literal_number(get(value, "version"), 4.0);
    let research = local || literal_number(get(value, "version"), 3.0);
    let mut keys = vec![
        "version",
        "kind",
        "datasetName",
        "datasetManifestHash",
        "datasetLicenseId",
        "datasetSplitManifestHash",
        "benchmarkHarnessDefinitionHash",
        "benchmarkFamily",
        "seedSchedule",
        "minimumRepetitions",
        "workerExposurePolicy",
        "signedAt",
        "expiresAt",
        "signatures",
    ];
    if !legacy {
        keys.push("analysisProtocolHash");
    }
    if research {
        keys.push("researchSemantics");
    }
    if local {
        keys.extend([
            "authorityScope",
            "evidenceClass",
            "academicPromotionEligible",
            "externalTrustClaimed",
            "authorityKeyPurpose",
            "localGoldenRuntimeScope",
        ]);
    }
    let kind = if local {
        "LocalGoldenDatasetHarnessAuthority"
    } else {
        "OperatorDatasetHarnessAuthority"
    };
    ensure(
        exact(value, &keys)
            && [1.0, 2.0, 3.0, 4.0]
                .iter()
                .any(|version| literal_number(get(value, "version"), *version))
            && eq(get(value, "kind"), kind),
        "operator_dataset_authority_document_shape_invalid",
    )?;
    let name = or_string(get(value, "datasetName"))?;
    let manifest_hash = or_string(get(value, "datasetManifestHash"))?.to_lowercase();
    let benchmark_family = or_string(get(value, "benchmarkFamily"))?;
    let research = if research {
        Some(
            semantics(get(value, "researchSemantics"))
                .map_err(|_| "operator_dataset_research_semantics_invalid".to_owned())?,
        )
    } else {
        None
    };
    let scope = if local {
        Some(runtime_scope(get(value, "localGoldenRuntimeScope"))?)
    } else {
        None
    };
    let seeds = array(get(value, "seedSchedule"))
        .iter()
        .map(number)
        .collect::<Result<Vec<_>, String>>()?;
    let repetitions = number(get(value, "minimumRepetitions"))?;
    ensure(
        identifier(&name, 128, b"_.-")
            && (dataset_name.is_empty() || name == dataset_name)
            && sha(&text(&manifest_hash))?
            && (manifest.is_empty() || manifest_hash == manifest.to_lowercase())
            && !or_string(get(value, "datasetLicenseId"))?.is_empty()
            && sha(get(value, "datasetSplitManifestHash"))?
            && sha(get(value, "benchmarkHarnessDefinitionHash"))?
            && family(&benchmark_family, registry).is_ok()
            && (legacy || sha(get(value, "analysisProtocolHash"))?)
            && !seeds.is_empty()
            && seeds.iter().copied().all(safe)
            && safe(repetitions)
            && repetitions >= 1.0
            && eq(
                get(value, "workerExposurePolicy"),
                "signed-complete-dataset-file-manifest-v1",
            )
            && (!local
                || (eq(get(value, "authorityScope"), LOCAL_SCOPE)
                    && eq(get(value, "evidenceClass"), LOCAL_EVIDENCE)
                    && boolean(get(value, "academicPromotionEligible"), false)
                    && boolean(get(value, "externalTrustClaimed"), false)
                    && eq(get(value, "authorityKeyPurpose"), LOCAL_PURPOSE)))
            && is_array(get(value, "signatures"))
            && !array(get(value, "signatures")).is_empty(),
        "operator_dataset_authority_document_invalid",
    )?;
    // Date parsing here normalizes signed document data. Authorization always
    // compares its resulting absolute instants with the reader's actual clock.
    let signed =
        crate::store_status::passive_node_date_parse_iso_v1(&or_string(get(value, "signedAt"))?)
            .ok_or("operator_dataset_authority_document_invalid")?;
    let expires =
        crate::store_status::passive_node_date_parse_iso_v1(&or_string(get(value, "expiresAt"))?)
            .ok_or("operator_dataset_authority_document_invalid")?;
    ensure(
        matches!(get(value, "signedAt"), Json::String(_))
            && matches!(get(value, "expiresAt"), Json::String(_)),
        "operator_dataset_authority_date_value_domain_refused",
    )?;
    let mut fields = vec![
        ("version".into(), get(value, "version").clone()),
        ("kind".into(), text(kind)),
        ("datasetName".into(), text(&name)),
        ("datasetManifestHash".into(), text(&manifest_hash)),
        (
            "datasetLicenseId".into(),
            text(&string(get(value, "datasetLicenseId"))?),
        ),
        (
            "datasetSplitManifestHash".into(),
            text(&string(get(value, "datasetSplitManifestHash"))?.to_lowercase()),
        ),
        (
            "benchmarkHarnessDefinitionHash".into(),
            text(&string(get(value, "benchmarkHarnessDefinitionHash"))?.to_lowercase()),
        ),
    ];
    if !legacy {
        fields.push((
            "analysisProtocolHash".into(),
            text(&string(get(value, "analysisProtocolHash"))?.to_lowercase()),
        ));
    }
    if let Some(research) = research {
        fields.push(("researchSemantics".into(), research));
    }
    if let Some(scope) = scope {
        fields.extend([
            ("authorityScope".into(), text(LOCAL_SCOPE)),
            ("evidenceClass".into(), text(LOCAL_EVIDENCE)),
            ("academicPromotionEligible".into(), Json::Bool(false)),
            ("externalTrustClaimed".into(), Json::Bool(false)),
            ("authorityKeyPurpose".into(), text(LOCAL_PURPOSE)),
            ("localGoldenRuntimeScope".into(), scope),
        ]);
    }
    fields.extend([
        ("benchmarkFamily".into(), text(&benchmark_family)),
        (
            "seedSchedule".into(),
            Json::Array(seeds.into_iter().map(Json::Number).collect()),
        ),
        ("minimumRepetitions".into(), Json::Number(repetitions)),
        (
            "workerExposurePolicy".into(),
            get(value, "workerExposurePolicy").clone(),
        ),
        ("signedAt".into(), text(&signed)),
        ("expiresAt".into(), text(&expires)),
        (
            "signatures".into(),
            Json::Array(
                array(get(value, "signatures"))
                    .iter()
                    .map(|signature| {
                        Ok(object([
                            ("keyId", text(&or_string(get(signature, "keyId"))?)),
                            ("role", text(&or_string(get(signature, "role"))?)),
                            ("algorithm", text(&or_string(get(signature, "algorithm"))?)),
                            ("value", text(&or_string(get(signature, "value"))?)),
                        ]))
                    })
                    .collect::<Result<Vec<_>, String>>()?,
            ),
        ),
    ]);
    let normalized = fields_object(fields);
    let digest = hash("OperatorDatasetHarnessAuthorityDocument", &normalized)?;
    Ok((normalized, digest, local, legacy))
}
fn split_manifest(
    value: &Json,
    name: &str,
    manifest: &str,
    c: &AtomicBool,
    d: Instant,
) -> Result<(Json, String), String> {
    ensure(
        exact(
            value,
            &[
                "version",
                "kind",
                "datasetName",
                "datasetManifestHash",
                "entries",
            ],
        ) && literal_number(get(value, "version"), 1.0)
            && eq(get(value, "kind"), "OperatorDatasetSplitManifest"),
        "operator_dataset_split_manifest_shape_invalid",
    )?;
    let declared_name = or_string(get(value, "datasetName"))?;
    let declared_hash = or_string(get(value, "datasetManifestHash"))?;
    ensure(
        identifier(&declared_name, 128, b"_.-")
            && declared_name == name
            && sha(&text(&declared_hash))?
            && declared_hash == manifest,
        "operator_dataset_split_manifest_identity_invalid",
    )?;
    ensure(
        is_array(get(value, "entries"))
            && !array(get(value, "entries")).is_empty()
            && array(get(value, "entries")).len() <= 100000,
        "operator_dataset_split_manifest_entries_invalid",
    )?;
    let mut seen = BTreeSet::new();
    let mut entries = Vec::new();
    for entry in array(get(value, "entries")) {
        control_check(c, d)?;
        ensure(
            exact(entry, &["path", "sha256", "split"]),
            "operator_dataset_split_manifest_entry_invalid",
        )?;
        let path = or_string(get(entry, "path"))?.replace('\\', "/");
        let digest = or_string(get(entry, "sha256"))?.to_lowercase();
        let split = or_string(get(entry, "split"))?;
        ensure(
            !path.is_empty()
                && path.len() <= 512
                && !path.starts_with('/')
                && path
                    .bytes()
                    .all(|byte| byte.is_ascii_alphanumeric() || b"_./-".contains(&byte))
                && !path.split('/').any(|component| component == "..")
                && sha(&text(&digest))?
                && ["train", "validation", "test", "public"].contains(&split.as_str())
                && seen.insert(path.clone()),
            "operator_dataset_split_manifest_entry_invalid",
        )?;
        ensure(
            split != "test",
            "operator_dataset_hidden_test_split_must_not_be_worker_visible",
        )?;
        entries.push((
            path.clone(),
            object([
                ("path", text(&path)),
                ("sha256", text(&digest)),
                ("split", text(&split)),
            ]),
        ));
    }
    let collator = hepta_legacy_compatibility::ProductionCollationV1::load()
        .map_err(|error| error.to_string())?;
    entries.sort_by(|left, right| collator.compare(&left.0, &right.0));
    let normalized = object([
        ("version", Json::Number(1.0)),
        ("kind", text("OperatorDatasetSplitManifest")),
        ("datasetName", text(name)),
        ("datasetManifestHash", text(&manifest.to_lowercase())),
        (
            "entries",
            Json::Array(entries.into_iter().map(|(_, entry)| entry).collect()),
        ),
    ]);
    let digest = hash("OperatorDatasetSplitManifest", &normalized)?;
    Ok((normalized, digest))
}
fn json_object(value: &Json) -> Result<bool, String> {
    Ok(matches!(value, Json::Object(_))
        && String::from_utf8(wire(value)?)
            .map_err(|_| "operator_dataset_harness_case_invalid")?
            .encode_utf16()
            .count()
            <= 64 * 1024)
}
fn harness(
    value: &Json,
    name: &str,
    registry: &Value,
    descriptors: &Value,
    c: &AtomicBool,
    d: Instant,
) -> Result<(Json, String, bool, usize, f64), String> {
    ensure(
        exact(
            value,
            &[
                "version",
                "kind",
                "benchmarkId",
                "benchmarkFamily",
                "seedSchedule",
                "minimumRepetitions",
                "cells",
            ],
        ) && literal_number(get(value, "version"), 1.0)
            && eq(
                get(value, "kind"),
                "OperatorAuthorizedDatasetBenchmarkHarness",
            ),
        "operator_dataset_harness_shape_invalid",
    )?;
    let id = or_string(get(value, "benchmarkId"))?;
    let benchmark_family = or_string(get(value, "benchmarkFamily"))?;
    ensure(
        identifier(&id, 128, b"_.-") && id == name && family(&benchmark_family, registry).is_ok(),
        "operator_dataset_harness_identity_invalid",
    )?;
    let oracle_fields = descriptors
        .as_array()
        .and_then(|entries| {
            entries
                .iter()
                .find(|entry| entry["benchmarkFamily"].as_str() == Some(&benchmark_family))
        })
        .and_then(|entry| entry["oracleFields"].as_array())
        .ok_or("operator_dataset_harness_identity_invalid")?
        .iter()
        .map(|field| {
            field
                .as_str()
                .map(str::to_owned)
                .ok_or("operator_dataset_harness_identity_invalid")
        })
        .collect::<Result<Vec<_>, _>>()?;
    let mut seeds = Vec::new();
    for seed in array(get(value, "seedSchedule")) {
        let seed = number(seed)?;
        if !seeds.contains(&seed) {
            seeds.push(seed);
        }
    }
    let repetitions = number(get(value, "minimumRepetitions"))?;
    let (_, _, clustered) = inference::profile(&benchmark_family, registry)?;
    let independent = if clustered {
        seeds.len() as f64
    } else {
        seeds.len() as f64 * repetitions
    };
    ensure(
        !seeds.is_empty()
            && seeds.len() <= 100
            && seeds.iter().copied().all(safe)
            && safe(repetitions)
            && (1.0..=100.0).contains(&repetitions)
            && independent >= 32.0,
        "operator_dataset_harness_schedule_invalid",
    )?;
    let expected = seeds
        .iter()
        .flat_map(|seed| (1..=repetitions as i64).map(move |repetition| (*seed as i64, repetition)))
        .collect::<BTreeSet<_>>();
    let mut seen = BTreeSet::new();
    let mut cells = Vec::new();
    for cell in array(get(value, "cells")) {
        control_check(c, d)?;
        ensure(
            exact(cell, &["seed", "repetition", "cases"]),
            "operator_dataset_harness_cell_invalid",
        )?;
        let seed = number(get(cell, "seed"))?;
        let repetition = number(get(cell, "repetition"))?;
        let key = (seed as i64, repetition as i64);
        ensure(
            safe(seed)
                && safe(repetition)
                && expected.contains(&key)
                && seen.insert(key)
                && is_array(get(cell, "cases"))
                && array(get(cell, "cases")).len() == 8,
            "operator_dataset_harness_cell_invalid",
        )?;
        let mut cases = Vec::new();
        let mut case_ids = BTreeSet::new();
        for case in array(get(cell, "cases")) {
            control_check(c, d)?;
            let scalar = benchmark_family == "registered_scalar_response_benchmark";
            let oracle = get(case, "oracle");
            let oracle_maximum = if scalar { 1e6 } else { 1e12 };
            let reference = get(case, "referenceResponse");
            ensure(exact(case,&["caseId","input","ablationInput","referenceResponse","oracle"]) && sha(get(case,"caseId"))? && json_object(get(case,"input"))? && json_object(get(case,"ablationInput"))? && matches!(reference,Json::Number(n) if n.is_finite() && n.abs()<=1e6) && exact(oracle,&oracle_fields.iter().map(String::as_str).collect::<Vec<_>>()) && oracle_fields.iter().all(|field|matches!(get(oracle,field),Json::Number(n) if n.is_finite() && n.abs()<=oracle_maximum)) && (!scalar || (number(get(oracle,"lowerBound"))?<=number(get(oracle,"upperBound"))? && number(get(oracle,"target"))?>=number(get(oracle,"lowerBound"))? && number(get(oracle,"target"))?<=number(get(oracle,"upperBound"))? && number(get(oracle,"robustTarget"))?>=number(get(oracle,"lowerBound"))? && number(get(oracle,"robustTarget"))?<=number(get(oracle,"upperBound"))?)),"operator_dataset_harness_case_invalid")?;
            let case_id = string(get(case, "caseId"))?.to_lowercase();
            ensure(
                case_ids.insert(case_id.clone()),
                "operator_dataset_harness_case_duplicate",
            )?;
            cases.push(object([
                ("caseId", text(&case_id)),
                (
                    "input",
                    hepta_legacy_compatibility::parse_production_json_v1(&wire(get(
                        case, "input",
                    ))?)
                    .map_err(|error| error.to_string())?,
                ),
                (
                    "ablationInput",
                    hepta_legacy_compatibility::parse_production_json_v1(&wire(get(
                        case,
                        "ablationInput",
                    ))?)
                    .map_err(|error| error.to_string())?,
                ),
                ("referenceResponse", reference.clone()),
                (
                    "oracle",
                    fields_object(
                        oracle_fields
                            .iter()
                            .map(|field| (field.clone(), get(oracle, field).clone())),
                    ),
                ),
            ]));
        }
        cells.push((
            key,
            object([
                ("seed", Json::Number(seed)),
                ("repetition", Json::Number(repetition)),
                ("cases", Json::Array(cases)),
            ]),
        ));
    }
    ensure(
        seen == expected,
        "operator_dataset_harness_schedule_incomplete",
    )?;
    cells.sort_by_key(|(key, _)| *key);
    let seed_count = seeds.len();
    let normalized = object([
        ("version", Json::Number(1.0)),
        ("kind", text("OperatorAuthorizedDatasetBenchmarkHarness")),
        ("benchmarkId", text(&id)),
        ("benchmarkFamily", text(&benchmark_family)),
        (
            "seedSchedule",
            Json::Array(seeds.into_iter().map(Json::Number).collect()),
        ),
        ("minimumRepetitions", Json::Number(repetitions)),
        (
            "cells",
            Json::Array(cells.into_iter().map(|(_, cell)| cell).collect()),
        ),
    ]);
    let digest = hash("OperatorAuthorizedDatasetBenchmarkHarness", &normalized)?;
    Ok((normalized, digest, clustered, seed_count, repetitions))
}
pub(super) fn validate(
    value: &Json,
    name: &str,
    manifest: &str,
    registry: &Value,
    descriptors: &Value,
    c: &AtomicBool,
    d: Instant,
) -> Result<DatasetContract, String> {
    control_check(c, d)?;
    let legacy = literal_number(get(value, "version"), 1.0);
    let local = literal_number(get(value, "version"), 4.0);
    let mut keys = vec![
        "version",
        "kind",
        "authority",
        "splitManifest",
        "harnessDefinition",
    ];
    if !legacy {
        keys.push("analysisProtocol");
    }
    ensure(
        exact(value, &keys)
            && [1.0, 2.0, 3.0, 4.0]
                .iter()
                .any(|version| literal_number(get(value, "version"), *version))
            && eq(
                get(value, "kind"),
                if local {
                    "LocalGoldenDatasetHarnessEnvelope"
                } else {
                    "OperatorDatasetHarnessEnvelope"
                },
            )
            && same(
                get(value, "version"),
                get(get(value, "authority"), "version"),
            )?,
        "operator_dataset_harness_envelope_shape_invalid",
    )?;
    let (authority, authority_hash, local, legacy) =
        authority(get(value, "authority"), name, manifest, registry)?;
    let name = string(get(&authority, "datasetName"))?;
    let manifest = string(get(&authority, "datasetManifestHash"))?;
    let family = string(get(&authority, "benchmarkFamily"))?;
    let (splits, split_hash) = split_manifest(get(value, "splitManifest"), &name, &manifest, c, d)?;
    let (definition, definition_hash, clustered, seeds, repetitions) = harness(
        get(value, "harnessDefinition"),
        &name,
        registry,
        descriptors,
        c,
        d,
    )?;
    let (analysis, analysis_hash) = if legacy {
        (Json::Null, None)
    } else {
        let (value, digest, _) = analysis::validate(
            get(value, "analysisProtocol"),
            &name,
            &family,
            registry,
            c,
            d,
        )?;
        (value, Some(digest))
    };
    let independent = if clustered {
        seeds as f64
    } else {
        seeds as f64 * repetitions
    };
    let research = local || literal_number(get(&authority, "version"), 3.0);
    ensure(eq(get(&authority,"datasetSplitManifestHash"),&split_hash) && eq(get(&authority,"benchmarkHarnessDefinitionHash"),&definition_hash) && (legacy || (analysis_hash.as_ref().is_some_and(|hash|eq(get(&authority,"analysisProtocolHash"),hash)) && independent>=number(get(get(&analysis,"power"),"requiredPairedObservations"))?)) && same(get(&authority,"benchmarkFamily"),get(&definition,"benchmarkFamily"))? && (!research || array(get(&splits,"entries")).iter().all(|entry|array(get(get(&authority,"researchSemantics"),"eligibleSplits")).iter().any(|split|matches!((split,get(entry,"split")),(Json::String(left),Json::String(right)) if left==right)))) && same(get(&authority,"seedSchedule"),get(&definition,"seedSchedule"))? && same(get(&authority,"minimumRepetitions"),get(&definition,"minimumRepetitions"))?,"operator_dataset_harness_envelope_binding_invalid")?;
    control_check(c, d)?;
    Ok(DatasetContract {
        authority,
        authority_hash,
        splits,
        split_hash,
        definition,
        definition_hash,
        analysis,
        analysis_hash,
        local,
        legacy,
    })
}
