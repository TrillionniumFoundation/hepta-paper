//! Stopped installed authority journal publication. Existing public-key history,
//! SQLite backup and native image owners supply all logical migration behavior.
//! This owner preserves the actual main/WAL/SHM/journal family, then queries each
//! no-replace rename on recovery. No service private key is opened or minted.
use super::{SchemaOperationIdentityV1, systemd::HeldStoppedInstalledAuthorityV1};
use crate::{
    local_state_authority::migration::LegacyAuthorityJournalVerifierV1,
    online_schema_execution::maintenance::normalization::finalization::recovery::restart::PreparedSchemaTargetRestartV2,
    sqlite_mutation_coordinator::{
        Result, authority::files::parse, error, hash, hash_bytes, keys, sha,
    },
    state_recoverability::publication::Directory,
};
use nix::{
    fcntl::{OFlag, RenameFlags, openat, renameat2},
    sys::stat::Mode,
    unistd::{Gid, Uid, fchown},
};
use rusqlite::{Connection, OpenFlags};
use serde_json::{Value, json};
use std::{
    fs::{self, File, Metadata},
    io::Read,
    os::{
        fd::AsFd,
        unix::fs::{FileExt, MetadataExt},
    },
    path::{Component, Path, PathBuf},
    time::Duration,
};
const CODE: &str = "autonomous_research_installed_authority_journal_invalid_or_changed";
const SUFFIXES: [&str; 4] = ["", "-wal", "-shm", "-journal"];
const RAW_NAMES: [&str; 4] = [
    "raw-main.sqlite",
    "raw-main.sqlite-wal",
    "raw-main.sqlite-shm",
    "raw-main.sqlite-journal",
];
const MAX_BYTES: u64 = 192 * 1024 * 1024;
const MAX_FAMILY: u64 = 384 * 1024 * 1024;
const INTENT: &str = "PUBLICATION.v1.json";
const COMPLETE: &str = "COMPLETED.v1.json";
fn invalid() -> crate::sqlite_mutation_coordinator::SqliteMutationCoordinatorError {
    error(CODE)
}
fn absent(path: &Path) -> Result<bool> {
    match fs::symlink_metadata(path) {
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(true),
        Ok(_) => Ok(false),
        Err(_) => Err(invalid()),
    }
}
fn canonical(path: &Path) -> bool {
    path.is_absolute()
        && path.to_str().is_some_and(|s| {
            !s.contains(['\0', '\\'])
                && !s.contains("//")
                && !s.ends_with('/')
                && !s
                    .split('/')
                    .any(|component| component == "." || component == "..")
        })
        && path
            .components()
            .all(|c| matches!(c, Component::RootDir | Component::Normal(_)))
}
fn identity(m: &Metadata) -> Value {
    json!({"device":m.dev(),"inode":m.ino(),"uid":m.uid(),"gid":m.gid(),"mode":m.mode(),"byteLength":m.len()})
}
fn metadata_valid(m: &Metadata, uid: u32, gid: u32) -> bool {
    m.is_file()
        && m.nlink() == 1
        && m.uid() == uid
        && m.gid() == gid
        && m.mode() & 0o7777 == 0o600
        && m.len() <= MAX_BYTES
}
fn read_held(file: &File, size: u64) -> Result<Vec<u8>> {
    if size > MAX_BYTES {
        return Err(invalid());
    }
    let mut bytes = Vec::new();
    bytes
        .try_reserve_exact(size as usize)
        .map_err(|_| invalid())?;
    bytes.resize(size as usize, 0);
    file.read_exact_at(&mut bytes, 0).map_err(|_| invalid())?;
    let mut extra = [0u8];
    if file.read_at(&mut extra, size).map_err(|_| invalid())? != 0 {
        return Err(invalid());
    }
    Ok(bytes)
}

