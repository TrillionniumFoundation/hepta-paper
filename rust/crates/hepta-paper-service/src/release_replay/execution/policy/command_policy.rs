//! Fixed command policy composition over the existing held graph/archive owners.
//! No native route inventory label becomes a Rust business execution permit.
use super::{Owner, PrivateTree, SourceGraph, digest, error};
use crate::release_replay::command_disposition::{
    LegacyCommandDispositionFixedInputsV1, inspect_legacy_paperctl_command_disposition_fixed_v1,
};
use serde_json::{Value, json};
use std::collections::BTreeMap;
const SUITE: &str = "migration/tests/p0-paperctl-command-disposition.mjs";
const CURRENT_INPUTS: &[&str] = &[
    "migration/legacy-command-disposition.mjs",
    SUITE,
    "migration/P0_PAPERCTL_COMMAND_DISPOSITION.json",
    "paper-core/src/paper-batch-runner.mjs",
    "paper-composition/batch/paper-batch-application.mjs",
    "paper-domain/workflow/mode-registry.mjs",
];
pub(super) struct Observed {
    pub receipt: Value,
}
pub(super) fn inspect(
    owner: &mut Owner<'_>,
    graph: &mut SourceGraph,
    tree: &PrivateTree,
) -> Result<Observed, String> {
    owner.remaining()?;
    // This is the sole original V8 measured sixteen MiB exception. The archive
    // owner has already checked its fixed selector, raw pin and held identity.
    let paperctl = tree.read_source("bin/paperctl", owner)?;
    let mut inputs = Vec::new();
    let mut bindings = vec![
        json!({"path":"bin/paperctl","origin":"held_fixed_archive","bytes":paperctl.len(),"sha256":digest(&paperctl)}),
    ];
    for path in CURRENT_INPUTS {
        owner.remaining()?;
        let bytes = graph.read_input(owner, path)?;
        bindings.push(json!({"path":path,"origin":"held_current_source_graph","bytes":bytes.len(),"sha256":digest(&bytes)}));
        inputs.push(bytes);
    }
    owner.remaining()?;
    let [
        catalog,
        suite,
        manifest,
        batch_entrypoint,
        batch_application,
        mode_registry,
    ] = inputs.as_slice()
    else {
        return Err(error("native_command_policy_fixed_inputs_missing"));
    };
    let calculation = inspect_legacy_paperctl_command_disposition_fixed_v1(
        LegacyCommandDispositionFixedInputsV1 {
            paperctl: &paperctl,
            catalog,
            suite,
            manifest,
            batch_entrypoint,
            batch_application,
            mode_registry,
        },
        owner.cancelled,
    )?;
    owner.remaining()?;
    Ok(Observed {
        receipt: json!({"version":1,"kind":"NativeCompleteFixed760CommandPolicyObservation","scope":"complete_fixed_parser_dispatch_disposition_manifest_and_source_bound_modes","inputs":bindings,"calculation":calculation,"fixedOriginalNodeSuite":SUITE,"actualSameInputWholeNodeSuiteResultMatched":false,"sourceGraphHeldBytesUsed":true,"archiveHeldBytesUsed":true,"parser":{"name":"oxc_parser","version":"0.148.0","javaScriptExecuted":false},"nativeRouteInventoryLabelsGrantBusinessExecution":false,"fullRustProductImplementationClaimed":false,"externalActionPerformed":false}),
    })
}
pub(super) fn compare(
    observed: &mut Observed,
    executions: &BTreeMap<String, Value>,
) -> Result<(), String> {
    let actual = executions
        .get(SUITE)
        .map(|value| &value["actualResult"])
        .ok_or_else(|| error("native_command_policy_actual_suite_missing"))?;
    if observed.receipt["calculation"]["suiteResult"] != *actual {
        return Err(error("native_command_policy_whole_suite_mismatch"));
    }
    observed.receipt["actualSameInputWholeNodeSuiteResultMatched"] = json!(true);
    Ok(())
}
