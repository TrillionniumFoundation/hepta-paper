use super::{Result, error, files, hash};
use serde::Serialize;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{
    collections::BTreeSet,
    fs::{self, File, Metadata},
    io::Read,
    os::unix::{ffi::OsStrExt, fs::MetadataExt},
    path::Path,
    sync::atomic::AtomicBool,
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
/// Internal composition seam. Only the fixed queries in this module reach the
/// observer. Ordinary and release observations both supply bounded reads and
/// cancellable process-group observations without sharing evidence authority.
pub(crate) trait ProvenanceObservationV1 {
    fn git(&mut self, root: &Path, operation: &str, args: &[&str], empty: bool) -> Result<Vec<u8>>;
    fn checkpoint(&mut self) -> Result<()>;
    fn repository_entry_count(&mut self, _: usize) -> Result<()> {
        Ok(())
    }
    fn source_entry(&mut self, root: &Path, relative: &str) -> Result<()>;
    fn file_size(&mut self, size: u64) -> Result<()>;
    fn consume(&mut self, bytes: usize) -> Result<()>;
    fn read_capacity(&mut self, requested: usize) -> Result<usize>;
    fn open_regular(&mut self, root: &Path, relative: &str) -> Result<File>;
    fn payload(&mut self, relative: &str, mode: Option<u32>, bytes: Option<&[u8]>) -> Result<()>;
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
fn capture(
    root: &Path,
    read_only: bool,
    observation: &mut dyn ProvenanceObservationV1,
) -> Result<Snapshot> {
    observation.checkpoint()?;
    let commit = id(
        observation.git(root, "head", &["rev-parse", "HEAD"], false)?,
        "head",
    )?;
    let tree = id(
        observation.git(root, "head_tree", &["rev-parse", "HEAD^{tree}"], false)?,
        "head_tree",
    )?;
    let mut tags = String::from_utf8(observation.git(
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
    tags.sort_by(|a, b| a.encode_utf16().cmp(b.encode_utf16()));
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
    let status = observation.git(root, "worktree_status", status_args, true)?;
    let listed = observation.git(
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
    observation.repository_entry_count(listed.iter().filter(|byte| **byte == 0).count())?;
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
    let index = observation.git(
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
        observation.checkpoint()?;
        observation.source_entry(root, &relative)?;
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
                observation.file_size(meta.len())?;
                let mut file = observation.open_regular(root, &relative)?;
                if !files::same(meta, &file.metadata().map_err(io_error)?) {
                    return Err(error("code_provenance_snapshot_changed_during_scan"));
                }
                let mut bytes = Vec::new();
                let mut buffer = [0u8; 64 * 1024];
                loop {
                    observation.checkpoint()?;
                    let remaining = meta.len().saturating_sub(bytes.len() as u64);
                    if remaining == 0 {
                        break;
                    }
                    let requested = usize::try_from(remaining.min(buffer.len() as u64))
                        .map_err(|_| error("code_provenance_entry_read_failed"))?;
                    let capacity = observation.read_capacity(requested)?;
                    if capacity == 0 || capacity > requested {
                        return Err(error("code_provenance_read_capacity_invalid"));
                    }
                    let read = file.read(&mut buffer[..capacity]).map_err(io_error)?;
                    if read == 0 {
                        break;
                    }
                    observation.file_size(bytes.len() as u64 + read as u64)?;
                    observation.consume(read)?;
                    bytes.extend_from_slice(&buffer[..read]);
                }
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
            if kind == "symlink" {
                observation.consume(bytes.as_ref().map_or(0, Vec::len))?;
            }
            observation.payload(&relative, Some(mode), bytes.as_deref())?;
            (kind, Some(mode), bytes.as_deref().map(hash))
        } else {
            observation.payload(&relative, None, None)?;
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
/// File/entry/operation limits and a deadline apply to all source observations.
/// This cooperative identity check does not claim an immutable source snapshot.
pub fn current_operational_code_provenance_v1(root: &Path) -> Result<Value> {
    current_operational_code_provenance_with_cancellation_v1(root, &AtomicBool::new(false))
}
/// Ordinary evidence classification and sealed closure semantics are preserved;
/// cancellation does not manufacture release attestation or imported authority.
pub fn current_operational_code_provenance_with_cancellation_v1(
    root: &Path,
    cancelled: &AtomicBool,
) -> Result<Value> {
    let mut observation = super::bounded::Observation::new(cancelled)?;
    current_operational_with_observation(root, &mut observation)
}
/// Composition may shorten the existing ordinary 120s ceiling; it cannot
/// extend it or replace the fixed Git/environment/source observation owner.
pub(crate) fn current_operational_code_provenance_with_deadline_v1(
    root: &Path,
    cancelled: &AtomicBool,
    deadline: std::time::Instant,
) -> Result<Value> {
    let mut observation = super::bounded::Observation::with_deadline(cancelled, deadline)?;
    current_operational_with_observation(root, &mut observation)
}
pub(super) fn current_operational_with_observation(
    root: &Path,
    observation: &mut super::bounded::Observation<'_>,
) -> Result<Value> {
    let root = fs::canonicalize(root).map_err(io_error)?;
    let sealed = std::env::var("HEPTA_RELEASE_ENV_LAUNCHER").ok().as_deref() == Some("sealed-v1");
    let read_only = sealed || fs::metadata(&root).map_err(io_error)?.mode() & 0o222 == 0;
    if read_only {
        let inspection = super::sealed::inspect_with_observation(&root, observation)?;
        if sealed && inspection["status"] != "sealed_readonly_submodules_verified" {
            return Err(error("code_provenance_sealed_submodule_closure_required"));
        }
    }
    let environment = std::env::var("HEPTA_EVIDENCE_ENVIRONMENT")
        .ok()
        .filter(|v| !v.is_empty())
        .unwrap_or("production".to_owned());
    let class = std::env::var("HEPTA_EVIDENCE_CLASS")
        .ok()
        .filter(|v| !v.is_empty())
        .unwrap_or("runtime_unclassified".to_owned());
    current_with_observation(&root, read_only, &environment, &class, observation)
}
/// Bounded release capture uses complete development status, including submodule
/// worktree changes. It does not infer a sealed deployment from environment.
pub(crate) fn current_bounded_code_provenance_v1(
    root: &Path,
    observation: &mut dyn ProvenanceObservationV1,
) -> Result<Value> {
    current_with_observation(
        root,
        false,
        "administrative",
        "release_attestation",
        observation,
    )
}
fn current_with_observation(
    root: &Path,
    read_only: bool,
    environment: &str,
    class: &str,
    observation: &mut dyn ProvenanceObservationV1,
) -> Result<Value> {
    for _ in 0..3 {
        let attempt = (|| {
            let before = capture(root, read_only, observation)?;
            let after = capture(root, read_only, observation)?;
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
            json!({"version":2,"kind":"CodeProvenance","packageVersion":version,"commit":snapshot.commit,"commitTree":snapshot.tree,"tags":snapshot.tags,"treeDirty":!snapshot.status.is_empty(),"indexStateHash":index_hash,"repositoryEntryCount":snapshot.entries.len(),"repositoryContentHash":snapshot.content_hash,"worktreeStateHash":format!("sha256:{}",hex::encode(state.finalize())),"evidenceEnvironment":environment,"evidenceClass":class}),
        );
    }
    Err(error("code_provenance_snapshot_unstable"))
}
