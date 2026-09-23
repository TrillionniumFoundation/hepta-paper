use super::{Result, error, files, hash};
use serde::Serialize;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{
    collections::BTreeSet,
    fs::{self, Metadata, OpenOptions},
    io::Read,
    os::unix::{
        ffi::OsStrExt,
        fs::{MetadataExt, OpenOptionsExt},
    },
    path::Path,
    process::Command,
};

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Entry {
    path: String,
    kind: &'static str,
    mode: Option<u32>,
    content_hash: Option<String>,
}
struct Snapshot {
    commit: String,
    tree: String,
    tags: Vec<String>,
    status: Vec<u8>,
    index: Vec<u8>,
    entries: Vec<(String, Option<Metadata>)>,
    content_hash: String,
    package: Vec<u8>,
}
fn git(root: &Path, operation: &str, args: &[&str], empty: bool) -> Result<Vec<u8>> {
    let output = Command::new("git")
        .args(args)
        .env("GIT_OPTIONAL_LOCKS", "0")
        .current_dir(root)
        .output()
        .map_err(|_| error(&format!("code_provenance_git_spawn_failed:{operation}")))?;
    if !output.status.success() {
        return Err(error(&format!(
            "code_provenance_git_command_failed:{operation}:exit_{}:stderr_{}",
            output
                .status
                .code()
                .map_or("no_status".to_owned(), |v| v.to_string()),
            &hash(&output.stderr)[7..]
        )));
    }
    if (!empty && output.stdout.is_empty()) || output.stdout.len() > 64 * 1024 * 1024 {
        return Err(error(&format!(
            "code_provenance_git_output_required:{operation}"
        )));
    }
    Ok(output.stdout)
}
fn id(bytes: Vec<u8>, operation: &str) -> Result<String> {
    let text = String::from_utf8(bytes)
        .map_err(|_| error("code_provenance_git_utf8_required"))?
        .trim()
        .to_owned();
    if !super::object_id(&json!(text)) {
        return Err(error(&format!(
            "code_provenance_git_object_id_invalid:{operation}"
        )));
    }
    Ok(text)
}
fn io_error(_: std::io::Error) -> super::OperationalStatusError {
    error("code_provenance_entry_read_failed")
}
fn capture(root: &Path, read_only: bool) -> Result<Snapshot> {
    let commit = id(git(root, "head", &["rev-parse", "HEAD"], false)?, "head")?;
    let tree = id(
        git(root, "head_tree", &["rev-parse", "HEAD^{tree}"], false)?,
        "head_tree",
    )?;
    let mut tags = String::from_utf8(git(
        root,
        "head_tags",
        &["tag", "--points-at", "HEAD"],
        true,
    )?)
    .map_err(|_| error("code_provenance_git_utf8_required"))?
    .lines()
    .filter(|v| !v.is_empty())
    .map(str::to_owned)
    .collect::<Vec<_>>();
    tags.sort();
    let status_args: &[&str] = if read_only {
        &[
            "status",
            "--porcelain=v1",
            "-z",
            "--ignore-submodules=dirty",
        ]
    } else {
        &["status", "--porcelain=v1", "-z"]
    };
    let status = git(root, "worktree_status", status_args, true)?;
    let listed = git(
        root,
        "repository_entries",
        &[
            "ls-files",
            "-z",
            "--cached",
            "--others",
            "--exclude-standard",
        ],
        false,
    )?;
    if listed.last() != Some(&0) {
        return Err(error(
            "code_provenance_git_nul_list_invalid:repository_entries",
        ));
    }
    let paths = listed
        .split(|b| *b == 0)
        .filter(|v| !v.is_empty())
        .map(|bytes| {
            let path = std::str::from_utf8(bytes)
                .map_err(|_| error("code_provenance_repository_path_utf8_required"))?;
            if Path::new(path).is_absolute() || path.split('/').any(|part| part == "..") {
                return Err(error("code_provenance_repository_path_invalid"));
            }
            Ok(path.to_owned())
        })
        .collect::<Result<BTreeSet<_>>>()?;
    let index = git(
        root,
        "index_state",
        &["diff-index", "--cached", "--raw", "-z", "HEAD"],
        true,
    )?;
    let mut digest = Sha256::new();
    digest.update(&index);
    digest.update(b"\0");
    let mut entries = Vec::new();
    let mut package = Vec::new();
    for relative in paths {
        let path = root.join(&relative);
        let before = match fs::symlink_metadata(&path) {
            Ok(meta) => Some(meta),
            Err(e)
                if matches!(
                    e.raw_os_error(),
                    Some(nix::libc::ENOENT | nix::libc::ENOTDIR)
                ) =>
            {
                None
            }
            Err(e) => return Err(io_error(e)),
        };
        let (kind, mode, content_hash) = if let Some(meta) = &before {
            let (kind, mode, bytes) = if meta.is_file() {
                let mut file = OpenOptions::new()
                    .read(true)
                    .custom_flags(nix::libc::O_NOFOLLOW | nix::libc::O_NONBLOCK)
                    .open(&path)
                    .map_err(io_error)?;
                if !files::same(meta, &file.metadata().map_err(io_error)?) {
                    return Err(error("code_provenance_snapshot_changed_during_scan"));
                }
                let mut bytes = Vec::new();
                file.read_to_end(&mut bytes).map_err(io_error)?;
                if !files::same(meta, &file.metadata().map_err(io_error)?)
                    || bytes.len() as u64 != meta.len()
                {
                    return Err(error("code_provenance_snapshot_changed_during_scan"));
                }
                (
                    "file",
                    if meta.mode() & 0o111 == 0 {
                        0o100644
                    } else {
                        0o100755
                    },
                    Some(bytes),
                )
            } else if meta.is_symlink() {
                (
                    "symlink",
                    0o120000,
                    Some(
                        fs::read_link(&path)
                            .map_err(io_error)?
                            .as_os_str()
                            .as_bytes()
                            .to_vec(),
                    ),
                )
            } else if meta.is_dir() {
                ("directory", 0o040000, None)
            } else {
                ("other", 0, None)
            };
            if !files::same(meta, &fs::symlink_metadata(&path).map_err(io_error)?) {
                return Err(error("code_provenance_snapshot_changed_during_scan"));
            }
            if relative == "package.json" && kind == "file" {
                package = bytes.clone().unwrap_or_default();
            }
            (kind, Some(mode), bytes.as_deref().map(hash))
        } else {
            ("missing", None, None)
        };
        let entry = Entry {
            path: relative.clone(),
            kind,
            mode,
            content_hash,
        };
        digest.update(
            serde_json::to_vec(&entry).map_err(|_| error("code_provenance_encoding_failed"))?,
        );
        digest.update(b"\0");
        entries.push((relative, before));
    }
    Ok(Snapshot {
        commit,
        tree,
        tags,
        status,
        index,
        entries,
        content_hash: format!("sha256:{}", hex::encode(digest.finalize())),
        package,
    })
}
fn same(left: &Snapshot, right: &Snapshot) -> bool {
    left.commit == right.commit
        && left.tree == right.tree
        && left.tags == right.tags
        && left.status == right.status
        && left.index == right.index
        && left.content_hash == right.content_hash
        && left.entries.len() == right.entries.len()
        && left
            .entries
            .iter()
            .zip(&right.entries)
            .all(|((lp, lm), (rp, rm))| {
                lp == rp
                    && match (lm, rm) {
                        (Some(l), Some(r)) => files::same(l, r),
                        (None, None) => true,
                        _ => false,
                    }
            })
        && left.package == right.package
}
/// Current Git and byte-level worktree identity. Release commit overrides are
/// intentionally ignored, as they are by the Node operational status entrypoint.
/// Sealed deployments verify their hydrated submodule closure before the Git
/// status probe, which ignores only closure-bound submodule worktree dirtiness.
pub fn current_operational_code_provenance_v1(root: &Path) -> Result<Value> {
    let root = fs::canonicalize(root).map_err(io_error)?;
    let sealed = std::env::var("HEPTA_RELEASE_ENV_LAUNCHER").ok().as_deref() == Some("sealed-v1");
    let read_only = sealed || fs::metadata(&root).map_err(io_error)?.mode() & 0o222 == 0;
    if read_only {
        let inspection = super::sealed::inspect_operational_sealed_submodules_v1(&root)?;
        if sealed && inspection["status"] != "sealed_readonly_submodules_verified" {
            return Err(error("code_provenance_sealed_submodule_closure_required"));
        }
    }
    for _ in 0..3 {
        let attempt = (|| {
            let before = capture(&root, read_only)?;
            let after = capture(&root, read_only)?;
            if !same(&before, &after) {
                return Err(error("code_provenance_snapshot_changed_during_scan"));
            }
            Ok(after)
        })();
        let snapshot = match attempt {
            Ok(value) => value,
            Err(e) if e.0 == "code_provenance_snapshot_changed_during_scan" => continue,
            Err(e) => return Err(e),
        };
        if snapshot.package.is_empty() {
            return Err(error("code_provenance_package_file_required"));
        }
        let package: Value = serde_json::from_slice(&snapshot.package)
            .map_err(|_| error("code_provenance_package_json_invalid"))?;
        let version = package["version"]
            .as_str()
            .filter(|v| !v.trim().is_empty())
            .ok_or_else(|| error("code_provenance_package_version_required"))?;
        let index_hash = hash(&snapshot.index);
        // Every Git object ID is nonempty; explicit framing matches Node.
        let mut state = Sha256::new();
        state.update(&snapshot.commit);
        state.update(b"\0");
        state.update(&snapshot.tree);
        state.update(b"\0");
        state.update(&snapshot.status);
        state.update(b"\0");
        state.update(&index_hash);
        state.update(b"\0");
        state.update(&snapshot.content_hash);
        return Ok(
            json!({"version":2,"kind":"CodeProvenance","packageVersion":version,"commit":snapshot.commit,"commitTree":snapshot.tree,"tags":snapshot.tags,"treeDirty":!snapshot.status.is_empty(),"indexStateHash":index_hash,"repositoryEntryCount":snapshot.entries.len(),"repositoryContentHash":snapshot.content_hash,"worktreeStateHash":format!("sha256:{}",hex::encode(state.finalize())),"evidenceEnvironment":std::env::var("HEPTA_EVIDENCE_ENVIRONMENT").ok().filter(|v| !v.is_empty()).unwrap_or("production".to_owned()),"evidenceClass":std::env::var("HEPTA_EVIDENCE_CLASS").ok().filter(|v| !v.is_empty()).unwrap_or("runtime_unclassified".to_owned())}),
        );
    }
    Err(error("code_provenance_snapshot_unstable"))
}
