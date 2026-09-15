//! Native-local mark/quarantine GC. No permanent deletion, production state or
//! opaque process-worker reachability is claimed. A journal fences crash residue.
use super::*;
use crate::{NativeJobV1, ObjectStoreV1, WorkerBindingV1, workflow::recovery_facts_at};
use hepta_campaign_writer::CampaignStateV1;
use nix::fcntl::{RenameFlags, renameat2};
use std::collections::BTreeMap;

const PENDING: &str = "gc-pending-v1.json";

/// Exact immutable GC proposal; applying it recomputes the candidate set.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct LocalGcPlanV1 {
    pub version: u16,
    pub state_directory: PathBuf,
    pub quarantine_directory: PathBuf,
    pub definition_hash: Sha256Digest,
    pub campaign_revision: u64,
    pub pins: BTreeSet<Sha256Digest>,
    pub source_inventory: Vec<LocalBackupFileV1>,
    pub quarantine: Vec<LocalBackupFileV1>,
    pub production_activation: bool,
    pub permanent_deletion: bool,
}
impl LocalGcPlanV1 {
    /// Domain-bound, deterministic proposal hash; not an approval signature.
    pub fn plan_hash(&self) -> Result<Sha256Digest, ServiceError> {
        if self.source_inventory.len() > MAX_FILES
            || self.quarantine.len() > MAX_FILES
            || self.pins.len() > MAX_FILES
        {
            return Err(ServiceError::Artifact);
        }
        let encoded = serde_json::to_vec(&("HeptaNativeLocalQuarantineV1", self))
            .map_err(|_| ServiceError::Artifact)?;
        if encoded.len() as u64 > MAX_MANIFEST_BYTES {
            return Err(ServiceError::Artifact);
        }
        digest(&encoded)
    }
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct LocalGcReceiptV1 {
    pub version: u16,
    pub plan_hash: Sha256Digest,
    pub quarantined_objects: usize,
    pub quarantined_bytes: u64,
    pub permanent_deletion: bool,
    pub production_activation: bool,
    pub node_retirement_verified: bool,
}

fn scan_digests(data: &[u8], found: &mut BTreeSet<Sha256Digest>) {
    // Conservative over-retention: any raw SHA256 token anywhere in input or
    // artifact bytes is retained, even if not semantically a reference.
    for token in data.split(|b| !b.is_ascii_hexdigit()) {
        if token.len() == 64
            && let Ok(raw) = std::str::from_utf8(token)
            && let Ok(hash) = format!("sha256:{raw}").parse()
        {
            found.insert(hash);
        }
    }
}

fn directory(path: &Path, owner: u32) -> Result<File, ServiceError> {
    let before = private_root(path)?;
    let file = OpenOptions::new()
        .read(true)
        .custom_flags((OFlag::O_DIRECTORY | OFlag::O_NOFOLLOW | OFlag::O_NONBLOCK).bits())
        .open(path)
        .map_err(|_| ServiceError::Filesystem)?;
    let opened = file.metadata().map_err(|_| ServiceError::Filesystem)?;
    if opened.uid() != owner || !unchanged(&before, &opened) {
        return Err(ServiceError::Artifact);
    }
    Ok(file)
}
fn directory_current(file: &File, path: &Path, owner: u32) -> Result<(), ServiceError> {
    let opened = file.metadata().map_err(|_| ServiceError::Filesystem)?;
    let named = private_root(path)?;
    if opened.uid() != owner || !unchanged(&opened, &named) {
        return Err(ServiceError::Artifact);
    }
    Ok(())
}

impl LocalMaintenanceSessionV1 {
    fn gc_roots(
        &self,
        expected: &Sha256Digest,
        pins: &BTreeSet<Sha256Digest>,
    ) -> Result<(u64, BTreeSet<Sha256Digest>), ServiceError> {
        let objects = ObjectStoreV1::readonly_under_guard(&self.state, self.access.clone())?;
        let facts = recovery_facts_at(&self.state, &self.state, self.owner, &objects, expected)
            .map_err(|_| ServiceError::Persistence)?;
        if facts.campaign.state == CampaignStateV1::Running || pins.len() > MAX_FILES {
            return Err(ServiceError::Configuration);
        }
        let mut roots = facts.result_hashes;
        for definition in &facts.all_definitions {
            if definition
                .template
                .workers
                .values()
                .any(|w| !matches!(w, WorkerBindingV1::Native))
            {
                return Err(ServiceError::Configuration);
            }
            for step in &definition.steps {
                let job: NativeJobV1 = serde_json::from_value(step.job_template.clone())
                    .map_err(|_| ServiceError::Configuration)?;
                match job {
                    NativeJobV1::Business { .. } => (),
                    NativeJobV1::ArtifactInventory { artifacts } => {
                        for hash in artifacts {
                            objects.read(&hash)?;
                            roots.insert(hash);
                        }
                    }
                    _ => return Err(ServiceError::Configuration),
                }
            }
            scan_digests(
                &serde_json::to_vec(definition).map_err(|_| ServiceError::Artifact)?,
                &mut roots,
            );
        }
        for hash in pins {
            objects.read(hash)?;
            roots.insert(hash.clone());
        }
        // All artifacts, even unreachable ones, may conservatively retain a
        // referenced object. Cycles therefore leak safely rather than losing data.
        for name in entries(&self.state.join("objects"))? {
            if !hash_name(&name) {
                return Err(ServiceError::Artifact);
            }
            let data = read_private(
                &self.state.join("objects").join(name),
                self.owner,
                MAX_FILE_BYTES,
            )?;
            scan_digests(&data, &mut roots);
        }
        Ok((facts.campaign.revision, roots))
    }

