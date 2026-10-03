//! Original target-scope calculation over the actual held inventory's tasks.
use super::*;
fn hash(kind: &str, value: &Value) -> Result<String, String> {
    hepta_legacy_compatibility::production_hash_record_v1(kind, value)
        .map(|h| h.as_str().to_owned())
        .map_err(|e| e.to_string())
}
fn unique(values: impl Iterator<Item = String>) -> Vec<String> {
    let mut out = values
        .map(|s| crate::automation_runtime_reconciliation::sqlite_number::trim(&s).to_owned())
        .filter(|s| !s.is_empty())
        .collect::<Vec<_>>();
    out.sort_by(|a, b| a.encode_utf16().cmp(b.encode_utf16()));
    out.dedup();
    out
}
pub(super) fn build(options: &NativeBatchCliOptionsV1, scan: &Value) -> Result<Value, String> {
    let rows = scan["rows"]
        .as_array()
        .ok_or("native_batch_operator_inventory_shape_invalid")?;
    let requested = unique(options.paper_ids.iter().cloned());
    let selected = unique(
        rows.iter()
            .filter_map(|r| r["task"]["paperId"].as_str().map(str::to_owned)),
    );
    let mut bindings=rows.iter().map(|r|json!({"paperId":r["task"]["paperId"],"taskHash":r["task"]["taskHash"],"paperQualityProfile":r["task"]["paperQualityProfile"]})).collect::<Vec<_>>();
    let collation =
        hepta_legacy_compatibility::ProductionCollationV1::load().map_err(|e| e.to_string())?;
    bindings.sort_by(|a, b| {
        collation.compare(
            a["paperId"].as_str().unwrap_or("null"),
            b["paperId"].as_str().unwrap_or("null"),
        )
    });
    let missing = requested
        .iter()
        .filter(|id| !selected.contains(id))
        .cloned()
        .collect::<Vec<_>>();
    let mut blockers = Vec::new();
    if selected.is_empty() {
        blockers.push("target_scope_empty".to_owned());
    }
    blockers.extend(
        missing
            .iter()
            .map(|id| format!("target_scope_requested_paper_missing:{id}")),
    );
    if options.execute && requested.is_empty() {
        blockers.push("target_scope_explicit_paper_ids_required".to_owned());
    }
    if options.execute
        && let Some(fallback) = scan["inventoryFallback"].as_str().filter(|s| !s.is_empty())
    {
        blockers.push(format!(
            "target_scope_inventory_fallback_forbidden:{fallback}"
        ));
    }
    if options.limit.is_some_and(|n| n == selected.len() as u64) && requested.is_empty() {
        blockers.push("target_scope_limit_truncation_requires_explicit_ids".to_owned());
    }
    let subject = json!({"mode":if options.mode.is_empty(){Value::Null}else{json!(options.mode)},"requestedPaperIds":requested,"selectedPaperIds":selected,"inventorySource":scan["inventorySource"],"inventoryFallback":scan["inventoryFallback"],"selectedTaskBindings":bindings});
    let target_hash = hash("TargetScopeSubject", &subject)?;
    let mut payload = subject;
    let object = payload
        .as_object_mut()
        .ok_or("native_batch_operator_target_shape_invalid")?;
    object.extend([
        ("version".into(), json!(1)),
        ("kind".into(), json!("TargetScopeReceipt")),
        (
            "status".into(),
            json!(if blockers.is_empty() {
                "target_scope_verified"
            } else {
                "target_scope_blocked"
            }),
        ),
        ("execute".into(), json!(options.execute)),
        ("targetPaperCount".into(), json!(selected.len())),
        ("targetScopeHash".into(), json!(target_hash)),
        ("missingRequestedPaperIds".into(), json!(missing)),
        ("blockers".into(), json!(blockers)),
        ("externalActionPerformed".into(), json!(false)),
    ]);
    payload["targetScopeReceiptHash"] = json!(hash("TargetScopeReceipt", &payload)?);
    Ok(payload)
}
