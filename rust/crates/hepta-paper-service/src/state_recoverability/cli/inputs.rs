use super::*;
use crate::sqlite_mutation_coordinator::authority::files::{Snapshot, parse};
use nix::{
    fcntl::{OFlag, openat},
    sys::stat::Mode,
};
use std::{
    fs::{self, File, Metadata},
    os::unix::fs::{FileExt, MetadataExt},
    path::Component,
};

pub(super) fn configuration(
    path: &Path,
    code: &str,
) -> Result<(super::super::files::ObservedFile, String, Value)> {
    let observed =
        super::super::files::ObservedFile::open(path, 4 * 1024 * 1024).map_err(|_| error(code))?;
    let bytes = observed.bytes(4 * 1024 * 1024).map_err(|_| error(code))?;
    let pin = hash_bytes(&bytes);
    let snapshot = Snapshot::load(path, &pin, 4 * 1024 * 1024, code)?;
    let document = snapshot.json(code)?;
    observed.assert_current().map_err(|_| error(code))?;
    Ok((observed, pin, document))
}
fn same(a: &Metadata, b: &Metadata) -> bool {
    a.dev() == b.dev()
        && a.ino() == b.ino()
        && a.mode() == b.mode()
        && a.nlink() == b.nlink()
        && a.uid() == b.uid()
        && a.gid() == b.gid()
        && a.len() == b.len()
        && a.mtime() == b.mtime()
        && a.mtime_nsec() == b.mtime_nsec()
        && a.ctime() == b.ctime()
        && a.ctime_nsec() == b.ctime_nsec()
}
/// A repository manifest is public source data and may be group writable in a
/// shared checkout. Authority configurations use the stronger private input
/// policy above. Neither policy opens FIFO devices or follows path aliases.
pub(super) struct ManifestFile {
    path: PathBuf,
    file: File,
    metadata: Metadata,
    parents: Vec<(PathBuf, File)>,
    pub value: Value,
}
impl ManifestFile {
    pub fn load(path: &Path) -> Result<Self> {
        let failed = || error("autonomous_research_state_backup_manifest_file_invalid");
        if !path.is_absolute()
            || path
                .components()
                .any(|c| !matches!(c, Component::RootDir | Component::Normal(_)))
        {
            return Err(failed());
        }
        let mut directory = File::open("/").map_err(|_| failed())?;
        let mut cursor = PathBuf::from("/");
        let mut parents = Vec::new();
        let mut parts = path
            .components()
            .filter_map(|c| match c {
                Component::Normal(name) => Some(name),
                _ => None,
            })
            .peekable();
        while let Some(name) = parts.next() {
            let last = parts.peek().is_none();
            let file = File::from(
                openat(
                    &directory,
                    Path::new(name),
                    OFlag::O_RDONLY
                        | OFlag::O_NOFOLLOW
                        | OFlag::O_CLOEXEC
                        | OFlag::O_NONBLOCK
                        | if last {
                            OFlag::empty()
                        } else {
                            OFlag::O_DIRECTORY
                        },
                    Mode::empty(),
                )
                .map_err(|_| failed())?,
            );
            parents.push((cursor.clone(), directory));
            cursor.push(name);
            if last {
                let metadata = file.metadata().map_err(|_| failed())?;
                if !metadata.is_file()
                    || metadata.len() == 0
                    || metadata.len() > 4 * 1024 * 1024
                    || metadata.nlink() != 1
                {
                    return Err(failed());
                }
                let mut bytes = vec![0; usize::try_from(metadata.len()).map_err(|_| failed())?];
                file.read_exact_at(&mut bytes, 0).map_err(|_| failed())?;
                let value = Self {
                    path: cursor,
                    file,
                    metadata,
                    parents,
                    value: parse(
                        &bytes,
                        "autonomous_research_state_backup_manifest_file_invalid",
                    )?,
                };
                value.assert_current()?;
                return Ok(value);
            }
            directory = file;
        }
        Err(failed())
    }
    pub fn assert_current(&self) -> Result<()> {
        let failed = || error("autonomous_research_state_backup_manifest_file_changed");
        for (path, parent) in &self.parents {
            let held = parent.metadata().map_err(|_| failed())?;
            let named = fs::symlink_metadata(path).map_err(|_| failed())?;
            if !named.is_dir()
                || named.is_symlink()
                || named.dev() != held.dev()
                || named.ino() != held.ino()
            {
                return Err(failed());
            }
        }
        let named = fs::symlink_metadata(&self.path).map_err(|_| failed())?;
        if named.is_symlink()
            || !same(&self.metadata, &named)
            || !same(&self.metadata, &self.file.metadata().map_err(|_| failed())?)
        {
            return Err(failed());
        }
        Ok(())
    }
}
