//! Explicit native-local quarantine retirement. Never purge live CAS, journals,
//! backups, unknown paths or opaque process-worker state. Durable per-object
//! intents make a partial unlink distinguishable from unaccounted disappearance.
use super::*;
use gc::{directory, directory_current};
use nix::unistd::{UnlinkatFlags, unlinkat};
use std::collections::BTreeMap;

pub(crate) const PURGE_PENDING: &str = "purge-pending-v1.json";
const JOURNAL: &str = "purge-v1";
const KIND: &str = "HeptaNativeLocalPurgeV1";

/// Operator-selected local retention window and complete additional pin set.
/// The explicit clock and pins are not authenticated production custody facts.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct LocalPurgePolicyV1 {
    pub not_before_unix_ms: u64,
    pub expires_at_unix_ms: u64,
    pub pins: BTreeSet<Sha256Digest>,
}

/// Hash-bound deletion proposal for an already completed native-local GC only.
/// Planning is read-only. Supplying its exact hash to apply is a separate act.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct LocalPurgePlanV1 {
    pub version: u16,
    pub kind: String,
    pub gc_plan: LocalGcPlanV1,
    pub gc_plan_hash: Sha256Digest,
    pub policy: LocalPurgePolicyV1,
    pub production_activation: bool,
}
impl LocalPurgePlanV1 {
    pub fn plan_hash(&self) -> Result<Sha256Digest, ServiceError> {
        validate_plan_shape(self)?;
        digest(&encode(self)?)
    }
}

/// Unlinked payload bytes, not guaranteed physical-block reclaim or secure erase.
/// All prior GC records and purge intents remain retained for audit/recovery.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct LocalPurgeReceiptV1 {
    pub version: u16,
    pub purge_plan_hash: Sha256Digest,
    pub unlinked_objects: usize,
    pub unlinked_payload_bytes: u64,
    pub source_inventory_hash: Sha256Digest,
    pub secure_erasure_verified: bool,
    pub production_activation: bool,
    pub node_retirement_verified: bool,
}
#[derive(Deserialize, Serialize, Eq, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct UnlinkIntentV1 {
    version: u16,
    purge_plan_hash: Sha256Digest,
    file: LocalBackupFileV1,
}

fn encode<T: Serialize>(value: &T) -> Result<Vec<u8>, ServiceError> {
    let bytes = serde_json::to_vec(value).map_err(|_| ServiceError::Artifact)?;
    if bytes.len() as u64 > MAX_MANIFEST_BYTES {
        return Err(ServiceError::Artifact);
    }
    Ok(bytes)
}
fn is_absent(path: &Path) -> Result<bool, ServiceError> {
    match fs::symlink_metadata(path) {
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(true),
        Err(_) => Err(ServiceError::Filesystem),
        Ok(_) => Ok(false),
    }
}
fn sum_bytes(rows: &[LocalBackupFileV1]) -> Result<u64, ServiceError> {
    rows.iter().try_fold(0u64, |sum, row| {
        sum.checked_add(row.bytes)
            .filter(|v| *v <= MAX_TOTAL_BYTES)
            .ok_or(ServiceError::Artifact)
    })
}
fn validate_plan_shape(plan: &LocalPurgePlanV1) -> Result<(), ServiceError> {
    let gc = &plan.gc_plan;
    if plan.version != 1
        || plan.kind != KIND
        || plan.production_activation
        || gc.version != 1
        || gc.production_activation
        || gc.permanent_deletion
        || gc.quarantine.is_empty()
        || gc.source_inventory.len() > MAX_FILES
        || gc.quarantine.len() > MAX_FILES
        || plan.policy.pins.len() > MAX_FILES
        || plan.policy.not_before_unix_ms == 0
        || plan.policy.expires_at_unix_ms <= plan.policy.not_before_unix_ms
        || plan.policy.expires_at_unix_ms > i64::MAX as u64
        || gc.plan_hash()? != plan.gc_plan_hash
    {
        return Err(ServiceError::Configuration);
    }
    let initial: BTreeMap<_, _> = gc.source_inventory.iter().map(|e| (&e.path, e)).collect();
    let selected: BTreeSet<_> = gc.quarantine.iter().map(|e| &e.path).collect();
    if initial.len() != gc.source_inventory.len()
        || selected.len() != gc.quarantine.len()
        || gc
            .source_inventory
            .windows(2)
            .any(|w| w[0].path >= w[1].path)
        || gc.quarantine.windows(2).any(|w| w[0].path >= w[1].path)
        || gc
            .source_inventory
            .iter()
            .any(|e| !allowed_path(&e.path) || e.bytes > MAX_FILE_BYTES)
        || gc.quarantine.iter().any(|e| {
            !e.path.starts_with("objects/")
                || initial.get(&e.path) != Some(&e)
                || e.sha256.as_str().strip_prefix("sha256:") != e.path.strip_prefix("objects/")
        })
    {
        return Err(ServiceError::Artifact);
    }
    sum_bytes(&gc.source_inventory)?;
    Ok(())
}
fn expected_source(plan: &LocalPurgePlanV1) -> Vec<LocalBackupFileV1> {
    let selected: BTreeSet<_> = plan.gc_plan.quarantine.iter().map(|e| &e.path).collect();
    plan.gc_plan
        .source_inventory
        .iter()
        .filter(|e| !selected.contains(&e.path))
        .cloned()
        .collect()
}