// All ancestor FDs are retained. Every ancestor is root-protected; only the
// final existing journal parent may belong to the independently pinned service.
struct JournalParent {
    path: PathBuf,
    file: File,
    ancestors: Vec<(PathBuf, File, Value)>,
    identity: Value,
    uid: u32,
    gid: u32,
}
impl JournalParent {
    fn open(path: &Path, uid: u32, gid: u32) -> Result<Self> {
        if !canonical(path) {
            return Err(invalid());
        }
        let mut cursor = PathBuf::from("/");
        let mut file = File::open("/").map_err(|_| invalid())?;
        let mut ancestors = Vec::new();
        for component in path.components() {
            let Component::Normal(name) = component else {
                continue;
            };
            let metadata = file.metadata().map_err(|_| invalid())?;
            if metadata.uid() != 0 || metadata.mode() & 0o022 != 0 {
                return Err(invalid());
            }
            let child = File::from(
                openat(
                    file.as_fd(),
                    Path::new(name),
                    OFlag::O_RDONLY | OFlag::O_DIRECTORY | OFlag::O_NOFOLLOW | OFlag::O_CLOEXEC,
                    Mode::empty(),
                )
                .map_err(|_| invalid())?,
            );
            ancestors.push((cursor.clone(), file, directory_identity(&metadata)));
            cursor.push(name);
            file = child;
        }
        let metadata = file.metadata().map_err(|_| invalid())?;
        if !metadata.is_dir()
            || metadata.uid() != uid
            || metadata.gid() != gid
            || metadata.mode() & 0o7777 != 0o700
        {
            return Err(invalid());
        }
        let result = Self {
            path: cursor,
            file,
            ancestors,
            identity: directory_identity(&metadata),
            uid,
            gid,
        };
        result.current()?;
        Ok(result)
    }
    fn current(&self) -> Result<()> {
        for (path, file, expected) in &self.ancestors {
            let held = file.metadata().map_err(|_| invalid())?;
            let named = fs::symlink_metadata(path).map_err(|_| invalid())?;
            if !named.is_dir()
                || named.is_symlink()
                || held.uid() != 0
                || held.mode() & 0o022 != 0
                || directory_identity(&held) != *expected
                || directory_identity(&named) != *expected
            {
                return Err(invalid());
            }
        }
        let held = self.file.metadata().map_err(|_| invalid())?;
        let named = fs::symlink_metadata(&self.path).map_err(|_| invalid())?;
        if !named.is_dir()
            || named.is_symlink()
            || directory_identity(&held) != self.identity
            || directory_identity(&named) != self.identity
        {
            return Err(invalid());
        }
        Ok(())
    }
    fn sync(&self) -> Result<()> {
        self.current()?;
        self.file.sync_all().map_err(|_| invalid())
    }
}
fn directory_identity(m: &Metadata) -> Value {
    json!([m.dev(), m.ino(), m.uid(), m.gid(), m.mode()])
}

