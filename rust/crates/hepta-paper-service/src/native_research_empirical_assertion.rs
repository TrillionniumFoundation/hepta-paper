//! Actual empirical assertion/presentation manuscript surfaces. Declarations and
//! hashes describe observed bytes; this reader grants no experiment authority.
use crate::{
    native_business::local_submission_preflight::{
        local_submission_projected_values_budget_v1 as projected_budget,
        local_submission_values_budget_v1 as budget,
    },
    native_empirical_markers::{
        assertion_marker_declaration_valid_v1, empirical_presentation_marker_declaration_valid_v1,
    },
    native_latex_theorem_syntax::{
        LatexSyntaxControlV1, analyze_theorem_environment_macro_definitions_with_control_v1,
    },
    native_research_empirical_claim::{
        NativeEmpiricalClaimUniverseObservationV1, NativeEmpiricalClaimUniverseRequestV1,
        inspect_native_empirical_claim_universe_with_context_v1,
    },
    native_research_manuscript::{
        NativeResearchReadContextV1, Universe, line_records, literal_includes, safe_path,
        trim_range,
    },
    native_research_support_surfaces::{
        extract_evidence_bound_surfaces_without_ir_v1,
        extract_formal_support_surfaces_without_authority_v1,
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
    path::{Component, Path, PathBuf},
    sync::{
        OnceLock,
        atomic::{AtomicBool, Ordering},
    },
    time::Instant,
};

mod syntax;
mod traversal;
use traversal::Reader;

fn trim(text: &str) -> &str {
    crate::automation_runtime_reconciliation::sqlite_number::trim(text)
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct NativeEmpiricalAssertionUniverseRequestV1 {
    pub version: u16,
    pub source_root: PathBuf,
    pub manuscript_path: String,
    pub maximum_files: usize,
    /// Derive and retain the actual claim universe, never accept a caller hash.
    pub derive_claim_universe: bool,
}
pub struct NativeEmpiricalAssertionUniverseObservationV1<'a> {
    source: SourceObservation<'a>,
    claim: Option<NativeEmpiricalClaimUniverseObservationV1<'a>>,
    observed: Value,
}
impl NativeEmpiricalAssertionUniverseObservationV1<'_> {
    pub fn observed(&self) -> &Value {
        &self.observed
    }
    pub(crate) fn claim_observation_v1(
        &self,
    ) -> Option<&NativeEmpiricalClaimUniverseObservationV1<'_>> {
        self.claim.as_ref()
    }
    pub fn verify_unchanged(&self) -> Result<(), String> {
        self.source.assert_current()?;
        if let Some(claim) = &self.claim {
            claim.verify_unchanged()?;
        }
        Ok(())
    }
}
fn refused() -> String {
    "native_empirical_assertion_universe_data_domain_v1_refused".into()
}
fn check(c: &AtomicBool, deadline: Instant) -> Result<(), String> {
    if c.load(Ordering::SeqCst) {
        Err("native_empirical_assertion_universe_cancelled".into())
    } else if Instant::now() >= deadline {
        Err("native_empirical_assertion_universe_deadline_exceeded".into())
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
fn finite(value: &ProductionJsonValue) -> bool {
    match value {
        ProductionJsonValue::Number(v) => v.is_finite(),
        ProductionJsonValue::Array(v) => v.iter().all(finite),
        ProductionJsonValue::Object(v) => v.iter().all(|(_, v)| finite(v)),
        _ => true,
    }
}
fn parse(text: &str, c: &AtomicBool) -> Result<Option<Value>, String> {
    if text.len() > 65536 {
        return Err(refused());
    }
    let Ok(value) = parse_production_json_v1(text.as_bytes()) else {
        return Ok(None);
    };
    production_json_resources_v1(
        &value,
        ProductionJsonEncodingLimitsV1 {
            maximum_bytes: 65536,
            maximum_values: 20000,
            maximum_utf16_units: 65536,
        },
        c,
    )
    .map_err(|_| refused())?;
    if !finite(&value) {
        return Err(refused());
    }
    let value: Value =
        serde_json::from_slice(&production_json_stringify_v1(&value).map_err(|_| refused())?)
            .map_err(|_| refused())?;
    budget([&value])?;
    Ok(Some(value))
}
pub fn inspect_native_empirical_assertion_universe_v1<'a>(
    request: NativeEmpiricalAssertionUniverseRequestV1,
    c: &'a AtomicBool,
    deadline: Instant,
) -> Result<NativeEmpiricalAssertionUniverseObservationV1<'a>, String> {
    check(c, deadline)?;
    let mut context = NativeResearchReadContextV1::new(c, deadline);
    inspect_native_empirical_assertion_universe_with_context_v1(request, &mut context)
}
pub(crate) fn inspect_native_empirical_assertion_universe_with_context_v1<'a>(
    request: NativeEmpiricalAssertionUniverseRequestV1,
    context: &mut NativeResearchReadContextV1<'a>,
) -> Result<NativeEmpiricalAssertionUniverseObservationV1<'a>, String> {
    context.require_active()?;
    let result = inspect(request, context);
    context.finish(result)
}
fn inspect<'a>(
    request: NativeEmpiricalAssertionUniverseRequestV1,
    context: &mut NativeResearchReadContextV1<'a>,
) -> Result<NativeEmpiricalAssertionUniverseObservationV1<'a>, String> {
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
    let claim = if request.derive_claim_universe {
        Some(inspect_native_empirical_claim_universe_with_context_v1(
            NativeEmpiricalClaimUniverseRequestV1 {
                version: 1,
                source_root: request.source_root.clone(),
                manuscript_path: request.manuscript_path.clone(),
                maximum_files: request.maximum_files,
            },
            context,
        )?)
    } else {
        None
    };
    let claims = claim.as_ref().map(|v| v.observed()).unwrap_or(&Value::Null);
    let claim_hash = claims["empiricalClaimUniverseHash"].clone();
    let mut claim_ranges = Vec::new();
    if claims["status"] == "empirical_claim_universe_verified" {
        for value in claims["claims"].as_array().ok_or_else(refused)? {
            projected_budget(claim_ranges.iter().chain([value]), 12, 256)?;
            let item = json!({"claimId":value["claimId"],"manuscriptPath":value["manuscriptPath"],"markerByteStart":value["markerByteStart"],"markerByteEnd":value["markerByteEnd"],"manuscriptContentHash":value["manuscriptContentHash"]});
            budget(claim_ranges.iter().chain([&item]))?;
            claim_ranges.push(item)
        }
    }
    let mut source = SourceObservation::new_with_deadline(&request.source_root, c, deadline)?;
    if source.root() != request.source_root {
        return Err(refused());
    }
    let work = context.syntax_control_v1()?;
    let mut reader = Reader {
        source: &mut source,
        context,
        work: &work,
        claim_ranges: &claim_ranges,
        maximum_files: request.maximum_files,
        visited: BTreeSet::new(),
        active: BTreeSet::new(),
        files: Vec::new(),
        assertions: Vec::new(),
        presentations: Vec::new(),
        supports: Vec::new(),
        surfaces: Vec::new(),
        blockers: Vec::new(),
        path_bytes: 0,
        include_bytes: 0,
    };
    reader.render_support()?;
    if claim.is_some() && claims["status"] != "empirical_claim_universe_verified" {
        reader.blocker("empirical_assertion_trusted_claim_universe_mismatch".into())?
    }
    if let Some(path) = &manuscript {
        reader.visit(path, 0)?
    } else {
        reader.blocker("empirical_assertion_universe_manuscript_path_invalid".into())?
    }
    let collator = ProductionCollationV1::load().map_err(|_| refused())?;
    reader.files.sort_by(|a, b| {
        collator.compare(
            a["path"].as_str().unwrap_or_default(),
            b["path"].as_str().unwrap_or_default(),
        )
    });
    for values in [
        &mut reader.assertions,
        &mut reader.presentations,
        &mut reader.supports,
        &mut reader.surfaces,
    ] {
        values.sort_by(|a, b| {
            collator
                .compare(
                    a["manuscriptPath"].as_str().unwrap_or_default(),
                    b["manuscriptPath"].as_str().unwrap_or_default(),
                )
                .then_with(|| {
                    a["markerByteStart"]
                        .as_u64()
                        .cmp(&b["markerByteStart"].as_u64())
                })
        })
    }
    reader.check()?;
    projected_budget(reader.all().chain(reader.files.iter()), 1, 0)?;
    let source_hash = hash(
        "EmpiricalAssertionSourceCorpus",
        &Value::Array(reader.files.clone()),
    )?;
    let mut ids = BTreeSet::new();
    for value in &reader.assertions {
        let id = value["declaration"]["assertionId"]
            .as_str()
            .ok_or_else(refused)?;
        if !ids.insert(id.to_owned()) {
            let blocker = json!(format!(
                "empirical_assertion_universe_assertion_id_duplicate:{id}"
            ));
            budget(reader.all().chain([&blocker]))?;
            reader.blockers.push(blocker)
        }
    }
    if reader.assertions.is_empty() {
        reader.blocker("empirical_assertion_universe_assertions_missing".into())?
    }
    let mut ids = BTreeSet::new();
    for value in &reader.presentations {
        let id = value["declaration"]["surfaceId"]
            .as_str()
            .ok_or_else(refused)?;
        if !ids.insert(id.to_owned()) {
            let blocker = json!(format!("empirical_presentation_surface_id_duplicate:{id}"));
            budget(reader.all().chain([&blocker]))?;
            reader.blockers.push(blocker)
        }
    }
    // Explicit null authority/IR support ports have no accepted surface branch.
    if !reader.supports.is_empty() || !reader.surfaces.is_empty() {
        return Err(refused());
    }
    let mut artifacts = Vec::new();
    for value in &reader.presentations {
        if !value["artifact"].is_null() {
            budget(
                reader
                    .all()
                    .chain(artifacts.iter())
                    .chain([&value["artifact"]]),
            )?;
            artifacts.push(value["artifact"].clone())
        }
    }
    artifacts.sort_by(|a, b| {
        collator.compare(
            a["path"].as_str().unwrap_or_default(),
            b["path"].as_str().unwrap_or_default(),
        )
    });
    let mut corpus_assertions = Vec::new();
    for value in &reader.assertions {
        projected_budget(
            reader.all().chain(corpus_assertions.iter()).chain([value]),
            12,
            256,
        )?;
        corpus_assertions.push(json!({"assertionId":value["declaration"]["assertionId"],"authorityEntryHash":value["declaration"]["authorityEntryHash"],"manuscriptPath":value["manuscriptPath"],"markerByteStart":value["markerByteStart"],"markerByteEnd":value["markerByteEnd"],"manuscriptByteStart":value["manuscriptByteStart"],"manuscriptByteEnd":value["manuscriptByteEnd"],"manuscriptContentHash":value["manuscriptContentHash"]}))
    }
    let mut corpus_presentations = Vec::new();
    for value in &reader.presentations {
        projected_budget(
            reader
                .all()
                .chain(corpus_assertions.iter())
                .chain(corpus_presentations.iter())
                .chain([value]),
            20,
            512,
        )?;
        corpus_presentations.push(json!({"surfaceId":value["declaration"]["surfaceId"],"surfaceKind":value["declaration"]["surfaceKind"],"surfaceAuthorityEntryHash":value["declaration"]["surfaceAuthorityEntryHash"],"artifactPath":value["declaration"]["artifactPath"],"artifactHash":value["artifact"]["hash"],"artifactBytes":value["artifact"]["bytes"],"manuscriptPath":value["manuscriptPath"],"markerByteStart":value["markerByteStart"],"markerByteEnd":value["markerByteEnd"],"manuscriptByteStart":value["manuscriptByteStart"],"manuscriptByteEnd":value["manuscriptByteEnd"],"manuscriptContentHash":value["manuscriptContentHash"]}))
    }
    budget(
        reader
            .all()
            .chain(corpus_assertions.iter())
            .chain(corpus_presentations.iter())
            .chain(artifacts.iter()),
    )?;
    let corpus = json!({"manuscriptPath":manuscript,"trustedEmpiricalClaimUniverseHash":claim_hash,"trustedFormalSupportAuthorityHash":null,"trustedManuscriptIrHash":null,"sourceCorpusHash":source_hash,"assertions":corpus_assertions,"presentations":corpus_presentations,"formalSupports":[],"evidenceBoundSurfaces":[]});
    let corpus_hash = hash("EmpiricalAssertionManuscriptCorpus", &corpus)?;
    drop(corpus);
    let mut seen = BTreeSet::new();
    reader
        .blockers
        .retain(|v| seen.insert(v.as_str().unwrap_or_default().to_owned()));
    budget(reader.all().chain(artifacts.iter()))?;
    let mut observed = json!({"version":1,"kind":"EmpiricalAssertionUniverse","status":if reader.blockers.is_empty(){"empirical_assertion_universe_verified"}else{"empirical_assertion_universe_blocked"},"manuscriptPath":manuscript,"trustedEmpiricalClaimUniverseHash":claim_hash,"trustedFormalSupportAuthorityHash":null,"trustedManuscriptIrHash":null,"manuscriptCorpusHash":corpus_hash,"sourceCorpusHash":source_hash,"files":reader.files,"assertions":reader.assertions,"presentations":reader.presentations,"formalSupports":reader.supports,"evidenceBoundSurfaces":reader.surfaces,"presentationArtifacts":artifacts,"blockers":reader.blockers});
    budget([&observed])?;
    observed["empiricalAssertionUniverseHash"] =
        json!(hash("EmpiricalAssertionUniverse", &observed)?);
    source.assert_current()?;
    if let Some(claim) = &claim {
        claim.verify_unchanged()?
    }
    check(c, deadline)?;
    Ok(NativeEmpiricalAssertionUniverseObservationV1 {
        source,
        claim,
        observed,
    })
}
#[cfg(test)]
mod tests;
