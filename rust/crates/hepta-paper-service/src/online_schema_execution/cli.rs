//! Ordinary CLI composition over the existing ten-database schema planner.
//! No new mutation/recovery kernel, authority transport invocation or state write.
mod arguments;
use super::plan::{SchemaTransitionPlanOptionsV1, build_schema_transition_plan_v1};
use crate::{
    sqlite_mutation_coordinator::{
        authority::{PinnedMutationAuthorityV1, ProcessMutationAuthorityTransportV1},
        clock::MutationClockV1,
        error,
    },
    state_recoverability::cli::state_backup_writer_manifest_v1,
};
use serde_json::{Value, json};
use std::{
    fs,
    path::{Component, Path},
};
const STATE_MANIFEST: &str =
    include_str!("../../../../../paper-core/config/autonomous-research-state-databases.v1.json");
const PREFIX: &str = "autonomous_research_online_schema_transition_";
fn no_control_state(root: &Path) -> Result<(), String> {
    if !root.is_absolute()
        || root
            .components()
            .any(|c| !matches!(c, Component::RootDir | Component::Normal(_)))
        || fs::canonicalize(root).ok().as_deref() != Some(root)
    {
        return Err(format!("{PREFIX}runtime_root_identity_invalid"));
    }
    let parent = root.join("autonomous-research");
    let metadata =
        fs::symlink_metadata(&parent).map_err(|_| format!("{PREFIX}control_path_unsafe"))?;
    if !metadata.is_dir() || metadata.is_symlink() {
        return Err(format!("{PREFIX}control_path_unsafe"));
    }
    match fs::symlink_metadata(parent.join("online-schema-transition")) {
        Err(cause) if cause.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(_) => Err(format!("{PREFIX}control_path_unsafe")),
        Ok(_) => Err(format!("{PREFIX}existing_control_requires_recovery")),
    }
}
/// Builds a fresh v1/v2 source plan only. Neither the returned JSON nor its hash
/// can construct the opaque maintenance reservation or activate a writer.
/// Clock injection is for library verification; the ordinary binary uses host time.
pub fn schema_transition_plan_cli_v1(
    args: &[String],
    clock: &mut dyn MutationClockV1,
) -> Result<Value, String> {
    let args = arguments::parse(args)?;
    if args.help {
        return Ok(
            json!({"version":1,"kind":"NativeSchemaTransitionPlanUsage","mutation":"none",
            "usage":"hepta-paper-rust autonomous-online-schema-transition --action plan --runtime-root ABSOLUTE_PATH --authority-process-config ABSOLUTE_PATH --authority-process-config-sha256 sha256:HASH [--requested-lease-ms N] [--required-execution-window-ms N] [--expected-pre-rebind-pristine-runtime-state-hash sha256:HASH]",
            "scope":"fresh_native_source_plan_only","executionAuthority":false}),
        );
    }
    // Existing control state is never silently replaced by a fresh simulation.
    // This conservative native profile does not interpret ACTIVE/FINAL recovery.
    no_control_state(&args.runtime)?;
    let manifest: Value = serde_json::from_str(STATE_MANIFEST)
        .map_err(|_| format!("{PREFIX}compiled_manifest_invalid"))?;
    let writer = state_backup_writer_manifest_v1().map_err(|e| e.code)?;
    let authority = PinnedMutationAuthorityV1::<ProcessMutationAuthorityTransportV1>::load_process(
        &args.process,
        &args.process_hash,
    )
    .map_err(|e| e.code)?;
    authority.assert_process_current_v1().map_err(|e| e.code)?;
    let mut previous = None;
    let mut observed_clock = || {
        let now = clock.now_millis()?;
        if now < 0 || previous.is_some_and(|old| now < old) {
            return Err(error(format!("{PREFIX}clock_regressed")));
        }
        previous = Some(now);
        Ok(now)
    };
    let plan = build_schema_transition_plan_v1(
        SchemaTransitionPlanOptionsV1 {
            runtime_root: &args.runtime,
            state_database_manifest: &manifest,
            writer_manifest: &writer,
            requested_lease_ms: args.requested_lease_ms,
            required_execution_window_ms: args.execution_window_ms,
            expected_pre_rebind_pristine_runtime_state_hash: args.expected_pristine.as_deref(),
            machine_genesis: None,
        },
        &authority,
        &mut observed_clock,
    )
    .map_err(|e| e.code)?;
    observed_clock().map_err(|e| e.code)?;
    // Revalidate the original executable, public trust and every source after
    // the full simulation; a stale preflight snapshot cannot yield a ready plan.
    plan.assert_current().map_err(|e| e.code)?;
    authority.assert_process_current_v1().map_err(|e| e.code)?;
    no_control_state(&args.runtime)?;
    Ok(
        json!({"version":1,"kind":"AutonomousResearchOnlineSchemaTransitionPlanReport",
        "status":"autonomous_research_online_schema_transition_plan_ready","ready":true,
        "plan":plan.value(),"completedInstanceIds":[],"crossDatabaseAtomicityClaimed":false,
        "networkUse":false,"publicationPerformed":false,"blockers":[],
        "readinessScope":"fresh_native_source_plan_only","authorityInvoked":false,
        "executionAuthority":false,"releaseAuthority":false,"submissionAuthority":false,
        "productionActivation":false,"nodeRetirement":false}),
    )
}
