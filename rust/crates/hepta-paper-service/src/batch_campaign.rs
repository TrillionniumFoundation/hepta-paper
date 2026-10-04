//! Build the complete ordinary batch command graph from normalized options and
//! discovered task data. Calculations alone are not inventory observations,
//! execution authority, scientific acceptance, or a durable queue receipt.
use crate::batch_cli::NativeBatchCliOptionsV1;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

mod plan;
mod research_input;

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct NativeBatchCampaignCommandInputV1 {
    pub version: u16,
    pub paper_task: Value,
    pub paper_state: Option<Value>,
    pub source_workspace: String,
    pub options: NativeBatchCliOptionsV1,
    pub target_scope_receipt: Value,
}
fn refusal() -> String {
    "native_batch_campaign_input_domain_v1_refused".into()
}
fn optional(v: &Value) -> Option<&str> {
    v.as_str()
        .map(crate::automation_runtime_reconciliation::sqlite_number::trim)
        .filter(|v| !v.is_empty())
}
fn hash(kind: &str, value: &Value) -> Result<String, String> {
    hepta_legacy_compatibility::production_hash_record_v1(kind, value)
        .map(|h| h.as_str().to_owned())
        .map_err(|_| refusal())
}
fn normalize_profiles(
    values: &[&Value],
    languages: &[String],
    infer: bool,
) -> Result<Vec<String>, String> {
    let mut out = Vec::new();
    let mut stack: Vec<&Value> = values.iter().rev().copied().collect();
    while let Some(v) = stack.pop() {
        if let Value::Array(items) = v {
            stack.extend(items.iter().rev());
            continue;
        }
        if v.is_null() {
            continue;
        }
        let text = v.as_str().ok_or_else(refusal)?;
        for token in text.split([',', '+']) {
            let token = crate::automation_runtime_reconciliation::sqlite_number::trim(token);
            if token.is_empty() {
                continue;
            }
            let canonical = if token == "theorem_or_proof" && languages.iter().any(|v| v == "lean")
            {
                "formal_theorem_or_proof"
            } else {
                token
            };
            if !matches!(
                canonical,
                "theorem_or_proof"
                    | "formal_theorem_or_proof"
                    | "empirical_or_experiment"
                    | "systems_or_artifact"
                    | "survey_or_position"
                    | "external_data_or_human_subjects"
            ) {
                return Err(format!("campaign_paper_quality_profile_unknown:{token}"));
            }
            if !out.iter().any(|v| v == canonical) {
                out.push(canonical.to_owned());
            }
        }
    }
    if infer
        && languages.iter().any(|v| v == "lean")
        && !out.iter().any(|v| v == "formal_theorem_or_proof")
    {
        out.push("formal_theorem_or_proof".into());
    }
    Ok(out)
}
fn canonical_mode(mode: &str) -> Result<&str, String> {
    match mode {
        "inventory" => Err("campaign_inventory_mode_has_no_execution_plan".into()),
        "journal-manage" | "venue-resolve" | "source-adapt" => {
            Err(format!("campaign_mode_executor_not_available:{mode}"))
        }
        "referee-autopilot" => Ok("local-review-loop"),
        "local-build" | "local-package" | "research-verify" | "local-dry-run"
        | "reviewed-submit" | "referee-review" | "referee-revise" | "local-review-loop" => Ok(mode),
        _ => Err(format!("campaign_mode_unknown:{mode}")),
    }
}
fn validate(input: &NativeBatchCampaignCommandInputV1) -> Result<(), String> {
    use crate::native_business::local_submission_preflight::local_submission_value_budget;
    if input.version != 1
        || !input.source_workspace.starts_with('/')
        || input.source_workspace.len() > 64 * 1024
        || input.source_workspace.contains('\0')
        || input.options.languages.len() > 16
        || input.options.max_rounds == 0
        || input.options.max_rounds > 9_007_199_254_740_991
    {
        return Err(refusal());
    }
    local_submission_value_budget(&input.paper_task)?;
    local_submission_value_budget(input.paper_state.as_ref().unwrap_or(&Value::Null))?;
    local_submission_value_budget(&input.target_scope_receipt)?;
    let bytes = serde_json::to_vec(&input.options).map_err(|_| refusal())?;
    if bytes.len() > 1024 * 1024
        || bytes.contains(&0)
        || input.options.dataset_root.is_some()
        || input.options.benchmark_id.is_some()
        || input.options.apply_manuscript
    {
        return Err("native_batch_campaign_empirical_input_domain_v1_not_implemented".into());
    }
    if !optional(&input.paper_task["paperId"]).is_some_and(|id| id.len() <= 256)
        || optional(&input.paper_task["semanticIdentityHash"]).is_none()
    {
        return Err("batch_campaign_command_paper_semantic_identity_required".into());
    }
    if input.target_scope_receipt["status"] != "target_scope_verified"
        || !input.target_scope_receipt["selectedPaperIds"]
            .as_array()
            .is_some_and(|ids| ids.contains(&input.paper_task["paperId"]))
    {
        return Err("batch_campaign_command_target_scope_not_verified".into());
    }
    if input.paper_task["registry"]["inventorySource"] == "proposal_materialization" {
        return Err("native_batch_campaign_proposal_input_domain_v1_not_implemented".into());
    }
    Ok(())
}
/// Produce all command, intent, research-input and graph fields in the bounded
/// native non-empirical v1 domain. Task/scope data remain calculation inputs;
/// only the ordinary inventory caller may claim they were actually observed.
pub fn build_native_batch_campaign_command_v1(
    input: &NativeBatchCampaignCommandInputV1,
) -> Result<Value, String> {
    validate(input)?;
    let options = &input.options;
    let requested = crate::automation_runtime_reconciliation::sqlite_number::trim(&options.mode);
    let effective = canonical_mode(requested)?;
    let paper_id = input.paper_task["paperId"].as_str().ok_or_else(refusal)?;
    let languages: Vec<String> = options
        .languages
        .iter()
        .map(|v| crate::automation_runtime_reconciliation::sqlite_number::trim(v).to_lowercase())
        .filter(|v| !v.is_empty())
        .fold(Vec::new(), |mut a, v| {
            if !a.contains(&v) {
                a.push(v);
            }
            a
        });
    let quality = json!(options.quality_profile);
    let profiles = normalize_profiles(
        &[
            &quality,
            &json!([]),
            &input.paper_task["paperQualityProfile"],
            &input.paper_task["paperQualityProfiles"],
        ],
        &languages,
        false,
    )?;
    let requested_venue = options
        .target_override
        .as_ref()
        .map(|v| crate::automation_runtime_reconciliation::sqlite_number::trim(v))
        .filter(|v| !v.is_empty());
    let venue = requested_venue.or_else(|| optional(&input.paper_task["venueTarget"]));
    let campaign_id = format!("paper-campaign:{paper_id}:batch-{effective}");
    let mut subject = json!({"version":3,"kind":"PaperBatchCampaignCommand","paperId":paper_id,"paperSemanticIdentityHash":input.paper_task["semanticIdentityHash"],"paperQualityProfile":profiles.first(),"paperQualityProfiles":profiles,"languages":languages,"sourceWorkspace":input.source_workspace,"requestedMode":requested,"requestedMaxRounds":options.max_rounds,"requestedVenueTarget":requested_venue,"requestedDatasetRoot":null,"requestedBenchmarkId":null,"requestedApplyManuscript":false,"venueTarget":venue,"effectiveDatasetRoot":null,"effectiveDatasetMounts":[],"scope":{"requestedPaperIds":input.target_scope_receipt["requestedPaperIds"].as_array().cloned().unwrap_or_default(),"selectedPaperIds":input.target_scope_receipt["selectedPaperIds"].as_array().cloned().unwrap_or_default(),"inventorySource":input.target_scope_receipt["inventorySource"],"inventoryFallback":input.target_scope_receipt["inventoryFallback"]}});
    let mut scheduling_subject = subject.clone();
    scheduling_subject["requestedMode"] = json!(effective);
    let command_hash = hash("PaperBatchCampaignCommand", &scheduling_subject)?;
    let command_binding = json!({"version":3,"kind":"PaperBatchCampaignCommandBinding","batchCampaignCommandHash":command_hash,"requestedMode":effective,"paperSemanticIdentityHash":input.paper_task["semanticIdentityHash"],"venueTarget":venue,"effectiveDatasetRoot":null,"requestedBenchmarkId":null,"requestedApplyManuscript":false});
    let plan = plan::build(input, &subject, &campaign_id, effective, command_binding)?;
    let object = subject.as_object_mut().ok_or_else(refusal)?;
    object.insert("effectiveMode".into(), json!(effective));
    object.insert("batchCampaignCommandHash".into(), json!(command_hash));
    object.insert("campaignId".into(), json!(campaign_id));
    object.insert("campaignPlanHash".into(), plan["campaignPlanHash"].clone());
    object.insert("campaignPlan".into(), plan);
    Ok(subject)
}

#[cfg(test)]
mod tests;
