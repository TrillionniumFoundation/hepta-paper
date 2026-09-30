//! Ordinary installed execution over the existing opaque kernel owners. Every
//! effect is bracketed by the physical installed barrier; selected external
//! request hashes live outside the kernel progress that recovery consumes.
use super::{control, journal::ExecutionJournalV1, systemd::HeldInstalledSchemaMaintenanceV1, *};
use crate::{
    online_schema_execution::{
        cli::{ControlGuard, arguments::Arguments},
        maintenance::{
            normalization::{
                ResumeSchemaNormalizationOptionsV1, SchemaNormalizationCheckpointV1,
                finalization::{
                    publication::SchemaFinalReceiptCheckpointV1,
                    recovery::{
                        self, PreparedSchemaFinalizationV1, SchemaFinalizationCheckpointV1,
                        SchemaObservationCheckpointV1,
                        restart::{self, SchemaTargetRestartCheckpointV2},
                    },
                },
                installation::{
                    ResumeSchemaInstallationOptionsV1, SchemaInstallationCheckpointV1,
                    SchemaInstallationOptionsV1, install_schema_maintenance_v1,
                    resume_schema_installation_v1,
                },
                normalize_schema_maintenance_v1, resume_schema_normalization_v1,
            },
            reserve_exact_schema_maintenance_v1,
        },
        plan::{SchemaTransitionPlanOptionsV1, build_schema_transition_plan_v1},
    },
    sqlite_mutation_coordinator::{
        authority::{PinnedMutationAuthorityV1, ProcessMutationAuthorityTransportV1},
        clock::{MutationClockV1, iso},
        timestamp,
    },
};
use serde_json::Value;
use std::fs;
type Authority = PinnedMutationAuthorityV1<ProcessMutationAuthorityTransportV1>;
struct Boundary<'a, 'p> {
    held: &'a HeldInstalledSchemaMaintenanceV1<'p>,
    journal: &'a ExecutionJournalV1,
}
impl Boundary<'_, '_> {
    fn check(&self) -> Result<()> {
        self.held.assert_current()?;
        self.journal.assert_current()
    }
}
impl SchemaNormalizationCheckpointV1 for Boundary<'_, '_> {
    fn checkpoint(&mut self, _: &str, _: &str) -> Result<()> {
        self.check()
    }
}
impl SchemaInstallationCheckpointV1 for Boundary<'_, '_> {
    fn checkpoint(&mut self, _: &str, _: &str) -> Result<()> {
        self.check()
    }
}
impl SchemaFinalizationCheckpointV1 for Boundary<'_, '_> {
    fn checkpoint(&mut self, _: &str) -> Result<()> {
        self.check()
    }
}
impl SchemaObservationCheckpointV1 for Boundary<'_, '_> {
    fn checkpoint(&mut self, _: &str) -> Result<()> {
        self.check()
    }
}
impl SchemaTargetRestartCheckpointV2 for Boundary<'_, '_> {
    fn checkpoint(&mut self, _: &str) -> Result<()> {
        self.check()
    }
}
impl SchemaFinalReceiptCheckpointV1 for Boundary<'_, '_> {
    fn checkpoint(&mut self, _: &str) -> Result<()> {
        self.check()
    }
}
fn invalid() -> crate::sqlite_mutation_coordinator::SqliteMutationCoordinatorError {
    error("autonomous_research_installed_schema_execution_subject_invalid")
}
fn pin(value: &Option<String>) -> Result<&str> {
    value.as_deref().ok_or_else(invalid)
}
fn selected_plan(
    args: &Arguments,
    manifest: &Value,
    writer: &Value,
    authority: &Authority,
    clock: &mut dyn MutationClockV1,
) -> Result<ObservedSchemaTransitionPlanV1> {
    let planned = timestamp(&json!(pin(&args.planned_at)?)).ok_or_else(invalid)?;
    if clock.now_millis()? < planned {
        return Err(invalid());
    }
    // Reconstruct only the independently selected original timestamp. All DB
    // observations, normalization projections, manifests and trust are fresh.
    let plan = build_schema_transition_plan_v1(
        SchemaTransitionPlanOptionsV1 {
            runtime_root: &args.runtime,
            state_database_manifest: manifest,
            writer_manifest: writer,
            requested_lease_ms: args.requested_lease_ms,
            required_execution_window_ms: args.execution_window_ms,
            expected_pre_rebind_pristine_runtime_state_hash: args.expected_pristine.as_deref(),
            machine_genesis: None,
        },
        authority,
        &mut || Ok(planned),
    )?;
    if plan.value()["transitionId"] != pin(&args.expected_transition_id)?
        || plan.value()["planHash"] != pin(&args.expected_plan_hash)?
    {
        return Err(invalid());
    }
    Ok(plan)
}
fn profile(args: &Arguments) -> Result<installation::ObservedInstalledSchemaProfileV1> {
    let result = installation::observe_installed_schema_profile_v1(
        args.installed_profile.as_deref().ok_or_else(invalid)?,
        pin(&args.installed_profile_hash)?,
        &args.runtime,
    )?;
    let source = &result.authority_restart().source_process_configuration;
    if source.path != args.process || source.sha256 != args.process_hash {
        return Err(invalid());
    }
    Ok(result)
}
fn installation_options(args: &Arguments) -> SchemaInstallationOptionsV1<'_> {
    SchemaInstallationOptionsV1 {
        commit_safety_margin_ms: args.commit_safety_margin_ms,
        machine_genesis: None,
    }
}
fn resume_final(
    args: &Arguments,
    manifest: &Value,
    writer: &Value,
    journal: &ExecutionJournalV1,
    source: &Authority,
) -> Result<PreparedSchemaFinalizationV1> {
    recovery::resume_schema_transition_finalization_from_selected_request_v1(
        recovery::ResumeSchemaFinalizationOptionsV1 {
            runtime_root: &args.runtime,
            state_database_manifest: manifest,
            writer_manifest: writer,
            expected_transition_id: pin(&args.expected_transition_id)?,
            expected_plan_hash: pin(&args.expected_plan_hash)?,
            expected_request_hash: journal.value()["finalizationRequestHash"]
                .as_str()
                .ok_or_else(invalid)?,
        },
        &journal.value()["finalizationRequest"],
        source,
    )
}
fn resume_restart(
    args: &Arguments,
    manifest: &Value,
    writer: &Value,
    journal: &ExecutionJournalV1,
    source: &Authority,
) -> Result<restart::PreparedSchemaTargetRestartV2> {
    restart::resume_schema_target_configuration_restart_from_selected_request_v2(
        restart::ResumeSchemaTargetRestartOptionsV2 {
            runtime_root: &args.runtime,
            state_database_manifest: manifest,
            writer_manifest: writer,
            expected_transition_id: pin(&args.expected_transition_id)?,
            expected_plan_hash: pin(&args.expected_plan_hash)?,
            expected_finalization_request_hash: journal.value()["finalizationRequestHash"]
                .as_str()
                .ok_or_else(invalid)?,
            expected_target_observation_request_hash: journal.value()["targetRestartRequestHash"]
                .as_str()
                .ok_or_else(invalid)?,
        },
        &journal.value()["targetRestartRequest"],
        source,
    )
}
fn resume_observation(
    args: &Arguments,
    manifest: &Value,
    writer: &Value,
    journal: &ExecutionJournalV1,
    source: &Authority,
) -> Result<recovery::PreparedSchemaObservationV1> {
    recovery::resume_schema_transition_observation_from_selected_request_v1(
        recovery::ResumeSchemaObservationOptionsV1 {
            runtime_root: &args.runtime,
            state_database_manifest: manifest,
            writer_manifest: writer,
            expected_transition_id: pin(&args.expected_transition_id)?,
            expected_plan_hash: pin(&args.expected_plan_hash)?,
            expected_finalization_request_hash: journal.value()["finalizationRequestHash"]
                .as_str()
                .ok_or_else(invalid)?,
            expected_observation_request_hash: journal.value()["observationRequestHash"]
                .as_str()
                .ok_or_else(invalid)?,
        },
        &journal.value()["observationRequest"],
        source,
    )
}
pub(in crate::online_schema_execution) fn run(
    args: &Arguments,
    manifest: &Value,
    writer: &Value,
    source: &mut Authority,
    clock: &mut dyn MutationClockV1,
    control_guard: Option<&ControlGuard>,
    historical_source: Option<&Authority>,
) -> Result<Value> {
    let profile = profile(args)?;
    let recovering = args.action == "recover";
    let (operation, mut journal, mut fresh_plan) = if recovering {
        let operation = SchemaOperationIdentityV1::from_pins(
            &profile,
            pin(&args.expected_transition_id)?,
            pin(&args.expected_plan_hash)?,
        )?;
        let journal = ExecutionJournalV1::recover(&operation, source.configuration_hash())?;
        if journal.value()["plan"]["plannedAt"] != pin(&args.planned_at)?
            || journal.value()["previousFinalReceiptFileSha256"].as_str()
                != args.expected_previous_final.as_deref()
        {
            return Err(invalid());
        }
        (operation, journal, None)
    } else {
        let plan = selected_plan(args, manifest, writer, source, clock)?;
        let operation = SchemaOperationIdentityV1::for_plan(&profile, &plan)?;
        // The physical owner is acquired below before this exact request can
        // reach the transport. The durable intent alone never authorizes SQL.
        let now = clock.now_millis()?;
        let request = plan.reserve_request(source, &iso(now)?)?;
        let journal = ExecutionJournalV1::begin(
            &operation,
            plan.value(),
            &request,
            source.configuration_hash(),
            control_guard
                .ok_or_else(invalid)?
                .final_receipt_file_sha256(),
            now,
        )?;
        (operation, journal, Some(plan))
    };
    let held = if recovering {
        systemd::recover_installed_schema_maintenance_v1(&profile, &operation)?
    } else {
        systemd::acquire_installed_schema_maintenance_v1(&profile, &operation)?
    };
    held.assert_current()?;
    if recovering {
        control::recover_control_handoff_v1(
            &operation,
            journal.value()["previousFinalReceiptFileSha256"].as_str(),
            || {
                crate::online_schema_execution::cli::finalized_predecessor(
                    &args.runtime,
                    args.expected_previous_final.as_deref(),
                    source,
                    historical_source,
                )
            },
        )?;
    } else {
        control::archive_predecessor_control_v1(&operation, control_guard.ok_or_else(invalid)?)?;
    }
    let mut phase = journal.value()["phase"]
        .as_str()
        .ok_or_else(invalid)?
        .to_owned();
    if phase == "reservation_pending" || phase == "normalization_pending" {
        // Installed Node v0.21 cannot sign the v2 rebind protocol. The physical
        // owner first preserves and converts its signed journal, then starts
        // the pinned native executor under the original source configuration.
        // Later recovery phases never move the authority back to that epoch.
        held.bootstrap_source_authority()?;
        held.assert_current()?;
        journal.assert_current()?;
    }
    let mut finalized = None;
    if phase == "reservation_pending" || phase == "normalization_pending" {
        let normalization = args
            .runtime
            .join("autonomous-research/online-schema-transition/NORMALIZATION.native.v1.json");
        let normalized = if recovering && fs::symlink_metadata(&normalization).is_ok() {
            resume_schema_normalization_v1(
                ResumeSchemaNormalizationOptionsV1 {
                    runtime_root: &args.runtime,
                    state_database_manifest: manifest,
                    writer_manifest: writer,
                    expected_transition_id: pin(&args.expected_transition_id)?,
                    expected_plan_hash: pin(&args.expected_plan_hash)?,
                    machine_genesis: None,
                },
                source,
                clock,
                &mut Boundary {
                    held: &held,
                    journal: &journal,
                },
            )?
        } else {
            let plan = match fresh_plan.take() {
                Some(value) => value,
                None => selected_plan(args, manifest, writer, source, clock)?,
            };
            held.assert_current()?;
            journal.assert_current()?;
            let token = reserve_exact_schema_maintenance_v1(
                plan,
                journal.value()["reserveRequest"].clone(),
                source,
                clock,
            )?;
            if phase == "reservation_pending" {
                journal.advance("normalization_pending", None, clock.now_millis()?)?;
            }
            normalize_schema_maintenance_v1(
                token,
                source,
                clock,
                &mut Boundary {
                    held: &held,
                    journal: &journal,
                },
            )?
        };
        journal.advance("installation_pending", None, clock.now_millis()?)?;
        let installed = install_schema_maintenance_v1(
            normalized,
            source,
            clock,
            installation_options(args),
            &mut Boundary {
                held: &held,
                journal: &journal,
            },
        )?;
        let prepared = recovery::prepare_schema_transition_finalization_with_selection_v1(
            installed,
            source,
            clock,
            &mut |request, digest, now| {
                held.assert_current()?;
                journal.select_request("finalizationRequestHash", request, digest, now)
            },
        )?;
        journal.advance(
            "finalization_pending",
            Some(("finalizationRequestHash", prepared.request_hash())),
            clock.now_millis()?,
        )?;
        finalized = Some(prepared);
        phase = "finalization_pending".into();
    } else if phase == "installation_pending" && !journal.value()["finalizationRequest"].is_null() {
        finalized = Some(resume_final(args, manifest, writer, &journal, source)?);
        journal.advance("finalization_pending", None, clock.now_millis()?)?;
        phase = "finalization_pending".into();
    } else if phase == "installation_pending" {
        let installed = resume_schema_installation_v1(
            ResumeSchemaInstallationOptionsV1 {
                runtime_root: &args.runtime,
                state_database_manifest: manifest,
                writer_manifest: writer,
                expected_transition_id: pin(&args.expected_transition_id)?,
                expected_plan_hash: pin(&args.expected_plan_hash)?,
                installation: installation_options(args),
            },
            source,
            clock,
            &mut Boundary {
                held: &held,
                journal: &journal,
            },
        )?;
        let prepared = recovery::prepare_schema_transition_finalization_with_selection_v1(
            installed,
            source,
            clock,
            &mut |request, digest, now| {
                held.assert_current()?;
                journal.select_request("finalizationRequestHash", request, digest, now)
            },
        )?;
        journal.advance(
            "finalization_pending",
            Some(("finalizationRequestHash", prepared.request_hash())),
            clock.now_millis()?,
        )?;
        finalized = Some(prepared);
        phase = "finalization_pending".into();
    }
    if phase == "finalization_pending" {
        let mut prepared = match finalized.take() {
            Some(value) => value,
            None => resume_final(args, manifest, writer, &journal, source)?,
        };
        recovery::finalize_prepared_schema_transition_v1(
            &mut prepared,
            source,
            clock,
            &mut Boundary {
                held: &held,
                journal: &journal,
            },
        )?;
        if journal.value()["plan"]["version"] == 2 {
            let prepared = if journal.value()["targetRestartRequest"].is_null() {
                restart::prepare_schema_target_configuration_restart_with_selection_v2(
                    prepared,
                    source,
                    clock,
                    &mut |request, digest, now| {
                        held.assert_current()?;
                        journal.select_request("targetRestartRequestHash", request, digest, now)
                    },
                )?
            } else {
                drop(prepared);
                resume_restart(args, manifest, writer, &journal, source)?
            };
            if prepared.target_authority_configuration_hash()
                != profile
                    .authority_restart()
                    .target_authority_configuration_hash
            {
                return Err(invalid());
            }
            journal.advance(
                "target_restart_pending",
                Some(("targetRestartRequestHash", prepared.request_hash())),
                clock.now_millis()?,
            )?;
        } else {
            let prepared = if journal.value()["observationRequest"].is_null() {
                recovery::prepare_schema_transition_observation_with_selection_v1(
                    prepared,
                    source,
                    clock,
                    &mut |request, digest, now| {
                        held.assert_current()?;
                        journal.select_request("observationRequestHash", request, digest, now)
                    },
                )?
            } else {
                drop(prepared);
                resume_observation(args, manifest, writer, &journal, source)?
            };
            journal.advance(
                "observation_pending",
                Some(("observationRequestHash", prepared.request_hash())),
                clock.now_millis()?,
            )?;
        }
        phase = journal.value()["phase"]
            .as_str()
            .ok_or_else(invalid)?
            .to_owned();
    }
    if journal.value()["plan"]["version"] == 2 {
        let mut prepared = resume_restart(args, manifest, writer, &journal, source)?;
        if phase == "target_restart_pending" {
            held.restart_target_authority(&prepared)?;
            journal.advance("observation_pending", None, clock.now_millis()?)?;
            phase = "observation_pending".into();
        }
        let target_profile = &profile.authority_restart().target_process_configuration;
        let mut target = Authority::load_process(&target_profile.path, &target_profile.sha256)?;
        if phase == "observation_pending" {
            restart::observe_restarted_schema_transition_v2(
                &mut prepared,
                source,
                &mut target,
                clock,
                &mut Boundary {
                    held: &held,
                    journal: &journal,
                },
            )?;
            journal.advance("publication_pending", None, clock.now_millis()?)?;
        }
        let published = restart::publish_restarted_schema_transition_observation_v2(
            prepared,
            source,
            &target,
            restart::PublishPreparedSchemaTargetRestartOptionsV2 {
                state_database_manifest: manifest,
                writer_manifest: writer,
                expected_plan_hash: pin(&args.expected_plan_hash)?,
                expected_previous_final_receipt_sha256: None,
            },
            &mut Boundary {
                held: &held,
                journal: &journal,
            },
        )?;
        journal.advance(
            "completed",
            Some(("finalReceiptFileSha256", &published.file_sha256)),
            clock.now_millis()?,
        )?;
    } else {
        let mut prepared = resume_observation(args, manifest, writer, &journal, source)?;
        if phase == "observation_pending" {
            recovery::observe_prepared_schema_transition_v1(
                &mut prepared,
                source,
                clock,
                &mut Boundary {
                    held: &held,
                    journal: &journal,
                },
            )?;
            journal.advance("publication_pending", None, clock.now_millis()?)?;
        }
        let published = recovery::publish_prepared_schema_transition_observation_v1(
            prepared,
            source,
            recovery::PublishPreparedSchemaObservationOptionsV1 {
                state_database_manifest: manifest,
                writer_manifest: writer,
                expected_plan_hash: pin(&args.expected_plan_hash)?,
                expected_previous_final_receipt_sha256: None,
            },
            &mut Boundary {
                held: &held,
                journal: &journal,
            },
        )?;
        journal.advance(
            "completed",
            Some(("finalReceiptFileSha256", &published.file_sha256)),
            clock.now_millis()?,
        )?;
    }
    held.assert_current()?;
    journal.assert_current()?;
    Ok(
        json!({"version":1,"kind":"InstalledSchemaExecutionReportV1","status":"schema_transition_published_writers_remain_fenced","transitionId":operation.transition_id,"planHash":operation.plan_hash,"profileSha256":operation.profile_sha256,"executionJournal":journal.value(),"maintenance":held.diagnostics(),"productionActivation":false,"releaseAuthority":false,"submissionAuthority":false,"nodeRetirement":false}),
    )
}
