//! Ordinary registry grammar and the existing explicit-path native extension.
use super::{StoreStatusError, inspect_store_status_with_options_v1};
use crate::workspace_status::{WorkspaceLayoutOptionsV1, resolve_workspace_layout_v1};
use serde_json::Value;
use std::{
    collections::{BTreeMap, BTreeSet},
    path::{Path, PathBuf},
};

pub fn store_status_cli_v1(
    argv: &[String],
    cwd: &Path,
    environment: &BTreeMap<String, String>,
) -> Result<(Value, i32), StoreStatusError> {
    let mut seen = BTreeSet::new();
    let mut paths = Vec::new();
    for token in argv {
        if token == "--" {
            return Err(StoreStatusError::Arguments(
                "unexpected_cli_argument_separator".into(),
            ));
        }
        if let Some(raw) = token.strip_prefix("--") {
            let (key, inline) = raw.split_once('=').map_or((raw, false), |(k, _)| (k, true));
            if key.is_empty() {
                return Err(StoreStatusError::Arguments("empty_cli_option".into()));
            }
            if ![
                "allow-isolated-verification-evidence",
                "require-trust-clean",
            ]
            .contains(&key)
            {
                return Err(StoreStatusError::Arguments(format!(
                    "unknown_cli_option:--{key}"
                )));
            }
            if inline {
                return Err(StoreStatusError::Arguments(format!(
                    "boolean_cli_option_does_not_take_value:--{key}"
                )));
            }
            if !seen.insert(key) {
                return Err(StoreStatusError::Arguments(format!(
                    "duplicate_cli_option:--{key}"
                )));
            }
        } else {
            paths.push(PathBuf::from(token));
            if paths.len() > 2 {
                return Err(StoreStatusError::Arguments(
                    "store-status accepts at most two paths".into(),
                ));
            }
        }
    }
    // Explicit database paths need no unrelated workspace default. Ordinary
    // invocations resolve their actual frontend deployment through the shared
    // workspace owner before deriving the runtime path.
    let runtime = if let Some(database) = paths.first() {
        paths.get(1).cloned().unwrap_or_else(|| {
            database
                .parent()
                .map(Path::to_path_buf)
                .unwrap_or_else(|| cwd.to_path_buf())
        })
    } else if let Some(selected) = environment
        .get("HEPTA_PAPER_RUNTIME_ROOT")
        .filter(|value| !value.is_empty())
    {
        crate::native_workspace::resolve_native_workspace_root_v1(
            cwd,
            Path::new(selected),
            Some(Path::new(selected)),
        )
        .map_err(StoreStatusError::Arguments)?
    } else {
        let workspace = crate::native_workspace::resolve_native_command_workspace_root_v1(
            cwd,
            environment,
            None,
        )
        .map_err(StoreStatusError::Arguments)?;
        let layout = resolve_workspace_layout_v1(
            &workspace,
            cwd,
            environment,
            &WorkspaceLayoutOptionsV1::default(),
        )
        .map_err(StoreStatusError::Arguments)?;
        PathBuf::from(&layout.roots.runtime_root)
    };
    let database = paths
        .first()
        .cloned()
        .unwrap_or_else(|| runtime.join("hepta-paper.sqlite"));
    let report = inspect_store_status_with_options_v1(
        &database,
        Some(&runtime),
        seen.contains("allow-isolated-verification-evidence"),
    )?;
    let code = if seen.contains("require-trust-clean") && report["ready"] != Value::Bool(true) {
        2
    } else {
        0
    };
    Ok((report, code))
}
