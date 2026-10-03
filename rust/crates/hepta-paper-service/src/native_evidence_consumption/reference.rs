use super::*;
use crate::journal_connector_coverage::qualification::canonical_instant_millis;
pub(super) fn created(reference: &Value) -> Result<Option<i64>, String> {
    let value = first(reference, &["createdAt", "created_at"]);
    if !truthy(value) {
        return Ok(None);
    }
    let value = value.as_str().ok_or_else(refused)?;
    canonical_instant_millis(value)
        .map(Some)
        .ok_or_else(refused)
}
pub(super) fn validity(
    reference: &Value,
    expected: &Value,
    now: &Value,
    age: &Value,
    w: &mut Work<'_>,
) -> Result<Value, String> {
    let mut blockers = Vec::new();
    let mut warnings = Vec::new();
    if !reference.is_object() {
        w.blocker(&mut blockers, "evidence_reference_missing")?;
    }
    let kind = first(reference, &["kind"]);
    let status = first(reference, &["status"]);
    let hash = first(
        reference,
        &[
            "hash",
            "receiptHash",
            "receipt_sha256",
            "provenanceReceiptHash",
        ],
    );
    for (key, actual, blocker) in [
        ("kind", kind, "evidence_kind_mismatch"),
        ("hash", hash, "evidence_hash_mismatch"),
        (
            "inputHash",
            first(reference, &["inputHash", "input_hash"]),
            "evidence_input_hash_mismatch",
        ),
        (
            "sourceRevision",
            first(reference, &["sourceRevision", "source_revision"]),
            "evidence_source_revision_mismatch",
        ),
        (
            "lineageId",
            first(reference, &["lineageId", "lineage_id"]),
            "evidence_lineage_mismatch",
        ),
        (
            "environment",
            first(reference, &["environment"]),
            "evidence_environment_mismatch",
        ),
        (
            "releaseCommit",
            first(reference, &["releaseCommit", "release_commit"]),
            "evidence_release_commit_mismatch",
        ),
    ] {
        w.check()?;
        let wanted = &expected[key];
        if truthy(wanted) && !strict(actual, wanted) {
            w.blocker(&mut blockers, blocker)?;
        }
        // The original status check occurs directly after the kind check.
        if key == "kind"
            && let Some(a) = expected["acceptedStatuses"].as_array()
            && !a.is_empty()
            && !a.iter().any(|v| strict(v, status))
        {
            w.blocker(&mut blockers, "evidence_status_not_accepted")?;
        }
    }
    if !truthy(hash) {
        w.blocker(&mut blockers, "evidence_hash_missing")?;
    }
    let time = if now.is_null() || now == "" {
        f64::NAN
    } else {
        number(now).map_err(|_| refused())?
    };
    if !time.is_finite() {
        w.blocker(&mut blockers, "evidence_reference_time_required")?;
    }
    if let Some(created) = created(reference)? {
        if time.is_finite() {
            if created as f64 - time > 300000.0 {
                w.blocker(&mut blockers, "evidence_future_dated")?;
            }
            if !age.is_null() {
                let limit = number(age).map_err(|_| refused())?;
                let limit = if limit.is_nan() {
                    f64::NAN
                } else {
                    limit.max(0.0)
                };
                if time - created as f64 > limit {
                    w.blocker(&mut blockers, "evidence_ttl_expired")?;
                }
            }
        }
    } else {
        w.blocker(&mut warnings, "evidence_created_at_missing_or_invalid")?;
    }
    w.reserve(16, 512)?;
    projected([w.input, kind, status, hash], w.items, w.bytes).map_err(|_| refused())?;
    hashed(
        "EvidenceReferenceValidityReport",
        json!({"version":1,"kind":"EvidenceReferenceValidityReport","status":if blockers.is_empty(){"evidence_reference_valid"}else{"evidence_reference_invalid"},"evidenceKind":kind,"evidenceStatus":status,"evidenceHash":hash,"blockers":blockers,"warnings":warnings,"ttlApplied":!age.is_null()}),
        w,
        "evidenceReferenceValidityHash",
    )
}
