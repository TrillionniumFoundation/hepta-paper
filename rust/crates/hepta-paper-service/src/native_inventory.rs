//! Ordinary bounded inventory reconstruction from actual SQLite and held source
//! files. Caller-supplied PaperTask summaries are never accepted. This read-only
//! observation grants neither scientific acceptance nor publication authority.
use crate::runtime_source_cas::observation::{SharedInventoryReadBudgetV1, SourceObservation};
use hepta_readonly_store::{
    FixedInventoryBudgetV1, FixedInventoryProjectionV1, OrdinaryReadOnlyStoreV1, ReadOnlyStoreV1,
};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::{
    path::PathBuf,
    sync::{Arc, atomic::AtomicBool},
    time::{Instant, SystemTime, UNIX_EPOCH},
};

mod paper;
mod sources;
mod values;

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct NativeInventoryRequestV1 {
    pub version: u8,
    pub root: PathBuf,
    pub database: Option<PathBuf>,
    #[serde(default = "auto")]
    pub inventory_source: String,
    #[serde(default = "yes")]
    pub include_loose_drafts: bool,
    #[serde(default)]
    pub include_retired: bool,
    #[serde(default)]
    pub include_quarantined: bool,
    #[serde(default = "yes")]
    pub include_proposal_staging: bool,
    pub proposal_staging_root: Option<PathBuf>,
    #[serde(default)]
    pub paper_ids: Vec<String>,
    pub limit: Option<f64>,
    pub observed_at: Option<String>,
}
fn yes() -> bool {
    true
}
fn auto() -> String {
    "auto".to_owned()
}

/// Keep this owner alive across command construction and recheck immediately
/// before consuming its output. A scan is an observation, never a filesystem
/// snapshot, write lease or an authority receipt.
pub struct NativeInventoryObservationV1<'a> {
    scan: Value,
    source: SourceObservation<'a>,
    store: Option<InventoryStoreV1>,
    database_observation: Option<SourceObservation<'a>>,
    staging_observation: Option<SourceObservation<'a>>,
}
enum InventoryStoreV1 {
    Ordinary(Box<OrdinaryReadOnlyStoreV1>),
    Immutable(Box<ReadOnlyStoreV1>),
}
impl InventoryStoreV1 {
    fn verify_unchanged(&self) -> Result<(), hepta_readonly_store::ReadOnlyStoreError> {
        match self {
            Self::Ordinary(store) => store.verify_unchanged(),
            Self::Immutable(store) => store.verify_unchanged(),
        }
    }
    fn projection(
        &self,
        cancelled: &Arc<AtomicBool>,
        deadline: Instant,
    ) -> Result<FixedInventoryProjectionV1, hepta_readonly_store::ReadOnlyStoreError> {
        match self {
            Self::Ordinary(store) => {
                store.fixed_inventory_projection_v1(&FixedInventoryBudgetV1::default())
            }
            Self::Immutable(store) => store.fixed_inventory_projection_with_cancellation_v1(
                &FixedInventoryBudgetV1::default(),
                Arc::clone(cancelled),
                deadline,
            ),
        }
    }
}

impl NativeInventoryObservationV1<'_> {
    pub fn scan(&self) -> &Value {
        &self.scan
    }
    pub fn verify_unchanged(&self) -> Result<(), String> {
        self.source.assert_current()?;
        if let Some(staging) = &self.staging_observation {
            staging.assert_current()?;
        }
        check_combined_source_budget(&self.source, self.staging_observation.as_ref())?;
        if let Some(database) = &self.database_observation {
            database.assert_current()?;
        }
        if let Some(store) = &self.store {
            store.verify_unchanged().map_err(|e| e.to_string())?;
        }
        self.source.assert_current()
    }
}

fn check_combined_source_budget(
    source: &SourceObservation<'_>,
    staged: Option<&SourceObservation<'_>>,
) -> Result<(), String> {
    let bytes = source.inventory_read_bytes()?.checked_add(
        staged
            .map(SourceObservation::inventory_read_bytes)
            .transpose()?
            .unwrap_or(0),
    );
    if bytes.is_some_and(|bytes| bytes <= 1024 * 1024 * 1024) {
        Ok(())
    } else {
        Err("native_inventory_aggregate_source_limit_exceeded".to_owned())
    }
}

