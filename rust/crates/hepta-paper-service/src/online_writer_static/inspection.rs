use super::*;
use crate::sqlite_mutation_coordinator::manifest::writer_manifest_hash_v1;
use nix::fcntl::OFlag;
use sha2::{Digest, Sha256};
use std::{
    fs::{Metadata, OpenOptions},
    io::Read,
    os::unix::fs::{MetadataExt, OpenOptionsExt},
    path::{Path, PathBuf},
};
#[derive(Clone)]
struct Source {
    path: PathBuf,
    identity: (u64, u64, u32, u64, u64, i64, i64, i64, i64),
    hash: String,
}
fn identity(s: &Metadata) -> (u64, u64, u32, u64, u64, i64, i64, i64, i64) {
    (
        s.dev(),
        s.ino(),
        s.mode(),
        s.nlink(),
        s.len(),
        s.mtime(),
        s.mtime_nsec(),
        s.ctime(),
        s.ctime_nsec(),
    )
}
fn read_source(path: &Path) -> Result<(String, Source)> {
    let fail = || error("autonomous_research_online_writer_source_not_regular");
    let mut file = OpenOptions::new()
        .read(true)
        .custom_flags(OFlag::O_NOFOLLOW.bits() | OFlag::O_CLOEXEC.bits() | OFlag::O_NONBLOCK.bits())
        .open(path)
        .map_err(|_| fail())?;
    let before = file.metadata().map_err(|_| fail())?;
    if !before.is_file() || before.len() > 16 * 1024 * 1024 {
        return Err(fail());
    }
    let mut bytes = Vec::new();
    file.by_ref()
        .take(16 * 1024 * 1024 + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| fail())?;
    let after = file.metadata().map_err(|_| fail())?;
    let named = std::fs::symlink_metadata(path).map_err(|_| fail())?;
    if bytes.len() > 16 * 1024 * 1024
        || identity(&before) != identity(&after)
        || identity(&after) != identity(&named)
        || named.file_type().is_symlink()
    {
        return Err(error(
            "autonomous_research_online_writer_source_changed_during_scan",
        ));
    }
    Ok((
        String::from_utf8_lossy(&bytes).into_owned(),
        Source {
            path: path.into(),
            identity: identity(&after),
            hash: format!("sha256:{}", hex::encode(Sha256::digest(&bytes))),
        },
    ))
}

