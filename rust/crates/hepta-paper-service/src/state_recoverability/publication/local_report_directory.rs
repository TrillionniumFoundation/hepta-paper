//! Ordinary local report directory observation, distinct from private authority
//! Directory. The existing nofollow held-chain traversal is shared verbatim;
//! group-writable data directories do not mint private publication authority.
use super::*;
pub(crate) struct LocalReportDirectoryV1 {
    pub path: PathBuf,
    pub held: File,
    parents: Vec<(PathBuf, File, fs::Metadata)>,
    identity: fs::Metadata,
}
impl LocalReportDirectoryV1 {
    pub(crate) fn open_or_create(path: &Path, create: bool) -> Result<Self> {
        Self::with_creation_policy(path, create, CreationPolicy::LocalReport)
    }
    /// The original filesystem ledger creates a private data directory. Existing
    /// safe group data modes are observed without chmod; this is no authority.
    pub(crate) fn open_receipt_ledger(path: &Path, create: bool) -> Result<Self> {
        Self::with_creation_policy(path, create, CreationPolicy::Private)
    }
    fn with_creation_policy(path: &Path, create: bool, policy: CreationPolicy) -> Result<Self> {
        let (path, held, parents) = open_directory_chain(path, create, policy)?;
        let identity = held.metadata().map_err(|_| failure())?;
        let parents = parents
            .into_iter()
            .map(|(path, file)| {
                let metadata = file.metadata().map_err(|_| failure())?;
                Ok((path, file, metadata))
            })
            .collect::<Result<Vec<_>>>()?;
        let result = Self {
            path,
            held,
            parents,
            identity,
        };
        result.assert_current()?;
        Ok(result)
    }
    /// Stage under an observed local data directory without changing its mode.
    /// The exclusive new child is re-opened by the existing private owner.
    pub(crate) fn private_staging_child_v1(&self, name: &str) -> Result<Directory> {
        self.assert_current()?;
        ensure(
            valid_name(name),
            "autonomous_research_state_backup_publication_name_invalid",
        )?;
        mkdirat(self.held.as_fd(), name, Mode::from_bits_truncate(0o700)).map_err(|_| failure())?;
        let child = Directory::open_or_create(&self.path.join(name), false)?;
        self.assert_current()?;
        Ok(child)
    }
    pub(crate) fn assert_current(&self) -> Result<()> {
        for (path, held, before) in self
            .parents
            .iter()
            .map(|(p, f, m)| (p, f, m))
            .chain(std::iter::once((&self.path, &self.held, &self.identity)))
        {
            let named = fs::symlink_metadata(path).map_err(|_| failure())?;
            let current = held.metadata().map_err(|_| failure())?;
            if named.is_symlink()
                || !same_directory(before, &named)
                || !same_directory(before, &current)
            {
                return Err(failure());
            }
        }
        let leaf = self.held.metadata().map_err(|_| failure())?;
        ensure(
            leaf.uid() == nix::unistd::getuid().as_raw() && leaf.mode() & 0o002 == 0,
            "native_local_report_directory_owner_or_world_write_v1_refused",
        )
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    use std::os::unix::fs::PermissionsExt;
    #[test]
    fn ordinary_group_data_mode_never_relaxes_private_authority_directory() {
        let root = std::env::temp_dir().join(format!(
            "hepta-local-report-directory-{}-{}",
            std::process::id(),
            nonce().unwrap()
        ));
        fs::create_dir(&root).unwrap();
        fs::set_permissions(&root, fs::Permissions::from_mode(0o775)).unwrap();
        let held = LocalReportDirectoryV1::open_or_create(&root, false).unwrap();
        held.assert_current().unwrap();
        assert!(Directory::open_or_create(&root, false).is_err());
        let staging = held.private_staging_child_v1("private-staging").unwrap();
        assert_eq!(staging.held.metadata().unwrap().mode() & 0o7777, 0o700);
        assert_eq!(held.held.metadata().unwrap().mode() & 0o7777, 0o775);
        staging.assert_current().unwrap();
        assert!(held.private_staging_child_v1("private-staging").is_err());
        fs::remove_dir(&staging.path).unwrap();
        fs::set_permissions(&root, fs::Permissions::from_mode(0o755)).unwrap();
        assert!(held.assert_current().is_err());
        let private = Directory::open_or_create(&root, false).unwrap();
        private.assert_current().unwrap();
        fs::set_permissions(&root, fs::Permissions::from_mode(0o777)).unwrap();
        assert!(LocalReportDirectoryV1::open_or_create(&root, false).is_err());
        assert!(private.assert_current().is_err());
        fs::remove_dir(&root).unwrap();
    }
    #[test]
    fn aliases_replacement_and_ancestor_permission_changes_are_refused() {
        let root = std::env::temp_dir().join(format!(
            "hepta-local-report-path-{}-{}",
            std::process::id(),
            nonce().unwrap()
        ));
        fs::create_dir(&root).unwrap();
        fs::set_permissions(&root, fs::Permissions::from_mode(0o700)).unwrap();
        let child = root.join("reports");
        fs::create_dir(&child).unwrap();
        fs::set_permissions(&child, fs::Permissions::from_mode(0o775)).unwrap();
        let observed = LocalReportDirectoryV1::open_or_create(&child, false).unwrap();
        fs::create_dir(root.join("legitimate-sibling")).unwrap();
        observed.assert_current().unwrap();
        let alias = root.join("alias");
        std::os::unix::fs::symlink(&child, &alias).unwrap();
        assert!(LocalReportDirectoryV1::open_or_create(&alias, false).is_err());
        assert!(LocalReportDirectoryV1::open_or_create(&alias.join("nested"), true).is_err());
        assert!(!child.join("nested").exists());
        fs::set_permissions(&root, fs::Permissions::from_mode(0o750)).unwrap();
        assert!(observed.assert_current().is_err());
        fs::set_permissions(&root, fs::Permissions::from_mode(0o700)).unwrap();
        let observed = LocalReportDirectoryV1::open_or_create(&child, false).unwrap();
        let old = root.join("original-reports");
        fs::rename(&child, &old).unwrap();
        fs::create_dir(&child).unwrap();
        fs::set_permissions(&child, fs::Permissions::from_mode(0o775)).unwrap();
        assert!(observed.assert_current().is_err());
        assert!(old.is_dir());
        fs::remove_dir_all(&root).unwrap();
    }
}
