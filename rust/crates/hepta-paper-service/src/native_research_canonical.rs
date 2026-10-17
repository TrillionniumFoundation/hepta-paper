//! Formal claim bindings derived from the actual held manuscript universe.
use crate::{
    native_business::local_submission_preflight::{
        local_submission_projected_values_budget_v1 as projected_budget,
        local_submission_truthy as truthy, local_submission_values_budget_v1 as budget,
    },
    native_research_claims::manuscript_hash,
    native_research_formal::{
        NativeFormalClaimUniverseObservationV1, NativeFormalClaimUniverseRequestV1,
        inspect_native_formal_claim_universe_with_context_v1,
    },
    native_research_manuscript::NativeResearchReadContextV1,
};
use hepta_legacy_compatibility::production_hash_record_v1;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{
    collections::BTreeSet,
    path::{Component, Path, PathBuf},
    sync::atomic::{AtomicBool, Ordering},
    time::Instant,
};
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct NativeCanonicalFormalClaimRegistryRequestV1 {
    pub version: u16,
    pub source_root: PathBuf,
    pub paper_task: Value,
    pub plan: Value,
}
pub struct NativeCanonicalFormalClaimRegistryObservationV1<'a> {
    source: NativeFormalClaimUniverseObservationV1<'a>,
    observed: Value,
}
impl NativeCanonicalFormalClaimRegistryObservationV1<'_> {
    pub fn observed(&self) -> &Value {
        &self.observed
    }
    pub fn verify_unchanged(&self) -> Result<(), String> {
        self.source.verify_unchanged()
    }
}
fn refused() -> String {
    "native_canonical_formal_claim_registry_data_domain_v1_refused".into()
}
fn check(c: &AtomicBool, deadline: Instant) -> Result<(), String> {
    if c.load(Ordering::SeqCst) {
        Err("native_canonical_formal_claim_registry_cancelled".into())
    } else if Instant::now() >= deadline {
        Err("native_canonical_formal_claim_registry_deadline_exceeded".into())
    } else {
        Ok(())
    }
}
fn coercion(v: &Value) -> Result<(), String> {
    match v {
        Value::Object(v) if v.contains_key("toString") || v.contains_key("valueOf") => {
            Err(refused())
        }
        Value::Array(v) => {
            for v in v {
                coercion(v)?;
            }
            Ok(())
        }
        _ => Ok(()),
    }
}
fn text(v: &Value) -> Result<String, String> {
    coercion(v)?;
    Ok(crate::release_state::javascript_string(v))
}
fn coercion_bound(
    value: &Value,
    limit: usize,
    c: &AtomicBool,
    deadline: Instant,
) -> Result<usize, String> {
    check(c, deadline)?;
    let bytes = match value {
        Value::String(text) => text.len(),
        Value::Null => 4,
        Value::Bool(_) => 5,
        Value::Number(_) => 32,
        Value::Object(_) => {
            coercion(value)?;
            15
        }
        Value::Array(values) => {
            let mut bytes = values.len().saturating_sub(1);
            for value in values {
                bytes = bytes
                    .checked_add(coercion_bound(value, limit, c, deadline)?)
                    .filter(|n| *n <= limit)
                    .ok_or_else(refused)?;
            }
            bytes
        }
    };
    if bytes > limit {
        return Err(refused());
    }
    Ok(bytes)
}
fn limited_text(
    value: &Value,
    limit: usize,
    c: &AtomicBool,
    deadline: Instant,
) -> Result<String, String> {
    coercion_bound(value, limit, c, deadline)?;
    text(value)
}
fn trim(v: &str) -> &str {
    v.trim_matches(|c|matches!(c,'\u{0009}'..='\u{000d}'|'\u{0020}'|'\u{00a0}'|'\u{1680}'|'\u{2000}'..='\u{200a}'|'\u{2028}'|'\u{2029}'|'\u{202f}'|'\u{205f}'|'\u{3000}'|'\u{feff}'))
}
fn number(v: &Value) -> Option<usize> {
    let n = v.as_f64()?;
    ((0.0..=9_007_199_254_740_991.0).contains(&n) && n.fract() == 0.0).then_some(n as usize)
}
fn hash(kind: &str, v: &Value) -> Result<String, String> {
    production_hash_record_v1(kind, v)
        .map(|v| v.as_str().to_owned())
        .map_err(|_| refused())
}
fn bytes_hash(v: &[u8]) -> String {
    format!("sha256:{:x}", Sha256::digest(v))
}
fn unique(v: Vec<Value>) -> Vec<Value> {
    let mut seen = BTreeSet::new();
    v.into_iter()
        .filter(|v| seen.insert(v.as_str().unwrap_or_default().to_owned()))
        .collect()
}
fn blocker(
    blockers: &mut Vec<Value>,
    universe: &Value,
    claims: &[Value],
    value: String,
) -> Result<(), String> {
    let value = Value::String(value);
    budget(
        claims
            .iter()
            .chain([universe, &value])
            .chain(blockers.iter()),
    )?;
    blockers.push(value);
    Ok(())
}
pub(crate) fn path(
    root: &Path,
    paper: &Value,
    c: &AtomicBool,
    deadline: Instant,
) -> Result<Option<String>, String> {
    let empty = json!("");
    let main = limited_text(
        if truthy(&paper["mainTex"]) {
            &paper["mainTex"]
        } else {
            &empty
        },
        4096,
        c,
        deadline,
    )?
    .replace('\\', "/");
    let workspace = limited_text(
        if truthy(&paper["sourceWorkspace"]) {
            &paper["sourceWorkspace"]
        } else {
            &empty
        },
        4096,
        c,
        deadline,
    )?
    .replace('\\', "/");
    let workspace = workspace
        .strip_prefix("./")
        .unwrap_or(&workspace)
        .trim_end_matches('/');
    let relative = if !workspace.is_empty() {
        main.strip_prefix(&format!("{workspace}/")).unwrap_or(&main)
    } else {
        &main
    };
    let absolute = if Path::new(&main).is_absolute() {
        PathBuf::from(&main)
    } else {
        root.join(relative)
    };
    let relative = absolute.strip_prefix(root).map_err(|_| refused())?;
    if relative
        .components()
        .any(|v| !matches!(v, Component::Normal(_)))
    {
        return Err(refused());
    }
    let relative = relative.to_str().ok_or_else(refused)?;
    if relative.is_empty() {
        return Ok(None);
    }
    if relative.len() > 4096 || !relative.ends_with(".tex") {
        return Err(refused());
    }
    Ok(Some(relative.into()))
}
/// Non-authorizing bindings and hashes; actual formal execution remains a separate worker obligation.
pub fn inspect_native_canonical_formal_claim_registry_v1<'a>(
    request: NativeCanonicalFormalClaimRegistryRequestV1,
    c: &'a AtomicBool,
    deadline: Instant,
) -> Result<NativeCanonicalFormalClaimRegistryObservationV1<'a>, String> {
    check(c, deadline)?;
    let mut context = NativeResearchReadContextV1::new(c, deadline);
    inspect_native_canonical_formal_claim_registry_with_context_v1(
        &request.source_root,
        &request.paper_task,
        &request.plan,
        request.version,
        &mut context,
    )
}
pub(crate) fn inspect_native_canonical_formal_claim_registry_with_context_v1<'a>(
    source_root: &Path,
    paper_task: &Value,
    plan: &Value,
    version: u16,
    context: &mut NativeResearchReadContextV1<'a>,
) -> Result<NativeCanonicalFormalClaimRegistryObservationV1<'a>, String> {
    context.require_active()?;
    let result = inspect_canonical(source_root, paper_task, plan, version, context);
    context.finish(result)
}
fn inspect_canonical<'a>(
    source_root: &Path,
    paper_task: &Value,
    plan: &Value,
    version: u16,
    context: &mut NativeResearchReadContextV1<'a>,
) -> Result<NativeCanonicalFormalClaimRegistryObservationV1<'a>, String> {
    let c = context.cancelled();
    let deadline = context.deadline();
    check(c, deadline)?;
    if version != 1 || !source_root.is_absolute() || source_root.as_os_str().len() > 4096 {
        return Err(refused());
    }
    budget([paper_task, plan])?;
    let manuscript = path(source_root, paper_task, c, deadline)?;
    let source = inspect_native_formal_claim_universe_with_context_v1(
        NativeFormalClaimUniverseRequestV1 {
            version: 1,
            source_root: source_root.to_owned(),
            manuscript_path: manuscript.clone().unwrap_or_default(),
            maximum_files: 128,
        },
        context,
    )?;
    if manuscript
        .as_deref()
        .map(|path| source.member_bytes_v1(path))
        .transpose()?
        .flatten()
        .is_none()
    {
        return Ok(NativeCanonicalFormalClaimRegistryObservationV1 {
            source,
            observed: json!({"status":"canonical_claim_registry_blocked","manuscriptPath":manuscript,"manuscriptHash":null,"claims":[],"byClaimId":{},"blockers":["canonical_claim_registry_manuscript_unreadable"]}),
        });
    }
    let manuscript = manuscript.ok_or_else(refused)?;
    let workers = plan["workers"]
        .as_array()
        .map(Vec::as_slice)
        .unwrap_or(&[])
        .iter()
        .filter(|v| v["type"] == "formal_verifier_lake")
        .collect::<Vec<_>>();
    let bindings = workers
        .iter()
        .filter_map(|v| v["parameters"]["claimBindings"].as_array())
        .flatten()
        .collect::<Vec<_>>();
    if bindings.len() > 256 {
        return Err(refused());
    }
    let universe = source.observed().clone();
    let theorems = universe["theorems"].as_array().ok_or_else(refused)?;
    let mut blockers = Vec::<Value>::new();
    let mut claims = Vec::<Value>::new();
    let mut ids = BTreeSet::new();
    let mut bound = BTreeSet::new();
    if !workers.is_empty() {
        if bindings.is_empty() {
            blocker(
                &mut blockers,
                &universe,
                &claims,
                "canonical_claim_registry_bindings_missing".into(),
            )?;
        }
        if theorems.is_empty() {
            blocker(
                &mut blockers,
                &universe,
                &claims,
                "formal_claim_universe_theorems_missing".into(),
            )?;
        }
        for value in universe["blockers"].as_array().ok_or_else(refused)? {
            budget(
                claims
                    .iter()
                    .chain([&universe, value])
                    .chain(blockers.iter()),
            )?;
            blocker(
                &mut blockers,
                &universe,
                &claims,
                value.as_str().ok_or_else(refused)?.to_owned(),
            )?;
        }
    }
    for binding in &bindings {
        check(c, deadline)?;
        let empty = json!("");
        let id = trim(&limited_text(
            if truthy(&binding["claimId"]) {
                &binding["claimId"]
            } else {
                &empty
            },
            256,
            c,
            deadline,
        )?)
        .to_owned();
        if id.len() > 256 {
            return Err(refused());
        }
        let locator = &binding["manuscriptSource"];
        let relative = limited_text(
            if truthy(&locator["path"]) {
                &locator["path"]
            } else {
                &empty
            },
            4096,
            c,
            deadline,
        )?
        .replace('\\', "/");
        let start = number(&locator["byteStart"]);
        let end = number(&locator["byteEnd"]);
        let mut errors = Vec::new();
        if id.is_empty() {
            errors.push("canonical_claim_id_missing");
        }
        let read = source.member_bytes_v1(&relative)?;
        if relative.is_empty() || read.is_none() {
            errors.push("canonical_claim_manuscript_path_mismatch");
        }
        if read.is_none() {
            errors.push("canonical_claim_manuscript_file_unreadable");
        }
        let content = read.as_ref().map(|v| v.0).unwrap_or(&[]);
        if start.is_none()
            || end.is_none()
            || end <= start
            || end.is_some_and(|v| v > content.len())
        {
            errors.push("canonical_claim_byte_range_invalid");
        }
        let bytes = if errors.contains(&"canonical_claim_byte_range_invalid") {
            &[][..]
        } else {
            &content[start.ok_or_else(refused)?..end.ok_or_else(refused)?]
        };
        let content_hash = (!bytes.is_empty()).then(|| bytes_hash(bytes));
        if !truthy(&locator["contentHash"])
            || locator["contentHash"].as_str() != content_hash.as_deref()
        {
            errors.push("canonical_claim_content_hash_mismatch");
        }
        let theorem = theorems.iter().find(|v| {
            v["manuscriptPath"] == relative
                && v["manuscriptByteStart"].as_u64().map(|v| v as usize) == start
                && v["manuscriptByteEnd"].as_u64().map(|v| v as usize) == end
        });
        if theorem.is_none_or(|v| v["manuscriptContentHash"].as_str() != content_hash.as_deref()) {
            errors.push("canonical_claim_not_exact_formal_theorem_body");
        } else if theorem
            .and_then(|v| v["theoremId"].as_str())
            .is_some_and(|v| bound.contains(v))
        {
            errors.push("canonical_claim_formal_theorem_duplicate_binding");
        }
        let valid_text = std::str::from_utf8(bytes);
        if valid_text.is_err() || valid_text.is_ok_and(|text| trim(text).is_empty()) {
            errors.push("canonical_claim_utf8_text_invalid");
        }
        let text = valid_text.unwrap_or("");
        if ids.contains(&id) {
            errors.push("canonical_claim_id_duplicate");
        }
        for error in &errors {
            blocker(
                &mut blockers,
                &universe,
                &claims,
                format!("{}:{error}", if id.is_empty() { "missing" } else { &id }),
            )?;
        }
        if !errors.is_empty() {
            continue;
        }
        let theorem = theorem.ok_or_else(refused)?;
        let source_locator = format!(
            "{relative}#bytes={}-{}",
            start.ok_or_else(refused)?,
            end.ok_or_else(refused)?
        );
        let obligations = if truthy(&binding["proofObligations"]) {
            &binding["proofObligations"]
        } else {
            &binding["obligationNames"]
        };
        let obligations = obligations.as_array().map(Vec::as_slice).unwrap_or(&[]);
        let obligation_bytes = obligations.iter().try_fold(0_usize, |bytes, value| {
            bytes
                .checked_add(coercion_bound(value, 64 * 1024, c, deadline)?)
                .ok_or_else(refused)
        })?;
        let reserved_bytes = obligation_bytes
            .checked_add(2 * id.len() + source_locator.len() + 1536)
            .ok_or_else(refused)?;
        // Reuse the same record budget while the source body and proof remain
        // borrowed; string coercion and the claim projection happen afterwards.
        projected_budget(
            claims
                .iter()
                .chain([&universe, &theorem["text"], &theorem["proof"]]),
            64 + obligations.len(),
            reserved_bytes,
        )?;
        let mut obligations = obligations
            .iter()
            .map(|value| limited_text(value, 64 * 1024, c, deadline))
            .collect::<Result<Vec<_>, _>>()?;
        obligations.sort_by(|a, b| a.encode_utf16().cmp(b.encode_utf16()));
        let value = json!({"id":id,"claimId":id,"text":text,"sourceLocator":source_locator,"manuscriptPath":relative,"manuscriptByteStart":start,"manuscriptByteEnd":end,"manuscriptContentHash":content_hash,"manuscriptFileHash":read.as_ref().map(|v|v.1),"manuscriptClaimHash":manuscript_hash(&id,text,&json!(source_locator))?,"formalClaimUniverseEntryHash":theorem["formalClaimUniverseEntryHash"],"formalClaimUniverseHash":universe["formalClaimUniverseHash"],"formalTheoremId":theorem["theoremId"],"formalTheoremEnvironment":theorem["environment"],"formalProof":theorem["proof"],"status":"candidate","kind":"formal_claim","verificationPlan":{"kind":"formal_lake_machine_checked","requiresWorker":true,"requiresEvidence":false,"verifier":"lean-lake-explicit-source-audit-certificate-v3"},"proofObligations":obligations});
        budget(claims.iter().chain([&value, &universe]))?;
        bound.insert(
            theorem["theoremId"]
                .as_str()
                .ok_or_else(refused)?
                .to_owned(),
        );
        ids.insert(id);
        claims.push(value);
    }
    if !workers.is_empty() {
        for theorem in theorems {
            check(c, deadline)?;
            let id = theorem["theoremId"].as_str().ok_or_else(refused)?;
            if !bound.contains(id) {
                blocker(
                    &mut blockers,
                    &universe,
                    &claims,
                    format!("formal_claim_universe_theorem_unbound:{id}"),
                )?;
            }
        }
        if bindings.len() != theorems.len() {
            blocker(
                &mut blockers,
                &universe,
                &claims,
                "formal_claim_universe_binding_count_mismatch".into(),
            )?;
        }
    }
    let blocked = !blockers.is_empty();
    let blockers = unique(blockers);
    let mut identity_bytes = 0_usize;
    for claim in &claims {
        check(c, deadline)?;
        identity_bytes = identity_bytes
            .checked_add(
                [
                    "claimId",
                    "manuscriptClaimHash",
                    "formalClaimUniverseEntryHash",
                ]
                .iter()
                .map(|key| key.len() + claim[*key].as_str().unwrap_or_default().len())
                .sum::<usize>(),
            )
            .ok_or_else(refused)?;
    }
    projected_budget(
        [&universe]
            .into_iter()
            .chain(claims.iter())
            .chain(blockers.iter()),
        32 + 4 * claims.len(),
        1024 + identity_bytes,
    )?;
    let identities=claims.iter().map(|v|json!({"claimId":v["claimId"],"manuscriptClaimHash":v["manuscriptClaimHash"],"formalClaimUniverseEntryHash":v["formalClaimUniverseEntryHash"]})).collect::<Vec<_>>();
    let payload = json!({"version":2,"kind":"CanonicalFormalClaimRegistry","manuscriptPath":manuscript,"manuscriptHash":universe["manuscriptHash"],"formalClaimUniverseHash":universe["formalClaimUniverseHash"],"claimIdentities":identities,"blockers":blockers});
    budget([&payload, &universe].into_iter().chain(claims.iter()))?;
    let registry = hash("CanonicalFormalClaimRegistry", &payload)?;
    check(c, deadline)?;
    let observed = json!({"status":if blocked{"canonical_claim_registry_blocked"}else{"canonical_claim_registry_verified"},"manuscriptPath":manuscript,"manuscriptHash":universe["manuscriptHash"],"formalClaimUniverse":universe,"formalClaimUniverseHash":universe["formalClaimUniverseHash"],"canonicalClaimRegistryHash":registry,"claims":claims,"byClaimId":{},"blockers":blockers});
    budget([&observed])?;
    source.verify_unchanged()?;
    check(c, deadline)?;
    Ok(NativeCanonicalFormalClaimRegistryObservationV1 { source, observed })
}
#[cfg(test)]
mod tests;
