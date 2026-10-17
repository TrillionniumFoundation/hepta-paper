//! The incumbent receipt is a public diagnostic projection; hidden cases never
//! enter it. Its hash is computed over the complete original ordered payload.
use super::{
    contract::{DatasetContract, LOCAL_EVIDENCE, LOCAL_SCOPE},
    json::*,
};
use hepta_legacy_compatibility::ProductionJsonValue as Json;
use std::{collections::BTreeSet, path::Path};

// Reserve a conservative complete projection before cloning any borrowed JSON.
// This native bounded profile refuses oversized receipts before allocating them.
fn reserve(
    mount: &Json,
    contract: Option<&DatasetContract>,
    verification: &Json,
    blockers: &[String],
    cancelled: &std::sync::atomic::AtomicBool,
    deadline: std::time::Instant,
) -> Result<(), String> {
    use hepta_legacy_compatibility::{
        ProductionJsonEncodingLimitsV1, production_json_resources_v1,
    };
    let bound = ProductionJsonEncodingLimitsV1::default();
    let mut bytes = 16 * 1024usize;
    let mut values = 1024usize;
    let mut units = 16 * 1024usize;
    for blocker in blockers {
        super::control_check(cancelled, deadline)?;
        let n = blocker.encode_utf16().count();
        bytes = bytes
            .checked_add(
                n.checked_mul(6)
                    .ok_or("operator_dataset_receipt_projection_budget_exceeded")?,
            )
            .and_then(|value| value.checked_add(4))
            .ok_or("operator_dataset_receipt_projection_budget_exceeded")?;
        units = units
            .checked_add(n)
            .ok_or("operator_dataset_receipt_projection_budget_exceeded")?;
        values = values
            .checked_add(1)
            .ok_or("operator_dataset_receipt_projection_budget_exceeded")?;
    }
    let mut borrowed = vec![mount, verification];
    if let Some(contract) = contract {
        borrowed.extend([
            &contract.authority,
            &contract.analysis,
            get(&contract.authority, "researchSemantics"),
            get(&contract.authority, "localGoldenRuntimeScope"),
        ]);
    }
    for input in borrowed {
        super::control_check(cancelled, deadline)?;
        let limits = ProductionJsonEncodingLimitsV1 {
            maximum_bytes: bound
                .maximum_bytes
                .checked_sub(bytes)
                .ok_or("operator_dataset_receipt_projection_budget_exceeded")?,
            maximum_values: bound
                .maximum_values
                .checked_sub(values)
                .ok_or("operator_dataset_receipt_projection_budget_exceeded")?,
            maximum_utf16_units: bound
                .maximum_utf16_units
                .checked_sub(units)
                .ok_or("operator_dataset_receipt_projection_budget_exceeded")?,
        };
        let measured = production_json_resources_v1(input, limits, cancelled)
            .map_err(|error| error.to_string())?;
        bytes += measured.bytes;
        values += measured.values;
        units += measured.utf16_units;
        super::control_check(cancelled, deadline)?;
    }
    Ok(())
}
fn nullable(value: &Json) -> Json {
    if truthy(value) {
        value.clone()
    } else {
        Json::Null
    }
}
pub(super) fn mount_bindings(
    mount: &Json,
    contract: Option<&DatasetContract>,
    runtime_root: &Path,
    manifest: &str,
    files: &[(String, String)],
    blockers: &mut Vec<String>,
) -> Result<(), String> {
    if let Some(contract) = contract {
        if contract.local {
            let root_hash = hash(
                "LocalGoldenDatasetRuntimeRoot",
                &object([(
                    "runtimeRoot",
                    text(
                        runtime_root
                            .to_str()
                            .ok_or("local_golden_dataset_runtime_root_required")?,
                    ),
                )]),
            )?;
            if !eq(
                get(
                    get(&contract.authority, "localGoldenRuntimeScope"),
                    "runtimeRootHash",
                ),
                &root_hash,
            ) {
                blockers.push("local_golden_dataset_runtime_scope_mismatch".into());
            }
            if !eq(get(mount, "authorityScope"), LOCAL_SCOPE)
                || !eq(get(mount, "evidenceClass"), LOCAL_EVIDENCE)
                || !boolean(get(mount, "academicPromotionEligible"), false)
                || !boolean(get(mount, "externalTrustClaimed"), false)
                || !same(
                    get(mount, "localGoldenRuntimeScope"),
                    get(&contract.authority, "localGoldenRuntimeScope"),
                )?
            {
                blockers.push("local_golden_dataset_mount_scope_binding_invalid".into());
            }
        }
        if contract.legacy {
            blockers.push("operator_dataset_analysis_protocol_required".into());
        }
    }
    if !eq(get(mount, "manifestHash"), manifest)
        || !contract
            .is_some_and(|contract| eq(get(&contract.authority, "datasetManifestHash"), manifest))
    {
        blockers.push("operator_dataset_manifest_identity_mismatch".into());
    }
    if let Some(contract) = contract {
        let declared = array(get(&contract.splits, "entries"))
            .iter()
            .map(|entry| Ok((string(get(entry, "path"))?, string(get(entry, "sha256"))?)))
            .collect::<Result<Vec<_>, String>>()?;
        let collator = hepta_legacy_compatibility::ProductionCollationV1::load()
            .map_err(|error| error.to_string())?;
        let mut actual = files.to_vec();
        actual.sort_by(|left, right| collator.compare(&left.0, &right.0));
        if actual != declared {
            blockers.push("operator_dataset_split_manifest_files_mismatch".into());
        }
    }
    if !contract.is_some_and(|contract| {
        matches!((get(&contract.authority,"datasetLicenseId"),get(mount,"licenseId")),
            (Json::String(left),Json::String(right)) if left==right)
    }) {
        blockers.push("operator_dataset_license_authority_mismatch".into());
    }
    Ok(())
}
pub(super) fn plan_bindings(
    mount: &Json,
    contract: Option<&DatasetContract>,
    envelope_hash: Option<&str>,
    blockers: &mut Vec<String>,
) -> Result<(), String> {
    if let Some(contract) = contract {
        let hash = envelope_hash.map_or(Json::Null, text);
        let analysis_hash = contract.analysis_hash.as_deref().map_or(Json::Null, text);
        let research = contract.local || literal_number(get(&contract.authority, "version"), 3.0);
        let mut matches = eq(
            get(mount, "operatorAuthorizationHash"),
            &contract.authority_hash,
        ) && eq(
            get(mount, "operatorDatasetAuthorityDocumentHash"),
            &contract.authority_hash,
        ) && eq(get(mount, "splitManifestHash"), &contract.split_hash)
            && eq(
                get(mount, "benchmarkHarnessDefinitionHash"),
                &contract.definition_hash,
            )
            && same(get(mount, "analysisProtocolHash"), &analysis_hash)?
            && same(get(mount, "analysisProtocol"), &contract.analysis)?
            && same(get(mount, "benchmarkHarnessDocumentHash"), &hash)?
            && same(get(mount, "operatorDatasetHarnessHandle"), &hash)?
            && same(get(mount, "operatorDatasetAuthority"), &contract.authority)?;
        if research {
            matches = matches
                && eq(
                    get(mount, "operatorDatasetResearchSemanticsHash"),
                    &hash_record_semantics(contract)?,
                )
                && same(
                    get(mount, "operatorDatasetResearchSemantics"),
                    get(&contract.authority, "researchSemantics"),
                )?;
        }
        if !matches {
            blockers.push("operator_dataset_harness_plan_binding_mismatch".into());
        }
    }
    Ok(())
}
fn hash_record_semantics(contract: &DatasetContract) -> Result<String, String> {
    hash(
        "OperatorDatasetResearchSemantics",
        get(&contract.authority, "researchSemantics"),
    )
}
pub(super) fn build(
    mount: &Json,
    contract: Option<&DatasetContract>,
    envelope_hash: Option<&str>,
    verification: Json,
    blockers: &[String],
    cancelled: &std::sync::atomic::AtomicBool,
    deadline: std::time::Instant,
) -> Result<Json, String> {
    reserve(
        mount,
        contract,
        &verification,
        blockers,
        cancelled,
        deadline,
    )?;
    let mut unique = Vec::new();
    let mut seen = BTreeSet::new();
    for blocker in blockers {
        if seen.insert(blocker) {
            unique.push(text(blocker));
        }
    }
    let mut fields = vec![
        ("version".into(), Json::Number(3.0)),
        (
            "kind".into(),
            text("OperatorDatasetHarnessAuthorityReceipt"),
        ),
        (
            "status".into(),
            text(if blockers.is_empty() {
                "operator_dataset_harness_authority_verified"
            } else {
                "operator_dataset_harness_authority_blocked"
            }),
        ),
        ("datasetName".into(), nullable(get(mount, "name"))),
        (
            "datasetManifestHash".into(),
            nullable(get(mount, "manifestHash")),
        ),
        (
            "datasetSplitManifestHash".into(),
            contract.map_or_else(
                || nullable(get(mount, "splitManifestHash")),
                |contract| text(&contract.split_hash),
            ),
        ),
        ("datasetLicenseId".into(), nullable(get(mount, "licenseId"))),
        (
            "operatorAuthorizationHash".into(),
            contract.map_or(Json::Null, |contract| text(&contract.authority_hash)),
        ),
        (
            "operatorDatasetAuthorityDocumentHash".into(),
            contract.map_or(Json::Null, |contract| text(&contract.authority_hash)),
        ),
        (
            "benchmarkHarnessDefinitionHash".into(),
            contract.map_or(Json::Null, |contract| text(&contract.definition_hash)),
        ),
        (
            "benchmarkFamily".into(),
            contract.map_or(Json::Null, |contract| {
                get(&contract.definition, "benchmarkFamily").clone()
            }),
        ),
        (
            "analysisProtocol".into(),
            contract.map_or(Json::Null, |contract| contract.analysis.clone()),
        ),
        (
            "analysisProtocolHash".into(),
            contract
                .and_then(|contract| contract.analysis_hash.as_deref())
                .map_or(Json::Null, text),
        ),
    ];
    if let Some(contract) = contract {
        if contract.local || literal_number(get(&contract.authority, "version"), 3.0) {
            fields.extend([
                (
                    "operatorDatasetResearchSemantics".into(),
                    get(&contract.authority, "researchSemantics").clone(),
                ),
                (
                    "operatorDatasetResearchSemanticsHash".into(),
                    text(&hash_record_semantics(contract)?),
                ),
            ]);
        }
        if contract.local {
            fields.extend([
                ("authorityScope".into(), text(LOCAL_SCOPE)),
                ("evidenceClass".into(), text(LOCAL_EVIDENCE)),
                ("academicPromotionEligible".into(), Json::Bool(false)),
                ("externalTrustClaimed".into(), Json::Bool(false)),
                (
                    "localGoldenRuntimeScope".into(),
                    get(&contract.authority, "localGoldenRuntimeScope").clone(),
                ),
            ]);
        }
    }
    fields.extend([
        (
            "authority".into(),
            contract.map_or(Json::Null, |contract| contract.authority.clone()),
        ),
        (
            "envelopeDocumentHash".into(),
            envelope_hash.map_or(Json::Null, text),
        ),
        (
            "operatorDatasetAuthorityVerificationHash".into(),
            text(&hash(
                "OperatorDatasetAuthorityVerification",
                &verification,
            )?),
        ),
        ("authorityVerification".into(), verification),
        (
            "authorizationScheme".into(),
            text("ed25519-signed-host-only-dataset-harness-v1"),
        ),
        (
            "evidenceAuthority".into(),
            text("host-owned-hidden-fixture-reader-and-evaluator-v2"),
        ),
        (
            "analysisAuthority".into(),
            text("operator-signed-preregistered-analysis-protocol-v1"),
        ),
        (
            "workerDatasetExposure".into(),
            text("signed-complete-dataset-file-manifest-v1"),
        ),
        ("hostOnlyHarnessMounted".into(), Json::Bool(false)),
        ("rawOraclePublished".into(), Json::Bool(false)),
        ("blockers".into(), Json::Array(unique)),
        ("externalActionPerformed".into(), Json::Bool(false)),
    ]);
    let mut report = fields_object(fields);
    super::control_check(cancelled, deadline)?;
    let digest = hash("OperatorDatasetHarnessAuthorityReceipt", &report)?;
    super::control_check(cancelled, deadline)?;
    let Json::Object(fields) = &mut report else {
        return Err("operator_dataset_receipt_projection_invalid".into());
    };
    fields.push((
        "operatorDatasetHarnessAuthorityReceiptHash"
            .encode_utf16()
            .collect(),
        text(&digest),
    ));
    Ok(report)
}
