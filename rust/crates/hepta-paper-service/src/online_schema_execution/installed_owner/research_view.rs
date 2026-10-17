//! A root-published minimum read-only schema history view. Public signatures
//! remain evidence; this delivery cannot mint research or external authority.
use super::{
    SchemaOperationIdentityV1, installation::ObservedInstalledSchemaProfileV1,
    systemd::HeldInstalledSchemaMaintenanceV1,
};
use crate::{
    online_schema_transition::{
        audit::verify_audit, history::checkpoint::load_schema_transition_checkpoint_v1,
    },
    sqlite_mutation_coordinator::{
        Result,
        authority::{MutationAuthorityTransportV1, PinnedMutationAuthorityV1, files::Snapshot},
        contracts::schema_transition::normalize_schema_numbers_v1,
        error, hash_bytes, keys,
        manifest::writer_manifest_hash_v1,
        text,
    },
    state_database_inventory::ObservedStateDatabaseInventoryV1,
    state_recoverability::publication::{Directory, publish_receipt},
};
use nix::{
    fcntl::{OFlag, RenameFlags, openat, renameat2},
    sys::stat::{Mode, fchmod},
    unistd::{Gid, Uid, fchown},
};
use serde_json::{Value, json};
use std::{
    fs::{self, File, Metadata},
    io::Read,
    os::{fd::AsFd, unix::fs::MetadataExt},
    path::{Component, Path, PathBuf},
};
const INTENT: &str = "RESEARCH_CHECKPOINT.v1.json";
const MAXIMUM: u64 = 16 * 1024 * 1024;
fn invalid() -> crate::sqlite_mutation_coordinator::SqliteMutationCoordinatorError {
    error("autonomous_research_installed_schema_readonly_view_invalid_or_changed")
}
struct Reader {
    uid: u32,
    gid: u32,
    groups: Vec<u32>,
}
impl Reader {
    fn from_profile(profile: &ObservedInstalledSchemaProfileV1) -> Result<Self> {
        profile.assert_current()?;
        let unit = profile
            .source_units()
            .iter()
            .find(|u| u.unit == "autonomous-research-supervisor.service")
            .ok_or_else(invalid)?;
        if unit.uid == 0 || unit.gid == 0 || unit.supplementary_gids.contains(&0) {
            return Err(invalid());
        }
        Ok(Self {
            uid: unit.uid,
            gid: unit.gid,
            groups: unit.supplementary_gids.clone(),
        })
    }
    fn search(&self, metadata: &Metadata) -> bool {
        let bit = if metadata.uid() == self.uid {
            0o100
        } else if metadata.gid() == self.gid || self.groups.contains(&metadata.gid()) {
            0o010
        } else {
            0o001
        };
        metadata.is_dir() && metadata.mode() & bit != 0
    }
    fn assert_search_path(&self, path: &Path) -> Result<()> {
        if !path.is_absolute() {
            return Err(invalid());
        }
        let mut cursor = PathBuf::from("/");
        let mut held = File::open("/").map_err(|_| invalid())?;
        if !self.search(&held.metadata().map_err(|_| invalid())?) {
            return Err(invalid());
        }
        for component in path.components() {
            let Component::Normal(name) = component else {
                if component != Component::RootDir {
                    return Err(invalid());
                }
                continue;
            };
            let next = File::from(
                openat(
                    held.as_fd(),
                    Path::new(name),
                    OFlag::O_RDONLY | OFlag::O_DIRECTORY | OFlag::O_NOFOLLOW | OFlag::O_CLOEXEC,
                    Mode::empty(),
                )
                .map_err(|_| invalid())?,
            );
            cursor.push(name);
            let named = fs::symlink_metadata(&cursor).map_err(|_| invalid())?;
            let actual = next.metadata().map_err(|_| invalid())?;
            if named.is_symlink() || !same_directory(&named, &actual) || !self.search(&actual) {
                return Err(invalid());
            }
            held = next;
        }
        Ok(())
    }
}
fn same_directory(a: &Metadata, b: &Metadata) -> bool {
    a.is_dir()
        && b.is_dir()
        && (a.dev(), a.ino(), a.uid(), a.gid(), a.mode())
            == (b.dev(), b.ino(), b.uid(), b.gid(), b.mode())
}
fn root_metadata(m: &Metadata) -> Result<()> {
    if !m.is_file() || m.nlink() != 1 || m.uid() != 0 || m.mode() & 0o022 != 0 {
        return Err(invalid());
    }
    Ok(())
}
fn root_file(file: &File) -> Result<()> {
    root_metadata(&file.metadata().map_err(|_| invalid())?)
}
// Raw durable members can include a genuine empty WAL. JSON Snapshot keeps
// its nonempty rule; this held-FD reader is only for selected root-owned bytes.
struct RawSnapshot {
    file: File,
    path: PathBuf,
    metadata: Metadata,
}
impl RawSnapshot {
    fn load(directory: &Directory, name: &str, expected: &str, maximum: u64) -> Result<Self> {
        directory.assert_current()?;
        let path = directory.path.join(name);
        let mut file = File::from(
            openat(
                directory.held.as_fd(),
                name,
                OFlag::O_RDONLY | OFlag::O_NOFOLLOW | OFlag::O_NONBLOCK | OFlag::O_CLOEXEC,
                Mode::empty(),
            )
            .map_err(|_| invalid())?,
        );
        root_file(&file)?;
        let metadata = file.metadata().map_err(|_| invalid())?;
        root_metadata(&metadata)?;
        if metadata.len() > maximum {
            return Err(invalid());
        }
        let mut bytes = Vec::new();
        (&mut file)
            .take(maximum + 1)
            .read_to_end(&mut bytes)
            .map_err(|_| invalid())?;
        if bytes.len() as u64 != metadata.len() || hash_bytes(&bytes) != expected {
            return Err(invalid());
        }
        let result = Self {
            file,
            path,
            metadata,
        };
        result.assert_current()?;
        directory.assert_current()?;
        Ok(result)
    }
    fn assert_current(&self) -> Result<()> {
        let held = self.file.metadata().map_err(|_| invalid())?;
        let named = fs::symlink_metadata(&self.path).map_err(|_| invalid())?;
        let same = |m: &Metadata| {
            m.is_file()
                && !m.is_symlink()
                && (
                    m.dev(),
                    m.ino(),
                    m.uid(),
                    m.gid(),
                    m.mode(),
                    m.nlink(),
                    m.len(),
                    m.mtime(),
                    m.mtime_nsec(),
                    m.ctime(),
                    m.ctime_nsec(),
                ) == (
                    self.metadata.dev(),
                    self.metadata.ino(),
                    self.metadata.uid(),
                    self.metadata.gid(),
                    self.metadata.mode(),
                    self.metadata.nlink(),
                    self.metadata.len(),
                    self.metadata.mtime(),
                    self.metadata.mtime_nsec(),
                    self.metadata.ctime(),
                    self.metadata.ctime_nsec(),
                )
        };
        if !same(&held) || !same(&named) {
            return Err(invalid());
        }
        Ok(())
    }
}
// An existing private intent is not yet a trusted Snapshot: observe it through
// the retained execution directory, bound bytes and all identities first.
fn read_private_intent(execution: &Directory) -> Result<Value> {
    read_private_intent_inner(
        execution,
        #[cfg(test)]
        &mut |_| Ok(()),
    )
}
fn read_private_intent_inner(
    execution: &Directory,
    #[cfg(test)] after_observation: &mut dyn FnMut(&File) -> Result<()>,
) -> Result<Value> {
    execution.assert_current()?;
    let file = File::from(
        openat(
            execution.held.as_fd(),
            INTENT,
            OFlag::O_RDONLY | OFlag::O_NOFOLLOW | OFlag::O_NONBLOCK | OFlag::O_CLOEXEC,
            Mode::empty(),
        )
        .map_err(|_| invalid())?,
    );
    root_file(&file)?;
    let metadata = file.metadata().map_err(|_| invalid())?;
    root_metadata(&metadata)?;
    if metadata.mode() & 0o077 != 0 || metadata.len() > MAXIMUM {
        return Err(invalid());
    }
    let observed = RawSnapshot {
        file,
        path: execution.path.join(INTENT),
        metadata,
    };
    observed.assert_current()?;
    execution.assert_current()?;
    #[cfg(test)]
    after_observation(&observed.file)?;
    let mut bytes = Vec::new();
    (&observed.file)
        .take(MAXIMUM + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| invalid())?;
    if bytes.len() as u64 > MAXIMUM || bytes.len() as u64 != observed.metadata.len() {
        return Err(invalid());
    }
    observed.assert_current()?;
    execution.assert_current()?;
    let pin = Snapshot::load(
        &observed.path,
        &hash_bytes(&bytes),
        MAXIMUM,
        &invalid().code,
    )?;
    observed.assert_current()?;
    execution.assert_current()?;
    let selected = pin.json(&invalid().code)?;
    pin.assert_current()?;
    observed.assert_current()?;
    execution.assert_current()?;
    Ok(selected)
}
fn mode_group(file: &File, gid: u32, mode: u32) -> Result<()> {
    fchown(file, Some(Uid::from_raw(0)), Some(Gid::from_raw(gid))).map_err(|_| invalid())?;
    fchmod(file, Mode::from_bits_truncate(mode)).map_err(|_| invalid())?;
    file.sync_all().map_err(|_| invalid())
}
fn permission_file(
    directory: &Directory,
    name: &str,
    sha: &str,
    maximum: u64,
    reader: &Reader,
) -> Result<()> {
    directory.assert_current()?;
    let pin = RawSnapshot::load(directory, name, sha, maximum)?;
    root_file(&pin.file)?;
    pin.assert_current()?;
    mode_group(&pin.file, reader.gid, 0o440)?;
    let current = RawSnapshot::load(directory, name, sha, maximum)?;
    let m = current.file.metadata().map_err(|_| invalid())?;
    if m.gid() != reader.gid || m.mode() & 0o7777 != 0o440 {
        return Err(invalid());
    }
    current.assert_current()?;
    directory.held.sync_all().map_err(|_| invalid())?;
    directory.assert_current()
}
fn permission_directory(directory: &Directory, reader: &Reader, mode: u32) -> Result<()> {
    directory.assert_current()?;
    mode_group(&directory.held, reader.gid, mode)?;
    directory.assert_current()?;
    let m = directory.held.metadata().map_err(|_| invalid())?;
    if m.uid() != 0 || m.gid() != reader.gid || m.mode() & 0o7777 != mode {
        return Err(invalid());
    }
    Ok(())
}
fn random_name() -> Result<String> {
    let mut bytes = [0u8; 16];
    getrandom::fill(&mut bytes).map_err(|_| invalid())?;
    Ok(format!("attempt-{}", hex::encode(bytes)))
}
fn existing(directory: &Directory, name: &str, expected: &str, maximum: u64) -> Result<bool> {
    directory.assert_current()?;
    let path = directory.path.join(name);
    if matches!(fs::symlink_metadata(&path), Err(e) if e.kind()==std::io::ErrorKind::NotFound) {
        return Ok(false);
    }
    let pin = RawSnapshot::load(directory, name, expected, maximum)?;
    root_file(&pin.file)?;
    pin.assert_current()?;
    Ok(true)
}
fn publish_file(
    attempts: &Directory,
    target: &Directory,
    name: &str,
    expected: &str,
    maximum: u64,
    write: impl FnOnce(&File) -> Result<()>,
) -> Result<()> {
    if existing(target, name, expected, maximum)? {
        return Ok(());
    }
    let attempt = random_name()?;
    let file = File::from(
        openat(
            attempts.held.as_fd(),
            attempt.as_str(),
            OFlag::O_RDWR | OFlag::O_CREAT | OFlag::O_EXCL | OFlag::O_NOFOLLOW | OFlag::O_CLOEXEC,
            Mode::from_bits_truncate(0o600),
        )
        .map_err(|_| invalid())?,
    );
    write(&file)?;
    root_file(&file)?;
    file.sync_all().map_err(|_| invalid())?;
    let pin = RawSnapshot::load(attempts, &attempt, expected, maximum)?;
    pin.assert_current()?;
    target.assert_current()?;
    attempts.assert_current()?;
    renameat2(
        attempts.held.as_fd(),
        attempt.as_str(),
        target.held.as_fd(),
        name,
        RenameFlags::RENAME_NOREPLACE,
    )
    .map_err(|_| invalid())?;
    attempts.held.sync_all().map_err(|_| invalid())?;
    target.held.sync_all().map_err(|_| invalid())?;
    if !existing(target, name, expected, maximum)? {
        return Err(invalid());
    }
    Ok(())
}
fn snapshot_audit<T: MutationAuthorityTransportV1>(
    runtime: &Path,
    final_pin: &str,
    inventory: &Value,
    writer: &Value,
    authority: &PinnedMutationAuthorityV1<T>,
) -> Result<Snapshot> {
    let pin = Snapshot::load(
        &runtime.join("autonomous-research/online-schema-transition/FINAL.json"),
        final_pin,
        MAXIMUM,
        &invalid().code,
    )?;
    root_file(&pin.file)?;
    let value = normalize_schema_numbers_v1(&pin.json(&invalid().code)?)?;
    verify_audit(
        &value,
        pin.bytes(),
        inventory,
        &writer_manifest_hash_v1(writer)?,
        authority,
    )?;
    pin.assert_current()?;
    Ok(pin)
}
/// The production caller retains the existing actual stopped-writer owner for
/// every copy and permission boundary. Caller JSON cannot select a reader.
pub(super) fn publish<T: MutationAuthorityTransportV1>(
    profile: &ObservedInstalledSchemaProfileV1,
    operation: &SchemaOperationIdentityV1,
    held: &HeldInstalledSchemaMaintenanceV1<'_>,
    inventory: &ObservedStateDatabaseInventoryV1,
    writer: &Value,
    authority: &PinnedMutationAuthorityV1<T>,
    final_pin: &str,
) -> Result<Value> {
    profile.assert_current()?;
    held.assert_current()?;
    if inventory.runtime_root() != profile.runtime_root()
        || inventory.runtime_root() != operation.runtime_root
    {
        return Err(invalid());
    }
    let reader = Reader::from_profile(profile)?;
    let result = publish_inner(
        operation,
        &reader,
        inventory,
        writer,
        authority,
        final_pin,
        &mut |_| held.assert_current(),
    )?;
    profile.assert_current()?;
    held.assert_current()?;
    Ok(result)
}
fn publish_inner<T: MutationAuthorityTransportV1>(
    operation: &SchemaOperationIdentityV1,
    reader: &Reader,
    inventory: &ObservedStateDatabaseInventoryV1,
    writer: &Value,
    authority: &PinnedMutationAuthorityV1<T>,
    final_pin: &str,
    boundary: &mut dyn FnMut(&str) -> Result<()>,
) -> Result<Value> {
    if nix::unistd::getuid().as_raw() != 0 || nix::unistd::geteuid().as_raw() != 0 {
        return Err(invalid());
    }
    boundary("research_view_boundary")?;
    inventory.assert_current()?;
    let runtime = &operation.runtime_root;
    reader.assert_search_path(&runtime.join("autonomous-research"))?;
    let execution = Directory::open_or_create(&operation.barrier_root.join("execution"), false)?;
    let intent_path = execution.path.join(INTENT);
    let intent = if matches!(fs::symlink_metadata(&intent_path),Err(e) if e.kind()==std::io::ErrorKind::NotFound)
    {
        snapshot_audit(runtime, final_pin, inventory.value(), writer, authority)?;
        let selected = json!({"version":1,"kind":"HeptaInstalledSchemaResearchCheckpointIntentV1","runtimeRoot":runtime,"transitionId":operation.transition_id,"planHash":operation.plan_hash,"profileSha256":operation.profile_sha256,"finalReceiptFileSha256":final_pin,"readerUid":reader.uid,"readerGid":reader.gid,"readerSupplementaryGids":reader.groups,"originalInventory":inventory.value()});
        boundary("research_view_boundary")?;
        inventory.assert_current()?;
        publish_receipt(&execution, INTENT, &selected, None)?;
        selected
    } else {
        read_private_intent(&execution)?
    };
    if !keys(
        &intent,
        &[
            "version",
            "kind",
            "runtimeRoot",
            "transitionId",
            "planHash",
            "profileSha256",
            "finalReceiptFileSha256",
            "readerUid",
            "readerGid",
            "readerSupplementaryGids",
            "originalInventory",
        ],
    ) || intent["version"] != 1
        || intent["kind"] != "HeptaInstalledSchemaResearchCheckpointIntentV1"
        || intent["runtimeRoot"] != json!(runtime)
        || intent["transitionId"] != operation.transition_id
        || intent["planHash"] != operation.plan_hash
        || intent["profileSha256"] != operation.profile_sha256
        || intent["finalReceiptFileSha256"] != final_pin
        || intent["readerUid"] != reader.uid
        || intent["readerGid"] != reader.gid
        || intent["readerSupplementaryGids"] != json!(reader.groups)
    {
        return Err(invalid());
    }
    snapshot_audit(
        runtime,
        final_pin,
        &intent["originalInventory"],
        writer,
        authority,
    )?;
    boundary("after_checkpoint_intent")?;
    let parent = Directory::open_or_create(&runtime.join("online-schema-checkpoints"), true)?;
    let name = operation
        .transition_id
        .strip_prefix("sha256:")
        .filter(|v| v.len() == 64 && v.bytes().all(|b| b.is_ascii_hexdigit()))
        .ok_or_else(invalid)?;
    let target = parent.path.join(name);
    let selected_rows = intent["originalInventory"]["instances"]
        .as_array()
        .ok_or_else(invalid)?;
    if matches!(fs::symlink_metadata(&target),Err(e) if e.kind()==std::io::ErrorKind::NotFound) {
        // A crash before publication retries only the selected original state.
        // Later business results cannot be re-photographed as that checkpoint.
        if inventory.value() != &intent["originalInventory"] {
            return Err(error(
                "autonomous_research_installed_schema_checkpoint_original_state_advanced",
            ));
        }
        let stage = Directory::open_or_create(&parent.path.join(format!("staging-{name}")), true)?;
        let attempts =
            Directory::open_or_create(&parent.path.join(format!("private-attempts-{name}")), true)?;
        let databases = Directory::open_or_create(&stage.path.join("databases"), true)?;
        let report = serde_json::to_vec(&intent["originalInventory"]).map_err(|_| invalid())?;
        publish_file(
            &attempts,
            &stage,
            "POST_INVENTORY.json",
            &hash_bytes(&report),
            MAXIMUM,
            |file| {
                use std::os::unix::fs::FileExt;
                file.write_all_at(&report, 0).map_err(|_| invalid())?;
                file.sync_all().map_err(|_| invalid())
            },
        )?;
        for (index, row) in selected_rows.iter().enumerate() {
            boundary("research_view_boundary")?;
            let id = text(row, "instanceId")?;
            let main = format!("{index:03}.sqlite");
            publish_file(
                &attempts,
                &databases,
                &main,
                text(row, "sourceSha256")?,
                256 * 1024 * 1024,
                |file| inventory.copy_schema_checkpoint_file_v1(id, false, file),
            )?;
            if !row["walFileIdentity"].is_null() {
                publish_file(
                    &attempts,
                    &databases,
                    &format!("{main}-wal"),
                    text(row, "walSha256")?,
                    256 * 1024 * 1024,
                    |file| inventory.copy_schema_checkpoint_file_v1(id, true, file),
                )?;
            }
        }
        boundary("research_view_boundary")?;
        inventory.assert_current()?;
        let proof =
            load_schema_transition_checkpoint_v1(&stage.path, inventory, writer, authority)?;
        if proof.historical_inventory() != &intent["originalInventory"] {
            return Err(invalid());
        }
        proof.assert_current(inventory, authority)?;
        drop(proof);
        for (index, row) in selected_rows.iter().enumerate() {
            let main = format!("{index:03}.sqlite");
            permission_file(
                &databases,
                &main,
                text(row, "sourceSha256")?,
                256 * 1024 * 1024,
                reader,
            )?;
            if !row["walFileIdentity"].is_null() {
                permission_file(
                    &databases,
                    &format!("{main}-wal"),
                    text(row, "walSha256")?,
                    256 * 1024 * 1024,
                    reader,
                )?;
            }
        }
        permission_file(
            &stage,
            "POST_INVENTORY.json",
            &hash_bytes(&report),
            MAXIMUM,
            reader,
        )?;
        permission_directory(&databases, reader, 0o550)?;
        permission_directory(&stage, reader, 0o550)?;
        boundary("research_view_boundary")?;
        inventory.assert_current()?;
        parent.assert_current()?;
        boundary("before_checkpoint_publication")?;
        parent.publish_new(&stage, name)?;
        boundary("after_checkpoint_publication")?;
    }
    let proof = load_schema_transition_checkpoint_v1(&target, inventory, writer, authority)?;
    if proof.historical_inventory() != &intent["originalInventory"] {
        return Err(invalid());
    }
    proof.assert_current(inventory, authority)?;
    drop(proof);
    boundary("research_view_boundary")?;
    let control = Directory::open_or_create(
        &runtime.join("autonomous-research/online-schema-transition"),
        false,
    )?;
    permission_file(&control, "FINAL.json", final_pin, MAXIMUM, reader)?;
    permission_directory(&control, reader, 0o750)?;
    permission_directory(&parent, reader, 0o750)?;
    reader.assert_search_path(&target)?;
    reader.assert_search_path(&control.path)?;
    boundary("research_view_boundary")?;
    let proof = load_schema_transition_checkpoint_v1(&target, inventory, writer, authority)?;
    proof.assert_current(inventory, authority)?;
    execution.assert_current()?;
    Ok(
        json!({"version":1,"kind":"HeptaInstalledSchemaResearchReadonlyViewV1","checkpointRoot":target,"finalReceiptFileSha256":final_pin,"historicalInventoryHash":intent["originalInventory"]["inventoryHash"],"readerUid":reader.uid,"readerGid":reader.gid,"historicalSignaturesVerified":true,"activationAuthority":false,"researchQualification":false,"releaseAuthority":false,"submissionAuthority":false}),
    )
}
#[cfg(test)]
mod tests;
