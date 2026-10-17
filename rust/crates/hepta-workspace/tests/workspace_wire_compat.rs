//! Frozen pure outputs from original blob 137f658cc403e76a417dd2e9eac33425de2bbfcd.
use hepta_workspace::{
    TreeEntryKindV1, TreeEntryV1, TreeInventoryV1, workspace_wire_compat_v1 as legacy,
};
use serde_json::Value;

fn current(nodes: &Value) -> TreeInventoryV1 {
    let nodes: Vec<legacy::TreeNodeV1> = serde_json::from_value(nodes.clone()).unwrap();
    let entries = nodes
        .into_iter()
        .map(|node| TreeEntryV1 {
            relative_path: node.path,
            kind: match node.kind {
                legacy::NodeKindV1::Directory => TreeEntryKindV1::Directory,
                legacy::NodeKindV1::File => TreeEntryKindV1::File,
            },
            mode: node.mode,
            uid: 1234,
            gid: 5678,
            link_count: 1,
            byte_count: node.bytes,
            content_hash: node.content_hash,
        })
        .collect::<Vec<_>>();
    TreeInventoryV1 {
        version: 1,
        total_file_bytes: entries.iter().map(|v| v.byte_count).sum(),
        entries,
        inventory_hash: format!("sha256:{}", "e".repeat(64)).parse().unwrap(),
    }
}

fn fixture() -> (TreeInventoryV1, TreeInventoryV1, Value) {
    let value: Value =
        serde_json::from_str(include_str!("fixtures/workspace-wire-compat-v1.json")).unwrap();
    (
        current(&value["workspaceInput"]["before"]),
        current(&value["workspaceInput"]["after"]),
        value["workspace"].clone(),
    )
}

#[test]
fn original_inventory_modified_added_removed_and_prepared_hashes_match() {
    let (mut before, mut after, expected) = fixture();
    before.entries.reverse();
    after.entries.reverse();
    assert_eq!(
        serde_json::to_value(legacy::from_current_inventory(&before).unwrap()).unwrap(),
        expected["before"]
    );
    assert_eq!(
        serde_json::to_value(legacy::from_current_inventory(&after).unwrap()).unwrap(),
        expected["after"]
    );
    let prepared = legacy::from_current_inventories(&before, &after).unwrap();
    assert_eq!(
        serde_json::to_value(prepared).unwrap(),
        expected["prepared"]
    );
}

#[test]
fn legacy_metadata_omission_is_explicit_and_bytes_modes_remain_bound() {
    let (before, _, _) = fixture();
    let mut after = before.clone();
    after.entries[0].uid += 1;
    after.entries[0].gid += 1;
    after.entries[0].link_count += 1;
    let result = legacy::from_current_inventories(&before, &after).unwrap();
    assert!(result.mutation_manifest.entries.is_empty());
    assert_eq!(result.source_inventory_hash, result.result_inventory_hash);
    after.entries[0].mode ^= 0o040;
    let changed = legacy::from_current_inventories(&before, &after).unwrap();
    assert_eq!(changed.mutation_manifest.entries.len(), 1);
    assert_ne!(changed.source_inventory_hash, changed.result_inventory_hash);
    assert_ne!(changed.prepared_result_hash, result.prepared_result_hash);
}

#[test]
fn ambiguous_or_escaping_current_paths_are_not_silently_aliased() {
    let (before, _, _) = fixture();
    for path in ["paper\\main.tex", "../escape", "/absolute", "bad\0name"] {
        let mut input = before.clone();
        input.entries[0].relative_path = path.into();
        assert!(legacy::from_current_inventory(&input).is_err(), "{path:?}");
    }
    let mut duplicate = before.clone();
    duplicate.entries.push(before.entries[0].clone());
    assert!(legacy::from_current_inventory(&duplicate).is_err());
}