/// Versioned native bounds remain stricter than unbounded incumbent discovery:
/// fixed SQL rows/cells/output, 16,384 observed entries / 64 components / 1 GiB
/// streamed files, 256 KiB per registry/contract, 16 MiB complete scan. Child
/// aliases, special/hardlinked read inputs, out-of-root sources and namespace
/// drift fail closed. These explicit refusals keep the route partial.
pub fn discover_native_inventory_v1<'a>(
    request: &NativeInventoryRequestV1,
    cancelled: &'a Arc<AtomicBool>,
    deadline: Instant,
) -> Result<NativeInventoryObservationV1<'a>, String> {
    discover_inventory(request, cancelled, deadline, false)
}

/// Normal batch uses the incumbent immutable/no-sidecar boundary. Its strict
/// known-installed schema profile grants no authority and never adopts records.
pub(crate) fn discover_native_immutable_batch_inventory_v1<'a>(
    request: &NativeInventoryRequestV1,
    cancelled: &'a Arc<AtomicBool>,
    deadline: Instant,
) -> Result<NativeInventoryObservationV1<'a>, String> {
    discover_inventory(request, cancelled, deadline, true)
}

fn discover_inventory<'a>(
    request: &NativeInventoryRequestV1,
    cancelled: &'a Arc<AtomicBool>,
    deadline: Instant,
    immutable_batch: bool,
) -> Result<NativeInventoryObservationV1<'a>, String> {
    if request.version != 1 || !request.root.is_absolute() || request.paper_ids.len() > 1024 {
        return Err("native_inventory_request_invalid".to_owned());
    }
    if std::fs::symlink_metadata(&request.root)
        .map_err(|e| e.to_string())?
        .file_type()
        .is_symlink()
    {
        return Err("native_inventory_root_alias_refused".to_owned());
    }
    let mut source = SourceObservation::new_with_deadline(&request.root, cancelled, deadline)?;
    let shared_read_budget = SharedInventoryReadBudgetV1::new();
    shared_read_budget.attach(&mut source)?;
    if source.root() != request.root {
        return Err("native_inventory_root_requires_physical_path".to_owned());
    }
    let mut database_observation = None;
    let mut missing_store = false;
    let store = if request.inventory_source == "yaml" && !immutable_batch {
        None
    } else if let Some(path) = &request.database {
        if !path.is_absolute() {
            return Err("native_inventory_database_path_invalid".to_owned());
        }
        let path = values::lexical(path);
        let parent = path
            .parent()
            .ok_or("native_inventory_database_path_invalid")?;
        let existing = parent
            .ancestors()
            .find(|p| std::fs::symlink_metadata(p).is_ok())
            .ok_or("native_inventory_database_path_invalid")?;
        let mut observed = SourceObservation::new_with_deadline(existing, cancelled, deadline)?;
        if observed.root() != existing {
            return Err("native_inventory_database_alias_refused".to_owned());
        }
        let relative = path
            .strip_prefix(existing)
            .map_err(|_| "native_inventory_database_path_invalid")?;
        let found = observed.inventory_probe(relative)?;
        let store = if found.is_some() {
            if immutable_batch {
                for suffix in ["-wal", "-shm", "-journal"] {
                    let mut sidecar = relative.as_os_str().to_owned();
                    sidecar.push(suffix);
                    if observed
                        .inventory_probe(std::path::Path::new(&sidecar))?
                        .is_some()
                    {
                        return Err("native_batch_inventory_immutable_sidecar_present".to_owned());
                    }
                }
                observed.assert_current()?;
                let immutable = ReadOnlyStoreV1::open_known_installed_with_cancellation_v1(
                    &path,
                    Arc::clone(cancelled),
                    deadline,
                )
                .map_err(|e| e.to_string())?;
                if immutable.schema_version() != 25 {
                    return Err("native_batch_inventory_schema25_required".to_owned());
                }
                Some(InventoryStoreV1::Immutable(Box::new(immutable)))
            } else {
                Some(InventoryStoreV1::Ordinary(Box::new(
                    OrdinaryReadOnlyStoreV1::open_with_cancellation(
                        &path,
                        Arc::clone(cancelled),
                        deadline,
                    )
                    .map_err(|e| e.to_string())?,
                )))
            }
        } else {
            missing_store = true;
            None
        };
        observed.assert_current()?;
        database_observation = Some(observed);
        store
    } else {
        None
    };
    let projection = if request.inventory_source == "yaml" {
        // Normal bootstrap still admits and holds the immutable database;
        // the actual YAML reader alone skips the fixed business queries.
        None
    } else {
        store
            .as_ref()
            .map(|store| store.projection(cancelled, deadline))
            .transpose()
            .map_err(|e| e.to_string())?
    };
    // The actual native Node store throws query failures. Empty successful
    // results can fall back to YAML, but malformed/schema-failed SQL cannot.
    if let Some(projection) = &projection
        && let Some(error) = projection
            .papers
            .error
            .as_ref()
            .or(projection.venues.error.as_ref())
    {
        return Err(error.clone());
    }
    let mut registry = sources::read(
        &mut source,
        &request.inventory_source,
        projection.as_ref(),
        missing_store,
    )?;
    for paper in &registry.papers {
        for name in ["metadata_json", "ledger_evidence_json"] {
            if let Some(value) = paper.coerced.get(name) {
                let _ = values::native_json(values::js_string(value).as_bytes())?;
            }
        }
    }
    let requested = request
        .paper_ids
        .iter()
        .map(|id| values::text(&Value::String(id.clone())))
        .filter(|id| !id.is_empty())
        .collect::<std::collections::BTreeSet<_>>();
    let mut known = registry
        .papers
        .iter()
        .map(|paper| values::field_text(&paper.coerced, "slug"))
        .filter(|id| !id.is_empty())
        .collect::<std::collections::BTreeSet<_>>();
    if request.include_loose_drafts {
        for paper in paper::loose_drafts(&mut source, &known)? {
            known.insert(values::field_text(&paper, "slug"));
            registry.papers.push(sources::PaperRecordV1::plain(paper));
        }
    }
    let staging = request.proposal_staging_root.clone().unwrap_or_else(|| {
        request
            .root
            .join("hepta-paper-workspace/runtime/proposal-staging")
    });
    let mut staging_observation = None;
    let staged = if request.include_proposal_staging {
        if staging.starts_with(&request.root) {
            paper::proposal_staging(&mut source, &staging, &mut known, &request.root)?
        } else {
            // The ordinary caller's runtime is already selected by its actual
            // DB path. Only that fixed proposal/proposal-staging namespace is
            // admitted outside the asset root, under a separate held owner.
            let runtime = request
                .database
                .as_ref()
                .and_then(|path| path.parent())
                .ok_or("native_inventory_external_runtime_binding_required")?;
            if !runtime.is_absolute()
                || values::lexical(runtime) != runtime
                || staging != runtime.join("proposal-staging")
            {
                return Err("native_inventory_external_runtime_binding_invalid".to_owned());
            }
            let common = request
                .root
                .ancestors()
                .find(|parent| runtime.starts_with(parent))
                .ok_or("native_inventory_external_runtime_binding_invalid")?;
            let mut held = SourceObservation::new_with_deadline(common, cancelled, deadline)?;
            shared_read_budget.attach(&mut held)?;
            if held.root() != common {
                return Err("native_inventory_runtime_alias_refused".to_owned());
            }
            let rows = paper::proposal_staging(&mut held, &staging, &mut known, &request.root)?;
            held.assert_current()?;
            staging_observation = Some(held);
            rows
        }
    } else {
        Vec::new()
    };
    let staged_count = staged.len();
    registry
        .papers
        .extend(staged.into_iter().map(sources::PaperRecordV1::plain));
    if registry.papers.len() > 1024 {
        return Err("native_inventory_rows_v1_exceeded".to_owned());
    }
    if !request.include_retired {
        registry
            .papers
            .retain(|p| values::field_text(&p.coerced, "status") != "retired_stale");
    }
    let quarantine = registry
        .papers
        .iter()
        .filter_map(|p| {
            paper::quarantine_reason(source.root(), &p.coerced).map(|reason| (p.clone(), reason))
        })
        .collect::<Vec<_>>();
    if !request.include_quarantined {
        let ids = quarantine
            .iter()
            .map(|(p, _)| values::field_text(&p.coerced, "slug"))
            .collect::<std::collections::BTreeSet<_>>();
        registry
            .papers
            .retain(|p| !ids.contains(&values::field_text(&p.coerced, "slug")));
    }
    if !requested.is_empty() {
        registry
            .papers
            .retain(|p| requested.contains(&values::field_text(&p.coerced, "slug")));
    }
    if let Some(limit) = request.limit.filter(|n| n.is_finite() && *n > 0.0) {
        registry.papers.truncate(limit.trunc() as usize);
    }
    let observed = match &request.observed_at {
        Some(value) if !value.is_empty() => value.clone(),
        _ => {
            let millis = SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .map_err(|_| "native_inventory_clock")?
                .as_millis();
            crate::sqlite_mutation_coordinator::clock::iso(
                i64::try_from(millis).map_err(|_| "native_inventory_clock")?,
            )
            .map_err(|_| "native_inventory_clock")?
        }
    };
    let mut rows = Vec::new();
    let mut remaining = 16 * 1024 * 1024;
    for input in registry.papers {
        if Instant::now() >= deadline {
            return Err("native_inventory_deadline_exceeded".to_owned());
        }
        let staged = values::field_text(&input.coerced, "inventory_source") == "proposal_staging";
        let selected = if staged {
            staging_observation.as_mut().unwrap_or(&mut source)
        } else {
            &mut source
        };
        let mut row = paper::discover(selected, input, &observed, &mut remaining, &request.root)?;
        check_combined_source_budget(&source, staging_observation.as_ref())?;
        row["venue"] = paper::venue(
            &registry.venues,
            &registry.coerced_venues,
            values::field_text(&row["task"], "venueTarget"),
        );
        values::charge(&row, &mut remaining)?;
        rows.push(row);
    }
    registry.refs["proposalStaging"] = if staged_count > 0 {
        json!(format!(
            "{}/*.json",
            values::logical_relative(&request.root, &staging)?
        ))
    } else {
        Value::Null
    };
    let count = |field: &str, predicate: fn(&Value) -> bool| {
        rows.iter()
            .filter(|row| predicate(&row["state"][field]))
            .count()
    };
    let venues = values::unique(
        rows.iter()
            .map(|row| values::field_text(&row["task"], "venueTarget")),
        32,
    );
    let scan = json!({"version":1,"kind":"PaperInventoryScan","root":request.root,"registryRefs":registry.refs,"inventorySource":registry.source,"inventoryFallback":registry.fallback,
        "quarantined":quarantine.iter().map(|(p,reason)| json!({"slug":values::field_text(&p.coerced,"slug"),"reason":reason,"canonicalDir":values::text(values::or(&p.coerced["canonical_dir"],&p.coerced["source_dir"]))})).collect::<Vec<_>>(),
        "venues":registry.venues,"workflows":registry.workflows,"summary":{"total":rows.len(),"sourceReady":count("draftStatus",|v|v=="source_tex_present"),"packageReady":count("packageStatus",|v|v=="package_present"||v=="package_ready"),"dryRunReady":count("readinessStatus",|v|v=="ready_for_local_dry_run"),"blocked":count("blockers",|v|v.as_array().is_some_and(|a|!a.is_empty())),"proposalStaged":rows.iter().filter(|row|row["task"]["registry"]["inventorySource"]=="proposal_staging").count(),"quarantined":if request.include_quarantined {0}else{quarantine.len()},"venues":venues},"rows":rows});
    values::bounded_json(&scan)?;
    let result = NativeInventoryObservationV1 {
        scan,
        source,
        store,
        database_observation,
        staging_observation,
    };
    result.verify_unchanged()?;
    if Instant::now() >= deadline {
        return Err("native_inventory_deadline_exceeded".to_owned());
    }
    Ok(result)
}

