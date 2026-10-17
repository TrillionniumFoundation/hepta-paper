//! Pinned bytes and namespace identities for the fixed Node observer inputs.
//! This verifies the selected explicit module list, never arbitrary dynamic imports.
use super::{Owner, error, same};
use serde_json::{Value, json};
use std::{
    fs::{self, File, OpenOptions},
    os::unix::fs::{MetadataExt, OpenOptionsExt},
    path::{Path, PathBuf},
};

pub(super) const SOURCE_INPUTS: &[&str] = &[
    "migration/retirement/production-state-compat.mjs",
    "migration/legacy-reference-fixture.mjs",
    "workflow-kernel/record-hash.mjs",
    "paper-adapters/referee-revise/decision-routing.mjs",
    "paper-domain/repair/command-contract.mjs",
    "migration/fixtures/legacy-differential-reference-v1.json",
    "migration/fixtures/legacy-differential-reference-v1.tar.gz",
];
struct Directory {
    path: PathBuf,
    file: File,
    metadata: fs::Metadata,
    selected_namespace: bool,
}
struct Input {
    relative: String,
    path: PathBuf,
    file: File,
    metadata: fs::Metadata,
    sha256: String,
    directories: Vec<Directory>,
}
pub(super) struct SourceGraph {
    inputs: Vec<Input>,
    read_bytes: u64,
}
fn directory_same(a: &fs::Metadata, b: &fs::Metadata, exact: bool) -> bool {
    a.is_dir()
        && b.is_dir()
        && !a.is_symlink()
        && !b.is_symlink()
        && if exact {
            same(a, b)
        } else {
            a.dev() == b.dev()
                && a.ino() == b.ino()
                && a.mode() == b.mode()
                && a.uid() == b.uid()
                && a.gid() == b.gid()
        }
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
        .map_err(|_| error("source_graph_unsafe"))
}
impl Input {
    fn assert_identity(&self) -> Result<(), String> {
        for directory in &self.directories {
            let named =
                fs::symlink_metadata(&directory.path).map_err(|_| error("source_graph_changed"))?;
            let held = directory
                .file
                .metadata()
                .map_err(|_| error("source_graph_changed"))?;
            if !directory_same(&directory.metadata, &named, directory.selected_namespace)
                || !directory_same(&directory.metadata, &held, directory.selected_namespace)
            {
                return Err(error("source_graph_changed"));
            }
        }
        let named = fs::symlink_metadata(&self.path).map_err(|_| error("source_graph_changed"))?;
        let held = self
            .file
            .metadata()
            .map_err(|_| error("source_graph_changed"))?;
        if !named.is_file()
            || named.is_symlink()
            || !same(&self.metadata, &named)
            || !same(&self.metadata, &held)
        {
            return Err(error("source_graph_changed"));
        }
        Ok(())
    }
}
impl SourceGraph {
    pub(super) fn capture(owner: &mut Owner<'_>) -> Result<Self, String> {
        Self::capture_paths(
            owner,
            SOURCE_INPUTS.iter().map(|v| (*v).to_owned()).collect(),
        )
    }
    pub(super) fn capture_paths(owner: &mut Owner<'_>, paths: Vec<String>) -> Result<Self, String> {
        if paths.is_empty() || paths.len() > 4096 {
            return Err(error("source_graph_path_budget_exceeded"));
        }
        let root = owner.request.source.workspace_root.clone();
        let mut inputs = Vec::new();
        let before_bytes = owner.read_bytes;
        let mut seen = std::collections::BTreeSet::new();
        for relative in paths {
            if relative.is_empty()
                || !seen.insert(relative.clone())
                || Path::new(&relative)
                    .components()
                    .any(|v| !matches!(v, std::path::Component::Normal(_)))
            {
                return Err(error("source_graph_path_invalid"));
            }
            owner.remaining()?;
            let path = root.join(&relative);
            if path.components().count() > 64
                || fs::canonicalize(&path).map_err(|_| error("source_graph_unsafe"))? != path
            {
                return Err(error("source_graph_unsafe"));
            }
            let mut directories = Vec::new();
            let mut selected = PathBuf::new();
            for component in path
                .parent()
                .ok_or_else(|| error("source_graph_unsafe"))?
                .components()
            {
                selected.push(component);
                let file = open(&selected, true)?;
                let metadata = file.metadata().map_err(|_| error("source_graph_unsafe"))?;
                if !metadata.is_dir() {
                    return Err(error("source_graph_unsafe"));
                }
                directories.push(Directory {
                    path: selected.clone(),
                    file,
                    metadata,
                    selected_namespace: selected.starts_with(&root),
                });
            }
            let file = open(&path, false)?;
            let metadata = file.metadata().map_err(|_| error("source_graph_unsafe"))?;
            if !metadata.is_file()
                || metadata.nlink() != 1
                || metadata.len() == 0
                || metadata.len() > 4 * 1024 * 1024
            {
                return Err(error("source_graph_unsafe"));
            }
            let mut input = Input {
                relative,
                path,
                file,
                metadata,
                sha256: String::new(),
                directories,
            };
            input.assert_identity()?;
            input.sha256 = owner.hash_file(&mut input.file, input.metadata.len())?;
            input.assert_identity()?;
            inputs.push(input);
        }
        let graph = Self {
            inputs,
            read_bytes: owner.read_bytes - before_bytes,
        };
        for input in &graph.inputs {
            input.assert_identity()?;
        }
        Ok(graph)
    }
    pub(super) fn assert_current(&mut self, owner: &mut Owner<'_>) -> Result<(), String> {
        let before_bytes = owner.read_bytes;
        for input in &mut self.inputs {
            owner.remaining()?;
            input.assert_identity()?;
            if owner.hash_file(&mut input.file, input.metadata.len())? != input.sha256 {
                return Err(error("source_graph_changed"));
            }
            input.assert_identity()?;
        }
        for input in &self.inputs {
            input.assert_identity()?;
        }
        self.read_bytes += owner.read_bytes - before_bytes;
        Ok(())
    }
    pub(super) fn read_input(
        &mut self,
        owner: &mut Owner<'_>,
        relative: &str,
    ) -> Result<Vec<u8>, String> {
        let input = self
            .inputs
            .iter_mut()
            .find(|v| v.relative == relative)
            .ok_or_else(|| error("source_graph_input_missing"))?;
        input.assert_identity()?;
        use std::io::Seek;
        input
            .file
            .rewind()
            .map_err(|_| error("source_graph_changed"))?;
        let mut bytes = vec![0; input.metadata.len() as usize];
        let mut offset = 0;
        let before = owner.read_bytes;
        while offset < bytes.len() {
            let read = owner.read_tool(&mut input.file, &mut bytes[offset..])?;
            if read == 0 {
                return Err(error("source_graph_changed"));
            }
            offset += read;
        }
        self.read_bytes += owner.read_bytes - before;
        if super::digest(&bytes) != input.sha256 {
            return Err(error("source_graph_changed"));
        }
        input.assert_identity()?;
        Ok(bytes)
    }
    pub(super) fn paths(&self) -> impl Iterator<Item = &str> {
        self.inputs.iter().map(|input| input.relative.as_str())
    }
    pub(super) fn read_bytes(&self) -> u64 {
        self.read_bytes
    }
    pub(super) fn report(&self) -> Value {
        json!({"scope":"fixed_explicit_node_module_and_archive_input_list","namespaceAndHeldFdStabilityVerified":true,
            "arbitraryDynamicImportGraphClaimed":false,"observedReadBytes":self.read_bytes,
            "inputs":self.inputs.iter().map(|input|json!({"path":input.relative,"sha256":input.sha256,"bytes":input.metadata.len(),"device":input.metadata.dev().to_string(),"inode":input.metadata.ino().to_string(),"mode":input.metadata.mode(),"mtime":input.metadata.mtime(),"mtimeNsec":input.metadata.mtime_nsec(),"ctime":input.metadata.ctime(),"ctimeNsec":input.metadata.ctime_nsec()})).collect::<Vec<_>>()})
    }
}