impl LocalMaintenanceSessionV1 {
    /// Build a read-only proposal after rechecking completed GC, unchanged
    /// source history, native-only roots, all payload bytes and explicit pins.
    pub fn plan_purge(
        &self,
        quarantine: &Path,
        expected_gc_hash: &Sha256Digest,
        policy: LocalPurgePolicyV1,
    ) -> Result<LocalPurgePlanV1, ServiceError> {
        self.validate()?;
        self.validate_quarantine(quarantine)?;
        if !is_absent(&self.state.join(PURGE_PENDING))? || !is_absent(&quarantine.join(JOURNAL))? {
            return Err(ServiceError::Persistence);
        }
        let gc_plan: LocalGcPlanV1 = serde_json::from_slice(&read_private(
            &quarantine.join("plan.json"),
            self.owner,
            MAX_MANIFEST_BYTES,
        )?)
        .map_err(|_| ServiceError::Artifact)?;
        let plan = LocalPurgePlanV1 {
            version: 1,
            kind: KIND.into(),
            gc_plan,
            gc_plan_hash: expected_gc_hash.clone(),
            policy,
            production_activation: false,
        };
        let hash = plan.plan_hash()?;
        self.purge_context(&plan, false)?;
        self.purge_payloads(&plan, &hash, false)?;
        // No writes above. Recheck the complete source inventory before returning.
        if inventory(&self.state, self.owner)? != expected_source(&plan) {
            return Err(ServiceError::Artifact);
        }
        Ok(plan)
    }

    /// Arm a new purge with an explicitly retained plan hash and admissible clock.
    /// Existing partial journals must use resume_purge; never silently adopt them.
    pub fn apply_purge(
        &self,
        plan: &LocalPurgePlanV1,
        expected_hash: &Sha256Digest,
        now: u64,
    ) -> Result<LocalPurgeReceiptV1, ServiceError> {
        if &plan.plan_hash()? != expected_hash
            || now < plan.policy.not_before_unix_ms
            || now >= plan.policy.expires_at_unix_ms
            || self.plan_purge(
                &plan.gc_plan.quarantine_directory,
                &plan.gc_plan_hash,
                plan.policy.clone(),
            )? != *plan
        {
            return Err(ServiceError::Configuration);
        }
        let journal = plan.gc_plan.quarantine_directory.join(JOURNAL);
        create_private(&journal)?;
        sync_dir(&plan.gc_plan.quarantine_directory)?;
        create_private(&journal.join("intents"))?;
        write_new(&journal.join("plan.json"), &encode(plan)?)?;
        sync_dir(&journal)?;
        self.resume_purge(&plan.gc_plan.quarantine_directory, expected_hash, now)
    }