struct SourceFile {
    name: String,
    file: File,
    descriptor: Value,
}
impl SourceFile {
    fn observe(parent: &JournalParent, name: &str, expected: Option<&Value>) -> Result<Self> {
        parent.current()?;
        let file = File::from(
            openat(
                parent.file.as_fd(),
                name,
                OFlag::O_RDONLY | OFlag::O_NOFOLLOW | OFlag::O_CLOEXEC | OFlag::O_NONBLOCK,
                Mode::empty(),
            )
            .map_err(|_| invalid())?,
        );
        let metadata = file.metadata().map_err(|_| invalid())?;
        if !metadata_valid(&metadata, parent.uid, parent.gid) {
            return Err(invalid());
        }
        let mut descriptor = identity(&metadata);
        descriptor["sha256"] = json!(hash_bytes(&read_held(&file, metadata.len())?));
        if expected.is_some_and(|value| *value != descriptor) {
            return Err(invalid());
        }
        let result = Self {
            name: name.to_owned(),
            file,
            descriptor,
        };
        result.current(parent)?;
        Ok(result)
    }
    fn current(&self, parent: &JournalParent) -> Result<()> {
        parent.current()?;
        let held = self.file.metadata().map_err(|_| invalid())?;
        let named = fs::symlink_metadata(parent.path.join(&self.name)).map_err(|_| invalid())?;
        if !metadata_valid(&held, parent.uid, parent.gid)
            || !metadata_valid(&named, parent.uid, parent.gid)
            || identity(&held) != without_hash(&self.descriptor)
            || identity(&named) != without_hash(&self.descriptor)
            || self.descriptor["sha256"] != hash_bytes(&read_held(&self.file, held.len())?)
        {
            return Err(invalid());
        }
        Ok(())
    }
}
fn without_hash(value: &Value) -> Value {
    let mut result = value.clone();
    if let Some(fields) = result.as_object_mut() {
        fields.remove("sha256");
    }
    result
}
fn retired(base: &str, operation: &SchemaOperationIdentityV1, suffix: &str) -> String {
    format!(
        ".{base}.legacy-{}{suffix}",
        operation.transition_id.trim_start_matches("sha256:")
    )
}
fn resolve_source(
    parent: &JournalParent,
    base: &str,
    operation: &SchemaOperationIdentityV1,
    intent: Option<&Value>,
    index: usize,
) -> Result<Option<SourceFile>> {
    let original = format!("{base}{}", SUFFIXES[index]);
    let retired = retired(base, operation, SUFFIXES[index]);
    let original_absent = absent(&parent.path.join(&original))?;
    let retired_absent = absent(&parent.path.join(&retired))?;
    let Some(intent) = intent else {
        if !retired_absent {
            return Err(invalid());
        }
        return if original_absent {
            Ok(None)
        } else {
            SourceFile::observe(parent, &original, None).map(Some)
        };
    };
    let expected = intent["sourceFamily"].get(index).ok_or_else(invalid)?;
    if expected.is_null() {
        return if original_absent && retired_absent {
            Ok(None)
        } else {
            Err(invalid())
        };
    }
    if retired_absent {
        return SourceFile::observe(parent, &original, Some(expected)).map(Some);
    }
    let old = SourceFile::observe(parent, &retired, Some(expected))?;
    if !original_absent {
        // A moved sidecar never has a second active name. Main may only be the
        // already published exact native image, never a second legacy preimage.
        if index != 0 {
            return Err(invalid());
        }
        let native = SourceFile::observe(parent, &original, None)?;
        if native.descriptor["sha256"] != intent["nativeImageSha256"] {
            return Err(invalid());
        }
    }
    Ok(Some(old))
}
fn retire_file(
    parent: &JournalParent,
    file: &mut SourceFile,
    base: &str,
    operation: &SchemaOperationIdentityV1,
    index: usize,
) -> Result<()> {
    file.current(parent)?;
    let original = format!("{base}{}", SUFFIXES[index]);
    let destination = retired(base, operation, SUFFIXES[index]);
    if file.name == original {
        if !absent(&parent.path.join(&destination))? {
            return Err(invalid());
        }
        renameat2(
            parent.file.as_fd(),
            original.as_str(),
            parent.file.as_fd(),
            destination.as_str(),
            RenameFlags::RENAME_NOREPLACE,
        )
        .map_err(|_| invalid())?;
        parent.sync()?;
        file.name = destination;
        file.current(parent)?;
    } else if file.name != destination || (!absent(&parent.path.join(&original))? && index != 0) {
        return Err(invalid());
    }
    Ok(())
}
fn private_root(path: &Path) -> Result<Directory> {
    let directory = Directory::open_or_create(path, true)?;
    for ancestor in path.ancestors() {
        let metadata = fs::symlink_metadata(ancestor).map_err(|_| invalid())?;
        if !metadata.is_dir()
            || metadata.is_symlink()
            || metadata.uid() != 0
            || metadata.mode() & 0o022 != 0
        {
            return Err(invalid());
        }
        // Sync every newly introduced directory's parent before intent or any
        // source rename. Existing ancestor syncs are safe and bounded by depth.
        File::open(ancestor)
            .map_err(|_| invalid())?
            .sync_all()
            .map_err(|_| invalid())?;
    }
    root_current(&directory)?;
    Ok(directory)
}
fn root_current(directory: &Directory) -> Result<()> {
    directory.assert_current()?;
    if directory.held.metadata().map_err(|_| invalid())?.mode() & 0o7777 != 0o700 {
        return Err(invalid());
    }
    for path in directory.path.ancestors() {
        let metadata = fs::symlink_metadata(path).map_err(|_| invalid())?;
        if !metadata.is_dir()
            || metadata.is_symlink()
            || metadata.uid() != 0
            || metadata.mode() & 0o022 != 0
        {
            return Err(invalid());
        }
    }
    directory.assert_current()
}
fn regular_observation(metadata: &Metadata) -> Value {
    json!([
        identity(metadata),
        metadata.nlink(),
        metadata.mtime(),
        metadata.mtime_nsec(),
        metadata.ctime(),
        metadata.ctime_nsec()
    ])
}
fn root_bytes(directory: &Directory, name: &str, maximum: u64) -> Result<Vec<u8>> {
    root_current(directory)?;
    let mut file = File::from(
        openat(
            directory.held.as_fd(),
            name,
            OFlag::O_RDONLY | OFlag::O_NOFOLLOW | OFlag::O_CLOEXEC | OFlag::O_NONBLOCK,
            Mode::empty(),
        )
        .map_err(|_| invalid())?,
    );
    let metadata = file.metadata().map_err(|_| invalid())?;
    if !metadata_valid(&metadata, 0, metadata.gid()) || metadata.len() > maximum {
        return Err(invalid());
    }
    let mut bytes = Vec::new();
    (&mut file)
        .take(maximum + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| invalid())?;
    let after = file.metadata().map_err(|_| invalid())?;
    let named = fs::symlink_metadata(directory.path.join(name)).map_err(|_| invalid())?;
    if bytes.len() as u64 != metadata.len()
        || !metadata_valid(&named, 0, metadata.gid())
        || regular_observation(&after) != regular_observation(&metadata)
        || regular_observation(&named) != regular_observation(&metadata)
    {
        return Err(invalid());
    }
    root_current(directory)?;
    Ok(bytes)
}
fn write_exact(directory: &Directory, name: &str, bytes: &[u8]) -> Result<()> {
    root_current(directory)?;
    if bytes.len() as u64 > MAX_BYTES {
        return Err(invalid());
    }
    let creating = absent(&directory.path.join(name))?;
    let flags = OFlag::O_RDWR
        | OFlag::O_NOFOLLOW
        | OFlag::O_CLOEXEC
        | OFlag::O_NONBLOCK
        | if creating {
            OFlag::O_CREAT | OFlag::O_EXCL
        } else {
            OFlag::empty()
        };
    let file = File::from(
        openat(
            directory.held.as_fd(),
            name,
            flags,
            Mode::from_bits_truncate(0o600),
        )
        .map_err(|_| invalid())?,
    );
    let before = file.metadata().map_err(|_| invalid())?;
    if !metadata_valid(&before, 0, before.gid()) || before.len() as usize > bytes.len() {
        return Err(invalid());
    }
    let prefix = read_held(&file, before.len())?;
    let named = fs::symlink_metadata(directory.path.join(name)).map_err(|_| invalid())?;
    if prefix != bytes[..prefix.len()]
        || regular_observation(&file.metadata().map_err(|_| invalid())?)
            != regular_observation(&before)
        || regular_observation(&named) != regular_observation(&before)
    {
        return Err(invalid());
    }
    // A private interrupted prefix is queried against complete verified bytes;
    // only its missing suffix can be appended. No truncation/overwrite occurs.
    file.write_all_at(&bytes[prefix.len()..], prefix.len() as u64)
        .map_err(|_| invalid())?;
    file.sync_all().map_err(|_| invalid())?;
    root_current(directory)?;
    directory.held.sync_all().map_err(|_| invalid())?;
    if root_bytes(directory, name, MAX_BYTES)? != bytes {
        return Err(invalid());
    }
    Ok(())
}

