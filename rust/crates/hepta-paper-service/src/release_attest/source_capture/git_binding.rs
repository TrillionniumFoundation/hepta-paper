//! Bind captured bytes and modes to the selected tree, independently of Git's
//! stat cache, ignore flags, filters, core.worktree, and replace mechanisms.
use super::*;
mod gitlink_reference;
pub(crate) use gitlink_reference::{GITLINK_REFERENCE_PROFILE, GitlinkReference};

#[derive(Clone, Eq, PartialEq)]
pub(crate) struct TreeEntry {
    pub mode: u32,
    pub oid: String,
}

/// Shared fixed-query boundary. Implementations must use their existing bounded
/// process owner, tool pin, deadline and byte budget; no caller command reaches
/// this adapter. No JSON-deserializable evidence capability is returned.
pub(crate) trait GitTreeObservationV1 {
    fn workspace_root(&self) -> &Path;
    fn expected_commit(&self) -> &str;
    fn expected_tree(&self) -> &str;
    fn query(&self, root: &Path, args: &[&str], stdin: Option<Vec<u8>>) -> Result<Vec<u8>>;
    fn consume(&mut self, bytes: usize) -> Result<()>;
}

pub(crate) fn assert_object_integrity(owner: &impl GitTreeObservationV1) -> Result<()> {
    if !hex(owner.expected_commit(), 40) {
        return Err(error("subject_invalid"));
    }
    owner
        .query(
            owner.workspace_root(),
            &[
                "fsck",
                "--strict",
                "--no-reflogs",
                "--no-dangling",
                "--no-progress",
                owner.expected_commit(),
            ],
            None,
        )
        .map(|_| ())
        .map_err(|failure| {
            if failure.0.ends_with("cancelled") || failure.0.ends_with("deadline_exceeded") {
                failure
            } else {
                error("tree_object_integrity_failed")
            }
        })
}

