use super::*;
use crate::{
    native_business::NativeBusinessOutputV1,
    native_research_claims::json_boundary,
    native_research_contract_context::{
        NativeResearchContractContextRequestV1, build_native_research_contract_context_v1,
    },
    native_research_evidence::{
        NativeResearchObservedInputsObservationV1, build_native_evidence_verification_candidates_v1,
    },
    native_research_gap_plan::build_native_research_gap_plan_v1,
};
use serde_json::json;
use std::collections::{BTreeMap, BTreeSet};
fn record_hash(kind: &str, value: &Value) -> Result<String, String> {
    hepta_legacy_compatibility::production_hash_record_v1(kind, value)
        .map(|h| h.as_str().into())
        .map_err(|_| refused())
}
pub(super) fn read_manifest(
    objects: &ObjectStoreV1,
    request: &NativeResearchCasAssessmentRequestV1,
) -> Result<CapturedManifest, String> {
    if request.version != 1 {
        return Err(refused());
    }
    let bytes = objects
        .read_with_maximum_v1(&request.manifest_object, MAX_MANIFEST)
        .map_err(|_| refused())?;
    if sha(&bytes) != request.manifest_object {
        return Err(refused());
    }
    let manifest: CapturedManifest = serde_json::from_slice(&bytes).map_err(|_| refused())?;
    if manifest.implementation_hash
        != crate::native_business::native_business_implementation_hash_v1()
        || manifest.version != 1
        || manifest.kind != "NativeCapturedResearchSourceManifest"
        || manifest.files.len() > MAX_FILES
        || manifest.records.len() > 96
    {
        return Err(refused());
    }
    display_root(&manifest.display_inventory_root)?;
    let source = display_root(&manifest.display_source_root)?;
    if !source.starts_with(&manifest.display_inventory_root) {
        return Err(refused());
    }
    let files = manifest.source_snapshot["workspaceSnapshot"]["fileRecords"]
        .as_array()
        .ok_or_else(refused)?;
    if files.len() != manifest.files.len() {
        return Err(refused());
    }
    let mut seen = BTreeSet::new();
    for file in &manifest.files {
        relative(&file.relative)?;
        if !seen.insert(&file.relative) || file.bytes > MAX_RAW {
            return Err(refused());
        }
        let actual = files
            .iter()
            .filter(|v| v["path"].as_str() == Some(&file.relative))
            .collect::<Vec<_>>();
        if actual.len() != 1
            || actual[0]["hash"].as_str() != Some(file.object.as_str())
            || actual[0]["bytes"].as_u64() != Some(file.bytes)
        {
            return Err(refused());
        }
    }
    reserve(
        [&manifest.row, &manifest.source_snapshot]
            .into_iter()
            .chain(&manifest.records),
        0,
        0,
    )?;
    if manifest.task_binding
        != NativeResearchObservedInputsObservationV1::derive_paper_task_binding_v1(
            &manifest.row["task"],
        )?
    {
        return Err(refused());
    }
    if manifest.row["sourceDir"].as_str() != Some(&manifest.display_source_root) {
        return Err(refused());
    }
    Ok(manifest)
}
/// The runtime fixes this deadline before entry. The request has no timeout,
/// workspace/database path authority or serialized verification receipts.
pub(crate) fn execute(
    objects: &ObjectStoreV1,
    request: NativeResearchCasAssessmentRequestV1,
    c: &AtomicBool,
    deadline: Instant,
) -> Result<NativeBusinessOutputV1, String> {
    check(c, deadline)?;
    let manifest = read_manifest(objects, &request)?;
    let mut actual = BTreeMap::new();
    let mut remaining = MAX_RAW;
    for file in &manifest.files {
        check(c, deadline)?;
        if file.bytes > remaining {
            return Err(refused());
        }
        let bytes = objects
            .read_with_maximum_v1(&file.object, remaining.max(1))
            .map_err(|_| refused())?;
        // Independent SHA recomputation, even though ObjectStore verifies too.
        if bytes.len() as u64 != file.bytes || sha(&bytes) != file.object {
            return Err(refused());
        }
        remaining -= file.bytes;
        actual.insert(file.relative.clone(), bytes);
    }
    let root = display_root(&manifest.display_inventory_root)?;
    let source = display_root(&manifest.display_source_root)?;
    let mut raw = BTreeMap::new();
    let mut seen = BTreeSet::new();
    for record in &manifest.records {
        check(c, deadline)?;
        let object = record.as_object().ok_or_else(refused)?;
        if object.keys().any(|key| {
            !matches!(
                key.as_str(),
                "role" | "path" | "filename" | "sizeBytes" | "mtimeMs" | "hash"
            )
        }) {
            return Err(refused());
        }
        let name = record["path"].as_str().ok_or_else(refused)?;
        if !seen.insert(name) {
            return Err(refused());
        }
        let path = root.join(relative(name)?);
        let member = path.strip_prefix(source).map_err(|_| refused())?;
        let member = member.to_str().ok_or_else(refused)?;
        relative(member)?;
        if Path::new(name).file_name().and_then(|v| v.to_str()) != record["filename"].as_str() {
            return Err(refused());
        }
        let bytes = actual.get(member).ok_or_else(refused)?;
        if record["sizeBytes"].as_u64() != Some(bytes.len() as u64)
            || record["hash"].as_str() != Some(sha(bytes).as_str())
        {
            return Err(refused());
        }
        raw.insert(name.to_owned(), bytes.as_slice());
    }
    let structured = crate::native_research_evidence::extract_native_research_record_bytes_v1(
        &manifest.records,
        &raw,
        c,
        deadline,
    )?;
    // Candidate statuses are data. Every actual integrity receipt is derived
    // below from the worker-owned object bytes, never from an input flag.
    let candidates = build_native_evidence_verification_candidates_v1(
        root,
        Some(source),
        &structured,
        c,
        deadline,
    )?;
    let now = crate::sqlite_mutation_coordinator::clock::MutationClockV1::now_millis(
        &mut crate::sqlite_mutation_coordinator::clock::SystemMutationClockV1,
    )
    .map_err(|_| refused())?;
    let created = crate::sqlite_mutation_coordinator::clock::iso(now).map_err(|_| refused())?;
    let mut receipts = Vec::new();
    for candidate in &candidates {
        check(c, deadline)?;
        let value = json_boundary(candidate);
        let path = value["path"].as_str().ok_or_else(refused)?;
        let selected = Path::new(path)
            .strip_prefix(source)
            .map_err(|_| refused())?;
        let name = selected.to_str().ok_or_else(refused)?;
        relative(name)?;
        let actual_bytes = actual.get(name);
        let actual_hash = actual_bytes.map(|bytes| sha(bytes));
        let mut blockers = Vec::new();
        if actual_hash.is_none() {
            blockers.push("cas_artifact_member_missing");
        }
        if actual_hash.as_ref().map(Sha256Digest::as_str) != value["hash"].as_str() {
            blockers.push("cas_artifact_expected_hash_mismatch");
        }
        if !value["provenance"].as_str().is_some_and(|v| !v.is_empty()) {
            blockers.push("cas_artifact_provenance_missing");
        }
        reserve(receipts.iter().chain([&value]), 32, created.len() + 4096)?;
        let mut receipt = json!({"version":1,"kind":"NativeCasArtifactIntegrityReceipt","evidenceId":value["id"],"path":value["path"],"expectedHash":value["hash"],"verifiedHash":actual_hash,"sourceManifestObject":request.manifest_object,"taskBinding":manifest.task_binding,"provenance":value["provenance"],"status":if blockers.is_empty(){"cas_artifact_integrity_verified"}else{"cas_artifact_integrity_blocked"},"blockers":blockers,"createdAt":created,"currentFilesystemVerified":false,"academicAuthorityGranted":false,"externalActionPerformed":false});
        receipt["provenanceReceiptHash"] =
            json!(record_hash("NativeCasArtifactIntegrityReceipt", &receipt)?);
        receipts.push(receipt);
    }
    let verification = NativeCasArtifactObservationV1 {
        objects,
        files: manifest
            .files
            .iter()
            .map(|f| (f.object.clone(), f.bytes))
            .collect(),
        receipts,
        cancelled: c,
        deadline,
    };
    verification.verify_unchanged()?;
    let intake =
        crate::native_research_evidence::intake::build_native_research_cas_evidence_intake_v1(
            &manifest.row["task"],
            &structured,
            &verification,
            now,
            c,
            deadline,
        )?;
    reserve(
        [&manifest.row, &structured, &intake]
            .into_iter()
            .chain(&manifest.records),
        64,
        4096,
    )?;
    let context = build_native_research_contract_context_v1(
        NativeResearchContractContextRequestV1 {
            version: 1,
            row: manifest.row.clone(),
            source_root: Some(source.to_path_buf()),
            evidence_records: manifest.records.clone(),
            proposal_seed_evidence: Vec::new(),
            structured,
            native_research_worker_execution: Value::Null,
            require_native_workers: false,
        },
        c,
        deadline,
    )?;
    let quality = crate::native_research_quality::quality_from_cas_intake(
        &manifest.row["task"],
        &context["claimRegistry"],
        &intake,
        &verification,
        c,
        deadline,
    )?;
    reserve([&manifest.row, &context, &intake, &quality], 32, 2048)?;
    let gap = build_native_research_gap_plan_v1(
        &json!({"paperTask":manifest.row["task"],"claimRegistry":context["claimRegistry"],"evidenceQualityGate":quality}),
        c,
        deadline,
    )?;
    reserve(
        [&manifest.row, &context, &intake, &quality, &gap]
            .into_iter()
            .chain(verification.receipts()),
        64,
        4096,
    )?;
    let report = json!({"version":1,"kind":"NativeCasResearchAssessment","profile":"captured_source_nonattested_cas_v1","sourceManifestObject":request.manifest_object,"taskBinding":manifest.task_binding,"paperId":manifest.row["task"]["paperId"],"taskKey":manifest.row["task"]["taskKey"],"integrityReceipts":verification.receipts(),"contractContext":context,"evidenceIntake":intake,"evidenceQualityGate":quality,"researchGapPlan":gap,"currentFilesystemVerified":false,"scientificAcceptanceGranted":false,"academicAuthorityGranted":false,"trustedExecutionBranchesAccepted":false});
    let bytes = serde_json::to_vec(&report).map_err(|_| refused())?;
    if bytes.len() as u64 > MAX_RAW {
        return Err(refused());
    }
    verification.verify_unchanged()?;
    let again = objects
        .read_with_maximum_v1(&request.manifest_object, MAX_MANIFEST)
        .map_err(|_| refused())?;
    if sha(&again) != request.manifest_object {
        return Err(refused());
    }
    check(c, deadline)?;
    Ok(NativeBusinessOutputV1 {
        evidence: json!({"kind":"NativeCasResearchAssessmentEvidenceV1","sourceManifestObject":request.manifest_object,"taskBinding":manifest.task_binding,"reportHash":sha(&bytes),"currentFilesystemVerified":false,"scientificAcceptance":false,"externalEffectAuthorized":false}),
        artifacts: vec![bytes],
    })
}