/// Pure original quality override over an actually observed PaperTask. It grants
/// no quality acceptance; the existing campaign builder validates its profile.
pub(crate) fn bind_native_inventory_task_quality_profile_v1(
    task: &Value,
    profile: &str,
) -> Result<Value, String> {
    let mut subject = task.clone();
    let object = subject
        .as_object_mut()
        .ok_or("PaperTask required for quality profile binding")?;
    if object
        .get("taskKey")
        .and_then(Value::as_str)
        .is_none_or(|s| s.is_empty())
    {
        return Err("PaperTask required for quality profile binding".to_owned());
    }
    for field in [
        "taskHash",
        "semanticIdentityVersion",
        "semanticIdentityHash",
    ] {
        object.remove(field);
    }
    let profile = values::text(&json!(profile));
    let mut profiles = subject["paperQualityProfiles"]
        .as_array()
        .cloned()
        .unwrap_or_default()
        .iter()
        .map(values::js_string)
        .collect::<Vec<_>>();
    profiles.push(profile.clone());
    subject["paperQualityProfile"] = values::nullable(profile);
    subject["paperQualityProfiles"] = json!(values::unique(profiles, 16));
    subject["taskHash"] = json!(values::hash_paper("PaperTask", &subject)?);
    let mut semantic = subject.clone();
    semantic
        .as_object_mut()
        .ok_or("native_batch_operator_task_invalid")?
        .remove("taskHash");
    subject["semanticIdentityVersion"] = json!(2);
    subject["semanticIdentityHash"] = json!(values::semantic_hash("PaperTask", &semantic)?);
    Ok(subject)
}

#[cfg(test)]
mod tests;
