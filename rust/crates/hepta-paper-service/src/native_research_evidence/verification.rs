//! Actual artifact integrity; no academic or external authority is inferred.
use super::*;
#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct NativeEvidenceArtifactVerificationRequestV1 {
    pub version: u16,
    pub source_root: Option<PathBuf>,
    pub evidence_items: Vec<Value>,
    pub expected_source_snapshot_hash: Option<Value>,
}
pub struct NativeEvidenceArtifactVerificationObservationV1<'a> {
    source: Option<SourceObservation<'a>>,
    receipts: Vec<Value>,
    cancelled: &'a AtomicBool,
    deadline: Instant,
}
impl NativeEvidenceArtifactVerificationObservationV1<'_> {
    pub fn receipts(&self) -> &[Value] {
        &self.receipts
    }
    pub fn verify_unchanged(&self) -> Result<(), String> {
        check(self.cancelled)?;
        if Instant::now() >= self.deadline {
            return Err("native_research_evidence_expired".into());
        }
        if let Some(source) = &self.source {
            source.assert_current()?;
        }
        Ok(())
    }
}
pub fn verify_native_evidence_artifacts_v1<'a>(
    request: NativeEvidenceArtifactVerificationRequestV1,
    c: &'a AtomicBool,
    deadline: Instant,
) -> Result<NativeEvidenceArtifactVerificationObservationV1<'a>, String> {
    let mut context = NativeResearchReadContextV1::new(c, deadline);
    verify_with_context(&request, &mut context, &mut || {
        let millis = crate::sqlite_mutation_coordinator::clock::MutationClockV1::now_millis(
            &mut crate::sqlite_mutation_coordinator::clock::SystemMutationClockV1,
        )
        .map_err(|_| refused())?;
        crate::sqlite_mutation_coordinator::clock::iso(millis).map_err(|_| refused())
    })
}
pub(super) fn verify_with_context<'a>(
    request: &NativeEvidenceArtifactVerificationRequestV1,
    context: &mut NativeResearchReadContextV1<'a>,
    clock: &mut impl FnMut() -> Result<String, String>,
) -> Result<NativeEvidenceArtifactVerificationObservationV1<'a>, String> {
    context.require_active()?;
    let result = inspect(request, context, clock);
    context.finish(result)
}
fn inspect<'a>(
    request: &NativeEvidenceArtifactVerificationRequestV1,
    context: &mut NativeResearchReadContextV1<'a>,
    clock: &mut impl FnMut() -> Result<String, String>,
) -> Result<NativeEvidenceArtifactVerificationObservationV1<'a>, String> {
    if request.version != 1
        || request.evidence_items.len() > 128
        || request
            .expected_source_snapshot_hash
            .as_ref()
            .is_some_and(|v| !matches!(v, Value::Null | Value::String(_)))
    {
        return Err(refused());
    }
    values_budget(
        request
            .evidence_items
            .iter()
            .chain(request.expected_source_snapshot_hash.iter()),
    )?;
    let mut source = if let Some(root) = &request.source_root {
        if !root.is_absolute() || root.as_os_str().len() > 4096 {
            return Err(refused());
        }
        let held =
            SourceObservation::new_with_deadline(root, context.cancelled(), context.deadline())?;
        if held.root() != root {
            return Err(refused());
        }
        Some(held)
    } else {
        None
    };
    let mut receipts = Vec::new();
    for evidence in &request.evidence_items {
        context.require_active()?;
        if !evidence.is_object() {
            return Err(refused());
        }
        // The shared borrowed request budget has already admitted this value.
        // Reuse the reader's JSON boundary before copying any caller field into
        // a receipt: Node parses all numeric payloads as ECMAScript Number.
        let normalized_evidence = json_boundary(evidence);
        let evidence = &normalized_evidence;
        context.require_active()?;
        let mut blockers = Vec::new();
        let (verified_hash, read_hash) = if let Some(source) = source.as_mut() {
            let path = if truthy(&evidence["path"]) {
                evidence["path"].as_str().ok_or_else(refused)?
            } else {
                ""
            };
            if path.len() > 4096 || path.contains('\\') || path.contains('\0') {
                return Err(refused());
            }
            let absolute = crate::native_workspace::resolve_native_workspace_root_v1(
                source.root(),
                Path::new(path),
                None,
            )?;
            let relative = scope(source.root(), &absolute)?;
            if let Some(metadata) = source.inventory_probe(&relative)? {
                if metadata.directory || metadata.link_count != 1 || metadata.size > 1024 * 1024 {
                    return Err(refused());
                }
                let observed = record(
                    source,
                    &relative,
                    Path::new(""),
                    "artifact",
                    request.source_root.as_deref().ok_or_else(refused)?,
                    context,
                )?;
                (
                    observed["hash"].clone(),
                    observed["scopedFileReadReceiptHash"].clone(),
                )
            } else {
                blockers.extend([
                    "evidence_path_outside_or_unsafe_source_root",
                    "scoped_path_missing_or_unreadable",
                ]);
                let identity = json!({"version":1,"kind":"ScopedFileIdentity","status":"scoped_file_identity_blocked","scopeRoot":source.root(),"path":absolute,"rootRealPath":source.root(),"realPath":null,"identity":null,"symlinkComponents":[],"blockers":["scoped_path_missing_or_unreadable"]});
                let identity_hash = hash("ScopedFileIdentity", &identity)?;
                let read = json!({"version":1,"kind":"ScopedFileReadReceipt","status":"scoped_file_read_blocked","beforeIdentityHash":identity_hash,"afterIdentityHash":identity_hash,"bytes":null,"hash":null,"blockers":["scoped_path_missing_or_unreadable"]});
                (Value::Null, json!(hash("ScopedFileReadReceipt", &read)?))
            }
        } else {
            blockers.push("evidence_path_outside_or_unsafe_source_root");
            (Value::Null, Value::Null)
        };
        if truthy(&evidence["hash"]) && verified_hash != evidence["hash"] {
            blockers.push("evidence_artifact_hash_mismatch");
        }
        if !truthy(&evidence["provenance"]) {
            blockers.push("evidence_provenance_missing");
        }
        if request
            .expected_source_snapshot_hash
            .as_ref()
            .is_some_and(truthy)
            && request.expected_source_snapshot_hash.as_ref()
                != Some(&evidence["sourceSnapshotHash"])
        {
            blockers.push("evidence_source_snapshot_mismatch");
        }
        if truthy(&evidence["authorityAttestation"]) {
            blockers.push("evidence_authority_verifier_missing");
        }
        let created_at = clock()?;
        let value = |key: &str| {
            if truthy(&evidence[key]) {
                &evidence[key]
            } else {
                &Value::Null
            }
        };
        let created_at = json!(created_at);
        projected_budget(
            receipts.iter().chain([
                value("id"),
                value("path"),
                value("hash"),
                value("sourceSnapshotHash"),
                value("provenance"),
                &verified_hash,
                &read_hash,
                &created_at,
            ]),
            32,
            1024,
        )?;
        let mut receipt = json!({"version":1,"kind":"EvidenceArtifactVerificationReceipt","evidenceId":value("id"),"path":value("path"),"expectedHash":value("hash"),"verifiedHash":verified_hash,"scopedFileReadReceiptHash":read_hash,"sourceSnapshotHash":value("sourceSnapshotHash"),"provenance":value("provenance"),"authorityReceiptHash":null,"status":if blockers.is_empty(){"evidence_artifact_verified"}else{"evidence_artifact_blocked"},"blockers":blockers,"createdAt":created_at,"externalActionPerformed":false});
        receipt["provenanceReceiptHash"] =
            json!(hash("EvidenceArtifactVerificationReceipt", &receipt)?);
        receipts.push(receipt);
    }
    if let Some(source) = &source {
        source.assert_current()?;
    }
    context.require_active()?;
    Ok(NativeEvidenceArtifactVerificationObservationV1 {
        source,
        receipts,
        cancelled: context.cancelled(),
        deadline: context.deadline(),
    })
}