    /// Only a single quiesced native workflow with no outstanding dispatch may
    /// be collected. External pins are mandatory input (an explicit empty set
    /// is allowed); no timestamp/age-only or process-worker garbage inference.
    pub fn plan_gc(
        &self,
        expected: &Sha256Digest,
        revision: u64,
        pins: BTreeSet<Sha256Digest>,
        quarantine: &Path,
    ) -> Result<LocalGcPlanV1, ServiceError> {
        self.validate()?;
        self.validate_quarantine(quarantine)?;
        let before = self.inspect()?;
        let (actual, roots) = self.gc_roots(expected, &pins)?;
        if revision != actual || self.inspect()? != before {
            return Err(ServiceError::Persistence);
        }
        let candidates = before
            .files
            .iter()
            .filter(|e| e.path.starts_with("objects/") && !roots.contains(&e.sha256))
            .cloned()
            .collect();
        Ok(LocalGcPlanV1 {
            version: 1,
            state_directory: self.state.clone(),
            quarantine_directory: quarantine.to_path_buf(),
            definition_hash: expected.clone(),
            campaign_revision: revision,
            pins,
            source_inventory: before.files,
            quarantine: candidates,
            production_activation: false,
            permanent_deletion: false,
        })
    }

    fn validate_quarantine(&self, path: &Path) -> Result<(), ServiceError> {
        let parent = path.parent().ok_or(ServiceError::Configuration)?;
        if !path.is_absolute()
            || path.file_name().is_none()
            || path.parent() != self.state.parent()
            || path == self.state
            || private_root(parent)?.uid() != self.owner
            || path != parent.join(path.file_name().ok_or(ServiceError::Configuration)?)
        {
            return Err(ServiceError::Configuration);
        }
        Ok(())
    }

