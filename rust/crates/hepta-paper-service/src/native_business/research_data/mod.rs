//! Actual CAS-backed data workers; their reports do not grant scientific acceptance.

mod assertions;
mod csv;
mod values;

use std::sync::atomic::{AtomicBool, Ordering};

use hepta_codex_protocol::Sha256Digest;
use hepta_legacy_compatibility::{
    ProductionJsonValue, parse_production_json_v1, production_json_stringify_with_limits_v1,
};
use serde::{Deserialize, Serialize};
use serde_json::json;

use super::{NativeBusinessError, NativeBusinessOutputV1, hash_bytes};
use crate::ObjectStoreV1;

const MAX_INPUT_BYTES: u64 = 4 * 1024 * 1024;
const MAX_INPUTS: usize = 64;
const MAX_PARAMETERS_BYTES: usize = 64 * 1024;
const MAX_NODES: usize = 100_000;
const MAX_DEPTH: usize = 64;

/// Fixed non-executing worker variants from the original research adapter.
#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum NativeResearchDataWorkerTypeV1 {
    ArtifactIntegrity,
    CsvDescriptiveStatistics,
    JsonAssertions,
}

impl NativeResearchDataWorkerTypeV1 {
    fn name(self) -> &'static str {
        match self {
            Self::ArtifactIntegrity => "artifact_integrity",
            Self::CsvDescriptiveStatistics => "csv_descriptive_statistics",
            Self::JsonAssertions => "json_assertions",
        }
    }
}

/// One named input backed by the worker-owned immutable CAS.
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct NativeResearchDataInputV1 {
    pub role: String,
    pub path: String,
    pub hash: Sha256Digest,
    pub expected_hash: Sha256Digest,
}

/// Closed v1 resources: 64 inputs, 4 MiB total, 64 KiB parameters, no execution authority.
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct NativeResearchDataWorkerRequestV1 {
    pub version: u16,
    pub worker_type: NativeResearchDataWorkerTypeV1,
    /// Exact original JSON text survives the existing workflow Value template.
    pub parameters_json: String,
    pub inputs: Vec<NativeResearchDataInputV1>,
}

/// Execute actual bytes through the original worker's data calculation contract.
/// Every selected CAS object is independently verified before and after computation.
pub fn execute_native_research_data_worker_v1(
    objects: &ObjectStoreV1,
    request: NativeResearchDataWorkerRequestV1,
    cancelled: &AtomicBool,
) -> Result<NativeBusinessOutputV1, NativeBusinessError> {
    check_cancel(cancelled)?;
    if request.version != 1
        || request.inputs.len() > MAX_INPUTS
        || request.parameters_json.len() > MAX_PARAMETERS_BYTES
    {
        return Err(NativeBusinessError::Contract);
    }
    let parameters = parse_production_json_v1(request.parameters_json.as_bytes())
        .map_err(|_| NativeBusinessError::Encoding)?;
    validate_value(&parameters)?;
    let mut observed = Vec::new();
    let mut total = 0_u64;
    for input in &request.inputs {
        check_cancel(cancelled)?;
        validate_input(input)?;
        let bytes = objects
            .read_with_maximum_v1(&input.hash, MAX_INPUT_BYTES.saturating_sub(total).max(1))
            .map_err(|_| NativeBusinessError::Contract)?;
        total = total
            .checked_add(bytes.len() as u64)
            .ok_or(NativeBusinessError::Contract)?;
        if total > MAX_INPUT_BYTES {
            return Err(NativeBusinessError::Contract);
        }
        observed.push(bytes);
    }
    let report = match request.worker_type {
        NativeResearchDataWorkerTypeV1::ArtifactIntegrity => values::object([
            ("status", values::text("native_research_worker_passed")),
            ("artifactCount", values::number(request.inputs.len() as f64)),
            (
                "artifacts",
                ProductionJsonValue::Array(
                    request
                        .inputs
                        .iter()
                        .map(|input| {
                            values::object([
                                ("role", values::text(&input.role)),
                                ("path", values::text(&input.path)),
                                ("hash", values::text(&input.hash.to_string())),
                                (
                                    "verified",
                                    ProductionJsonValue::Bool(input.hash == input.expected_hash),
                                ),
                            ])
                        })
                        .collect(),
                ),
            ),
        ]),
        NativeResearchDataWorkerTypeV1::CsvDescriptiveStatistics => {
            csv::inspect(&parameters, &observed, cancelled)?
        }
        NativeResearchDataWorkerTypeV1::JsonAssertions => {
            assertions::inspect(&parameters, &observed, cancelled)?
        }
    };
    check_cancel(cancelled)?;
    let bytes = production_json_stringify_with_limits_v1(&report, assertions::limits(), cancelled)
        .map_err(|_| NativeBusinessError::OutputLimit)?;
    if bytes.len() as u64 > MAX_INPUT_BYTES {
        return Err(NativeBusinessError::OutputLimit);
    }
    for (input, original) in request.inputs.iter().zip(&observed) {
        check_cancel(cancelled)?;
        if objects
            .read_with_maximum_v1(&input.hash, MAX_INPUT_BYTES)
            .map_err(|_| NativeBusinessError::Contract)?
            != *original
        {
            return Err(NativeBusinessError::Contract);
        }
    }
    check_cancel(cancelled)?;
    Ok(NativeBusinessOutputV1 {
        evidence: json!({
            "kind":"NativeResearchDataWorkerEvidenceV1",
            "workerType":request.worker_type.name(),
            "inputHashes":request.inputs.iter().map(|input|input.hash.to_string()).collect::<Vec<_>>(),
            "reportHash":hash_bytes(&bytes),
            "scientificAcceptance":false,
            "externalEffectAuthorized":false,
        }),
        artifacts: vec![bytes],
    })
}

fn validate_input(input: &NativeResearchDataInputV1) -> Result<(), NativeBusinessError> {
    super::validate_inline_text(&input.role, 128)?;
    super::validate_inline_text(&input.path, 4096)?;
    if input.path.starts_with('/')
        || input
            .path
            .split('/')
            .any(|part| part.is_empty() || matches!(part, "." | ".."))
        || input.path.contains('\\')
    {
        return Err(NativeBusinessError::Contract);
    }
    Ok(())
}

fn validate_value(value: &ProductionJsonValue) -> Result<(), NativeBusinessError> {
    fn visit(
        value: &ProductionJsonValue,
        depth: usize,
        nodes: &mut usize,
    ) -> Result<(), NativeBusinessError> {
        *nodes = nodes.checked_add(1).ok_or(NativeBusinessError::Contract)?;
        if *nodes > MAX_NODES || depth > MAX_DEPTH {
            return Err(NativeBusinessError::Contract);
        }
        match value {
            ProductionJsonValue::Array(values) => {
                for value in values {
                    visit(value, depth + 1, nodes)?;
                }
            }
            ProductionJsonValue::Object(values) => {
                for (_, value) in values {
                    visit(value, depth + 1, nodes)?;
                }
            }
            _ => (),
        }
        Ok(())
    }
    visit(value, 0, &mut 0)
}

fn check_cancel(cancelled: &AtomicBool) -> Result<(), NativeBusinessError> {
    if cancelled.load(Ordering::SeqCst) {
        Err(NativeBusinessError::Contract)
    } else {
        Ok(())
    }
}

#[cfg(test)]
mod tests;
