//! Private complete inputs for a single AST proof. No process-global cache.
//! Retained parent descriptors avoid one open descriptor per source module.
use super::*;
use nix::{
    fcntl::{OFlag, openat},
    sys::stat::Mode,
};
use std::{
    collections::{BTreeMap, BTreeSet},
    ffi::OsString,
    fs::{self, File},
    os::{fd::AsRawFd, unix::fs::FileExt},
    path::Component,
};
const MAX_FILES: usize = 20_000;
const MAX_DIRECTORIES: usize = 4096;
const MAX_PATH_COMPONENTS: usize = 256;
const MAX_BYTES: u64 = 512 * 1024 * 1024;
// Separate preconnection retention for fixed native-store transactions. The
// public proof keeps its existing low-descriptor currentness implementation.
#[path = "proof_inputs/retained.rs"]
#[allow(dead_code)] // The owning admitted transaction remains a separate step.
mod retained;
pub(crate) use retained::RetainedWriterStaticInputsV1;
fn changed() -> crate::sqlite_mutation_coordinator::SqliteMutationCoordinatorError {
    error("autonomous_research_online_writer_source_changed_during_scan")
}
fn invalid() -> crate::sqlite_mutation_coordinator::SqliteMutationCoordinatorError {
    error("autonomous_research_online_writer_complete_inputs_unsafe")
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
fn bounded_path(path: &Path) -> Result<()> {
    if path.components().take(MAX_PATH_COMPONENTS + 1).count() > MAX_PATH_COMPONENTS {
        return Err(invalid());
    }
    Ok(())
}
fn normalize(path: &Path) -> Result<PathBuf> {
    let path = if path.is_absolute() {
        path.to_owned()
    } else {
        std::env::current_dir().map_err(|_| invalid())?.join(path)
    };
    // Check before parent recursion or any open; even a non-existent caller
    // path must not consume an unbounded stack while finding its ancestors.
    bounded_path(&path)?;
    let mut value = PathBuf::from("/");
    for part in path.components() {
        match part {
            Component::RootDir | Component::CurDir => {}
            Component::ParentDir => {
                value.pop();
            }
            Component::Normal(name) => value.push(name),
            _ => return Err(invalid()),
        }
    }
    Ok(value)
}
struct DirectoryInput {
    path: PathBuf,
    file: File,
    identity: Metadata,
    entries: Option<Vec<OsString>>,
}
impl DirectoryInput {
    fn current(&self) -> Result<()> {
        let named = fs::symlink_metadata(&self.path).map_err(|_| changed())?;
        if named.is_symlink()
            || !same_directory(&self.identity, &named)
            || !same_directory(
                &self.identity,
                &self.file.metadata().map_err(|_| changed())?,
            )
        {
            return Err(changed());
        }
        if let Some(expected) = &self.entries
            && &names(&self.file)? != expected
        {
            return Err(changed());
        }
        Ok(())
    }
}
fn names(directory: &File) -> Result<Vec<OsString>> {
    let mut entries = Vec::new();
    for entry in
        fs::read_dir(format!("/proc/self/fd/{}", directory.as_raw_fd())).map_err(|_| invalid())?
    {
        if entries.len() >= MAX_FILES {
            return Err(invalid());
        }
        entries.push(entry.map_err(|_| invalid())?.file_name());
    }
    entries.sort();
    Ok(entries)
}
struct FileInput {
    source: Source,
    uid: u32,
    gid: u32,
    parent: PathBuf,
    name: OsString,
}
fn read_file(path: &Path, file: &File) -> Result<(Source, u32, u32)> {
    let before = file.metadata().map_err(|_| invalid())?;
    if !before.is_file() || before.len() > 16 * 1024 * 1024 {
        return Err(invalid());
    }
    let mut hash = Sha256::new();
    let mut offset = 0;
    let mut buffer = [0u8; 64 * 1024];
    while offset < before.len() {
        let remaining = usize::try_from((before.len() - offset).min(buffer.len() as u64))
            .map_err(|_| invalid())?;
        file.read_exact_at(&mut buffer[..remaining], offset)
            .map_err(|_| changed())?;
        hash.update(&buffer[..remaining]);
        offset += remaining as u64;
    }
    let after = file.metadata().map_err(|_| changed())?;
    if identity(&before) != identity(&after)
        || before.uid() != after.uid()
        || before.gid() != after.gid()
    {
        return Err(changed());
    }
    Ok((
        Source {
            path: path.to_owned(),
            identity: identity(&after),
            hash: format!("sha256:{}", hex::encode(hash.finalize())),
        },
        after.uid(),
        after.gid(),
    ))
}
pub(super) struct CompleteStaticInputs {
    root: PathBuf,
    directories: BTreeMap<PathBuf, DirectoryInput>,
    files: BTreeMap<PathBuf, FileInput>,
    absent: BTreeSet<PathBuf>,
    bytes: u64,
}
impl CompleteStaticInputs {
    pub(super) fn capture(root: &Path, manifest: &Value, config: &Value) -> Result<Self> {
        let root = normalize(root)?;
        let file = File::open("/").map_err(|_| invalid())?;
        let identity = file.metadata().map_err(|_| invalid())?;
        let base = DirectoryInput {
            path: PathBuf::from("/"),
            file,
            identity,
            entries: None,
        };
        let mut value = Self {
            root: root.clone(),
            directories: BTreeMap::from([(base.path.clone(), base)]),
            files: BTreeMap::new(),
            absent: BTreeSet::new(),
            bytes: 0,
        };
        if !value.directory(&root)? {
            return Err(invalid());
        }
        for relative in strings(&config["SCAN_ROOTS"]) {
            let path = value.inside(relative)?;
            value.tree(&path, 0)?;
        }
        let migration = value.inside(config["SQL_MIGRATION_ROOT"].as_str().ok_or_else(invalid)?)?;
        // The exact direct migration namespace is observed, including excluded
        // entries; migration contents are held even when currently non-mutating.
        if value.directory(&migration)? {
            let entries = value.namespace(&migration)?;
            for name in entries {
                let path = migration.join(name);
                if path.extension().is_some_and(|x| x == "sql") {
                    value.file(&path)?;
                }
            }
        }
        for relative in strings(&config["PROVENANCE_ONLY_SOURCES"]) {
            let path = value.inside(relative)?;
            value.file(&path)?;
        }
        for operation in manifest["operations"].as_array().ok_or_else(invalid)? {
            let path = value.inside(operation["sourceFile"].as_str().ok_or_else(invalid)?)?;
            value.file(&path)?;
        }
        value.assert_current()?;
        Ok(value)
    }
    fn inside(&self, relative: &str) -> Result<PathBuf> {
        let relative = Path::new(relative);
        if relative.is_absolute()
            || relative
                .components()
                .any(|c| !matches!(c, Component::Normal(_)))
        {
            return Err(invalid());
        }
        let path = self.root.join(relative);
        bounded_path(&path)?;
        Ok(path)
    }
    fn directory(&mut self, path: &Path) -> Result<bool> {
        bounded_path(path)?;
        if self.directories.contains_key(path) {
            return Ok(true);
        }
        if self.directories.len() >= MAX_DIRECTORIES {
            return Err(invalid());
        }
        let parent = path.parent().ok_or_else(invalid)?;
        if !self.directory(parent)? {
            self.absent.insert(path.to_owned());
            return Ok(false);
        }
        // Recursing into an uncached ancestor chain can consume descriptors.
        // Enforce the budget again after that chain has been opened.
        if self.directories.len() >= MAX_DIRECTORIES {
            return Err(invalid());
        }
        let owner = &self.directories[parent];
        let name = path.file_name().ok_or_else(invalid)?;
        let opened = openat(
            &owner.file,
            Path::new(name),
            OFlag::O_RDONLY
                | OFlag::O_DIRECTORY
                | OFlag::O_NOFOLLOW
                | OFlag::O_CLOEXEC
                | OFlag::O_NONBLOCK,
            Mode::empty(),
        );
        match opened {
            Ok(file) => {
                let file = File::from(file);
                let identity = file.metadata().map_err(|_| invalid())?;
                self.directories.insert(
                    path.to_owned(),
                    DirectoryInput {
                        path: path.to_owned(),
                        file,
                        identity,
                        entries: None,
                    },
                );
                Ok(true)
            }
            Err(nix::errno::Errno::ENOENT) => {
                self.absent.insert(path.to_owned());
                Ok(false)
            }
            Err(_) => Err(invalid()),
        }
    }
    fn namespace(&mut self, path: &Path) -> Result<Vec<OsString>> {
        let directory = self.directories.get_mut(path).ok_or_else(invalid)?;
        let entries = names(&directory.file)?;
        if directory
            .entries
            .as_ref()
            .is_some_and(|old| old != &entries)
        {
            return Err(changed());
        }
        directory.entries = Some(entries.clone());
        Ok(entries)
    }
    fn tree(&mut self, path: &Path, depth: usize) -> Result<()> {
        if depth > 128 {
            return Err(invalid());
        }
        if !self.directory(path)? {
            return Ok(());
        }
        for name in self.namespace(path)? {
            let child = path.join(&name);
            bounded_path(&child)?;
            let directory = &self.directories[path];
            let file = File::from(
                openat(
                    &directory.file,
                    Path::new(&name),
                    OFlag::O_RDONLY | OFlag::O_NOFOLLOW | OFlag::O_CLOEXEC | OFlag::O_NONBLOCK,
                    Mode::empty(),
                )
                .map_err(|_| invalid())?,
            );
            let metadata = file.metadata().map_err(|_| invalid())?;
            if metadata.is_dir() {
                drop(file);
                self.tree(&child, depth + 1)?;
            } else if metadata.is_file() {
                self.insert_file(&child, file)?;
            } else {
                return Err(invalid());
            }
        }
        Ok(())
    }
    fn file(&mut self, path: &Path) -> Result<()> {
        if self.files.contains_key(path) {
            return Ok(());
        }
        let parent = path.parent().ok_or_else(invalid)?;
        if !self.directory(parent)? {
            self.absent.insert(path.to_owned());
            return Ok(());
        }
        let directory = &self.directories[parent];
        let name = path.file_name().ok_or_else(invalid)?;
        match openat(
            &directory.file,
            Path::new(name),
            OFlag::O_RDONLY | OFlag::O_NOFOLLOW | OFlag::O_CLOEXEC | OFlag::O_NONBLOCK,
            Mode::empty(),
        ) {
            Ok(file) => self.insert_file(path, File::from(file)),
            Err(nix::errno::Errno::ENOENT) => {
                self.absent.insert(path.to_owned());
                Ok(())
            }
            Err(_) => Err(invalid()),
        }
    }
    fn insert_file(&mut self, path: &Path, file: File) -> Result<()> {
        if self.files.contains_key(path) {
            return Ok(());
        }
        if self.files.len() >= MAX_FILES {
            return Err(invalid());
        }
        let (source, uid, gid) = read_file(path, &file)?;
        self.bytes = self
            .bytes
            .checked_add(source.identity.4)
            .ok_or_else(invalid)?;
        if self.bytes > MAX_BYTES {
            return Err(invalid());
        }
        let input = FileInput {
            source,
            uid,
            gid,
            parent: path.parent().ok_or_else(invalid)?.to_owned(),
            name: path.file_name().ok_or_else(invalid)?.to_owned(),
        };
        self.files.insert(path.to_owned(), input);
        Ok(())
    }
    fn paths(&self, directory: &Path, recursive: bool, extension: &str) -> Result<Vec<PathBuf>> {
        let normalized = normalize(directory)?;
        let mut paths = self
            .files
            .keys()
            .filter_map(|path| {
                let relative = path.strip_prefix(&normalized).ok()?;
                if (!recursive && path.parent() != Some(normalized.as_path()))
                    || !path.extension().is_some_and(|value| value == extension)
                {
                    return None;
                }
                Some(directory.join(relative))
            })
            .collect::<Vec<_>>();
        paths.sort_by(|a, b| {
            a.to_string_lossy()
                .encode_utf16()
                .cmp(b.to_string_lossy().encode_utf16())
        });
        Ok(paths)
    }
    pub(super) fn module_paths(&self, directory: &Path) -> Result<Vec<PathBuf>> {
        self.paths(directory, true, "mjs")
    }
    pub(super) fn migration_paths(&self, directory: &Path) -> Result<Vec<PathBuf>> {
        self.paths(directory, false, "sql")
    }
    pub(super) fn assert_source(&self, source: &Source) -> Result<()> {
        let path = normalize(&source.path)?;
        let held = self.files.get(&path).ok_or_else(changed)?;
        if source.identity != held.source.identity || source.hash != held.source.hash {
            return Err(changed());
        }
        Ok(())
    }
    pub(super) fn assert_current(&self) -> Result<()> {
        for directory in self.directories.values() {
            directory.current()?;
        }
        for path in &self.absent {
            if !matches!(fs::symlink_metadata(path),Err(e) if e.kind()==std::io::ErrorKind::NotFound)
            {
                return Err(changed());
            }
        }
        for input in self.files.values() {
            let parent = &self.directories[&input.parent];
            let file = File::from(
                openat(
                    &parent.file,
                    Path::new(&input.name),
                    OFlag::O_RDONLY | OFlag::O_NOFOLLOW | OFlag::O_CLOEXEC | OFlag::O_NONBLOCK,
                    Mode::empty(),
                )
                .map_err(|_| changed())?,
            );
            let (current, uid, gid) = read_file(&input.source.path, &file)?;
            if current.identity != input.source.identity
                || current.hash != input.source.hash
                || uid != input.uid
                || gid != input.gid
            {
                return Err(changed());
            }
            let named = fs::symlink_metadata(&input.source.path).map_err(|_| changed())?;
            if named.is_symlink()
                || identity(&named) != current.identity
                || named.uid() != uid
                || named.gid() != gid
            {
                return Err(changed());
            }
        }
        for directory in self.directories.values() {
            directory.current()?;
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicU64, Ordering};
    static NEXT: AtomicU64 = AtomicU64::new(0);
    struct Tree(PathBuf);
    impl Tree {
        fn new() -> Self {
            let root = std::env::temp_dir().join(format!(
                "hepta-static-held-inputs-{}-{}",
                std::process::id(),
                NEXT.fetch_add(1, Ordering::Relaxed)
            ));
            fs::create_dir(&root).unwrap();
            fs::create_dir(root.join("scan")).unwrap();
            fs::create_dir(root.join("sql")).unwrap();
            fs::write(root.join("scan/inert.mjs"), "export const inert = 1;").unwrap();
            Self(root)
        }
        fn capture(&self) -> Result<CompleteStaticInputs> {
            CompleteStaticInputs::capture(
                &self.0,
                &json!({"operations": []}),
                &json!({
                    "SCAN_ROOTS": ["scan"], "SQL_MIGRATION_ROOT": "sql", "PROVENANCE_ONLY_SOURCES": []
                }),
            )
        }
    }
    impl Drop for Tree {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }
    #[test]
    fn ast_read_must_match_the_captured_full_input_before_final_currentness() {
        let tree = Tree::new();
        let inputs = tree.capture().unwrap();
        let path = tree.0.join("scan/inert.mjs");
        let (_, original) = read_source(&path).unwrap();
        inputs.assert_source(&original).unwrap();
        fs::write(&path, "export const inert = 2;").unwrap();
        let (_, modified) = read_source(&path).unwrap();
        assert_ne!(original.hash, modified.hash);
        assert!(inputs.assert_source(&modified).is_err());
        assert!(inputs.assert_current().is_err());
    }
    #[test]
    fn initial_scan_rejects_oversize_files_and_non_regular_ignored_entries() {
        let tree = Tree::new();
        let path = tree.0.join("scan/oversized.bin");
        File::create(&path)
            .unwrap()
            .set_len(16 * 1024 * 1024 + 1)
            .unwrap();
        assert!(tree.capture().is_err());
        fs::remove_file(&path).unwrap();
        let fifo = tree.0.join("scan/ignored.fifo");
        nix::unistd::mkfifo(&fifo, Mode::S_IRUSR | Mode::S_IWUSR).unwrap();
        assert!(tree.capture().is_err());
        fs::remove_file(fifo).unwrap();
        let alias = tree.0.join("scan/ignored.alias");
        std::os::unix::fs::symlink(tree.0.join("scan/inert.mjs"), alias).unwrap();
        assert!(tree.capture().is_err());
    }
    #[test]
    fn migration_namespace_and_declared_sources_are_part_of_the_private_input_set() {
        let tree = Tree::new();
        fs::create_dir(tree.0.join("declared")).unwrap();
        fs::write(tree.0.join("declared/source.mjs"), "export const a=1;").unwrap();
        let inputs = CompleteStaticInputs::capture(
            &tree.0,
            &json!({"operations":[{"sourceFile":"declared/source.mjs"}]}),
            &json!({
                "SCAN_ROOTS":["scan"],"SQL_MIGRATION_ROOT":"sql","PROVENANCE_ONLY_SOURCES":[]
            }),
        )
        .unwrap();
        fs::write(tree.0.join("declared/source.mjs"), "export const a=2;").unwrap();
        assert!(inputs.assert_current().is_err());
        let inputs = tree.capture().unwrap();
        fs::create_dir(tree.0.join("sql/new-directory")).unwrap();
        assert!(inputs.assert_current().is_err());
    }
    #[test]
    fn absent_scan_roots_cannot_appear_and_file_hardlink_changes_are_detected() {
        let tree = Tree::new();
        let inputs = CompleteStaticInputs::capture(&tree.0, &json!({"operations":[]}), &json!({
            "SCAN_ROOTS":["scan", "absent"],"SQL_MIGRATION_ROOT":"sql","PROVENANCE_ONLY_SOURCES":[]
        })).unwrap();
        fs::create_dir(tree.0.join("absent")).unwrap();
        assert!(inputs.assert_current().is_err());
        let inputs = tree.capture().unwrap();
        // The added link is outside every scanned namespace: file metadata must catch it.
        fs::hard_link(tree.0.join("scan/inert.mjs"), tree.0.join("outside-link")).unwrap();
        assert!(inputs.assert_current().is_err());
    }
    #[test]
    fn initial_ast_enumeration_cannot_omit_transiently_hidden_modules_or_migrations() {
        let tree = Tree::new();
        let rogue = tree.0.join("scan/rogue.mjs");
        let migration = tree.0.join("sql/001_rogue.sql");
        fs::write(
            &rogue,
            "export function write(db){db.exec('DELETE FROM records');}",
        )
        .unwrap();
        fs::write(&migration, "DELETE FROM records;").unwrap();
        let inputs = tree.capture().unwrap();
        let hidden_module = tree.0.join("hidden-module");
        let hidden_sql = tree.0.join("hidden-sql");
        fs::rename(&rogue, &hidden_module).unwrap();
        fs::rename(&migration, &hidden_sql).unwrap();
        // The first AST uses these exact lists, so disappearance cannot hide
        // a captured input even when the names later return before final checks.
        assert!(
            inputs
                .module_paths(&tree.0.join("scan"))
                .unwrap()
                .contains(&rogue)
        );
        assert!(
            inputs
                .migration_paths(&tree.0.join("sql"))
                .unwrap()
                .contains(&migration)
        );
        assert!(read_source(&rogue).is_err());
        assert!(read_source(&migration).is_err());
        fs::rename(hidden_module, &rogue).unwrap();
        fs::rename(hidden_sql, &migration).unwrap();
        // Restoring names cannot remove the entries from the captured AST input.
        assert!(
            inputs
                .module_paths(&tree.0.join("scan"))
                .unwrap()
                .contains(&rogue)
        );
        assert!(
            inputs
                .migration_paths(&tree.0.join("sql"))
                .unwrap()
                .contains(&migration)
        );
        let raw_root = tree.0.join("scan/..");
        let paths = inputs.module_paths(&raw_root.join("scan")).unwrap();
        assert!(
            paths
                .iter()
                .all(|path| path.strip_prefix(&raw_root).is_ok())
        );
    }
    #[test]
    fn real_ast_gate_cannot_mint_complete_report_by_hiding_a_captured_writer() {
        for (relative, body) in [
            (
                "paper-adapters/transient/rogue.mjs",
                "export function rogue(db){db.exec('DELETE FROM records');}",
            ),
            ("store/migrations/001_rogue.sql", "DELETE FROM records;"),
        ] {
            let tree = Tree::new();
            let configuration = config().unwrap();
            for relative in strings(&configuration["PROVENANCE_ONLY_SOURCES"]) {
                let path = tree.0.join(relative);
                fs::create_dir_all(path.parent().unwrap()).unwrap();
                fs::write(path, "// fixture provenance\n").unwrap();
            }
            let roles = crate::sqlite_mutation_coordinator::DATABASE_ROLES;
            let mut roles = roles.to_vec();
            roles.sort();
            let protocol = "external-linearizable-reserve-apply-finalize-v1";
            let mut operations = Vec::new();
            let mut writers = Vec::new();
            for (index, role) in roles.iter().enumerate() {
                let operation = format!("{role}.testWriter.mutate.v1");
                let relative = format!("paper-adapters/automation/input-proof-fixture-{index}.mjs");
                let entry = format!("mutateRole{index}");
                operations.push(json!({"operationId":operation,"databaseRole":role,"sourceFile":relative,
                    "entrypoint":entry,"mutationClass":"business-dml","protocolStatus":"coordinator-integrated-reserve-apply-finalize-v1","coordinatorIntegrated":true}));
                writers.push(json!({"writerId":format!("writer:{role}:fixture:v1"),"databaseRoles":[role],"operationIds":[operation],
                    "implementationHash":format!("sha256:{}","a".repeat(64)),"protocol":protocol}));
                fs::write(tree.0.join(relative),format!("export function {entry}(db) {{return db.executeMutation({{databaseRole:{},operationId:{},mutate:(tx)=>tx.run('statement:one')}});}}",json!(role),json!(operation))).unwrap();
            }
            let manifest = json!({"version":1,"kind":"AutonomousResearchOnlineWriterCoverageManifest","manifestId":"complete-input-fixture",
                "protocol":protocol,"requiredDatabaseRoles":roles,"writers":writers,"operations":operations,
                "coverage":{"requiredRoleCount":10,"coveredRoleCount":10,"coveredDatabaseRoles":roles,"percent":100}});
            let baseline = inspect(&tree.0, &manifest, None).unwrap().0;
            assert_eq!(
                baseline["status"],
                "autonomous_research_online_writer_static_coverage_complete"
            );
            let path = tree.0.join(relative);
            fs::create_dir_all(path.parent().unwrap()).unwrap();
            fs::write(&path, body).unwrap();
            let inputs = CompleteStaticInputs::capture(&tree.0, &manifest, &configuration).unwrap();
            let hidden = tree.0.join("temporarily-hidden-source-directory");
            let directory = path.parent().unwrap();
            fs::rename(directory, &hidden).unwrap();
            // The actual original live enumeration now omits the writer.
            assert_eq!(
                inspect(&tree.0, &manifest, None).unwrap().0["status"],
                "autonomous_research_online_writer_static_coverage_complete"
            );
            // The verified gate must read the captured entry and refuse its absence.
            assert!(inspect(&tree.0, &manifest, Some(&inputs)).is_err());
            fs::rename(hidden, directory).unwrap();
            // Directory rename/restoration leaves every file's bytes and metadata
            // unchanged. All old end-boundary checks alone can therefore pass.
            inputs.assert_current().unwrap();
            assert_eq!(
                inspect(&tree.0, &manifest, None).unwrap().0["status"],
                "autonomous_research_online_writer_static_coverage_blocked"
            );
        }
    }
    #[test]
    fn oversized_absolute_and_declared_parent_chains_fail_before_recursing() {
        let path = PathBuf::from("/").join("x/".repeat(100_000));
        assert_eq!(
            normalize(&path).err().unwrap().code,
            "autonomous_research_online_writer_complete_inputs_unsafe"
        );
        assert!(
            CompleteStaticInputs::capture(
                &path,
                &json!({"operations":[]}),
                &json!({
                    "SCAN_ROOTS":[],"SQL_MIGRATION_ROOT":"sql","PROVENANCE_ONLY_SOURCES":[]
                })
            )
            .is_err()
        );
        let tree = Tree::new();
        let mut inputs = tree.capture().unwrap();
        assert!(inputs.directory(&path).is_err());
        assert!(
            inputs
                .inside(&"nested/".repeat(MAX_PATH_COMPONENTS + 1))
                .is_err()
        );
        let maximum = PathBuf::from("/").join("x/".repeat(MAX_PATH_COMPONENTS - 1));
        assert!(bounded_path(&maximum).is_ok());
        assert!(bounded_path(&maximum.join("one-more")).is_err());
    }
}
