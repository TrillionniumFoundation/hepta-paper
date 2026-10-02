//! Prepare actual plan-backed data jobs for the existing worker service.
//!
//! Immutable CAS identity is observed here. Filesystem provenance, scientific
//! acceptance, independent review, and ordinary batch admission are separate.

use std::{
    collections::{BTreeMap, BTreeSet},
    sync::atomic::{AtomicBool, Ordering},
};

use hepta_codex_protocol::Sha256Digest;
use hepta_legacy_compatibility::{
    ProductionJsonValue as V, parse_production_json_v1, production_json_stringify_v1,
};
use serde::{Deserialize, Serialize};

use crate::{
    NativeJobV1, ObjectStoreV1,
    native_business::{
        NativeBusinessJobV1,
        research_data::{
            NativeResearchDataInputV1, NativeResearchDataWorkerRequestV1,
            NativeResearchDataWorkerTypeV1,
        },
    },
};

const MAX_PLAN_BYTES: u64 = 256 * 1024;
const MAX_INPUT_BYTES: u64 = 4 * 1024 * 1024;

/// The actual plan object and exact source-path to immutable-object bindings.
/// This request has no executable, trust declaration, or authorizing flag.
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct NativeResearchPlanRequestV1 {
    pub version: u16,
    pub paper_id: String,
    pub task_key: String,
    pub plan_object: Sha256Digest,
    pub source_objects: BTreeMap<String, Sha256Digest>,
}

/// A real typed service payload derived from the held plan, never a caller job.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PreparedNativeResearchDataJobV1 {
    pub worker_id: String,
    pub claim_ids: Vec<String>,
    pub job: NativeJobV1,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PreparedNativeResearchPlanV1 {
    pub version: u16,
    pub kind: &'static str,
    pub paper_id: String,
    pub task_key: String,
    pub plan_hash: Sha256Digest,
    pub jobs: Vec<PreparedNativeResearchDataJobV1>,
    pub scientific_acceptance: bool,
    pub external_effect_authorized: bool,
}

fn refusal() -> String {
    "native_research_plan_data_domain_v1_refused".into()
}
fn check(cancelled: &AtomicBool) -> Result<(), String> {
    if cancelled.load(Ordering::SeqCst) {
        Err("native_research_plan_cancelled".into())
    } else {
        Ok(())
    }
}
fn field<'a>(value: &'a V, name: &str) -> Option<&'a V> {
    let name: Vec<_> = name.encode_utf16().collect();
    match value {
        V::Object(fields) => fields.iter().find(|(key, _)| *key == name).map(|(_, v)| v),
        _ => None,
    }
}
fn string(value: Option<&V>, maximum: usize) -> Result<String, String> {
    let Some(V::String(units)) = value else {
        return Err(refusal());
    };
    let text = String::from_utf16(units).map_err(|_| refusal())?;
    inline(&text, maximum)?;
    Ok(text)
}
fn inline(text: &str, maximum: usize) -> Result<(), String> {
    if text.is_empty() || text.len() > maximum || text.chars().any(char::is_control) {
        Err(refusal())
    } else {
        Ok(())
    }
}
fn relative(text: &str) -> Result<(), String> {
    inline(text, 4096)?;
    if text.starts_with('/')
        || text.contains('\\')
        || text
            .split('/')
            .any(|part| part.is_empty() || matches!(part, "." | ".."))
    {
        Err(refusal())
    } else {
        Ok(())
    }
}
fn worker_type(value: Option<&V>) -> Result<NativeResearchDataWorkerTypeV1, String> {
    match string(value, 64)?.as_str() {
        "artifact_integrity" => Ok(NativeResearchDataWorkerTypeV1::ArtifactIntegrity),
        "csv_descriptive_statistics" => {
            Ok(NativeResearchDataWorkerTypeV1::CsvDescriptiveStatistics)
        }
        "json_assertions" => Ok(NativeResearchDataWorkerTypeV1::JsonAssertions),
        _ => Err("native_research_plan_non_data_worker_requires_existing_scientific_owner".into()),
    }
}

