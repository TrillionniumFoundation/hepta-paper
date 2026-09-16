//! Complete state-backup command composition. Production authority calls use
//! the pinned process clients; no Node, shell or fixture adapter is invoked.
mod arguments;
mod inputs;
use super::*;
use super::{
    renewal,
    service::{BackupRecoveryServiceOptionsV1, BackupRecoveryServiceV1},
};
use crate::sqlite_mutation_coordinator::authority::{
    MutationAuthorityTransportV1, PinnedMutationAuthorityV1, ProcessMutationAuthorityTransportV1,
};
use crate::state_backup_authority::{
    PinnedStateBackupAuthorityV1, ProcessStateBackupAuthorityTransportV1,
};
use crate::state_database_inventory::inspect_state_database_inventory_v1;
pub use arguments::StateBackupActionV1;
use std::{
    collections::BTreeMap,
    path::{Path, PathBuf},
};

pub struct StateBackupCliContextV1 {
    pub workspace_root: PathBuf,
    pub working_directory: PathBuf,
    pub environment: BTreeMap<String, String>,
}
pub enum StateBackupCliOutputV1 {
    Help(&'static str),
    Report { report: Value, exit_code: i32 },
}
/// This is source manifest data ported from the incumbent's fixed module, not
/// a cached coverage result. Its trusted hash is separately checked by the
/// online authority and no data in it grants a current runtime permit.
pub fn state_backup_writer_manifest_v1() -> Result<Value> {
    let value = serde_json::from_str(include_str!("cli/writer-manifest.v1.json"))
        .map_err(|_| error("autonomous_research_state_backup_writer_manifest_invalid"))?;
    crate::sqlite_mutation_coordinator::manifest::assert_writer_manifest_v1(&value)?;
    Ok(value)
}
enum OnlineTransport {
    Process(Box<ProcessMutationAuthorityTransportV1>),
    VerificationOnly,
}
impl MutationAuthorityTransportV1 for OnlineTransport {
    fn invoke(&mut self, request: &Value) -> Result<Value> {
        match self {
            Self::Process(transport) => transport.invoke(request),
            Self::VerificationOnly => Err(error(
                "autonomous_research_state_backup_online_authority_transport_unavailable",
            )),
        }
    }
}
type ProcessService =
    BackupRecoveryServiceV1<ProcessStateBackupAuthorityTransportV1, OnlineTransport>;
fn reconciliation_failure(
    cause: &crate::sqlite_mutation_coordinator::SqliteMutationCoordinatorError,
) -> Value {
    json!({"version":1,"kind":"AutonomousResearchStateReconcileAndRenewReceipt","status":"autonomous_research_state_reconcile_and_renew_blocked","businessDmlReplayed":false,"backupAttempted":false,"initialInventoryHash":cause.details["initialInventoryHash"],"reconciledInventoryHash":cause.details["reconciledInventoryHash"],"databaseScopeHash":cause.details["databaseScopeHash"],"reconciliations":cause.details.get("reconciliations").cloned().unwrap_or_else(||json!([])),"pendingInspections":cause.details.get("pendingInspections").cloned().unwrap_or_else(||json!([])),"renewalReceipt":null,"blockers":[cause.code]})
}
fn reconcile_and_renew_report(
    service: &mut ProcessService,
    clock: &mut dyn MutationClockV1,
) -> Value {
    let pending = match service.reconcile_pending(clock) {
        Ok(pending) => pending,
        Err(cause) => return reconciliation_failure(&cause),
    };
    let renewal = match pending.inventory.assert_current() {
        Ok(()) => renewal::renew_report(service, clock),
        Err(cause) => return reconciliation_failure(&cause),
    };
    let p = pending.value();
    let complete = (|| {
        ensure(
            renewal["status"] == "autonomous_research_state_backup_renewal_complete",
            "autonomous_research_state_reconcile_and_renew_backup_renewal_required",
        )?;
        let mut receipt = json!({"version":1,"kind":"AutonomousResearchStateReconcileAndRenewReceipt","status":"autonomous_research_state_reconcile_and_renew_complete","databaseScopeHash":pending.inventory.value()["databaseScopeHash"],"writerManifestHash":service.online.trust()["writerManifestHash"],"initialInventoryHash":pending.initial_inventory_hash,"reconciledInventoryHash":pending.inventory.value()["inventoryHash"],"reconciledDatabaseCount":p["reconciledDatabaseCount"],"recoveredFinalizationCount":p["recoveredFinalizationCount"],"abortedRemoteOnlyReservationCount":p["abortedRemoteOnlyReservationCount"],"businessDmlReplayed":false,"backupAttempted":true,"renewalReceiptHash":renewal["renewalReceiptHash"],"reconciliationReceiptHashes":p["reconciliations"].as_array().into_iter().flatten().map(|r|r["reconciliationReceiptHash"].clone()).collect::<Vec<_>>(),"pendingInspectionSetHash":hash("AutonomousResearchStatePendingFinalizationInspectionSet",&p["pendingInspections"] )?,"completedAt":clock_now(clock)?.1,"blockers":[]});
        receipt["reconcileAndRenewReceiptHash"] =
            hash("AutonomousResearchStateReconcileAndRenewReceipt", &receipt)?.into();
        receipt["reconciliations"] = p["reconciliations"].clone();
        receipt["pendingInspections"] = p["pendingInspections"].clone();
        receipt["renewalReceipt"] = renewal.clone();
        Ok(receipt)
    })();
    complete.unwrap_or_else(
        |cause: crate::sqlite_mutation_coordinator::SqliteMutationCoordinatorError| {
            let mut report = reconciliation_failure(&cause);
            report["backupAttempted"] = true.into();
            report["initialInventoryHash"] = pending.initial_inventory_hash.clone();
            report["reconciledInventoryHash"] = pending.inventory.value()["inventoryHash"].clone();
            report["databaseScopeHash"] = pending.inventory.value()["databaseScopeHash"].clone();
            report["reconciliations"] = p["reconciliations"].clone();
            report["pendingInspections"] = p["pendingInspections"].clone();
            let mut blockers = renewal["blockers"]
                .as_array()
                .into_iter()
                .flatten()
                .filter_map(Value::as_str)
                .map(str::to_owned)
                .collect::<Vec<_>>();
            blockers.push(cause.code);
            blockers.sort_by(|a, b| a.encode_utf16().cmp(b.encode_utf16()));
            blockers.dedup();
            report["blockers"] = blockers.into();
            report["renewalReceipt"] = renewal;
            report
        },
    )
}
/// Match original options, defaults, report status and exit classes. Clock and
/// workspace injection are library-only; the binary obtains both itself.
pub fn state_backup_cli_v1(
    argv: &[String],
    context: &StateBackupCliContextV1,
    clock: &mut dyn MutationClockV1,
) -> std::result::Result<StateBackupCliOutputV1, String> {
    let args = arguments::parse(argv)?;
    if args.help {
        return Ok(StateBackupCliOutputV1::Help(arguments::USAGE));
    }
    run(args, context, clock).map_err(|cause| cause.code)
}
fn run(
    args: arguments::Arguments,
    context: &StateBackupCliContextV1,
    clock: &mut dyn MutationClockV1,
) -> Result<StateBackupCliOutputV1> {
    let cwd = &context.working_directory;
    let workspace = arguments::resolve(cwd, &context.workspace_root)?;
    let runtime = if let Some(root) = args.runtime.as_ref().or_else(|| {
        context
            .environment
            .get("HEPTA_PAPER_RUNTIME_ROOT")
            .filter(|s| !s.is_empty())
    }) {
        arguments::resolve(cwd, Path::new(root))?
    } else {
        workspace
            .parent()
            .unwrap_or(Path::new("/"))
            .join("hepta-paper-runtime/native-runtime")
    };
    let manifest = inputs::ManifestFile::load(
        &workspace.join("paper-core/config/autonomous-research-state-databases.v1.json"),
    )?;
    crate::state_backup_authority::manifest::assert_state_database_manifest_v1(&manifest.value)?;
    let writer = state_backup_writer_manifest_v1()?;
    let mut configuration_files = Vec::new();
    let mut backup_document = Value::Null;
    let backup = if let Some(path) = &args.backup_configuration {
        let path = arguments::resolve(cwd, Path::new(path))?;
        let (file, pin, document) = inputs::configuration(
            &path,
            "autonomous_research_state_backup_authority_process_configuration_invalid",
        )?;
        let authority = PinnedStateBackupAuthorityV1::load_process(&path, &pin)?;
        backup_document = document;
        configuration_files.push(file);
        Some(authority)
    } else {
        None
    };
    let online = if let Some(path) = &args.online_configuration {
        let path = arguments::resolve(cwd, Path::new(path))?;
        let (file, pin, document) = inputs::configuration(
            &path,
            "autonomous_research_online_mutation_authority_process_configuration_invalid",
        )?;
        let transport = ProcessMutationAuthorityTransportV1::load(&path, &pin)?;
        let authority = PinnedMutationAuthorityV1::load(
            Path::new(text(&document, "authorityConfigurationPath")?),
            text(&document, "authorityConfigurationSha256")?,
            OnlineTransport::Process(Box::new(transport)),
        )?;
        configuration_files.push(file);
        Some(authority)
    } else {
        None
    };
    manifest.assert_current()?;
    for file in &configuration_files {
        file.assert_current()?;
    }
    let report = if args.action == StateBackupActionV1::Status {
        inspect_state_database_inventory_v1(&runtime, &manifest.value)?
    } else if let Some(backup) = backup {
        // Backup and drill need the fixed verifier, not an extra online RPC
        // client. Only reconcile-and-renew invokes an online process authority.
        let online = match (args.action, online) {
            (StateBackupActionV1::ReconcileAndRenew, Some(online)) => online,
            _ => PinnedMutationAuthorityV1::load(
                Path::new(
                    backup_document["onlineMutationAuthorityConfigurationPath"]
                        .as_str()
                        .ok_or_else(|| {
                            error(
                                "autonomous_research_state_restore_online_authority_trust_required",
                            )
                        })?,
                ),
                text(
                    &backup_document,
                    "onlineMutationAuthorityConfigurationSha256",
                )?,
                OnlineTransport::VerificationOnly,
            )?,
        };
        let mut service = BackupRecoveryServiceV1::new(
            backup,
            online,
            BackupRecoveryServiceOptionsV1 {
                runtime_root: runtime.clone(),
                backup_root: runtime.join("backups/autonomous-research-state"),
                state_database_manifest: manifest.value.clone(),
                writer_manifest: writer,
            },
        )?;
        match args.action {
            StateBackupActionV1::Backup => service
                .backup(clock)
                .unwrap_or_else(|cause| renewal::backup_failure(&cause)),
            StateBackupActionV1::RestoreDrill => {
                let bundle = arguments::resolve(
                    cwd,
                    Path::new(args.bundle.as_deref().ok_or_else(|| {
                        error("autonomous_research_state_backup_bundle_required")
                    })?),
                )?;
                service
                    .restore_drill(&bundle, clock)
                    .unwrap_or_else(|cause| renewal::drill_failure(&cause, &bundle))
            }
            StateBackupActionV1::Renew => renewal::renew_report(&mut service, clock),
            StateBackupActionV1::ReconcileAndRenew => {
                reconcile_and_renew_report(&mut service, clock)
            }
            StateBackupActionV1::Status => {
                return Err(error("autonomous_research_state_backup_action_invalid"));
            }
        }
    } else {
        match args.action {
            StateBackupActionV1::Backup => renewal::backup_failure(&error(
                "autonomous_research_state_backup_external_authority_required",
            )),
            StateBackupActionV1::RestoreDrill => renewal::drill_failure(
                &error("autonomous_research_state_restore_external_authority_required"),
                &arguments::resolve(
                    cwd,
                    Path::new(args.bundle.as_deref().ok_or_else(|| {
                        error("autonomous_research_state_backup_bundle_required")
                    })?),
                )?,
            ),
            StateBackupActionV1::Renew => renewal::no_authority_renewal(),
            _ => {
                return Err(error(
                    "autonomous_research_state_reconcile_and_renew_authority_configuration_required",
                ));
            }
        }
    };
    manifest.assert_current()?;
    for file in &configuration_files {
        file.assert_current()?;
    }
    let exit_code = if report["status"] == args.action.ready_status() {
        0
    } else {
        2
    };
    Ok(StateBackupCliOutputV1::Report { report, exit_code })
}
