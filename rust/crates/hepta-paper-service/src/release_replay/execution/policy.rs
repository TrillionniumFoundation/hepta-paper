//! Native matrix policy calculations over independently captured source bytes.
//! Fixed Node suites are explicit differential observers, never product owners.
mod archive;
mod build_package_policy;
mod command_policy;
mod current_worker;
mod facts;
#[cfg(test)]
mod fixture_test_support;
mod measured_profile;
mod native_profile;
mod node_assets;
mod node_packages;
mod private_tree;
mod pure_matching;
mod research_policy;
mod retirement_policy;
mod runner_contract;
use super::{Owner, ReleaseAttestationReplayRequestV3, SourceGraph, Tool, digest, error};
use archive::PinnedArchive;
use facts::{Matrix, Reference, graph_paths, inspect_rows, validate_contract};
use hepta_codex_runtime::{
    BoundedProcessRequestV1, EnvironmentPolicyV1, ProcessLimitsV1, ProcessTerminationReason,
    RestrictedEnvironmentV1, run_bounded_process_capturing_stdout_with_cancellation,
};
use hepta_control_plane::canonical_hash_v1;
pub use measured_profile::ReleaseAttestationMeasuredPolicyReplayRequestV8;
use measured_profile::SourceLimits;
pub use native_profile::{
    ReleaseAttestationNativeAstPolicyReplayRequestV9,
    ReleaseAttestationNativeBuildPackagePolicyReplayRequestV11,
    ReleaseAttestationNativeCommandDispositionPolicyReplayRequestV12,
    ReleaseAttestationNativeResearchRetirementPolicyReplayRequestV13,
    ReleaseAttestationNativeRetirementPolicyReplayRequestV10,
};
use private_tree::PrivateTree;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::{
    collections::BTreeMap,
    ffi::OsString,
    path::{Path, PathBuf},
    sync::atomic::AtomicBool,
    time::Instant,
};

