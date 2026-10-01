//! Descriptor-retained streaming observations; no file or attribute mutations.
use super::*;
use nix::{
    fcntl::{OFlag, open, openat},
    sys::stat::Mode,
};
use sha2::{Digest, Sha256};
use std::{
    fs::{self, File, Metadata},
    io::Read,
    os::{fd::AsFd, unix::fs::MetadataExt},
    path::{Component, PathBuf},
};
const FLAGS: OFlag = OFlag::O_RDONLY
    .union(OFlag::O_NOFOLLOW)
    .union(OFlag::O_NONBLOCK)
    .union(OFlag::O_CLOEXEC);
fn refused() -> RetirementReferenceError {
    RetirementReferenceError::Refused("file_or_directory_changed_or_unsafe")
}
fn same(a: &Metadata, b: &Metadata) -> bool {
    (
        a.dev(),
        a.ino(),
        a.mode(),
        a.uid(),
        a.gid(),
        a.nlink(),
        a.len(),
        a.mtime(),
        a.mtime_nsec(),
        a.ctime(),
        a.ctime_nsec(),
    ) == (
        b.dev(),
        b.ino(),
        b.mode(),
        b.uid(),
        b.gid(),
        b.nlink(),
        b.len(),
        b.mtime(),
        b.mtime_nsec(),
        b.ctime(),
        b.ctime_nsec(),
    )
}
struct Directory {
    path: PathBuf,
    held: File,
    metadata: Metadata,
}
impl Directory {
    fn new(path: PathBuf, held: File) -> Result<Self> {
        let metadata = held.metadata()?;
        if !metadata.is_dir() {
            return Err(refused());
        }
        let result = Self {
            path,
            held,
            metadata,
        };
        result.current()?;
        Ok(result)
    }
    fn current(&self) -> Result<()> {
        for current in [self.held.metadata()?, fs::symlink_metadata(&self.path)?] {
            if !current.is_dir()
                || current.is_symlink()
                || (
                    current.dev(),
                    current.ino(),
                    current.mode(),
                    current.uid(),
                    current.gid(),
                ) != (
                    self.metadata.dev(),
                    self.metadata.ino(),
                    self.metadata.mode(),
                    self.metadata.uid(),
                    self.metadata.gid(),
                )
            {
                return Err(refused());
            }
        }
        Ok(())
    }
}
pub(super) struct ReferenceRoot {
    directories: Vec<Directory>,
    path: PathBuf,
}
pub(super) enum ReferenceRootObservation {
    Present(ReferenceRoot),
    Missing(MissingReferenceRoot),
}
/// A specific absent edge observed relative to the last retained ancestor.
/// Both the edge and that parent's full metadata stay current through use.
pub(super) struct MissingReferenceRoot {
    directories: Vec<Directory>,
    edge: std::ffi::OsString,
}
impl MissingReferenceRoot {
    pub fn assert_current(&self) -> Result<()> {
        for directory in &self.directories {
            directory.current()?;
        }
        let parent = self.directories.last().ok_or_else(refused)?;
        if !same(&parent.metadata, &parent.held.metadata()?)
            || !same(&parent.metadata, &fs::symlink_metadata(&parent.path)?)
        {
            return Err(refused());
        }
        match openat(
            parent.held.as_fd(),
            Path::new(&self.edge),
            FLAGS | OFlag::O_DIRECTORY,
            Mode::empty(),
        ) {
            Err(nix::errno::Errno::ENOENT) => (),
            _ => return Err(refused()),
        }
        for directory in &self.directories {
            directory.current()?;
        }
        if !same(&parent.metadata, &parent.held.metadata()?)
            || !same(&parent.metadata, &fs::symlink_metadata(&parent.path)?)
        {
            return Err(refused());
        }
        Ok(())
    }
}
impl ReferenceRoot {
    pub fn load(root: &Path) -> Result<Self> {
        match Self::observe(root)? {
            ReferenceRootObservation::Present(root) => Ok(root),
            ReferenceRootObservation::Missing(_) => Err(refused()),
        }
    }
    pub fn observe(root: &Path) -> Result<ReferenceRootObservation> {
        let absolute = if root.is_absolute() {
            root.to_owned()
        } else {
            std::env::current_dir()?.join(root)
        };
        if absolute
            .components()
            .any(|c| matches!(c, Component::ParentDir | Component::Prefix(_)))
        {
            return Err(RetirementReferenceError::Refused("root_path_invalid"));
        }
        let mut directories = vec![Directory::new(
            "/".into(),
            File::from(
                open(Path::new("/"), FLAGS | OFlag::O_DIRECTORY, Mode::empty())
                    .map_err(|_| refused())?,
            ),
        )?];
        for part in absolute.components().filter_map(|c| {
            if let Component::Normal(p) = c {
                Some(p)
            } else {
                None
            }
        }) {
            let previous = directories.last().ok_or_else(refused)?;
            let file = match openat(
                previous.held.as_fd(),
                Path::new(part),
                FLAGS | OFlag::O_DIRECTORY,
                Mode::empty(),
            ) {
                Ok(file) => File::from(file),
                Err(nix::errno::Errno::ENOENT) => {
                    let observation = MissingReferenceRoot {
                        directories,
                        edge: part.to_owned(),
                    };
                    observation.assert_current()?;
                    return Ok(ReferenceRootObservation::Missing(observation));
                }
                Err(_) => return Err(refused()),
            };
            directories.push(Directory::new(previous.path.join(part), file)?);
        }
        let path = directories.last().ok_or_else(refused)?.path.clone();
        let result = Self { directories, path };
        result.assert_current()?;
        Ok(ReferenceRootObservation::Present(result))
    }
    pub fn path(&self) -> &Path {
        &self.path
    }
    pub fn assert_current(&self) -> Result<()> {
        for d in &self.directories {
            d.current()?;
        }
        Ok(())
    }
    pub fn validate_name(name: &str) -> Result<()> {
        if name.is_empty()
            || name.len() > 4096
            || name.chars().any(char::is_control)
            || Path::new(name)
                .components()
                .any(|c| !matches!(c, Component::Normal(_)))
        {
            return Err(RetirementReferenceError::Refused("receipt_name_invalid"));
        }
        Ok(())
    }
    pub fn open(&self, name: &str) -> Result<Option<RetainedFile>> {
        Self::validate_name(name)?;
        self.assert_current()?;
        let mut parent = self
            .directories
            .last()
            .ok_or_else(refused)?
            .held
            .try_clone()?;
        let mut path = self.path().to_owned();
        let mut parents = Vec::new();
        let mut components = Path::new(name).components().peekable();
        while let Some(Component::Normal(part)) = components.next() {
            let last = components.peek().is_none();
            let held = match openat(
                parent.as_fd(),
                Path::new(part),
                FLAGS
                    | if last {
                        OFlag::empty()
                    } else {
                        OFlag::O_DIRECTORY
                    },
                Mode::empty(),
            ) {
                Ok(fd) => File::from(fd),
                Err(nix::errno::Errno::ENOENT) => return Ok(None),
                Err(_) => return Err(refused()),
            };
            path.push(part);
            if last {
                let metadata = held.metadata()?;
                if !metadata.is_file() || metadata.nlink() != 1 {
                    return Err(refused());
                }
                let file = RetainedFile {
                    path,
                    held,
                    metadata,
                    parents,
                };
                file.assert_current()?;
                self.assert_current()?;
                return Ok(Some(file));
            }
            let directory = Directory::new(path.clone(), held)?;
            parent = directory.held.try_clone()?;
            parents.push(directory);
        }
        Err(refused())
    }
}
pub(super) struct RetainedFile {
    path: PathBuf,
    held: File,
    metadata: Metadata,
    parents: Vec<Directory>,
}
impl RetainedFile {
    pub fn absolute(path: &Path) -> Result<Self> {
        let parent = ReferenceRoot::load(path.parent().ok_or_else(refused)?)?;
        let mut file = parent
            .open(
                path.file_name()
                    .and_then(|s| s.to_str())
                    .ok_or_else(refused)?,
            )?
            .ok_or_else(refused)?;
        file.parents.splice(0..0, parent.directories);
        Ok(file)
    }
    pub fn path(&self) -> &Path {
        &self.path
    }
    pub fn size(&self) -> u64 {
        self.metadata.len()
    }
    pub fn assert_system_executable(&self) -> Result<()> {
        if self.metadata.uid() != 0
            || self.metadata.mode() & 0o022 != 0
            || self.metadata.mode() & 0o111 == 0
        {
            return Err(refused());
        }
        for parent in &self.parents {
            if parent.metadata.uid() != 0 || parent.metadata.mode() & 0o022 != 0 {
                return Err(refused());
            }
        }
        let mut bytes = [0u8; 4];
        use std::os::unix::fs::FileExt;
        if self.held.read_at(&mut bytes, 0)? != 4 || bytes != *b"\x7fELF" {
            return Err(refused());
        }
        self.assert_current()
    }
    pub fn assert_current(&self) -> Result<()> {
        for parent in &self.parents {
            parent.current()?;
        }
        if !same(&self.metadata, &self.held.metadata()?)
            || !same(&self.metadata, &fs::symlink_metadata(&self.path)?)
        {
            return Err(refused());
        }
        Ok(())
    }
    fn read(
        &mut self,
        maximum: u64,
        budget: &mut Budget<'_>,
        mut consume: impl FnMut(&[u8]),
    ) -> Result<()> {
        budget.current()?;
        self.assert_current()?;
        if self.metadata.len() > maximum {
            return Err(RetirementReferenceError::Refused(
                "file_read_limit_exceeded",
            ));
        }
        let mut total = 0u64;
        let mut bytes = [0u8; 64 * 1024];
        loop {
            budget.current()?;
            let count = self.held.read(&mut bytes)?;
            if count == 0 {
                break;
            }
            total = total.checked_add(count as u64).ok_or_else(refused)?;
            if total > maximum {
                return Err(RetirementReferenceError::Refused(
                    "file_read_limit_exceeded",
                ));
            }
            budget.consume(count as u64)?;
            consume(&bytes[..count]);
        }
        if total != self.metadata.len() {
            return Err(refused());
        }
        self.assert_current()?;
        budget.current()
    }
    pub fn read_bytes(&mut self, maximum: u64, budget: &mut Budget<'_>) -> Result<Vec<u8>> {
        let mut bytes = Vec::new();
        self.read(maximum, budget, |part| bytes.extend_from_slice(part))?;
        Ok(bytes)
    }
    pub fn hash(&mut self, maximum: u64, budget: &mut Budget<'_>) -> Result<String> {
        let mut digest = Sha256::new();
        self.read(maximum, budget, |part| digest.update(part))?;
        Ok(format!("sha256:{:x}", digest.finalize()))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{io::Write, os::unix::fs::symlink};
    #[test]
    fn missing_reference_root_retains_first_and_last_absent_edges_and_rejects_creation() {
        let root =
            std::env::temp_dir().join(format!("hepta-reference-missing-{}", std::process::id()));
        fs::create_dir(&root).unwrap();
        for selected in [root.join("first/leaf"), root.join("leaf")] {
            let ReferenceRootObservation::Missing(missing) =
                ReferenceRoot::observe(&selected).unwrap()
            else {
                panic!("expected an actual absent edge");
            };
            missing.assert_current().unwrap();
            let edge = missing.directories.last().unwrap().path.join(&missing.edge);
            fs::create_dir(&edge).unwrap();
            assert!(missing.assert_current().is_err());
            fs::remove_dir(&edge).unwrap();
            // Even an edge created and removed before this check changes the
            // retained parent's metadata; the old observation cannot revive.
            assert!(missing.assert_current().is_err());
            let ReferenceRootObservation::Missing(fresh) =
                ReferenceRoot::observe(&selected).unwrap()
            else {
                panic!("fresh retry must observe the missing edge again");
            };
            fresh.assert_current().unwrap();
        }
        fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn missing_reference_root_rejects_parent_replacement_symlink_and_non_directory() {
        let root = std::env::temp_dir().join(format!(
            "hepta-reference-missing-replace-{}",
            std::process::id()
        ));
        fs::create_dir(&root).unwrap();
        let parent = root.join("parent");
        fs::create_dir(&parent).unwrap();
        let selected = parent.join("absent");
        let ReferenceRootObservation::Missing(missing) = ReferenceRoot::observe(&selected).unwrap()
        else {
            panic!("expected missing final edge");
        };
        fs::rename(&parent, root.join("old-parent")).unwrap();
        fs::create_dir(&parent).unwrap();
        assert!(missing.assert_current().is_err());
        symlink(root.join("old-parent"), &selected).unwrap();
        assert!(ReferenceRoot::observe(&selected).is_err());
        fs::remove_file(&selected).unwrap();
        fs::write(&selected, b"regular parent").unwrap();
        assert!(ReferenceRoot::observe(&selected.join("child")).is_err());
        fs::remove_file(&selected).unwrap();
        // A final symlink to a missing destination still cannot become ENOENT
        // evidence, because the named edge itself is not an absent directory.
        symlink(root.join("missing-target"), &selected).unwrap();
        assert!(ReferenceRoot::observe(&selected).is_err());
        fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn missing_reference_root_permission_denial_is_never_absence_evidence() {
        use std::os::unix::fs::PermissionsExt;
        let root =
            std::env::temp_dir().join(format!("hepta-reference-permission-{}", std::process::id()));
        fs::create_dir(&root).unwrap();
        let denied = root.join("denied");
        fs::create_dir(&denied).unwrap();
        fs::set_permissions(&denied, fs::Permissions::from_mode(0o0)).unwrap();
        // A privileged test process cannot create an EACCES observation. The
        // ordinary unprivileged source lane checks the actual kernel refusal.
        if !nix::unistd::geteuid().is_root() {
            assert!(ReferenceRoot::observe(&denied.join("missing")).is_err());
        }
        fs::set_permissions(&denied, fs::Permissions::from_mode(0o700)).unwrap();
        fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn retained_archive_rejects_replacement_same_bytes_rewrite_and_parent_alias() {
        let root =
            std::env::temp_dir().join(format!("hepta-reference-held-{}", std::process::id()));
        fs::create_dir(&root).unwrap();
        fs::create_dir(root.join("nested")).unwrap();
        let path = root.join("nested/archive");
        fs::write(&path, b"original").unwrap();
        let observation = ReferenceRoot::load(&root).unwrap();
        let original = observation.open("nested/archive").unwrap().unwrap();
        std::thread::sleep(Duration::from_millis(2));
        fs::OpenOptions::new()
            .write(true)
            .open(&path)
            .unwrap()
            .write_all(b"original")
            .unwrap();
        assert!(original.assert_current().is_err());
        let original = observation.open("nested/archive").unwrap().unwrap();
        fs::rename(&path, root.join("old")).unwrap();
        fs::write(&path, b"original").unwrap();
        assert!(original.assert_current().is_err());
        let original = observation.open("nested/archive").unwrap().unwrap();
        fs::rename(root.join("nested"), root.join("moved")).unwrap();
        symlink(root.join("moved"), root.join("nested")).unwrap();
        assert!(original.assert_current().is_err());
        assert!(observation.open("nested/archive").is_err());
        fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn streaming_archive_honors_total_read_budget_cancellation_and_deadline() {
        let root =
            std::env::temp_dir().join(format!("hepta-reference-budget-{}", std::process::id()));
        fs::create_dir(&root).unwrap();
        fs::write(root.join("archive"), vec![0u8; 131072]).unwrap();
        let observation = ReferenceRoot::load(&root).unwrap();
        let cancelled = AtomicBool::new(false);
        let mut budget = Budget {
            cancelled: &cancelled,
            deadline: Instant::now() + Duration::from_secs(1),
            remaining: 65536,
        };
        let mut file = observation.open("archive").unwrap().unwrap();
        assert_eq!(
            file.hash(131072, &mut budget).unwrap_err().to_string(),
            "retirement_reference_total_read_limit_exceeded"
        );
        cancelled.store(true, Ordering::Release);
        assert_eq!(
            file.hash(131072, &mut budget).unwrap_err().to_string(),
            "retirement_reference_cancelled"
        );
        cancelled.store(false, Ordering::Release);
        budget.deadline = Instant::now();
        assert_eq!(
            file.hash(131072, &mut budget).unwrap_err().to_string(),
            "retirement_reference_deadline_exceeded"
        );
        fs::remove_dir_all(root).unwrap();
    }
}
