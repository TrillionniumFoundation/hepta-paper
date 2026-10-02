//! Held complete paper-source observations through the existing read-only owner.
use crate::runtime_source_cas::observation::SourceObservation;
use hepta_legacy_compatibility::{ProductionCollationV1, production_hash_record_v1};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{
    collections::BTreeSet,
    path::{Path, PathBuf},
    sync::atomic::{AtomicBool, Ordering},
    time::Instant,
};
const MAX_BYTES: u64 = 4 * 1024 * 1024;
const MAX_RECORDS: usize = 4096;
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct NativeResearchSourceSnapshotRequestV1 {
    pub version: u16,
    pub source_root: PathBuf,
}
pub struct NativeResearchSourceSnapshotObservationV1<'a> {
    source: SourceObservation<'a>,
    snapshot: Value,
}
impl<'a> NativeResearchSourceSnapshotObservationV1<'a> {
    pub fn snapshot(&self) -> &Value {
        &self.snapshot
    }
    pub fn verify_unchanged(&self) -> Result<(), String> {
        self.source.assert_current()
    }
}
fn refused() -> String {
    "native_research_source_profile_v1_refused".into()
}
fn check(c: &AtomicBool) -> Result<(), String> {
    if c.load(Ordering::SeqCst) {
        Err("native_research_source_cancelled".into())
    } else {
        Ok(())
    }
}
fn hash(kind: &str, v: &Value) -> Result<String, String> {
    production_hash_record_v1(kind, v)
        .map(|h| h.as_str().to_owned())
        .map_err(|_| refused())
}
struct Walker<'a, 'b> {
    source: &'a mut SourceObservation<'b>,
    exclusions: BTreeSet<String>,
    collator: ProductionCollationV1,
    cancelled: &'b AtomicBool,
    files: Vec<Value>,
    directories: Vec<Value>,
    merkle_records: Vec<String>,
    remaining: u64,
    path_bytes: usize,
}
impl Walker<'_, '_> {
    fn walk(&mut self, relative: &Path, depth: usize) -> Result<(), String> {
        check(self.cancelled)?;
        if depth > 64 {
            return Err(refused());
        }
        let mut entries = self.source.inventory_entries(relative)?;
        entries.sort_by(|a, b| self.collator.compare(&a.name, &b.name));
        for entry in entries {
            check(self.cancelled)?;
            if self.exclusions.contains(&entry.name)
                && (entry.name != "runtime" || relative.as_os_str().is_empty())
            {
                continue;
            }
            let path = relative.join(&entry.name);
            let name = path.to_str().ok_or_else(refused)?;
            // No caller-supplied escaped/traversal or display-name substitution.
            if self.files.len() + self.directories.len() >= MAX_RECORDS
                || name.contains('\\')
                || name.len() > 4096
            {
                return Err(refused());
            }
            self.path_bytes = self
                .path_bytes
                .checked_add(name.len())
                .filter(|n| *n <= 1024 * 1024)
                .ok_or_else(refused)?;
            if !entry.directory && !entry.regular {
                return Err("native_research_source_unwalked_entry_refused".into());
            }
            let metadata = self.source.inventory_probe(&path)?.ok_or_else(refused)?;
            if entry.directory {
                self.directories
                    .push(json!({"path":name,"mode":metadata.mode&0o777}));
                self.walk(&path, depth + 1)?;
            } else {
                if metadata.link_count != 1 || metadata.size > self.remaining {
                    return Err(refused());
                }
                let (digest, bytes) = self.source.archive(&path, self.remaining.max(1))?;
                if bytes != metadata.size {
                    return Err(refused());
                }
                self.remaining = self.remaining.checked_sub(bytes).ok_or_else(refused)?;
                self.merkle_records.push(format!(
                    "{name}\0{}",
                    digest.strip_prefix("sha256:").ok_or_else(refused)?
                ));
                self.files.push(
                    json!({"path":name,"mode":metadata.mode&0o777,"hash":digest,"bytes":bytes}),
                );
            }
        }
        self.source.assert_current()?;
        Ok(())
    }
}
/// Complete valid source-tree identity in the fixed bounded v1 domain. The held
/// namespace and content descriptors remain live through subsequent admission;
/// this read-only identity itself is neither a writer lease nor source authority.
pub fn inspect_native_research_source_snapshot_v1<'a>(
    request: NativeResearchSourceSnapshotRequestV1,
    cancelled: &'a AtomicBool,
    deadline: Instant,
) -> Result<NativeResearchSourceSnapshotObservationV1<'a>, String> {
    check(cancelled)?;
    if request.version != 1 || !request.source_root.is_absolute() {
        return Err(refused());
    }
    let mut source =
        SourceObservation::new_with_deadline(&request.source_root, cancelled, deadline)?;
    if source.root() != request.source_root {
        return Err(refused());
    }
    let mut exclusions = [
        ".git",
        "node_modules",
        "runtime",
        "automation-results",
        ".hepta-materialization-recovery",
        "__pycache__",
        ".pytest_cache",
        ".mypy_cache",
        ".ruff_cache",
    ]
    .into_iter()
    .map(str::to_owned)
    .collect::<BTreeSet<_>>();
    for entry in source.inventory_entries(Path::new(""))? {
        if entry.name == "venv" || entry.name == ".venv" || entry.name.starts_with(".venv-") {
            exclusions.insert(entry.name);
        }
    }
    let mut w = Walker {
        source: &mut source,
        exclusions,
        collator: ProductionCollationV1::load().map_err(|_| refused())?,
        cancelled,
        files: Vec::new(),
        directories: Vec::new(),
        merkle_records: Vec::new(),
        remaining: MAX_BYTES,
        path_bytes: 0,
    };
    w.walk(Path::new(""), 0)?;
    let source_merkle = format!(
        "sha256:{:x}",
        Sha256::digest(w.merkle_records.join("\n").as_bytes())
    );
    w.files.sort_by(|a, b| {
        w.collator.compare(
            a["path"].as_str().unwrap_or_default(),
            b["path"].as_str().unwrap_or_default(),
        )
    });
    w.directories.sort_by(|a, b| {
        w.collator.compare(
            a["path"].as_str().unwrap_or_default(),
            b["path"].as_str().unwrap_or_default(),
        )
    });
    let merkle_records = w
        .files
        .iter()
        .map(|v| {
            Ok(format!(
                "{}\0{}",
                v["path"].as_str().ok_or_else(refused)?,
                v["hash"]
                    .as_str()
                    .ok_or_else(refused)?
                    .strip_prefix("sha256:")
                    .ok_or_else(refused)?
            ))
        })
        .collect::<Result<Vec<_>, String>>()?;
    let merkle = format!(
        "sha256:{:x}",
        Sha256::digest(merkle_records.join("\n").as_bytes())
    );
    let mut manifest_records = w
        .files
        .iter()
        .map(|v| {
            Ok((
                v["path"].as_str().ok_or_else(refused)?.to_owned(),
                format!(
                    "file\0{}\0{}\0{}\0{}",
                    v["path"].as_str().ok_or_else(refused)?,
                    v["mode"].as_u64().ok_or_else(refused)?,
                    v["hash"].as_str().ok_or_else(refused)?,
                    v["bytes"].as_u64().ok_or_else(refused)?
                ),
            ))
        })
        .collect::<Result<Vec<_>, String>>()?;
    for v in &w.directories {
        let path = v["path"].as_str().ok_or_else(refused)?;
        manifest_records.push((
            path.to_owned(),
            format!(
                "directory\0{path}\0{}",
                v["mode"].as_u64().ok_or_else(refused)?
            ),
        ));
    }
    manifest_records.sort_by(|a, b| w.collator.compare(&a.0, &b.0));
    let manifest = hash(
        "WorkspaceExecutionSnapshotManifest",
        &json!({"version":1,"kind":"WorkspaceExecutionSnapshotManifest","records":manifest_records.into_iter().map(|v|v.1).collect::<Vec<_>>()}),
    )?;
    let snapshot = json!({"workspaceSnapshot":{"merkleHash":merkle,"manifestHash":manifest,"fileRecords":w.files,"directoryRecords":w.directories,"blockers":[]},"sourceMerkle":source_merkle});
    source.assert_current()?;
    check(cancelled)?;
    Ok(NativeResearchSourceSnapshotObservationV1 { source, snapshot })
}
#[cfg(test)]
mod tests;
