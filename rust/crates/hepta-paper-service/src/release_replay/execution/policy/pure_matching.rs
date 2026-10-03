//! Same-input native calculations over the existing bounded fixed oracles.
//! These receipts cover the named pure corpus only, never an entire Node suite.
use super::super::{Owner, Tool, digest, error};
use crate::release_replay::{
    PRODUCTION_REPLAY_CORPUS_V1, REFEREE_REPLAY_CORPUS_V1, REPLAY_ORACLE_INPUT_GUARD_V1,
    evaluate_production_replay_corpus_v1, evaluate_referee_replay_corpus_v1,
};
use serde_json::{Value, json};
use std::collections::BTreeMap;

pub(super) fn inspect(owner: &Owner<'_>, node: &Tool) -> Result<BTreeMap<String, Value>, String> {
    owner.remaining()?;
    let native_p0 = evaluate_production_replay_corpus_v1(PRODUCTION_REPLAY_CORPUS_V1.as_bytes())?;
    owner.remaining()?;
    let script = format!(
        "{REPLAY_ORACLE_INPUT_GUARD_V1}\n{}",
        include_str!("../../production-oracle.mjs")
    );
    let (node_p0, process_p0) = owner.oracle(node, &script, PRODUCTION_REPLAY_CORPUS_V1)?;
    let artifacts = native_p0["artifactCases"]
        .as_array()
        .filter(|v| v.len() >= 4)
        .ok_or_else(|| error("compiled_corpus_invalid"))?;
    if native_p0 != node_p0["actual"]
        || native_p0["base"] != node_p0["archivedPython"]["base"]
        || json!(artifacts[..4]) != node_p0["archivedPython"]["artifactCases"]
    {
        return Err(error("production_differential_mismatch"));
    }
    owner.remaining()?;
    let native_p1 = evaluate_referee_replay_corpus_v1(REFEREE_REPLAY_CORPUS_V1.as_bytes())?;
    let cases = native_p1["actual"]
        .as_array()
        .ok_or_else(|| error("compiled_corpus_invalid"))?;
    let base = native_p1["baseCaseCount"]
        .as_u64()
        .and_then(|v| usize::try_from(v).ok())
        .filter(|v| *v <= cases.len())
        .ok_or_else(|| error("compiled_corpus_invalid"))?;
    owner.remaining()?;
    let script = format!(
        "{REPLAY_ORACLE_INPUT_GUARD_V1}\n{}",
        include_str!("../../referee-oracle.mjs")
    );
    let (node_p1, process_p1) = owner.oracle(node, &script, REFEREE_REPLAY_CORPUS_V1)?;
    if native_p1["actual"] != node_p1["actual"] || json!(cases[..base]) != node_p1["archivedPython"]
    {
        return Err(error("referee_differential_mismatch"));
    }
    owner.remaining()?;
    let encode = |v: &Value| {
        serde_json::to_vec(v)
            .map(|bytes| digest(&bytes))
            .map_err(|_| error("pure_match_output_invalid"))
    };
    Ok(BTreeMap::from([
        (
            "migration/tests/p0-production-core-differential.mjs".into(),
            json!({"status":"same_input_fixed_pure_corpus_matched","rustCallableOwner":"evaluate_production_replay_corpus_v1","inputSha256":digest(PRODUCTION_REPLAY_CORPUS_V1.as_bytes()),"nativeOutputSha256":encode(&native_p0)?,"sameInputRustNodeVerified":true,"archivedPythonBaselineVerified":true,"fullSuiteContractMatched":false,"scope":"six_pure_calculations_fixed_bounded_parameter_corpus","process":process_p0}),
        ),
        (
            "migration/tests/p1-referee-revision-differential.mjs".into(),
            json!({"status":"same_input_fixed_pure_corpus_matched","rustCallableOwner":"evaluate_referee_replay_corpus_v1","inputSha256":digest(REFEREE_REPLAY_CORPUS_V1.as_bytes()),"nativeOutputSha256":encode(&native_p1)?,"caseCount":cases.len(),"originalArchiveCaseCount":base,"sameInputRustNodeVerified":true,"archivedPythonBaselineVerified":true,"fullSuiteContractMatched":false,"scope":"eight_pure_request_resync_ready_merge_post_apply_calculations_fixed_bounded_parameter_corpus","safeApplyCommandContractMigration":"legacy_merge_queue_to_hepta_safe_apply_plan","process":process_p1}),
        ),
    ]))
}
