//! A private fixed observer-input fixture, never source or execution authority.
//! The candidate remains unchanged, including its ignored dependencies and R CAS.
use super::super::{PrivateTree, facts, node_assets, node_packages};
use super::{FixtureOwner, Owner};
use serde_json::{Value, json};
use std::{
    collections::{BTreeMap, BTreeSet},
    fs::{self, File, Metadata, OpenOptions},
    os::unix::fs::{MetadataExt, OpenOptionsExt},
    path::{Path, PathBuf},
};

pub(super) struct FixtureGraph {
    tree: PrivateTree,
    provenance: Value,
    copied_inputs: Vec<PinnedInput>,
    copied_directories: BTreeMap<PathBuf, Metadata>,
}
#[derive(Clone)]
struct PinnedInput {
    path: PathBuf,
    metadata: Metadata,
    sha256: String,
}
#[derive(Default)]
struct Selection {
    paths: BTreeMap<String, PathBuf>,
    directories: BTreeMap<PathBuf, Metadata>,
    copy_directories: BTreeSet<String>,
    entries: usize,
    dirs: usize,
}
fn failure(message: &str) -> String {
    super::super::error(message)
}
fn open(path: &Path, directory: bool) -> Result<File, String> {
    OpenOptions::new()
        .read(true)
        .custom_flags(
            nix::libc::O_NOFOLLOW
                | nix::libc::O_NONBLOCK
                | nix::libc::O_CLOEXEC
                | if directory { nix::libc::O_DIRECTORY } else { 0 },
        )
        .open(path)
        .map_err(|_| failure("policy_fixture_input_unsafe"))
}
fn directory(path: &Path) -> Result<Metadata, String> {
    let before =
        fs::symlink_metadata(path).map_err(|_| failure("policy_fixture_directory_unsafe"))?;
    let file = open(path, true)?;
    let held = file
        .metadata()
        .map_err(|_| failure("policy_fixture_directory_unsafe"))?;
    if !before.is_dir() || before.is_symlink() || !super::super::super::same(&before, &held) {
        return Err(failure("policy_fixture_directory_unsafe"));
    }
    Ok(before)
}
fn assert_directories(dirs: &BTreeMap<PathBuf, Metadata>) -> Result<(), String> {
    for (path, before) in dirs {
        if !super::super::super::same(before, &directory(path)?) {
            return Err(failure("policy_fixture_directory_changed"));
        }
    }
    Ok(())
}
fn pin_parents(
    root: &Path,
    path: &Path,
    dirs: &mut BTreeMap<PathBuf, Metadata>,
) -> Result<(), String> {
    let mut parent = path
        .parent()
        .ok_or_else(|| failure("policy_fixture_path_invalid"))?;
    loop {
        if !parent.starts_with(root) {
            return Err(failure("policy_fixture_path_invalid"));
        }
        let metadata = directory(parent)?;
        if let Some(before) = dirs.get(parent) {
            if !super::super::super::same(before, &metadata) {
                return Err(failure("policy_fixture_directory_changed"));
            }
        } else {
            dirs.insert(parent.into(), metadata);
        }
        if parent == root {
            break;
        }
        parent = parent
            .parent()
            .ok_or_else(|| failure("policy_fixture_path_invalid"))?;
    }
    Ok(())
}
fn walk(
    owner: &Owner<'_>,
    root: &Path,
    path: &Path,
    depth: usize,
    all_regular: bool,
    selected: &mut Selection,
) -> Result<(), String> {
    owner.remaining()?;
    selected.dirs += 1;
    if depth > 32 || selected.dirs > 4096 {
        return Err(failure("policy_graph_directory_budget"));
    }
    let before = directory(path)?;
    selected.directories.insert(path.to_owned(), before.clone());
    let relative = path
        .strip_prefix(root)
        .ok()
        .and_then(Path::to_str)
        .filter(|p| facts::relative(p))
        .ok_or_else(|| failure("policy_fixture_path_invalid"))?;
    selected.copy_directories.insert(relative.into());
    let mut children = Vec::new();
    for entry in fs::read_dir(path).map_err(|_| failure("policy_fixture_directory_unsafe"))? {
        owner.remaining()?;
        selected.entries += 1;
        if selected.entries > 200_000 {
            return Err(failure("policy_graph_entry_budget"));
        }
        children.push(entry.map_err(|_| failure("policy_fixture_directory_unsafe"))?);
    }
    children.sort_by_key(|e| e.file_name());
    for entry in children {
        let name = entry
            .file_name()
            .into_string()
            .map_err(|_| failure("policy_fixture_path_invalid"))?;
        if matches!(name.as_str(), "node_modules" | "__pycache__" | ".git") {
            if all_regular {
                return Err(failure("policy_node_package_namespace_invalid"));
            }
            continue;
        }
        let path = entry.path();
        let metadata =
            fs::symlink_metadata(&path).map_err(|_| failure("policy_fixture_input_unsafe"))?;
        if metadata.is_symlink() {
            return Err(failure("policy_fixture_input_unsafe"));
        }
        if metadata.is_dir() {
            walk(owner, root, &path, depth + 1, all_regular, selected)?;
        } else if metadata.is_file() {
            if all_regular
                || matches!(
                    path.extension().and_then(|v| v.to_str()),
                    Some("mjs" | "js" | "json" | "sql" | "py" | "yml" | "yaml")
                )
            {
                let rel = path
                    .strip_prefix(root)
                    .ok()
                    .and_then(Path::to_str)
                    .filter(|p| facts::relative(p))
                    .ok_or_else(|| failure("policy_fixture_path_invalid"))?;
                if selected.paths.insert(rel.into(), path).is_some() || selected.paths.len() > 4096
                {
                    return Err(failure("policy_graph_path_budget"));
                }
            }
        } else {
            return Err(failure("policy_fixture_input_unsafe"));
        }
    }
    if !super::super::super::same(&before, &directory(path)?) {
        return Err(failure("policy_fixture_directory_changed"));
    }
    Ok(())
}
fn read(owner: &mut Owner<'_>, path: &Path) -> Result<(Vec<u8>, PinnedInput), String> {
    owner.remaining()?;
    let before = fs::symlink_metadata(path).map_err(|_| failure("policy_fixture_input_unsafe"))?;
    if !before.is_file()
        || before.is_symlink()
        || before.nlink() != 1
        || before.len() == 0
        || before.len() > 4 * 1024 * 1024
        || before.mode() & 0o7000 != 0
        || before.mode() & 0o400 == 0
    {
        return Err(failure("policy_fixture_input_unsafe"));
    }
    let mut file = open(path, false)?;
    if !super::super::super::same(
        &before,
        &file
            .metadata()
            .map_err(|_| failure("policy_fixture_input_unsafe"))?,
    ) {
        return Err(failure("policy_fixture_input_changed"));
    }
    let mut bytes = vec![0; before.len() as usize];
    let mut offset = 0;
    while offset < bytes.len() {
        let count = owner.read_tool(&mut file, &mut bytes[offset..])?;
        if count == 0 {
            return Err(failure("policy_fixture_input_changed"));
        }
        offset += count;
    }
    if !super::super::super::same(
        &before,
        &file
            .metadata()
            .map_err(|_| failure("policy_fixture_input_changed"))?,
    ) || !super::super::super::same(
        &before,
        &fs::symlink_metadata(path).map_err(|_| failure("policy_fixture_input_changed"))?,
    ) {
        return Err(failure("policy_fixture_input_changed"));
    }
    let sha256 = super::super::digest(&bytes);
    Ok((
        bytes,
        PinnedInput {
            path: path.into(),
            metadata: before,
            sha256,
        },
    ))
}
fn assert_inputs(owner: &mut Owner<'_>, inputs: &[PinnedInput]) -> Result<(), String> {
    // Each read closes its FD; at most this bounded batch is in progress. These
    // value pins describe copying, and cannot construct a SourceGraph owner.
    for batch in inputs.chunks(64) {
        owner.remaining()?;
        for before in batch {
            let (_, after) = read(owner, &before.path)?;
            if !super::super::super::same(&before.metadata, &after.metadata)
                || before.sha256 != after.sha256
            {
                return Err(failure("policy_fixture_input_changed"));
            }
        }
    }
    Ok(())
}
fn metadata_value(metadata: &Metadata) -> Value {
    json!({"dev":metadata.dev(),"ino":metadata.ino(),"mode":metadata.mode(),"uid":metadata.uid(),"gid":metadata.gid(),"nlink":metadata.nlink(),"bytes":metadata.len(),"mtime":[metadata.mtime(),metadata.mtime_nsec()],"ctime":[metadata.ctime(),metadata.ctime_nsec()]})
}
impl FixtureGraph {
    pub(super) fn capture(helper: &FixtureOwner) -> Result<Self, String> {
        let source_root = helper.root();
        let mut owner = helper.owner();
        let mut selected = Selection::default();
        selected
            .directories
            .insert(source_root.into(), directory(source_root)?);
        for name in facts::fixture_roots() {
            walk(
                &owner,
                source_root,
                &source_root.join(name),
                0,
                false,
                &mut selected,
            )?;
        }
        // The original differential profile has exactly these fixed assets and
        // an empty fixture R CAS. Public R content in the candidate is neither
        // copied nor deleted, and is never qualified by this observer fixture.
        for (name, _) in node_assets::fixture_files() {
            selected
                .paths
                .insert((*name).into(), source_root.join(name));
        }
        for name in [
            "package.json",
            "package-lock.json",
            "migration/fixtures/legacy-differential-reference-v1.tar.gz",
            "rust/oracle/build-package-retired-sources.v1.tar.gz",
            "rust/oracle/research-retired-sources.v1.tar.gz",
        ] {
            selected.paths.insert(name.into(), source_root.join(name));
        }
        let (lock, _) = read(&mut owner, &source_root.join("package-lock.json"))?;
        node_packages::validate_fixture_lock(
            &serde_json::from_slice(&lock)
                .map_err(|_| failure("policy_node_package_lock_invalid"))?,
        )?;
        let mut dependency_roots = Vec::new();
        for root in [
            source_root.to_owned(),
            source_root
                .parent()
                .ok_or_else(|| failure("policy_fixture_dependency_parent_invalid"))?
                .to_owned(),
        ] {
            match fs::symlink_metadata(root.join("node_modules")) {
                Ok(metadata) => {
                    if !metadata.is_dir() || metadata.is_symlink() {
                        return Err(failure("policy_fixture_dependency_unsafe"));
                    }
                    dependency_roots.push(root);
                }
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
                Err(_) => return Err(failure("policy_fixture_dependency_unsafe")),
            }
        }
        if dependency_roots.is_empty() {
            return Err(failure("policy_fixture_dependencies_absent"));
        }
        let mut original_inputs = Vec::new();
        let mut dependency_values = BTreeMap::new();
        let mut primary = None;
        for root in &dependency_roots {
            let mut package_selection = Selection::default();
            package_selection.directories.insert(
                root.join("node_modules"),
                directory(&root.join("node_modules"))?,
            );
            for name in node_packages::ROOTS {
                walk(
                    &owner,
                    root,
                    &root.join(name),
                    0,
                    true,
                    &mut package_selection,
                )?;
            }
            node_packages::validate_paths(&package_selection.paths.keys().cloned().collect())?;
            let mut values = BTreeMap::new();
            for (name, expected) in node_packages::fixture_files() {
                let (_, input) = read(&mut owner, &root.join(name))?;
                if input.sha256 != *expected {
                    return Err(failure("policy_node_package_bytes_invalid"));
                }
                values.insert(
                    (*name).to_owned(),
                    (input.sha256.clone(), input.metadata.mode()),
                );
                original_inputs.push(input);
            }
            if primary.is_some() && values != dependency_values {
                return Err(failure("policy_fixture_dependencies_conflict"));
            }
            if primary.is_none() {
                primary = Some(root.clone());
                dependency_values = values;
                selected.paths.extend(package_selection.paths);
                selected
                    .copy_directories
                    .extend(package_selection.copy_directories);
            }
            selected.directories.extend(package_selection.directories);
        }
        let mut tree = PrivateTree::new()?;
        for directory in &selected.copy_directories {
            tree.directory(&format!("sources/{directory}"))?;
        }
        tree.directory("sources/runtime-images/r-scientific/source-cas")?;
        let mut provenance_files = Vec::new();
        let mut copied_inputs = Vec::new();
        let mut copied_bytes = 0_u64;
        for (name, source_path) in &selected.paths {
            let root = if name.starts_with("node_modules/") {
                primary.as_ref().unwrap().as_path()
            } else {
                source_root
            };
            pin_parents(root, source_path, &mut selected.directories)?;
            let (bytes, input) = read(&mut owner, source_path)?;
            if let Some((_, expected)) = node_assets::fixture_files()
                .iter()
                .find(|(path, _)| *path == name)
                && input.sha256 != *expected
            {
                return Err(failure("policy_node_asset_bytes_invalid"));
            }
            if let Some((sha, mode)) = dependency_values.get(name)
                && (&input.sha256 != sha || input.metadata.mode() != *mode)
            {
                return Err(failure("policy_fixture_dependencies_changed"));
            }
            copied_bytes += bytes.len() as u64;
            tree.fixture_source(name, &bytes, input.metadata.mode() & 0o777)?;
            let (copy_bytes, copy) = read(&mut owner, &tree.sources().join(name))?;
            if copy_bytes != bytes
                || copy.metadata.nlink() != 1
                || copy.metadata.mode() != input.metadata.mode()
            {
                return Err(failure("policy_fixture_copy_changed"));
            }
            provenance_files.push(json!({"relative":name,"originalPath":input.path,"sha256":input.sha256,"originalMetadata":metadata_value(&input.metadata),"copyMetadata":metadata_value(&copy.metadata)}));
            original_inputs.push(input);
            copied_inputs.push(copy);
        }
        assert_inputs(&mut owner, &original_inputs)?;
        assert_inputs(&mut owner, &copied_inputs)?;
        assert_directories(&selected.directories)?;
        let provenance_hash = super::super::digest(&serde_json::to_vec(&provenance_files).unwrap());
        let provenance = json!({"version":1,"kind":"PrivateFixedPolicyObserverFixture","sourceRoot":source_root,"dependencyRoots":dependency_roots,"primaryDependencyRoot":primary,"fileCount":provenance_files.len(),"fileBytes":copied_bytes,"provenanceHash":provenance_hash,"files":provenance_files,"originalInputsBeforeAfterVerified":true,"copyBeforeAfterVerified":true,"emptyRCasIsFixtureOnly":true,"publicRContentQualification":false,"sourceAuthority":false,"executionAuthority":false});
        let mut copied_directories = BTreeMap::new();
        for input in &copied_inputs {
            pin_parents(&tree.sources(), &input.path, &mut copied_directories)?;
        }
        for path in selected
            .copy_directories
            .iter()
            .map(|p| tree.sources().join(p))
            .chain([tree
                .sources()
                .join("runtime-images/r-scientific/source-cas")])
        {
            copied_directories.insert(path.clone(), directory(&path)?);
        }
        Ok(Self {
            tree,
            provenance,
            copied_inputs,
            copied_directories,
        })
    }
    pub(super) fn root(&self) -> PathBuf {
        self.tree.sources()
    }
    pub(super) fn assert_current(&self, owner: &mut Owner<'_>) -> Result<(), String> {
        assert_inputs(owner, &self.copied_inputs)?;
        assert_directories(&self.copied_directories)
    }
    pub(super) fn report(&self) -> Value {
        let mut report = self.provenance.clone();
        report.as_object_mut().unwrap().remove("files");
        report
    }
}