    /// Recover only the retained exact proposal. Missing bytes without a durable
    /// intent, changed source/pins, conflicting journals and expiry fail closed.
    /// After expiry an already-finished deletion may only finalize its receipt.
    pub fn resume_purge(
        &self,
        quarantine: &Path,
        expected_hash: &Sha256Digest,
        now: u64,
    ) -> Result<LocalPurgeReceiptV1, ServiceError> {
        self.validate()?;
        self.validate_quarantine(quarantine)?;
        let journal = quarantine.join(JOURNAL);
        if private_root(&journal)?.uid() != self.owner
            || private_root(&journal.join("intents"))?.uid() != self.owner
        {
            return Err(ServiceError::Artifact);
        }
        let encoded = read_private(&journal.join("plan.json"), self.owner, MAX_MANIFEST_BYTES)?;
        let plan: LocalPurgePlanV1 =
            serde_json::from_slice(&encoded).map_err(|_| ServiceError::Artifact)?;
        if &plan.plan_hash()? != expected_hash || plan.gc_plan.quarantine_directory != quarantine {
            return Err(ServiceError::Configuration);
        }
        let source_marker = self.state.join(PURGE_PENDING);
        let marker_absent = is_absent(&source_marker)?;
        let receipt_absent = is_absent(&journal.join("receipt.json"))?;
        if !marker_absent
            && read_private(&source_marker, self.owner, MAX_MANIFEST_BYTES)? != encoded
        {
            return Err(ServiceError::Artifact);
        }
        // A pre-arm crash may leave a complete plan and empty intent directory.
        // Any side-effect history without either fence or final receipt is ambiguous.
        if marker_absent && receipt_absent && !entries(&journal.join("intents"))?.is_empty() {
            return Err(ServiceError::Persistence);
        }
        self.purge_context(&plan, true)?;
        let present = self.purge_payloads(&plan, expected_hash, true)?;
        if now < plan.policy.not_before_unix_ms
            || (now >= plan.policy.expires_at_unix_ms
                && (present != 0 || marker_absent && receipt_absent))
        {
            return Err(ServiceError::Configuration);
        }
        if !receipt_absent && present != 0 {
            return Err(ServiceError::Artifact);
        }
        if marker_absent && receipt_absent {
            write_new(&source_marker, &encoded)?;
            sync_dir(&self.state)?;
        }
        let target_path = quarantine.join("objects");
        let target = directory(&target_path, self.owner)?;
        for entry in &plan.gc_plan.quarantine {
            self.validate()?;
            let raw = entry
                .path
                .strip_prefix("objects/")
                .ok_or(ServiceError::Artifact)?;
            let intent_path = journal.join("intents").join(format!("{raw}.json"));
            let intent = UnlinkIntentV1 {
                version: 1,
                purge_plan_hash: expected_hash.clone(),
                file: entry.clone(),
            };
            if !is_absent(&target_path.join(raw))? {
                if !receipt_absent
                    || now < plan.policy.not_before_unix_ms
                    || now >= plan.policy.expires_at_unix_ms
                {
                    return Err(ServiceError::Configuration);
                }
                let data = read_private(&target_path.join(raw), self.owner, MAX_FILE_BYTES)?;
                if digest(&data)? != entry.sha256 || data.len() as u64 != entry.bytes {
                    return Err(ServiceError::Artifact);
                }
                if is_absent(&intent_path)? {
                    write_new(&intent_path, &encode(&intent)?)?;
                    sync_dir(&journal.join("intents"))?;
                }
                // Intent validation precedes every irreversible unlink, including resume.
                let saved: UnlinkIntentV1 = serde_json::from_slice(&read_private(
                    &intent_path,
                    self.owner,
                    MAX_MANIFEST_BYTES,
                )?)
                .map_err(|_| ServiceError::Artifact)?;
                if saved != intent
                    || read_private(&source_marker, self.owner, MAX_MANIFEST_BYTES)? != encoded
                {
                    return Err(ServiceError::Artifact);
                }
                directory_current(&target, &target_path, self.owner)?;
                unlinkat(&target, raw, UnlinkatFlags::NoRemoveDir)
                    .map_err(|_| ServiceError::Filesystem)?;
                target.sync_all().map_err(|_| ServiceError::Filesystem)?;
            }
        }
        target.sync_all().map_err(|_| ServiceError::Filesystem)?;
        if self.purge_payloads(&plan, expected_hash, true)? != 0 {
            return Err(ServiceError::Artifact);
        }
        self.purge_context(&plan, true)?;
        let receipt = LocalPurgeReceiptV1 {
            version: 1,
            purge_plan_hash: expected_hash.clone(),
            unlinked_objects: plan.gc_plan.quarantine.len(),
            unlinked_payload_bytes: sum_bytes(&plan.gc_plan.quarantine)?,
            source_inventory_hash: digest(&encode(&expected_source(&plan))?)?,
            secure_erasure_verified: false,
            production_activation: false,
            node_retirement_verified: false,
        };
        let receipt_path = journal.join("receipt.json");
        if receipt_absent {
            write_new(&receipt_path, &encode(&receipt)?)?;
            sync_dir(&journal)?;
        } else {
            let old: LocalPurgeReceiptV1 = serde_json::from_slice(&read_private(
                &receipt_path,
                self.owner,
                MAX_MANIFEST_BYTES,
            )?)
            .map_err(|_| ServiceError::Artifact)?;
            if old != receipt {
                return Err(ServiceError::Artifact);
            }
        }
        self.validate()?;
        if !is_absent(&source_marker)? {
            if read_private(&source_marker, self.owner, MAX_MANIFEST_BYTES)? != encoded {
                return Err(ServiceError::Artifact);
            }
            let source = directory(&self.state, self.owner)?;
            directory_current(&source, &self.state, self.owner)?;
            unlinkat(&source, PURGE_PENDING, UnlinkatFlags::NoRemoveDir)
                .map_err(|_| ServiceError::Filesystem)?;
            source.sync_all().map_err(|_| ServiceError::Filesystem)?;
        }
        Ok(receipt)
    }

