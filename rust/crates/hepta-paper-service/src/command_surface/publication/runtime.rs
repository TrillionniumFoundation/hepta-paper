//! Versioned local package-publication correlation in the existing runtime
//! layout. These records never grant signed authority or hide legacy unknowns.
use super::*;
use crate::native_workspace::resolve_native_workspace_root_v1;

pub(super) const BINDING_NAME: &str = "root-binding-v2.json";
pub(super) const NAMESPACE: &str = "command-surface-publication-v2";
#[derive(Clone, Debug, Deserialize, Serialize, Eq, PartialEq)]
#[serde(deny_unknown_fields)]
struct DirectoryIdentity {
    dev: u64,
    ino: u64,
    uid: u32,
    gid: u32,
    mode: u32,
}
impl DirectoryIdentity {
    fn observe(metadata: &Metadata) -> Result<Self, CommandSurfaceError> {
        if !metadata.is_dir() {
            return Err(changed());
        }
        Ok(Self {
            dev: metadata.dev(),
            ino: metadata.ino(),
            uid: metadata.uid(),
            gid: metadata.gid(),
            mode: metadata.mode() & 0o7777,
        })
    }
}
#[derive(Clone, Debug, Deserialize, Serialize, Eq, PartialEq)]
#[serde(deny_unknown_fields)]
struct RootBinding {
    version: u8,
    kind: String,
    workspace_path: String,
    workspace: DirectoryIdentity,
    runtime_path: String,
    runtime: DirectoryIdentity,
    namespace: DirectoryIdentity,
    publication_path: String,
    publication: DirectoryIdentity,
    lock: Witness,
    authority_granted: bool,
}
pub(super) struct Context {
    runtime: Directory,
    namespace: Directory,
    runtime_identity: DirectoryIdentity,
    namespace_identity: DirectoryIdentity,
    workspace_path: String,
    workspace_identity: DirectoryIdentity,
    pub(super) key: String,
    pub(super) path: PathBuf,
}
fn path_text(path: &Path) -> Result<String, CommandSurfaceError> {
    let value = path.to_str().ok_or_else(changed)?;
    if value.is_empty() || value.len() > 4096 || value.contains('\0') {
        return Err(changed());
    }
    Ok(value.to_owned())
}
pub(super) fn workspace_key(
    root: &Path,
    metadata: &Metadata,
) -> Result<String, CommandSurfaceError> {
    let workspace_path = path_text(root)?;
    let identity = DirectoryIdentity::observe(metadata)?;
    Ok(format!(
        "workspace-{}",
        hex::encode(Sha256::digest(serde_json::to_vec(
            &serde_json::json!({"version": 2, "workspacePath": workspace_path, "dev": identity.dev, "ino": identity.ino})
        )?))
    ))
}
pub(super) fn selected_runtime_path(root: &Path) -> Result<PathBuf, CommandSurfaceError> {
    let selected = std::env::var_os("HEPTA_PAPER_RUNTIME_ROOT")
        .filter(|value| !value.is_empty())
        .map(PathBuf::from)
        .unwrap_or_else(|| {
            root.parent()
                .unwrap_or(root)
                .join("hepta-paper-runtime/native-runtime")
        });
    // Normal Node wrappers resolve a relative runtime environment from the
    // physically selected frontend ROOT rather than the arbitrary caller cwd.
    resolve_native_workspace_root_v1(root, &selected, Some(&selected)).map_err(|_| changed())
}
// Read-only observation of the existing path prefix before creation. It
// never initializes an absent directory, follows an alias, or changes access
// bits. This is a held/named observation, not protection from hostile future
// mounts or a kernel CAS; the completed Directory owner checks again after
// creation and retains failures instead of reversing unverified state.
fn preflight_runtime_prefix(
    path: &Path,
    workspace: &DirectoryIdentity,
) -> Result<(), CommandSurfaceError> {
    use std::{os::unix::ffi::OsStrExt, path::Component};
    let mut current = File::from(
        nix::fcntl::open(Path::new("/"), FLAGS | OFlag::O_DIRECTORY, Mode::empty())
            .map_err(|_| changed())?,
    );
    let mut cursor = PathBuf::from("/");
    let mut held_prefix = Vec::new();
    let mut absent = false;
    for component in path.components() {
        let Component::Normal(name) = component else {
            if component == Component::RootDir {
                continue;
            }
            return Err(changed());
        };
        if name.as_bytes().len() > 255 {
            return Err(changed());
        }
        if absent {
            continue;
        }
        let before = current.metadata()?;
        let named = fs::symlink_metadata(&cursor)?;
        if DirectoryIdentity::observe(&before)? != DirectoryIdentity::observe(&named)? {
            return Err(changed());
        }
        if before.dev() == workspace.dev && before.ino() == workspace.ino {
            return Err(refused(
                "command_surface_publication_runtime_aliases_workspace",
            ));
        }
        match openat(
            current.as_fd(),
            Path::new(name),
            FLAGS | OFlag::O_DIRECTORY,
            Mode::empty(),
        ) {
            Ok(fd) => {
                held_prefix.push((
                    cursor.clone(),
                    current,
                    DirectoryIdentity::observe(&before)?,
                ));
                cursor.push(name);
                current = File::from(fd);
            }
            Err(nix::errno::Errno::ENOENT) => absent = true,
            Err(_) => return Err(changed()),
        }
    }
    let final_metadata = current.metadata()?;
    if final_metadata.dev() != workspace.dev {
        return Err(refused(
            "command_surface_publication_runtime_filesystem_mismatch",
        ));
    }
    if final_metadata.dev() == workspace.dev && final_metadata.ino() == workspace.ino {
        return Err(refused(
            "command_surface_publication_runtime_aliases_workspace",
        ));
    }
    held_prefix.push((
        cursor,
        current,
        DirectoryIdentity::observe(&final_metadata)?,
    ));
    phase("runtime_prefix_retained");
    for (named_path, held, before) in &held_prefix {
        let held_metadata = held.metadata()?;
        let named_metadata = fs::symlink_metadata(named_path)?;
        // These non-authority ancestors may legitimately acquire siblings.
        // Reuse the existing Directory owner's device/inode/UID/GID/mode
        // identity rather than misclassifying directory ctime/nlink as a
        // content witness. All regular leaves retain their full Witness.
        if DirectoryIdentity::observe(&held_metadata)? != *before
            || DirectoryIdentity::observe(&named_metadata)? != *before
        {
            return Err(refused(
                "command_surface_publication_runtime_prefix_changed",
            ));
        }
    }
    Ok(())
}
impl Context {
    pub(super) fn open(input: &NativeWorkspacePackageGuardV1) -> Result<Self, CommandSurfaceError> {
        let root = input.root();
        let runtime_path = selected_runtime_path(root)?;
        Self::open_selected(input, &runtime_path)
    }
    pub(super) fn open_selected(
        input: &NativeWorkspacePackageGuardV1,
        runtime_path: &Path,
    ) -> Result<Self, CommandSurfaceError> {
        let root = input.root();
        let runtime_path = resolve_native_workspace_root_v1(root, runtime_path, Some(runtime_path))
            .map_err(|_| changed())?;
        path_text(&runtime_path)?;
        let workspace_path = path_text(root)?;
        let workspace_identity = DirectoryIdentity::observe(&input.parent().metadata()?)?;
        let key = workspace_key(root, &input.parent().metadata()?)?;
        let namespace_path = runtime_path.join(NAMESPACE);
        let path = namespace_path.join(&key);
        // Validate every intended name and the complete final path before any
        // mkdir. Refusal must not leave a partly created layout for a path
        // which was already outside this bounded local profile.
        path_text(&path)?;
        if runtime_path.starts_with(root) || root.starts_with(&runtime_path) {
            return Err(refused(
                "command_surface_publication_runtime_overlaps_workspace",
            ));
        }
        input.assert_current().map_err(|_| changed())?;
        preflight_runtime_prefix(&runtime_path, &workspace_identity)?;
        input.assert_current().map_err(|_| changed())?;
        let runtime = Directory::open_or_create(&runtime_path, true).map_err(private_error)?;
        let runtime_identity = DirectoryIdentity::observe(&runtime.held.metadata()?)?;
        if runtime_identity.dev == workspace_identity.dev
            && runtime_identity.ino == workspace_identity.ino
        {
            return Err(refused(
                "command_surface_publication_runtime_aliases_workspace",
            ));
        }
        if runtime_identity.dev != workspace_identity.dev {
            return Err(refused(
                "command_surface_publication_runtime_filesystem_mismatch",
            ));
        }
        let namespace = Directory::open_or_create(&namespace_path, true).map_err(private_error)?;
        let namespace_identity = DirectoryIdentity::observe(&namespace.held.metadata()?)?;
        if namespace_identity.mode != 0o700
            || namespace_identity.uid != getuid().as_raw()
            || namespace_identity.dev != workspace_identity.dev
        {
            return Err(changed());
        }
        // The namespace's held chain includes the runtime and every ancestor.
        // Sync that complete chain once before moving records; the final
        // assertion also rechecks the separately held runtime identity.
        namespace.sync_with_parents().map_err(private_error)?;
        let result = Self {
            runtime,
            namespace,
            runtime_identity,
            namespace_identity,
            workspace_path,
            workspace_identity,
            key,
            path,
        };
        result.assert_current(input)?;
        Ok(result)
    }
    pub(super) fn assert_current(
        &self,
        input: &NativeWorkspacePackageGuardV1,
    ) -> Result<(), CommandSurfaceError> {
        input.assert_parent_current().map_err(|_| changed())?;
        self.runtime.assert_current().map_err(private_error)?;
        self.namespace.assert_current().map_err(private_error)?;
        if DirectoryIdentity::observe(&self.runtime.held.metadata()?)? != self.runtime_identity
            || DirectoryIdentity::observe(&self.namespace.held.metadata()?)?
                != self.namespace_identity
            || DirectoryIdentity::observe(&input.parent().metadata()?)? != self.workspace_identity
            || path_text(input.root())? != self.workspace_path
        {
            return Err(changed());
        }
        Ok(())
    }
    fn expected(&self, held: &File) -> Result<RootBinding, CommandSurfaceError> {
        let publication = DirectoryIdentity::observe(&held.metadata()?)?;
        if publication.mode != 0o700
            || publication.uid != getuid().as_raw()
            || publication.dev != self.workspace_identity.dev
        {
            return Err(changed());
        }
        let lock = read_leaf(held, "lock", 1)?.ok_or_else(unknown)?;
        if lock.metadata.uid() != getuid().as_raw()
            || lock.metadata.mode() & 0o7777 != 0o600
            || !lock.bytes.is_empty()
        {
            return Err(changed());
        }
        lock.assert_current(held, "lock")?;
        Ok(RootBinding {
            version: 2,
            kind: "OrdinaryPackagePublicationRootBinding".into(),
            workspace_path: self.workspace_path.clone(),
            workspace: self.workspace_identity.clone(),
            runtime_path: path_text(&self.runtime.path)?,
            runtime: self.runtime_identity.clone(),
            namespace: self.namespace_identity.clone(),
            publication_path: path_text(&self.path)?,
            publication,
            lock: Witness::new(&lock.metadata),
            authority_granted: false,
        })
    }
    pub(super) fn observe_binding(
        &self,
        input: &NativeWorkspacePackageGuardV1,
        held: &File,
    ) -> Result<Option<Leaf>, CommandSurfaceError> {
        self.assert_current(input)?;
        let Some(leaf) = read_leaf(held, BINDING_NAME, RECORD_LIMIT)? else {
            return Ok(None);
        };
        if leaf.metadata.uid() != getuid().as_raw()
            || leaf.metadata.mode() & 0o7777 != 0o600
            || serde_json::from_slice::<RootBinding>(&leaf.bytes).map_err(|_| unknown())?
                != self.expected(held)?
        {
            return Err(unknown());
        }
        leaf.assert_current(held, BINDING_NAME)?;
        self.assert_current(input)?;
        Ok(Some(leaf))
    }
    pub(super) fn create_binding(
        &self,
        input: &NativeWorkspacePackageGuardV1,
        directory: &Directory,
    ) -> Result<Leaf, CommandSurfaceError> {
        self.assert_current(input)?;
        directory.assert_current().map_err(private_error)?;
        let bytes = serde_json::to_vec(&self.expected(&directory.held)?)?;
        if bytes.len() as u64 > RECORD_LIMIT {
            return Err(changed());
        }
        directory
            .write_new(BINDING_NAME, &bytes)
            .map_err(private_error)?;
        phase("runtime_binding_durable");
        self.observe_binding(input, &directory.held)?
            .ok_or_else(unknown)
    }
    pub(super) fn target_exists(&self) -> Result<bool, CommandSurfaceError> {
        match openat(
            self.namespace.held.as_fd(),
            self.key.as_str(),
            FLAGS | OFlag::O_DIRECTORY,
            Mode::empty(),
        ) {
            Ok(fd) => {
                let _held = File::from(fd);
                Ok(true)
            }
            Err(nix::errno::Errno::ENOENT) => Ok(false),
            Err(_) => Err(unknown()),
        }
    }
    pub(super) fn migrate(
        &self,
        publication: &mut PackagePublication,
    ) -> Result<(), CommandSurfaceError> {
        publication.check()?;
        self.assert_current(&publication.input)?;
        if self.target_exists()? {
            return Err(refused(
                "command_surface_publication_runtime_migration_conflict_retained",
            ));
        }
        let names = publication.collect()?;
        let mut snapshots = Vec::new();
        // One bounded leaf allocation at a time; migration retains metadata
        // and digests, not an unbounded aggregate copy of the recovery tree.
        for name in names {
            let leaf = publication
                .private_leaf(&name, MAXIMUM)?
                .ok_or_else(unknown)?;
            snapshots.push((name, Witness::new(&leaf.metadata), hash(&leaf.bytes)));
        }
        phase("before_runtime_move");
        publication.check()?;
        self.assert_current(&publication.input)?;
        for (name, metadata, digest) in &snapshots {
            let leaf = publication
                .private_leaf(name, MAXIMUM)?
                .ok_or_else(unknown)?;
            if Witness::new(&leaf.metadata) != *metadata || hash(&leaf.bytes) != *digest {
                return Err(unknown());
            }
        }
        if publication.collect()?.len() != snapshots.len() || self.target_exists()? {
            return Err(unknown());
        }
        renameat2(
            publication.input.parent().as_fd(),
            SIDECAR,
            self.namespace.held.as_fd(),
            self.key.as_str(),
            RenameFlags::RENAME_NOREPLACE,
        )
        .map_err(|_| refused("command_surface_publication_runtime_migration_requires_recovery"))?;
        // Once the atomic move happens, no inverse or speculative deletion is
        // permitted. The retained Flock follows the same inode into runtime.
        publication.path = self.path.clone();
        publication.directory =
            Directory::open_or_create(&self.path, false).map_err(|_| unknown())?;
        let result = (|| {
            publication.check()?;
            for (name, metadata, digest) in &snapshots {
                let leaf = publication
                    .private_leaf(name, MAXIMUM)?
                    .ok_or_else(unknown)?;
                if Witness::new(&leaf.metadata) != *metadata || hash(&leaf.bytes) != *digest {
                    return Err(unknown());
                }
            }
            if publication.collect()?.len() != snapshots.len() {
                return Err(unknown());
            }
            phase("after_runtime_move");
            publication.input.parent().sync_all()?;
            self.namespace.held.sync_all()?;
            publication.check()?;
            phase("runtime_move_directories_durable");
            Ok(())
        })();
        result.map_err(|_: CommandSurfaceError| unknown())
    }
}
