//! Byte-compatible inspection of immutable, hydrated submodule closures.
use super::{Result, error, files, hash, ordered::Ordered, sha};
use serde::Serialize;
use serde_json::{Value, json};
use std::{
    fs::{self, Metadata, OpenOptions},
    io::Read,
    os::{
        fd::AsRawFd,
        unix::{
            ffi::OsStrExt,
            fs::{MetadataExt, OpenOptionsExt},
        },
    },
    path::Path,
    process::Command,
};
const SUBMODULES: &[(&str, &str)] = &[
    ("core", "core"),
    (
        "rScientificSourceCas",
        "runtime-images/r-scientific/source-cas",
    ),
];
const CLOSURE: &str = "deployment-closure/TOOL-CLOSURE.json";
fn io_error(_: std::io::Error) -> super::OperationalStatusError {
    error("code_provenance_sealed_closure_read_failed")
}
fn git(root: &Path, operation: &str, args: &[&str]) -> Result<String> {
    let output = Command::new("/usr/bin/git")
        .args([
            "-c",
            "core.fsmonitor=false",
            "-c",
            "core.hooksPath=/dev/null",
            "-c",
            "core.attributesFile=/dev/null",
            "-c",
        ])
        .arg(format!("safe.directory={}", root.display()))
        .arg("-C")
        .arg(root)
        .args(args)
        .env_clear()
        .envs([
            ("PATH", "/usr/bin:/bin"),
            ("HOME", "/nonexistent"),
            ("XDG_CONFIG_HOME", "/nonexistent"),
            ("LANG", "C"),
            ("LC_ALL", "C"),
            ("GIT_CONFIG_NOSYSTEM", "1"),
            ("GIT_CONFIG_GLOBAL", "/dev/null"),
            ("GIT_NO_REPLACE_OBJECTS", "1"),
            ("GIT_OPTIONAL_LOCKS", "0"),
            ("GIT_TERMINAL_PROMPT", "0"),
            ("GIT_LFS_SKIP_SMUDGE", "1"),
        ])
        .output()
        .map_err(|_| {
            error(&format!(
                "code_provenance_sealed_submodule_git_failed:{operation}"
            ))
        })?;
    if !output.status.success() || output.stdout.len() > 16 * 1024 * 1024 {
        return Err(error(&format!(
            "code_provenance_sealed_submodule_git_failed:{operation}"
        )));
    }
    String::from_utf8(output.stdout).map_err(|_| {
        error(&format!(
            "code_provenance_sealed_submodule_git_failed:{operation}"
        ))
    })
}
fn object(value: &str) -> bool {
    value.len() == 40
        && value
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}
fn git_object(root: &Path, expression: &str, operation: &str) -> Result<String> {
    let value = git(root, operation, &["rev-parse", "--verify", expression])?
        .trim()
        .to_owned();
    if !object(&value) {
        return Err(error(&format!(
            "code_provenance_sealed_submodule_object_invalid:{operation}"
        )));
    }
    Ok(value)
}
fn read_closure(root: &Path) -> Result<Option<Ordered>> {
    let path = root.join(CLOSURE);
    let identity = match fs::symlink_metadata(&path) {
        Ok(value) => value,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(e) => return Err(io_error(e)),
    };
    if !identity.is_file()
        || identity.is_symlink()
        || fs::canonicalize(&path).map_err(io_error)? != path
    {
        return Err(error("code_provenance_sealed_closure_file_invalid"));
    }
    let root_meta = fs::symlink_metadata(root).map_err(io_error)?;
    if !root_meta.is_dir()
        || root_meta.is_symlink()
        || fs::canonicalize(root).map_err(io_error)? != root
        || root_meta.mode() & 0o7777 != 0o555
    {
        return Err(error("code_provenance_sealed_workspace_root_not_read_only"));
    }
    let mut cursor = root.to_path_buf();
    let mut chain = vec![(cursor.clone(), root_meta)];
    for component in Path::new(CLOSURE).components() {
        cursor.push(component);
        let meta = fs::symlink_metadata(&cursor).map_err(io_error)?;
        let last = cursor == path;
        if meta.is_symlink()
            || fs::canonicalize(&cursor).map_err(io_error)? != cursor
            || if last {
                !meta.is_file()
            } else {
                !meta.is_dir()
            }
        {
            return Err(error("code_provenance_sealed_closure_path_invalid"));
        }
        if meta.mode() & 0o7777 != if last { 0o444 } else { 0o555 } {
            return Err(error(if last {
                "code_provenance_sealed_closure_file_not_read_only"
            } else {
                "code_provenance_sealed_closure_directory_not_read_only"
            }));
        }
        if last && meta.nlink() != 1 {
            return Err(error(
                "code_provenance_sealed_closure_file_link_count_invalid",
            ));
        }
        chain.push((cursor.clone(), meta));
    }
    let mut file = OpenOptions::new()
        .read(true)
        .custom_flags(nix::libc::O_NOFOLLOW | nix::libc::O_NONBLOCK)
        .open(&path)
        .map_err(io_error)?;
    if !files::same(&identity, &file.metadata().map_err(io_error)?) {
        return Err(error("code_provenance_sealed_closure_file_invalid"));
    }
    let mut bytes = Vec::new();
    file.read_to_end(&mut bytes).map_err(io_error)?;
    if !files::same(&identity, &file.metadata().map_err(io_error)?)
        || bytes.len() as u64 != identity.len()
    {
        return Err(error("code_provenance_sealed_closure_file_invalid"));
    }
    for (path, meta) in chain {
        if !files::same(&meta, &fs::symlink_metadata(path).map_err(io_error)?) {
            return Err(error("code_provenance_sealed_closure_path_invalid"));
        }
    }
    let parsed: Ordered = serde_json::from_slice(&bytes)
        .map_err(|_| error("code_provenance_sealed_closure_json_invalid"))?;
    let value = parsed.value();
    if ![json!(1), json!(2)].contains(&value["version"])
        || value["kind"] != "HeptaDeploymentToolClosure"
        || !value["submodules"].is_object()
        || !sha(&value["closureHash"])
    {
        return Err(error("code_provenance_sealed_closure_schema_invalid"));
    }
    if bytes != format!("{}\n", parsed.encode(false)?).as_bytes()
        && bytes != format!("{}\n", parsed.encode(true)?).as_bytes()
    {
        return Err(error("code_provenance_sealed_closure_json_noncanonical"));
    }
    if !super::exact_keys(&value["submodules"], &["core", "rScientificSourceCas"]) {
        return Err(error(
            "code_provenance_sealed_closure_submodule_set_invalid",
        ));
    }
    if value["closureHash"] != hash(parsed.without("closureHash").encode(false)?.as_bytes()) {
        return Err(error("code_provenance_sealed_closure_hash_mismatch"));
    }
    Ok(Some(parsed))
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct TreeRecord {
    path: String,
    kind: &'static str,
    mode: u32,
    size: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    content_hash: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    target_hash: Option<String>,
}
#[derive(Serialize)]
struct Counts {
    entries: usize,
    directories: usize,
    files: usize,
    symlinks: usize,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct TreeReport {
    version: u8,
    kind: &'static str,
    counts: Counts,
    tree_hash: String,
}
fn tree_error(code: &str) -> super::OperationalStatusError {
    error(&format!("release_dependency_tree_{code}"))
}
fn visit(path: &Path, relative: &str, records: &mut Vec<TreeRecord>) -> Result<()> {
    let before = fs::symlink_metadata(path).map_err(|_| tree_error("entry_read_failed"))?;
    if before.is_file() {
        let mut file = OpenOptions::new()
            .read(true)
            .custom_flags(nix::libc::O_NOFOLLOW | nix::libc::O_NONBLOCK)
            .open(path)
            .map_err(|_| tree_error("entry_read_failed"))?;
        if !files::same(
            &before,
            &file
                .metadata()
                .map_err(|_| tree_error("file_identity_changed"))?,
        ) {
            return Err(tree_error("file_identity_changed"));
        }
        let mut bytes = Vec::new();
        file.read_to_end(&mut bytes)
            .map_err(|_| tree_error("entry_read_failed"))?;
        if !files::same(
            &before,
            &file
                .metadata()
                .map_err(|_| tree_error("file_changed_during_read"))?,
        ) || bytes.len() as u64 != before.len()
        {
            return Err(tree_error("file_changed_during_read"));
        }
        records.push(TreeRecord {
            path: relative.to_owned(),
            kind: "file",
            mode: if before.mode() & 0o111 == 0 {
                0o644
            } else {
                0o755
            },
            size: bytes.len() as u64,
            content_hash: Some(hash(&bytes)),
            target_hash: None,
        });
        return Ok(());
    }
    if before.is_symlink() {
        let target = fs::read_link(path).map_err(|_| tree_error("entry_read_failed"))?;
        let bytes = target.as_os_str().as_bytes();
        if !files::same(
            &before,
            &fs::symlink_metadata(path).map_err(|_| tree_error("symlink_changed_during_read"))?,
        ) {
            return Err(tree_error("symlink_changed_during_read"));
        }
        records.push(TreeRecord {
            path: relative.to_owned(),
            kind: "symlink",
            mode: 0o777,
            size: bytes.len() as u64,
            content_hash: None,
            target_hash: Some(hash(bytes)),
        });
        return Ok(());
    }
    if !before.is_dir() {
        return Err(tree_error("special_file_forbidden"));
    }
    let descriptor = OpenOptions::new()
        .read(true)
        .custom_flags(nix::libc::O_RDONLY | nix::libc::O_DIRECTORY | nix::libc::O_NOFOLLOW)
        .open(path)
        .map_err(|_| tree_error("entry_read_failed"))?;
    if !files::same(
        &before,
        &descriptor
            .metadata()
            .map_err(|_| tree_error("directory_identity_changed"))?,
    ) {
        return Err(tree_error("directory_identity_changed"));
    }
    records.push(TreeRecord {
        path: relative.to_owned(),
        kind: "directory",
        mode: 0o755,
        size: 0,
        content_hash: None,
        target_hash: None,
    });
    let pinned = std::path::PathBuf::from(format!("/proc/self/fd/{}", descriptor.as_raw_fd()));
    let mut names = fs::read_dir(&pinned)
        .map_err(|_| tree_error("entry_read_failed"))?
        .map(|entry| {
            entry
                .map(|v| v.file_name())
                .map_err(|_| tree_error("entry_read_failed"))
        })
        .collect::<Result<Vec<_>>>()?;
    names.sort_by(|a, b| a.as_bytes().cmp(b.as_bytes()));
    for name in names {
        let name = name
            .to_str()
            .ok_or_else(|| tree_error("entry_name_invalid"))?;
        if name == "." || name == ".." || name.contains('/') || name.contains('\0') {
            return Err(tree_error("entry_name_invalid"));
        }
        visit(
            &pinned.join(name),
            &if relative == "." {
                name.to_owned()
            } else {
                format!("{relative}/{name}")
            },
            records,
        )?;
    }
    if !files::same(
        &before,
        &descriptor
            .metadata()
            .map_err(|_| tree_error("directory_changed_during_scan"))?,
    ) {
        return Err(tree_error("directory_changed_during_scan"));
    }
    Ok(())
}
fn scan(root: &Path) -> Result<(Metadata, String)> {
    let before = fs::symlink_metadata(root).map_err(|_| tree_error("root_directory_required"))?;
    if !before.is_dir() || before.is_symlink() {
        return Err(tree_error("root_directory_required"));
    }
    let mut records = Vec::new();
    visit(root, ".", &mut records)?;
    if !files::same(
        &before,
        &fs::symlink_metadata(root).map_err(|_| tree_error("root_changed_during_scan"))?,
    ) {
        return Err(tree_error("root_changed_during_scan"));
    }
    let report = TreeReport {
        version: 1,
        kind: "ReleaseDependencySourceTree",
        counts: Counts {
            entries: records.len(),
            directories: records.iter().filter(|v| v.kind == "directory").count(),
            files: records.iter().filter(|v| v.kind == "file").count(),
            symlinks: records.iter().filter(|v| v.kind == "symlink").count(),
        },
        tree_hash: hash(&serde_json::to_vec(&records).map_err(|_| tree_error("encoding_failed"))?),
    };
    Ok((
        before,
        serde_json::to_string(&report).map_err(|_| tree_error("encoding_failed"))?,
    ))
}
fn capture_tree(root: &Path) -> Result<String> {
    let (first, a) = scan(root)?;
    let (second, b) = scan(root)?;
    if !files::same(&first, &second) || a != b {
        return Err(tree_error("snapshot_unstable"));
    }
    Ok(b)
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Observation {
    key: String,
    path: String,
    commit: String,
    tree: String,
    content_tree_hash: String,
}
fn inspect_one(root: &Path, key: &str, path: &str, expected: &Ordered) -> Result<Observation> {
    let value = expected.value();
    let submodule = root.join(path);
    let stat = fs::symlink_metadata(&submodule)
        .map_err(|_| error(&format!("code_provenance_sealed_submodule_missing:{key}")))?;
    if !stat.is_dir()
        || stat.is_symlink()
        || fs::canonicalize(&submodule).map_err(io_error)? != submodule
    {
        return Err(error(&format!(
            "code_provenance_sealed_submodule_root_invalid:{key}"
        )));
    }
    if stat.mode() & 0o7777 != 0o555 {
        return Err(error(&format!(
            "code_provenance_sealed_submodule_root_not_read_only:{key}"
        )));
    }
    let raw = git(
        root,
        &format!("gitlink:{path}"),
        &["ls-tree", "-z", "HEAD", "--", path],
    )?;
    let (gitlink, listed) = raw
        .trim_end_matches('\0')
        .strip_prefix("160000 commit ")
        .and_then(|v| v.split_once('\t'))
        .ok_or_else(|| {
            error(&format!(
                "code_provenance_sealed_submodule_gitlink_invalid:{path}"
            ))
        })?;
    if !object(gitlink) || listed != path {
        return Err(error(&format!(
            "code_provenance_sealed_submodule_gitlink_invalid:{path}"
        )));
    }
    if !value["commit"].as_str().is_some_and(object) || !value["tree"].as_str().is_some_and(object)
    {
        return Err(error(&format!(
            "code_provenance_sealed_submodule_closure_identity_invalid:{key}"
        )));
    }
    let expected_tree = expected
        .get("sealedTree")
        .or_else(|| expected.get("readOnlyTree"))
        .or_else(|| expected.get("sourceTree"))
        .ok_or_else(|| {
            error(&format!(
                "code_provenance_sealed_submodule_closure_content_hash_invalid:{key}"
            ))
        })?;
    if !sha(&expected_tree.value()["treeHash"]) {
        return Err(error(&format!(
            "code_provenance_sealed_submodule_closure_content_hash_invalid:{key}"
        )));
    }
    if value["commit"] != gitlink {
        return Err(error(&format!(
            "code_provenance_sealed_submodule_commit_mismatch:{key}"
        )));
    }
    let commit = git_object(&submodule, "HEAD^{commit}", &format!("{key}:head"))?;
    let tree = git_object(&submodule, "HEAD^{tree}", &format!("{key}:tree"))?;
    if value["commit"] != commit {
        return Err(error(&format!(
            "code_provenance_sealed_submodule_worktree_commit_mismatch:{key}"
        )));
    }
    if value["tree"] != tree {
        return Err(error(&format!(
            "code_provenance_sealed_submodule_tree_mismatch:{key}"
        )));
    }
    let actual = capture_tree(&submodule)?;
    if actual != expected_tree.encode(false)? {
        return Err(error(&format!(
            "code_provenance_sealed_submodule_content_mismatch:{key}"
        )));
    }
    let actual: Value = serde_json::from_str(&actual).map_err(|_| tree_error("encoding_failed"))?;
    Ok(Observation {
        key: key.to_owned(),
        path: path.to_owned(),
        commit,
        tree,
        content_tree_hash: actual["treeHash"]
            .as_str()
            .ok_or_else(|| tree_error("encoding_failed"))?
            .to_owned(),
    })
}
/// Verify Git links, submodule HEAD/tree identities and hydrated filesystem
/// bytes against a read-only deployment closure without inspecting Git status.
pub fn inspect_operational_sealed_submodules_v1(root: &Path) -> Result<Value> {
    let root = std::path::absolute(root).map_err(io_error)?;
    if root.parent().is_none() {
        return Err(error("code_provenance_sealed_workspace_root_invalid"));
    }
    let Some(closure) = read_closure(&root)? else {
        #[derive(Serialize)]
        struct Payload<'a> {
            version: u8,
            root: &'a str,
        }
        let payload = Payload {
            version: 1,
            root: root
                .to_str()
                .ok_or_else(|| error("code_provenance_sealed_workspace_root_invalid"))?,
        };
        return Ok(
            json!({"version":1,"kind":"SealedReadOnlySubmoduleInspection","status":"sealed_readonly_submodules_not_configured","submodules":[],"inspectionHash":hash(&serde_json::to_vec(&payload).map_err(|_|error("code_provenance_sealed_closure_json_invalid"))?)}),
        );
    };
    let mut observations = Vec::new();
    for (key, path) in SUBMODULES {
        let expected = closure
            .get("submodules")
            .and_then(|v| v.get(key))
            .ok_or_else(|| {
                error(&format!(
                    "code_provenance_sealed_submodule_closure_entry_invalid:{key}"
                ))
            })?;
        if expected.value()["path"] != *path {
            return Err(error(&format!(
                "code_provenance_sealed_submodule_closure_entry_invalid:{key}"
            )));
        }
        observations.push(inspect_one(&root, key, path, expected)?);
    }
    #[derive(Serialize)]
    #[serde(rename_all = "camelCase")]
    struct Payload {
        version: u8,
        kind: &'static str,
        status: &'static str,
        closure_hash: Value,
        submodules: Vec<Observation>,
    }
    let payload = Payload {
        version: 1,
        kind: "SealedReadOnlySubmoduleInspection",
        status: "sealed_readonly_submodules_verified",
        closure_hash: closure.value()["closureHash"].clone(),
        submodules: observations,
    };
    let bytes = serde_json::to_vec(&payload)
        .map_err(|_| error("code_provenance_sealed_closure_json_invalid"))?;
    let mut result = serde_json::to_value(payload)
        .map_err(|_| error("code_provenance_sealed_closure_json_invalid"))?;
    result["inspectionHash"] = json!(hash(&bytes));
    Ok(result)
}