enum ReadJournal {
    Images(Vec<u8>, Vec<u8>, Value),
    Native(Value),
}
fn build_images(
    verifier: &LegacyAuthorityJournalVerifierV1,
    working: &Directory,
    prepared: Option<&PreparedSchemaTargetRestartV2>,
) -> Result<ReadJournal> {
    verifier.current()?;
    root_current(working)?;
    let database = Connection::open_with_flags(
        working.path.join("authority.sqlite"),
        OpenFlags::SQLITE_OPEN_READ_ONLY
            | OpenFlags::SQLITE_OPEN_NOFOLLOW
            | OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )?;
    let result = (|| {
        database.busy_timeout(Duration::from_secs(5))?;
        database.pragma_update(None, "query_only", true)?;
        database.execute_batch("BEGIN DEFERRED")?;
        database.query_row("SELECT count(*) FROM main.sqlite_schema", [], |row| {
            row.get::<_, i64>(0)
        })?;
        let version: i64 = database.pragma_query_value(None, "user_version", |row| row.get(0))?;
        if version == 1 {
            let report = verifier.inspect_native_journal_snapshot(
                &database,
                prepared
                    .map(|value| (value.request(), value.target_authority_configuration_hash())),
            )?;
            return Ok(ReadJournal::Native(report));
        }
        if version != 0 {
            return Err(invalid());
        }
        let (native, legacy) = match prepared {
            Some(prepared) => {
                let images = verifier.build_pending_target_restart_images(
                    &database,
                    prepared.request(),
                    prepared.target_authority_configuration_hash(),
                )?;
                (images.native, images.legacy)
            }
            None => (
                verifier.build_offline_native_image(&database)?,
                verifier.build_offline_legacy_archive(&database)?,
            ),
        };
        if native.report()["sourceHistory"] != legacy.report()["sourceHistory"] {
            return Err(invalid());
        }
        Ok(ReadJournal::Images(
            native.bytes().to_vec(),
            legacy.bytes().to_vec(),
            json!({"native":native.report(),"legacy":legacy.report()}),
        ))
    })();
    let rollback = if database.is_autocommit() {
        Ok(())
    } else {
        database.execute_batch("ROLLBACK")
    };
    if let Err((connection, _)) = database.close() {
        drop(connection);
        return Err(invalid());
    }
    rollback?;
    verifier.current()?;
    root_current(working)?;
    result
}
fn intent_subject(
    operation: &SchemaOperationIdentityV1,
    prepared: Option<&PreparedSchemaTargetRestartV2>,
    path: &Path,
    verifier: &LegacyAuthorityJournalVerifierV1,
    daemon_pin: &str,
    process_pin: &str,
) -> Result<Value> {
    Ok(
        json!({"version":1,"kind":if prepared.is_some(){"HeptaInstalledAuthorityJournalPublicationIntentV1"}else{"HeptaInstalledAuthoritySourceJournalBootstrapIntentV1"},
        "runtimeRoot":operation.runtime_root,"transitionId":operation.transition_id,"planHash":operation.plan_hash,
        "profileSha256":operation.profile_sha256,"sourcePath":path,
        "sourceDaemonConfigurationFileSha256":daemon_pin,"sourceProcessConfigurationFileSha256":process_pin,
        "targetObservationRequestHash":prepared.map(|value|value.request_hash()),
        "targetAuthorityConfigurationHash":match prepared {Some(value)=>value.target_authority_configuration_hash().to_owned(),None=>hash("HeptaLocalAutonomousResearchStateAuthorityConfiguration",verifier.daemon_configuration())?},
        "preparedProgressJournalHash":prepared.map(|value|value.journal_hash())}),
    )
}

