//! Descriptor-bound, no-clobber publication of ten fresh business databases.
//! Failures retain staging; an uncertain or published target is never deleted.
use super::{
    Result, error, files, input_hash,
    schema::{Image, bytes_hash},
};
use nix::{
    errno::Errno,
    fcntl::{Flock, FlockArg, OFlag, RenameFlags, open, openat, renameat2},
    sys::stat::{Mode, mkdirat},
};
use serde_json::{Value, json};
use std::{
    collections::{BTreeMap, BTreeSet},
    fs::{self, File, Metadata},
    io::{Read, Seek, SeekFrom, Write},
    os::{fd::AsFd, unix::fs::MetadataExt},
    path::{Component, Path, PathBuf},
};
const INVALID: &str = "autonomous_state_provisioning_target_identity_invalid";
fn flags() -> OFlag {
    OFlag::O_RDONLY | OFlag::O_DIRECTORY | OFlag::O_NOFOLLOW | OFlag::O_CLOEXEC
}
fn same_directory(a: &Metadata, b: &Metadata) -> bool {
    a.is_dir()
        && b.is_dir()
        && a.dev() == b.dev()
        && a.ino() == b.ino()
        && a.mode() == b.mode()
        && a.uid() == b.uid()
        && a.gid() == b.gid()
}
fn nonexistent(path: &Path) -> Result<()> {
    match fs::symlink_metadata(path) {
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        _ => Err(error(
            "autonomous_state_provisioning_fresh_runtime_required",
        )),
    }
}
pub(super) struct Target {
    pub path: PathBuf,
    pub(super) name: String,
    pub(super) parent: File,
    parents: Vec<(PathBuf, File, Metadata)>,
}
impl Target {
    pub fn open(requested: &Path) -> Result<Self> {
        let target = Self::open_parent(requested)?;
        target.require_fresh()?;
        Ok(target)
    }
    pub(super) fn open_parent(requested: &Path) -> Result<Self> {
        let path = files::absolute(requested)?;
        let name = path
            .file_name()
            .and_then(|v| v.to_str())
            .filter(|v| !v.is_empty() && v.len() <= 128)
            .ok_or_else(|| error(INVALID))?
            .to_owned();
        let parent_path = path.parent().ok_or_else(|| error(INVALID))?;
        let mut parent =
            File::from(open(Path::new("/"), flags(), Mode::empty()).map_err(|_| error(INVALID))?);
        let mut cursor = PathBuf::from("/");
        let mut parents = Vec::new();
        for part in parent_path.components() {
            if let Component::Normal(part) = part {
                parents.push((cursor.clone(), parent.try_clone()?, parent.metadata()?));
                parent = File::from(
                    openat(parent.as_fd(), Path::new(part), flags(), Mode::empty())
                        .map_err(|_| error(INVALID))?,
                );
                cursor.push(part);
            }
        }
        let identity = parent.metadata()?;
        if identity.uid() != nix::unistd::geteuid().as_raw() || identity.mode() & 0o022 != 0 {
            return Err(error(INVALID));
        }
        parents.push((cursor, parent.try_clone()?, identity));
        let target = Self {
            path,
            name,
            parent,
            parents,
        };
        target.assert_current()?;
        Ok(target)
    }
    pub(super) fn lock(&self) -> Result<Flock<File>> {
        Flock::lock(self.parent.try_clone()?, FlockArg::LockExclusiveNonblock)
            .map_err(|_| error("autonomous_state_provisioning_owner_busy"))
    }
    pub(super) fn require_absent(&self) -> Result<()> {
        self.assert_current()?;
        nonexistent(&self.path)
    }
    fn require_fresh(&self) -> Result<()> {
        self.require_absent()?;
        let prefix = format!(".{}.provisioning-", self.name);
        for (index, entry) in
            fs::read_dir(self.path.parent().ok_or_else(|| error(INVALID))?)?.enumerate()
        {
            if index >= 4096 {
                return Err(error("autonomous_state_provisioning_parent_entry_bound"));
            }
            if entry?.file_name().to_string_lossy().starts_with(&prefix) {
                return Err(error(
                    "autonomous_state_provisioning_retained_staging_requires_inspection",
                ));
            }
        }
        self.assert_current()
    }
    pub fn observation(&self) -> Result<Value> {
        let m = self.parent.metadata()?;
        Ok(
            json!({"path":self.path.parent(),"device":m.dev(),"inode":m.ino(),"uid":m.uid(),"gid":m.gid(),"mode":m.mode()}),
        )
    }
    pub fn assert_current(&self) -> Result<()> {
        for (path, file, identity) in &self.parents {
            if !same_directory(&file.metadata()?, identity)
                || !same_directory(&fs::symlink_metadata(path)?, identity)
            {
                return Err(error(INVALID));
            }
        }
        Ok(())
    }
}
struct Written {
    file: File,
    relative: String,
    identity: Metadata,
    hash: String,
    bytes: usize,
}
impl Written {
    fn verify(&mut self, root: &Path) -> Result<()> {
        let current = self.file.metadata()?;
        let named = fs::symlink_metadata(root.join(&self.relative))?;
        if !current.is_file()
            || !named.is_file()
            || current.nlink() != 1
            || named.nlink() != 1
            || current.dev() != self.identity.dev()
            || current.ino() != self.identity.ino()
            || current.mode() != self.identity.mode()
            || current.uid() != self.identity.uid()
            || current.gid() != self.identity.gid()
            || current.len() != self.bytes as u64
            || named.dev() != current.dev()
            || named.ino() != current.ino()
            || named.mode() != current.mode()
            || named.uid() != current.uid()
            || named.gid() != current.gid()
        {
            return Err(error("autonomous_state_provisioning_staged_file_changed"));
        }
        self.file.seek(SeekFrom::Start(0))?;
        let mut bytes = Vec::new();
        (&mut self.file)
            .take(self.bytes as u64 + 1)
            .read_to_end(&mut bytes)?;
        let after = self.file.metadata()?;
        if bytes.len() != self.bytes
            || bytes_hash(&bytes) != self.hash
            || after.len() != current.len()
            || after.mtime() != current.mtime()
            || after.mtime_nsec() != current.mtime_nsec()
            || after.ctime() != current.ctime()
            || after.ctime_nsec() != current.ctime_nsec()
        {
            return Err(error("autonomous_state_provisioning_staged_file_changed"));
        }
        Ok(())
    }
}
fn write_file(dir: &File, name: &str, relative: &str, bytes: &[u8]) -> Result<Written> {
    let fd = openat(
        dir.as_fd(),
        name,
        OFlag::O_RDWR | OFlag::O_CREAT | OFlag::O_EXCL | OFlag::O_NOFOLLOW | OFlag::O_CLOEXEC,
        Mode::from_bits_truncate(0o600),
    )
    .map_err(|_| error("autonomous_state_provisioning_stage_write_failed"))?;
    let mut file = File::from(fd);
    file.write_all(bytes)?;
    file.sync_all()?;
    let identity = file.metadata()?;
    Ok(Written {
        file,
        relative: relative.into(),
        identity,
        hash: bytes_hash(bytes),
        bytes: bytes.len(),
    })
}
fn verify_stage(
    root: &Path,
    dirs: &BTreeMap<String, (File, Metadata)>,
    files: &mut [Written],
) -> Result<()> {
    let allowed = dirs
        .keys()
        .cloned()
        .chain(files.iter().map(|f| f.relative.clone()))
        .collect::<BTreeSet<_>>();
    for (relative, (file, identity)) in dirs {
        let path = root.join(relative);
        if !same_directory(&file.metadata()?, identity)
            || !same_directory(&fs::symlink_metadata(&path)?, identity)
        {
            return Err(error(INVALID));
        }
        for entry in fs::read_dir(&path)?.take(128) {
            let name = entry?.file_name();
            let name = name.to_str().ok_or_else(|| error(INVALID))?;
            let full = if relative.is_empty() {
                name.to_owned()
            } else {
                format!("{relative}/{name}")
            };
            if !allowed.contains(&full) {
                return Err(error(
                    "autonomous_state_provisioning_unexpected_staged_path",
                ));
            }
        }
    }
    for file in files {
        file.verify(root)?;
    }
    Ok(())
}
pub(super) fn publish(
    target: &Target,
    images: &[Image],
    receipt: &Value,
    revalidate: &impl Fn() -> Result<()>,
) -> Result<Value> {
    publish_with_hook(target, images, receipt, revalidate, &mut |_| Ok(()))
}
// Internal hooks exercise actual disk effects; no environment-controlled fault path exists.
fn publish_with_hook(
    target: &Target,
    images: &[Image],
    receipt: &Value,
    revalidate: &impl Fn() -> Result<()>,
    hook: &mut impl FnMut(&str) -> Result<()>,
) -> Result<Value> {
    let _owner_lock = target.lock()?;
    target.require_fresh()?;
    if images.len() != 10 {
        return Err(error("autonomous_state_provisioning_ten_images_required"));
    }
    let mut random = [0u8; 16];
    getrandom::fill(&mut random)
        .map_err(|_| error("autonomous_state_provisioning_random_unavailable"))?;
    let stage_name = format!(".{}.provisioning-{}", target.name, hex::encode(random));
    mkdirat(
        target.parent.as_fd(),
        stage_name.as_str(),
        Mode::from_bits_truncate(0o700),
    )
    .map_err(|_| error("autonomous_state_provisioning_stage_create_failed"))?;
    let stage_path = target
        .path
        .parent()
        .ok_or_else(|| error(INVALID))?
        .join(&stage_name);
    let mut published = Some(false);
    let outcome = (|| {
        // Persist the recovery name before constructing children. A process or
        // machine failure must not turn a retained stage into an invisible leak.
        target.parent.sync_all()?;
        let stage = File::from(
            openat(
                target.parent.as_fd(),
                stage_name.as_str(),
                flags(),
                Mode::empty(),
            )
            .map_err(|_| error(INVALID))?,
        );
        let mut directories: BTreeMap<String, (File, Metadata)> = BTreeMap::new();
        directories.insert(String::new(), (stage.try_clone()?, stage.metadata()?));
        let mut files = Vec::new();
        for image in images {
            let relative = Path::new(&image.relative);
            if relative.is_absolute()
                || relative
                    .components()
                    .any(|c| !matches!(c, Component::Normal(_)))
            {
                return Err(error("autonomous_state_provisioning_schema_path_invalid"));
            }
            let parts = image.relative.split('/').collect::<Vec<_>>();
            let mut parent = String::new();
            for part in &parts[..parts.len() - 1] {
                let child = if parent.is_empty() {
                    (*part).to_owned()
                } else {
                    format!("{parent}/{part}")
                };
                if !directories.contains_key(&child) {
                    let fd = &directories.get(&parent).ok_or_else(|| error(INVALID))?.0;
                    mkdirat(fd.as_fd(), *part, Mode::from_bits_truncate(0o700))
                        .map_err(|_| error(INVALID))?;
                    let created = File::from(
                        openat(fd.as_fd(), *part, flags(), Mode::empty())
                            .map_err(|_| error(INVALID))?,
                    );
                    let identity = created.metadata()?;
                    directories.insert(child.clone(), (created, identity));
                }
                parent = child;
            }
            files.push(write_file(
                &directories.get(&parent).ok_or_else(|| error(INVALID))?.0,
                parts.last().ok_or_else(|| error(INVALID))?,
                &image.relative,
                &image.bytes,
            )?);
            hook("after_database")?;
        }
        let receipt_bytes = serde_json::to_vec_pretty(receipt)?;
        if receipt_bytes.len() > 1024 * 1024 {
            return Err(error("autonomous_state_provisioning_receipt_bound"));
        }
        files.push(write_file(
            &stage,
            "native-provisioning-receipt.json",
            "native-provisioning-receipt.json",
            &receipt_bytes,
        )?);
        for (file, _) in directories.values().rev() {
            file.sync_all()?;
        }
        hook("before_publish")?;
        revalidate()?;
        target.assert_current()?;
        verify_stage(&stage_path, &directories, &mut files)?;
        match renameat2(
            target.parent.as_fd(),
            stage_name.as_str(),
            target.parent.as_fd(),
            target.name.as_str(),
            RenameFlags::RENAME_NOREPLACE,
        ) {
            Ok(()) => published = Some(true),
            Err(Errno::EEXIST) => {
                return Err(error("autonomous_state_provisioning_target_appeared"));
            }
            Err(_) => {
                published = None;
                return Err(error(
                    "autonomous_state_provisioning_publication_indeterminate",
                ));
            }
        }
        hook("after_publish")?;
        target.parent.sync_all()?;
        target.assert_current()?;
        verify_stage(&target.path, &directories, &mut files)?;
        revalidate()?;
        // The pre-rename record describes prepared bytes, never successful
        // installation. Only the owner that observed publication issues this
        // separately durable terminal receipt.
        hook("before_terminal_receipt")?;
        let mut terminal = receipt.clone();
        terminal["preparedReceiptHash"] = receipt["provisioningReceiptHash"].clone();
        terminal
            .as_object_mut()
            .ok_or_else(|| error(INVALID))?
            .remove("provisioningReceiptHash");
        terminal["status"] = json!("autonomous_research_state_business_schemas_provisioned");
        terminal["ready"] = json!(true);
        terminal["freshRuntimeInstalled"] = json!(true);
        terminal["publicationState"] = json!("published");
        terminal["provisioningReceiptHash"] = json!(input_hash(
            "AutonomousResearchStateBusinessSchemaProvisioningReceipt",
            &terminal
        )?);
        let terminal_bytes = serde_json::to_vec_pretty(&terminal)?;
        if terminal_bytes.len() > 1024 * 1024 {
            return Err(error("autonomous_state_provisioning_receipt_bound"));
        }
        files.push(write_file(
            &stage,
            "native-provisioning-publication.json",
            "native-provisioning-publication.json",
            &terminal_bytes,
        )?);
        stage.sync_all()?;
        target.assert_current()?;
        verify_stage(&target.path, &directories, &mut files)?;
        Ok(terminal)
    })();
    outcome.map_err(|failure|error(format!("{}; publicationState={}; retainedStaging={}; runtimeRoot={}; automaticRetryAllowed=false",
        failure.0,match published {Some(true)=>"published",Some(false)=>"not_published",None=>"indeterminate"},
        stage_path.display(),target.path.display())))
}

#[cfg(test)]
mod tests;
