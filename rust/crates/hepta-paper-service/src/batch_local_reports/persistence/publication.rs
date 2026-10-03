//! Local prepared artifact materialization. No inverse rename is attempted on
//! uncertainty. The old and new bytes remain in the prepared private bundle.
use super::*;
use crate::{
    ObjectStoreV1,
    state_recoverability::{
        files::ObservedFile,
        publication::{Directory, LocalReportDirectoryV1},
    },
};
use nix::{
    fcntl::{OFlag, RenameFlags, openat, renameat2},
    sys::stat::{Mode, fchmod},
};
use serde::{Deserialize, Serialize};
use std::{
    fs::{self, File, Metadata},
    io::Write,
    os::{fd::AsFd, unix::fs::MetadataExt},
    path::{Path, PathBuf},
};
mod cleanup;
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct Witness {
    dev: u64,
    ino: u64,
    mode: u32,
    uid: u32,
    gid: u32,
    nlink: u64,
    len: u64,
    mtime: i64,
    mtime_nsec: i64,
    ctime: i64,
    ctime_nsec: i64,
}
impl Witness {
    pub(super) fn of(m: &Metadata) -> Self {
        Self {
            dev: m.dev(),
            ino: m.ino(),
            mode: m.mode(),
            uid: m.uid(),
            gid: m.gid(),
            nlink: m.nlink(),
            len: m.len(),
            mtime: m.mtime(),
            mtime_nsec: m.mtime_nsec(),
            ctime: m.ctime(),
            ctime_nsec: m.ctime_nsec(),
        }
    }
    fn exchanged(&self, m: &Metadata) -> bool {
        let mut after = Self::of(m);
        after.ctime = self.ctime;
        after.ctime_nsec = self.ctime_nsec;
        *self == after
    }
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Previous {
    witness: Witness,
    hash: String,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Intent {
    version: u32,
    kind: String,
    root_binding: String,
    operation: String,
    target: String,
    role: String,
    content_type: String,
    created_at: String,
    object_created: bool,
    previous: Option<Previous>,
    replacement: Witness,
    hash: String,
    authority_granted: bool,
}
fn error() -> String {
    "native_local_report_materialization_unknown_v1_retained".into()
}
fn observed(path: &Path, maximum: u64) -> Result<ObservedFile, String> {
    ObservedFile::open(path, maximum).map_err(|_| error())
}
fn bytes(file: &ObservedFile, maximum: u64) -> Result<Vec<u8>, String> {
    file.bytes(maximum).map_err(|_| error())
}
pub(super) fn hash_bytes(bytes: &[u8]) -> String {
    use sha2::Digest;
    format!("sha256:{}", hex::encode(sha2::Sha256::digest(bytes)))
}
fn nonce() -> Result<String, String> {
    let mut value = [0u8; 16];
    getrandom::fill(&mut value).map_err(|_| error())?;
    Ok(hex::encode(value))
}
fn leaf(directory: &Directory, name: &str) -> Result<File, String> {
    directory.assert_current().map_err(|_| error())?;
    let file = File::from(
        openat(
            directory.held.as_fd(),
            name,
            OFlag::O_WRONLY
                | OFlag::O_CREAT
                | OFlag::O_EXCL
                | OFlag::O_NOFOLLOW
                | OFlag::O_NONBLOCK
                | OFlag::O_CLOEXEC,
            Mode::from_bits_truncate(0o600),
        )
        .map_err(|_| error())?,
    );
    let m = file.metadata().map_err(|_| error())?;
    if !m.is_file()
        || m.nlink() != 1
        || m.uid() != nix::unistd::getuid().as_raw()
        || m.mode() & 0o077 != 0
    {
        return Err(error());
    }
    Ok(file)
}
pub(super) trait Destination {
    fn path(&self) -> &Path;
    fn held(&self) -> &File;
    fn current(&self) -> Result<(), String>;
}
impl Destination for Directory {
    fn path(&self) -> &Path {
        &self.path
    }
    fn held(&self) -> &File {
        &self.held
    }
    fn current(&self) -> Result<(), String> {
        self.assert_current().map_err(|_| error())
    }
}
impl Destination for LocalReportDirectoryV1 {
    fn path(&self) -> &Path {
        &self.path
    }
    fn held(&self) -> &File {
        &self.held
    }
    fn current(&self) -> Result<(), String> {
        self.assert_current().map_err(|_| error())
    }
}
/// A new temporary leaf can be interrupted without ever exposing a partial
/// immutable final record. Unpublished temporary bytes are retained on failure.
pub(super) fn immutable(
    directory: &Directory,
    name: &str,
    content: &[u8],
    public: bool,
) -> Result<(), String> {
    immutable_from(directory, directory, name, content, public, &|_| Ok(()))
}
pub(super) fn immutable_from(
    staging: &Directory,
    directory: &impl Destination,
    name: &str,
    content: &[u8],
    public: bool,
    hook: &dyn Fn(&str) -> Result<(), String>,
) -> Result<(), String> {
    directory.current()?;
    if let Ok(existing) = observed(&directory.path().join(name), 16 * 1024 * 1024) {
        if bytes(&existing, 16 * 1024 * 1024)? != content {
            return Err(error());
        }
        return Ok(());
    }
    if !matches!(fs::symlink_metadata(directory.path().join(name)),Err(e) if e.kind()==std::io::ErrorKind::NotFound)
    {
        return Err(error());
    }
    let temporary = format!(".unprepared-copy-{}", nonce()?);
    let mut file = leaf(staging, &temporary)?;
    let first = content.len().min(64);
    file.write_all(&content[..first]).map_err(|_| error())?;
    hook("immutable_partial_copy")?;
    file.write_all(&content[first..]).map_err(|_| error())?;
    if public {
        fchmod(&file, Mode::from_bits_truncate(0o444)).map_err(|_| error())?;
    }
    file.sync_all().map_err(|_| error())?;
    hook("immutable_copy_synced")?;
    directory.current()?;
    let witness = observed(&staging.path.join(&temporary), 16 * 1024 * 1024)?;
    if bytes(&witness, 16 * 1024 * 1024)? != content {
        return Err(error());
    }
    match renameat2(
        staging.held.as_fd(),
        temporary.as_str(),
        directory.held().as_fd(),
        name,
        RenameFlags::RENAME_NOREPLACE,
    ) {
        Ok(()) => {}
        Err(nix::errno::Errno::EEXIST) => {
            let existing = observed(&directory.path().join(name), 16 * 1024 * 1024)?;
            if bytes(&existing, 16 * 1024 * 1024)? != content {
                return Err(error());
            }
            return Ok(());
        }
        Err(_) => return Err(error()),
    }
    directory.held().sync_all().map_err(|_| error())?;
    staging.held.sync_all().map_err(|_| error())?;
    directory.current()?;
    let final_file = observed(&directory.path().join(name), 16 * 1024 * 1024)?;
    if bytes(&final_file, 16 * 1024 * 1024)? != content {
        return Err(error());
    }
    Ok(())
}
pub(super) struct Prepared {
    directory: Directory,
    intent: Intent,
    objects: ObjectStoreV1,
    public_cas: PathBuf,
}
pub(super) struct PrepareInput<'a> {
    pub(super) namespace: &'a Directory,
    pub(super) binding: &'a str,
    pub(super) operation: &'a str,
    pub(super) target: &'a LocalReportDirectoryV1,
    pub(super) artifact: &'a NativeLocalReportArtifactV1,
    pub(super) created_at: &'a str,
    pub(super) object_created: bool,
    pub(super) cancelled: &'a AtomicBool,
    pub(super) deadline: Instant,
    pub(super) hook: &'a dyn Fn(&str) -> Result<(), String>,
}
impl Prepared {
    pub(super) fn prepare(input: PrepareInput<'_>) -> Result<Self, String> {
        let PrepareInput {
            namespace,
            binding,
            operation,
            target,
            artifact,
            created_at,
            object_created,
            cancelled,
            deadline,
            hook,
        } = input;
        active(cancelled, deadline)?;
        namespace.assert_current().map_err(|_| error())?;
        target.assert_current().map_err(|_| error())?;
        let name = Path::new(&artifact.relative_path)
            .file_name()
            .and_then(|v| v.to_str())
            .ok_or_else(error)?;
        let previous = match observed(&target.path.join(name), 16 * 1024 * 1024) {
            Ok(file) => {
                let value = bytes(&file, 16 * 1024 * 1024)?;
                Some((file, value))
            }
            Err(_) if matches!(fs::symlink_metadata(target.path.join(name)),Err(e) if e.kind()==std::io::ErrorKind::NotFound) => {
                None
            }
            Err(e) => return Err(e),
        };
        let temporary = namespace
            .child(&format!(".unprepared-{}", nonce()?))
            .map_err(|_| error())?;
        hook("unprepared_created")?;
        active(cancelled, deadline)?;
        // Existing CAS writer/verifier remains unchanged. A torn unprepared CAS
        // stays isolated and is never accepted as a prepared object or overwritten.
        let objects = ObjectStoreV1::open(&temporary.path).map_err(|_| error())?;
        let content_hash = objects
            .put(&artifact.bytes)
            .map_err(|_| error())?
            .to_string();
        if let Some((_, value)) = &previous {
            objects.put(value).map_err(|_| error())?;
        }
        hook("unprepared_objects")?;
        active(cancelled, deadline)?;
        let mut file = leaf(&temporary, "replacement")?;
        let first = artifact.bytes.len().min(64);
        file.write_all(&artifact.bytes[..first])
            .map_err(|_| error())?;
        hook("unprepared_partial_replacement")?;
        active(cancelled, deadline)?;
        file.write_all(&artifact.bytes[first..])
            .map_err(|_| error())?;
        fchmod(&file, Mode::from_bits_truncate(0o444)).map_err(|_| error())?;
        file.sync_all().map_err(|_| error())?;
        let replacement = observed(&temporary.path.join("replacement"), 16 * 1024 * 1024)?;
        if bytes(&replacement, 16 * 1024 * 1024)? != artifact.bytes {
            return Err(error());
        }
        let previous = previous
            .map(|(file, value)| {
                Ok::<Previous, String>(Previous {
                    witness: Witness::of(&file.file.metadata().map_err(|_| error())?),
                    hash: hash_bytes(&value),
                })
            })
            .transpose()?;
        let intent = Intent {
            version: 1,
            kind: "NativeLocalReportPreparedArtifact".into(),
            root_binding: binding.into(),
            operation: operation.into(),
            target: target.path.join(name).to_str().ok_or_else(error)?.into(),
            role: artifact.role.into(),
            content_type: artifact.content_type.into(),
            created_at: created_at.into(),
            object_created,
            previous,
            replacement: Witness::of(&replacement.file.metadata().map_err(|_| error())?),
            hash: content_hash,
            authority_granted: false,
        };
        immutable(
            &temporary,
            "intent.json",
            &serde_json::to_vec(&intent).map_err(|_| error())?,
            false,
        )?;
        temporary.sync_with_parents().map_err(|_| error())?;
        hook("before_prepared")?;
        active(cancelled, deadline)?;
        target.assert_current().map_err(|_| error())?;
        let prepared_name = format!("prepared-{}", nonce()?);
        let path = namespace
            .publish_new(&temporary, &prepared_name)
            .map_err(|_| error())?;
        let directory = Directory::open_or_create(&path, false).map_err(|_| error())?;
        let objects = ObjectStoreV1::open(&path).map_err(|_| error())?;
        namespace.assert_current().map_err(|_| error())?;
        hook("prepared")?;
        Ok(Self {
            directory,
            intent,
            objects,
            public_cas: namespace
                .path
                .parent()
                .ok_or_else(error)?
                .join("report-artifact-cas"),
        })
    }
    pub(super) fn open(
        namespace: &Directory,
        name: &str,
        binding: &str,
        runtime: &Path,
    ) -> Result<Self, String> {
        namespace.assert_current().map_err(|_| error())?;
        let directory =
            Directory::open_or_create(&namespace.path.join(name), false).map_err(|_| error())?;
        let source = observed(&directory.path.join("intent.json"), 64 * 1024)?;
        let intent: Intent =
            serde_json::from_slice(&bytes(&source, 64 * 1024)?).map_err(|_| error())?;
        let target = PathBuf::from(&intent.target);
        let reports = runtime.join("reports");
        if intent.version != 1
            || intent.kind != "NativeLocalReportPreparedArtifact"
            || intent.root_binding != binding
            || intent.authority_granted
            || !target.starts_with(&reports)
            || target == reports
            || !target.components().all(|c| {
                matches!(
                    c,
                    std::path::Component::RootDir | std::path::Component::Normal(_)
                )
            })
            || !digest(&intent.hash)
            || !digest(&intent.operation)
            || !matches!(
                intent.role.as_str(),
                "paper_batch_result_detail"
                    | "paper_batch_report"
                    | "paper_batch_report_markdown"
                    | "paper_batch_current_report_pointer"
                    | "paper_batch_current_report_pointer_markdown"
            )
        {
            return Err(error());
        }
        let objects = ObjectStoreV1::open(&directory.path).map_err(|_| error())?;
        let result = Self {
            directory,
            intent,
            objects,
            public_cas: runtime.join("report-artifact-cas"),
        };
        result.content()?;
        Ok(result)
    }
    pub(super) fn materialize(
        &self,
        cancelled: &AtomicBool,
        deadline: Instant,
        hook: &dyn Fn(&str) -> Result<(), String>,
    ) -> Result<ObservedFile, String> {
        active(cancelled, deadline)?;
        self.directory.assert_current().map_err(|_| error())?;
        let target = PathBuf::from(&self.intent.target);
        let parent =
            LocalReportDirectoryV1::open_or_create(target.parent().ok_or_else(error)?, false)
                .map_err(|_| error())?;
        let name = target
            .file_name()
            .and_then(|v| v.to_str())
            .ok_or_else(error)?;
        let current = observed(&target, 16 * 1024 * 1024).ok();
        let staged = observed(&self.directory.path.join("replacement"), 16 * 1024 * 1024).ok();
        let target_is_post = match &current {
            Some(file) => {
                self.intent
                    .replacement
                    .exchanged(&file.file.metadata().map_err(|_| error())?)
                    && hash_bytes(&bytes(file, 16 * 1024 * 1024)?) == self.intent.hash
            }
            None => false,
        };
        if !target_is_post {
            let stage = staged.as_ref().ok_or_else(error)?;
            if Witness::of(&stage.file.metadata().map_err(|_| error())?) != self.intent.replacement
                || hash_bytes(&bytes(stage, 16 * 1024 * 1024)?) != self.intent.hash
            {
                return Err(error());
            }
            match (&self.intent.previous, &current) {
                (None, None) => {
                    if !matches!(fs::symlink_metadata(&target),Err(e) if e.kind()==std::io::ErrorKind::NotFound)
                    {
                        return Err(error());
                    }
                }
                (Some(previous), Some(current)) => {
                    if Witness::of(&current.file.metadata().map_err(|_| error())?)
                        != previous.witness
                        || hash_bytes(&bytes(current, 16 * 1024 * 1024)?) != previous.hash
                    {
                        return Err(error());
                    }
                }
                _ => return Err(error()),
            }
            hook("before_materialize")?;
            active(cancelled, deadline)?;
            parent.assert_current().map_err(|_| error())?;
            stage.assert_current().map_err(|_| error())?;
            if let Some(current) = &current {
                current.assert_current().map_err(|_| error())?;
            }
            // No inode-CAS claim: this seam exercises actual replacement in
            // the remaining syscall window; any foreign displaced inode is retained.
            hook("before_materialize_syscall")?;
            renameat2(
                self.directory.held.as_fd(),
                "replacement",
                parent.held.as_fd(),
                name,
                if self.intent.previous.is_some() {
                    RenameFlags::RENAME_EXCHANGE
                } else {
                    RenameFlags::RENAME_NOREPLACE
                },
            )
            .map_err(|_| error())?;
            hook("after_materialize")?;
        }
        let final_file = observed(&target, 16 * 1024 * 1024)?;
        if !self
            .intent
            .replacement
            .exchanged(&final_file.file.metadata().map_err(|_| error())?)
            || hash_bytes(&bytes(&final_file, 16 * 1024 * 1024)?) != self.intent.hash
        {
            return Err(error());
        }
        if let Some(previous) = &self.intent.previous
            && !cleanup::permits_public_content(self)?
        {
            let displaced = observed(&self.directory.path.join("replacement"), 16 * 1024 * 1024)?;
            if !previous
                .witness
                .exchanged(&displaced.file.metadata().map_err(|_| error())?)
                || hash_bytes(&bytes(&displaced, 16 * 1024 * 1024)?) != previous.hash
            {
                return Err(error());
            }
        }
        parent.held.sync_all().map_err(|_| error())?;
        self.directory.held.sync_all().map_err(|_| error())?;
        parent.assert_current().map_err(|_| error())?;
        self.directory.assert_current().map_err(|_| error())?;
        final_file.assert_current().map_err(|_| error())?;
        hook("materialized_synced")?;
        Ok(final_file)
    }
    pub(super) fn record(
        &self,
        name: &str,
        wire: &[u8],
        hook: &dyn Fn(&str) -> Result<(), String>,
    ) -> Result<(), String> {
        immutable_from(&self.directory, &self.directory, name, wire, false, hook)
    }
    pub(super) fn retained_unprepared(&self) -> Result<Vec<PathBuf>, String> {
        cleanup::retained_unprepared(self)
    }
    pub(super) fn content(&self) -> Result<Vec<u8>, String> {
        match self
            .objects
            .read(&self.intent.hash.parse().map_err(|_| error())?)
        {
            Ok(value) => Ok(value),
            Err(_) if cleanup::permits_public_content(self)? => {
                let raw = &self.intent.hash[7..];
                let source = observed(
                    &self
                        .public_cas
                        .join("objects/sha256")
                        .join(&raw[..2])
                        .join(&raw[2..]),
                    16 * 1024 * 1024,
                )?;
                let content = bytes(&source, 16 * 1024 * 1024)?;
                if hash_bytes(&content) != self.intent.hash {
                    return Err(error());
                }
                Ok(content)
            }
            Err(_) => Err(error()),
        }
    }
    pub(super) fn compact(
        &self,
        cancelled: &AtomicBool,
        deadline: Instant,
        hook: &dyn Fn(&str) -> Result<(), String>,
    ) -> Result<(), String> {
        cleanup::compact(self, cancelled, deadline, hook)
    }
    pub(super) fn read_record(&self, name: &str) -> Result<Option<Vec<u8>>, String> {
        match observed(&self.directory.path.join(name), 512 * 1024) {
            Ok(file) => Ok(Some(bytes(&file, 512 * 1024)?)),
            Err(_) if matches!(fs::symlink_metadata(self.directory.path.join(name)),Err(e) if e.kind()==std::io::ErrorKind::NotFound) => {
                Ok(None)
            }
            Err(e) => Err(e),
        }
    }
    pub(super) fn directory(&self) -> &Directory {
        &self.directory
    }
    pub(super) fn object_created(&self) -> bool {
        self.intent.object_created
    }
    pub(super) fn operation(&self) -> &str {
        &self.intent.operation
    }
    pub(super) fn role(&self) -> &str {
        &self.intent.role
    }
    pub(super) fn content_type(&self) -> &str {
        &self.intent.content_type
    }
    pub(super) fn target(&self) -> &Path {
        Path::new(&self.intent.target)
    }
    pub(super) fn created_at(&self) -> &str {
        &self.intent.created_at
    }
}
