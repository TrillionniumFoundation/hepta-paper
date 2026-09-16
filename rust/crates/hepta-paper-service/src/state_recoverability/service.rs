//! Concrete recovery service. Every ready source comes from the real inventory
//! resolver, actual backup bytes, signed authority and SQLite restore execution.
use super::*;
use super::{
    observation::{LiveBackupHeadObservationV1, observe_stored_backup_head_v1},
    publication::Directory,
    reconciliation::PendingStateReconciliationV1,
};
use crate::sqlite_mutation_coordinator::authority::{
    MutationAuthorityTransportV1, PinnedMutationAuthorityV1,
};
use crate::state_backup_authority::{
    PinnedStateBackupAuthorityV1, StateBackupAuthorityTransportV1,
    restore_source::{
        StoredRestoreSourceOptionsV1, VerifiedStoredRestoreSourceV1,
        verify_stored_restore_source_v1,
    },
};
use crate::state_database_inventory::{
    ObservedStateDatabaseInventoryV1, observe_state_database_inventory_v1,
};
use std::{
    fs,
    os::unix::fs::MetadataExt,
    path::{Path, PathBuf},
};
pub struct BackupRecoveryServiceOptionsV1 {
    pub runtime_root: PathBuf,
    pub backup_root: PathBuf,
    pub state_database_manifest: Value,
    pub writer_manifest: Value,
}
pub struct BackupRecoveryServiceV1<B, O> {
    pub(super) backup: PinnedStateBackupAuthorityV1<B>,
    pub(super) online: PinnedMutationAuthorityV1<O>,
    pub(super) options: BackupRecoveryServiceOptionsV1,
}
pub(super) struct CurrentRestoreSourcesV1 {
    pub source: VerifiedStoredRestoreSourceV1,
    pub inventory: ObservedStateDatabaseInventoryV1,
    pub inspection: Value,
}
impl CurrentRestoreSourcesV1 {
    pub fn assert_current(&self, now: i64) -> Result<()> {
        self.inventory
            .assert_current()
            .map_err(|e| error(e.to_string()))?;
        self.source.assert_current(self.inventory.value(), now)
    }
}
pub(super) struct Renewal {
    pub sources: CurrentRestoreSourcesV1,
    pub recovered_heads: Value,
    receipt: Value,
}
impl<B: StateBackupAuthorityTransportV1, O: MutationAuthorityTransportV1>
    BackupRecoveryServiceV1<B, O>
{
    pub fn new(
        backup: PinnedStateBackupAuthorityV1<B>,
        online: PinnedMutationAuthorityV1<O>,
        options: BackupRecoveryServiceOptionsV1,
    ) -> Result<Self> {
        crate::state_backup_authority::manifest::assert_state_database_manifest_v1(
            &options.state_database_manifest,
        )?;
        crate::sqlite_mutation_coordinator::manifest::assert_writer_manifest_v1(
            &options.writer_manifest,
        )?;
        ensure(
            options.runtime_root.is_absolute()
                && options.backup_root.is_absolute()
                && backup.online_mutation_configuration_hash() == Some(online.configuration_hash()),
            "autonomous_research_state_reconcile_and_renew_backup_online_authority_mismatch",
        )?;
        Ok(Self {
            backup,
            online,
            options,
        })
    }
    /// Create an externally reserved backup from the actual observed runtime.
    pub fn backup(&mut self, clock: &mut dyn MutationClockV1) -> Result<Value> {
        super::backup::create(self, clock)
    }
    /// Resume a private staged backup using its original signed reservation and
    /// exact persisted finalization request. This publishes historical evidence;
    /// callers still need a fresh drill and controller epoch before mutation.
    pub fn recover_backup(
        &mut self,
        staging: &Path,
        clock: &mut dyn MutationClockV1,
    ) -> Result<Value> {
        super::backup_recovery::recover(self, staging, clock)
    }
    /// Validate a fresh signed head and restore isolated SQLite copies of the
    /// selected bundle; only the verified drill receipt is published.
    pub fn restore_drill(
        &mut self,
        bundle: &Path,
        clock: &mut dyn MutationClockV1,
    ) -> Result<Value> {
        super::drill::run(self, bundle, clock)
    }
    pub fn inspect_sources(&self, now: i64) -> Result<Value> {
        self.sources(now).map(|v| v.inspection)
    }
    pub fn reconcile_pending(
        &mut self,
        clock: &mut dyn MutationClockV1,
    ) -> Result<PendingStateReconciliationV1> {
        let trust = self.backup.online_mutation_trust().ok_or_else(|| {
            error("autonomous_research_state_restore_online_authority_trust_required")
        })?;
        super::reconciliation::reconcile(
            &self.options.runtime_root,
            &self.options.state_database_manifest,
            &self.options.writer_manifest,
            &mut self.online,
            trust,
            clock,
        )
    }
    pub(super) fn inventory(&self) -> Result<ObservedStateDatabaseInventoryV1> {
        observe_state_database_inventory_v1(
            &self.options.runtime_root,
            &self.options.state_database_manifest,
        )
        .map_err(|e| error(e.to_string()))
    }
    pub(super) fn selected(
        &self,
        path: &Path,
        inventory: ObservedStateDatabaseInventoryV1,
        now: i64,
    ) -> Result<CurrentRestoreSourcesV1> {
        ensure(
            path.parent() == Some(self.options.backup_root.as_path()),
            "autonomous_research_state_backup_bundle_path_unsafe",
        )?;
        let manifest = super::files::ObservedFile::open(
            &path.join("AUTONOMOUS_RESEARCH_STATE_BACKUP.json"),
            64 * 1024 * 1024,
        )?;
        let restore = super::files::ObservedFile::open(
            &path.join("RESTORE_DRILL_RECEIPT.json"),
            256 * 1024 * 1024,
        )?;
        let source = verify_stored_restore_source_v1(
            &self.backup,
            StoredRestoreSourceOptionsV1 {
                bundle_path: path,
                bundle_file_hash: &hash_bytes(&manifest.bytes(64 * 1024 * 1024)?),
                restore_receipt_file_hash: &hash_bytes(&restore.bytes(256 * 1024 * 1024)?),
                state_database_manifest: &self.options.state_database_manifest,
                current_inventory: inventory.value(),
                now,
            },
        )?;
        manifest.assert_current()?;
        restore.assert_current()?;
        inventory
            .assert_current()
            .map_err(|e| error(e.to_string()))?;
        Ok(CurrentRestoreSourcesV1 {
            inspection: source.inspection().clone(),
            source,
            inventory,
        })
    }
    pub(super) fn sources(&self, now: i64) -> Result<CurrentRestoreSourcesV1> {
        if matches!(fs::symlink_metadata(&self.options.backup_root),Err(e) if e.kind()==std::io::ErrorKind::NotFound)
        {
            return Err(error("autonomous_research_state_backup_bundle_missing"));
        }
        let directory = Directory::open_or_create(&self.options.backup_root, false)?;
        let mut candidates = Vec::new();
        for (count, entry) in fs::read_dir(&directory.path)
            .map_err(|_| error("autonomous_research_state_backup_bundle_missing"))?
            .enumerate()
        {
            if count >= 4096 {
                return Err(error(
                    "autonomous_research_state_backup_source_candidate_limit",
                ));
            }
            let entry =
                entry.map_err(|_| error("autonomous_research_state_backup_candidate_invalid"))?;
            let stat = fs::symlink_metadata(entry.path())
                .map_err(|_| error("autonomous_research_state_backup_candidate_invalid"))?;
            if stat.is_dir()
                && !stat.is_symlink()
                && !entry.file_name().to_string_lossy().starts_with('.')
            {
                candidates.push((entry.path(), stat.mtime(), stat.mtime_nsec()));
            }
        }
        ensure(
            !candidates.is_empty(),
            "autonomous_research_state_backup_bundle_missing",
        )?;
        let collator = hepta_legacy_compatibility::ProductionCollationV1::load()
            .map_err(|e| error(e.to_string()))?;
        candidates.sort_by(|a, b| {
            b.1.cmp(&a.1)
                .then(b.2.cmp(&a.2))
                .then_with(|| collator.compare(&b.0.to_string_lossy(), &a.0.to_string_lossy()))
        });
        let mut skipped = Vec::new();
        for (path, seconds, nanos) in candidates {
            match self.selected(&path, self.inventory()?, now) {
                Ok(mut source) => {
                    directory.assert_current()?;
                    source.inspection["skippedCandidates"] = skipped.into();
                    return Ok(source);
                }
                Err(e) => {
                    let blocker = e
                        .code
                        .split(':')
                        .next()
                        .filter(|s| {
                            s.starts_with("autonomous_research_state_")
                                && s.bytes().all(|b| {
                                    b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'_'
                                })
                        })
                        .unwrap_or("autonomous_research_state_backup_candidate_invalid");
                    skipped.push(json!({"candidateDirectoryNameHash":hash("AutonomousResearchStateBackupCandidateDirectoryName",&json!(path.file_name().and_then(|s|s.to_str()).unwrap_or_default()))?,"modifiedAt":iso(seconds.saturating_mul(1000).saturating_add(nanos/1_000_000))?,"blockers":[blocker]}));
                }
            }
        }
        let mut e = error("autonomous_research_state_backup_no_valid_restore_drill_bundle");
        e.details = json!({"skippedCandidates":skipped});
        Err(e)
    }
    pub(super) fn observe(
        &mut self,
        sources: &CurrentRestoreSourcesV1,
        clock: &mut dyn MutationClockV1,
    ) -> Result<LiveBackupHeadObservationV1> {
        sources
            .inventory
            .assert_current()
            .map_err(|e| error(e.to_string()))?;
        let result = observe_stored_backup_head_v1(
            &mut self.backup,
            &sources.source,
            sources.inventory.value(),
            clock,
        )?;
        sources
            .inventory
            .assert_current()
            .map_err(|e| error(e.to_string()))?;
        Ok(result)
    }
    pub(super) fn assert_observation(
        &self,
        observation: &LiveBackupHeadObservationV1,
        now: i64,
    ) -> Result<()> {
        ensure(
            observation.authority_configuration_hash() == self.backup.configuration_hash(),
            "autonomous_research_state_recoverability_observation_authority_changed",
        )?;
        self.backup.verify_current_head(
            &observation.value()["authorityCurrentHeadReceipt"],
            &observation.value()["authorityCurrentHeadRequest"],
            now,
        )?;
        Ok(())
    }
    pub(super) fn drill_selected(
        &mut self,
        sources: &CurrentRestoreSourcesV1,
        clock: &mut dyn MutationClockV1,
    ) -> Result<CurrentRestoreSourcesV1> {
        let path = PathBuf::from(text(sources.source.inspection(), "bundlePath")?);
        sources.assert_current(clock_now(clock)?.0)?;
        super::drill::run(self, &path, clock)?;
        self.selected(&path, self.inventory()?, clock_now(clock)?.0)
    }
    pub fn reconcile_and_renew(&mut self, clock: &mut dyn MutationClockV1) -> Result<Value> {
        self.renew_evidence(clock).map(|r| r.receipt)
    }
    pub(super) fn renew_evidence(&mut self, clock: &mut dyn MutationClockV1) -> Result<Renewal> {
        let pending = self.reconcile_pending(clock)?;
        pending
            .inventory
            .assert_current()
            .map_err(|e| error(e.to_string()))?;
        let backup = super::backup::create(self, clock)?;
        let path = PathBuf::from(text(&backup, "bundlePath")?);
        let drill = super::drill::run(self, &path, clock)?;
        ensure(
            drill["bundleManifestHash"] == backup["bundleManifestHash"]
                && drill["snapshotContentHash"] == backup["snapshotContentHash"],
            "autonomous_research_state_backup_renewal_restore_drill_required",
        )?;
        let mut renewal = json!({"version":1,"kind":"AutonomousResearchStateBackupRenewalReceipt","status":"autonomous_research_state_backup_renewal_complete","bundlePath":path,"bundleManifestHash":backup["bundleManifestHash"],"snapshotContentHash":backup["snapshotContentHash"],"backupAuthorityHeadSequence":backup["authorityHeadSequence"],"backupAuthorityHeadHash":backup["authorityHeadHash"],"restoreAuthorityHeadSequence":drill["authorityCurrentHeadReceipt"]["headSequence"],"restoreAuthorityHeadHash":drill["authorityCurrentHeadReceipt"]["headHash"],"restoreDrillReceiptHash":drill["restoreDrillReceiptHash"],"recoverabilityBindingHash":drill["recoverabilityBindingHash"],"completeFinalizedMutationJournal":drill["completeFinalizedMutationJournal"],"journalReplayMutationCount":drill["journalReplayMutationCount"],"renewedAt":clock_now(clock)?.1,"productionStateMutated":false,"blockers":[]});
        renewal["renewalReceiptHash"] =
            hash("AutonomousResearchStateBackupRenewalReceipt", &renewal)?.into();
        super::publication::publish_receipt(
            &Directory::open_or_create(&path, false)?,
            "RENEWAL_RECEIPT.json",
            &renewal,
            None,
        )?;
        let sources = self.selected(&path, self.inventory()?, clock_now(clock)?.0)?;
        ensure(
            sources.source.inspection()["restoreDrillReceiptHash"]
                == renewal["restoreDrillReceiptHash"]
                && sources.source.inspection()["headSequence"]
                    == renewal["restoreAuthorityHeadSequence"]
                && sources.source.inspection()["headHash"] == renewal["restoreAuthorityHeadHash"],
            "autonomous_research_state_recoverability_fresh_snapshot_publish_invalid",
        )?;
        let p = pending.value();
        let mut receipt = json!({"version":1,"kind":"AutonomousResearchStateReconcileAndRenewReceipt","status":"autonomous_research_state_reconcile_and_renew_complete","databaseScopeHash":pending.inventory.value()["databaseScopeHash"],"writerManifestHash":self.online.trust()["writerManifestHash"],"initialInventoryHash":pending.initial_inventory_hash,"reconciledInventoryHash":pending.inventory.value()["inventoryHash"],"reconciledDatabaseCount":p["reconciledDatabaseCount"],"recoveredFinalizationCount":p["recoveredFinalizationCount"],"abortedRemoteOnlyReservationCount":p["abortedRemoteOnlyReservationCount"],"businessDmlReplayed":false,"backupAttempted":true,"renewalReceiptHash":renewal["renewalReceiptHash"],"reconciliationReceiptHashes":p["reconciliations"].as_array().into_iter().flatten().map(|r|r["reconciliationReceiptHash"].clone()).collect::<Vec<_>>(),"pendingInspectionSetHash":hash("AutonomousResearchStatePendingFinalizationInspectionSet",&p["pendingInspections"] )?,"completedAt":clock_now(clock)?.1,"blockers":[]});
        receipt["reconcileAndRenewReceiptHash"] =
            hash("AutonomousResearchStateReconcileAndRenewReceipt", &receipt)?.into();
        receipt["reconciliations"] = p["reconciliations"].clone();
        receipt["pendingInspections"] = p["pendingInspections"].clone();
        receipt["renewalReceipt"] = renewal;
        Ok(Renewal {
            sources,
            receipt,
            recovered_heads: pending.value()["recovery"]["finalizedHeads"].clone(),
        })
    }
}
