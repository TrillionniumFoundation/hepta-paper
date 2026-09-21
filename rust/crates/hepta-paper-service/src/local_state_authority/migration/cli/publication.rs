//! Fresh offline bundle publication, after the owning CLI has closed SQLite.
//! This private filesystem operation does not establish source provenance,
//! process retirement, native deployment, or permission to replace a journal.
use crate::{
    local_state_authority::{migration::OfflineNativeAuthorityImageV1, storage},
    sqlite_mutation_coordinator::{Result, SqliteMutationCoordinatorError, error, hash_bytes},
};
use nix::{
    errno::Errno,
    fcntl::{AtFlags, OFlag, RenameFlags, openat, renameat2},
    sys::stat::{Mode, mkdirat},
    unistd::{UnlinkatFlags, unlinkat},
};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{
    fs::{self, File, Metadata, OpenOptions},
    io::Write,
    os::{
        fd::AsFd,
        unix::fs::{FileExt, MetadataExt, OpenOptionsExt},
    },
    path::{Component, Path, PathBuf},
};

const INVALID: &str = "local_authority_offline_publication_path_invalid";
const CHANGED: &str = "local_authority_offline_publication_namespace_changed";
const FAILED: &str = "local_authority_offline_publication_failed";
const EXISTS: &str = "local_authority_offline_publication_output_exists";
const PROTECTED: &str = "local_authority_offline_publication_protected_path";
const IMAGE: &str = "authority.sqlite";
const REPORT: &str = "report.json";

fn canonical_shape(path: &Path) -> bool {
    path.to_str().is_some_and(|s| {
        path.is_absolute()
            && !s.contains(['\\', '\0'])
            && !s.contains("//")
            && (s == "/" || !s.ends_with('/'))
            && !s.split('/').any(|v| v == "." || v == "..")
            && path
                .components()
                .all(|c| matches!(c, Component::RootDir | Component::Normal(_)))
    })
}
fn directory_equal(a: &Metadata, b: &Metadata) -> bool {
    a.is_dir()
        && !a.is_symlink()
        && b.is_dir()
        && !b.is_symlink()
        && a.dev() == b.dev()
        && a.ino() == b.ino()
        && a.mode() == b.mode()
        && a.uid() == b.uid()
        && a.gid() == b.gid()
}
fn file_equal(a: &Metadata, b: &Metadata) -> bool {
    a.is_file()
        && !a.is_symlink()
        && a.nlink() == 1
        && b.nlink() == 1
        && a.dev() == b.dev()
        && a.ino() == b.ino()
        && a.mode() == b.mode()
        && a.uid() == b.uid()
        && a.gid() == b.gid()
        && a.len() == b.len()
        && a.mtime() == b.mtime()
        && a.mtime_nsec() == b.mtime_nsec()
        && a.ctime() == b.ctime()
        && a.ctime_nsec() == b.ctime_nsec()
}
fn annotate(
    mut failure: SqliteMutationCoordinatorError,
    output: &Path,
    committed: Option<bool>,
) -> SqliteMutationCoordinatorError {
    failure.details = json!({"publicationCommitted":committed,"outputPath":output.to_string_lossy(),
        "inspectionRequired":committed != Some(false)});
    failure.retryable = false;
    failure
}