fn path(value: &[u8]) -> Result<String> {
    let name = std::str::from_utf8(value).map_err(|_| error("tree_path_invalid"))?;
    if name.is_empty()
        || name
            .split('/')
            .any(|v| v.is_empty() || v == "." || v == "..")
        || name.contains('\\')
        || Path::new(name)
            .components()
            .any(|v| !matches!(v, Component::Normal(_)))
    {
        return Err(error("tree_path_invalid"));
    }
    Ok(name.into())
}
fn inventory(bytes: &[u8], tree: bool) -> Result<BTreeMap<String, TreeEntry>> {
    if bytes.last() != Some(&0) {
        return Err(error("tree_inventory_invalid"));
    }
    let mut rows = BTreeMap::new();
    for line in bytes.split(|v| *v == 0).filter(|v| !v.is_empty()) {
        if rows.len() >= MAX_ENTRIES / 4 {
            return Err(error("tree_inventory_too_large"));
        }
        let tab = line
            .iter()
            .position(|v| *v == b'\t')
            .ok_or_else(|| error("tree_inventory_invalid"))?;
        let name = path(&line[tab + 1..])?;
        let header =
            std::str::from_utf8(&line[..tab]).map_err(|_| error("tree_inventory_invalid"))?;
        let parts: Vec<_> = header.split(' ').collect();
        if parts.len() != 3 {
            return Err(error("tree_inventory_invalid"));
        }
        let mode = u32::from_str_radix(parts[0], 8).map_err(|_| error("tree_inventory_invalid"))?;
        if !matches!(mode, 0o100644 | 0o100755 | 0o120000 | 0o160000) {
            return Err(error("tree_mode_invalid"));
        }
        let oid = if tree {
            if parts[1] != if mode == 0o160000 { "commit" } else { "blob" } {
                return Err(error("tree_type_invalid"));
            }
            parts[2]
        } else {
            if parts[2] != "0" {
                return Err(error("index_conflict"));
            }
            parts[1]
        };
        if !hex(oid, 40)
            || rows
                .insert(
                    name,
                    TreeEntry {
                        mode,
                        oid: oid.into(),
                    },
                )
                .is_some()
        {
            return Err(error("tree_inventory_invalid"));
        }
    }
    if rows.is_empty() {
        return Err(error("tree_inventory_empty"));
    }
    Ok(rows)
}
pub(crate) fn capture_tree(
    owner: &impl GitTreeObservationV1,
) -> Result<BTreeMap<String, TreeEntry>> {
    if !hex(owner.expected_commit(), 40) || !hex(owner.expected_tree(), 40) {
        return Err(error("subject_invalid"));
    }
    let root = owner.workspace_root();
    let config = owner.query(
        root,
        &["config", "--no-includes", "--name-only", "--list"],
        None,
    )?;
    if std::str::from_utf8(&config)
        .map_err(|_| error("git_configuration_invalid"))?
        .lines()
        .any(|v| {
            let key = v.to_ascii_lowercase();
            key == "extensions.partialclone"
                || key.ends_with(".promisor")
                || key.starts_with("fsck.")
                || key.starts_with("include.")
                || key.starts_with("includeif.")
        })
    {
        return Err(error("git_configuration_can_bypass_integrity_or_fetch"));
    }

    let top = owner.query(root, &["rev-parse", "--show-toplevel"], None)?;
    if std::str::from_utf8(&top)
        .map_err(|_| error("worktree_invalid"))?
        .trim_end()
        != root.to_str().ok_or_else(|| error("worktree_invalid"))?
    {
        return Err(error("worktree_redirection"));
    }
    if !owner
        .query(
            root,
            &["for-each-ref", "--format=%(refname)", "refs/replace/"],
            None,
        )?
        .is_empty()
    {
        return Err(error("replace_refs_forbidden"));
    }
    for (name, expected) in [
        ("HEAD^{commit}", owner.expected_commit()),
        ("HEAD^{tree}", owner.expected_tree()),
    ] {
        let result = owner.query(root, &["rev-parse", "--verify", name], None)?;
        if std::str::from_utf8(&result)
            .map_err(|_| error("subject_invalid"))?
            .trim()
            != expected
        {
            return Err(error("subject_mismatch"));
        }
    }
    let flags = owner.query(root, &["ls-files", "-v", "-z"], None)?;
    if flags.last() != Some(&0)
        || flags
            .split(|v| *v == 0)
            .filter(|v| !v.is_empty())
            .any(|v| v.len() < 3 || &v[..2] != b"H ")
    {
        return Err(error("index_ignore_flags_forbidden"));
    }
    let tree = inventory(
        &owner.query(
            root,
            &["ls-tree", "-r", "--full-tree", "-z", owner.expected_tree()],
            None,
        )?,
        true,
    )?;
    let index = inventory(
        &owner.query(root, &["ls-files", "--stage", "-z"], None)?,
        false,
    )?;
    if tree != index {
        return Err(error("tree_index_mismatch"));
    }
    let flag_names = flags
        .split(|v| *v == 0)
        .filter(|v| !v.is_empty())
        .map(|v| path(&v[2..]))
        .collect::<Result<std::collections::BTreeSet<_>>>()?;
    if flag_names.len() != tree.len() || flag_names.iter().any(|v| !tree.contains_key(v)) {
        return Err(error("tree_index_mismatch"));
    }
    Ok(tree)
}
pub(crate) fn assert_blob_binding(
    owner: &mut impl GitTreeObservationV1,
    selected_tree: &BTreeMap<String, TreeEntry>,
    actual_payloads: &BTreeMap<String, (u32, Option<String>)>,
) -> Result<()> {
    if capture_tree(owner)? != *selected_tree || actual_payloads.len() != selected_tree.len() {
        return Err(error("tree_binding_changed"));
    }
    for (name, entry) in selected_tree {
        let actual = actual_payloads
            .get(name)
            .ok_or_else(|| error("tracked_source_missing"))?;
        if actual.0 != entry.mode || (entry.mode == 0o160000 && actual.1.is_some()) {
            return Err(error("tracked_mode_mismatch"));
        }
    }
    let mut oids = BTreeMap::new();
    for (name, entry) in selected_tree {
        if entry.mode == 0o160000 {
            let reference = GitlinkReference::capture(owner.workspace_root(), name, entry)?;
            if reference.is_absent() {
                return Err(error("gitlink_missing"));
            }
            reference.assert_current()?;
        } else {
            oids.insert(entry.oid.clone(), None::<String>);
        }
    }
    let input = oids
        .keys()
        .map(|v| format!("{v}\n"))
        .collect::<String>()
        .into_bytes();
    let sizes = owner.query(
        owner.workspace_root(),
        &[
            "cat-file",
            "--batch-check=%(objectname) %(objecttype) %(objectsize)",
        ],
        Some(input),
    )?;
    let rows = std::str::from_utf8(&sizes)
        .map_err(|_| error("blob_contract_invalid"))?
        .lines()
        .map(|line| {
            let parts: Vec<_> = line.split(' ').collect();
            if parts.len() != 3 || !oids.contains_key(parts[0]) || parts[1] != "blob" {
                return Err(error("blob_contract_invalid"));
            }
            let size: u64 = parts[2]
                .parse()
                .map_err(|_| error("blob_contract_invalid"))?;
            if size > MAX_FILE_BYTES {
                return Err(error("file_budget_exceeded"));
            }
            Ok((parts[0].to_owned(), size))
        })
        .collect::<Result<Vec<_>>>()?;
    if rows.len() != oids.len() || rows.iter().zip(oids.keys()).any(|((a, _), b)| a != b) {
        return Err(error("blob_contract_invalid"));
    }
    let mut offset = 0;
    while offset < rows.len() {
        let mut end = offset;
        let mut size = 0u64;
        while end < rows.len() && size + rows[end].1 + 128 < 48 * 1024 * 1024 {
            size += rows[end].1 + 128;
            end += 1;
        }
        if end == offset {
            return Err(error("blob_budget_exceeded"));
        }
        let input = rows[offset..end]
            .iter()
            .map(|(oid, _)| format!("{oid}\n"))
            .collect::<String>()
            .into_bytes();
        let bytes = owner.query(
            owner.workspace_root(),
            &["cat-file", "--batch"],
            Some(input),
        )?;
        owner.consume(bytes.len())?;
        let mut cursor = 0;
        for (oid, expected_size) in &rows[offset..end] {
            let newline = bytes[cursor..]
                .iter()
                .position(|v| *v == b'\n')
                .ok_or_else(|| error("blob_contract_invalid"))?
                + cursor;
            let expected_header = format!("{oid} blob {expected_size}");
            if bytes.get(cursor..newline) != Some(expected_header.as_bytes()) {
                return Err(error("blob_contract_invalid"));
            }
            let start = newline + 1;
            let finish = start
                .checked_add(*expected_size as usize)
                .ok_or_else(|| error("blob_contract_invalid"))?;
            let body = bytes
                .get(start..finish)
                .ok_or_else(|| error("blob_contract_invalid"))?;
            if bytes.get(finish) != Some(&b'\n') {
                return Err(error("blob_contract_invalid"));
            }
            oids.insert(oid.clone(), Some(hash(body)));
            cursor = finish + 1;
        }
        if cursor != bytes.len() {
            return Err(error("blob_contract_invalid"));
        }
        offset = end;
    }
    for (name, entry) in selected_tree {
        if entry.mode != 0o160000 && actual_payloads[name].1 != oids[&entry.oid] {
            return Err(error("tracked_bytes_mismatch"));
        }
    }
    Ok(())
}