fn validate_intent(value: &Value, subject: &Value, uid: u32, gid: u32) -> Result<()> {
    if !keys(
        value,
        &[
            "version",
            "kind",
            "runtimeRoot",
            "transitionId",
            "planHash",
            "profileSha256",
            "sourcePath",
            "sourceDaemonConfigurationFileSha256",
            "sourceProcessConfigurationFileSha256",
            "targetObservationRequestHash",
            "targetAuthorityConfigurationHash",
            "preparedProgressJournalHash",
            "sourceFamily",
            "nativeImageSha256",
            "legacyArchiveSha256",
            "imageReportsSha256",
        ],
    ) {
        return Err(invalid());
    }
    for (name, expected) in subject.as_object().ok_or_else(invalid)? {
        if value[name] != *expected {
            return Err(invalid());
        }
    }
    let family = value["sourceFamily"]
        .as_array()
        .filter(|v| v.len() == 4)
        .ok_or_else(invalid)?;
    if family[0].is_null() {
        return Err(invalid());
    }
    let mut total = 0u64;
    for file in family.iter().filter(|v| !v.is_null()) {
        if !keys(
            file,
            &[
                "device",
                "inode",
                "uid",
                "gid",
                "mode",
                "byteLength",
                "sha256",
            ],
        ) || !sha(&file["sha256"])
            || file["uid"] != uid
            || file["gid"] != gid
            || file["mode"].as_u64().is_none_or(|m| m & 0o7777 != 0o600)
            || ["device", "inode", "mode", "byteLength"]
                .iter()
                .any(|key| file[*key].as_u64().is_none())
        {
            return Err(invalid());
        }
        let length = file["byteLength"].as_u64().ok_or_else(invalid)?;
        total = total
            .checked_add(length)
            .filter(|n| *n <= MAX_FAMILY)
            .ok_or_else(invalid)?;
        if length > MAX_BYTES {
            return Err(invalid());
        }
    }
    if [
        "nativeImageSha256",
        "legacyArchiveSha256",
        "imageReportsSha256",
    ]
    .iter()
    .any(|key| !sha(&value[*key]))
    {
        return Err(invalid());
    }
    Ok(())
}
fn prepare_native_stage(
    parent: &JournalParent,
    base: &str,
    operation: &SchemaOperationIdentityV1,
    image: &[u8],
) -> Result<Option<SourceFile>> {
    parent.current()?;
    let stage = format!(
        ".{base}.native-{}.staged",
        operation.transition_id.trim_start_matches("sha256:")
    );
    if !absent(&parent.path.join(base))? {
        let observed = SourceFile::observe(parent, base, None)?;
        if observed.descriptor["sha256"] != hash_bytes(image)
            || observed.descriptor["byteLength"] != image.len()
        {
            return Err(invalid());
        }
        return Ok(None);
    }
    let creating = absent(&parent.path.join(&stage))?;
    let flags = OFlag::O_RDWR
        | OFlag::O_NOFOLLOW
        | OFlag::O_CLOEXEC
        | OFlag::O_NONBLOCK
        | if creating {
            OFlag::O_CREAT | OFlag::O_EXCL
        } else {
            OFlag::empty()
        };
    let file = File::from(
        openat(
            parent.file.as_fd(),
            stage.as_str(),
            flags,
            Mode::from_bits_truncate(0o600),
        )
        .map_err(|_| invalid())?,
    );
    let before = file.metadata().map_err(|_| invalid())?;
    let creator = nix::unistd::getuid().as_raw();
    if !before.is_file()
        || before.nlink() != 1
        || before.mode() & 0o7777 != 0o600
        || (before.uid() != creator && before.uid() != parent.uid)
        || before.len() as usize > image.len()
    {
        return Err(invalid());
    }
    let prefix = read_held(&file, before.len())?;
    let named = fs::symlink_metadata(parent.path.join(&stage)).map_err(|_| invalid())?;
    if prefix != image[..prefix.len()]
        || regular_observation(&file.metadata().map_err(|_| invalid())?)
            != regular_observation(&before)
        || regular_observation(&named) != regular_observation(&before)
        || (before.uid() != creator && prefix.len() != image.len())
    {
        return Err(invalid());
    }
    // Query a provable root-owned prefix after an interrupted private write;
    // append only missing bytes. Existing bytes are never overwritten/truncated.
    file.write_all_at(&image[prefix.len()..], prefix.len() as u64)
        .map_err(|_| invalid())?;
    file.sync_all().map_err(|_| invalid())?;
    fchown(
        &file,
        Some(Uid::from_raw(parent.uid)),
        Some(Gid::from_raw(parent.gid)),
    )
    .map_err(|_| invalid())?;
    file.sync_all().map_err(|_| invalid())?;
    parent.sync()?;
    let staged = SourceFile::observe(parent, &stage, None)?;
    if staged.descriptor["sha256"] != hash_bytes(image)
        || staged.descriptor["byteLength"] != image.len()
    {
        return Err(invalid());
    }
    Ok(Some(staged))
}
fn publish_prepared_native(parent: &JournalParent, base: &str, staged: &SourceFile) -> Result<()> {
    parent.current()?;
    staged.current(parent)?;
    renameat2(
        parent.file.as_fd(),
        staged.name.as_str(),
        parent.file.as_fd(),
        base,
        RenameFlags::RENAME_NOREPLACE,
    )
    .map_err(|_| invalid())?;
    parent.sync()?;
    let published = SourceFile::observe(parent, base, None)?;
    if published.descriptor != staged.descriptor {
        return Err(invalid());
    }
    Ok(())
}
#[cfg(test)]
fn publish_native(
    parent: &JournalParent,
    base: &str,
    operation: &SchemaOperationIdentityV1,
    image: &[u8],
) -> Result<()> {
    if let Some(stage) = prepare_native_stage(parent, base, operation, image)? {
        publish_prepared_native(parent, base, &stage)?;
    }
    Ok(())
}

