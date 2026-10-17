//! Actual marker-bound empirical manuscript claims from the existing held source.
//! This reader never verifies an experiment or grants scientific authority.
use crate::{
    native_business::local_submission_preflight::{
        local_submission_projected_values_budget_v1 as projected_budget,
        local_submission_truthy as truthy, local_submission_values_budget_v1 as budget,
    },
    native_latex_theorem_syntax::{
        LatexSyntaxControlV1, analyze_theorem_environment_macro_definitions_with_control_v1,
    },
    native_research_claims::{number, number_value, raw_string},
    native_research_manuscript::{
        NativeResearchReadContextV1, Universe, line_records, literal_includes, safe_path,
        trim_range,
    },
    runtime_source_cas::observation::SourceObservation,
};
use hepta_legacy_compatibility::{
    ProductionCollationV1, ProductionJsonEncodingLimitsV1, ProductionJsonValue,
    parse_production_json_v1, production_hash_record_v1, production_json_resources_v1,
    production_json_stringify_v1,
};
use regex::Regex;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{
    collections::BTreeSet,
    path::{Path, PathBuf},
    sync::{
        OnceLock,
        atomic::{AtomicBool, Ordering},
    },
    time::Instant,
};
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct NativeEmpiricalClaimUniverseRequestV1 {
    pub version: u16,
    pub source_root: PathBuf,
    pub manuscript_path: String,
    pub maximum_files: usize,
}
pub struct NativeEmpiricalClaimUniverseObservationV1<'a> {
    source: SourceObservation<'a>,
    observed: Value,
    canonical_claims: Value,
}
impl NativeEmpiricalClaimUniverseObservationV1<'_> {
    pub fn observed(&self) -> &Value {
        &self.observed
    }
    pub fn canonical_claims(&self) -> &Value {
        &self.canonical_claims
    }
    pub fn verify_unchanged(&self) -> Result<(), String> {
        self.source.assert_current()
    }
}
fn refused() -> String {
    "native_empirical_claim_universe_data_domain_v1_refused".into()
}
fn check(c: &AtomicBool, deadline: Instant) -> Result<(), String> {
    if c.load(Ordering::SeqCst) {
        Err("native_empirical_claim_universe_cancelled".into())
    } else if Instant::now() >= deadline {
        Err("native_empirical_claim_universe_deadline_exceeded".into())
    } else {
        Ok(())
    }
}
fn hash(kind: &str, value: &Value) -> Result<String, String> {
    production_hash_record_v1(kind, value)
        .map(|h| h.as_str().to_owned())
        .map_err(|_| refused())
}
fn bytes_hash(value: &[u8]) -> String {
    format!("sha256:{:x}", Sha256::digest(value))
}
fn latin1(value: &[u8]) -> String {
    value.iter().map(|b| char::from(*b)).collect()
}
fn patterns() -> Result<&'static (Regex, Regex), String> {
    static PATTERNS: OnceLock<Result<(Regex, Regex), String>> = OnceLock::new();
    PATTERNS.get_or_init(||Ok((
        Regex::new(r"^[\t\x0b\x0c\r \u{a0}]*%[\t\x0b\x0c\r \u{a0}]*HEPTA_EMPIRICAL_CLAIM_BEGIN[\t\x0b\x0c\r \u{a0}]+(\{[^\r\n]*\})[\t\x0b\x0c\r \u{a0}]*$").map_err(|_|refused())?,
        Regex::new(r"^[\t\x0b\x0c\r \u{a0}]*%[\t\x0b\x0c\r \u{a0}]*HEPTA_EMPIRICAL_CLAIM_END[\t\x0b\x0c\r \u{a0}]+([A-Za-z0-9][A-Za-z0-9_.:-]{0,159})[\t\x0b\x0c\r \u{a0}]*$").map_err(|_|refused())?
    ))).as_ref().map_err(Clone::clone)
}
fn identifier(value: &Value) -> Result<bool, String> {
    let value = if truthy(value) {
        raw_string(value)?
    } else {
        String::new()
    };
    Ok(!value.is_empty()
        && value.len() <= 160
        && value.as_bytes()[0].is_ascii_alphanumeric()
        && value
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"_.:-".contains(&b)))
}
fn sha(value: &Value) -> Result<bool, String> {
    let value = raw_string(value)?;
    Ok(value.len() == 71
        && value
            .get(..7)
            .is_some_and(|p| p.eq_ignore_ascii_case("sha256:"))
        && value.as_bytes()[7..].iter().all(u8::is_ascii_hexdigit))
}
fn valid_declaration(value: &Value) -> Result<bool, String> {
    let Some(object) = value.as_object() else {
        return Ok(false);
    };
    let keys = [
        "claimId",
        "metric",
        "comparator",
        "alternative",
        "minimumEffect",
        "acceptanceRequired",
        "proposalClaimRecordHash",
    ];
    if object.len() != keys.len() || keys.iter().any(|k| !object.contains_key(*k)) {
        return Ok(false);
    }
    let effect = number(&value["minimumEffect"])?;
    Ok(identifier(&value["claimId"])?
        && identifier(&value["metric"])?
        && matches!(value["comparator"].as_str(), Some("baseline" | "ablation"))
        && matches!(value["alternative"].as_str(), Some("greater" | "less"))
        && effect.is_finite()
        && effect >= 0.0
        && value["acceptanceRequired"].is_boolean()
        && (value["proposalClaimRecordHash"].is_null() || sha(&value["proposalClaimRecordHash"])?))
}
fn finite(value: &ProductionJsonValue) -> bool {
    match value {
        ProductionJsonValue::Number(value) => value.is_finite(),
        ProductionJsonValue::Array(value) => value.iter().all(finite),
        ProductionJsonValue::Object(value) => value.iter().all(|(_, v)| finite(v)),
        _ => true,
    }
}
fn parse_declaration(text: &str, c: &AtomicBool) -> Result<Option<Value>, String> {
    if text.len() > 65536 {
        return Err(refused());
    }
    let Ok(parsed) = parse_production_json_v1(text.as_bytes()) else {
        return Ok(None);
    };
    production_json_resources_v1(
        &parsed,
        ProductionJsonEncodingLimitsV1 {
            maximum_bytes: 65536,
            maximum_values: 20_000,
            maximum_utf16_units: 65536,
        },
        c,
    )
    .map_err(|_| refused())?;
    if !finite(&parsed) {
        return Err(refused());
    }
    let bytes = production_json_stringify_v1(&parsed).map_err(|_| refused())?;
    let value: Value = serde_json::from_slice(&bytes).map_err(|_| refused())?;
    budget([&value])?;
    Ok(Some(value))
}
struct Reader<'a, 'b> {
    source: &'a mut SourceObservation<'b>,
    context: &'a mut NativeResearchReadContextV1<'b>,
    work: &'a LatexSyntaxControlV1<'b>,
    maximum_files: usize,
    visited: BTreeSet<String>,
    files: Vec<Value>,
    claims: Vec<Value>,
    blockers: Vec<Value>,
    path_bytes: usize,
    include_bytes: usize,
}
impl Reader<'_, '_> {
    fn all(&self) -> impl Iterator<Item = &Value> {
        self.files.iter().chain(&self.claims).chain(&self.blockers)
    }
    fn check(&self) -> Result<(), String> {
        check(self.context.cancelled(), self.context.deadline())
    }
    fn blocker(&mut self, value: String) -> Result<(), String> {
        let value = Value::String(value);
        budget(self.all().chain([&value]))?;
        self.blockers.push(value);
        Ok(())
    }
    fn extract(
        &mut self,
        relative: &str,
        content: &[u8],
        file_hash: &str,
    ) -> Result<Vec<Value>, String> {
        let units = content.iter().map(|b| u16::from(*b)).collect::<Vec<_>>();
        let lines = line_records(&units, self.context.cancelled(), self.context.deadline())?;
        let (begin_pattern, end_pattern) = patterns()?;
        let mut open: Option<(Value, usize, usize)> = None;
        let mut surfaces = Vec::new();
        for line in lines {
            self.check()?;
            let begin = begin_pattern.captures(&line.text);
            let end = end_pattern.captures(&line.text);
            if (line.text.contains("HEPTA_EMPIRICAL_CLAIM_BEGIN")
                || line.text.contains("HEPTA_EMPIRICAL_CLAIM_END"))
                && begin.is_none()
                && end.is_none()
            {
                self.blocker(format!(
                    "empirical_claim_universe_marker_malformed:{relative}:{}",
                    line.byte_start
                ))?;
                continue;
            }
            if let Some(begin) = begin {
                if open.is_some() {
                    self.blocker(format!(
                        "empirical_claim_universe_marker_nested:{relative}:{}",
                        line.byte_start
                    ))?;
                    continue;
                }
                let declaration = parse_declaration(
                    begin.get(1).ok_or_else(refused)?.as_str(),
                    self.context.cancelled(),
                )?;
                if declaration
                    .as_ref()
                    .map(valid_declaration)
                    .transpose()?
                    .unwrap_or(false)
                {
                    let declaration = declaration.ok_or_else(refused)?;
                    budget(self.all().chain(surfaces.iter()).chain([&declaration]))?;
                    open = Some((declaration, line.byte_start, line.byte_end));
                } else {
                    self.blocker(format!(
                        "empirical_claim_universe_declaration_invalid:{relative}:{}",
                        line.byte_start
                    ))?;
                }
                continue;
            }
            let Some(end) = end else { continue };
            let Some((declaration, marker_start, body_start)) = open.take() else {
                self.blocker(format!(
                    "empirical_claim_universe_marker_end_unpaired:{relative}:{}",
                    line.byte_start
                ))?;
                continue;
            };
            if declaration["claimId"].as_str() != Some(end.get(1).ok_or_else(refused)?.as_str()) {
                self.blocker(format!(
                    "empirical_claim_universe_marker_id_mismatch:{relative}:{}",
                    line.byte_start
                ))?;
                continue;
            }
            let range = trim_range(
                &units,
                body_start,
                line.byte_start,
                self.context.cancelled(),
                self.context.deadline(),
            )?;
            let bytes = &content[range.byte_start..range.byte_end];
            let Ok(text) = std::str::from_utf8(bytes) else {
                self.blocker(format!(
                    "empirical_claim_universe_claim_body_invalid:{relative}:{marker_start}"
                ))?;
                continue;
            };
            if bytes.is_empty()
                || crate::automation_runtime_reconciliation::sqlite_number::trim(text).is_empty()
            {
                self.blocker(format!(
                    "empirical_claim_universe_claim_body_invalid:{relative}:{marker_start}"
                ))?;
                continue;
            }
            if text.len() > 65536 || text.contains('\0') {
                return Err(refused());
            }
            projected_budget(
                self.all().chain(surfaces.iter()).chain([&declaration]),
                25,
                text.len() + 256 + relative.len() + file_hash.len(),
            )?;
            let body = Value::String(text.to_owned());
            let surface = json!({"declaration":declaration,"manuscriptPath":relative,"manuscriptFileHash":file_hash,"markerByteStart":marker_start,"markerByteEnd":line.byte_end,"manuscriptByteStart":range.byte_start,"manuscriptByteEnd":range.byte_end,"manuscriptContentHash":bytes_hash(bytes),"text":body});
            budget(self.all().chain(surfaces.iter()).chain([&surface]))?;
            surfaces.push(surface);
        }
        if let Some((_, marker_start, _)) = open {
            self.blocker(format!(
                "empirical_claim_universe_marker_unterminated:{relative}:{marker_start}"
            ))?;
        }
        Ok(surfaces)
    }
    fn visit(&mut self, relative: &str, depth: usize) -> Result<(), String> {
        self.check()?;
        if relative.is_empty() || self.visited.contains(relative) {
            return Ok(());
        }
        if self.visited.len() >= self.maximum_files || depth > 32 {
            return self.blocker("empirical_claim_universe_include_limit_exceeded".into());
        }
        if relative.len() > 4096
            || relative.contains('\\')
            || Path::new(relative)
                .components()
                .any(|c| !matches!(c, std::path::Component::Normal(_)))
        {
            return Err(refused());
        }
        self.path_bytes = self
            .path_bytes
            .checked_add(relative.len())
            .filter(|v| *v <= 65536)
            .ok_or_else(refused)?;
        self.visited.insert(relative.into());
        let Some(metadata) = self.source.inventory_probe(Path::new(relative))? else {
            return self.blocker(format!(
                "empirical_claim_universe_manuscript_unreadable:{relative}"
            ));
        };
        if metadata.directory {
            return self.blocker(format!(
                "empirical_claim_universe_manuscript_unreadable:{relative}"
            ));
        }
        if metadata.size > 1024 * 1024 || metadata.link_count != 1 {
            return Err(refused());
        }
        self.context.charge(self.source, Path::new(relative))?;
        let content = self
            .source
            .inventory_document(Path::new(relative), 1024 * 1024)?;
        self.check()?;
        let digest = bytes_hash(&content);
        let file = json!({"path":relative,"hash":digest,"bytes":content.len()});
        budget(self.all().chain([&file]))?;
        self.files.push(file);
        let syntax = analyze_theorem_environment_macro_definitions_with_control_v1(
            &latin1(&content),
            &[],
            self.work,
        )?;
        for blocker in syntax.blockers {
            self.blocker(format!(
                "empirical_claim_universe_dynamic_tex_unsupported:{relative}:{}",
                blocker.offset
            ))?;
        }
        let includes = literal_includes(
            &syntax.masked_source.encode_utf16().collect::<Vec<_>>(),
            relative,
            Universe::EmpiricalClaim,
            self.context.cancelled(),
            self.context.deadline(),
        )?;
        self.include_bytes =
            includes
                .includes
                .iter()
                .try_fold(self.include_bytes, |total, item| {
                    total
                        .checked_add(item.path.len() + 32)
                        .filter(|v| *v <= 1024 * 1024)
                        .ok_or_else(refused)
                })?;
        for blocker in includes.blockers {
            self.blocker(blocker)?;
        }
        let mut extracted = self
            .extract(relative, &content, &digest)?
            .into_iter()
            .map(Some)
            .collect::<Vec<_>>();
        let mut events = extracted
            .iter()
            .enumerate()
            .map(|(i, v)| {
                (
                    v.as_ref()
                        .and_then(|v| v["markerByteStart"].as_u64())
                        .unwrap_or(0),
                    false,
                    i,
                )
            })
            .chain(
                includes
                    .includes
                    .iter()
                    .enumerate()
                    .map(|(i, v)| (v.byte_start as u64, true, i)),
            )
            .collect::<Vec<_>>();
        events.sort_by_key(|event| (event.0, event.1));
        for (_, include, index) in events {
            self.check()?;
            if include {
                self.visit(&includes.includes[index].path, depth + 1)?
            } else {
                let claim = extracted[index].take().ok_or_else(refused)?;
                budget(self.all().chain([&claim]))?;
                self.claims.push(claim)
            }
        }
        Ok(())
    }
}
pub fn inspect_native_empirical_claim_universe_v1<'a>(
    request: NativeEmpiricalClaimUniverseRequestV1,
    c: &'a AtomicBool,
    deadline: Instant,
) -> Result<NativeEmpiricalClaimUniverseObservationV1<'a>, String> {
    check(c, deadline)?;
    let mut context = NativeResearchReadContextV1::new(c, deadline);
    inspect_native_empirical_claim_universe_with_context_v1(request, &mut context)
}
pub(crate) fn inspect_native_empirical_claim_universe_with_context_v1<'a>(
    request: NativeEmpiricalClaimUniverseRequestV1,
    context: &mut NativeResearchReadContextV1<'a>,
) -> Result<NativeEmpiricalClaimUniverseObservationV1<'a>, String> {
    context.require_active()?;
    let result = inspect_empirical(request, context);
    context.finish(result)
}
fn inspect_empirical<'a>(
    request: NativeEmpiricalClaimUniverseRequestV1,
    context: &mut NativeResearchReadContextV1<'a>,
) -> Result<NativeEmpiricalClaimUniverseObservationV1<'a>, String> {
    if request.version != 1
        || !request.source_root.is_absolute()
        || request.source_root.as_os_str().len() > 4096
        || request.manuscript_path.len() > 4096
        || request.maximum_files > 128
    {
        return Err(refused());
    }
    let c = context.cancelled();
    let deadline = context.deadline();
    let manuscript = safe_path(&request.manuscript_path);
    let mut source = SourceObservation::new_with_deadline(&request.source_root, c, deadline)?;
    if source.root() != request.source_root {
        return Err(refused());
    }
    let work = context.syntax_control_v1()?;
    let mut reader = Reader {
        source: &mut source,
        context,
        work: &work,
        maximum_files: request.maximum_files,
        visited: BTreeSet::new(),
        files: Vec::new(),
        claims: Vec::new(),
        blockers: Vec::new(),
        path_bytes: 0,
        include_bytes: 0,
    };
    if let Some(path) = &manuscript {
        reader.visit(path, 0)?
    } else {
        reader.blocker("empirical_claim_universe_manuscript_path_invalid".into())?
    }
    let collator = ProductionCollationV1::load().map_err(|_| refused())?;
    reader.files.sort_by(|a, b| {
        collator.compare(
            a["path"].as_str().unwrap_or_default(),
            b["path"].as_str().unwrap_or_default(),
        )
    });
    reader.check()?;
    projected_budget(reader.all().chain(reader.files.iter()), 1, 0)?;
    let source_corpus = hash(
        "EmpiricalManuscriptSourceCorpus",
        &Value::Array(reader.files.clone()),
    )?;
    let mut corpus = Vec::new();
    for candidate in &reader.claims {
        reader.check()?;
        let d = &candidate["declaration"];
        projected_budget(
            reader.all().chain(corpus.iter()).chain([
                d,
                &candidate["manuscriptPath"],
                &candidate["manuscriptContentHash"],
            ]),
            12,
            256,
        )?;
        let entry = json!({"claimId":d["claimId"],"metric":d["metric"],"comparator":d["comparator"],"alternative":d["alternative"],"minimumEffect":number_value(number(&d["minimumEffect"])?) ,"acceptanceRequired":d["acceptanceRequired"]==true,"proposalClaimRecordHash":d["proposalClaimRecordHash"],"manuscriptPath":candidate["manuscriptPath"],"manuscriptContentHash":candidate["manuscriptContentHash"]});
        budget(reader.all().chain(corpus.iter()).chain([&entry]))?;
        corpus.push(entry);
    }
    projected_budget(reader.all().chain(corpus.iter()).chain(corpus.iter()), 1, 0)?;
    let manuscript_corpus = hash(
        "EmpiricalManuscriptClaimCorpus",
        &Value::Array(corpus.clone()),
    )?;
    let mut identities = Vec::new();
    for claim in &corpus {
        reader.check()?;
        projected_budget(
            reader
                .all()
                .chain(corpus.iter())
                .chain(identities.iter())
                .chain([claim]),
            12,
            256,
        )?;
        let payload = json!({"claimId":raw_string(&claim["claimId"])? ,"metric":raw_string(&claim["metric"])? ,"comparator":raw_string(&claim["comparator"])? ,"alternative":raw_string(&claim["alternative"])? ,"minimumEffect":claim["minimumEffect"],"acceptanceRequired":claim["acceptanceRequired"],"proposalClaimRecordHash":claim["proposalClaimRecordHash"],"manuscriptPath":claim["manuscriptPath"],"manuscriptContentHash":claim["manuscriptContentHash"],"manuscriptCorpusHash":manuscript_corpus});
        let identity = json!({"claimId":claim["claimId"],"manuscriptClaimHash":hash("EmpiricalManuscriptClaim",&payload)?,"proposalClaimRecordHash":claim["proposalClaimRecordHash"]});
        budget(
            reader
                .all()
                .chain(corpus.iter())
                .chain(identities.iter())
                .chain([&identity]),
        )?;
        identities.push(identity);
    }
    budget(reader.all().chain(corpus.iter()).chain(identities.iter()))?;
    let authority = json!({"version":1,"kind":"EmpiricalClaimUniverseAuthority","manuscriptPath":manuscript.clone().unwrap_or_default(),"manuscriptCorpusHash":manuscript_corpus,"claimIdentities":&identities});
    let universe_hash = hash("EmpiricalClaimUniverseAuthority", &authority)?;
    drop(authority);
    drop(corpus);
    let mut ids = BTreeSet::new();
    if identities.len() != reader.claims.len() {
        return Err(refused());
    }
    for (index, claim_identity) in identities.iter().enumerate() {
        reader.check()?;
        let id = reader.claims[index]["declaration"]["claimId"]
            .as_str()
            .ok_or_else(refused)?
            .to_owned();
        if !ids.insert(id.clone()) {
            reader.blocker(format!("empirical_claim_universe_claim_id_duplicate:{id}"))?;
        }
        let identity = claim_identity["manuscriptClaimHash"]
            .as_str()
            .ok_or_else(refused)?
            .to_owned();
        projected_budget(reader.all(), 12, 256)?;
        let candidate = reader.claims[index].as_object_mut().ok_or_else(refused)?;
        let d = candidate.remove("declaration").ok_or_else(refused)?;
        let effect = number(&d["minimumEffect"])?;
        let Value::Object(d) = d else {
            return Err(refused());
        };
        for (k, v) in d {
            candidate.insert(k, v);
        }
        candidate.insert("minimumEffect".into(), number_value(effect));
        candidate.insert("version".into(), json!(1));
        candidate.insert("kind".into(), json!("EmpiricalClaimUniverseEntry"));
        candidate.insert("manuscriptClaimHash".into(), json!(identity));
        let entry_hash = hash("EmpiricalClaimUniverseEntry", &reader.claims[index])?;
        reader.claims[index]["empiricalClaimUniverseEntryHash"] = json!(entry_hash);
    }
    if reader.claims.is_empty() {
        reader.blocker("empirical_claim_universe_claims_missing".into())?
    }
    let mut seen = BTreeSet::new();
    reader
        .blockers
        .retain(|v| seen.insert(v.as_str().unwrap_or_default().to_owned()));
    budget(reader.all())?;
    let verified = reader.blockers.is_empty();
    let mut observed = json!({"version":1,"kind":"EmpiricalClaimUniverse","status":if verified{"empirical_claim_universe_verified"}else{"empirical_claim_universe_blocked"},"manuscriptPath":manuscript,"manuscriptCorpusHash":manuscript_corpus,"sourceCorpusHash":source_corpus,"files":reader.files,"claims":reader.claims,"blockers":reader.blockers,"empiricalClaimUniverseHash":universe_hash});
    budget([&observed])?;
    observed["empiricalClaimUniverseReceiptHash"] =
        json!(hash("EmpiricalClaimUniverseReceipt", &observed)?);
    let mut canonical = Vec::new();
    if verified {
        for claim in observed["claims"].as_array().ok_or_else(refused)? {
            check(c, deadline)?;
            projected_budget(
                [&observed]
                    .into_iter()
                    .chain(canonical.iter())
                    .chain([claim]),
                32,
                512,
            )?;
            let value = json!({"id":claim["claimId"],"claimId":claim["claimId"],"text":claim["text"],"sourceLocator":format!("{}#bytes={}-{}",claim["manuscriptPath"].as_str().ok_or_else(refused)?,claim["manuscriptByteStart"],claim["manuscriptByteEnd"]),"manuscriptPath":claim["manuscriptPath"],"manuscriptByteStart":claim["manuscriptByteStart"],"manuscriptByteEnd":claim["manuscriptByteEnd"],"manuscriptContentHash":claim["manuscriptContentHash"],"manuscriptFileHash":claim["manuscriptFileHash"],"manuscriptClaimHash":claim["manuscriptClaimHash"],"empiricalClaimUniverseEntryHash":claim["empiricalClaimUniverseEntryHash"],"empiricalClaimUniverseHash":observed["empiricalClaimUniverseHash"],"manuscriptCorpusHash":observed["manuscriptCorpusHash"],"proposalClaimRecordHash":claim["proposalClaimRecordHash"],"status":"candidate","kind":"empirical_claim","verificationPlan":{"kind":"empirical_claim_bound_academic_experiment","requiresWorker":false,"requiresEvidence":false,"verifier":"system-owned-claim-bound-analysis-protocol-v2"},"proofObligations":[]});
            budget(
                [&observed]
                    .into_iter()
                    .chain(canonical.iter())
                    .chain([&value]),
            )?;
            canonical.push(value);
        }
    }
    source.assert_current()?;
    check(c, deadline)?;
    Ok(NativeEmpiricalClaimUniverseObservationV1 {
        source,
        observed,
        canonical_claims: Value::Array(canonical),
    })
}
#[cfg(test)]
mod tests;