    /// Persist both copies of the proposal before moving any object. Source
    /// access remains fenced after a crash until resume_gc validates the union.
    pub fn apply_gc(
        &self,
        plan: &LocalGcPlanV1,
        expected_hash: &Sha256Digest,
    ) -> Result<LocalGcReceiptV1, ServiceError> {
        if &plan.plan_hash()? != expected_hash
            || &self.plan_gc(
                &plan.definition_hash,
                plan.campaign_revision,
                plan.pins.clone(),
                &plan.quarantine_directory,
            )? != plan
        {
            return Err(ServiceError::Configuration);
        }
        let encoded = serde_json::to_vec(plan).map_err(|_| ServiceError::Artifact)?;
        if encoded.len() as u64 > MAX_MANIFEST_BYTES {
            return Err(ServiceError::Artifact);
        }
        create_private(&plan.quarantine_directory)?;
        sync_dir(
            plan.quarantine_directory
                .parent()
                .ok_or(ServiceError::Configuration)?,
        )?;
        create_private(&plan.quarantine_directory.join("objects"))?;
        write_new(&plan.quarantine_directory.join("plan.json"), &encoded)?;
        sync_dir(&plan.quarantine_directory)?;
        write_new(&self.state.join(PENDING), &encoded)?;
        sync_dir(&self.state)?;
        self.resume_gc(&plan.quarantine_directory, expected_hash)
    }

    /// Recover a interrupted quarantine only with the externally retained plan
    /// digest. Every original file must exist exactly once, at the original or
    /// selected quarantine location, with unchanged bytes. No object is deleted.
    pub fn resume_gc(
        &self,
        quarantine: &Path,
        expected_hash: &Sha256Digest,
    ) -> Result<LocalGcReceiptV1, ServiceError> {
        self.validate()?;
        self.validate_quarantine(quarantine)?;
        if private_root(quarantine)?.uid() != self.owner {
            return Err(ServiceError::Artifact);
        }
        let encoded = read_private(
            &quarantine.join("plan.json"),
            self.owner,
            MAX_MANIFEST_BYTES,
        )?;
        let plan: LocalGcPlanV1 =
            serde_json::from_slice(&encoded).map_err(|_| ServiceError::Artifact)?;
        if plan.version != 1
            || plan.state_directory != self.state
            || plan.quarantine_directory != quarantine
            || plan.production_activation
            || plan.permanent_deletion
            || &plan.plan_hash()? != expected_hash
            || plan.source_inventory.len() > MAX_FILES
            || plan.quarantine.len() > MAX_FILES
        {
            return Err(ServiceError::Configuration);
        }
        let marker = fs::symlink_metadata(self.state.join(PENDING));
        if marker.is_ok() {
            if read_private(&self.state.join(PENDING), self.owner, MAX_MANIFEST_BYTES)? != encoded {
                return Err(ServiceError::Artifact);
            }
        } else if !matches!(marker,Err(ref e) if e.kind()==std::io::ErrorKind::NotFound)
            || !quarantine.join("receipt.json").is_file()
        {
            return Err(ServiceError::Artifact);
        }
        self.verify_gc_union(&plan)?;
        let (revision, roots) = self.gc_roots(&plan.definition_hash, &plan.pins)?;
        if revision != plan.campaign_revision
            || plan.quarantine.iter().any(|e| roots.contains(&e.sha256))
        {
            return Err(ServiceError::Persistence);
        }
        let source_dir = directory(&self.state.join("objects"), self.owner)?;
        let target_dir = directory(&quarantine.join("objects"), self.owner)?;
        for entry in &plan.quarantine {
            self.validate()?;
            let raw = entry
                .path
                .strip_prefix("objects/")
                .ok_or(ServiceError::Artifact)?;
            let source = self.state.join(&entry.path);
            match fs::symlink_metadata(&source) {
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => continue,
                Err(_) => return Err(ServiceError::Filesystem),
                Ok(_) => (),
            }
            let data = read_private(&source, self.owner, MAX_FILE_BYTES)?;
            if digest(&data)? != entry.sha256 || data.len() as u64 != entry.bytes {
                return Err(ServiceError::Artifact);
            }
            directory_current(&source_dir, &self.state.join("objects"), self.owner)?;
            directory_current(&target_dir, &quarantine.join("objects"), self.owner)?;
            renameat2(
                &source_dir,
                raw,
                &target_dir,
                raw,
                RenameFlags::RENAME_NOREPLACE,
            )
            .map_err(|_| ServiceError::Filesystem)?;
            source_dir
                .sync_all()
                .and_then(|()| target_dir.sync_all())
                .map_err(|_| ServiceError::Filesystem)?;
        }
        self.verify_gc_union(&plan)?;
        let receipt = LocalGcReceiptV1 {
            version: 1,
            plan_hash: expected_hash.clone(),
            quarantined_objects: plan.quarantine.len(),
            quarantined_bytes: plan.quarantine.iter().map(|e| e.bytes).sum(),
            permanent_deletion: false,
            production_activation: false,
            node_retirement_verified: false,
        };
        let receipt_path = quarantine.join("receipt.json");
        match fs::symlink_metadata(&receipt_path) {
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => write_new(
                &receipt_path,
                &serde_json::to_vec(&receipt).map_err(|_| ServiceError::Artifact)?,
            )?,
            Ok(_) => {
                let prior: LocalGcReceiptV1 = serde_json::from_slice(&read_private(
                    &receipt_path,
                    self.owner,
                    MAX_MANIFEST_BYTES,
                )?)
                .map_err(|_| ServiceError::Artifact)?;
                if prior != receipt {
                    return Err(ServiceError::Artifact);
                }
            }
            _ => return Err(ServiceError::Filesystem),
        }
        sync_dir(quarantine)?;
        if self.state.join(PENDING).exists() {
            fs::remove_file(self.state.join(PENDING)).map_err(|_| ServiceError::Filesystem)?;
            sync_dir(&self.state)?;
        }
        Ok(receipt)
    }

