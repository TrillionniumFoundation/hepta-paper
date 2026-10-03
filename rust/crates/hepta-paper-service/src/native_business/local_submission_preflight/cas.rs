//! Actual CAS content binding for non-authorizing local submission preparation.
//! This owner reads the existing verified object store; it never reads an
//! arbitrary filesystem path, accepts an authority receipt, or sends a request.
use super::*;
use crate::{
    ObjectStoreV1,
    native_business::{
        NativeBusinessError, NativeBusinessOutputV1, SubmissionPackageV1, prepare_submission_v1,
        verify_native_build_bundle_v1,
    },
};
use hepta_codex_protocol::Sha256Digest;
use std::sync::atomic::{AtomicBool, Ordering};
#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum CasLocalSubmissionArtifactRoleV1 {
    Manuscript,
    SourcePackage,
    Supplementary,
}
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CasLocalSubmissionArtifactV1 {
    pub role: CasLocalSubmissionArtifactRoleV1,
    pub filename: String,
    pub digest: Sha256Digest,
}
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CasLocalSubmissionPreparationRequestV1 {
    pub version: u16,
    pub kind: String,
    pub preflight: LocalSubmissionPreflightInputV1,
    pub artifacts: Vec<CasLocalSubmissionArtifactV1>,
    pub cover_letter: String,
    pub reference_time_millis: i64,
}
fn cas_local_submission_check_cancelled(cancelled: &AtomicBool) -> Result<(), NativeBusinessError> {
    if cancelled.load(Ordering::Acquire) {
        Err(NativeBusinessError::Contract)
    } else {
        Ok(())
    }
}
fn cas_local_submission_contract() -> NativeBusinessError {
    NativeBusinessError::Contract
}
/// Read and rehash real CAS objects, then compute a ready *local* manifest and
/// dry-run receipt. Readiness here is artifact binding, never academic or live
/// submission acceptance. Caller-supplied status/hash summaries cannot enter.
pub fn prepare_local_submission_from_cas_v1(
    objects: &ObjectStoreV1,
    request: CasLocalSubmissionPreparationRequestV1,
    cancelled: &AtomicBool,
) -> Result<NativeBusinessOutputV1, NativeBusinessError> {
    cas_local_submission_check_cancelled(cancelled)?;
    if request.version != 1
        || request.kind != "NativeCasLocalSubmissionPreparationRequest"
        || request.preflight.mode != "local-dry-run"
        || request.preflight.reviewed_submit
        || request.artifacts.len() < 2
        || request.artifacts.len() > 64
    {
        return Err(cas_local_submission_contract());
    }
    build_local_submission_preflight_v1(request.preflight.clone())
        .map_err(|_| cas_local_submission_contract())?;
    crate::native_business::validate_body_text(&request.cover_letter)?;
    let mut paths = BTreeSet::new();
    let mut hashes = BTreeSet::new();
    for artifact in &request.artifacts {
        crate::native_business::validate_identifier(&artifact.filename, 1024)?;
        if artifact.filename.starts_with('/')
            || artifact.filename.contains('\\')
            || artifact
                .filename
                .split('/')
                .any(|p| p.is_empty() || p == "." || p == "..")
            || !paths.insert(artifact.filename.clone())
            || !hashes.insert(artifact.digest.clone())
        {
            return Err(cas_local_submission_contract());
        }
    }
    let manuscripts = request
        .artifacts
        .iter()
        .filter(|a| a.role == CasLocalSubmissionArtifactRoleV1::Manuscript)
        .collect::<Vec<_>>();
    let sources = request
        .artifacts
        .iter()
        .filter(|a| a.role == CasLocalSubmissionArtifactRoleV1::SourcePackage)
        .collect::<Vec<_>>();
    if manuscripts.len() != 1 || sources.len() != 1 {
        return Err(cas_local_submission_contract());
    }
    let manuscript = manuscripts[0];
    let source = sources[0];
    if request.preflight.paper_task["sourceWorkspace"] != format!("cas:{}", source.digest)
        || request.preflight.paper_task["mainTex"] != manuscript.filename
    {
        return Err(cas_local_submission_contract());
    }
    let mut observed = Vec::new();
    let mut total = 0usize;
    for descriptor in &request.artifacts {
        cas_local_submission_check_cancelled(cancelled)?;
        let bytes = objects
            .read(&descriptor.digest)
            .map_err(|_| cas_local_submission_contract())?;
        if bytes.is_empty() {
            return Err(cas_local_submission_contract());
        }
        total = total
            .checked_add(bytes.len())
            .ok_or_else(cas_local_submission_contract)?;
        if total > crate::native_business::MAX_TOTAL_TEXT_BYTES {
            return Err(NativeBusinessError::OutputLimit);
        }
        cas_local_submission_check_cancelled(cancelled)?;
        observed.push((descriptor, bytes));
    }
    let manuscript_bytes = &observed
        .iter()
        .find(|(d, _)| d.role == CasLocalSubmissionArtifactRoleV1::Manuscript)
        .ok_or_else(cas_local_submission_contract)?
        .1;
    let manuscript_text =
        std::str::from_utf8(manuscript_bytes).map_err(|_| cas_local_submission_contract())?;
    crate::native_business::validate_body_text(manuscript_text)?;
    let source_bytes = &observed
        .iter()
        .find(|(d, _)| d.role == CasLocalSubmissionArtifactRoleV1::SourcePackage)
        .ok_or_else(cas_local_submission_contract)?
        .1;
    let entries = verify_native_build_bundle_v1(source_bytes, source.digest.as_str())?;
    if !entries.iter().any(|entry| {
        entry.path == manuscript.filename && entry.content.as_bytes() == manuscript_bytes.as_slice()
    }) {
        return Err(cas_local_submission_contract());
    }
    let created = crate::sqlite_mutation_coordinator::clock::iso(request.reference_time_millis)
        .map_err(|_| cas_local_submission_contract())?;
    let artifact_rows=observed.iter().enumerate().map(|(i,(d,b))|json!({"id":format!("{}:artifact:{}",request.preflight.paper_task["paperId"].as_str().unwrap_or(""),i+1),"role":match d.role{CasLocalSubmissionArtifactRoleV1::Manuscript=>"manuscript",CasLocalSubmissionArtifactRoleV1::SourcePackage=>"source_package",CasLocalSubmissionArtifactRoleV1::Supplementary=>"supplementary"},"filename":d.filename,"path":format!("cas:{}",d.digest),"mimeType":match d.role{CasLocalSubmissionArtifactRoleV1::Manuscript=>"text/markdown",CasLocalSubmissionArtifactRoleV1::SourcePackage=>"application/vnd.hepta.native-bundle",CasLocalSubmissionArtifactRoleV1::Supplementary=>"application/octet-stream"},"sizeBytes":b.len(),"hash":d.digest,"source":"native_content_addressed_store"})).collect::<Vec<_>>();
    let mut package = json!({"version":1,"kind":"PaperArtifactPackage","taskKey":request.preflight.paper_task["taskKey"],"paperId":request.preflight.paper_task["paperId"],"outputMode":"manuscript_package","mode":"local-package","packageStatus":"package_ready","buildStatus":"native_bundle_content_verified","artifactCount":artifact_rows.len(),"artifacts":artifact_rows,"submitReady":true,"candidateArtifactPackageHash":null,"packageVerificationStatus":null,"packageVerificationReceiptHash":null,"artifactSettlementStatus":null,"artifactSettlementHash":null,"sourceSnapshotHash":null,"sourceTreeManifestHash":null,"sourcePackageContractHash":null,"manuscriptPromotionStatus":null,"manuscriptPromotionGateHash":null,"provenance":{"generatedByPaperCore":false,"generatedByNativeCasPreparation":true,"sourceMutation":false,"externalActionPerformed":false},"evidenceRefs":[],"createdAt":created});
    for key in ["channelId", "productLineId", "workflowId"] {
        if let Some(v) = request.preflight.paper_task.get(key) {
            package
                .as_object_mut()
                .ok_or_else(cas_local_submission_contract)?
                .insert(key.to_owned(), v.clone());
        }
    }
    let hash = local_submission_paper_hash("PaperArtifactPackage", &package)
        .map_err(|_| cas_local_submission_contract())?;
    let semantic = workflow::local_submission_semantic_hash("PaperArtifactPackage", &package)
        .map_err(|_| cas_local_submission_contract())?;
    let object = package
        .as_object_mut()
        .ok_or_else(cas_local_submission_contract)?;
    object.insert("artifactPackageHash".into(), json!(hash));
    object.insert("semanticIdentityVersion".into(), json!(2));
    object.insert("semanticIdentityHash".into(), json!(semantic));
    let lifecycle = lifecycle::local_submission_lifecycle_from_artifact_v1(
        LocalSubmissionLifecycleInputV1 {
            version: 1,
            kind: "NativeLocalSubmissionLifecycleInput".into(),
            preflight: request.preflight.clone(),
            row_blockers: vec![],
            reference_time_millis: request.reference_time_millis,
        },
        &package,
    )
    .map_err(|_| cas_local_submission_contract())?;
    if lifecycle["manifest"]["status"] != "ready_for_adapter"
        || lifecycle["receipt"]["status"] != "dry_run_recorded"
        || lifecycle["safety"]["externalActionPerformed"] != false
    {
        return Err(cas_local_submission_contract());
    }
    let venue_id = request
        .preflight
        .venue
        .as_ref()
        .and_then(|v| v["venue_id"].as_str().or_else(|| v["venueId"].as_str()))
        .or_else(|| request.preflight.paper_task["venueTarget"].as_str())
        .ok_or_else(cas_local_submission_contract)?;
    let prepared = prepare_submission_v1(SubmissionPackageV1 {
        venue_id: venue_id.to_owned(),
        manuscript_artifact: format!("cas:{}", manuscript.digest),
        cover_letter: request.cover_letter,
        supplementary_artifacts: request
            .artifacts
            .iter()
            .filter(|a| a.role != CasLocalSubmissionArtifactRoleV1::Manuscript)
            .map(|a| format!("cas:{}", a.digest))
            .collect(),
        recipient_hint: None,
    })?;
    // Re-read every held store subject after all calculations; stale or corrupt
    // object bytes cannot become an accepted prepared result on this path.
    for (descriptor, bytes) in &observed {
        cas_local_submission_check_cancelled(cancelled)?;
        if objects
            .read(&descriptor.digest)
            .map_err(|_| cas_local_submission_contract())?
            != *bytes
        {
            return Err(cas_local_submission_contract());
        }
    }
    cas_local_submission_check_cancelled(cancelled)?;
    let result = json!({"version":1,"kind":"NativeCasLocalSubmissionPreparation","artifactPackage":package,"preparedSubmission":prepared,"lifecycle":lifecycle,"casInputs":observed.iter().map(|(d,b)|json!({"digest":d.digest,"bytes":b.len(),"role":d.role,"filename":d.filename})).collect::<Vec<_>>(),"localArtifactPreparationReady":true,"externalActionAuthorized":false,"externalActionPerformed":false});
    let encoded = serde_json::to_vec(&result).map_err(|_| NativeBusinessError::Encoding)?;
    if encoded.len() > crate::native_business::MAX_TOTAL_TEXT_BYTES {
        return Err(NativeBusinessError::OutputLimit);
    }
    Ok(NativeBusinessOutputV1 {
        artifacts: vec![encoded],
        evidence: json!({"kind":"native_cas_local_submission_preparation_v1","actualCasInputCount":observed.len(),"actualCasInputBytes":total,"artifactPackageHash":hash,"manifestHash":result["lifecycle"]["manifest"]["manifestHash"],"externalActionAuthorized":false,"externalActionPerformed":false,"normalSubmissionRouteAccepted":false}),
    })
}