pub(super) const SUITES: &[(&str, &str)] = &[
    (
        "migration/tests/p0-entrypoint-and-batch-parity.mjs",
        "P0EntrypointAndBatchParityTest",
    ),
    (
        "migration/tests/p0-paperctl-command-disposition.mjs",
        "P0PaperctlCommandDispositionTest",
    ),
    (
        "migration/tests/p0-production-core-differential.mjs",
        "P0ProductionCoreDifferentialTest",
    ),
    (
        "migration/tests/p1-build-package-retirements.mjs",
        "P1BuildPackageExplicitRetirementTest",
    ),
    (
        "migration/tests/p1-plugin-wrapper-boundaries.mjs",
        "P1PluginWrapperBoundaryTest",
    ),
    (
        "migration/tests/p1-referee-revise-retirements.mjs",
        "P1RefereeReviseExplicitRetirementTest",
    ),
    (
        "migration/tests/p1-referee-revision-differential.mjs",
        "P1RefereeRevisionDifferentialTest",
    ),
    (
        "migration/tests/p1-research-verify-retirements.mjs",
        "P1ResearchVerifyExplicitRetirementTest",
    ),
    (
        "migration/tests/p1-submission-boundaries.mjs",
        "P1SubmissionLifecycleBoundaryTest",
    ),
    (
        "migration/tests/p1-venue-resolve-retirements.mjs",
        "P1VenueResolveExplicitRetirementTest",
    ),
];
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ReleaseAttestationPolicyReplayRequestV4 {
    pub version: u16,
    pub kind: String,
    pub replay: ReleaseAttestationReplayRequestV3,
    pub archive_path: PathBuf,
    pub archive_sha256: String,
}
fn environment(extra: BTreeMap<String, String>) -> Result<RestrictedEnvironmentV1, String> {
    let mut values = BTreeMap::from([
        ("PATH".into(), "/usr/bin:/bin".into()),
        ("LANG".into(), "C.UTF-8".into()),
        ("LC_ALL".into(), "C.UTF-8".into()),
        ("PYTHONDONTWRITEBYTECODE".into(), "1".into()),
    ]);
    values.extend(extra);
    EnvironmentPolicyV1::new(
        "release-native-matrix-policy-v4",
        values.keys().cloned(),
        ["PATH", "LANG", "LC_ALL"],
    )
    .and_then(|p| p.build(std::iter::empty::<(OsString, OsString)>(), &values))
    .map_err(|_| error("policy_environment_invalid"))
}
fn process_limits(
    timeout_ms: u64,
    input_bytes: usize,
    output_limit: u64,
) -> Result<ProcessLimitsV1, String> {
    const PIPE_BYTES: u64 = 64 * 1024 * 1024;
    if input_bytes as u64 > PIPE_BYTES || !(1..=PIPE_BYTES).contains(&output_limit) {
        return Err(error("policy_process_byte_budget"));
    }
    Ok(ProcessLimitsV1 {
        timeout_ms,
        maximum_stdin_bytes: PIPE_BYTES as usize,
        maximum_stdout_bytes: output_limit,
        maximum_stderr_bytes: 1024 * 1024,
        maximum_tail_bytes: output_limit.min(64 * 1024) as usize,
        termination_grace_ms: 100,
        cleanup_timeout_ms: 2000,
        ..ProcessLimitsV1::default()
    })
}
fn process(
    owner: &Owner<'_>,
    tool: &Tool,
    arguments: Vec<OsString>,
    input: Option<Vec<u8>>,
    environment: RestrictedEnvironmentV1,
    output_limit: u64,
    mut private_tree: Option<&mut PrivateTree>,
) -> Result<(Vec<u8>, Value), String> {
    let limits = process_limits(
        owner.remaining()?,
        input.as_ref().map_or(0, Vec::len),
        output_limit,
    )?;
    let environment_hash = environment.environment_hash.to_string();
    let environment_policy_hash = environment.policy_hash.to_string();
    let selected_tmpdir = environment.get("TMPDIR").map(str::to_owned);
    let request = BoundedProcessRequestV1 {
        executable: tool.path.clone(),
        arguments: arguments.clone(),
        working_directory: owner.request.source.workspace_root.clone(),
        environment,
        stdin: input,
    };
    if let Some(tree) = &mut private_tree {
        // An unknown process-owner outcome must retain its private runtime.
        tree.process_cleanup(false);
    }
    let result =
        run_bounded_process_capturing_stdout_with_cancellation(&request, limits, owner.cancelled)
            .map_err(|e| format!("{}:{e}", error("policy_process_failed")))?;
    let p = &result.process;
    if let Some(tree) = &mut private_tree {
        tree.process_cleanup(p.process_group_cleanup_verified);
    }
    if p.termination_reason != ProcessTerminationReason::Exited
        || p.exit_code != Some(0)
        || p.signal.is_some()
        || !p.process_group_cleanup_verified
        || p.stderr_truncated
        || p.stdout_bytes != result.stdout.len() as u64
        || p.stdout_hash.to_string() != digest(&result.stdout)
    {
        return Err(format!(
            "{}:{:?}:exit={:?}:groupCleanup={}:{}",
            error("policy_observer_failed"),
            p.termination_reason,
            p.exit_code,
            p.process_group_cleanup_verified,
            String::from_utf8_lossy(&p.stderr_tail)
        ));
    }
    let receipt = json!({"environmentSha256":environment_hash,"environmentPolicySha256":environment_policy_hash,"selectedTemporaryRoot":selected_tmpdir,"executable":tool.path,"executableSha256":tool.sha256,"arguments":arguments.iter().map(|v|v.to_string_lossy()).collect::<Vec<_>>(),"stdoutSha256":p.stdout_hash.to_string(),"stderrSha256":p.stderr_hash.to_string(),"stdoutBytes":p.stdout_bytes,"capturedStdoutBytes":result.stdout.len(),"stdoutTailTruncated":p.stdout_truncated,"stderrBytes":p.stderr_bytes,"exitCode":p.exit_code,"processGroupCleanupVerified":p.process_group_cleanup_verified});
    Ok((result.stdout, receipt))
}
pub fn inspect_release_attestation_policy_replay_v4(
    request: ReleaseAttestationPolicyReplayRequestV4,
) -> Result<Value, String> {
    inspect_release_attestation_policy_replay_with_cancellation_v4(request, &AtomicBool::new(false))
}
pub fn inspect_release_attestation_policy_replay_with_cancellation_v4(
    request: ReleaseAttestationPolicyReplayRequestV4,
    cancelled: &AtomicBool,
) -> Result<Value, String> {
    inspect_policy(
        request,
        cancelled,
        SourceLimits::OriginalV4,
        4,
        false,
        false,
        false,
    )
}
pub fn inspect_release_attestation_measured_policy_replay_with_cancellation_v8(
    request: ReleaseAttestationMeasuredPolicyReplayRequestV8,
    cancelled: &AtomicBool,
) -> Result<Value, String> {
    measured_profile::validate(&request)?;
    inspect_policy(
        request.policy,
        cancelled,
        SourceLimits::Measured263V1,
        8,
        false,
        false,
        false,
    )
}
pub fn inspect_release_attestation_native_ast_policy_replay_with_cancellation_v9(
    request: ReleaseAttestationNativeAstPolicyReplayRequestV9,
    cancelled: &AtomicBool,
) -> Result<Value, String> {
    native_profile::validate(&request)?;
    inspect_policy(
        request.policy.policy,
        cancelled,
        SourceLimits::Measured263V1,
        9,
        true,
        false,
        false,
    )
}
pub fn inspect_release_attestation_native_retirement_policy_replay_with_cancellation_v10(
    request: ReleaseAttestationNativeRetirementPolicyReplayRequestV10,
    cancelled: &AtomicBool,
) -> Result<Value, String> {
    native_profile::validate_retirement(&request)?;
    inspect_policy(
        request.policy.policy.policy,
        cancelled,
        SourceLimits::Measured263V1,
        10,
        true,
        true,
        false,
    )
}
pub fn inspect_release_attestation_native_build_package_policy_replay_with_cancellation_v11(
    request: ReleaseAttestationNativeBuildPackagePolicyReplayRequestV11,
    cancelled: &AtomicBool,
) -> Result<Value, String> {
    native_profile::validate_build_package(&request)?;
    inspect_policy(
        request.policy.policy.policy.policy,
        cancelled,
        SourceLimits::Measured263V1,
        11,
        true,
        true,
        true,
    )
}
pub fn inspect_release_attestation_native_command_disposition_policy_replay_with_cancellation_v12(
    request: ReleaseAttestationNativeCommandDispositionPolicyReplayRequestV12,
    cancelled: &AtomicBool,
) -> Result<Value, String> {
    native_profile::validate_command_disposition(&request)?;
    inspect_policy(
        request.policy.policy.policy.policy.policy,
        cancelled,
        SourceLimits::Measured263V1,
        12,
        true,
        true,
        true,
    )
}
pub fn inspect_release_attestation_native_research_retirement_policy_replay_with_cancellation_v13(
    request: ReleaseAttestationNativeResearchRetirementPolicyReplayRequestV13,
    cancelled: &AtomicBool,
) -> Result<Value, String> {
    native_profile::validate_research_retirement(&request)?;
    inspect_policy(
        request.policy.policy.policy.policy.policy.policy,
        cancelled,
        SourceLimits::Measured263V1,
        13,
        true,
        true,
        true,
    )
}
fn inspect_policy(
    request: ReleaseAttestationPolicyReplayRequestV4,
    cancelled: &AtomicBool,
    source_limits: SourceLimits,
    output_version: u16,
    native_ast_enabled: bool,
    native_retirement_enabled: bool,
    native_build_package_enabled: bool,
) -> Result<Value, String> {
    if request.version != 4
        || request.kind != "ReleaseAttestationPolicyReplayRequest"
        || request.replay.version != 3
        || request.replay.kind != "ReleaseAttestationReplayRequest"
        || !(1..=600_000).contains(&request.replay.timeout_ms)
        || request
            .replay
            .node_executable
            .file_name()
            .is_none_or(|v| v != "node")
        || !facts::sha(&request.replay.node_executable_sha256, true)
        || !facts::sha(&request.archive_sha256, true)
    {
        return Err(error("policy_request_invalid"));
    }
    let mut owner = Owner {
        request: &request.replay,
        cancelled,
        started: Instant::now(),
        environment: environment(BTreeMap::new())?,
        read_bytes: 0,
    };
    let before = owner.source()?;
    let mut node = owner.tool(
        &request.replay.node_executable,
        Some(&request.replay.node_executable_sha256),
    )?;
    let mut python = owner.tool(Path::new("/usr/bin/python3"), None)?;
    let mut tar = owner.tool(Path::new("/usr/bin/tar"), None)?;
    let paths = graph_paths(&mut owner)?;
    let mut graph = SourceGraph::capture_paths(&mut owner, paths)?;
    let node_package_inputs = node_packages::inspect(&mut owner, &mut graph)?;
    let node_assets = node_assets::Assets::capture(&mut owner, &mut graph)?;
    let matrix_bytes = graph.read_input(
        &mut owner,
        "migration/legacy-semantic-migration-matrix.json",
    )?;
    let reference_bytes = graph.read_input(
        &mut owner,
        "migration/fixtures/legacy-matrix-reference-v1.json",
    )?;
    let matrix: Matrix =
        serde_json::from_slice(&matrix_bytes).map_err(|_| error("policy_matrix_invalid"))?;
    let reference: Reference =
        serde_json::from_slice(&reference_bytes).map_err(|_| error("policy_reference_invalid"))?;
    validate_contract(&matrix, &reference, &matrix_bytes, &request)?;
    let mut archive = PinnedArchive::capture(
        &mut owner,
        &request.archive_path,
        &request.archive_sha256,
        source_limits.archive(),
    )?;
    let mut tree = PrivateTree::new()?;
    let extraction = archive.materialize(&owner, &tar, &matrix, &mut tree, source_limits)?;
    let mut rows = inspect_rows(&mut owner, &mut graph, &matrix, &tree)?;
    // Exact executable profile is measured in the same pinned executable.
    let (profile_bytes,profile_process)=process(&owner,&node,vec!["--input-type=module".into(),"--eval".into(),"process.stdout.write(JSON.stringify({node:process.version,icu:process.versions.icu,cldr:process.versions.cldr}))".into()],None,owner.environment.clone(),4096,None)?;
    let profile: Value =
        serde_json::from_slice(&profile_bytes).map_err(|_| error("policy_node_profile_invalid"))?;
    if profile != json!({"node":"v22.23.1","icu":"78.2","cldr":"48.0"}) {
        return Err(error("policy_node_profile_invalid"));
    }
    let pure_matches = pure_matching::inspect(&owner, &node)?;
    let native_ast = if native_ast_enabled {
        Some(current_worker::observe_native_python_ast_v1(
            &mut owner, &matrix, &mut graph, &python, &mut tree,
        )?)
    } else {
        None
    };
    let mut native_retirement = if native_retirement_enabled {
        Some(retirement_policy::inspect(
            &mut owner,
            &mut graph,
            &matrix,
            native_ast
                .as_ref()
                .ok_or_else(|| error("native_retirement_ast_required"))?,
        )?)
    } else {
        None
    };
    let mut native_build_package = if native_build_package_enabled {
        Some(build_package_policy::inspect(
            &mut owner,
            &mut graph,
            &matrix,
            native_ast
                .as_ref()
                .ok_or_else(|| error("native_build_package_ast_required"))?,
            &mut tree,
            &python,
        )?)
    } else {
        None
    };
    // Only the closed V12 entry above selects this internal observation. The
    // caller cannot choose a scope or grant authority through an output version.
    let mut native_command = if matches!(output_version, 12 | 13) {
        Some(command_policy::inspect(&mut owner, &mut graph, &tree)?)
    } else {
        None
    };
    let mut native_research = if output_version == 13 {
        Some(research_policy::inspect(
            &mut owner,
            &mut graph,
            &matrix,
            native_ast
                .as_ref()
                .ok_or_else(|| error("native_research_retirement_ast_required"))?,
            &tree,
        )?)
    } else {
        None
    };
    let mut executions = BTreeMap::new();
    for (index, (suite, kind)) in SUITES.iter().enumerate() {
        owner.remaining()?;
        let runtime = tree.directory(&format!("runtimes/suite-{index}"))?;
        let variables = BTreeMap::from([
            ("TMPDIR".into(), runtime.to_string_lossy().into_owned()),
            (
                "PAPER_FACTORY_LEGACY_ROOT".into(),
                tree.sources().to_string_lossy().into_owned(),
            ),
            (
                "HEPTA_PAPER_RUNTIME_ROOT".into(),
                runtime.to_string_lossy().into_owned(),
            ),
            (
                "HEPTA_PRODUCTION_RUNTIME_ROOT".into(),
                runtime.to_string_lossy().into_owned(),
            ),
            (
                "HEPTA_PAPER_ASSET_ROOT".into(),
                tree.sources().to_string_lossy().into_owned(),
            ),
            ("HEPTA_PAPER_RUNTIME_ISOLATED".into(), "1".into()),
            ("HEPTA_LEGACY_REFERENCE_PREPARED".into(), "1".into()),
            ("HEPTA_MIGRATION_MATRIX_TEST".into(), "1".into()),
            (
                "HEPTA_LEGACY_REFERENCE_ARCHIVE".into(),
                request.archive_path.to_string_lossy().into_owned(),
            ),
        ]);
        let (bytes, receipt) = process(
            &owner,
            &node,
            vec![
                owner
                    .request
                    .source
                    .workspace_root
                    .join(suite)
                    .into_os_string(),
            ],
            None,
            environment(variables)?,
            16 * 1024 * 1024,
            Some(&mut tree),
        )?;
        let observed: Value =
            serde_json::from_slice(&bytes).map_err(|_| error("policy_observer_json_invalid"))?;
        if observed["ok"] != true
            || observed["kind"] != *kind
            || observed
                .get("externalActionPerformed")
                .is_some_and(|v| v != false)
        {
            return Err(format!(
                "{}:{suite}:{}",
                error("policy_observer_result_invalid"),
                observed
            ));
        }
        executions.insert((*suite).to_owned(),json!({"path":suite,"scope":"fixed_node_behavior_differential_observer","runtimeIsolation":"independent_private_runtime_per_unique_suite","actualResult":observed,"process":receipt}));
    }
    if let Some(observed) = &mut native_retirement {
        retirement_policy::compare(observed, &executions)?;
    }
    if let Some(observed) = &mut native_build_package {
        build_package_policy::compare(observed, &executions)?;
    }
    if let Some(observed) = &mut native_command {
        command_policy::compare(observed, &executions)?;
    }
    if let Some(observed) = &mut native_research {
        research_policy::compare(observed, &executions)?;
    }
    for row in &mut rows {
        let actual = row["behaviorTests"]
            .as_array()
            .ok_or_else(|| error("policy_row_internal_invalid"))?
            .iter()
            .map(|v| {
                executions
                    .get(v["path"].as_str().unwrap_or(""))
                    .cloned()
                    .ok_or_else(|| error("policy_test_receipt_missing"))
            })
            .collect::<Result<Vec<_>, _>>()?;
        row["behaviorExecutions"] = json!(actual);
        row["status"] = json!("native_matrix_facts_and_node_observer_captured");
        row["nativeFactsVerified"] = json!(true);
        row["verified"] = json!(false);
        row["rustBehavioralSuiteMatchingComplete"] = json!(false);
        if native_retirement.as_ref().is_some_and(|observed| {
            row["sourcePath"]
                .as_str()
                .is_some_and(|path| observed.accepted_source_paths.contains(path))
        }) {
            row["nativeExplicitRetirementPolicyComplete"] = json!(true);
            row["status"] =
                json!("native_complete_explicit_retirement_policy_and_full_node_suite_matched");
        }

        if native_build_package.as_ref().is_some_and(|observed| {
            row["sourcePath"]
                .as_str()
                .is_some_and(|path| observed.accepted_source_paths.contains(path))
        }) {
            row["nativeExplicitRetirementPolicyComplete"] = json!(true);
            row["status"] =
                json!("native_complete_explicit_retirement_policy_and_full_node_suite_matched");
        }

        if native_research.as_ref().is_some_and(|observed| {
            row["sourcePath"]
                .as_str()
                .is_some_and(|path| observed.accepted_source_paths.contains(path))
        }) {
            row["nativeExplicitRetirementPolicyComplete"] = json!(true);
            row["status"] =
                json!("native_complete_explicit_retirement_policy_and_full_node_suite_matched");
        }
        row["rustFixedCorpusMatches"] = json!(
            row["behaviorTests"]
                .as_array()
                .ok_or_else(|| error("policy_row_internal_invalid"))?
                .iter()
                .filter_map(|v| v["path"].as_str().and_then(|path| pure_matches.get(path)))
                .collect::<Vec<_>>()
        );
    }
    // Re-observe immutable source bytes after actual observers and after the last
    // provenance snapshot; same-byte file rewrites fail held metadata checks.
    tree.assert_sources(&matrix, &mut owner)?;
    let after = owner.source()?;
    if before["nativeSourceCapture"] != after["nativeSourceCapture"] {
        return Err(error("policy_source_changed"));
    }
    node_assets.assert_current(&owner)?;
    archive.assert_current(&mut owner)?;
    graph.assert_current(&mut owner)?;
    owner.assert_tool(&mut node)?;
    owner.assert_tool(&mut python)?;
    owner.assert_tool(&mut tar)?;
    tree.cleanup()?;
    let behavioral = matrix
        .entries
        .iter()
        .filter(|r| r.verification_class == "behavioral_replacement")
        .count();
    let retired = matrix
        .entries
        .iter()
        .filter(|r| r.verification_class == "explicit_retirement")
        .count();
    let implementation = after["implementationBlockers"]
        .as_array()
        .ok_or_else(|| error("policy_source_report_invalid"))?
        .clone();
    let mut report = json!({"version":output_version,"kind":"ReleaseAttestationPolicyReplayInspection","status":"release_attestation_blocked","sourceBound":true,"nativeSourceCapture":after["nativeSourceCapture"],"matrixPolicyReplay":{"status":"native_matrix_facts_and_node_observers_captured","scope":"263_hash_bound_source_facts_fixed_node_observers_and_two_native_pure_corpus_matches","matrixSha256":digest(&matrix_bytes),"referenceSha256":digest(&reference_bytes),"archive":archive.report(),"archiveExtraction":extraction,"entryCount":rows.len(),"observedBehavioralReplacementRowCount":behavioral,"observedExplicitRetirementRowCount":retired,"verifiedRustBehavioralReplacementCount":0,"uniqueBehaviorTestExecutionCount":executions.len(),"sharedTestsExecutedOnce":true,"functionalParityClaimAllowed":false,"explicitRetirementIsNotBehavioralMigration":true,"nativeMatrixFactsInspectionComplete":true,"policyReplayComplete":false,"rustBehavioralSuiteMatchingComplete":false,"rustFixedCorpusMatchingSuiteCount":pure_matches.len(),"rustFixedCorpusMatches":pure_matches.values().collect::<Vec<_>>(),"fullRestoredArchiveAndRuntimeReplayComplete":false,"fullRustProductImplementationClaimed":false,"rows":rows,"behaviorExecutions":executions.values().collect::<Vec<_>>(),"nodeProfile":profile,"profileProcess":profile_process,"nodePackageInputs":node_package_inputs,"nodeAssetInputs":node_assets.report()},"implementationBlockers":implementation,"externalQualificationBlockers":after["externalQualificationBlockers"],"technicalLocalChecksReady":false,"releaseEvidenceReady":false,"signingKeyRead":false,"runtimeEvidenceWritten":false,"physicalDeletionAllowed":false,"nodeRetirement":false,"externalActionPerformed":false,"temporaryRuntimeCleanupVerified":true,"sourceGraph":graph.report(),"resourceLimits":{"sourceArchiveProfile":source_limits.report(),"maximumArchiveBytes":source_limits.archive(),"maximumExtractedSourceBytes":source_limits.selected(),"maximumProcessStdinBytes":64*1024*1024,"maximumProcessStdoutBytes":64*1024*1024,"maximumSourceInputFileBytes":4*1024*1024,"aggregateObservedReadBytes":1024*1024*1024,"observerStdoutBytes":16*1024*1024,"sourceCaptureCount":2,"perCaptureMaximumSourceBytes":2_u64*1024*1024*1024,"timeoutMs":request.replay.timeout_ms},"observedReadBytes":owner.read_bytes});
    if let Some((actual, receipt)) = native_ast {
        report["matrixPolicyReplay"]["nativePythonAstObservations"] = json!({"version":1,"scope":"actual_245_immutable_archive_python_ast_observations_only","sameInputIndependentPythonAstVerified":true,"actual":actual,"worker":receipt,"fullBehavioralSuiteMatchingComplete":false});
        report["matrixPolicyReplay"]["scope"] = json!(
            "263_hash_bound_source_facts_fixed_node_observers_two_native_pure_corpus_matches_and_245_actual_native_ast_matches"
        );
    }
    if let Some(observed) = native_retirement {
        report["matrixPolicyReplay"]["nativeExplicitRetirementPolicies"] = observed.receipt;
        report["matrixPolicyReplay"]["verifiedNativeExplicitRetirementCount"] =
            json!(observed.accepted_source_paths.len());
        report["matrixPolicyReplay"]["completeNativeExplicitRetirementSuiteCount"] =
            json!(observed.summaries.len());
        report["matrixPolicyReplay"]["scope"] = json!(
            "263_source_facts_245_native_ast_matches_two_native_pure_corpora_and_24_complete_explicit_retirement_policies"
        );
    }
    if let Some(observed) = native_build_package {
        report["matrixPolicyReplay"]["nativeBuildPackageRetirementPolicy"] = observed.receipt;
        report["matrixPolicyReplay"]["verifiedNativeExplicitRetirementCount"] =
            json!(24 + observed.accepted_source_paths.len());
        report["matrixPolicyReplay"]["completeNativeExplicitRetirementSuiteCount"] = json!(3);
        report["matrixPolicyReplay"]["scope"] = json!(
            "263_source_facts_245_native_ast_matches_two_native_pure_corpora_and_60_complete_explicit_retirement_policies"
        );
    }
    if let Some(observed) = native_command {
        report["matrixPolicyReplay"]["nativeCompleteCommandDispositionPolicy"] = observed.receipt;
        report["matrixPolicyReplay"]["scope"] = json!(
            "263_source_facts_245_native_ast_matches_two_native_pure_corpora_complete_explicit_retirement_policies_and_source_bound_760_command_disposition"
        );
    }
    if let Some(observed) = native_research {
        report["matrixPolicyReplay"]["nativeResearchRetirementPolicy"] = observed.receipt;
        report["matrixPolicyReplay"]["verifiedNativeExplicitRetirementCount"] =
            json!(60 + observed.accepted_source_paths.len());
        report["matrixPolicyReplay"]["completeNativeExplicitRetirementSuiteCount"] = json!(4);
        report["matrixPolicyReplay"]["scope"] = json!(
            "263_source_facts_245_native_ast_two_pure_corpora_215_explicit_retirements_and_760_command_disposition"
        );
    }
    let mut blockers = implementation;
    blockers.extend(
        after["externalQualificationBlockers"]
            .as_array()
            .ok_or_else(|| error("policy_source_report_invalid"))?
            .clone(),
    );
    report["blockers"] = json!(blockers);
    report["reportHash"] = json!(
        canonical_hash_v1(
            &json!({"kind":"ReleaseAttestationPolicyReplayInspection","value":report.clone()})
        )
        .map_err(|_| error("policy_report_hash_failed"))?
        .to_string()
    );
    Ok(report)
}