    fn purge_context(&self, plan: &LocalPurgePlanV1, journal: bool) -> Result<(), ServiceError> {
        self.validate()?;
        validate_plan_shape(plan)?;
        let gc = &plan.gc_plan;
        self.validate_quarantine(&gc.quarantine_directory)?;
        if gc.state_directory != self.state
            || !is_absent(&self.state.join("gc-pending-v1.json"))?
            || private_root(&gc.quarantine_directory)?.uid() != self.owner
        {
            return Err(ServiceError::Persistence);
        }
        let retained: LocalGcPlanV1 = serde_json::from_slice(&read_private(
            &gc.quarantine_directory.join("plan.json"),
            self.owner,
            MAX_MANIFEST_BYTES,
        )?)
        .map_err(|_| ServiceError::Artifact)?;
        let receipt: LocalGcReceiptV1 = serde_json::from_slice(&read_private(
            &gc.quarantine_directory.join("receipt.json"),
            self.owner,
            MAX_MANIFEST_BYTES,
        )?)
        .map_err(|_| ServiceError::Artifact)?;
        if retained != *gc
            || receipt
                != (LocalGcReceiptV1 {
                    version: 1,
                    plan_hash: plan.gc_plan_hash.clone(),
                    quarantined_objects: gc.quarantine.len(),
                    quarantined_bytes: sum_bytes(&gc.quarantine)?,
                    permanent_deletion: false,
                    production_activation: false,
                    node_retirement_verified: false,
                })
        {
            return Err(ServiceError::Artifact);
        }
        let mut top = vec![
            "objects".to_owned(),
            "plan.json".to_owned(),
            "receipt.json".to_owned(),
        ];
        if journal {
            top.push(JOURNAL.into());
            top.sort();
        }
        if entries(&gc.quarantine_directory)? != top
            || inventory_ignoring(&self.state, self.owner, Some(PURGE_PENDING))?
                != expected_source(plan)
        {
            return Err(ServiceError::Artifact);
        }
        let pins = gc.pins.union(&plan.policy.pins).cloned().collect();
        let (revision, roots) = self.gc_roots(&gc.definition_hash, &pins)?;
        if revision != gc.campaign_revision
            || gc.quarantine.iter().any(|e| roots.contains(&e.sha256))
        {
            return Err(ServiceError::Persistence);
        }
        Ok(())
    }

