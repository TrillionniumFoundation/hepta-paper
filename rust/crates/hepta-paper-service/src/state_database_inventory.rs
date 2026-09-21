//! Observed live SQLite inventory. Serialized claims cannot create the opaque
//! observation type. WAL inspection operates only on a private database copy.
mod files;
mod inspection;
pub(crate) mod schema_source;
mod snapshot;
#[cfg(test)]
mod tests;
// A local observation prerequisite; production transaction ownership is not
// wired yet. Keep this internal until the owning activation path is complete.
#[allow(dead_code)]
mod transaction_guard;
#[allow(unused_imports)]
pub(crate) use transaction_guard::NativeStoreTransactionInventoryGuardV1;
mod tree;
use crate::sqlite_mutation_coordinator::{
    Result, SqliteMutationCoordinatorError as Error, error, hash, text,
};
use crate::state_backup_authority::manifest;
use serde_json::{Value, json};
use std::path::{Path, PathBuf};
fn ensure(valid: bool, code: &str) -> Result<()> {
    if valid { Ok(()) } else { Err(error(code)) }
}
/// Real file, SQLite and namespace observations, not external authority or
/// runtime readiness. All fields are private; there is no Deserialize or claim
/// constructor. The authority/activation layers must separately bind this hash.
pub struct ObservedStateDatabaseInventoryV1 {
    report: Value,
    runtime_root: PathBuf,
    manifest: Value,
    ancestors: Vec<files::Directory>,
    databases: Vec<(String, files::DatabaseObservation)>,
}
impl ObservedStateDatabaseInventoryV1 {
    pub fn value(&self) -> &Value {
        &self.report
    }
    pub fn runtime_root(&self) -> &Path {
        &self.runtime_root
    }
    /// In-crate startup recovery rechecks one actual observed instance at a time.
    /// The enclosing reconciler must compare complete fresh inventories after
    /// its authorized writes; this method does not waive that global check.
    pub(crate) fn current_database_instance(&self, instance_id: &str) -> Result<&Value> {
        for ancestor in &self.ancestors {
            ancestor.assert_current()?;
        }
        self.databases
            .iter()
            .find(|(id, _)| id == instance_id)
            .ok_or_else(|| error("autonomous_research_state_database_instance_missing"))?
            .1
            .assert_current()?;
        self.report["instances"]
            .as_array()
            .and_then(|rows| rows.iter().find(|row| row["instanceId"] == instance_id))
            .ok_or_else(|| error("autonomous_research_state_database_instance_missing"))
    }
    /// Re-observe a complete post-write inventory after SQLite recovery has
    /// legitimately appended finalization rows. The old inventory's content
    /// hashes are intentionally stale; only its directory/source namespace
    /// binding is reused before resolving fresh observations.
    pub(crate) fn reobserve_post_write_v1(&self) -> Result<Self> {
        for (_, database) in &self.databases {
            database.assert_source_namespace_current()?;
        }
        resolve(&self.runtime_root, &self.manifest, false).and_then(|resolved| {
            if resolved.report["status"] != "autonomous_research_state_database_inventory_ready" {
                return Err(error(
                    "autonomous_research_state_database_inventory_blocked",
                ));
            }
            Ok(Self {
                report: resolved.report,
                runtime_root: resolved.runtime_root,
                manifest: self.manifest.clone(),
                ancestors: resolved.ancestors,
                databases: resolved.databases,
            })
        })
    }
    pub fn assert_current(&self) -> Result<()> {
        for ancestor in &self.ancestors {
            ancestor.assert_current()?;
        }
        for (_, database) in &self.databases {
            database.assert_current()?;
        }
        let current = resolve(&self.runtime_root, &self.manifest, false)?;
        ensure(
            current.report == self.report,
            "autonomous_research_state_database_inventory_changed",
        )
    }
    /// Fixed local schema and integrity observations on a temporary private
    /// SQLite copy. This never opens the source through SQLite, so hot-journal
    /// recovery and SHM writes cannot affect the source. The result is local
    /// data, not external authority or runtime activation evidence.
    pub fn inspect_database_v1(&self, instance_id: &str) -> Result<Value> {
        self.with_database_snapshot(instance_id, |path| {
            let wal = PathBuf::from(format!("{}-wal",path.display()));
            let inspected = inspection::inspect_uri(path.to_str().ok_or_else(files::changed)?,!wal.exists())?;
            Ok(json!({"quickCheck":inspected["quickCheck"],"foreignKeyViolationCount":inspected["foreignKeyViolationCount"],"schemaHash":inspected["schemaHash"],"userVersion":inspected["userVersion"],"applicationId":inspected["applicationId"]}))
        })
    }
    /// Fixed copied-database query for the internal reconciliation chain. It
    /// cannot mutate live SQLite state or grant authority from a caller count.
    pub(crate) fn inspect_pending_finalizations_v1(&self, instance_id: &str) -> Result<Value> {
        let instance = self.current_database_instance(instance_id)?;
        let role = text(instance, "role")?;
        self.with_database_snapshot(instance_id, |path| {
            inspection::pending(path, role, instance_id)
        })
    }
    /// Trusted in-crate composition inspects a temporary private copy, removed
    /// when the callback returns. Its result is arbitrary unauthenticated data;
    /// neither a live connection nor callback data becomes verified evidence.
    /// The callback must close handles before returning; returned paths are not
    /// durable. The original source and complete inventory are checked again.
    pub(crate) fn with_database_snapshot<R>(
        &self,
        instance_id: &str,
        inspect: impl FnOnce(&Path) -> Result<R>,
    ) -> Result<R> {
        self.assert_current()?;
        let database = &self
            .databases
            .iter()
            .find(|(id, _)| id == instance_id)
            .ok_or_else(|| error("autonomous_research_state_database_instance_missing"))?
            .1;
        let result = snapshot::with_snapshot(database, inspect);
        self.assert_current()?;
        result
    }
}
struct Resolution {
    report: Value,
    runtime_root: PathBuf,
    ancestors: Vec<files::Directory>,
    databases: Vec<(String, files::DatabaseObservation)>,
}
fn resolve(runtime_root: &Path, manifest: &Value, handoff: bool) -> Result<Resolution> {
    manifest::assert_state_database_manifest_v1(manifest)?;
    // The contract fixes the ten roles; bound the variable object lists and
    // path strings before cloning definitions during namespace traversal.
    ensure(
        manifest["databases"].as_array().is_some_and(|rows| {
            rows.iter().all(|row| {
                row["requiredSchemaObjects"]
                    .as_array()
                    .is_some_and(|objects| objects.len() <= 4096)
                    && row
                        .get("relativePath")
                        .or_else(|| row.get("relativePathPattern"))
                        .and_then(Value::as_str)
                        .is_some_and(|path| path.len() <= 4096)
            })
        }) && manifest["excludedDatabases"]
            .as_array()
            .is_some_and(|rows| {
                rows.len() <= 256
                    && rows.iter().all(|row| {
                        row["relativePath"]
                            .as_str()
                            .is_some_and(|path| path.len() <= 4096)
                    })
            }),
        "autonomous_research_state_database_inventory_limit_exceeded",
    )?;
    let (runtime_root, ancestors) = files::open_root(runtime_root)?;
    let root = ancestors.last().ok_or_else(files::changed)?;
    let (candidates, mut blockers) = tree::collect(root, manifest, handoff)?;
    let initial_scope = tree::fingerprint(&candidates, &blockers);
    let mut instances = Vec::new();
    let mut observations = Vec::new();
    let mut budget = files::Budget::default();
    for candidate in &candidates {
        match inspection::candidate(root, candidate, &mut budget) {
            Ok((instance, observation)) => {
                let id = text(&instance, "instanceId")?;
                if instance["quickCheck"] != "ok" {
                    blockers.push(if handoff {
                        "autonomous_submission_handoff_state_database_quick_check_failed".into()
                    } else {
                        format!("autonomous_research_state_database_quick_check_failed:{id}")
                    });
                }
                if instance["foreignKeyViolationCount"].as_i64() != Some(0) {
                    blockers.push(if handoff {
                        "autonomous_submission_handoff_state_database_foreign_key_check_failed"
                            .into()
                    } else {
                        format!("autonomous_research_state_database_foreign_key_check_failed:{id}")
                    });
                }
                let missing = instance["missingSchemaObjects"]
                    .as_array()
                    .ok_or_else(files::changed)?;
                if !missing.is_empty() {
                    let objects = missing
                        .iter()
                        .filter_map(Value::as_str)
                        .collect::<Vec<_>>()
                        .join(",");
                    blockers.push(if handoff{format!("autonomous_submission_handoff_state_database_schema_contract_mismatch:{objects}")}else{format!("autonomous_research_state_database_schema_contract_mismatch:{id}:{}:{objects}",text(&instance,"schemaContractId")?)});
                }
                observations.push((id.to_owned(), observation));
                instances.push(instance);
            }
            Err(cause) => blockers.push(if handoff {
                format!("autonomous_submission_handoff_state_database_inspection_failed:{cause}")
            } else {
                format!(
                    "autonomous_research_state_database_inspection_failed:{}:{cause}",
                    text(&candidate.definition, "role")?
                )
            }),
        }
    }
    for ancestor in &ancestors {
        ancestor.assert_current()?;
    }
    for (_, observation) in &observations {
        observation.assert_current()?;
    }
    let (last_candidates, last_blockers) = tree::collect(root, manifest, handoff)?;
    ensure(
        initial_scope == tree::fingerprint(&last_candidates, &last_blockers),
        "autonomous_research_state_database_changed_during_snapshot",
    )?;
    let collator = hepta_legacy_compatibility::ProductionCollationV1::load()
        .map_err(|e| error(e.to_string()))?;
    instances.sort_by(|a, b| {
        collator.compare(
            a["instanceId"].as_str().unwrap_or_default(),
            b["instanceId"].as_str().unwrap_or_default(),
        )
    });
    blockers.sort_by(|a, b| a.encode_utf16().cmp(b.encode_utf16()));
    blockers.dedup();
    let source_manifest_hash = manifest::state_database_manifest_hash_v1(manifest)?;
    let manifest_hash = if handoff {
        hash(
            "AutonomousSubmissionHandoffStateDatabaseManifestProjection",
            &json!({"sourceManifestHash":source_manifest_hash,"database":manifest["databases"].as_array().and_then(|a|a.iter().find(|d|d["role"]=="submission-handoff"&&d["cardinality"]=="singleton")).ok_or_else(files::changed)?}),
        )?
    } else {
        source_manifest_hash
    };
    let scope = if instances.is_empty() {
        Value::Null
    } else {
        json!(manifest::state_database_scope_hash_v1(&json!(instances))?)
    };
    let ready = blockers.is_empty();
    let manifest_id = if handoff {
        format!("{}:submission-handoff", text(manifest, "manifestId")?)
    } else {
        text(manifest, "manifestId")?.to_owned()
    };
    let mut report = json!({"version":1,"kind":"AutonomousResearchStateDatabaseInventory","status":if ready{"autonomous_research_state_database_inventory_ready"}else{"autonomous_research_state_database_inventory_blocked"},"manifestId":manifest_id,"manifestHash":manifest_hash,"databaseScopeHash":scope,"instances":instances,"blockers":blockers});
    report["inventoryHash"] = if ready {
        json!(hash(
            "AutonomousResearchStateDatabaseInventory",
            &json!({"manifestId":report["manifestId"],"manifestHash":report["manifestHash"],"databaseScopeHash":report["databaseScopeHash"],"instances":report["instances"]})
        )?)
    } else {
        Value::Null
    };
    Ok(Resolution {
        report,
        runtime_root,
        ancestors,
        databases: observations,
    })
}
/// Inspect one registered path through the same descriptor-pinned private
/// snapshot used by the inventory. Callers receive no live database handle.
pub(crate) fn with_database_snapshot_path_v1<R>(
    runtime_root: &Path,
    relative: &Path,
    role: &str,
    inspect: impl FnOnce(&Path) -> std::result::Result<R, String>,
) -> Result<R> {
    let (_, ancestors) = files::open_root(runtime_root)?;
    let root = ancestors.last().ok_or_else(files::changed)?;
    let mut budget = files::Budget::default();
    let observation = files::DatabaseObservation::observe(root, relative, role, &mut budget)?;
    let result =
        snapshot::with_main_only_snapshot(&observation, |path| inspect(path).map_err(error))?;
    observation.assert_current()?;
    for ancestor in ancestors {
        ancestor.assert_current()?;
    }
    Ok(result)
}