fn observe_stopped_native(
    stopped: &HeldStoppedInstalledAuthorityV1<'_, '_>,
    prepared: Option<&PreparedSchemaTargetRestartV2>,
    verifier: &LegacyAuthorityJournalVerifierV1,
    target: &LegacyAuthorityJournalVerifierV1,
    parent: &JournalParent,
    base: &str,
    subject: &Value,
) -> Result<()> {
    let mut family = Vec::new();
    let mut source = Vec::new();
    let mut total = 0u64;
    for suffix in SUFFIXES {
        let name = format!("{base}{suffix}");
        let file = if absent(&parent.path.join(&name))? {
            None
        } else {
            Some(SourceFile::observe(parent, &name, None)?)
        };
        if let Some(file) = &file {
            total = total
                .checked_add(file.descriptor["byteLength"].as_u64().ok_or_else(invalid)?)
                .filter(|value| *value <= MAX_FAMILY)
                .ok_or_else(invalid)?;
            family.push(file.descriptor.clone());
        } else {
            family.push(Value::Null);
        }
        source.push(file);
        stopped.assert_current()?;
    }
    if family[0].is_null() {
        return Err(invalid());
    }
    let digest = hash(
        "HeptaInstalledNativeAuthorityPhysicalSnapshotV1",
        &json!({"subject":subject,"sourceFamily":family}),
    )?;
    let root = private_root(
        &stopped
            .operation()
            .barrier_root
            .join("authority-journal-native-observations")
            .join(digest.trim_start_matches("sha256:")),
    )?;
    for (index, file) in source.iter().enumerate() {
        if let Some(file) = file {
            write_exact(
                &root,
                RAW_NAMES[index],
                &read_held(
                    &file.file,
                    file.descriptor["byteLength"].as_u64().ok_or_else(invalid)?,
                )?,
            )?;
        }
    }
    let working = private_root(&root.path.join("working"))?;
    for index in [0usize, 1, 3] {
        if !family[index].is_null() {
            write_exact(
                &working,
                &format!("authority.sqlite{}", SUFFIXES[index]),
                &root_bytes(&root, RAW_NAMES[index], MAX_BYTES)?,
            )?;
        }
    }
    for file in source.iter().flatten() {
        file.current(parent)?;
    }
    stopped.assert_current()?;
    let ReadJournal::Native(report) = build_images(verifier, &working, prepared)? else {
        return Err(invalid());
    };
    for (index, file) in source.iter().enumerate() {
        if let Some(file) = file {
            file.current(parent)?;
        } else if !absent(&parent.path.join(format!("{base}{}", SUFFIXES[index])))? {
            return Err(invalid());
        }
    }
    write_exact(&root,"OBSERVED.v1.json",&serde_json::to_vec(&json!({"subject":subject,"sourceFamily":family,"history":report,"sourceConnectionClosed":true,"sourceLogicalDataWritten":false,"activationAuthority":false})).map_err(|_|invalid())?)?;
    verifier.current()?;
    target.current()?;
    stopped.assert_current()
}

