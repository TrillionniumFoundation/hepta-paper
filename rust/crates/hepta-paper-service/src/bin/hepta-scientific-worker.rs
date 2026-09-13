//! First-party Rust worker for explicitly pinned local scientific tool execution.
use base64ct::{Base64, Encoding};
use hepta_control_plane::ExecutionRequestV1;
use hepta_paper_service::{
    WorkerResponseV1,
    scientific_runtime::{
        ScientificJobV1, execute_scientific_job_v1, read_scientific_job_v1,
        read_scientific_profile_v1, scientific_file_hash_v1, scientific_job_hash_v1,
    },
};
use serde::Deserialize;
use std::{
    env,
    io::{self, Read, Write},
    path::Path,
};

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Envelope {
    version: u16,
    execution: ExecutionRequestV1,
    input: ScientificJobV1,
}
fn execute() -> Result<(), Box<dyn std::error::Error>> {
    let args: Vec<String> = env::args().skip(1).collect();
    if args.len() != 2 {
        return Err("profile path and exact digest required".into());
    }
    if args[0] == "job-hash" {
        println!(
            "{}",
            scientific_job_hash_v1(&read_scientific_job_v1(Path::new(&args[1]))?)?
        );
        return Ok(());
    }
    if args[0] == "file-hash" {
        println!("{}", scientific_file_hash_v1(Path::new(&args[1]))?);
        return Ok(());
    }
    let profile = read_scientific_profile_v1(Path::new(&args[0]), &args[1].parse()?)?;
    let mut bytes = Vec::new();
    io::stdin().take(1_048_577).read_to_end(&mut bytes)?;
    if bytes.len() > 1_048_576 {
        return Err("input exceeds bound".into());
    }
    let request: Envelope = serde_json::from_slice(&bytes)?;
    if request.version != 1
        || request.execution.version != 1
        || request.execution.snapshot_hash != request.execution.candidate.snapshot_hash
        || request.execution.candidate.resources.provider_calls != 0
        || request.execution.candidate.resources.external_actions != 0
        || request.execution.candidate.resources.central_writer_turns != 0
    {
        return Err("unsupported version".into());
    }
    let output = execute_scientific_job_v1(
        &profile,
        request.input,
        &request.execution.candidate.capability_id,
    )?;
    let response = WorkerResponseV1 {
        version: 1,
        artifacts: output
            .artifacts
            .iter()
            .map(|b| Base64::encode_string(b))
            .collect(),
        evidence: serde_json::json!({
            "kind":"ScientificWorkerEvidenceV1", "version":1,
            "attemptId":request.execution.attempt_id, "snapshotHash":request.execution.snapshot_hash,
            "planHash":request.execution.plan_hash,
            "candidateHash":request.execution.candidate.candidate_hash()?,
            "runtimeEvidence":output.evidence,
        }),
        // Only a pinned trusted-local no-external-effects profile is supported.
        // This response cannot grant production or scientific qualification.
        external_action_may_have_started: false,
    };
    let bytes = serde_json::to_vec(&response)?;
    if bytes.len() > 1_048_576 {
        return Err("output exceeds transport bound".into());
    }
    let mut stdout = io::stdout().lock();
    stdout.write_all(&bytes)?;
    stdout.flush()?;
    Ok(())
}
fn main() {
    if execute().is_err() {
        eprintln!("scientific worker rejected; retain private attempt state for reconciliation");
        std::process::exit(1);
    }
}
