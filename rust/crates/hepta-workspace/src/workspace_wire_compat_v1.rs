//! Pure diagnostic projection of the 2026-08-30 workspace wire.
//!
//! Source blob: `137f658cc403e76a417dd2e9eac33425de2bbfcd`.
//! This namespace retains inventory/mutation/prepared hashes, not the old filesystem owner,
//! path writer, materializer or permissive mutation policy. It projects caller-supplied current
//! inventories, performs no I/O and grants no authority. Current policy validation, safe owner
//! and publication checks remain separate mandatory responsibilities of an actual executor.

use crate::{WorkspaceError, hash_serialized};
use hepta_codex_protocol::Sha256Digest;
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, BTreeSet};

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum NodeKindV1 {
    Directory,
    File,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TreeNodeV1 {
    pub path: String,
    pub kind: NodeKindV1,
    pub mode: u32,
    pub bytes: u64,
    pub content_hash: Option<Sha256Digest>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TreeInventoryV1 {
    pub version: u16,
    pub nodes: Vec<TreeNodeV1>,
    pub root_hash: Sha256Digest,
}

impl TreeInventoryV1 {
    fn new(nodes: BTreeMap<String, TreeNodeV1>) -> Result<Self, WorkspaceError> {
        if nodes.len() > crate::MAXIMUM_TREE_ENTRIES {
            return Err(WorkspaceError::TreeEntryLimitExceeded);
        }
        let nodes = nodes.into_values().collect::<Vec<_>>();
        let root_hash = hash_serialized("HeptaWorkspaceInventoryV1", &nodes)?;
        Ok(Self {
            version: 1,
            nodes,
            root_hash,
        })
    }

    fn node_map(&self) -> BTreeMap<&str, &TreeNodeV1> {
        self.nodes
            .iter()
            .map(|node| (node.path.as_str(), node))
            .collect()
    }
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum MutationKindV1 {
    Added,
    Modified,
    Removed,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MutationEntryV1 {
    pub path: String,
    pub kind: MutationKindV1,
    pub before: Option<TreeNodeV1>,
    pub after: Option<TreeNodeV1>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MutationManifestV1 {
    pub version: u16,
    pub entries: Vec<MutationEntryV1>,
    pub manifest_hash: Sha256Digest,
}

impl MutationManifestV1 {
    fn between(before: &TreeInventoryV1, after: &TreeInventoryV1) -> Result<Self, WorkspaceError> {
        let left = before.node_map();
        let right = after.node_map();
        let paths = left
            .keys()
            .chain(right.keys())
            .copied()
            .collect::<BTreeSet<_>>();
        let entries = paths
            .into_iter()
            .filter_map(|path| match (left.get(path), right.get(path)) {
                (None, Some(after)) => Some(MutationEntryV1 {
                    path: path.to_owned(),
                    kind: MutationKindV1::Added,
                    before: None,
                    after: Some((*after).clone()),
                }),
                (Some(before), None) => Some(MutationEntryV1 {
                    path: path.to_owned(),
                    kind: MutationKindV1::Removed,
                    before: Some((*before).clone()),
                    after: None,
                }),
                (Some(before), Some(after)) if before != after => Some(MutationEntryV1 {
                    path: path.to_owned(),
                    kind: MutationKindV1::Modified,
                    before: Some((*before).clone()),
                    after: Some((*after).clone()),
                }),
                _ => None,
            })
            .collect::<Vec<_>>();
        let manifest_hash = hash_serialized("HeptaWorkspaceMutationManifestV1", &entries)?;
        Ok(Self {
            version: 1,
            entries,
            manifest_hash,
        })
    }
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PreparedWorkspaceResultV1 {
    pub version: u16,
    pub source_inventory_hash: Sha256Digest,
    pub result_inventory_hash: Sha256Digest,
    pub mutation_manifest: MutationManifestV1,
    pub prepared_result_hash: Sha256Digest,
}

impl PreparedWorkspaceResultV1 {
    fn new(
        source_inventory_hash: Sha256Digest,
        result_inventory_hash: Sha256Digest,
        mutation_manifest: MutationManifestV1,
    ) -> Result<Self, WorkspaceError> {
        #[derive(Serialize)]
        #[serde(rename_all = "camelCase")]
        struct HashView<'a> {
            version: u16,
            source_inventory_hash: &'a Sha256Digest,
            result_inventory_hash: &'a Sha256Digest,
            mutation_manifest: &'a MutationManifestV1,
        }
        let prepared_result_hash = hash_serialized(
            "HeptaPreparedWorkspaceResultV1",
            &HashView {
                version: 1,
                source_inventory_hash: &source_inventory_hash,
                result_inventory_hash: &result_inventory_hash,
                mutation_manifest: &mutation_manifest,
            },
        )?;
        Ok(Self {
            version: 1,
            source_inventory_hash,
            result_inventory_hash,
            mutation_manifest,
            prepared_result_hash,
        })
    }
}

/// Rebuild the old inventory wire from current typed observation fields.
/// Owner/group/link-count facts and current hashes have no fields in this older wire.
/// Backslash paths are refused because the older filesystem walker aliased them to `/`.
pub fn from_current_inventory(
    current: &crate::TreeInventoryV1,
) -> Result<TreeInventoryV1, WorkspaceError> {
    if current.version != 1 || current.entries.len() > crate::MAXIMUM_TREE_ENTRIES {
        return Err(WorkspaceError::TreeEntryLimitExceeded);
    }
    let mut nodes = BTreeMap::new();
    for entry in &current.entries {
        if entry.relative_path.contains('\\') || entry.relative_path.contains('\0') {
            return Err(WorkspaceError::PathEscapesRoot);
        }
        crate::validate_relative(std::path::Path::new(&entry.relative_path))?;
        let node = TreeNodeV1 {
            path: entry.relative_path.clone(),
            kind: match entry.kind {
                crate::TreeEntryKindV1::Directory => NodeKindV1::Directory,
                crate::TreeEntryKindV1::File => NodeKindV1::File,
            },
            mode: entry.mode,
            bytes: entry.byte_count,
            content_hash: entry.content_hash.clone(),
        };
        if nodes.insert(entry.relative_path.clone(), node).is_some() {
            return Err(WorkspaceError::InventoryChanged);
        }
    }
    TreeInventoryV1::new(nodes)
}

/// Rebuild the old diagnostic prepared wire from before/after observations.
/// The result records a difference; it does not mean any mutation was authorized,
/// performed, safely published, independently qualified, or durably committed.
pub fn from_current_inventories(
    before: &crate::TreeInventoryV1,
    after: &crate::TreeInventoryV1,
) -> Result<PreparedWorkspaceResultV1, WorkspaceError> {
    let before = from_current_inventory(before)?;
    let after = from_current_inventory(after)?;
    let mutation = MutationManifestV1::between(&before, &after)?;
    PreparedWorkspaceResultV1::new(before.root_hash, after.root_hash, mutation)
}
