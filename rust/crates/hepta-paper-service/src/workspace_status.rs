//! Read-only workspace layout and physical-decoupling diagnostics.
//! Paths are observations, never retained file capabilities or authorization.
use serde::Serialize;
use std::{
    collections::{BTreeMap, VecDeque},
    fs,
    path::{Path, PathBuf},
};

const NAMES: [&str; 4] = ["workspaceRoot", "assetRoot", "runtimeRoot", "legacyRoot"];

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceRootsV1 {
    pub workspace_root: String,
    pub asset_root: String,
    pub runtime_root: String,
    pub legacy_root: String,
}
impl WorkspaceRootsV1 {
    fn values(&self) -> [&str; 4] {
        [
            &self.workspace_root,
            &self.asset_root,
            &self.runtime_root,
            &self.legacy_root,
        ]
    }
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceLayoutV1 {
    version: u8,
    kind: &'static str,
    #[serde(flatten)]
    pub roots: WorkspaceRootsV1,
    pub real_paths: WorkspaceRootsV1,
    pub physically_decoupled: bool,
    pub decoupling_blockers: Vec<String>,
    pub legacy_catalog_runtime_scan_allowed: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceStatusV1 {
    #[serde(flatten)]
    pub layout: WorkspaceLayoutV1,
    pub workspace_real_path: String,
    pub asset_real_path: String,
    pub runtime_real_path: String,
    pub legacy_real_path: String,
    pub workspace_present: bool,
    pub asset_root_present: bool,
    pub runtime_root_present: bool,
    pub native_store_present: bool,
    pub status: &'static str,
}

/// Optional adapter inputs, matching the original layout API. Empty strings
/// fall back to the corresponding environment/default, as in Node.
#[derive(Default)]
pub struct WorkspaceLayoutOptionsV1<'a> {
    pub asset_root: Option<&'a str>,
    pub runtime_root: Option<&'a str>,
    pub legacy_root: Option<&'a str>,
}

fn path_text(path: &Path) -> Result<&str, String> {
    path.to_str()
        .ok_or_else(|| "workspace_layout_utf8_path_required".into())
}

/// Node's Unix `path.resolve`, performed before any filesystem lookup. A
/// backslash is an ordinary filename byte. Parent traversal clamps at root.
fn resolve(cwd: &str, path: &str) -> String {
    let absolute = if path.starts_with('/') {
        path.to_owned()
    } else {
        format!("{cwd}/{path}")
    };
    let mut components = Vec::new();
    for component in absolute.split('/') {
        match component {
            "" | "." => (),
            ".." => {
                components.pop();
            }
            component => components.push(component),
        }
    }
    format!("/{}", components.join("/"))
}

fn parent(path: &str) -> &str {
    path.rsplit_once('/')
        .map(|(prefix, _)| if prefix.is_empty() { "/" } else { prefix })
        .unwrap_or("/")
}

fn join(parent: &str, child: &str) -> String {
    if parent == "/" {
        format!("/{child}")
    } else {
        format!("{parent}/{child}")
    }
}

/// Resolve directory symlinks while retaining a missing suffix. This differs
/// intentionally from lexical normalization and from full `realpath`: once a
/// component is missing, a later `..` in a symlink target is unresolved.
fn physical_directory(path: &str) -> Option<String> {
    let mut current = String::from("/");
    let mut pending = path.split('/').map(str::to_owned).collect::<VecDeque<_>>();
    let mut missing = false;
    let mut symlink_hops = 0;
    while let Some(component) = pending.pop_front() {
        match component.as_str() {
            "" | "." => continue,
            ".." => {
                if missing {
                    return None;
                }
                current = parent(&current).to_owned();
                continue;
            }
            _ => (),
        }
        let selected = join(&current, &component);
        if missing {
            current = selected;
            continue;
        }
        let metadata = match fs::symlink_metadata(&selected) {
            Ok(metadata) => metadata,
            Err(cause) if cause.raw_os_error() == Some(2) => {
                missing = true;
                current = selected;
                continue;
            }
            Err(_) => return None,
        };
        if !metadata.file_type().is_symlink() {
            if !metadata.is_dir() {
                return None;
            }
            current = selected;
            continue;
        }
        if symlink_hops >= 40 {
            return None;
        }
        symlink_hops += 1;
        let target = fs::read_link(selected).ok()?;
        let target = target.to_str()?;
        if target.starts_with('/') {
            current = String::from("/");
        }
        for component in target.split('/').rev() {
            pending.push_front(component.to_owned());
        }
    }
    Some(current)
}

fn overlaps(left: &str, right: &str) -> bool {
    let contains = |parent: &str, candidate: &str| {
        parent == candidate
            || parent == "/"
            || candidate
                .strip_prefix(parent)
                .is_some_and(|suffix| suffix.starts_with('/'))
    };
    contains(left, right) || contains(right, left)
}

fn requested<'a>(
    explicit: Option<&'a str>,
    environment: &'a BTreeMap<String, String>,
    key: &str,
) -> Option<&'a str> {
    explicit.filter(|v| !v.is_empty()).or_else(|| {
        environment
            .get(key)
            .filter(|v| !v.is_empty())
            .map(String::as_str)
    })
}

