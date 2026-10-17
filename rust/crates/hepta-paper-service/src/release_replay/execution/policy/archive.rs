//! Archive members are emitted as bounded bytes, never extracted by tar into paths.
use super::{
    Owner, Tool, digest, error,
    facts::{Matrix, relative},
    measured_profile::SourceLimits,
    private_tree::PrivateTree,
    process,
};
use serde_json::{Value, json};
use std::{
    collections::BTreeMap,
    fs::{self, File, OpenOptions},
    os::unix::fs::{MetadataExt, OpenOptionsExt},
    path::{Component, Path, PathBuf},
};
struct Directory {
    path: PathBuf,
    file: File,
    metadata: fs::Metadata,
}
pub(super) struct PinnedArchive {
    path: PathBuf,
    file: File,
    metadata: fs::Metadata,
    bytes: Vec<u8>,
    sha256: String,
    parents: Vec<Directory>,
}
impl PinnedArchive {
    pub(super) fn capture(
        owner: &mut Owner<'_>,
        path: &Path,
        sha256: &str,
        maximum_archive_bytes: u64,
    ) -> Result<Self, String> {
        owner.remaining()?;
        if !path.is_absolute()
            || path
                .components()
                .any(|v| !matches!(v, Component::RootDir | Component::Normal(_)))
            || fs::canonicalize(path).map_err(|_| error("policy_archive_unsafe"))? != path
        {
            return Err(error("policy_archive_unsafe"));
        }
        let mut parents = Vec::new();
        let mut cursor = PathBuf::new();
        for c in path
            .parent()
            .ok_or_else(|| error("policy_archive_unsafe"))?
            .components()
        {
            cursor.push(c);
            let file = OpenOptions::new()
                .read(true)
                .custom_flags(nix::libc::O_DIRECTORY | nix::libc::O_NOFOLLOW | nix::libc::O_CLOEXEC)
                .open(&cursor)
                .map_err(|_| error("policy_archive_parent_unsafe"))?;
            let metadata = file
                .metadata()
                .map_err(|_| error("policy_archive_parent_unsafe"))?;
            parents.push(Directory {
                path: cursor.clone(),
                file,
                metadata,
            });
        }
        let mut file = OpenOptions::new()
            .read(true)
            .custom_flags(nix::libc::O_NOFOLLOW | nix::libc::O_NONBLOCK | nix::libc::O_CLOEXEC)
            .open(path)
            .map_err(|_| error("policy_archive_unsafe"))?;
        let metadata = file
            .metadata()
            .map_err(|_| error("policy_archive_unsafe"))?;
        if !metadata.is_file()
            || metadata.nlink() != 1
            || metadata.len() == 0
            || metadata.len() > maximum_archive_bytes
        {
            return Err(error("policy_archive_unsafe"));
        }
        let mut bytes = vec![0; metadata.len() as usize];
        let mut offset = 0;
        while offset < bytes.len() {
            let n = owner.read_tool(&mut file, &mut bytes[offset..])?;
            if n == 0 {
                return Err(error("policy_archive_short_read"));
            }
            offset += n;
        }
        if digest(&bytes) != sha256 {
            return Err(error("policy_archive_hash_mismatch"));
        }
        let archive = Self {
            path: path.to_owned(),
            file,
            metadata,
            bytes,
            sha256: sha256.into(),
            parents,
        };
        archive.identity()?;
        Ok(archive)
    }
    fn identity(&self) -> Result<(), String> {
        for d in &self.parents {
            let named = fs::symlink_metadata(&d.path)
                .map_err(|_| error("policy_archive_parent_changed"))?;
            let held = d
                .file
                .metadata()
                .map_err(|_| error("policy_archive_parent_changed"))?;
            for m in [&named, &held] {
                if !m.is_dir()
                    || m.is_symlink()
                    || m.dev() != d.metadata.dev()
                    || m.ino() != d.metadata.ino()
                    || m.mode() != d.metadata.mode()
                    || m.uid() != d.metadata.uid()
                    || m.gid() != d.metadata.gid()
                {
                    return Err(error("policy_archive_parent_changed"));
                }
            }
        }
        for m in [
            fs::symlink_metadata(&self.path).map_err(|_| error("policy_archive_changed"))?,
            self.file
                .metadata()
                .map_err(|_| error("policy_archive_changed"))?,
        ] {
            if !super::super::same(&m, &self.metadata) || !m.is_file() || m.is_symlink() {
                return Err(error("policy_archive_changed"));
            }
        }
        Ok(())
    }
    pub(super) fn assert_current(&mut self, owner: &mut Owner<'_>) -> Result<(), String> {
        self.identity()?;
        if owner.hash_file(&mut self.file, self.metadata.len())? != self.sha256 {
            return Err(error("policy_archive_changed"));
        }
        self.identity()
    }
    pub(super) fn report(&self) -> Value {
        json!({"path":self.path,"sha256":self.sha256,"bytes":self.bytes.len(),"device":self.metadata.dev().to_string(),"inode":self.metadata.ino().to_string(),"mode":self.metadata.mode(),"heldFdAndNamedNamespaceStable":true,"filesystemImmutableClaimed":false})
    }
    pub(super) fn materialize(
        &self,
        owner: &Owner<'_>,
        tar: &Tool,
        matrix: &Matrix,
        tree: &mut PrivateTree,
        source_limits: SourceLimits,
    ) -> Result<Value, String> {
        self.identity()?;
        let (listing, list_receipt) = process(
            owner,
            tar,
            [
                "--list",
                "--verbose",
                "--numeric-owner",
                "--gzip",
                "--file",
                "-",
                "--quoting-style=escape",
            ]
            .into_iter()
            .map(Into::into)
            .collect(),
            Some(self.bytes.clone()),
            owner.environment.clone(),
            8 * 1024 * 1024,
            None,
        )?;
        let text =
            std::str::from_utf8(&listing).map_err(|_| error("policy_archive_inventory_invalid"))?;
        let mut members: BTreeMap<String, (char, u64)> = BTreeMap::new();
        let mut count = 0;
        for line in text.lines() {
            owner.remaining()?;
            count += 1;
            if count > 200_000 {
                return Err(error("policy_archive_inventory_budget"));
            }
            let fields: Vec<_> = line.split_whitespace().collect();
            let entry_kind = fields
                .first()
                .and_then(|v| v.chars().next())
                .ok_or_else(|| error("policy_archive_inventory_invalid"))?;
            if fields.len() != 6 && !(entry_kind == 'l' && fields.len() == 8 && fields[6] == "->") {
                return Err(error("policy_archive_inventory_invalid"));
            }
            let name = fields[5].trim_end_matches('/');
            if !relative(name) {
                return Err(error("policy_archive_member_path_invalid"));
            }
            let kind = fields[0]
                .chars()
                .next()
                .ok_or_else(|| error("policy_archive_inventory_invalid"))?;
            let size = fields[2]
                .parse::<u64>()
                .map_err(|_| error("policy_archive_inventory_invalid"))?;
            if members.insert(name.to_owned(), (kind, size)).is_some() {
                return Err(error("policy_archive_duplicate_member"));
            }
        }
        let mut total = 0_u64;
        for row in &matrix.entries {
            owner.remaining()?;
            let (kind, bytes) = members
                .get(&row.source.path)
                .ok_or_else(|| error("policy_archive_source_missing"))?;
            if *kind != '-'
                || *bytes > source_limits.file(&row.id, &row.source.path, &row.source.sha256)
            {
                return Err(error("policy_archive_source_unsafe"));
            }
            total = total
                .checked_add(*bytes)
                .filter(|v| *v <= source_limits.selected())
                .ok_or_else(|| error("policy_archive_source_byte_budget"))?;
            let parts: Vec<_> = row.source.path.split('/').collect();
            for i in 1..parts.len() {
                if members
                    .get(&parts[..i].join("/"))
                    .is_some_and(|(k, _)| *k != 'd')
                {
                    return Err(error("policy_archive_parent_unsafe"));
                }
            }
        }
        let mut args: Vec<_> = ["--extract", "--to-stdout", "--gzip", "--file", "-", "--"]
            .into_iter()
            .map(Into::into)
            .collect();
        args.extend(matrix.entries.iter().map(|r| r.source.path.clone().into()));
        // GNU tar emits selected files in archive order, not argv order. Match
        // inventory order independently before dividing the bounded byte stream.
        let order = text
            .lines()
            .filter_map(|line| line.split_whitespace().nth(5))
            .map(|v| v.trim_end_matches('/'))
            .filter(|name| matrix.entries.iter().any(|r| r.source.path == *name))
            .collect::<Vec<_>>();
        if order.len() != matrix.entries.len() {
            return Err(error("policy_archive_member_order_invalid"));
        }
        let (extracted, extract_receipt) = process(
            owner,
            tar,
            args,
            Some(self.bytes.clone()),
            owner.environment.clone(),
            total.max(1),
            None,
        )?;
        if extracted.len() as u64 != total {
            return Err(error("policy_archive_extracted_length_mismatch"));
        }
        let mut offset = 0;
        for name in order {
            owner.remaining()?;
            let row = matrix
                .entries
                .iter()
                .find(|r| r.source.path == name)
                .ok_or_else(|| error("policy_archive_member_order_invalid"))?;
            let size = members[name].1 as usize;
            let bytes = extracted
                .get(offset..offset + size)
                .ok_or_else(|| error("policy_archive_extracted_length_mismatch"))?;
            if digest(bytes) != format!("sha256:{}", row.source.sha256) {
                return Err(format!(
                    "{}:{name}",
                    error("policy_archive_source_hash_mismatch")
                ));
            }
            tree.source(name, bytes)?;
            offset += size;
        }
        self.identity()?;
        Ok(
            json!({"kind":"NativeSelectedLegacyMatrixSourceMaterialization","memberCount":matrix.entries.len(),"sourceBytes":total,"completeArchiveInventoryEntryCount":count,"tarWritesPaths":false,"fullArchiveRestored":false,"restoredDatabaseClaimed":false,"listProcess":list_receipt,"extractProcess":extract_receipt}),
        )
    }
}