pub(crate) fn migrate_stopped_installed_authority_journal_v1(
    stopped: &HeldStoppedInstalledAuthorityV1<'_, '_>,
    prepared: &PreparedSchemaTargetRestartV2,
) -> Result<()> {
    migrate_stopped_journal(stopped, Some(prepared))
}
pub(crate) fn migrate_stopped_installed_authority_source_journal_v1(
    stopped: &HeldStoppedInstalledAuthorityV1<'_, '_>,
) -> Result<()> {
    migrate_stopped_journal(stopped, None)
}
fn migrate_stopped_journal(
    stopped: &HeldStoppedInstalledAuthorityV1<'_, '_>,
    prepared: Option<&PreparedSchemaTargetRestartV2>,
) -> Result<()> {
    if nix::unistd::getuid().as_raw() != 0 || nix::unistd::geteuid().as_raw() != 0 {
        return Err(error(
            "autonomous_research_installed_schema_owner_requires_root",
        ));
    }
    stopped.assert_current()?;
    let operation = stopped.operation();
    let restart = stopped.profile().authority_restart();
    if restart.source_unit.uid != restart.target_unit.uid
        || restart.source_unit.gid != restart.target_unit.gid
        || prepared.is_some_and(|value| {
            value.request()["transitionId"] != operation.transition_id
                || value.target_authority_configuration_hash()
                    != restart.target_authority_configuration_hash
        })
    {
        return Err(invalid());
    }
    let verifier = LegacyAuthorityJournalVerifierV1::load_process(
        &restart.source_daemon_configuration.path,
        &restart.source_daemon_configuration.sha256,
        &restart.source_process_configuration.path,
        &restart.source_process_configuration.sha256,
    )?;
    let target = LegacyAuthorityJournalVerifierV1::load_process(
        &restart.target_daemon_configuration.path,
        &restart.target_daemon_configuration.sha256,
        &restart.target_process_configuration.path,
        &restart.target_process_configuration.sha256,
    )?;
    if verifier.public_key_sha256() != target.public_key_sha256() {
        return Err(invalid());
    }
    if let Some(prepared) = prepared {
        let mut expected = verifier.daemon_configuration().clone();
        expected["writerManifestHash"] = prepared.request()["writerManifestHash"].clone();
        if hash(
            "HeptaLocalAutonomousResearchStateAuthorityConfiguration",
            target.daemon_configuration(),
        )? != hash(
            "HeptaLocalAutonomousResearchStateAuthorityConfiguration",
            &expected,
        )? || verifier.public_key_sha256() != target.public_key_sha256()
            || hash(
                "HeptaLocalAutonomousResearchStateAuthorityConfiguration",
                &expected,
            )? != prepared.target_authority_configuration_hash()
        {
            return Err(invalid());
        }
    }
    let path = verifier.source_database_path()?;
    if !canonical(path) || target.source_database_path()? != path {
        return Err(invalid());
    }
    let parent = JournalParent::open(
        path.parent().ok_or_else(invalid)?,
        restart.source_unit.uid,
        restart.source_unit.gid,
    )?;
    let base = path
        .file_name()
        .and_then(|s| s.to_str())
        .filter(|s| !s.contains(['\\', '\0']))
        .ok_or_else(invalid)?;
    let subject = intent_subject(
        operation,
        prepared,
        path,
        &verifier,
        &restart.source_daemon_configuration.sha256,
        &restart.source_process_configuration.sha256,
    )?;
    // Already native journals are inspected in a fresh exact physical family
    // namespace. They are never reconverted, and target activation remains with
    // the existing daemon. This also resolves an unknown bootstrap completion.
    if !absent(path)? {
        let main = SourceFile::observe(&parent, base, None)?;
        let mut header = [0u8; 64];
        if main.file.read_exact_at(&mut header, 0).is_ok()
            && &header[..16] == b"SQLite format 3\0"
            && u32::from_be_bytes(header[60..64].try_into().map_err(|_| invalid())?) == 1
        {
            return observe_stopped_native(
                stopped, prepared, &verifier, &target, &parent, base, &subject,
            );
        }
    }
    let root = private_root(&operation.barrier_root.join(if prepared.is_some() {
        "authority-journal-target"
    } else {
        "authority-journal-source"
    }))?;
    let existing = if absent(&root.path.join(INTENT))? {
        None
    } else {
        let bytes = root_bytes(&root, INTENT, 4 * 1024 * 1024)?;
        match parse(&bytes, CODE) {
            Ok(value) => Some(value),
            Err(_) => {
                // A crash during the private intent write precedes all source
                // effects. Query every retired name before reconstructing;
                // write_exact later permits only the proven matching suffix.
                for suffix in SUFFIXES {
                    if !absent(&parent.path.join(retired(base, operation, suffix)))? {
                        return Err(invalid());
                    }
                }
                None
            }
        }
    };
    if let Some(value) = &existing {
        validate_intent(value, &subject, parent.uid, parent.gid)?;
    }
    let mut source = Vec::new();
    let mut family = Vec::new();
    let mut total = 0u64;
    for (index, raw_name) in RAW_NAMES.iter().enumerate() {
        let observed = resolve_source(&parent, base, operation, existing.as_ref(), index)?;
        if let Some(file) = &observed {
            let size = file.descriptor["byteLength"].as_u64().ok_or_else(invalid)?;
            total = total
                .checked_add(size)
                .filter(|n| *n <= MAX_FAMILY)
                .ok_or_else(invalid)?;
            if existing.is_none() {
                write_exact(&root, raw_name, &read_held(&file.file, size)?)?;
            }
            let raw = root_bytes(&root, raw_name, MAX_BYTES)?;
            if hash_bytes(&raw) != file.descriptor["sha256"] || raw.len() as u64 != size {
                return Err(invalid());
            }
            family.push(file.descriptor.clone());
        } else {
            family.push(Value::Null);
        }
        source.push(observed);
        stopped.assert_current()?;
    }
    if family[0].is_null() {
        return Err(invalid());
    }
    if let Some(value) = &existing {
        validate_intent(value, &subject, parent.uid, parent.gid)?;
    }
    // SQLite reads a closed physical copy of the stopped family. Original SHM
    // bytes remain sealed; this working copy gets its own disposable read locks.
    let working = private_root(&root.path.join("working"))?;
    for index in [0usize, 1, 3] {
        if !family[index].is_null() {
            let raw = root_bytes(&root, RAW_NAMES[index], MAX_BYTES)?;
            write_exact(
                &working,
                &format!("authority.sqlite{}", SUFFIXES[index]),
                &raw,
            )?;
        }
    }
    for file in source.iter().flatten() {
        file.current(&parent)?;
    }
    stopped.assert_current()?;
    let ReadJournal::Images(image, archive, reports) = build_images(&verifier, &working, prepared)?
    else {
        return Err(invalid());
    };
    for file in source.iter().flatten() {
        file.current(&parent)?;
    }
    stopped.assert_current()?;
    let reports_bytes = serde_json::to_vec(&reports).map_err(|_| invalid())?;
    write_exact(&root, "native.sqlite", &image)?;
    write_exact(&root, "legacy.sqlite", &archive)?;
    write_exact(&root, "images.v1.json", &reports_bytes)?;
    let mut intent = subject.clone();
    intent["sourceFamily"] = json!(family);
    intent["nativeImageSha256"] = json!(hash_bytes(&image));
    intent["legacyArchiveSha256"] = json!(hash_bytes(&archive));
    intent["imageReportsSha256"] = json!(hash_bytes(&reports_bytes));
    validate_intent(&intent, &subject, parent.uid, parent.gid)?;
    if existing.as_ref().is_some_and(|value| *value != intent) {
        return Err(invalid());
    }
    write_exact(
        &root,
        INTENT,
        &serde_json::to_vec(&intent).map_err(|_| invalid())?,
    )?;
    // Intent and all rollback bytes are now durable before the first source
    // mutation. Unknown results are classified by exact current names/identity.
    for (index, source_file) in source.iter_mut().enumerate() {
        let Some(file) = source_file else {
            continue;
        };
        stopped.assert_current()?;
        verifier.current()?;
        target.current()?;
        root_current(&root)?;
        retire_file(&parent, file, base, operation, index)?;
    }
    stopped.assert_current()?;
    let staged = prepare_native_stage(&parent, base, operation, &image)?;
    stopped.assert_current()?;
    verifier.current()?;
    target.current()?;
    root_current(&root)?;
    if let Some(staged) = staged {
        publish_prepared_native(&parent, base, &staged)?;
    }
    for file in source.iter().flatten() {
        file.current(&parent)?;
    }
    for suffix in &SUFFIXES[1..] {
        if !absent(&parent.path.join(format!("{base}{suffix}")))? {
            return Err(invalid());
        }
    }
    let completion = json!({"version":1,"kind":"HeptaInstalledAuthorityJournalPublicationCompleteV1","intentSha256":hash_bytes(&serde_json::to_vec(&intent).map_err(|_| invalid())?),"nativeImageSha256":hash_bytes(&image),"sourceFamilyPreserved":true,"privateKeyOpened":false,"activationDelegatedToExistingNativeOwner":true});
    write_exact(
        &root,
        COMPLETE,
        &serde_json::to_vec(&completion).map_err(|_| invalid())?,
    )?;
    verifier.current()?;
    target.current()?;
    stopped.assert_current()
}

#[cfg(test)]
mod tests;