struct Parent {
    path: PathBuf,
    file: File,
    identity: Metadata,
    ancestors: storage::Ancestors,
}
impl Parent {
    fn open(path: &Path) -> Result<Self> {
        if !canonical_shape(path) || fs::canonicalize(path).ok().as_deref() != Some(path) {
            return Err(error(INVALID));
        }
        let ancestors = storage::Ancestors::capture(path)?;
        let file = OpenOptions::new()
            .read(true)
            .custom_flags(nix::libc::O_DIRECTORY | nix::libc::O_NOFOLLOW | nix::libc::O_CLOEXEC)
            .open(path)
            .map_err(|_| error(INVALID))?;
        let identity = file.metadata().map_err(|_| error(INVALID))?;
        let value = Self {
            path: path.into(),
            file,
            identity,
            ancestors,
        };
        value.assert_current()?;
        Ok(value)
    }
    fn assert_current(&self) -> Result<()> {
        self.ancestors
            .assert_open_directory(&self.file)
            .map_err(|_| error(CHANGED))?;
        let current = fs::symlink_metadata(&self.path).map_err(|_| error(CHANGED))?;
        let uid = nix::unistd::geteuid().as_raw();
        if !directory_equal(&current, &self.identity)
            || (current.uid() != uid && current.uid() != 0)
            || current.mode() & 0o7777 != 0o700
        {
            return Err(error(INVALID));
        }
        let mut child = current;
        for path in self.path.ancestors().skip(1) {
            let value = fs::symlink_metadata(path).map_err(|_| error(CHANGED))?;
            if !value.is_dir()
                || value.is_symlink()
                || (value.uid() != uid && value.uid() != 0)
                || (value.mode() & 0o022 != 0
                    && !(value.mode() & 0o1000 != 0 && (child.uid() == uid || child.uid() == 0)))
            {
                return Err(error(INVALID));
            }
            child = value;
        }
        Ok(())
    }
    fn absent(&self, name: &Path) -> Result<()> {
        self.assert_current()?;
        match nix::sys::stat::fstatat(self.file.as_fd(), name, AtFlags::AT_SYMLINK_NOFOLLOW) {
            Err(Errno::ENOENT) => Ok(()),
            Ok(_) => Err(error(EXISTS)),
            Err(_) => Err(error(FAILED)),
        }
    }
}
struct BundleFile {
    name: &'static str,
    file: File,
    identity: Metadata,
    hash: String,
}
impl BundleFile {
    fn assert_current(&self, directory: &Path) -> Result<()> {
        let held = self.file.metadata().map_err(|_| error(CHANGED))?;
        let named = fs::symlink_metadata(directory.join(self.name)).map_err(|_| error(CHANGED))?;
        if !file_equal(&held, &self.identity)
            || !file_equal(&named, &self.identity)
            || held.mode() & 0o7777 != 0o600
            || held.uid() != nix::unistd::geteuid().as_raw()
        {
            return Err(error(CHANGED));
        }
        let mut digest = Sha256::new();
        let mut offset = 0;
        let mut buffer = [0u8; 8192];
        while offset < held.len() {
            let length = usize::try_from((held.len() - offset).min(buffer.len() as u64))
                .map_err(|_| error(FAILED))?;
            self.file
                .read_exact_at(&mut buffer[..length], offset)
                .map_err(|_| error(CHANGED))?;
            digest.update(&buffer[..length]);
            offset += length as u64;
        }
        if format!("sha256:{}", hex::encode(digest.finalize())) != self.hash
            || !file_equal(
                &self.file.metadata().map_err(|_| error(CHANGED))?,
                &self.identity,
            )
            || !file_equal(
                &fs::symlink_metadata(directory.join(self.name)).map_err(|_| error(CHANGED))?,
                &self.identity,
            )
        {
            return Err(error(CHANGED));
        }
        Ok(())
    }
}
struct Stage<'a> {
    parent: &'a Parent,
    name: String,
    file: File,
    identity: Metadata,
    files: Vec<BundleFile>,
    published: bool,
}
impl<'a> Stage<'a> {
    fn create(parent: &'a Parent) -> Result<Self> {
        for _ in 0..32 {
            parent.assert_current()?;
            let mut random = [0u8; 16];
            getrandom::fill(&mut random).map_err(|_| error(FAILED))?;
            let name = format!(".hepta-image-{}", hex::encode(random));
            match mkdirat(
                parent.file.as_fd(),
                name.as_str(),
                Mode::from_bits_truncate(0o700),
            ) {
                Err(Errno::EEXIST) => continue,
                Err(_) => return Err(error(FAILED)),
                Ok(()) => {}
            }
            // Never remove an unobserved inode if this open/observation fails.
            let file = File::from(
                openat(
                    parent.file.as_fd(),
                    name.as_str(),
                    OFlag::O_RDONLY | OFlag::O_DIRECTORY | OFlag::O_NOFOLLOW | OFlag::O_CLOEXEC,
                    Mode::empty(),
                )
                .map_err(|_| error(FAILED))?,
            );
            let identity = file.metadata().map_err(|_| error(FAILED))?;
            let stage = Self {
                parent,
                name,
                file,
                identity,
                files: Vec::new(),
                published: false,
            };
            stage.assert_current(&stage.path())?;
            return Ok(stage);
        }
        Err(error(FAILED))
    }
    fn path(&self) -> PathBuf {
        self.parent.path.join(&self.name)
    }
    fn assert_current(&self, path: &Path) -> Result<()> {
        self.parent.assert_current()?;
        let held = self.file.metadata().map_err(|_| error(CHANGED))?;
        let named = fs::symlink_metadata(path).map_err(|_| error(CHANGED))?;
        if !directory_equal(&held, &self.identity)
            || !directory_equal(&named, &self.identity)
            || held.uid() != nix::unistd::geteuid().as_raw()
            || held.mode() & 0o7777 != 0o700
        {
            return Err(error(CHANGED));
        }
        let entries = fs::read_dir(path)
            .map_err(|_| error(CHANGED))?
            .take(3)
            .collect::<std::io::Result<Vec<_>>>()
            .map_err(|_| error(CHANGED))?;
        if entries.len() != self.files.len()
            || entries
                .iter()
                .any(|e| !self.files.iter().any(|f| e.file_name() == f.name))
        {
            return Err(error(CHANGED));
        }
        for file in &self.files {
            file.assert_current(path)?;
        }
        self.parent.assert_current()?;
        Ok(())
    }
    fn write_new(&mut self, name: &'static str, bytes: &[u8]) -> Result<()> {
        self.assert_current(&self.path())?;
        let mut file = File::from(
            openat(
                self.file.as_fd(),
                name,
                OFlag::O_RDWR
                    | OFlag::O_CREAT
                    | OFlag::O_EXCL
                    | OFlag::O_NOFOLLOW
                    | OFlag::O_CLOEXEC,
                Mode::from_bits_truncate(0o600),
            )
            .map_err(|_| error(FAILED))?,
        );
        file.write_all(bytes).map_err(|_| error(FAILED))?;
        file.sync_all().map_err(|_| error(FAILED))?;
        let identity = file.metadata().map_err(|_| error(FAILED))?;
        self.files.push(BundleFile {
            name,
            file,
            identity,
            hash: hash_bytes(bytes),
        });
        self.assert_current(&self.path())
    }
    fn publish(&mut self, name: &Path, output: &Path) -> Result<()> {
        self.parent
            .assert_current()
            .map_err(|e| annotate(e, output, Some(false)))?;
        self.assert_current(&self.path())
            .map_err(|e| annotate(e, output, Some(false)))?;
        self.file
            .sync_all()
            .map_err(|_| annotate(error(FAILED), output, Some(false)))?;
        match renameat2(
            self.parent.file.as_fd(),
            self.name.as_str(),
            self.parent.file.as_fd(),
            name,
            RenameFlags::RENAME_NOREPLACE,
        ) {
            Ok(()) => self.published = true,
            Err(code) => {
                // Except for the explicit no-replace conflict, a failed
                // rename can have an uncertain outcome (including remote
                // filesystem retry semantics). Retain artifacts for inspection.
                let committed = if code == Errno::EEXIST {
                    Some(false)
                } else {
                    None
                };
                if committed.is_none() {
                    self.published = true;
                }
                return Err(annotate(
                    error(if code == Errno::EEXIST {
                        EXISTS
                    } else {
                        FAILED
                    }),
                    output,
                    committed,
                ));
            }
        }
        self.finish_publication(output)
    }
    fn finish_publication(&self, output: &Path) -> Result<()> {
        self.parent
            .file
            .sync_all()
            .map_err(|_| annotate(error(FAILED), output, Some(true)))?;
        self.assert_current(output)
            .map_err(|e| annotate(e, output, Some(true)))
    }
}
impl Drop for Stage<'_> {
    fn drop(&mut self) {
        // Cleanup only our entire unchanged staging namespace. Never traverse
        // through a replaced ancestor or delete anything at the final name.
        if self.published || self.assert_current(&self.path()).is_err() {
            return;
        }
        for file in &self.files {
            if self.parent.assert_current().is_err() || file.assert_current(&self.path()).is_err() {
                return;
            }
            if unlinkat(self.file.as_fd(), file.name, UnlinkatFlags::NoRemoveDir).is_err() {
                return;
            }
        }
        if self.parent.assert_current().is_ok()
            && fs::symlink_metadata(self.path()).is_ok_and(|m| directory_equal(&m, &self.identity))
        {
            let _ = unlinkat(
                self.parent.file.as_fd(),
                self.name.as_str(),
                UnlinkatFlags::RemoveDir,
            );
        }
    }
}

