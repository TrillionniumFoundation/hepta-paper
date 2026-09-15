//! Recovery has a separate report from V1 byte-backup receipts. Restore requires
//! exact original-path, externally selected manifest and latest revision binding.
use super::*;
use crate::{ObjectStoreV1, workflow::recovery_facts_at};
use hepta_campaign_writer::CampaignStateV1;
use nix::fcntl::{RenameFlags, renameat2};

/// Verified local history, not a host/provider/writer authorization.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalRecoveryReportV1 {
    pub version: u16,
    pub definition_hash: Sha256Digest,
    pub inventory_hash: Sha256Digest,
    pub campaign_revision: u64,
    pub campaign_state: CampaignStateV1,
    pub committed_steps: usize,
    pub total_steps: usize,
    pub event_count: usize,
    pub budget_remaining_microusd: u64,
    pub clock_floor_unix_ms: u64,
    pub history_verified: bool,
    pub artifact_bytes_verified: bool,
    pub pending_execution: bool,
    pub lease_current: bool,
    pub history_allows_local_resume: bool,
    pub production_activation: bool,
    pub node_retirement_verified: bool,
}

impl LocalMaintenanceSessionV1 {
    /// Explicitly checkpoint a local-only database under both exclusion guards.
    /// This may merge WAL pages and remove SQLite-owned sidecars on close, but
    /// does not acquire or refresh a writer lease or alter workflow semantics.
    pub fn quiesce(&self) -> Result<(), ServiceError> {
        self.validate()?;
        // A pending GC binds exact database bytes. Even a journal-mode change
        // would destroy that recovery preimage; only gc-resume may proceed.
        match fs::symlink_metadata(self.state.join("gc-pending-v1.json")) {
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => (),
            _ => return Err(ServiceError::Persistence),
        }
        for suffix in ["-wal", "-shm", "-journal"] {
            let path = self.state.join(format!("campaign.sqlite{suffix}"));
            match fs::symlink_metadata(&path) {
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => (),
                Err(_) => return Err(ServiceError::Filesystem),
                Ok(_) => {
                    if suffix == "-journal" {
                        return Err(ServiceError::Persistence);
                    }
                    read_private(&path, self.owner, MAX_FILE_BYTES)?;
                }
            }
        }
        hepta_campaign_writer::CampaignWriterStoreV1::quiesce_local_for_backup(
            &self.state.join("campaign.sqlite"),
            hepta_campaign_writer::CampaignWriterPolicyV1::strict(self.owner),
        )
        .map_err(|_| ServiceError::Persistence)?;
        self.validate()?;
        sync_dir(&self.state)?;
        self.inspect()?;
        Ok(())
    }

    /// Replay immutable SQLite/events, amendments, plans, result and receipt
    /// bytes, budget and every CAS object. No lease refresh or worker dispatch.
    pub fn verify_recovery(
        &self,
        expected: &Sha256Digest,
        now: u64,
    ) -> Result<LocalRecoveryReportV1, ServiceError> {
        self.recovery_at(&self.state, expected, now)
    }

    fn recovery_at(
        &self,
        logical: &Path,
        expected: &Sha256Digest,
        now: u64,
    ) -> Result<LocalRecoveryReportV1, ServiceError> {
        let before = self.inspect()?;
        let objects = ObjectStoreV1::readonly_under_guard(&self.state, self.access.clone())?;
        let facts = recovery_facts_at(&self.state, logical, self.owner, &objects, expected)
            .map_err(|_| ServiceError::Persistence)?;
        if self.inspect()? != before {
            return Err(ServiceError::Artifact);
        }
        let lease_current = now >= facts.clock_floor
            && now < facts.definition.template.writer_lease.expires_at_unix_ms;
        Ok(LocalRecoveryReportV1 {
            version: 1,
            definition_hash: facts.definition_hash,
            inventory_hash: digest(
                &serde_json::to_vec(&before.files).map_err(|_| ServiceError::Artifact)?,
            )?,
            campaign_revision: facts.campaign.revision,
            campaign_state: facts.campaign.state,
            committed_steps: facts.committed_steps,
            total_steps: facts.definition.steps.len(),
            event_count: facts.event_count,
            budget_remaining_microusd: facts.campaign.budget_remaining_microusd,
            clock_floor_unix_ms: facts.clock_floor,
            history_verified: true,
            artifact_bytes_verified: true,
            pending_execution: false,
            lease_current,
            history_allows_local_resume: lease_current
                && !facts.rejected
                && matches!(
                    facts.campaign.state,
                    CampaignStateV1::Running | CampaignStateV1::Paused
                ),
            production_activation: false,
            node_retirement_verified: false,
        })
    }
}

fn backup_manifest(
    bundle: &Path,
    expected: &Sha256Digest,
) -> Result<LocalBackupManifestV1, ServiceError> {
    verify_local_backup_v1(bundle, expected)?;
    let owner = private_root(bundle)?.uid();
    serde_json::from_slice(&read_private(
        &bundle.join("manifest.json"),
        owner,
        MAX_MANIFEST_BYTES,
    )?)
    .map_err(|_| ServiceError::Artifact)
}

