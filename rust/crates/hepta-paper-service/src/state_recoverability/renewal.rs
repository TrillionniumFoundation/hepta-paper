//! Backup renewal executes no startup reconciliation. It drills the exact
//! newly published bundle and durably publishes the verified renewal receipt.
use super::*;
use super::{publication::Directory, service::BackupRecoveryServiceV1};
use crate::sqlite_mutation_coordinator::{
    SqliteMutationCoordinatorError, authority::MutationAuthorityTransportV1,
};
use crate::state_backup_authority::StateBackupAuthorityTransportV1;
use std::path::Path;

pub(super) fn backup_failure(cause: &SqliteMutationCoordinatorError) -> Value {
    if cause.code == "autonomous_research_state_database_inventory_blocked"
        && cause.details["inventory"].is_object()
    {
        return json!({"version":1,"kind":"AutonomousResearchStateBackupReceipt","status":"autonomous_research_state_backup_blocked","blockers":cause.details["inventory"]["blockers"],"inventory":cause.details["inventory"]});
    }
    json!({"version":1,"kind":"AutonomousResearchStateBackupReceipt","status":"autonomous_research_state_backup_blocked","blockers":[cause.code],"recoverableStagingPath":cause.details["recoverableStagingPath"]})
}
pub(super) fn drill_failure(cause: &SqliteMutationCoordinatorError, path: &Path) -> Value {
    json!({"version":1,"kind":"AutonomousResearchStateRestoreDrillReceipt","status":"autonomous_research_state_restore_drill_blocked","blockers":[cause.code],"bundlePath":path,"bundleManifestHash":cause.details["bundleManifestHash"],"authorityCurrentHeadReceiptHash":cause.details["authorityCurrentHeadReceiptHash"]})
}
fn blocked(mut blockers: Vec<String>, backup: Value, drill: Value) -> Value {
    blockers.sort_by(|a, b| a.encode_utf16().cmp(b.encode_utf16()));
    blockers.dedup();
    json!({"version":1,"kind":"AutonomousResearchStateBackupRenewalReceipt","status":"autonomous_research_state_backup_renewal_blocked","productionStateMutated":false,"blockers":blockers,"backupReceipt":backup,"restoreDrillReceipt":drill})
}
pub(super) fn no_authority_renewal() -> Value {
    let code = "autonomous_research_state_backup_external_authority_required";
    blocked(
        vec![
            code.into(),
            "autonomous_research_state_backup_renewal_backup_required".into(),
        ],
        backup_failure(&error(code)),
        Value::Null,
    )
}
pub(super) fn renew_report<B: StateBackupAuthorityTransportV1, O: MutationAuthorityTransportV1>(
    service: &mut BackupRecoveryServiceV1<B, O>,
    clock: &mut dyn MutationClockV1,
) -> Value {
    let backup = match service.backup(clock) {
        Ok(receipt) => receipt,
        Err(cause) => {
            let report = backup_failure(&cause);
            let mut blockers = report["blockers"]
                .as_array()
                .into_iter()
                .flatten()
                .filter_map(Value::as_str)
                .map(str::to_owned)
                .collect::<Vec<_>>();
            blockers.push("autonomous_research_state_backup_renewal_backup_required".into());
            return blocked(blockers, report, Value::Null);
        }
    };
    let path = match text(&backup, "bundlePath") {
        Ok(path) => Path::new(path),
        Err(cause) => return blocked(vec![cause.code], backup, Value::Null),
    };
    let drill = match service.restore_drill(path, clock) {
        Ok(receipt) => receipt,
        Err(cause) => {
            let report = drill_failure(&cause, path);
            return blocked(
                vec![
                    cause.code,
                    "autonomous_research_state_backup_renewal_restore_drill_required".into(),
                ],
                backup,
                report,
            );
        }
    };
    let publish: Result<Value> = (|| {
        ensure(
            drill["bundlePath"] == backup["bundlePath"]
                && drill["bundleManifestHash"] == backup["bundleManifestHash"]
                && drill["snapshotContentHash"] == backup["snapshotContentHash"],
            "autonomous_research_state_backup_renewal_restore_drill_required",
        )?;
        let mut receipt = json!({"version":1,"kind":"AutonomousResearchStateBackupRenewalReceipt","status":"autonomous_research_state_backup_renewal_complete","bundlePath":path,"bundleManifestHash":backup["bundleManifestHash"],"snapshotContentHash":backup["snapshotContentHash"],"backupAuthorityHeadSequence":backup["authorityHeadSequence"],"backupAuthorityHeadHash":backup["authorityHeadHash"],"restoreAuthorityHeadSequence":drill["authorityCurrentHeadReceipt"]["headSequence"],"restoreAuthorityHeadHash":drill["authorityCurrentHeadReceipt"]["headHash"],"restoreDrillReceiptHash":drill["restoreDrillReceiptHash"],"recoverabilityBindingHash":drill["recoverabilityBindingHash"],"completeFinalizedMutationJournal":drill["completeFinalizedMutationJournal"],"journalReplayMutationCount":drill["journalReplayMutationCount"],"renewedAt":clock_now(clock)?.1,"productionStateMutated":false,"blockers":[]});
        receipt["renewalReceiptHash"] =
            hash("AutonomousResearchStateBackupRenewalReceipt", &receipt)?.into();
        super::publication::publish_receipt(
            &Directory::open_or_create(path, false)?,
            "RENEWAL_RECEIPT.json",
            &receipt,
            None,
        )?;
        Ok(receipt)
    })();
    match publish {
        Ok(receipt) => receipt,
        Err(cause) => blocked(vec![cause.code], backup, drill),
    }
}
impl<B: StateBackupAuthorityTransportV1, O: MutationAuthorityTransportV1>
    BackupRecoveryServiceV1<B, O>
{
    /// Create a backup and drill that exact bundle without touching pending
    /// startup finalizations. Failure details retain the actual blocked report.
    pub fn renew(&mut self, clock: &mut dyn MutationClockV1) -> Result<Value> {
        let report = renew_report(self, clock);
        if report["status"] == "autonomous_research_state_backup_renewal_complete" {
            return Ok(report);
        }
        let mut cause = error("autonomous_research_state_backup_renewal_blocked");
        cause.details = json!({"renewalReceipt":report});
        Err(cause)
    }
}
