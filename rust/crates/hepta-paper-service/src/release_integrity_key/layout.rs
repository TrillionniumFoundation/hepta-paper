use super::storage::normalize;
use super::{ReleaseIntegrityKeyContextV1, Result, error};
use std::{
    collections::VecDeque,
    ffi::OsString,
    fs,
    path::{Component, Path, PathBuf},
};
fn physical(candidate: &Path) -> Option<PathBuf> {
    let absolute = normalize(candidate).ok()?;
    let mut current = PathBuf::from("/");
    let mut pending = absolute
        .components()
        .skip(1)
        .map(|part| part.as_os_str().to_owned())
        .collect::<VecDeque<OsString>>();
    let mut missing = false;
    let mut hops = 0;
    while let Some(part) = pending.pop_front() {
        if part.is_empty() || part == "." {
            continue;
        }
        if part == ".." {
            if missing {
                return None;
            }
            current.pop();
            continue;
        }
        let selected = current.join(&part);
        if missing {
            current = selected;
            continue;
        }
        let metadata = match fs::symlink_metadata(&selected) {
            Ok(v) => v,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
                missing = true;
                current = selected;
                continue;
            }
            Err(_) => return None,
        };
        if !metadata.is_symlink() {
            if !metadata.is_dir() {
                return None;
            }
            current = selected;
            continue;
        }
        if hops >= 40 {
            return None;
        }
        hops += 1;
        let target = fs::read_link(&selected).ok()?;
        if target.is_absolute() {
            current = PathBuf::from("/");
        }
        let target_parts = target
            .components()
            .filter(|part| !matches!(part, Component::RootDir))
            .map(|part| part.as_os_str().to_owned())
            .collect::<Vec<_>>();
        for part in target_parts.into_iter().rev() {
            pending.push_front(part);
        }
    }
    Some(current)
}
pub(super) fn assert_decoupled(context: &ReleaseIntegrityKeyContextV1) -> Result<()> {
    let roots = [
        ("workspaceRoot", &context.workspace_root),
        ("assetRoot", &context.asset_root),
        ("runtimeRoot", &context.runtime_root),
        ("legacyRoot", &context.legacy_root),
    ];
    let mut blockers = Vec::new();
    let mut real = Vec::new();
    for (name, path) in roots {
        let canonical = physical(path);
        if canonical.is_none() {
            blockers.push(format!("workspace_layout_path_resolution_failed:{name}"));
        }
        real.push((name, canonical.unwrap_or(normalize(path)?)));
    }
    for left in 0..real.len() {
        for right in left + 1..real.len() {
            if real[left].1.starts_with(&real[right].1) || real[right].1.starts_with(&real[left].1)
            {
                blockers.push(format!(
                    "workspace_layout_paths_overlap:{}:{}",
                    real[left].0, real[right].0
                ));
            }
        }
    }
    if !blockers.is_empty() {
        return Err(error(format!(
            "workspace_layout_not_physically_decoupled:{}",
            blockers.join(",")
        )));
    }
    Ok(())
}
