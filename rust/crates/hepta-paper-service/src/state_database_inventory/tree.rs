use super::*;
use std::{collections::BTreeSet, path::PathBuf};
pub(super) struct Candidate {
    pub definition: Value,
    pub relative: PathBuf,
    pub paper_id: Option<String>,
}
fn present(path: &Path) -> bool {
    std::fs::symlink_metadata(path).is_ok()
}
fn entries(
    directory: &files::Directory,
    visited: &mut usize,
) -> Result<Vec<(String, std::fs::FileType)>> {
    directory.assert_current()?;
    let before = files::identity(&directory.held.metadata().map_err(|_| files::changed())?);
    let mut result = Vec::new();
    for entry in std::fs::read_dir(directory.fd_path()).map_err(|_| files::changed())? {
        *visited += 1;
        ensure(
            *visited <= 10_000,
            "autonomous_research_state_database_inventory_limit_exceeded",
        )?;
        let entry = entry.map_err(|_| files::changed())?;
        let name = entry
            .file_name()
            .into_string()
            .map_err(|_| error("autonomous_research_state_database_utf8_invalid"))?;
        result.push((name, entry.file_type().map_err(|_| files::changed())?));
    }
    directory.assert_current()?;
    ensure(
        before == files::identity(&directory.held.metadata().map_err(|_| files::changed())?),
        "autonomous_research_state_database_changed_during_snapshot",
    )?;
    result.sort_by(|a, b| a.0.encode_utf16().cmp(b.0.encode_utf16()));
    Ok(result)
}
fn walk(
    directory: &files::Directory,
    relative: &Path,
    blockers: &mut Vec<String>,
    visited: &mut usize,
    depth: usize,
) -> Result<Vec<PathBuf>> {
    ensure(
        depth <= 64,
        "autonomous_research_state_database_inventory_limit_exceeded",
    )?;
    let mut result = Vec::new();
    for (name, kind) in entries(directory, visited)? {
        let path = relative.join(&name);
        if kind.is_symlink() {
            blockers.push(format!(
                "autonomous_research_state_database_tree_symlink_forbidden:{}",
                path.display()
            ));
        } else if kind.is_dir() {
            result.extend(walk(
                &directory.child_directory(std::ffi::OsStr::new(&name))?,
                &path,
                blockers,
                visited,
                depth + 1,
            )?);
        } else if kind.is_file() && name.ends_with(".sqlite") {
            result.push(path);
        } else if name.ends_with(".sqlite") {
            blockers.push(format!(
                "autonomous_research_state_database_special_file_forbidden:{}",
                path.display()
            ));
        }
    }
    result.sort_by(|a, b| {
        a.as_os_str()
            .as_encoded_bytes()
            .cmp(b.as_os_str().as_encoded_bytes())
    });
    Ok(result)
}
fn exclusion(
    root: &files::Directory,
    exclusion: &Value,
    blockers: &mut Vec<String>,
    detailed: bool,
) -> Result<()> {
    let relative = Path::new(text(exclusion, "relativePath")?);
    let path = root.path.join(relative);
    if !present(&path) {
        return Ok(());
    }
    let metadata = std::fs::symlink_metadata(&path).map_err(|_| files::changed())?;
    let valid = metadata.is_file()
        && !metadata.file_type().is_symlink()
        && exclusion["requiredBytes"].as_f64() == Some(metadata.len() as f64)
        && (!detailed
            || (!present(&PathBuf::from(format!("{}-wal", path.display())))
                && !present(&PathBuf::from(format!("{}-shm", path.display())))));
    if !valid {
        blockers.push(format!(
            "autonomous_research_state_database_exclusion_invalid:{}{}",
            relative.display(),
            if detailed && metadata.file_type().is_symlink() {
                ":autonomous_research_state_database_symlink_forbidden"
            } else if detailed {
                ":retired_placeholder_not_empty"
            } else {
                ""
            }
        ));
    }
    Ok(())
}
pub(super) fn collect(
    root: &files::Directory,
    manifest: &Value,
    handoff: bool,
) -> Result<(Vec<Candidate>, Vec<String>)> {
    let definitions = manifest["databases"]
        .as_array()
        .ok_or_else(files::changed)?;
    let mut blockers = Vec::new();
    let mut rows = Vec::new();
    if handoff {
        let definition = definitions
            .iter()
            .find(|v| v["role"] == "submission-handoff" && v["cardinality"] == "singleton")
            .ok_or_else(|| {
                error("autonomous_submission_handoff_state_database_manifest_invalid")
            })?;
        let relative = PathBuf::from(text(definition, "relativePath")?);
        let path = root.path.join(&relative);
        if !present(&path) {
            blockers.push("autonomous_submission_handoff_state_database_required_missing".into());
        }
        if let Some(parent) = relative.parent()
            && present(&root.path.join(parent))
        {
            let fake = parent.join(".inventory-probe");
            let (chain, _) = files::parent(root, &fake)?;
            let directory = chain.last().unwrap_or(root);
            let mut visited = 0;
            for candidate in walk(directory, Path::new(""), &mut blockers, &mut visited, 0)? {
                let full = parent.join(candidate);
                if full != relative {
                    blockers.push(format!(
                        "autonomous_submission_handoff_state_database_unregistered:{}",
                        full.display()
                    ));
                }
            }
        }
        if present(&path) {
            rows.push(Candidate {
                definition: definition.clone(),
                relative,
                paper_id: None,
            });
        }
        return Ok((rows, blockers));
    }
    let mut recognized = BTreeSet::new();
    for definition in definitions
        .iter()
        .filter(|v| v["cardinality"] == "singleton")
    {
        let relative = PathBuf::from(text(definition, "relativePath")?);
        if !present(&root.path.join(&relative)) {
            blockers.push(format!(
                "autonomous_research_state_database_required_missing:{}",
                text(definition, "role")?
            ));
        } else {
            recognized.insert(relative.clone());
            rows.push(Candidate {
                definition: definition.clone(),
                relative,
                paper_id: None,
            });
        }
    }
    for excluded in manifest["excludedDatabases"]
        .as_array()
        .ok_or_else(files::changed)?
    {
        recognized.insert(PathBuf::from(text(excluded, "relativePath")?));
        exclusion(root, excluded, &mut blockers, false)?;
    }
    let mut visited = 0;
    let top = entries(root, &mut visited)?;
    let mut top_sqlite = Vec::new();
    for (name, kind) in top {
        if !name.ends_with(".sqlite") {
            continue;
        }
        let relative = PathBuf::from(&name);
        if !recognized.contains(&relative) {
            blockers.push(format!(
                "autonomous_research_state_database_unregistered:{name}"
            ));
        }
        if kind.is_symlink() {
            blockers.push(format!(
                "autonomous_research_state_database_tree_symlink_forbidden:{name}"
            ));
        } else if kind.is_file() {
            top_sqlite.push(relative);
        } else {
            blockers.push(format!(
                "autonomous_research_state_database_special_file_forbidden:{name}"
            ));
        }
    }
    let autonomous = if present(&root.path.join("autonomous-research")) {
        let directory = root.child_directory(std::ffi::OsStr::new("autonomous-research"))?;
        let mut tree_visited = 0;
        walk(
            &directory,
            Path::new(""),
            &mut blockers,
            &mut tree_visited,
            0,
        )?
        .into_iter()
        .map(|p| Path::new("autonomous-research").join(p))
        .collect::<Vec<_>>()
    } else {
        Vec::new()
    };
    for definition in definitions
        .iter()
        .filter(|v| v["cardinality"] == "per-paper")
    {
        let pattern = text(definition, "relativePathPattern")?;
        let (prefix, suffix) = pattern.split_once("{paperId}").ok_or_else(files::changed)?;
        let mut count = 0;
        for candidate in &autonomous {
            let relative = candidate.to_str().ok_or_else(files::changed)?;
            let paper = relative
                .strip_prefix(prefix)
                .and_then(|p| p.strip_suffix(suffix))
                .filter(|p| !p.is_empty() && !p.contains('/'));
            if let Some(paper) = paper {
                ensure(
                    rows.len() < 256,
                    "autonomous_research_state_database_inventory_limit_exceeded",
                )?;
                recognized.insert(candidate.clone());
                rows.push(Candidate {
                    definition: definition.clone(),
                    relative: candidate.clone(),
                    paper_id: Some(paper.to_owned()),
                });
                count += 1;
            }
        }
        if definition["minimumInstances"]
            .as_f64()
            .is_none_or(|minimum| f64::from(count) < minimum)
        {
            blockers.push(format!(
                "autonomous_research_state_database_required_missing:{}",
                text(definition, "role")?
            ));
        }
    }
    for excluded in manifest["excludedDatabases"]
        .as_array()
        .ok_or_else(files::changed)?
    {
        exclusion(root, excluded, &mut blockers, true)?;
    }
    for path in top_sqlite.into_iter().chain(autonomous) {
        if !recognized.contains(&path) {
            blockers.push(format!(
                "autonomous_research_state_database_unregistered:{}",
                path.display()
            ));
        }
    }
    let collator = hepta_legacy_compatibility::ProductionCollationV1::load()
        .map_err(|e| error(e.to_string()))?;
    rows.sort_by(|a, b| {
        collator.compare(
            a.relative.to_str().unwrap_or_default(),
            b.relative.to_str().unwrap_or_default(),
        )
    });
    ensure(
        rows.len() <= 256,
        "autonomous_research_state_database_inventory_limit_exceeded",
    )?;
    Ok((rows, blockers))
}
pub(super) fn fingerprint(rows: &[Candidate], blockers: &[String]) -> Value {
    let mut blockers = blockers.to_vec();
    blockers.sort();
    json!({"rows":rows.iter().map(|r|json!({"definition":r.definition,"relative":r.relative,"paper":r.paper_id})).collect::<Vec<_>>(),"blockers":blockers})
}
