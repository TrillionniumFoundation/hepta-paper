//! Held original evidence observations; this reader confers no evidence authority.
use crate::{
    native_business::local_submission_preflight::{
        local_submission_normalize as normalize,
        local_submission_projected_values_budget_v1 as projected_budget,
        local_submission_truthy as truthy, local_submission_values_budget_v1 as values_budget,
    },
    native_research_canonical::{
        NativeCanonicalFormalClaimRegistryObservationV1,
        inspect_native_canonical_formal_claim_registry_with_context_v1,
    },
    native_research_empirical_assertion::{
        NativeEmpiricalAssertionUniverseObservationV1, NativeEmpiricalAssertionUniverseRequestV1,
        inspect_native_empirical_assertion_universe_with_context_v1,
    },
    native_research_manuscript::NativeResearchReadContextV1,
    runtime_source_cas::observation::SourceObservation,
};
use hepta_legacy_compatibility::{
    ProductionJsonEncodingLimitsV1, ProductionJsonValue, parse_production_json_v1,
    production_hash_record_v1, production_json_resources_v1, production_json_stringify_v1,
};
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value, json};
use std::{
    borrow::Cow,
    path::{Component, Path, PathBuf},
    sync::atomic::{AtomicBool, Ordering},
    time::Instant,
};
#[cfg(test)]
const MAX_BYTES: u64 = 4 * 1024 * 1024;
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct NativeResearchEvidenceRequestV1 {
    pub version: u16,
    pub root: PathBuf,
    pub source_root: Option<PathBuf>,
    pub log_root: Option<PathBuf>,
    pub empirical_root: Option<PathBuf>,
    pub paper_task: Value,
}
pub struct NativeResearchEvidenceObservationV1<'a> {
    source: SourceObservation<'a>,
    runtime: Option<runtime::RuntimeEvidenceSourceV2<'a>>,
    observed: Value,
    canonical: Option<NativeCanonicalFormalClaimRegistryObservationV1<'a>>,
    empirical: Option<NativeEmpiricalAssertionUniverseObservationV1<'a>>,
}
impl NativeResearchEvidenceObservationV1<'_> {
    pub fn observed(&self) -> &Value {
        &self.observed
    }
    pub fn verify_unchanged(&self) -> Result<(), String> {
        self.source.assert_current()?;
        if let Some(runtime) = &self.runtime {
            runtime.verify_unchanged()?;
        }
        if let Some(canonical) = &self.canonical {
            canonical.verify_unchanged()?;
        }
        if let Some(empirical) = &self.empirical {
            empirical.verify_unchanged()?;
        }
        Ok(())
    }
}
fn refused() -> String {
    "native_research_evidence_data_domain_v1_refused".into()
}
fn check(c: &AtomicBool) -> Result<(), String> {
    if c.load(Ordering::SeqCst) {
        Err("native_research_evidence_cancelled".into())
    } else {
        Ok(())
    }
}
fn hash(kind: &str, v: &Value) -> Result<String, String> {
    production_hash_record_v1(kind, v)
        .map(|h| h.as_str().to_owned())
        .map_err(|_| refused())
}
fn choice<'a>(v: &'a Value, keys: &[&str]) -> Option<&'a Value> {
    keys.iter().map(|k| &v[*k]).find(|v| truthy(v))
}
fn chosen<'a>(v: &'a Value, keys: &[&str], default: Value) -> Cow<'a, Value> {
    choice(v, keys).map_or(Cow::Owned(default), Cow::Borrowed)
}
fn assembled(
    out: &Structured,
    fields: Vec<(&str, Cow<'_, Value>)>,
    c: &AtomicBool,
) -> Result<Value, String> {
    check(c)?;
    let names = Value::String(fields.iter().map(|(name, _)| *name).collect());
    out.budget(
        fields
            .iter()
            .map(|(_, value)| value.as_ref())
            .chain([&names, &Value::Null]),
    )?;
    Ok(Value::Object(
        fields
            .into_iter()
            .map(|(name, value)| (name.to_owned(), value.into_owned()))
            .collect(),
    ))
}

fn text(v: &Value) -> Result<String, String> {
    match v {
        Value::Object(v) if v.contains_key("toString") || v.contains_key("valueOf") => {
            return Err(refused());
        }
        Value::Array(v) => {
            for item in v {
                let _ = text(item)?;
            }
        }
        _ => (),
    };
    Ok(crate::release_state::javascript_string(v))
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
        v => v.clone(),
    }
}
fn scope(root: &Path, absolute: &Path) -> Result<PathBuf, String> {
    let relative = absolute.strip_prefix(root).map_err(|_| refused())?;
    if relative
        .components()
        .any(|v| !matches!(v, Component::Normal(_)))
    {
        return Err(refused());
    }
    Ok(relative.into())
}
fn record(
    source: &mut SourceObservation<'_>,
    relative: &Path,
    scoped_root: &Path,
    role: &str,
    display_root: &Path,
    budget: &mut NativeResearchReadContextV1<'_>,
) -> Result<Value, String> {
    let metadata = source.inventory_probe(relative)?.ok_or_else(refused)?;
    if metadata.link_count != 1 {
        return Err(refused());
    }
    let displayed = runtime::display_path(display_root, &source.root().join(relative))?;
    if displayed.contains('\\') || normalize(&displayed) != displayed {
        return Err(refused());
    }
    budget.charge(source, relative)?;
    let (digest, bytes) = source.archive(relative, metadata.size.max(1))?;
    if bytes != metadata.size {
        return Err(refused());
    }
    let absolute = source.root().join(relative);
    let root = if scoped_root.as_os_str().is_empty() {
        source.root().to_path_buf()
    } else {
        source.root().join(scoped_root)
    };
    let mtime_ns =
        i128::from(metadata.mtime_seconds) * 1_000_000_000 + i128::from(metadata.mtime_nanoseconds);
    let identity = json!({"version":1,"kind":"ScopedFileIdentity","status":"scoped_file_identity_verified","scopeRoot":root,"path":absolute,"rootRealPath":root,"realPath":absolute,"identity":{"device":metadata.device.to_string(),"inode":metadata.inode.to_string(),"mode":metadata.mode.to_string(),"size":metadata.size,"mtimeNs":mtime_ns.to_string(),"linkCount":metadata.link_count},"symlinkComponents":[],"blockers":[]});
    let identity_hash = hash("ScopedFileIdentity", &identity)?;
    let read = json!({"version":1,"kind":"ScopedFileReadReceipt","status":"scoped_file_read_verified","beforeIdentityHash":identity_hash,"afterIdentityHash":identity_hash,"bytes":bytes,"hash":digest,"blockers":[]});
    let read_hash = hash("ScopedFileReadReceipt", &read)?;
    let millis = (metadata.mtime_seconds as f64 * 1000.0
        + metadata.mtime_nanoseconds as f64 / 1_000_000.0)
        .trunc();
    Ok(
        json!({"role":format!("{role}_evidence"),"path":displayed,"filename":relative.file_name().and_then(|v|v.to_str()).ok_or_else(refused)?,"sizeBytes":bytes,"mtimeMs":json_boundary(&json!(millis)),"hash":digest,"scopedFileReadReceiptHash":read_hash}),
    )
}
fn ordered(text: &str, tokens: &[&str]) -> bool {
    text.split(['\n', '\r', '\u{2028}', '\u{2029}'])
        .any(|line| {
            let mut tail = line;
            for token in tokens {
                let Some(index) = tail.find(token) else {
                    return false;
                };
                tail = &tail[index + token.len()..];
            }
            true
        })
}
fn evidence_name(name: &str) -> bool {
    let lower = name.to_ascii_lowercase();
    name != "FORMAL_CLAIM_REVIEW.json"
        && name != "RESEARCH_WORKER_PLAN.json"
        && [".md", ".json", ".jsonl", ".csv", ".txt"]
            .iter()
            .any(|x| lower.ends_with(x))
        && [
            "claim",
            "evidence",
            "proof",
            "referee",
            "review",
            "verdict",
            "audit",
            "manifest",
            "readiness",
            "status",
            "formal",
            "lean",
            "empirical",
            "experiment",
            "result",
            "dataset",
            "benchmark",
            "table",
        ]
        .iter()
        .any(|x| lower.contains(x))
}
fn walk(
    source: &mut SourceObservation<'_>,
    relative: &Path,
    depth: usize,
    selected: &mut Vec<PathBuf>,
    c: &AtomicBool,
) -> Result<(), String> {
    check(c)?;
    if depth > 5 || selected.len() >= 2000 {
        return Ok(());
    }
    for entry in source.inventory_entries(relative)? {
        check(c)?;
        if selected.len() >= 2000 {
            break;
        }
        if entry.name.starts_with('.') {
            continue;
        }
        let path = relative.join(&entry.name);
        if entry.directory {
            if ![".git", ".lake", "node_modules", "__pycache__"].contains(&entry.name.as_str()) {
                walk(source, &path, depth + 1, selected, c)?;
            }
        } else if entry.regular && evidence_name(&entry.name) {
            selected.push(path);
        }
    }
    Ok(())
}
fn finite(v: &ProductionJsonValue) -> bool {
    match v {
        ProductionJsonValue::Number(n) => n.is_finite(),
        ProductionJsonValue::Array(a) => a.iter().all(finite),
        ProductionJsonValue::Object(o) => o.iter().all(|(_, v)| finite(v)),
        _ => true,
    }
}
fn read_json(
    source: &mut SourceObservation<'_>,
    path: &Path,
    budget: &mut NativeResearchReadContextV1<'_>,
    c: &AtomicBool,
) -> Result<Value, String> {
    let Some(metadata) = source.inventory_probe(path)? else {
        return Ok(Value::Null);
    };
    if metadata.directory {
        return Ok(Value::Null);
    }
    if metadata.size > 1024 * 1024 {
        return Err(refused());
    }
    budget.charge(source, path)?;
    let bytes = source.inventory_document(path, 1024 * 1024)?;
    parse_record_json_bytes(&bytes, c)
}
fn parse_record_json_bytes(bytes: &[u8], c: &AtomicBool) -> Result<Value, String> {
    if bytes.len() > 1024 * 1024 || std::str::from_utf8(bytes).is_err() {
        return Err(refused());
    }
    let Ok(parsed) = parse_production_json_v1(bytes) else {
        return Ok(Value::Null);
    };
    production_json_resources_v1(
        &parsed,
        ProductionJsonEncodingLimitsV1 {
            maximum_bytes: 1024 * 1024,
            maximum_values: 20_000,
            maximum_utf16_units: 1024 * 1024,
        },
        c,
    )
    .map_err(|_| refused())?;
    if !finite(&parsed) {
        return Err(refused());
    }
    let encoded = production_json_stringify_v1(&parsed).map_err(|_| refused())?;
    let value = serde_json::from_slice::<Value>(&encoded).map_err(|_| refused())?;
    values_budget(std::iter::once(&value))?;
    Ok(json_boundary(&value))
}
fn roles(record: &Value) -> Vec<&'static str> {
    let value = normalize(&format!(
        "{} {}",
        record["path"].as_str().unwrap_or_default(),
        record["filename"].as_str().unwrap_or_default()
    ))
    .to_lowercase();
    let mut out = Vec::new();
    if value.contains("claim") {
        out.push("claim");
    }
    if ["proof", "formal", "lean", "coq", "isabelle", "theorem"]
        .iter()
        .any(|v| value.contains(v))
    {
        out.push("proof");
    }
    if [
        "evidence",
        "matrix",
        "audit",
        "manifest",
        "verdict",
        "status",
        "empirical",
        "experiment",
        "result",
        "dataset",
        "benchmark",
        "table",
    ]
    .iter()
    .any(|v| value.contains(v))
    {
        out.push("evidence");
    }
    if [
        "reproduc",
        "result",
        "seed",
        "checksum",
        "sha256",
        "command",
        "run",
        "experiment",
        "dataset",
        "benchmark",
    ]
    .iter()
    .any(|v| value.contains(v))
    {
        out.push("reproducibility");
    }
    if ["referee", "review", "revision"]
        .iter()
        .any(|v| value.contains(v))
    {
        out.push("referee");
    }
    if out.is_empty() {
        out.push("evidence");
    }
    out
}
#[derive(Default)]
struct Structured {
    claims: Vec<Value>,
    obligations: Vec<Value>,
    evidence: Vec<Value>,
    repro: Vec<Value>,
    experiments: Vec<Value>,
    formal_adapters: Vec<Value>,
    formal_certificates: Vec<Value>,
}
impl Structured {
    fn all(&self) -> impl Iterator<Item = &Value> {
        self.claims
            .iter()
            .chain(self.obligations.iter())
            .chain(self.evidence.iter())
            .chain(self.repro.iter())
            .chain(self.experiments.iter())
            .chain(self.formal_adapters.iter())
            .chain(self.formal_certificates.iter())
    }
    fn budget<'a>(&'a self, extra: impl IntoIterator<Item = &'a Value>) -> Result<(), String> {
        values_budget(self.all().chain(extra))
    }
    fn push(&mut self, which: usize, item: Value, c: &AtomicBool) -> Result<(), String> {
        check(c)?;
        self.budget(std::iter::once(&item))?;
        match which {
            0 => self.claims.push(item),
            1 => self.obligations.push(item),
            2 => self.evidence.push(item),
            3 => self.repro.push(item),
            4 => self.experiments.push(item),
            5 => self.formal_adapters.push(item),
            6 => self.formal_certificates.push(item),
            _ => return Err(refused()),
        };
        Ok(())
    }
    fn value(self) -> Value {
        json!({"claims":self.claims,"obligations":self.obligations,"evidenceItems":self.evidence,"reproducibilityItems":self.repro,"experiments":self.experiments,"formalAdapterReceipts":self.formal_adapters,"formalCertificateRequests":self.formal_certificates,"canonicalClaimRegistry":null,"canonicalEmpiricalClaimRegistry":null,"canonicalEmpiricalAssertionUniverse":null})
    }
}
fn arrays<'a>(v: &'a Value, keys: &[&str]) -> Vec<&'a Value> {
    keys.iter()
        .filter_map(|k| v[*k].as_array())
        .flatten()
        .collect()
}
fn item(record: &Value, role: &str, index: usize) -> Value {
    json!({"id":format!("{role}:{}",index+1),"kind":role,"text":format!("{role} evidence: {}",record["path"].as_str().unwrap_or_default()),"status":"observed","sourceLocator":record["path"],"evidenceRefs":[{"kind":"path","ref":record["path"],"hash":record["hash"]}]})
}
fn experiment_projection(value: &Value, c: &AtomicBool) -> Result<(usize, usize), String> {
    check(c)?;
    let fields = ["experimentId", "resultPath", "resultHash"];
    if let Value::Object(object) = value {
        let added = fields.iter().filter(|key| !object.contains_key(**key));
        let count = added.clone().count();
        if object.len().checked_add(count).is_none_or(|n| n > 128) {
            return Err(refused());
        }
        return Ok((0, added.map(|key| key.len()).sum()));
    }
    let mut nodes = 0;
    let mut key_bytes = fields.iter().map(|key| key.len()).sum::<usize>();
    let count = match value {
        Value::Array(array) => array.len(),
        Value::String(text) => {
            let mut count = 0;
            for ch in text.chars() {
                check(c)?;
                count += 1;
                // The actual object has one decimal property per UTF-16 unit
                // and three named fields; refuse before allocating that map.
                if ch.len_utf16() != 1 || count > 125 {
                    return Err(refused());
                }
            }
            nodes = count;
            count
        }
        Value::Bool(_) | Value::Number(_) => 0,
        Value::Null => return Err(refused()),
        Value::Object(_) => return Err(refused()),
    };
    if count > 125 {
        return Err(refused());
    }
    for index in 0..count {
        check(c)?;
        key_bytes += if index == 0 {
            1
        } else {
            index.ilog10() as usize + 1
        };
    }
    Ok((nodes, key_bytes))
}
fn extract(
    source: &mut SourceObservation<'_>,
    records: &[Value],
    budget: &mut NativeResearchReadContextV1<'_>,
    c: &AtomicBool,
    runtime: &mut Option<runtime::RuntimeEvidenceSourceV2<'_>>,
) -> Result<Structured, String> {
    extract_records(records, c, &mut |path| {
        if let Some(runtime) = runtime.as_mut()
            && let Some(relative) = runtime.member(path)?
        {
            read_json(&mut runtime.source, &relative, budget, c)
        } else {
            read_json(source, path, budget, c)
        }
    })
}
/// Same original record extraction, with bytes selected from a closed CAS map.
/// Paths here are display/member keys; they never cause filesystem access.
pub(crate) fn extract_native_research_record_bytes_v1(
    records: &[Value],
    raw: &std::collections::BTreeMap<String, &[u8]>,
    c: &AtomicBool,
    deadline: Instant,
) -> Result<Value, String> {
    values_budget(records)?;
    if records.len() > 96 || raw.len() > 128 {
        return Err(refused());
    }
    let result = extract_records(records, c, &mut |path| {
        check(c)?;
        if Instant::now() >= deadline {
            return Err(refused());
        }
        let bytes = raw
            .get(path.to_str().ok_or_else(refused)?)
            .ok_or_else(refused)?;
        parse_record_json_bytes(bytes, c)
    })?
    .value();
    check(c)?;
    if Instant::now() >= deadline {
        return Err(refused());
    }
    Ok(result)
}
fn extract_records(
    records: &[Value],
    c: &AtomicBool,
    read: &mut impl FnMut(&Path) -> Result<Value, String>,
) -> Result<Structured, String> {
    let mut out = Structured::default();
    for record in records.iter().take(96) {
        check(c)?;
        let path = Path::new(record["path"].as_str().ok_or_else(refused)?);
        let json = if record["filename"]
            .as_str()
            .is_some_and(|v| v.to_ascii_lowercase().ends_with(".json"))
        {
            read(path)?
        } else {
            Value::Null
        };
        let rs = roles(record);
        let json_claims = arrays(&json, &["claims", "claim_packets", "claims_matrix"]);
        if rs.contains(&"claim") && json_claims.is_empty() {
            out.push(0, item(record, "claim", out.claims.len()), c)?;
        }
        for (role, which) in [("proof", 1), ("evidence", 2), ("reproducibility", 3)] {
            if rs.contains(&role) {
                let n = match which {
                    1 => out.obligations.len(),
                    2 => out.evidence.len(),
                    _ => out.repro.len(),
                };
                out.push(which, item(record, role, n), c)?;
            }
        }
        if !matches!(json, Value::Object(_) | Value::Array(_)) {
            continue;
        }
        for claim in json_claims.into_iter().take(24) {
            if claim.is_null() {
                return Err(refused());
            }
            out.budget(std::iter::once(claim))?;
            let value = assembled(
                &out,
                vec![
                    (
                        "id",
                        chosen(
                            claim,
                            &["claim_id", "id", "key"],
                            json!(format!("json_claim:{}", out.claims.len() + 1)),
                        ),
                    ),
                    (
                        "text",
                        chosen(
                            claim,
                            &["claim_text", "text", "claim", "statement"],
                            json!(format!(
                                "claim from {}",
                                record["path"].as_str().ok_or_else(refused)?
                            )),
                        ),
                    ),
                    (
                        "status",
                        chosen(claim, &["status", "verdict"], json!("observed")),
                    ),
                    (
                        "kind",
                        chosen(claim, &["claim_kind", "claimKind", "kind"], json!("claim")),
                    ),
                    (
                        "riskClass",
                        chosen(claim, &["risk_class", "riskClass"], json!("")),
                    ),
                    (
                        "proofObligations",
                        chosen(claim, &["proof_obligations", "proofObligations"], json!([])),
                    ),
                    (
                        "verificationPlan",
                        chosen(
                            claim,
                            &["verification_plan", "verificationPlan"],
                            Value::Null,
                        ),
                    ),
                    (
                        "negativeResultPolicy",
                        chosen(
                            claim,
                            &["negative_result_policy", "negativeResultPolicy"],
                            Value::Null,
                        ),
                    ),
                    (
                        "sourceLocator",
                        chosen(
                            claim,
                            &["source_locator", "locator"],
                            record["path"].clone(),
                        ),
                    ),
                    (
                        "evidenceRefs",
                        Cow::Owned(
                            json!([{"kind":"path","ref":record["path"],"hash":record["hash"]}]),
                        ),
                    ),
                ],
                c,
            )?;
            out.push(0, value, c)?;
        }
        for v in arrays(&json, &["proof_obligations", "obligations"])
            .into_iter()
            .take(24)
        {
            if v.is_null() {
                return Err(refused());
            }
            out.budget(std::iter::once(v))?;
            let value = assembled(
                &out,
                vec![
                    (
                        "id",
                        chosen(
                            v,
                            &["obligation_id", "id", "key"],
                            json!(format!("json_proof:{}", out.obligations.len() + 1)),
                        ),
                    ),
                    (
                        "text",
                        chosen(
                            v,
                            &["obligation", "text", "statement"],
                            json!(format!(
                                "proof obligation from {}",
                                record["path"].as_str().ok_or_else(refused)?
                            )),
                        ),
                    ),
                    ("status", chosen(v, &["status"], json!("observed"))),
                    ("kind", chosen(v, &["kind"], json!("proof_obligation"))),
                    (
                        "sourceLocator",
                        chosen(v, &["source_locator", "locator"], record["path"].clone()),
                    ),
                    (
                        "evidenceRefs",
                        Cow::Owned(
                            json!([{"kind":"path","ref":record["path"],"hash":record["hash"]}]),
                        ),
                    ),
                ],
                c,
            )?;
            out.push(1, value, c)?;
        }
        for v in arrays(&json, &["evidence", "evidence_items", "candidate_evidence"])
            .into_iter()
            .take(48)
        {
            if v.is_null() {
                return Err(refused());
            }
            out.budget(std::iter::once(v))?;
            let mut fields = vec![
                (
                    "id",
                    chosen(
                        v,
                        &["evidence_id", "id", "path"],
                        json!(format!("json_evidence:{}", out.evidence.len() + 1)),
                    ),
                ),
                (
                    "text",
                    chosen(
                        v,
                        &["text", "summary", "path"],
                        json!(format!(
                            "evidence from {}",
                            record["path"].as_str().ok_or_else(refused)?
                        )),
                    ),
                ),
                (
                    "status",
                    chosen(v, &["status", "verdict"], json!("observed")),
                ),
                ("kind", chosen(v, &["kind"], json!("evidence"))),
                (
                    "claimIds",
                    chosen(
                        v,
                        &["claim_ids", "claimIds"],
                        if truthy(&v["claim_id"]) {
                            json!([v["claim_id"]])
                        } else {
                            json!([])
                        },
                    ),
                ),
                (
                    "requiredOutputs",
                    chosen(v, &["required_outputs", "requiredOutputs"], json!([])),
                ),
                (
                    "availableOutputs",
                    chosen(
                        v,
                        &["available_outputs", "availableOutputs", "outputs"],
                        json!([]),
                    ),
                ),
                (
                    "resultClass",
                    chosen(v, &["result_class", "resultClass"], Value::Null),
                ),
                (
                    "forbiddenSideEffects",
                    chosen(
                        v,
                        &["forbidden_side_effects", "forbiddenSideEffects"],
                        json!([]),
                    ),
                ),
                (
                    "observedSideEffects",
                    chosen(
                        v,
                        &["observed_side_effects", "observedSideEffects"],
                        json!([]),
                    ),
                ),
                (
                    "sourceLocator",
                    chosen(v, &["source_locator", "path"], record["path"].clone()),
                ),
                (
                    "evidenceRefs",
                    Cow::Owned(
                        json!([{"kind":"path","ref":chosen(v,&["path"],record["path"].clone()),"hash":chosen(v,&["sha256"],record["hash"].clone())}]),
                    ),
                ),
            ];
            if let Some(accepted) = choice(v, &["accepted_result_classes", "acceptedResultClasses"])
            {
                fields.push(("acceptedResultClasses", Cow::Borrowed(accepted)));
            }
            let value = assembled(&out, fields, c)?;
            out.push(2, value, c)?;
        }
        let mut refs = Vec::new();
        if let Some(v) = choice(&json, &["command", "command_line"]) {
            refs.push(v.clone());
        }
        if let Some(v) = choice(&json, &["seed", "seeds"]) {
            refs.push(json!(format!(
                "seed:{}",
                String::from_utf8(
                    production_json_stringify_v1(
                        &parse_production_json_v1(&serde_json::to_vec(v).map_err(|_| refused())?)
                            .map_err(|_| refused())?
                    )
                    .map_err(|_| refused())?
                )
                .map_err(|_| refused())?
            )));
        }
        if let Some(v) = choice(&json, &["sha256", "checksum"]) {
            refs.push(json!(format!("checksum:{}", text(v)?)));
        }
        for v in refs.into_iter().take(12) {
            out.push(3,json!({"id":format!("json_repro:{}",out.repro.len()+1),"text":normalize(&text(&v)?),"status":"observed","kind":"reproducibility","sourceLocator":record["path"],"evidenceRefs":[{"kind":"path","ref":record["path"],"hash":record["hash"]}]}),c)?;
        }
        for v in arrays(
            &json,
            &[
                "reproducibility",
                "reproducibility_items",
                "reproducibility_plan",
            ],
        )
        .into_iter()
        .take(24)
        {
            if v.is_null() {
                return Err(refused());
            }
            out.budget(std::iter::once(v))?;
            let string = if choice(v, &["text", "summary", "description"]).is_some() {
                Value::Null
            } else {
                json!(text(v)?)
            };
            let value = assembled(
                &out,
                vec![
                    (
                        "id",
                        chosen(
                            v,
                            &["id", "key"],
                            json!(format!("json_repro:{}", out.repro.len() + 1)),
                        ),
                    ),
                    (
                        "text",
                        chosen(v, &["text", "summary", "description"], string),
                    ),
                    ("status", chosen(v, &["status"], json!("observed"))),
                    ("kind", chosen(v, &["kind"], json!("reproducibility"))),
                    (
                        "sourceLocator",
                        chosen(
                            v,
                            &["source_locator", "sourceLocator"],
                            record["path"].clone(),
                        ),
                    ),
                    (
                        "evidenceRefs",
                        Cow::Owned(
                            json!([{"kind":"path","ref":record["path"],"hash":record["hash"]}]),
                        ),
                    ),
                ],
                c,
            )?;
            out.push(3, value, c)?;
        }
        let mut experiments = arrays(&json, &["experiments"]);
        for k in ["experiment", "experiment_manifest"] {
            if matches!(json[k], Value::Object(_) | Value::Array(_)) {
                experiments.push(&json[k]);
            }
        }
        for v in experiments.into_iter().take(24) {
            let (projected_nodes, projected_key_bytes) = experiment_projection(v, c)?;
            let experiment_id = chosen(
                v,
                &["experimentId", "experiment_id", "id"],
                json!(format!("json_experiment:{}", out.experiments.len() + 1)),
            );
            let result_path = chosen(v, &["resultPath", "result_path"], record["path"].clone());
            let result_hash = chosen(v, &["resultHash", "result_hash"], record["hash"].clone());
            projected_budget(
                out.all().chain(std::iter::once(v)).chain([
                    experiment_id.as_ref(),
                    result_path.as_ref(),
                    result_hash.as_ref(),
                ]),
                projected_nodes,
                projected_key_bytes,
            )?;
            let mut value = match v {
                Value::Object(o) => Value::Object(o.clone()),
                Value::Array(a) => Value::Object(
                    a.iter()
                        .enumerate()
                        .map(|(i, v)| (i.to_string(), v.clone()))
                        .collect(),
                ),
                Value::Null => return Err(refused()),
                Value::Bool(_) | Value::Number(_) => Value::Object(Map::new()),
                Value::String(text) => {
                    if text.chars().any(|c| c.len_utf16() != 1) {
                        return Err(refused());
                    }
                    Value::Object(
                        text.chars()
                            .enumerate()
                            .map(|(i, c)| (i.to_string(), json!(c.to_string())))
                            .collect(),
                    )
                }
            };
            value["experimentId"] = experiment_id.into_owned();
            value["resultPath"] = result_path.into_owned();
            value["resultHash"] = result_hash.into_owned();
            out.push(4, value, c)?;
        }
        for v in arrays(
            &json,
            &["formalVerifierAdapters", "formal_verifier_adapters"],
        )
        .into_iter()
        .take(24)
        {
            out.budget(std::iter::once(v))?;
            out.push(5, v.clone(), c)?;
        }
        let mut certificates = arrays(&json, &["formalCertificates", "formal_certificates"]);
        for k in ["formalCertificateRequest", "formal_certificate_request"] {
            if matches!(json[k], Value::Object(_) | Value::Array(_)) {
                certificates.push(&json[k]);
            }
        }
        for v in certificates.into_iter().take(24) {
            out.budget(std::iter::once(v))?;
            out.push(6, v.clone(), c)?;
        }
    }
    Ok(out)
}
/// Actual evidence and formal-plan observations share one fixed read aggregate.
/// This composition grants no scientific or submission authority.
pub fn inspect_native_research_evidence_v1<'a>(
    request: NativeResearchEvidenceRequestV1,
    c: &'a AtomicBool,
    deadline: Instant,
) -> Result<NativeResearchEvidenceObservationV1<'a>, String> {
    check(c)?;
    let mut context = NativeResearchReadContextV1::new(c, deadline);
    inspect_native_research_evidence_with_context_v1(request, &mut context)
}
pub(crate) fn inspect_native_research_evidence_with_context_v1<'a>(
    request: NativeResearchEvidenceRequestV1,
    context: &mut NativeResearchReadContextV1<'a>,
) -> Result<NativeResearchEvidenceObservationV1<'a>, String> {
    context.require_active()?;
    let result = inspect_evidence(request, context, None);
    context.finish(result)
}
fn inspect_evidence<'a>(
    request: NativeResearchEvidenceRequestV1,
    budget: &mut NativeResearchReadContextV1<'a>,
    runtime_root: Option<PathBuf>,
) -> Result<NativeResearchEvidenceObservationV1<'a>, String> {
    let c = budget.cancelled();
    let deadline = budget.deadline();
    check(c)?;
    if request.version != 1 || !request.root.is_absolute() {
        return Err(refused());
    }
    for path in [
        Some(&request.root),
        request.source_root.as_ref(),
        request.log_root.as_ref(),
        request.empirical_root.as_ref(),
    ]
    .into_iter()
    .flatten()
    {
        if !path.is_absolute() || path.as_os_str().len() > 4096 {
            return Err(refused());
        }
    }
    values_budget(std::iter::once(&request.paper_task))?;
    let profiles = &request.paper_task["paperQualityProfiles"];
    if !profiles.is_null() && !profiles.is_array() {
        return Err(refused());
    }
    let empirical_profile = request.paper_task["paperQualityProfile"] == "empirical_or_experiment"
        || request.paper_task["paperQualityProfiles"]
            .as_array()
            .is_some_and(|a| a.iter().any(|v| v == "empirical_or_experiment"));
    let mut source = SourceObservation::new_with_deadline(&request.root, c, deadline)?;
    if source.root() != request.root {
        return Err(refused());
    }
    let mut runtime = runtime_root
        .map(|root| {
            runtime::RuntimeEvidenceSourceV2::new(
                &request.root,
                &root,
                &request.paper_task,
                c,
                deadline,
            )
        })
        .transpose()?;
    let mut sets = Vec::new();
    for (absolute, role) in [
        (&request.source_root, "source"),
        (&request.log_root, "log"),
        (&request.empirical_root, "empirical"),
    ] {
        let mut records = Vec::new();
        if role == "empirical" && runtime.is_some() {
            let held = runtime.as_mut().ok_or_else(refused)?;
            records = held.records(&request.root, budget)?;
        } else if let Some(absolute) = absolute {
            let relative = scope(&request.root, absolute)?;
            if let Some(metadata) = source.inventory_probe(&relative)?
                && metadata.directory
            {
                let mut selected = Vec::new();
                walk(&mut source, &relative, 0, &mut selected, c)?;
                for path in selected.into_iter().take(128) {
                    records.push(record(
                        &mut source,
                        &path,
                        &relative,
                        role,
                        &request.root,
                        budget,
                    )?);
                }
            }
        }
        sets.push(records);
    }
    let records = sets.iter().flatten().cloned().collect::<Vec<_>>();
    let mut structured = extract(&mut source, &records, budget, c, &mut runtime)?;
    let mut canonical = None;
    let mut canonical_claims = None;
    let mut formal_worker = false;
    let mut empirical = None;
    if let Some(absolute) = &request.source_root {
        let relative = scope(&request.root, absolute)?.join("RESEARCH_WORKER_PLAN.json");
        let plan = read_json(&mut source, &relative, budget, c)?;
        if truthy(&plan) {
            let workers = &plan["workers"];
            if truthy(workers) && !workers.is_array() {
                return Err(refused());
            }
            let observed = inspect_native_canonical_formal_claim_registry_with_context_v1(
                absolute,
                &request.paper_task,
                &plan,
                1,
                budget,
            )?;
            let claims = &observed.observed()["claims"];
            formal_worker = workers.as_array().is_some_and(|workers| {
                workers
                    .iter()
                    .any(|worker| worker["type"] == "formal_verifier_lake")
            });
            if formal_worker && claims.as_array().is_some_and(|claims| !claims.is_empty()) {
                structured.claims.clear();
                values_budget(structured.all().chain(records.iter()).chain([
                    observed.observed(),
                    claims,
                    &plan,
                ]))?;
                canonical_claims = Some(claims.clone());
            }
            values_budget(
                structured
                    .all()
                    .chain(records.iter())
                    .chain([observed.observed()])
                    .chain(canonical_claims.iter()),
            )?;
            canonical = Some(observed);
        }
    }
    if empirical_profile {
        // Original empirical profile replaces observed claims even when the
        // canonical claim array is empty. No caller universe or hash is used.
        structured.claims.clear();
        if !formal_worker {
            canonical_claims = None;
        }
        if let Some(absolute) = &request.source_root {
            let default_main = json!("main.tex");
            let empty = json!("");
            let path_task = json!({
                "mainTex": if truthy(&request.paper_task["mainTex"]) { &request.paper_task["mainTex"] } else { &default_main },
                "sourceWorkspace": if truthy(&request.paper_task["sourceWorkspace"]) { &request.paper_task["sourceWorkspace"] } else { &empty },
            });
            let manuscript =
                crate::native_research_canonical::path(absolute, &path_task, c, deadline)?
                    .ok_or_else(refused)?;
            let observed = inspect_native_empirical_assertion_universe_with_context_v1(
                NativeEmpiricalAssertionUniverseRequestV1 {
                    version: 1,
                    source_root: absolute.clone(),
                    manuscript_path: manuscript,
                    maximum_files: 128,
                    derive_claim_universe: true,
                },
                budget,
            )?;
            values_budget(
                structured
                    .all()
                    .chain(records.iter())
                    .chain([observed.observed()])
                    .chain(observed.claim_observation_v1().map(|v| v.observed())),
            )?;
            empirical = Some(observed);
        }
    }
    values_budget(
        structured
            .all()
            .chain(records.iter())
            .chain(sets.iter().flatten())
            .chain(records.iter()),
    )?;
    let seeds = records
        .iter()
        .filter(|v| {
            let text = format!(
                "{} {}",
                v["filename"].as_str().unwrap_or_default(),
                v["path"].as_str().unwrap_or_default()
            )
            .to_lowercase();
            ordered(&text, &["proposal", "seed", "contract"])
                || ordered(&text, &["claim", "proof", "evidence", "repro", "seed"])
        })
        .cloned()
        .collect::<Vec<_>>();
    let mut observed = Map::new();
    for (role, records) in ["sourceEvidence", "logEvidence", "empiricalEvidence"]
        .into_iter()
        .zip(sets)
    {
        observed.insert(role.into(), Value::Array(records));
    }
    observed.insert("evidenceRecords".into(), Value::Array(records));
    observed.insert("proposalSeedEvidence".into(), Value::Array(seeds));
    let mut structured_value = structured.value();
    if let Some(canonical) = &canonical {
        values_budget(
            [canonical.observed(), &structured_value]
                .into_iter()
                .chain(canonical_claims.iter())
                .chain(observed.values()),
        )?;
        structured_value["canonicalClaimRegistry"] = canonical.observed().clone();
    }
    if let Some(claims) = canonical_claims {
        structured_value["claims"] = claims;
    }
    if let Some(empirical) = &empirical {
        let claim = empirical.claim_observation_v1().ok_or_else(refused)?;
        let universe = claim.observed();
        let assertion = empirical.observed();
        values_budget(
            [
                universe,
                assertion,
                claim.canonical_claims(),
                &structured_value,
            ]
            .into_iter()
            .chain(observed.values()),
        )?;
        let registry = json!({"status": if universe["status"] == "empirical_claim_universe_verified" { "canonical_empirical_claim_registry_verified" } else { "canonical_empirical_claim_registry_blocked" }, "empiricalClaimUniverse": universe, "empiricalClaimUniverseHash": universe["empiricalClaimUniverseHash"], "manuscriptCorpusHash": universe["manuscriptCorpusHash"], "claims": claim.canonical_claims(), "blockers": universe["blockers"]});
        let assertion = json!({"status": if assertion["status"] == "empirical_assertion_universe_verified" { "canonical_empirical_assertion_universe_verified" } else { "canonical_empirical_assertion_universe_blocked" }, "empiricalAssertionUniverse": assertion, "empiricalAssertionUniverseHash": assertion["empiricalAssertionUniverseHash"], "manuscriptCorpusHash": assertion["manuscriptCorpusHash"], "blockers": assertion["blockers"]});
        let existing = structured_value["claims"].as_array().ok_or_else(refused)?;
        let extra = claim.canonical_claims().as_array().ok_or_else(refused)?;
        values_budget(
            [&structured_value, &registry, &assertion]
                .into_iter()
                .chain(observed.values())
                .chain(extra.iter()),
        )?;
        let mut claims = Vec::with_capacity(existing.len() + extra.len());
        claims.extend_from_slice(existing);
        claims.extend_from_slice(extra);
        structured_value["claims"] = Value::Array(claims);
        structured_value["canonicalEmpiricalClaimRegistry"] = registry;
        structured_value["canonicalEmpiricalAssertionUniverse"] = assertion;
    }
    observed.insert("structured".into(), structured_value);
    values_budget(observed.values())?;
    source.assert_current()?;
    if let Some(canonical) = &canonical {
        canonical.verify_unchanged()?;
    }
    if let Some(empirical) = &empirical {
        empirical.verify_unchanged()?;
    }
    if let Some(runtime) = &runtime {
        runtime.verify_unchanged()?;
    }
    budget.require_active()?;
    check(c)?;
    Ok(NativeResearchEvidenceObservationV1 {
        source,
        runtime,
        observed: Value::Object(observed),
        canonical,
        empirical,
    })
}
#[cfg(test)]
mod tests;

mod runtime;
pub use runtime::{
    NativeResearchEvidenceRuntimeRequestV2, inspect_native_research_evidence_for_current_runtime_v2,
};

#[cfg(test)]
mod runtime_tests;

pub(crate) mod intake;
pub use intake::build_native_research_evidence_intake_v1;
mod candidates;
pub use candidates::build_native_evidence_verification_candidates_v1;
mod observed_inputs;
#[cfg(test)]
mod observed_inputs_tests;
pub use observed_inputs::{
    NativeResearchObservedInputsObservationV1, NativeResearchObservedInputsRequestV1,
    inspect_native_research_observed_inputs_v1,
};
mod verification;
pub use verification::{
    NativeEvidenceArtifactVerificationObservationV1, NativeEvidenceArtifactVerificationRequestV1,
    verify_native_evidence_artifacts_v1,
};

#[cfg(test)]
mod verification_tests;
