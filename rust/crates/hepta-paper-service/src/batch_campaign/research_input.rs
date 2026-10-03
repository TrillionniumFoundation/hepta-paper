use super::*;

fn evidence(values: &Value) -> Result<Value, String> {
    let mut out = Vec::new();
    for item in values.as_array().into_iter().flatten() {
        if !item.is_object() {
            return Err(refusal());
        }
        let reference = optional(&item["ref"]).or_else(|| optional(&item["path"]));
        let path = optional(&item["path"]);
        if reference.is_none() && path.is_none() {
            continue;
        }
        let role = optional(&item["role"]);
        let authority = format!(
            "{}:{}:{}",
            role.unwrap_or_default(),
            reference.unwrap_or_default(),
            path.unwrap_or_default()
        )
        .to_lowercase();
        if [
            "workflow-authority",
            "workflow_authority",
            "receipt-ledger",
            "receipt_ledger",
            "paperbatchcampaign",
        ]
        .iter()
        .any(|s| authority.contains(s))
        {
            continue;
        }
        let size = match &item["sizeBytes"] {
            Value::Null => Some(0.0),
            Value::Bool(v) => Some(f64::from(u8::from(*v))),
            Value::Number(v) => v.as_f64(),
            Value::String(v) => {
                crate::automation_runtime_reconciliation::sqlite_number::string_number(v)
            }
            _ => None,
        }
        .filter(|n| n.is_finite());
        let size = if !item
            .as_object()
            .is_some_and(|o| o.contains_key("sizeBytes"))
        {
            Value::Null
        } else {
            match size {
                Some(n) => {
                    serde_json::from_str(ryu_js::Buffer::new().format(n)).map_err(|_| refusal())?
                }
                None => Value::Null,
            }
        };
        out.push(json!({"ref":reference,"path":path,"role":role,"hash":optional(&item["hash"]),"sizeBytes":size}));
    }
    let key = |v: &Value| {
        format!(
            "{}:{}:{}",
            v["ref"].as_str().unwrap_or_default(),
            v["path"].as_str().unwrap_or_default(),
            v["hash"].as_str().unwrap_or_default()
        )
    };
    let collation =
        hepta_legacy_compatibility::ProductionCollationV1::load().map_err(|_| refusal())?;
    out.sort_by(|left, right| collation.compare(&key(left), &key(right)));
    Ok(json!(out))
}
pub(super) fn build(
    input: &NativeBatchCampaignCommandInputV1,
    profiles: &[String],
) -> Result<Value, String> {
    let task = &input.paper_task;
    if optional(&task["taskKey"]).is_none() {
        return Err("campaign_research_paper_task_identity_required".into());
    }
    let mut stable = serde_json::Map::new();
    for field in [
        "version",
        "channelId",
        "productLineId",
        "workflowId",
        "status",
        "venueTarget",
        "paperType",
        "canonicalDir",
        "sourceWorkspace",
        "mainTex",
        "semanticIdentityVersion",
    ] {
        stable.insert(
            field.into(),
            if task[field].is_null()
                || task[field] == false
                || task[field] == ""
                || task[field] == 0
            {
                Value::Null
            } else {
                task[field].clone()
            },
        );
    }
    for field in ["paperId", "taskKey", "semanticIdentityHash"] {
        stable.insert(field.into(), task[field].clone());
    }
    stable.insert("kind".into(), json!("PaperTask"));
    stable.insert(
        "title".into(),
        optional(&task["title"]).map_or_else(|| task["paperId"].clone(), |v| json!(v)),
    );
    stable.insert("paperQualityProfile".into(), json!(profiles.first()));
    stable.insert("paperQualityProfiles".into(), json!(profiles));
    stable.insert("evidenceRefs".into(), evidence(&task["evidenceRefs"])?);
    let state_evidence = match input.paper_state.as_ref() {
        Some(state) if state["evidenceRefs"].is_array() => &state["evidenceRefs"],
        _ => &task["evidenceRefs"],
    };
    let mut result = json!({"version":1,"kind":"CampaignResearchVerificationInput","paperId":task["paperId"],"paperSemanticIdentityHash":task["semanticIdentityHash"],"paperTask":stable,"state":{"evidenceRefs":evidence(state_evidence)?}});
    let h = hash("CampaignResearchVerificationInput", &result)?;
    result["campaignResearchVerificationInputHash"] = json!(h);
    Ok(result)
}