/// Independently hash-bound byte verification followed by actual immutable
/// workflow replay. The source directory need not exist; logical hashes stay fixed.
pub fn verify_local_backup_recovery_v1(
    bundle: &Path,
    expected_manifest: &Sha256Digest,
    expected_definition: &Sha256Digest,
    now: u64,
) -> Result<LocalRecoveryReportV1, ServiceError> {
    let manifest = backup_manifest(bundle, expected_manifest)?;
    let session = LocalMaintenanceSessionV1::acquire(&bundle.join("payload"))?;
    let report = session.recovery_at(&manifest.source_directory, expected_definition, now)?;
    verify_local_backup_v1(bundle, expected_manifest)?;
    Ok(report)
}

fn absent(path: &Path) -> Result<(), ServiceError> {
    match fs::symlink_metadata(path) {
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        _ => Err(ServiceError::Artifact),
    }
}

/// Restore only to the ABSENT original path, never roll back an extant state.
/// The caller supplies an independently selected latest campaign revision as a
/// high-water mark. An absent path alone does not prove a backup is the latest.
/// A same-parent private staging directory publishes through RENAME_NOREPLACE.
/// Interrupted partial stages are retained, never adopted by a later invocation.
#[allow(clippy::too_many_arguments)]
pub fn restore_local_backup_v1(
    bundle: &Path,
    destination: &Path,
    staging: &Path,
    expected_manifest: &Sha256Digest,
    expected_definition: &Sha256Digest,
    expected_latest_revision: u64,
    now: u64,
) -> Result<LocalRecoveryReportV1, ServiceError> {
    let manifest = backup_manifest(bundle, expected_manifest)?;
    if manifest.source_directory != destination
        || destination == staging
        || destination.parent() != staging.parent()
        || destination.starts_with(bundle)
        || bundle.starts_with(destination)
        || staging.starts_with(bundle)
        || bundle.starts_with(staging)
        || destination.file_name().is_none()
        || staging.file_name().is_none()
    {
        return Err(ServiceError::Configuration);
    }
    let parent = destination.parent().ok_or(ServiceError::Configuration)?;
    let parent_identity = private_root(parent)?;
    if parent_identity.uid() != private_root(bundle)?.uid() {
        return Err(ServiceError::Artifact);
    }
    let stage_name = staging.file_name().ok_or(ServiceError::Configuration)?;
    if staging != parent.join(stage_name) {
        return Err(ServiceError::Configuration);
    }
    absent(destination)?;
    absent(staging)?;
    let source_session = LocalMaintenanceSessionV1::acquire(&bundle.join("payload"))?;
    let source = source_session.recovery_at(destination, expected_definition, now)?;
    if source.campaign_revision != expected_latest_revision {
        return Err(ServiceError::Persistence);
    }
    create_private(staging)?;
    sync_dir(parent)?;
    create_private(&staging.join("objects"))?;
    create_private(&staging.join("attempts"))?;
    // This marker denies regular service/maintenance access to a partial stage.
    write_new(
        &staging.join("restore-incomplete-v1"),
        expected_manifest.as_str().as_bytes(),
    )?;
    sync_dir(staging)?;
    for entry in &manifest.files {
        source_session.validate()?;
        let bytes = read_private(
            &bundle.join("payload").join(&entry.path),
            source_session.owner,
            MAX_FILE_BYTES,
        )?;
        if digest(&bytes)? != entry.sha256 || bytes.len() as u64 != entry.bytes {
            return Err(ServiceError::Artifact);
        }
        write_new(&staging.join(&entry.path), &bytes)?;
    }
    for directory in [
        staging.join("objects"),
        staging.join("attempts"),
        staging.to_path_buf(),
    ] {
        sync_dir(&directory)?;
    }
    verify_local_backup_v1(bundle, expected_manifest)?;
    // Logical path remains the original; the marker is removed only after all
    // bytes are present. A crash before atomic publication leaves no destination.
    fs::remove_file(staging.join("restore-incomplete-v1")).map_err(|_| ServiceError::Filesystem)?;
    sync_dir(staging)?;
    let staged = LocalMaintenanceSessionV1::acquire(staging)?;
    if staged.inspect()?.files != manifest.files {
        return Err(ServiceError::Artifact);
    }
    let staged_report = staged.recovery_at(destination, expected_definition, now)?;
    if staged_report.campaign_revision != expected_latest_revision
        || staged_report.inventory_hash != source.inventory_hash
    {
        return Err(ServiceError::Persistence);
    }
    staged.validate()?;
    let named_parent = private_root(parent)?;
    if parent_identity.dev() != named_parent.dev()
        || parent_identity.ino() != named_parent.ino()
        || parent_identity.uid() != named_parent.uid()
    {
        return Err(ServiceError::Artifact);
    }
    let directory = OpenOptions::new()
        .read(true)
        .custom_flags((OFlag::O_DIRECTORY | OFlag::O_NOFOLLOW).bits())
        .open(parent)
        .map_err(|_| ServiceError::Filesystem)?;
    let opened = directory.metadata().map_err(|_| ServiceError::Filesystem)?;
    if opened.dev() != parent_identity.dev() || opened.ino() != parent_identity.ino() {
        return Err(ServiceError::Artifact);
    }
    // No fallback to rename(): its overwrite behavior would weaken the contract.
    renameat2(
        &directory,
        Path::new(stage_name),
        &directory,
        Path::new(destination.file_name().ok_or(ServiceError::Configuration)?),
        RenameFlags::RENAME_NOREPLACE,
    )
    .map_err(|_| ServiceError::Filesystem)?;
    directory.sync_all().map_err(|_| ServiceError::Filesystem)?;
    // No database connection, worker, or writer lease was opened for mutation.
    // Publication completed. The returned report remains scoped to this backup.
    drop(staged);
    Ok(staged_report)
}
