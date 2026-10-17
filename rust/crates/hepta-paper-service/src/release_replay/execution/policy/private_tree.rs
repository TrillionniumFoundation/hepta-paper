//! Private local allocations with identity checked cleanup; no host runtime writes.
use super::{
    Owner, error,
    facts::{Matrix, relative},
};
use std::{
    collections::BTreeMap,
    fs::{self, File, OpenOptions},
    io::Write,
    os::unix::fs::{DirBuilderExt, MetadataExt, OpenOptionsExt, PermissionsExt},
    path::{Path, PathBuf},
};
struct Entry {
    file: File,
    metadata: fs::Metadata,
}
pub(super) struct PrivateTree {
    root: PathBuf,
    metadata: fs::Metadata,
    sources: BTreeMap<String, Entry>,
    directories: BTreeMap<PathBuf, fs::Metadata>,
    cleaned: bool,
    cleanup_allowed: bool,
}
fn identity(a: &fs::Metadata, b: &fs::Metadata) -> bool {
    a.dev() == b.dev()
        && a.ino() == b.ino()
        && a.mode() == b.mode()
        && a.uid() == b.uid()
        && a.gid() == b.gid()
}
impl PrivateTree {
    pub(super) fn new() -> Result<Self, String> {
        let base = fs::canonicalize(std::env::temp_dir())
            .map_err(|_| error("policy_temporary_parent_invalid"))?;
        let mut random = [0; 16];
        getrandom::fill(&mut random).map_err(|_| error("policy_random_failed"))?;
        let root = base.join(format!(
            "hepta-native-matrix-policy-{}",
            hex::encode(random)
        ));
        fs::DirBuilder::new()
            .mode(0o700)
            .create(&root)
            .map_err(|_| error("policy_temporary_create_failed"))?;
        let metadata =
            fs::symlink_metadata(&root).map_err(|_| error("policy_temporary_invalid"))?;
        let mut tree = Self {
            root,
            metadata,
            sources: BTreeMap::new(),
            directories: BTreeMap::new(),
            cleaned: false,
            cleanup_allowed: true,
        };
        tree.directory("sources")?;
        Ok(tree)
    }
    fn root_current(&self) -> Result<(), String> {
        let named =
            fs::symlink_metadata(&self.root).map_err(|_| error("policy_temporary_changed"))?;
        if !named.is_dir() || named.is_symlink() || !identity(&self.metadata, &named) {
            return Err(error("policy_temporary_changed"));
        }
        Ok(())
    }
    pub(super) fn sources(&self) -> PathBuf {
        self.root.join("sources")
    }
    pub(super) fn directory(&mut self, relative_path: &str) -> Result<PathBuf, String> {
        if !relative(relative_path) {
            return Err(error("policy_temporary_path_invalid"));
        }
        self.root_current()?;
        let mut path = self.root.clone();
        for c in Path::new(relative_path).components() {
            path.push(c);
            if let Some(before) = self.directories.get(&path) {
                let after =
                    fs::symlink_metadata(&path).map_err(|_| error("policy_temporary_changed"))?;
                if !after.is_dir() || after.is_symlink() || !identity(before, &after) {
                    return Err(error("policy_temporary_changed"));
                }
            } else {
                fs::DirBuilder::new()
                    .mode(0o700)
                    .create(&path)
                    .map_err(|_| error("policy_temporary_create_failed"))?;
                let m =
                    fs::symlink_metadata(&path).map_err(|_| error("policy_temporary_invalid"))?;
                self.directories.insert(path.clone(), m);
            }
        }
        Ok(path)
    }
    pub(super) fn source(&mut self, name: &str, bytes: &[u8]) -> Result<(), String> {
        if !relative(name) || self.sources.contains_key(name) {
            return Err(error("policy_source_path_invalid"));
        }
        let relative_path = format!("sources/{name}");
        let parent = Path::new(&relative_path)
            .parent()
            .and_then(|p| p.to_str())
            .ok_or_else(|| error("policy_source_path_invalid"))?;
        self.directory(parent)?;
        let path = self.root.join(relative_path);
        let mut file = OpenOptions::new()
            .create_new(true)
            .read(true)
            .write(true)
            .mode(0o600)
            .custom_flags(nix::libc::O_NOFOLLOW | nix::libc::O_CLOEXEC)
            .open(&path)
            .map_err(|_| error("policy_source_create_failed"))?;
        file.write_all(bytes)
            .map_err(|_| error("policy_source_write_failed"))?;
        file.sync_all()
            .map_err(|_| error("policy_source_write_failed"))?;
        file.set_permissions(fs::Permissions::from_mode(0o400))
            .map_err(|_| error("policy_source_write_failed"))?;
        let metadata = file
            .metadata()
            .map_err(|_| error("policy_source_write_failed"))?;
        self.sources.insert(name.into(), Entry { file, metadata });
        Ok(())
    }
    pub(super) fn read_source(&self, name: &str, owner: &mut Owner<'_>) -> Result<Vec<u8>, String> {
        self.root_current()?;
        let source = self
            .sources
            .get(name)
            .ok_or_else(|| error("policy_source_not_owned"))?;
        let named = fs::symlink_metadata(self.sources().join(name))
            .map_err(|_| error("policy_source_changed"))?;
        let held = source
            .file
            .metadata()
            .map_err(|_| error("policy_source_changed"))?;
        if !super::super::same(&named, &source.metadata)
            || !super::super::same(&held, &source.metadata)
            || !named.is_file()
            || named.is_symlink()
        {
            return Err(error("policy_source_changed"));
        }
        let mut file = source
            .file
            .try_clone()
            .map_err(|_| error("policy_source_changed"))?;
        use std::io::Seek;
        file.rewind().map_err(|_| error("policy_source_changed"))?;
        let mut bytes = vec![0; source.metadata.len() as usize];
        let mut offset = 0;
        while offset < bytes.len() {
            let n = owner.read_tool(&mut file, &mut bytes[offset..])?;
            if n == 0 {
                return Err(error("policy_source_changed"));
            }
            offset += n;
        }
        let after = source
            .file
            .metadata()
            .map_err(|_| error("policy_source_changed"))?;
        if !super::super::same(&after, &source.metadata) {
            return Err(error("policy_source_changed"));
        }
        Ok(bytes)
    }
    #[cfg(test)]
    pub(super) fn fixture_source(
        &mut self,
        name: &str,
        bytes: &[u8],
        original_mode: u32,
    ) -> Result<(), String> {
        if original_mode & !0o777 != 0 || original_mode & 0o400 == 0 {
            return Err(error("policy_fixture_mode_invalid"));
        }
        self.source(name, bytes)?;
        self.root_current()?;
        let source = self.sources.get_mut(name).unwrap();
        let named = fs::symlink_metadata(self.root.join("sources").join(name))
            .map_err(|_| error("policy_source_changed"))?;
        if !super::super::same(&named, &source.metadata)
            || !super::super::same(
                &source
                    .file
                    .metadata()
                    .map_err(|_| error("policy_source_changed"))?,
                &source.metadata,
            )
        {
            return Err(error("policy_source_changed"));
        }
        source
            .file
            .set_permissions(fs::Permissions::from_mode(original_mode))
            .map_err(|_| error("policy_source_write_failed"))?;
        source
            .file
            .sync_all()
            .map_err(|_| error("policy_source_write_failed"))?;
        source.metadata = source
            .file
            .metadata()
            .map_err(|_| error("policy_source_changed"))?;
        if !super::super::same(
            &fs::symlink_metadata(self.root.join("sources").join(name))
                .map_err(|_| error("policy_source_changed"))?,
            &source.metadata,
        ) || source.metadata.nlink() != 1
        {
            return Err(error("policy_source_changed"));
        }
        // Copying retains value provenance, not an execution/source owner. The
        // real SourceGraph will open and hold the private files itself. Avoid
        // keeping a second full set of candidate-sized file descriptors here.
        self.sources.remove(name);
        Ok(())
    }
    pub(super) fn assert_sources(
        &self,
        matrix: &Matrix,
        owner: &mut Owner<'_>,
    ) -> Result<(), String> {
        for row in &matrix.entries {
            let bytes = self.read_source(&row.source.path, owner)?;
            if super::digest(&bytes) != format!("sha256:{}", row.source.sha256) {
                return Err(error("policy_source_changed"));
            }
        }
        Ok(())
    }
    pub(super) fn process_cleanup(&mut self, verified: bool) {
        self.cleanup_allowed = verified;
    }
    pub(super) fn cleanup(&mut self) -> Result<(), String> {
        if !self.cleanup_allowed {
            return Err(error(
                "policy_process_cleanup_unverified_temporary_root_retained",
            ));
        }
        if self.cleaned {
            return Ok(());
        }
        self.root_current()?;
        fn collect(
            root: &Path,
            path: &Path,
            depth: usize,
            entries: &mut Vec<(PathBuf, fs::Metadata)>,
        ) -> Result<(), String> {
            if depth > 64 || entries.len() > 20_000 {
                return Err(error("policy_cleanup_budget"));
            }
            let before = fs::symlink_metadata(path).map_err(|_| error("policy_cleanup_changed"))?;
            if !before.is_dir() || before.is_symlink() || !path.starts_with(root) {
                return Err(error("policy_cleanup_changed"));
            }
            for e in fs::read_dir(path).map_err(|_| error("policy_cleanup_changed"))? {
                if entries.len() >= 20_000 {
                    return Err(error("policy_cleanup_budget"));
                }
                let p = e.map_err(|_| error("policy_cleanup_changed"))?.path();
                let m = fs::symlink_metadata(&p).map_err(|_| error("policy_cleanup_changed"))?;
                if m.is_symlink()
                    || !m.is_file() && !m.is_dir()
                    || m.uid() != nix::unistd::getuid().as_raw()
                {
                    return Err(error("policy_cleanup_unknown_entry"));
                }
                if m.is_dir() {
                    collect(root, &p, depth + 1, entries)?;
                }
                entries.push((p, m));
            }
            let after = fs::symlink_metadata(path).map_err(|_| error("policy_cleanup_changed"))?;
            if !identity(&before, &after) {
                return Err(error("policy_cleanup_changed"));
            }
            Ok(())
        }
        let mut entries = Vec::new();
        collect(&self.root, &self.root, 0, &mut entries)?;
        for (path, before) in entries {
            self.root_current()?;
            let after = fs::symlink_metadata(&path).map_err(|_| error("policy_cleanup_changed"))?;
            if !identity(&before, &after) {
                return Err(error("policy_cleanup_changed"));
            }
            if after.is_dir() {
                fs::remove_dir(&path).map_err(|_| error("policy_cleanup_failed"))?;
            } else {
                fs::remove_file(&path).map_err(|_| error("policy_cleanup_failed"))?;
            }
        }
        self.root_current()?;
        fs::remove_dir(&self.root).map_err(|_| error("policy_cleanup_failed"))?;
        self.cleaned = true;
        Ok(())
    }
}
impl Drop for PrivateTree {
    fn drop(&mut self) {
        let _ = self.cleanup();
    }
}