    fn verify_gc_union(&self, plan: &LocalGcPlanV1) -> Result<(), ServiceError> {
        let initial: BTreeMap<_, _> = plan
            .source_inventory
            .iter()
            .map(|e| (e.path.clone(), e))
            .collect();
        let selected: BTreeSet<_> = plan.quarantine.iter().map(|e| e.path.clone()).collect();
        if initial.len() != plan.source_inventory.len()
            || selected.len() != plan.quarantine.len()
            || plan.quarantine.iter().any(|e| {
                !e.path.starts_with("objects/")
                    || !allowed_path(&e.path)
                    || initial.get(&e.path) != Some(&e)
            })
        {
            return Err(ServiceError::Artifact);
        }
        let target = &plan.quarantine_directory;
        let top = entries(target)?;
        if top != ["objects".to_owned(), "plan.json".to_owned()]
            && top
                != [
                    "objects".to_owned(),
                    "plan.json".to_owned(),
                    "receipt.json".to_owned(),
                ]
        {
            return Err(ServiceError::Artifact);
        }
        if private_root(&target.join("objects"))?.uid() != self.owner {
            return Err(ServiceError::Artifact);
        }
        let mut union = inventory_filtered(&self.state, self.owner, true)?;
        for name in entries(&target.join("objects"))? {
            if !hash_name(&name) || !selected.contains(&format!("objects/{name}")) {
                return Err(ServiceError::Artifact);
            }
            let data = read_private(
                &target.join("objects").join(&name),
                self.owner,
                MAX_FILE_BYTES,
            )?;
            let sha256 = digest(&data)?;
            if sha256.as_str() != format!("sha256:{name}") {
                return Err(ServiceError::Artifact);
            }
            union.push(LocalBackupFileV1 {
                path: format!("objects/{name}"),
                bytes: data.len() as u64,
                sha256,
            });
        }
        union.sort_by(|a, b| a.path.cmp(&b.path));
        if union != plan.source_inventory {
            return Err(ServiceError::Artifact);
        }
        Ok(())
    }
}
