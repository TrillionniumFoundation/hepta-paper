//! Actual non-authorizing claim graph and optimistic record transitions.
use crate::automation_runtime_reconciliation::sqlite_number::{string_number, trim};
use crate::native_business::local_submission_preflight::{
    local_submission_truthy as truthy, local_submission_values_budget_v1,
};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::{
    collections::{BTreeMap, BTreeSet},
    sync::atomic::{AtomicBool, Ordering},
};
use unicode_normalization::UnicodeNormalization;

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct NativeResearchClaimRegistryRequestV1 {
    pub version: u16,
    pub paper_task: Value,
    pub claims: Vec<Value>,
}
fn refused() -> String {
    "native_research_claim_registry_data_domain_v1_refused".into()
}
fn check(c: &AtomicBool) -> Result<(), String> {
    if c.load(Ordering::SeqCst) {
        Err("native_research_claim_registry_cancelled".into())
    } else {
        Ok(())
    }
}
fn or<'a>(v: &'a Value, names: &[&str]) -> &'a Value {
    names
        .iter()
        .map(|k| &v[*k])
        .find(|v| truthy(v))
        .unwrap_or(&Value::Null)
}
fn raw_string(v: &Value) -> Result<String, String> {
    fn custom(v: &Value) -> bool {
        match v {
            Value::Object(o) => o.contains_key("toString") || o.contains_key("valueOf"),
            Value::Array(a) => a.iter().any(custom),
            _ => false,
        }
    }
    if custom(v) {
        Err(refused())
    } else {
        Ok(crate::release_state::javascript_string(v))
    }
}
fn json_boundary(v: &Value) -> Value {
    match v {
        Value::Number(n) => crate::release_state::javascript_json_number(n),
        Value::Array(a) => Value::Array(a.iter().map(json_boundary).collect()),
        Value::Object(o) => Value::Object(
            o.iter()
                .map(|(k, v)| (k.clone(), json_boundary(v)))
                .collect(),
        ),
        _ => v.clone(),
    }
}
fn nullable(v: &Value) -> Value {
    if truthy(v) {
        json_boundary(v)
    } else {
        Value::Null
    }
}
fn hash(kind: &str, v: &Value) -> Result<String, String> {
    hepta_legacy_compatibility::production_hash_record_v1(kind, v)
        .map(|h| h.as_str().to_owned())
        .map_err(|_| refused())
}
fn number(v: &Value) -> Result<f64, String> {
    Ok(match v {
        Value::Null => 0.0,
        Value::Bool(b) => {
            if *b {
                1.0
            } else {
                0.0
            }
        }
        Value::Number(n) => n.as_f64().unwrap_or(f64::NAN),
        Value::String(s) => string_number(s).unwrap_or(f64::NAN),
        Value::Array(_) => string_number(&raw_string(v)?).unwrap_or(f64::NAN),
        Value::Object(_) => f64::NAN,
    })
}
fn number_value(n: f64) -> Value {
    serde_json::Number::from_f64(if n == 0.0 { 0.0 } else { n })
        .as_ref()
        .map(crate::release_state::javascript_json_number)
        .unwrap_or(Value::Null)
}
fn safe_integer(v: &Value) -> Value {
    if v.is_number()
        && v.as_f64().is_some_and(|n| {
            n.is_finite() && n.fract() == 0.0 && n.abs() <= 9_007_199_254_740_991.0
        })
    {
        json_boundary(v)
    } else {
        Value::Null
    }
}
fn sorted_strings(v: &Value) -> Result<Vec<String>, String> {
    let mut out = match v.as_array() {
        Some(a) => a.iter().map(raw_string).collect::<Result<Vec<_>, _>>()?,
        None => Vec::new(),
    };
    out.sort_by(|a, b| a.encode_utf16().cmp(b.encode_utf16()));
    Ok(out)
}
fn sha(v: &Value) -> Result<bool, String> {
    let empty = Value::String(String::new());
    let text = raw_string(if truthy(v) { v } else { &empty })?;
    Ok(text.len() == 71
        && text
            .get(..7)
            .is_some_and(|v| v.eq_ignore_ascii_case("sha256:"))
        && text.as_bytes()[7..].iter().all(u8::is_ascii_hexdigit))
}
fn manuscript_hash(id: &str, text: &str, locator: &Value) -> Result<String, String> {
    let mut normalized = String::new();
    for ch in text.nfkc() {
        if normalized.len() + ch.len_utf8() > 64 * 1024 {
            return Err(refused());
        }
        normalized.push(ch);
    }
    let collapsed = normalized
        .split(|c: char| {
            let mut bytes = [0u8; 4];
            trim(c.encode_utf8(&mut bytes)).is_empty()
        })
        .filter(|s| !s.is_empty())
        .collect::<Vec<_>>()
        .join(" ");
    hash(
        "ManuscriptClaimIdentity",
        &json!({"version":1,"claimId":trim(id),"text":collapsed,"sourceLocator":if truthy(locator){json!(trim(&raw_string(locator)?))}else{Value::Null}}),
    )
}
fn cycle(records: &[Value], c: &AtomicBool) -> Result<Option<Vec<String>>, String> {
    fn visit(
        id: &str,
        by: &BTreeMap<&str, &Value>,
        visiting: &mut BTreeSet<String>,
        visited: &mut BTreeSet<String>,
        stack: &mut Vec<String>,
        c: &AtomicBool,
    ) -> Result<Option<Vec<String>>, String> {
        check(c)?;
        if visiting.contains(id) {
            let mut out = stack.clone();
            out.push(id.into());
            return Ok(Some(out));
        }
        if visited.contains(id) {
            return Ok(None);
        }
        visiting.insert(id.into());
        stack.push(id.into());
        if let Some(v) = by.get(id) {
            for d in v["dependencyIds"].as_array().ok_or_else(refused)? {
                if let Some(found) = visit(
                    d.as_str().ok_or_else(refused)?,
                    by,
                    visiting,
                    visited,
                    stack,
                    c,
                )? {
                    return Ok(Some(found));
                }
            }
        }
        stack.pop();
        visiting.remove(id);
        visited.insert(id.into());
        Ok(None)
    }
    let by = records
        .iter()
        .map(|v| Ok((v["claimId"].as_str().ok_or_else(refused)?, v)))
        .collect::<Result<BTreeMap<_, _>, String>>()?;
    let mut visiting = BTreeSet::new();
    let mut visited = BTreeSet::new();
    let mut stack = Vec::new();
    // Map order follows actual first occurrence in the source records, not the
    // sorted lookup map. Original DFS produces an ordered full cycle witness.
    for v in records {
        if let Some(found) = visit(
            v["claimId"].as_str().ok_or_else(refused)?,
            &by,
            &mut visiting,
            &mut visited,
            &mut stack,
            c,
        )? {
            return Ok(Some(found));
        }
    }
    Ok(None)
}
/// These original policy records are not trusted scientific or external authority.
pub fn build_native_research_claim_registry_v1(
    request: NativeResearchClaimRegistryRequestV1,
    c: &AtomicBool,
) -> Result<Value, String> {
    check(c)?;
    if request.version != 1
        || request.claims.len() > 256
        || request.claims.iter().any(Value::is_null)
    {
        return Err(refused());
    }
    local_submission_values_budget_v1(
        std::iter::once(&request.paper_task).chain(request.claims.iter()),
    )?;
    let mut records = Vec::new();
    for (i, v) in request.claims.iter().enumerate() {
        check(c)?;
        let id = or(v, &["id", "claimId"]);
        let id = if id.is_null() {
            format!("claim-{}", i + 1)
        } else {
            raw_string(id)?
        };
        if id.len() > 256 {
            return Err(refused());
        }
        let text = or(v, &["text", "summary"]);
        let text = if text.is_null() {
            String::new()
        } else {
            raw_string(text)?
        };
        let locator = or(v, &["sourceLocator", "source_locator"]);
        let k = or(v, &["claimKind", "kind"]);
        let k = if k.is_null() {
            json!("research_claim")
        } else {
            json_boundary(k)
        };
        let canonical = k == "empirical_claim"
            && [
                "empiricalClaimUniverseEntryHash",
                "empiricalClaimUniverseHash",
                "manuscriptCorpusHash",
                "manuscriptClaimHash",
            ]
            .iter()
            .map(|key| sha(&v[*key]))
            .collect::<Result<Vec<_>, _>>()?
            .into_iter()
            .all(|b| b);
        let ver = or(v, &["version"]);
        let default_version = json!(1);
        let n = number(if ver.is_null() { &default_version } else { ver })?;
        let n = if n.is_nan() { n } else { n.max(1.0) };
        records.push(json!({"claimId":id,"text":text,"sourceLocator":nullable(locator),"manuscriptClaimHash":if canonical{v["manuscriptClaimHash"].clone()}else{json!(manuscript_hash(&id,&text,locator)?)},"status":if truthy(&v["status"]){json_boundary(&v["status"])}else{json!("candidate")},"version":number_value(n),"dependencyIds":sorted_strings(&v["dependencyIds"])? ,"claimKind":k,"manuscriptPath":nullable(&v["manuscriptPath"]),"manuscriptByteStart":safe_integer(&v["manuscriptByteStart"]),"manuscriptByteEnd":safe_integer(&v["manuscriptByteEnd"]),"manuscriptContentHash":nullable(&v["manuscriptContentHash"]),"manuscriptFileHash":nullable(&v["manuscriptFileHash"]),"empiricalClaimUniverseEntryHash":if canonical{v["empiricalClaimUniverseEntryHash"].clone()}else{Value::Null},"empiricalClaimUniverseHash":if canonical{v["empiricalClaimUniverseHash"].clone()}else{Value::Null},"manuscriptCorpusHash":if canonical{v["manuscriptCorpusHash"].clone()}else{Value::Null},"proposalClaimRecordHash":if canonical{nullable(&v["proposalClaimRecordHash"])}else{Value::Null},"riskClass":if truthy(or(v,&["riskClass","risk_class"])){json_boundary(or(v,&["riskClass","risk_class"]))}else{json!("")},"proofObligations":sorted_strings(or(v,&["proofObligations","proof_obligations"]))?,"verificationPlan":nullable(or(v,&["verificationPlan","verification_plan"])),"negativeResultPolicy":if truthy(or(v,&["negativeResultPolicy","negative_result_policy"])){json_boundary(or(v,&["negativeResultPolicy","negative_result_policy"]))}else{json!("preserve_and_do_not_promote_without_explicit_acceptance")}}));
    }
    let mut blockers = Vec::new();
    if records.is_empty() {
        blockers.push("claim_registry_empty".into());
    }
    let mut ids = BTreeSet::new();
    let mut duplicates = BTreeSet::new();
    for v in &records {
        let id = v["claimId"].as_str().ok_or_else(refused)?;
        if !ids.insert(id.to_owned()) && duplicates.insert(id.to_owned()) {
            blockers.push(format!("duplicate_claim_id:{id}"));
        }
    }
    let mut missing = false;
    for v in &records {
        check(c)?;
        for d in v["dependencyIds"].as_array().ok_or_else(refused)? {
            let dep = d.as_str().ok_or_else(refused)?;
            if !ids.contains(dep) {
                missing = true;
                blockers.push(format!(
                    "missing_claim_dependency:{}:{dep}",
                    v["claimId"].as_str().ok_or_else(refused)?
                ));
            }
        }
    }
    if duplicates.is_empty()
        && !missing
        && let Some(cycle) = cycle(&records, c)?
    {
        blockers.push(format!("claim_dependency_cycle:{}", cycle.join(">")));
    }
    for kind in ["formal_claim", "empirical_claim"] {
        for v in &records {
            if v["claimKind"] == kind
                && (!truthy(&v["manuscriptPath"])
                    || v["manuscriptByteStart"].is_null()
                    || v["manuscriptByteEnd"].is_null()
                    || !truthy(&v["manuscriptContentHash"])
                    || !truthy(&v["manuscriptFileHash"])
                    || (kind == "empirical_claim"
                        && [
                            "empiricalClaimUniverseEntryHash",
                            "empiricalClaimUniverseHash",
                            "manuscriptCorpusHash",
                        ]
                        .iter()
                        .any(|key| !truthy(&v[*key]))))
            {
                blockers.push(format!(
                    "{}_canonical_manuscript_binding_missing:{}",
                    if kind == "formal_claim" {
                        "formal_claim"
                    } else {
                        "empirical_claim"
                    },
                    v["claimId"].as_str().ok_or_else(refused)?
                ));
            }
        }
    }
    let mut record = json!({"version":2,"kind":"ClaimRegistry","paperId":nullable(&request.paper_task["paperId"]),"status":if blockers.is_empty(){"claim_graph_valid"}else{"claim_graph_blocked"},"claims":records,"blockers":blockers});
    record["claimRegistryHash"] = json!(hash("ClaimRegistry", &record)?);
    check(c)?;
    Ok(record)
}
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct NativeResearchClaimTransitionRequestV1 {
    pub version: u16,
    pub paper_task: Value,
    pub claims: Vec<Value>,
    pub claim_id: Value,
    pub to_status: Value,
    pub expected_version: Option<Value>,
}
/// Recompute the prior graph from actual record inputs and its next hash. This
/// record transition is not an independent scientific acceptance or authority.
pub fn transition_native_research_claim_v1(
    request: NativeResearchClaimTransitionRequestV1,
    c: &AtomicBool,
) -> Result<Value, String> {
    if request.version != 1 {
        return Err(refused());
    }
    local_submission_values_budget_v1(
        std::iter::once(&request.paper_task)
            .chain(request.claims.iter())
            .chain(std::iter::once(&request.claim_id))
            .chain(std::iter::once(&request.to_status))
            .chain(request.expected_version.iter()),
    )?;
    let prior = build_native_research_claim_registry_v1(
        NativeResearchClaimRegistryRequestV1 {
            version: 1,
            paper_task: request.paper_task,
            claims: request.claims,
        },
        c,
    )?;
    if prior["status"] != "claim_graph_valid" {
        return Err("Claim graph must be valid before transition".into());
    }
    let id = raw_string(&request.claim_id)?;
    let rows = prior["claims"].as_array().ok_or_else(refused)?;
    let index = rows
        .iter()
        .position(|v| v["claimId"] == id)
        .ok_or_else(|| format!("Unknown claim: {id}"))?;
    let current = &rows[index];
    let default_version = json!(1);
    let current_version = number(if truthy(&current["version"]) {
        &current["version"]
    } else {
        &default_version
    })?;
    if request
        .expected_version
        .as_ref()
        .is_some_and(|v| !v.is_null())
        && number(request.expected_version.as_ref().ok_or_else(refused)?)? != current_version
    {
        return Err("Claim version conflict".into());
    }
    let to = raw_string(&request.to_status)?;
    let from = raw_string(&current["status"])?;
    let valid = match from.as_str() {
        "candidate" => matches!(to.as_str(), "supported" | "rejected" | "superseded"),
        "supported" => to == "superseded",
        _ => false,
    };
    if !valid {
        return Err(format!("Invalid claim transition: {from}->{to}"));
    }
    let mut claims = rows.clone();
    for (i, row) in claims.iter_mut().enumerate() {
        check(c)?;
        row["id"] = row["claimId"].clone();
        if i == index {
            row["status"] = json!(to);
            row["version"] = number_value(current_version + 1.0);
        }
    }
    let mut next = build_native_research_claim_registry_v1(
        NativeResearchClaimRegistryRequestV1 {
            version: 1,
            paper_task: json!({"paperId":prior["paperId"]}),
            claims,
        },
        c,
    )?;
    let mut receipt = json!({"version":1,"kind":"ClaimTransitionReceipt","paperId":prior["paperId"],"claimId":current["claimId"],"fromStatus":current["status"],"toStatus":to,"priorVersion":number_value(current_version),"nextVersion":number_value(current_version+1.0),"priorRegistryHash":prior["claimRegistryHash"],"nextRegistryHash":next["claimRegistryHash"],"status":"claim_transition_recorded"});
    receipt["claimTransitionReceiptHash"] = json!(hash("ClaimTransitionReceipt", &receipt)?);
    next["transitionReceipt"] = receipt;
    check(c)?;
    Ok(next)
}

#[cfg(test)]
mod tests;