    fn purge_payloads(
        &self,
        plan: &LocalPurgePlanV1,
        hash: &Sha256Digest,
        journal: bool,
    ) -> Result<usize, ServiceError> {
        let target = plan.gc_plan.quarantine_directory.join("objects");
        if private_root(&target)?.uid() != self.owner {
            return Err(ServiceError::Artifact);
        }
        let expected: BTreeMap<_, _> = plan
            .gc_plan
            .quarantine
            .iter()
            .map(|e| (e.path.trim_start_matches("objects/").to_owned(), e))
            .collect();
        let names = entries(&target)?;
        if names.iter().any(|n| !expected.contains_key(n)) {
            return Err(ServiceError::Artifact);
        }
        let intents = plan
            .gc_plan
            .quarantine_directory
            .join(JOURNAL)
            .join("intents");
        if journal {
            let j = plan.gc_plan.quarantine_directory.join(JOURNAL);
            if private_root(&j)?.uid() != self.owner || private_root(&intents)?.uid() != self.owner
            {
                return Err(ServiceError::Artifact);
            }
            let files = entries(&j)?;
            if files != ["intents".to_owned(), "plan.json".to_owned()]
                && files
                    != [
                        "intents".to_owned(),
                        "plan.json".to_owned(),
                        "receipt.json".to_owned(),
                    ]
            {
                return Err(ServiceError::Artifact);
            }
            let saved: LocalPurgePlanV1 = serde_json::from_slice(&read_private(
                &j.join("plan.json"),
                self.owner,
                MAX_MANIFEST_BYTES,
            )?)
            .map_err(|_| ServiceError::Artifact)?;
            if saved != *plan {
                return Err(ServiceError::Artifact);
            }
            for name in entries(&intents)? {
                let raw = name.strip_suffix(".json").ok_or(ServiceError::Artifact)?;
                if !expected.contains_key(raw) {
                    return Err(ServiceError::Artifact);
                }
            }
        }
        for (raw, entry) in &expected {
            let present = names.contains(raw);
            let intent_path = intents.join(format!("{raw}.json"));
            let has_intent = journal && !is_absent(&intent_path)?;
            if !present && !has_intent {
                return Err(ServiceError::Artifact);
            }
            if has_intent {
                let saved: UnlinkIntentV1 = serde_json::from_slice(&read_private(
                    &intent_path,
                    self.owner,
                    MAX_MANIFEST_BYTES,
                )?)
                .map_err(|_| ServiceError::Artifact)?;
                if saved
                    != (UnlinkIntentV1 {
                        version: 1,
                        purge_plan_hash: hash.clone(),
                        file: (*entry).clone(),
                    })
                {
                    return Err(ServiceError::Artifact);
                }
            }
            if present {
                let data = read_private(&target.join(raw), self.owner, MAX_FILE_BYTES)?;
                if digest(&data)? != entry.sha256 || data.len() as u64 != entry.bytes {
                    return Err(ServiceError::Artifact);
                }
            }
        }
        if entries(&target)? != names {
            return Err(ServiceError::Artifact);
        }
        Ok(names.len())
    }
}