/// Native binding for the original module's deployment-root constant. The
/// caller selects a deployment workspace; no compile-time source path is used.
/// All values remain diagnostic and can change immediately after inspection.
pub fn resolve_workspace_layout_v1(
    workspace_root: &Path,
    working_directory: &Path,
    environment: &BTreeMap<String, String>,
    options: &WorkspaceLayoutOptionsV1<'_>,
) -> Result<WorkspaceLayoutV1, String> {
    let cwd = path_text(working_directory)?;
    if !cwd.starts_with('/') {
        return Err("workspace_layout_working_directory_invalid".into());
    }
    let workspace = resolve(cwd, path_text(workspace_root)?);
    let workspace_parent = parent(&workspace);
    let is_legacy_parent = workspace_parent.rsplit('/').next() == Some("paper_factory");
    let asset_default = if is_legacy_parent {
        workspace_parent.to_owned()
    } else {
        join(workspace_parent, "hepta-paper-assets")
    };
    let runtime_default = join(workspace_parent, "hepta-paper-runtime/native-runtime");
    let legacy_default = if is_legacy_parent {
        workspace_parent.to_owned()
    } else {
        join(workspace_parent, "paper_factory")
    };
    let roots = WorkspaceRootsV1 {
        workspace_root: workspace.clone(),
        asset_root: resolve(
            cwd,
            requested(options.asset_root, environment, "HEPTA_PAPER_ASSET_ROOT")
                .unwrap_or(&asset_default),
        ),
        runtime_root: resolve(
            cwd,
            requested(
                options.runtime_root,
                environment,
                "HEPTA_PAPER_RUNTIME_ROOT",
            )
            .unwrap_or(&runtime_default),
        ),
        legacy_root: resolve(
            cwd,
            requested(
                options.legacy_root,
                environment,
                "PAPER_FACTORY_LEGACY_ROOT",
            )
            .unwrap_or(&legacy_default),
        ),
    };
    let mut blockers = Vec::new();
    let mut physical = roots.clone();
    for ((name, value), destination) in NAMES.iter().zip(roots.values()).zip([
        &mut physical.workspace_root,
        &mut physical.asset_root,
        &mut physical.runtime_root,
        &mut physical.legacy_root,
    ]) {
        match physical_directory(value) {
            Some(canonical) => *destination = canonical,
            None => blockers.push(format!("workspace_layout_path_resolution_failed:{name}")),
        }
    }
    let physical_values = physical.values();
    for (left_index, (left_name, left_path)) in NAMES.iter().zip(physical_values).enumerate() {
        for (right_name, right_path) in NAMES.iter().zip(physical_values).skip(left_index + 1) {
            if overlaps(left_path, right_path) {
                blockers.push(format!(
                    "workspace_layout_paths_overlap:{left_name}:{right_name}"
                ));
            }
        }
    }
    Ok(WorkspaceLayoutV1 {
        version: 1,
        kind: "HeptaPaperWorkspaceLayout",
        roots,
        real_paths: physical,
        physically_decoupled: blockers.is_empty(),
        decoupling_blockers: blockers,
        legacy_catalog_runtime_scan_allowed: false,
    })
}