fn modules(root: &Path) -> Result<Vec<PathBuf>> {
    if !root.exists() {
        return Ok(vec![]);
    }
    fn visit(directory: &Path, out: &mut Vec<PathBuf>) -> Result<()> {
        for entry in std::fs::read_dir(directory).map_err(|e| error(e.to_string()))? {
            let entry = entry.map_err(|e| error(e.to_string()))?;
            let kind = entry.file_type().map_err(|e| error(e.to_string()))?;
            if kind.is_symlink() {
                continue;
            }
            if kind.is_dir() {
                visit(&entry.path(), out)?;
            } else if kind.is_file() && entry.path().extension().is_some_and(|s| s == "mjs") {
                out.push(entry.path());
            }
            if out.len() > 20000 {
                return Err(error("autonomous_research_online_writer_source_scan_limit"));
            }
        }
        Ok(())
    }
    let mut out = Vec::new();
    visit(root, &mut out)?;
    out.sort_by(|a, b| {
        a.to_string_lossy()
            .encode_utf16()
            .cmp(b.to_string_lossy().encode_utf16())
    });
    Ok(out)
}
fn relative(root: &Path, path: &Path) -> Result<String> {
    path.strip_prefix(root)
        .ok()
        .and_then(Path::to_str)
        .map(str::to_owned)
        .ok_or_else(|| error("autonomous_research_online_writer_source_path_invalid"))
}
fn tagged(path: &str, value: &Value) -> Value {
    let mut row = json!({"sourceFile":path});
    if let (Some(out), Some(input)) = (row.as_object_mut(), value.as_object()) {
        out.extend(input.clone());
    }
    row
}
fn inspect(root: &Path, manifest: &Value) -> Result<(Value, Vec<Source>)> {
    let manifest_hash = writer_manifest_hash_v1(manifest)?;
    let config = config()?;
    let root = if root.is_absolute() {
        root.to_owned()
    } else {
        std::env::current_dir()
            .map_err(|e| error(e.to_string()))?
            .join(root)
    };
    let operations = manifest["operations"]
        .as_array()
        .ok_or_else(|| error("autonomous_research_online_writer_operation_manifest_invalid"))?;
    let declared = operations
        .iter()
        .filter_map(|o| Some((o["sourceFile"].as_str()?, o["entrypoint"].as_str()?)))
        .collect::<BTreeSet<_>>();
    let mut discovered = Vec::new();
    let mut bindings = Vec::new();
    let mut violations = Vec::new();
    let mut excluded = Vec::new();
    let mut blockers = Vec::new();
    let mut all_functions = BTreeMap::new();
    let mut sources = BTreeMap::<String, Source>::new();
    for scan in strings(&config["SCAN_ROOTS"]) {
        for path in modules(&root.join(scan))? {
            let relative = relative(&root, &path)?;
            let (text, source) = read_source(&path)?;
            let inspection = discover_online_writer_mutation_entrypoints_v1(&relative, &text)?;
            if let Some(reason) = inspection["exclusionReason"].as_str() {
                excluded.push(json!({"sourceFile":relative,"reason":reason}));
            }
            excluded.extend(
                inspection["excludedEntrypoints"]
                    .as_array()
                    .into_iter()
                    .flatten()
                    .cloned(),
            );
            all_functions.insert(
                relative.clone(),
                strings(&inspection["allFunctions"])
                    .into_iter()
                    .map(str::to_owned)
                    .collect::<BTreeSet<_>>(),
            );
            if !strings(&inspection["entrypoints"]).is_empty()
                || !inspection["exclusionReason"].is_null()
                || inspection["excludedEntrypoints"]
                    .as_array()
                    .is_some_and(|a| !a.is_empty())
            {
                sources.insert(relative.clone(), source);
            }
            for entrypoint in strings(&inspection["entrypoints"]) {
                discovered.push(json!({"sourceFile":relative,"entrypoint":entrypoint}));
            }
            for binding in inspection["coordinatorBindings"]
                .as_array()
                .into_iter()
                .flatten()
            {
                bindings.push(tagged(&relative, binding));
            }
            for violation in inspection["callbackBoundaryViolations"]
                .as_array()
                .into_iter()
                .flatten()
            {
                violations.push(tagged(&relative, violation));
            }
        }
    }
    for relative in js_sorted(
        strings(&config["PROVENANCE_ONLY_SOURCES"])
            .into_iter()
            .map(str::to_owned)
            .collect(),
    ) {
        let path = root.join(&relative);
        if !path.exists() {
            blockers.push(format!(
                "autonomous_research_online_writer_provenance_source_missing:{relative}"
            ));
        } else {
            sources.insert(relative, read_source(&path)?.1);
        }
    }
    let migration_root =
        root.join(config["SQL_MIGRATION_ROOT"].as_str().ok_or_else(|| {
            error("autonomous_research_online_writer_static_configuration_invalid")
        })?);
    if migration_root.exists() {
        let mut migrations = std::fs::read_dir(&migration_root)
            .map_err(|e| error(e.to_string()))?
            .map(|e| e.map(|e| e.path()))
            .collect::<std::io::Result<Vec<_>>>()
            .map_err(|e| error(e.to_string()))?;
        migrations.retain(|p| p.extension().is_some_and(|e| e == "sql"));
        migrations.sort();
        let name_pattern =
            regex::Regex::new(r"^\d{3}_[a-z0-9_]+\.sql$").map_err(|e| error(e.to_string()))?;
        for path in migrations {
            let relative = relative(&root, &path)?;
            let name = path
                .file_name()
                .and_then(|s| s.to_str())
                .ok_or_else(|| error("autonomous_research_online_writer_source_path_invalid"))?;
            if !name_pattern.is_match(name) {
                blockers.push(format!(
                    "autonomous_research_online_writer_migration_filename_invalid:{relative}"
                ));
                continue;
            }
            let (text, source) = read_source(&path)?;
            let entrypoint = format!(
                "migration{}",
                name.strip_suffix(".sql").ok_or_else(|| error(
                    "autonomous_research_online_writer_source_path_invalid"
                ))?
            );
            all_functions.insert(relative.clone(), BTreeSet::from([entrypoint.clone()]));
            sources.insert(relative.clone(), source);
            if mutation_sql(&text)? {
                discovered.push(json!({"sourceFile":relative,"entrypoint":entrypoint}));
            }
        }
    }
    for violation in &violations {
        blockers.push(format!("autonomous_research_online_writer_mutate_callback_capability_bypass:{}:{}:{}:{}:{}:{}:{}",violation["sourceFile"].as_str().unwrap_or_default(),violation["entrypoint"].as_str().unwrap_or_default(),violation["operationId"].as_str().unwrap_or("unknown-operation"),violation["capabilityBinding"].as_str().unwrap_or_default(),violation["method"].as_str().unwrap_or_default(),violation["line"],violation["column"]));
    }
    for operation in operations {
        let source = operation["sourceFile"]
            .as_str()
            .ok_or_else(|| error("autonomous_research_online_writer_operation_invalid"))?;
        let entry = operation["entrypoint"]
            .as_str()
            .ok_or_else(|| error("autonomous_research_online_writer_operation_invalid"))?;
        let path = root.join(source);
        if !path.exists() {
            blockers.push(format!(
                "autonomous_research_online_writer_source_missing:{source}"
            ));
            continue;
        }
        if !sources.contains_key(source) {
            sources.insert(source.into(), read_source(&path)?.1);
        }
        if !all_functions
            .get(source)
            .is_some_and(|set| set.contains(entry))
        {
            blockers.push(format!(
                "autonomous_research_online_writer_entrypoint_missing:{source}:{entry}"
            ));
        }
    }
    for row in &discovered {
        let source = row["sourceFile"].as_str().unwrap_or_default();
        let entry = row["entrypoint"].as_str().unwrap_or_default();
        if !declared.contains(&(source, entry)) {
            blockers.push(format!(
                "autonomous_research_online_writer_mutation_unregistered:{source}:{entry}"
            ));
        }
    }
    for binding in &bindings {
        let operation = operations
            .iter()
            .find(|o| o["operationId"] == binding["operationId"]);
        if !operation.is_some_and(|o| {
            o["databaseRole"] == binding["databaseRole"]
                && o["sourceFile"] == binding["sourceFile"]
                && o["entrypoint"] == binding["entrypoint"]
                && o["coordinatorIntegrated"] == true
        }) {
            blockers.push(format!(
                "autonomous_research_online_writer_coordinator_binding_invalid:{}:{}",
                binding["sourceFile"].as_str().unwrap_or_default(),
                binding["entrypoint"].as_str().unwrap_or_default()
            ));
        }
    }
    for operation in operations {
        if operation["coordinatorIntegrated"] == true
            && bindings
                .iter()
                .filter(|b| {
                    ["sourceFile", "entrypoint", "databaseRole", "operationId"]
                        .iter()
                        .all(|k| b[k] == operation[k])
                })
                .count()
                != 1
        {
            blockers.push(format!(
                "autonomous_research_online_writer_coordinator_binding_required:{}",
                operation["operationId"].as_str().unwrap_or_default()
            ));
        }
        if !discovered.iter().any(|row| {
            row["sourceFile"] == operation["sourceFile"]
                && row["entrypoint"] == operation["entrypoint"]
        }) {
            blockers.push(format!(
                "autonomous_research_online_writer_declared_operation_not_discovered:{}",
                operation["operationId"].as_str().unwrap_or_default()
            ));
        }
    }
    let collator = hepta_legacy_compatibility::ProductionCollationV1::load()
        .map_err(|e| error(e.to_string()))?;
    let mut provenance = sources
        .iter()
        .map(|(path, source)| json!({"sourceFile":path,"sourceHash":source.hash}))
        .collect::<Vec<_>>();
    provenance.sort_by(|a, b| {
        collator.compare(
            a["sourceFile"].as_str().unwrap_or_default(),
            b["sourceFile"].as_str().unwrap_or_default(),
        )
    });
    let order = |a: &Value, b: &Value| {
        collator
            .compare(
                a["sourceFile"].as_str().unwrap_or_default(),
                b["sourceFile"].as_str().unwrap_or_default(),
            )
            .then_with(|| {
                collator.compare(
                    a["entrypoint"].as_str().unwrap_or_default(),
                    b["entrypoint"].as_str().unwrap_or_default(),
                )
            })
    };
    discovered.sort_by(order);
    bindings.sort_by(|a, b| {
        order(a, b).then_with(|| {
            collator.compare(
                a["operationId"].as_str().unwrap_or("null"),
                b["operationId"].as_str().unwrap_or("null"),
            )
        })
    });
    violations.sort_by(|a, b| {
        order(a, b)
            .then_with(|| a["line"].as_u64().cmp(&b["line"].as_u64()))
            .then_with(|| a["column"].as_u64().cmp(&b["column"].as_u64()))
    });
    excluded.sort_by(|a, b| {
        collator.compare(
            a["sourceFile"].as_str().unwrap_or_default(),
            b["sourceFile"].as_str().unwrap_or_default(),
        )
    });
    blockers = js_sorted(
        blockers
            .into_iter()
            .collect::<BTreeSet<_>>()
            .into_iter()
            .collect(),
    );
    let mut payload = json!({"version":1,"kind":"AutonomousResearchOnlineWriterStaticCoverageInspection","status":if blockers.is_empty(){"autonomous_research_online_writer_static_coverage_complete"}else{"autonomous_research_online_writer_static_coverage_blocked"},"inspectionSource":"repository-ast-import-gate-v1","manifestHash":manifest_hash,"coveredDatabaseRoles":manifest["coverage"]["coveredDatabaseRoles"],"operationCount":operations.len(),"operationIds":js_sorted(operations.iter().filter_map(|o|o["operationId"].as_str().map(str::to_owned)).collect()),"discoveredMutationEntrypoints":discovered,"coordinatorBindings":bindings,"callbackBoundaryViolations":violations,"codeProvenanceHash":hash("AutonomousResearchOnlineWriterCodeProvenance",&json!(provenance))?,"codeProvenanceSources":provenance,"excludedCandidates":excluded,"blockers":blockers});
    payload["astGateReceiptHash"] = json!(hash(
        "AutonomousResearchOnlineWriterStaticCoverageInspection",
        &payload
    )?);
    for source in sources.values() {
        source.assert_current()?;
    }
    Ok((payload, sources.into_values().collect()))
}
impl Source {
    fn assert_current(&self) -> Result<()> {
        let (_, current) = read_source(&self.path)?;
        if current.identity != self.identity || current.hash != self.hash {
            return Err(error(
                "autonomous_research_online_writer_source_changed_during_scan",
            ));
        }
        Ok(())
    }
}
/// Actual source scan result. Blocked scans remain inspectable but cannot mint
/// the opaque completed evidence returned by `verify_online_writer_static_coverage_v1`.
pub fn inspect_online_writer_static_coverage_v1(
    workspace_root: &Path,
    manifest: &Value,
) -> Result<Value> {
    inspect(workspace_root, manifest).map(|(value, _)| value)
}
pub struct VerifiedWriterStaticCoverageV1 {
    value: Value,
    root: PathBuf,
    manifest: Value,
    sources: Vec<Source>,
}
impl VerifiedWriterStaticCoverageV1 {
    pub fn value(&self) -> &Value {
        &self.value
    }
    pub fn assert_current(&self) -> Result<()> {
        for source in &self.sources {
            source.assert_current()?;
        }
        let current = inspect_online_writer_static_coverage_v1(&self.root, &self.manifest)?;
        if current != self.value {
            return Err(error(
                "autonomous_research_online_writer_source_changed_during_scan",
            ));
        }
        Ok(())
    }
}
pub fn verify_online_writer_static_coverage_v1(
    workspace_root: &Path,
    manifest: &Value,
) -> Result<VerifiedWriterStaticCoverageV1> {
    let (value, sources) = inspect(workspace_root, manifest)?;
    if value["status"] != "autonomous_research_online_writer_static_coverage_complete"
        || !value["blockers"].as_array().is_some_and(Vec::is_empty)
    {
        return Err(error(
            "autonomous_research_online_writer_static_coverage_required",
        ));
    }
    let root = if workspace_root.is_absolute() {
        workspace_root.to_owned()
    } else {
        std::env::current_dir()
            .map_err(|e| error(e.to_string()))?
            .join(workspace_root)
    };
    Ok(VerifiedWriterStaticCoverageV1 {
        value,
        root,
        manifest: manifest.clone(),
        sources,
    })
}