fn prepare_worker(
    worker: &V,
    request: &NativeResearchPlanRequestV1,
    observed: &BTreeMap<String, Vec<u8>>,
) -> Result<PreparedNativeResearchDataJobV1, String> {
    let id = string(field(worker, "id"), 64)?;
    if !id.as_bytes()[0].is_ascii_alphanumeric()
        || !id
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'_' | b'-'))
        || string(field(worker, "evidenceClass"), 64)? != "research_evidence"
        || !matches!(field(worker, "syntheticInput"), Some(V::Bool(false)))
        || !matches!(field(worker, "outcomesPreprogrammed"), Some(V::Bool(false)))
    {
        return Err(refusal());
    }
    let worker_type = worker_type(field(worker, "type"))?;
    let Some(V::Array(claims)) = field(worker, "claimIds") else {
        return Err(refusal());
    };
    if claims.is_empty() || claims.len() > 128 {
        return Err(refusal());
    }
    let claim_ids = claims
        .iter()
        .map(|v| string(Some(v), 256))
        .collect::<Result<Vec<_>, _>>()?;
    let Some(V::Array(specs)) = field(worker, "inputs") else {
        return Err(refusal());
    };
    if specs.is_empty() || specs.len() > 64 {
        return Err(refusal());
    }
    let mut inputs = Vec::new();
    let mut total = 0_u64;
    for spec in specs {
        let path = string(field(spec, "path"), 4096)?;
        relative(&path)?;
        let expected_hash = string(field(spec, "sha256"), 71)?
            .parse::<Sha256Digest>()
            .map_err(|_| refusal())?;
        let hash = request.source_objects.get(&path).ok_or_else(refusal)?;
        if *hash != expected_hash {
            return Err("native_research_plan_actual_input_hash_mismatch".into());
        }
        total = total
            .checked_add(observed.get(&path).ok_or_else(refusal)?.len() as u64)
            .ok_or_else(refusal)?;
        if total > MAX_INPUT_BYTES {
            return Err(refusal());
        }
        let role = match field(spec, "role") {
            None | Some(V::Null) => "research_worker_input".into(),
            value => string(value, 128)?,
        };
        inputs.push(NativeResearchDataInputV1 {
            role,
            path,
            hash: hash.clone(),
            expected_hash,
        });
    }
    let empty = V::Object(Vec::new());
    let parameters = field(worker, "parameters").unwrap_or(&empty);
    let parameters = match parameters {
        V::Null | V::Bool(false) => &empty,
        _ => parameters,
    };
    let parameters_json =
        String::from_utf8(production_json_stringify_v1(parameters).map_err(|_| refusal())?)
            .map_err(|_| refusal())?;
    if parameters_json.len() > 64 * 1024 {
        return Err(refusal());
    }
    Ok(PreparedNativeResearchDataJobV1 {
        worker_id: id,
        claim_ids,
        job: NativeJobV1::Business {
            job: NativeBusinessJobV1::ResearchDataWorkerV1 {
                request: NativeResearchDataWorkerRequestV1 {
                    version: 1,
                    worker_type,
                    parameters_json,
                    inputs,
                },
            },
        },
    })
}

/// Read the actual immutable plan and every supplied input before creating jobs.
/// The same objects are checked again before returning to a normal queue caller.
pub fn prepare_native_research_data_plan_v1(
    objects: &ObjectStoreV1,
    request: NativeResearchPlanRequestV1,
    cancelled: &AtomicBool,
) -> Result<PreparedNativeResearchPlanV1, String> {
    prepare_native_research_data_plan_from_request_v1(objects, &request, cancelled)
}

pub(crate) fn prepare_native_research_data_plan_from_request_v1(
    objects: &ObjectStoreV1,
    request: &NativeResearchPlanRequestV1,
    cancelled: &AtomicBool,
) -> Result<PreparedNativeResearchPlanV1, String> {
    check(cancelled)?;
    if request.version != 1
        || request.source_objects.is_empty()
        || request.source_objects.len() > 128
    {
        return Err(refusal());
    }
    inline(&request.paper_id, 256)?;
    inline(&request.task_key, 512)?;
    let bytes = objects
        .read_with_maximum_v1(&request.plan_object, MAX_PLAN_BYTES)
        .map_err(|_| refusal())?;
    let plan = parse_production_json_v1(&bytes).map_err(|_| refusal())?;
    if !matches!(field(&plan, "version"), Some(V::Number(n)) if *n == 1.0)
        || string(field(&plan, "kind"), 64)? != "NativeResearchWorkerPlan"
        || string(field(&plan, "paperId"), 256)? != request.paper_id
        || string(field(&plan, "taskKey"), 512)? != request.task_key
    {
        return Err(refusal());
    }
    let Some(V::Array(workers)) = field(&plan, "workers") else {
        return Err(refusal());
    };
    if workers.is_empty() || workers.len() > 16 {
        return Err(refusal());
    }
    let mut observed = BTreeMap::new();
    let mut total = 0_u64;
    for (path, hash) in &request.source_objects {
        check(cancelled)?;
        relative(path)?;
        let maximum = MAX_INPUT_BYTES
            .checked_sub(total)
            .ok_or_else(refusal)?
            .max(1);
        let data = objects
            .read_with_maximum_v1(hash, maximum)
            .map_err(|_| refusal())?;
        total = total.checked_add(data.len() as u64).ok_or_else(refusal)?;
        if total > MAX_INPUT_BYTES {
            return Err(refusal());
        }
        observed.insert(path.clone(), data);
    }
    let mut ids = BTreeSet::new();
    let mut jobs = Vec::new();
    for worker in workers {
        check(cancelled)?;
        let job = prepare_worker(worker, request, &observed)?;
        if !ids.insert(job.worker_id.clone()) {
            return Err(refusal());
        }
        jobs.push(job);
    }
    for (path, hash) in &request.source_objects {
        check(cancelled)?;
        if objects
            .read_with_maximum_v1(hash, observed[path].len().max(1) as u64)
            .map_err(|_| refusal())?
            != observed[path]
        {
            return Err(refusal());
        }
    }
    if objects
        .read_with_maximum_v1(&request.plan_object, MAX_PLAN_BYTES)
        .map_err(|_| refusal())?
        != bytes
    {
        return Err(refusal());
    }
    check(cancelled)?;
    Ok(PreparedNativeResearchPlanV1 {
        version: 1,
        kind: "PreparedNativeResearchDataPlanV1",
        paper_id: request.paper_id.clone(),
        task_key: request.task_key.clone(),
        plan_hash: request.plan_object.clone(),
        jobs,
        scientific_acceptance: false,
        external_effect_authorized: false,
    })
}

#[cfg(test)]
mod tests;