/// Full original workspace-status report. The top-level real paths use the
/// source command's `realpath-or-lexical` fallback, independently of the layout's
/// missing-suffix resolver. `exists` follows symlinks and accepts files as Node
/// does; directory-only validation remains visible in decoupling blockers.
pub fn inspect_workspace_status_v1(
    workspace_root: &Path,
    working_directory: &Path,
    environment: &BTreeMap<String, String>,
) -> Result<WorkspaceStatusV1, String> {
    let layout = resolve_workspace_layout_v1(
        workspace_root,
        working_directory,
        environment,
        &WorkspaceLayoutOptionsV1::default(),
    )?;
    let real = |value: &str| {
        fs::canonicalize(value)
            .ok()
            .and_then(|path| path.into_os_string().into_string().ok())
            .unwrap_or_else(|| value.to_owned())
    };
    let roots = &layout.roots;
    let result = WorkspaceStatusV1 {
        workspace_real_path: real(&roots.workspace_root),
        asset_real_path: real(&roots.asset_root),
        runtime_real_path: real(&roots.runtime_root),
        legacy_real_path: real(&roots.legacy_root),
        workspace_present: Path::new(&roots.workspace_root).exists(),
        asset_root_present: Path::new(&roots.asset_root).exists(),
        runtime_root_present: Path::new(&roots.runtime_root).exists(),
        native_store_present: Path::new(&roots.runtime_root)
            .join("hepta-paper.sqlite")
            .exists(),
        status: if layout.physically_decoupled {
            "hepta_workspace_physically_decoupled"
        } else {
            "hepta_workspace_paths_overlap"
        },
        layout,
    };
    Ok(result)
}

/// Relocatable native command root: explicit flag, then nonempty deployment
/// environment, then the process working directory. Incumbent unknown options
/// remain ignored; only the added workspace-root option consumes a value.
pub fn workspace_status_cli_v1(
    argv: &[String],
    working_directory: &Path,
    environment: &BTreeMap<String, String>,
) -> Result<(WorkspaceStatusV1, i32), String> {
    let mut args = argv.iter();
    let mut explicit = None;
    while let Some(arg) = args.next() {
        let value = if arg == "--workspace-root" {
            Some(
                args.next()
                    .ok_or("workspace_status_workspace_root_required")?
                    .as_str(),
            )
        } else {
            arg.strip_prefix("--workspace-root=")
        };
        if let Some(value) = value {
            if explicit.is_some() || value.is_empty() || value.starts_with("--") {
                return Err("workspace_status_workspace_root_invalid".into());
            }
            explicit = Some(value);
        }
    }
    // The incumbent `paper-core/bin/workspace-status.mjs` resolves its
    // workspace from the installed module location (`HEPTA_WORKSPACE_ROOT`),
    // rather than from the caller's cwd. Keep the explicit relocation and
    // environment override for native deployments, but make the no-argument
    // invocation observe the same compiled deployment root as Node.
    let compiled_workspace_root = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../..");
    let root = requested(explicit, environment, "HEPTA_PAPER_WORKSPACE_ROOT")
        .map(PathBuf::from)
        .unwrap_or(compiled_workspace_root);
    let report = inspect_workspace_status_v1(&root, working_directory, environment)?;
    let code =
        if argv.iter().any(|a| a == "--require-decoupled") && !report.layout.physically_decoupled {
            2
        } else {
            0
        };
    Ok((report, code))
}