/// Only the closed-source CLI path calls this function. `source_report` is its
/// actual named namespace observation, not a caller assertion of provenance.
/// Existing output objects are never overwritten, reclaimed, or removed.
pub(super) fn publish_image(
    output: &Path,
    image: &OfflineNativeAuthorityImageV1,
    source_report: &Value,
    protected_paths: &[PathBuf],
) -> Result<Value> {
    let prepare = || -> Result<(Parent, Vec<u8>)> {
        if !canonical_shape(output) || output == Path::new("/") || protected_paths.is_empty() {
            return Err(error(INVALID));
        }
        for path in protected_paths {
            if !canonical_shape(path) {
                return Err(error(INVALID));
            }
            if output.starts_with(path) || path.starts_with(output) {
                return Err(error(PROTECTED));
            }
        }
        if image.report()["imageSha256"] != hash_bytes(image.bytes())
            || image.report()["imageByteLength"].as_u64() != Some(image.bytes().len() as u64)
        {
            return Err(error("local_authority_offline_publication_image_mismatch"));
        }
        let parent = Parent::open(output.parent().ok_or_else(|| error(INVALID))?)?;
        parent.absent(Path::new(output.file_name().ok_or_else(|| error(INVALID))?))?;
        let report = serde_json::to_vec_pretty(&json!({
            "version":1,"kind":"HeptaLocalStateAuthorityOfflineNativeImageBundleV1",
            "evidenceScope":"offline_artifact_no_migration_or_publication_authority",
            "image":image.report(),"sourceNamespaceObservation":source_report,
        }))
        .map_err(|_| error(FAILED))?;
        Ok((parent, report))
    };
    let (parent, report) = prepare().map_err(|e| annotate(e, output, Some(false)))?;
    let mut stage = Stage::create(&parent).map_err(|e| annotate(e, output, Some(false)))?;
    stage
        .write_new(IMAGE, image.bytes())
        .map_err(|e| annotate(e, output, Some(false)))?;
    stage
        .write_new(REPORT, &report)
        .map_err(|e| annotate(e, output, Some(false)))?;
    stage.publish(
        Path::new(
            output
                .file_name()
                .ok_or_else(|| annotate(error(INVALID), output, Some(false)))?,
        ),
        output,
    )?;
    Ok(json!({
        "version":1,"kind":"HeptaLocalStateAuthorityOfflineNativeImagePublicationV1",
        "evidenceScope":"offline_artifact_no_live_migration_authority","publicationCommitted":true,
        "outputPath":output,"imagePath":output.join(IMAGE),"reportPath":output.join(REPORT),
        "imageSha256":image.report()["imageSha256"],"reportSha256":hash_bytes(&report),
        "imageByteLength":image.bytes().len(),"reportByteLength":report.len(),
    }))
}

#[cfg(test)]
mod tests;