#[cfg(test)]
mod non_regular_source_tests {
    use super::*;
    use nix::{sys::stat::Mode, unistd::mkfifo};
    use std::{sync::mpsc, time::Duration};

    #[test]
    fn writer_source_fifos_and_directories_are_rejected_without_waiting_for_a_writer() {
        let root = std::env::temp_dir().join(format!(
            "hepta-writer-nonregular-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir(&root).unwrap();
        assert_eq!(
            read_source(&root).err().unwrap().code,
            "autonomous_research_online_writer_source_not_regular"
        );
        for replacement in [false, true] {
            let path = root.join(if replacement {
                "replaced.mjs"
            } else {
                "provenance.mjs"
            });
            if replacement {
                std::fs::write(
                    &path,
                    "// A regular file discovered by a prior directory scan.",
                )
                .unwrap();
                assert!(std::fs::symlink_metadata(&path).unwrap().is_file());
                std::fs::remove_file(&path).unwrap();
            }
            mkfifo(&path, Mode::S_IRUSR | Mode::S_IWUSR).unwrap();
            let reader_path = path.clone();
            let (sender, receiver) = mpsc::channel();
            let reader = std::thread::spawn(move || {
                sender
                    .send(read_source(&reader_path).err().map(|e| e.code))
                    .unwrap();
            });
            let result = receiver.recv_timeout(Duration::from_secs(2));
            // Unblock an old blocking-open implementation before asserting so a
            // regression fails finitely and does not leak a waiting test thread.
            let rescue = result.is_err().then(|| {
                OpenOptions::new()
                    .read(true)
                    .write(true)
                    .custom_flags(OFlag::O_NONBLOCK.bits())
                    .open(&path)
                    .unwrap()
            });
            reader.join().unwrap();
            drop(rescue);
            std::fs::remove_file(&path).unwrap();
            assert_eq!(
                result.unwrap(),
                Some("autonomous_research_online_writer_source_not_regular".into())
            );
        }
        std::fs::remove_dir(root).unwrap();
    }
}
