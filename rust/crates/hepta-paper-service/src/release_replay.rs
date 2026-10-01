//! Native replay calculations. Differential evidence observes actual legacy
//! reference bytes; these calculations grant no signing or release authority.
pub(crate) mod local_signature;
pub mod production_core;
pub mod python_ast;
pub mod referee;

use serde::Deserialize;
use serde_json::{Value, json};

/// A closed deterministic input envelope, shared byte-for-byte by independent
/// runtimes. It supplies examples, never a claimed acceptance result.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ProductionReplayCorpusV1 {
    version: u16,
    created_at: String,
    base_snapshots: Vec<Value>,
    extended_snapshots: Vec<Value>,
    artifact_cases: Vec<Value>,
    frontier_cases: Vec<Value>,
    shard_cases: Vec<ShardCase>,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ShardCase {
    frontier: Value,
    worker_limit: Value,
}

pub const PRODUCTION_REPLAY_CORPUS_V1: &str =
    include_str!("release_replay/production-corpus.v1.json");

pub fn evaluate_production_replay_corpus_v1(bytes: &[u8]) -> Result<Value, String> {
    if bytes.len() >= 4 * 1024 * 1024 {
        return Err("release_replay_corpus_too_large".into());
    }
    let tree: Value =
        serde_json::from_slice(bytes).map_err(|_| "release_replay_corpus_invalid".to_string())?;
    production_core::budget(&[&tree])?;
    let corpus: ProductionReplayCorpusV1 =
        serde_json::from_slice(bytes).map_err(|_| "release_replay_corpus_invalid".to_string())?;
    if corpus.version != 1
        || corpus.shard_cases.len() > 1024
        || corpus.frontier_cases.len() > 1024
        || corpus.artifact_cases.len() > 1024
        || corpus.base_snapshots.len() > 1024
        || corpus.extended_snapshots.len() > 1024
    {
        return Err("release_replay_corpus_invalid".into());
    }
    let evaluate = |snapshots: &[Value]| -> Result<Value, String> {
        let evaluations = snapshots
            .iter()
            .map(production_core::evaluate_snapshot_v1)
            .collect::<Result<Vec<_>, _>>()?;
        let single_audits = snapshots
            .iter()
            .map(|v| {
                production_core::audit_v1(
                    std::slice::from_ref(v),
                    "single",
                    &corpus.created_at,
                    &[],
                )
            })
            .collect::<Result<Vec<_>, _>>()?;
        let single_frontiers = single_audits
            .iter()
            .map(production_core::frontier_v1)
            .collect::<Result<Vec<_>, _>>()?;
        Ok(
            json!({"evaluations":evaluations,"summary":production_core::summarize_v1(&evaluations)?,
            "audit":production_core::audit_v1(snapshots,"differential",&corpus.created_at,&[json!("fixture-skip")])?,
            "singleFrontiers":single_frontiers}),
        )
    };
    Ok(
        json!({"base":evaluate(&corpus.base_snapshots)?,"extended":evaluate(&corpus.extended_snapshots)?,
        "artifactCases":corpus.artifact_cases.iter().map(production_core::resolve_artifact_v1).collect::<Result<Vec<_>,_>>()?,
        "frontierCases":corpus.frontier_cases.iter().map(production_core::frontier_v1).collect::<Result<Vec<_>,_>>()?,
        "shardCases":corpus.shard_cases.iter().map(|v| production_core::shard_v1(&v.frontier,&v.worker_limit)).collect::<Result<Vec<_>,_>>()?}),
    )
}

pub const REFEREE_REPLAY_CORPUS_V1: &str = include_str!("release_replay/referee-corpus.v1.json");

mod execution;
pub use execution::{
    ReleaseAttestationMeasuredPolicyReplayRequestV8,
    ReleaseAttestationNativeAstPolicyReplayRequestV9,
    ReleaseAttestationNativeRetirementPolicyReplayRequestV10,
    ReleaseAttestationPolicyReplayRequestV4, ReleaseAttestationReplayRequestV3,
    inspect_release_attestation_measured_policy_replay_with_cancellation_v8,
    inspect_release_attestation_native_ast_policy_replay_with_cancellation_v9,
    inspect_release_attestation_native_retirement_policy_replay_with_cancellation_v10,
    inspect_release_attestation_policy_replay_v4,
    inspect_release_attestation_policy_replay_with_cancellation_v4,
    inspect_release_attestation_replay_v3, inspect_release_attestation_replay_with_cancellation_v3,
};

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct RefereeReplayCorpusV1 {
    version: u16,
    base_case_count: usize,
    cases: Vec<Value>,
}

pub fn evaluate_referee_replay_corpus_v1(bytes: &[u8]) -> Result<Value, String> {
    if bytes.len() >= 4 * 1024 * 1024 {
        return Err("release_replay_referee_corpus_too_large".into());
    }
    let corpus: RefereeReplayCorpusV1 = serde_json::from_slice(bytes)
        .map_err(|_| "release_replay_referee_corpus_invalid".to_string())?;
    if corpus.version != 1
        || corpus.cases.len() > 1024
        || corpus.base_case_count > corpus.cases.len()
    {
        return Err("release_replay_referee_corpus_invalid".into());
    }
    production_core::budget(&[&json!(corpus.cases)])?;
    let actual = corpus
        .cases
        .iter()
        .map(referee::evaluate_referee_case_v1)
        .collect::<Result<Vec<_>, _>>()?;
    Ok(json!({"baseCaseCount":corpus.base_case_count,"actual":actual}))
}

pub const REPLAY_ORACLE_INPUT_GUARD_V1: &str =
    include_str!("release_replay/oracle-input-guard.mjs");
