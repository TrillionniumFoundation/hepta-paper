//! Process worker entry point for the Rust-native business capability kernel.

#![forbid(unsafe_code)]

use base64ct::{Base64, Encoding};
use hepta_control_plane::ExecutionRequestV1;
use hepta_paper_service::native_business::{
    NativeBusinessError, NativeBusinessJobV1, execute_native_business_v1,
    native_business_implementation_hash_v1,
};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::io::{self, Read, Write};

const MAX_STDIN_BYTES: usize = 16 * 1024 * 1024;
const MAX_STDOUT_BYTES: usize = 32 * 1024 * 1024;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct WorkerEnvelopeV1 {
    version: u16,
    execution: ExecutionRequestV1,
    input: NativeBusinessJobV1,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct WorkerResponseV1 {
    version: u16,
    artifacts: Vec<String>,
    evidence: Value,
    external_action_may_have_started: bool,
}

fn run_bytes(input: &[u8]) -> Result<Vec<u8>, NativeBusinessError> {
    if input.is_empty() || input.len() > MAX_STDIN_BYTES {
        return Err(NativeBusinessError::Contract);
    }
    let envelope: WorkerEnvelopeV1 =
        serde_json::from_slice(input).map_err(|_| NativeBusinessError::Encoding)?;
    if envelope.version != 1 {
        return Err(NativeBusinessError::Contract);
    }
    let output = execute_native_business_v1(envelope.input)?;
    let artifacts = output
        .artifacts
        .iter()
        .map(|artifact| Base64::encode_string(artifact))
        .collect();
    let evidence = json!({
        "kind": "NativeBusinessWorkerEvidenceV1",
        "version": 1,
        "implementationHash": native_business_implementation_hash_v1(),
        "attemptId": envelope.execution.attempt_id,
        "snapshotHash": envelope.execution.snapshot_hash,
        "planHash": envelope.execution.plan_hash,
        "candidateId": envelope.execution.candidate.candidate_id,
        "moduleId": envelope.execution.candidate.module_id,
        "moduleVersion": envelope.execution.candidate.module_version,
        "capabilityId": envelope.execution.candidate.capability_id,
        "businessEvidence": output.evidence,
        "externalActionMayHaveStarted": false
    });
    let response = WorkerResponseV1 {
        version: 1,
        artifacts,
        evidence,
        external_action_may_have_started: false,
    };
    let bytes = serde_json::to_vec(&response).map_err(|_| NativeBusinessError::Encoding)?;
    if bytes.len() > MAX_STDOUT_BYTES {
        return Err(NativeBusinessError::OutputLimit);
    }
    Ok(bytes)
}

fn run() -> Result<Vec<u8>, NativeBusinessError> {
    let mut input = Vec::new();
    io::stdin()
        .lock()
        .take((MAX_STDIN_BYTES + 1) as u64)
        .read_to_end(&mut input)
        .map_err(|_| NativeBusinessError::Encoding)?;
    run_bytes(&input)
}

fn main() {
    let status = match run() {
        Ok(output) => {
            let mut stdout = io::stdout().lock();
            if stdout.write_all(&output).is_ok() && stdout.flush().is_ok() {
                0
            } else {
                1
            }
        }
        Err(_) => 1,
    };
    std::process::exit(status);
}
