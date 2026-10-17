//! The complete fixed P1 build/package explicit-retirement suite. Local contract
//! materialization is exercised in the existing private tree, never a host root.
use super::{
    Matrix, Owner, PrivateTree, SourceGraph, Tool, environment, error, process, retirement_policy,
    runner_contract,
};
use crate::state_recoverability::publication::Directory;
use serde_json::{Value, json};
use std::collections::{BTreeMap, BTreeSet};
const CATALOG: &str = "migration/build-package-retirements.mjs";
const CATALOG_HASH: &str =
    "sha256:242e0402ad8fb984835f2a854a8782050997cbb31afbc8996f7fd1540d22bd74";
const SUITE: &str = "migration/tests/p1-build-package-retirements.mjs";
const SUITE_HASH: &str = "sha256:a9301927b71aa90e7d3b1c6c9791ce9d6f308c9b07752dcfdb564ee65433ec1d";
const WRITER_HASH: &str = "sha256:7825b10b02306594493a2cf6f112f6fbaa934f0f38023e6555573d07f81d4d2d";
fn invalid() -> String {
    error("native_build_package_policy_invalid")
}
pub(super) struct Observed {
    pub summary: Value,
    pub accepted_source_paths: BTreeSet<String>,
    pub receipt: Value,
}
pub(super) fn inspect(
    owner: &mut Owner<'_>,
    graph: &mut SourceGraph,
    matrix: &Matrix,
    ast: &(Value, Value),
    tree: &mut PrivateTree,
    python: &Tool,
) -> Result<Observed, String> {
    let native = ast.0["native"]["audits"].as_array().ok_or_else(invalid)?;
    let bindings = ast.1["bindings"].as_array().ok_or_else(invalid)?;
    if native.len() != 245 || bindings.len() != 245 {
        return Err(invalid());
    }
    inspect_component(owner, graph, matrix, ast, tree, python)
}
fn inspect_component(
    owner: &mut Owner<'_>,
    graph: &mut SourceGraph,
    matrix: &Matrix,
    ast: &(Value, Value),
    tree: &mut PrivateTree,
    python: &Tool,
) -> Result<Observed, String> {
    owner.remaining()?;
    let raw = graph.read_input(owner, CATALOG)?;
    let suite = graph.read_input(owner, SUITE)?;
    if super::digest(&suite) != SUITE_HASH {
        return Err(error("native_build_package_fixed_suite_changed"));
    }
    let entries = retirement_policy::fixed_symbol_table(&raw, CATALOG_HASH, "PUBLIC_SYMBOLS")?;
    if entries.len() != 36
        || entries
            .iter()
            .any(|(path, _)| path == "paperctl_modules/not-retired.py")
    {
        return Err(invalid());
    }
    let native = ast.0["native"]["audits"].as_array().ok_or_else(invalid)?;
    let bindings = ast.1["bindings"].as_array().ok_or_else(invalid)?;
    if bindings.len() != native.len() {
        return Err(invalid());
    }
    let audits: BTreeMap<_, _> = bindings
        .iter()
        .zip(native)
        .map(|(b, a)| (b["sourcePath"].as_str().unwrap_or(""), (b, a)))
        .collect();
    if audits.len() != native.len() {
        return Err(invalid());
    }
    let mut accepted = BTreeSet::new();
    let mut public_count = 0usize;
    for (path, symbols) in &entries {
        owner.remaining()?;
        let local = path == runner_contract::LOCAL_WRITER;
        let row = matrix
            .entries
            .iter()
            .find(|r| r.source.path == *path)
            .ok_or_else(invalid)?;
        let action = if local {
            "retired_legacy_local_runner_contract_materializer"
        } else {
            "retired_generated_build_misclassified_control_evidence_surface"
        };
        let (binding, audit) = audits.get(path.as_str()).ok_or_else(invalid)?;
        if row.verification_class != "explicit_retirement"
            || row.migration_action != action
            || row.source.symbols != *symbols
            || row.behavior_tests.len() != 1
            || row.behavior_tests[0].path != SUITE
            || binding["matrixId"] != row.id
            || binding["sourceSha256"] != format!("sha256:{}", row.source.sha256)
            || binding["profile"] != "build_package_v1"
            || audit["public"] != json!(symbols)
            || audit["external_calls"] != json!([])
            || audit["network_imports"] != json!([])
            || audit["process_imports"] != json!([])
            || audit["writes"]
                != if local {
                    json!(["path.parent.mkdir", "path.write_text"])
                } else {
                    json!([])
                }
            || !accepted.insert(path.clone())
        {
            return Err(invalid());
        }
        public_count += symbols.len();
    }
    if !accepted.contains(runner_contract::LOCAL_WRITER) {
        return Err(invalid());
    }
    let writer = tree.read_source(runner_contract::LOCAL_WRITER, owner)?;
    if super::digest(&writer) != WRITER_HASH {
        return Err(error("native_build_package_fixed_writer_changed"));
    }
    let paths: Vec<_> = graph
        .paths()
        .filter(|path| retirement_policy::production_path(path))
        .map(str::to_owned)
        .collect();
    if paths.is_empty() {
        return Err(error("native_build_package_production_graph_empty"));
    }
    let mut scanned = Vec::new();
    let mut scanned_bytes = 0usize;
    for path in &paths {
        owner.remaining()?;
        let bytes = graph.read_input(owner, path)?;
        for selected in &accepted {
            if retirement_policy::referenced(&bytes, selected) {
                return Err(error("native_build_package_production_reference_found"));
            }
        }
        scanned_bytes += bytes.len();
        scanned.push(json!({"path":path,"sha256":super::digest(&bytes),"bytes":bytes.len()}));
    }
    let materializer = observe_materializer(owner, tree, python)?;
    let summary = json!({"ok":true,"kind":"P1BuildPackageExplicitRetirementTest","retiredSourceCount":entries.len(),"pureReportSourceCount":35,"localContractMaterializerCount":1,"publicSymbolCount":public_count,"externalActions":0,"heptaProductionReferences":0});
    Ok(Observed {
        summary,
        accepted_source_paths: accepted,
        receipt: json!({"version":1,"kind":"NativeFixedBuildPackageRetirementPolicyObservation","catalog":{"path":CATALOG,"sha256":super::digest(&raw),"bytes":raw.len(),"suite":SUITE,"suiteSha256":super::digest(&suite),"lookupUsesBorrowedActualEntry":true,"unknownPath":"paperctl_modules/not-retired.py","unknownLookupReturnedNull":true},"retiredSourceCount":36,"pureReportSourceCount":35,"localContractMaterializerCount":1,"productionReferenceScan":{"actualFileCount":paths.len(),"actualBytes":scanned_bytes,"inputs":scanned,"references":0},"materializer":materializer,"fullRustProductImplementationClaimed":false,"behavioralReplacementClaimed":false,"authorityGranted":false}),
    })
}
pub(super) fn compare(
    observed: &mut Observed,
    executions: &BTreeMap<String, Value>,
) -> Result<(), String> {
    if executions.get(SUITE).map(|v| &v["actualResult"]) != Some(&observed.summary) {
        return Err(error("native_build_package_full_suite_mismatch"));
    }
    observed.receipt["actualSameInputFullNodeSuiteResultsMatched"] = json!(true);
    observed.receipt["nativeSummaryResult"] = observed.summary.clone();
    Ok(())
}
pub(super) fn inputs() -> (Value, Value) {
    (
        json!({"status":"PASS","target_scope_state":"TARGET_SCOPE_RESOLVED","summary":{"target_paper_count":1,"target_slug_set_hash":"a".repeat(64)}}),
        json!({"status":"PASS","label":"fixture","runner_execution_contract_authoring_surface_state":"READY","summary":{"authoring_surface_ready":true},"authoring_surface_matrix":[{"authoring_surface_ready":true,"expected_contract_path":"logs/paperctl/_contracts/runner_execution/fixture.json","expected_contract_id":"fixture-contract","route_id":"fixture-route","command":"local-fixture-command","runner_lane":"fixture","contract_kind":"delegated_external_runner","external_lifecycle_stage":"blocked","external_lifecycle_readiness_report":"fixture.json","required_contract_fields":[],"validation_sequence":[],"matrix_hash":"b".repeat(64)}]}),
    )
}
fn observe_materializer(
    owner: &Owner<'_>,
    tree: &mut PrivateTree,
    python: &Tool,
) -> Result<Value, String> {
    owner.remaining()?;
    let native_root = tree.directory("runtimes/native-build-package-materializer")?;
    let python_root = tree.directory("runtimes/python-build-package-materializer")?;
    let native = Directory::open_or_create(&native_root, false).map_err(|_| invalid())?;
    let (target, authoring) = inputs();
    let actual = runner_contract::materialize(
        &native,
        &target,
        &authoring,
        &json!({}),
        "fixture",
        true,
        "2026-07-10T00:00:00+00:00",
    )?;
    let artifact = runner_contract::observe_artifact(
        &native,
        "logs/paperctl/_contracts/runner_execution/fixture.json",
    )?;
    let bytes = &artifact.bytes;
    // Differential observation executes only the exact hash-bound archived
    // Python source. The native materializer never delegates its calculations.
    let script = include_str!("runner_contract_oracle.py");
    let input=serde_json::to_vec(&json!({"target":target,"authoring":authoring,"upstream":{},"label":"fixture","materialize":true,"createdAt":"2026-07-10T00:00:00+00:00"})).map_err(|_|invalid())?;
    let (output, receipt) = process(
        owner,
        python,
        vec![
            "-c".into(),
            script.into(),
            python_root.clone().into_os_string(),
            tree.sources().into_os_string(),
        ],
        Some(input),
        environment(BTreeMap::from([
            ("HOME".into(), python_root.to_string_lossy().into_owned()),
            ("TMPDIR".into(), python_root.to_string_lossy().into_owned()),
        ]))?,
        4 * 1024 * 1024,
        Some(tree),
    )?;
    let expected: Value = serde_json::from_slice(&output).map_err(|_| invalid())?;
    if expected["report"] != actual
        || expected["files"]
            != json!([{"path":"logs/paperctl/_contracts/runner_execution/fixture.json","bytesHex":hex::encode(bytes),"sha256":super::digest(bytes),"mode":0o600}])
    {
        return Err(error(
            "native_build_package_materializer_full_result_mismatch",
        ));
    }
    artifact.assert_current()?;
    native.assert_current().map_err(|_| invalid())?;
    Ok(
        json!({"scope":"fixed_original_ascii_materializer_fixture_full_report_and_exact_artifact_bytes","arbitraryLegacyPythonApiParityClaimed":false,"nativeReport":actual,"artifactBytes":bytes.len(),"artifactSha256":super::digest(bytes),"sameInputArchivedPythonWholeValueMatched":true,"pythonObserver":receipt,"artifactMode":0o600,"externalActionAuthorized":false,"externalActionPerformed":false}),
    )
}
#[cfg(test)]
mod tests;
