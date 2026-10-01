//! Complete fixed research retirement policy; retired Python execution surfaces
//! do not inherit a native execution permit or academic evidence authority.
use super::{Matrix, Owner, PrivateTree, SourceGraph, digest, error, retirement_policy};
use crate::retirement_reference::files::{
    MissingReferenceRoot, ReferenceRoot, ReferenceRootObservation,
};
use serde_json::{Value, json};
use std::collections::{BTreeMap, BTreeSet};
use std::path::Path;
const CATALOG: &str = "migration/research-verify-retirements.mjs";
const SUITE: &str = "migration/tests/p1-research-verify-retirements.mjs";
const SUITE_HASH: &str = "sha256:abaff33af41add349358de26a9bf0518f23cf10971cd95757439752938fe9d67";
const SMOKE: &str = "paperctl_modules/research_compute_claim_local_e2e_smoke.py";
const FORMAL: &str = "paperctl_modules/research_compute_formal_verifier_lean_execution_harness.py";
fn invalid() -> String {
    error("native_research_retirement_policy_invalid")
}
fn disposition(path: &str) -> &'static str {
    match path {
        "paperctl_modules/research_compute_executor.py" => {
            "retired_legacy_unbounded_research_executor"
        }
        SMOKE => "retired_research_local_e2e_smoke_harness",
        FORMAL => "retired_legacy_local_formal_verifier_harness",
        _ if path.contains("research_compute_formal_verifier_production_claim") => {
            "retired_generated_claim_specific_formal_authoring_chain"
        }
        _ if ["external_submission", "portal_capability"]
            .iter()
            .any(|s| path.contains(s)) =>
        {
            "retired_research_misclassified_external_submission_control_plane"
        }
        _ if [
            "source_apply",
            "patch_queue",
            "manuscript_patch",
            "merge",
            "candidate_note",
        ]
        .iter()
        .any(|s| path.contains(s)) =>
        {
            "retired_legacy_research_source_mutation_or_patch_queue_control_plane"
        }
        _ if ["fixture", "smoke"].iter().any(|s| path.contains(s)) => {
            "retired_research_smoke_fixture"
        }
        _ => "retired_legacy_research_planner_report_surface",
    }
}
fn execution_disposition(value: &str) -> bool {
    [
        "retired_legacy_unbounded_research_executor",
        "retired_research_local_e2e_smoke_harness",
        "retired_legacy_local_formal_verifier_harness",
        "retired_generated_claim_specific_formal_authoring_chain",
        "retired_research_smoke_fixture",
    ]
    .contains(&value)
}
fn array<'a>(value: &'a Value, field: &str) -> Result<&'a Vec<Value>, String> {
    let values = value[field].as_array().ok_or_else(invalid)?;
    if values.len() > 256 || values.iter().any(|v| v.as_str().is_none()) {
        return Err(invalid());
    }
    let unique: BTreeSet<_> = values.iter().map(|v| v.as_str().unwrap_or("")).collect();
    if unique.len() != values.len() {
        return Err(invalid());
    }
    Ok(values)
}
pub(super) struct Observed {
    pub summary: Value,
    pub accepted_source_paths: BTreeSet<String>,
    pub receipt: Value,
    absences: Vec<MissingReferenceRoot>,
}
pub(super) fn inspect(
    owner: &mut Owner<'_>,
    graph: &mut SourceGraph,
    matrix: &Matrix,
    ast: &(Value, Value),
    tree: &PrivateTree,
) -> Result<Observed, String> {
    if ast.0["native"]["audits"]
        .as_array()
        .is_none_or(|v| v.len() != 245)
        || ast.1["bindings"].as_array().is_none_or(|v| v.len() != 245)
    {
        return Err(invalid());
    }
    inspect_component(owner, graph, matrix, ast, tree)
}
fn inspect_component(
    owner: &mut Owner<'_>,
    graph: &mut SourceGraph,
    matrix: &Matrix,
    ast: &(Value, Value),
    tree: &PrivateTree,
) -> Result<Observed, String> {
    owner.remaining()?;
    let catalog = graph.read_input(owner, CATALOG)?;
    let suite = graph.read_input(owner, SUITE)?;
    if digest(&suite) != SUITE_HASH {
        return Err(error("native_research_retirement_fixed_suite_changed"));
    }
    let entries = retirement_policy::fixed_research_symbol_table(&catalog)?;
    if entries.len() != 155
        || entries.iter().any(|(p, _)| {
            !p.is_ascii() || !p.starts_with("paperctl_modules/") || !p.ends_with(".py")
        })
    {
        return Err(invalid());
    }
    let audits = ast.0["native"]["audits"].as_array().ok_or_else(invalid)?;
    let bindings = ast.1["bindings"].as_array().ok_or_else(invalid)?;
    if audits.len() != bindings.len() {
        return Err(invalid());
    }
    let observed: BTreeMap<_, _> = bindings
        .iter()
        .zip(audits)
        .map(|(b, a)| (b["sourcePath"].as_str().unwrap_or(""), (b, a)))
        .collect();
    if observed.len() != audits.len() {
        return Err(invalid());
    }
    let mut accepted = BTreeSet::new();
    let mut by_disposition = BTreeMap::<&str, usize>::new();
    let mut public_count = 0;
    let mut with_writes = 0;
    let mut with_process = 0;
    let mut with_subprocess = 0;
    let mut with_execution = 0;
    let mut harnesses = Vec::new();
    let mut source_inputs = Vec::new();
    for (path, symbols) in &entries {
        owner.remaining()?;
        let row = matrix
            .entries
            .iter()
            .find(|r| r.source.path == *path)
            .ok_or_else(invalid)?;
        let (binding, audit) = observed.get(path.as_str()).ok_or_else(invalid)?;
        let action = disposition(path);
        if row.verification_class != "explicit_retirement"
            || row.migration_action != action
            || row.source.symbols != *symbols
            || row.behavior_tests.len() != 1
            || row.behavior_tests[0].path != SUITE
            || binding["matrixId"] != row.id
            || binding["sourceSha256"] != format!("sha256:{}", row.source.sha256)
            || binding["profile"] != "research_verify_v1"
            || audit["public"] != json!(symbols)
            || !array(audit, "network_imports")?.is_empty()
            || audit["sqlite_import"] != false
            || !accepted.insert(path.clone())
        {
            return Err(invalid());
        }
        let writes = !array(audit, "writes")?.is_empty();
        let process = !array(audit, "process_calls")?.is_empty();
        let subprocess = audit["subprocess_import"].as_bool().ok_or_else(invalid)?;
        let execution = writes || process || subprocess;
        if execution && !execution_disposition(action) {
            return Err(error(
                "native_research_retired_execution_disposition_mismatch",
            ));
        }
        let bytes = tree.read_source(path, owner)?;
        if digest(&bytes) != binding["sourceSha256"] {
            return Err(error("native_research_retired_source_changed"));
        }
        source_inputs.push(json!({"path":path,"bytes":bytes.len(),"sha256":digest(&bytes),"profile":"research_verify_v1"}));
        public_count += symbols.len();
        with_writes += usize::from(writes);
        with_process += usize::from(process);
        with_subprocess += usize::from(subprocess);
        with_execution += usize::from(execution);
        *by_disposition.entry(action).or_default() += 1;
        if [SMOKE, FORMAL].contains(&path.as_str()) {
            if !execution {
                return Err(invalid());
            }
            harnesses.push(json!({"path":path,"sourceSha256":digest(&bytes),"actualPublicSymbols":symbols,"actualAst":audit,"disposition":action,"inheritedExecutionAuthorityDenied":true,"arbitraryLegacyHarnessApiBehavioralReplacementClaimed":false}));
        }
    }
    if harnesses.len() != 2
        || (with_writes, with_process, with_subprocess, with_execution) != (32, 21, 33, 35)
    {
        return Err(invalid());
    }
    let paths: Vec<_> = graph
        .paths()
        .filter(|p| retirement_policy::production_path(p))
        .map(str::to_owned)
        .collect();
    if paths.is_empty() {
        return Err(error("native_research_retirement_production_graph_empty"));
    }
    let mut scanned = Vec::new();
    for path in &paths {
        owner.remaining()?;
        let bytes = graph.read_input(owner, path)?;
        if accepted
            .iter()
            .any(|retired| retirement_policy::referenced(&bytes, retired))
        {
            return Err(error(
                "native_research_retirement_production_reference_found",
            ));
        }
        scanned.push(json!({"path":path,"bytes":bytes.len(),"sha256":digest(&bytes)}));
    }
    // A fixed missing-source verification fixture has no source/evidence or
    // dispatcher inputs. Observe actual ENOENT edges through the existing
    // descriptor-held owner; no legacy worker body or provider is called.
    let absent_source = missing(
        &tree
            .sources()
            .join("hepta-paper-workspace/migration/fixtures/missing-research-source"),
    )?;
    let absent_logs = missing(
        &tree
            .sources()
            .join("logs/paperctl/research_retirement_fixture"),
    )?;
    let absent_empirical=missing(&owner.request.source.workspace_root.join("runtime/migration-research-retirement-fixture/empirical-analysis/research_retirement_fixture"))?;
    for absent in [&absent_source, &absent_logs, &absent_empirical] {
        absent.assert_current().map_err(|_| invalid())?;
    }
    let summary = json!({"ok":true,"kind":"P1ResearchVerifyExplicitRetirementTest","retiredSourceCount":accepted.len(),"publicSymbolCount":public_count,"purePlanOrReportSourceCount":accepted.len()-with_execution,"withExecutionSurface":with_execution,"withWrites":with_writes,"withProcessCalls":with_process,"withSubprocessImport":with_subprocess,"networkSourceCount":0,"byDisposition":by_disposition,"nativeExecutedWorkerCount":0,"nativeSemanticMigrationVerifiedWorkerCount":0,"academicEvidenceEligible":false});
    Ok(Observed {
        summary,
        accepted_source_paths: accepted,
        absences: vec![absent_source, absent_logs, absent_empirical],
        receipt: json!({"version":1,"kind":"NativeCompleteFixedResearchRetirementPolicyObservation","catalog":{"path":CATALOG,"sha256":digest(&catalog),"bytes":catalog.len(),"maximumBytes":64*1024,"suite":SUITE,"suiteSha256":digest(&suite)},"actualSources":source_inputs,"localHarnesses":harnesses,"productionReferenceScan":{"actualFileCount":paths.len(),"inputs":scanned,"references":0},"fixedMissingSourceFixture":{"descriptorHeldEnoentVerified":true,"sourceMutation":false,"externalActionPerformed":false,"executedWorkerCount":0,"semanticMigrationVerifiedWorkerCount":0,"academicEvidenceEligible":false,"generalNativeResearchAdapterParityClaimed":false},"fullRustProductImplementationClaimed":false,"arbitraryLegacyPythonApiParityClaimed":false,"authorityGranted":false}),
    })
}
fn missing(path: &Path) -> Result<MissingReferenceRoot, String> {
    match ReferenceRoot::observe(path).map_err(|_| invalid())? {
        ReferenceRootObservation::Missing(value) => Ok(value),
        ReferenceRootObservation::Present(_) => {
            Err(error("native_research_retirement_fixture_not_absent"))
        }
    }
}
pub(super) fn compare(
    observed: &mut Observed,
    executions: &BTreeMap<String, Value>,
) -> Result<(), String> {
    for absent in &observed.absences {
        absent
            .assert_current()
            .map_err(|_| error("native_research_retirement_fixture_absence_changed"))?;
    }
    if executions.get(SUITE).map(|v| &v["actualResult"]) != Some(&observed.summary) {
        return Err(error(
            "native_research_retirement_whole_node_suite_mismatch",
        ));
    }
    observed.receipt["actualSameInputFullNodeSuiteResultsMatched"] = json!(true);
    observed.receipt["nativeSummaryResult"] = observed.summary.clone();
    Ok(())
}
#[cfg(test)]
mod tests;
