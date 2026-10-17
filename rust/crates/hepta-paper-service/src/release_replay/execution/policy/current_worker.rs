//! The parent owns the archive/source data and existing
//! process-group kernel. This accepts no caller-selected parser executable.
use super::{Matrix, Owner, PrivateTree, SourceGraph, Tool, environment, error, process};
use serde_json::{Value, json};
use std::fs;
use std::{collections::BTreeMap, ffi::OsString};
const REQUEST_BYTES: usize = 16 * 1024 * 1024;
const OUTPUT_BYTES: u64 = 4 * 1024 * 1024;
fn profile(suite: &str) -> Option<&'static str> {
    match suite {
        "migration/tests/p1-build-package-retirements.mjs" => Some("build_package_v1"),
        "migration/tests/p1-referee-revise-retirements.mjs" => Some("referee_revise_v1"),
        "migration/tests/p1-research-verify-retirements.mjs" => Some("research_verify_v1"),
        "migration/tests/p1-submission-boundaries.mjs" => Some("submission_v1"),
        "migration/tests/p1-venue-resolve-retirements.mjs" => Some("venue_resolve_v1"),
        _ => None,
    }
}
fn executing_identity(tool: &Tool) -> Result<(), String> {
    let current = fs::metadata("/proc/self/exe")
        .map_err(|_| error("native_ast_executing_elf_identity_unavailable"))?;
    if !super::super::same(&current, &tool.metadata) {
        return Err(error("native_ast_current_executable_replaced"));
    }
    Ok(())
}
pub(super) fn observe_native_python_ast_v1(
    owner: &mut Owner<'_>,
    matrix: &Matrix,
    graph: &mut SourceGraph,
    python: &Tool,
    tree: &mut PrivateTree,
) -> Result<(Value, Value), String> {
    owner.remaining()?;
    let mut cases = Vec::new();
    let mut bindings = Vec::new();
    let mut source_bytes = 0_usize;
    let mut oracle_inputs: BTreeMap<String, Vec<(usize, OsString)>> = BTreeMap::new();
    for row in &matrix.entries {
        owner.remaining()?;
        let Some(selected) = row
            .behavior_tests
            .first()
            .filter(|_| row.behavior_tests.len() == 1)
            .and_then(|test| profile(&test.path))
        else {
            continue;
        };
        if !row.source.path.ends_with(".py") {
            return Err(error("native_ast_selected_source_identity"));
        }
        let raw = tree.read_source(&row.source.path, owner)?;
        if raw.len() > 4 * 1024 * 1024 {
            return Err(error("native_ast_source_byte_budget"));
        }
        source_bytes = source_bytes
            .checked_add(raw.len())
            .filter(|v| *v <= REQUEST_BYTES)
            .ok_or_else(|| error("native_ast_source_aggregate_budget"))?;
        let sha = super::digest(&raw);
        if sha != format!("sha256:{}", row.source.sha256) {
            return Err(error("native_ast_source_hash_changed"));
        }
        let text =
            std::str::from_utf8(&raw).map_err(|_| error("native_ast_source_utf8_invalid"))?;
        oracle_inputs
            .entry(row.behavior_tests[0].path.clone())
            .or_default()
            .push((
                cases.len(),
                tree.sources().join(&row.source.path).into_os_string(),
            ));
        let context_path = tree.sources().join(&row.source.path);
        let context_path = context_path
            .to_str()
            .ok_or_else(|| error("native_ast_context_path_encoding"))?;
        cases.push(json!({"version":1,"kind":"NativePythonRetirementAstRequest","profile":selected,"source":text,"sourcePath":context_path}));
        bindings.push(json!({"matrixId":row.id,"sourcePath":row.source.path,"sourceSha256":sha,"sourceBytes":raw.len(),"profile":selected}));
    }
    if cases.len() != 245 {
        return Err(error("native_ast_fixed_case_count_changed"));
    }
    let input = serde_json::to_vec(
        &json!({"version":1,"kind":"NativePythonRetirementAstBatchRequest","cases":cases}),
    )
    .map_err(|_| error("native_ast_input_encoding"))?;
    if input.len() > REQUEST_BYTES {
        return Err(error("native_ast_input_byte_budget"));
    }
    let current =
        std::env::current_exe().map_err(|_| error("native_ast_current_executable_unavailable"))?;
    let mut tool = owner.tool(&current, None)?;
    executing_identity(&tool)?;
    let input_sha = super::digest(&input);
    let runtime = tree.directory("runtimes/native-ast-v1")?;
    let worker_environment = environment(BTreeMap::from([
        ("TMPDIR".into(), runtime.to_string_lossy().into_owned()),
        ("HOME".into(), runtime.to_string_lossy().into_owned()),
    ]))?;
    let (stdout, receipt) = process(
        owner,
        &tool,
        vec!["__hepta_internal_retirement_python_ast_v1".into()],
        Some(input),
        worker_environment,
        OUTPUT_BYTES,
        Some(tree),
    )?;
    owner.assert_tool(&mut tool)?;
    executing_identity(&tool)?;
    let result: Value =
        serde_json::from_slice(&stdout).map_err(|_| error("native_ast_output_invalid"))?;
    if result.as_object().is_none_or(|v| v.len() != 11)
        || result["parser"].as_object().is_none_or(|v| v.len() != 3)
        || result["visitedCoreAstNodeCount"]
            .as_u64()
            .is_none_or(|v| v > 4_000_000)
        || result["lexicalTokenCount"]
            .as_u64()
            .is_none_or(|v| v > 4_000_000)
        || result["version"] != 1
        || result["kind"] != "NativePythonRetirementAstBatchInspection"
        || result["parser"]["name"] != "rustpython-parser"
        || result["parser"]["version"] != "0.4.0"
        || result["parser"]["astVisitorVersion"] != "0.4.0"
        || result["caseCount"] != 245
        || result["sourceBytes"] != source_bytes
        || result["sourceExecuted"] != false
        || result["productPythonDelegationPerformed"] != false
        || result["fullRustProductImplementationClaimed"] != false
        || result["audits"].as_array().is_none_or(|v| v.len() != 245)
    {
        return Err(error("native_ast_output_contract_invalid"));
    }
    let native = result["audits"]
        .as_array()
        .ok_or_else(|| error("native_ast_output_audits_invalid"))?;
    let mut matches = Vec::new();
    for (suite, inputs) in oracle_inputs {
        owner.remaining()?;
        let source = graph.read_input(owner, &suite)?;
        let source_text =
            std::str::from_utf8(&source).map_err(|_| error("native_ast_oracle_source_encoding"))?;
        let marker = "const pythonAudit = String.raw`";
        if source_text.matches(marker).count() != 1 {
            return Err(error("native_ast_oracle_source_identity"));
        }
        let raw = source_text
            .split_once(marker)
            .and_then(|(_, tail)| tail.split_once("`;"))
            .map(|(raw, _)| raw)
            .ok_or_else(|| error("native_ast_oracle_source_identity"))?;
        let expected = match suite.as_str() {
            "migration/tests/p1-build-package-retirements.mjs" => {
                "sha256:412e96088e2160068df2d8ef239fd930b9ab5c75b034518edcbce05003abeadd"
            }
            "migration/tests/p1-referee-revise-retirements.mjs" => {
                "sha256:63a2666c2c2d5f8887596a11b81b009bb5434de3ab359cdfff3c22ed8fd5467f"
            }
            "migration/tests/p1-research-verify-retirements.mjs" => {
                "sha256:c8dd3c9205f94c90e65b4779f5848c449d287e01a676943182431cf27326adda"
            }
            "migration/tests/p1-submission-boundaries.mjs" => {
                "sha256:47ae1829163c5e99e1d6bb84d96c68e9e9d8fe74662ee127dc60544a1cd2222a"
            }
            "migration/tests/p1-venue-resolve-retirements.mjs" => {
                "sha256:6846f412f1ffa598ef414a81ae1339a38fe66186421a87f846cc380b660f1da5"
            }
            _ => return Err(error("native_ast_oracle_suite_invalid")),
        };
        if super::digest(raw.as_bytes()) != expected {
            return Err(error("native_ast_oracle_fixed_bytes_changed"));
        }
        let runtime = tree.directory(&format!("runtimes/native-ast-oracle-{}", matches.len()))?;
        let restricted = environment(BTreeMap::from([
            ("HOME".into(), runtime.to_string_lossy().into_owned()),
            ("TMPDIR".into(), runtime.to_string_lossy().into_owned()),
        ]))?;
        let mut arguments = vec!["-c".into(), raw.into()];
        arguments.extend(inputs.iter().map(|(_, path)| path.clone()));
        let (bytes, process_receipt) = process(
            owner,
            python,
            arguments,
            None,
            restricted,
            OUTPUT_BYTES,
            Some(tree),
        )?;
        let audits: Vec<Value> = serde_json::from_slice(&bytes)
            .map_err(|_| error("native_ast_oracle_output_invalid"))?;
        if audits.len() != inputs.len() {
            return Err(error("native_ast_oracle_case_count_changed"));
        }
        for ((index, _), observed) in inputs.iter().zip(&audits) {
            if native.get(*index) != Some(observed) {
                return Err(format!(
                    "{}:{}",
                    error("native_ast_same_input_mismatch"),
                    bindings[*index]["sourcePath"]
                ));
            }
        }
        matches.push(json!({"suite":suite,"scope":"fixed_archived_python_ast_observations_only","sameInputNativePythonAstVerified":true,"actualCaseCount":inputs.len(),"actualAudits":audits,"fixedOracleScriptSha256":expected,"process":process_receipt,"fullBehavioralSuiteMatchingComplete":false}));
    }
    if matches.len() != 5 {
        return Err(error("native_ast_fixed_oracle_suite_count"));
    }
    Ok((
        json!({"native":result,"matches":matches}),
        json!({"version":1,"kind":"ActualNativePythonAstBoundedWorkerObservation","inputSha256":input_sha,"bindings":bindings,"process":receipt,"currentExecutingElfSha256":tool.sha256,"currentExecutingElfHeldAndNamedBeforeAfterVerified":true,"atomicFdBasedExecClaimed":false,"resourceLimits":crate::release_replay::python_ast::python_ast_resource_limits_v1(),"parserSelectionFromCallerAllowed":false,"nativeFullSuiteMatchingComplete":false,"fullRustProductImplementationClaimed":false}),
    ))
}