/// Produces the legacy ready/blocked report from actual observed state. This
/// serialized report alone is not a verified observation capability.
pub fn inspect_state_database_inventory_v1(runtime_root: &Path, manifest: &Value) -> Result<Value> {
    Ok(resolve(runtime_root, manifest, false)?.report)
}
pub fn inspect_submission_handoff_inventory_v1(
    runtime_root: &Path,
    manifest: &Value,
) -> Result<Value> {
    Ok(resolve(runtime_root, manifest, true)?.report)
}
/// Resolves the complete manifest, registered and unknown namespaces, source
/// bytes and effective SQLite state. Blocked reports never create this type.
pub fn observe_state_database_inventory_v1(
    runtime_root: &Path,
    manifest: &Value,
) -> Result<ObservedStateDatabaseInventoryV1> {
    let resolved = resolve(runtime_root, manifest, false)?;
    if resolved.report["status"] != "autonomous_research_state_database_inventory_ready" {
        let mut failure = error("autonomous_research_state_database_inventory_blocked");
        failure.details = json!({"inventory":resolved.report});
        return Err(failure);
    }
    Ok(ObservedStateDatabaseInventoryV1 {
        report: resolved.report,
        runtime_root: resolved.runtime_root,
        manifest: manifest.clone(),
        ancestors: resolved.ancestors,
        databases: resolved.databases,
    })
}
