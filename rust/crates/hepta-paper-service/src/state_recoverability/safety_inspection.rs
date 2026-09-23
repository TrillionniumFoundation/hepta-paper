//! Passive composition from actual local files and pinned signature verifiers.
//! The returned JSON is diagnostic data. This API never returns a coordinator,
//! activation token, recoverability epoch, or action permit and invokes no RPC.
use super::cli::inputs;
use super::*;
mod sources;
use crate::{
    online_authority_evidence_cache::read_passive_authority_evidence_cache_v1,
    online_authority_inspection::inspect_passive_online_authority_v1,
    online_mutation_composition::compose_configured_online_mutation_coordinator_v1,
    online_writer_static::verify_online_writer_static_coverage_v1,
    sqlite_mutation_coordinator::{
        authority::{
            MutationAuthorityTransportV1, PinnedMutationAuthorityV1,
            ProcessMutationAuthorityTransportV1, files::Snapshot,
        },
        manifest::writer_manifest_hash_v1,
    },
    state_backup_authority::{PinnedStateBackupAuthorityV1, StateBackupAuthorityTransportV1},
    state_database_inventory::{
        ObservedStateDatabaseInventoryV1, inspect_state_database_inventory_v1,
        observe_state_database_inventory_v1,
    },
    state_safety::{
        evaluate_state_safety_readiness_v1, unavailable_online_anti_rollback_inspection_v1,
    },
};
use std::{
    collections::BTreeMap,
    path::{Component, Path, PathBuf},
};

/// Environment values are paths only; no report or readiness override is read.
/// Relative paths resolve against the explicitly supplied working directory.
pub struct StateSafetyInspectionOptionsV1 {
    pub workspace_root: PathBuf,
    pub runtime_root: PathBuf,
    pub working_directory: PathBuf,
    pub now: i64,
    pub environment: BTreeMap<String, String>,
}
struct PassiveOnly;
impl MutationAuthorityTransportV1 for PassiveOnly {
    fn invoke(&mut self, _: &Value) -> Result<Value> {
        Err(error(
            "autonomous_research_state_safety_passive_rpc_forbidden",
        ))
    }
}
impl StateBackupAuthorityTransportV1 for PassiveOnly {
    fn invoke(&mut self, _: &Value) -> Result<Value> {
        Err(error(
            "autonomous_research_state_safety_passive_rpc_forbidden",
        ))
    }
}
fn resolve(cwd: &Path, path: &Path) -> Result<PathBuf> {
    ensure(
        cwd.is_absolute(),
        "autonomous_research_state_safety_working_directory_invalid",
    )?;
    let absolute = if path.is_absolute() {
        path.to_owned()
    } else {
        cwd.join(path)
    };
    let mut out = PathBuf::from("/");
    for part in absolute.components() {
        match part {
            Component::RootDir | Component::CurDir => {}
            Component::ParentDir => {
                out.pop();
            }
            Component::Normal(name) => out.push(name),
            _ => return Err(error("autonomous_research_state_safety_path_invalid")),
        }
    }
    Ok(out)
}
fn configured_path(
    options: &StateSafetyInspectionOptionsV1,
    name: &str,
) -> Result<Option<PathBuf>> {
    options
        .environment
        .get(name)
        .filter(|s| !s.is_empty())
        .map(|p| resolve(&options.working_directory, Path::new(p)))
        .transpose()
}
struct HeldConfiguration {
    selected: super::files::ObservedFile,
    pin: String,
    document: Value,
    dependencies: Vec<Snapshot>,
}
impl HeldConfiguration {
    fn load(path: &Path, code: &str) -> Result<Self> {
        let (selected, pin, document) = inputs::configuration(path, code)?;
        Ok(Self {
            selected,
            pin,
            document,
            dependencies: Vec::new(),
        })
    }
    fn dependency(
        &mut self,
        path_field: &str,
        pin_field: &str,
        maximum: u64,
        code: &str,
    ) -> Result<()> {
        self.dependencies.push(Snapshot::load(
            Path::new(text(&self.document, path_field)?),
            text(&self.document, pin_field)?,
            maximum,
            code,
        )?);
        Ok(())
    }
    fn current(&self) -> Result<()> {
        self.selected.assert_current()?;
        for file in &self.dependencies {
            file.assert_current()?;
        }
        Ok(())
    }
}
struct PassiveBackup {
    manifest: inputs::ManifestFile,
    authority: Option<PinnedStateBackupAuthorityV1<PassiveOnly>>,
    configuration: Option<HeldConfiguration>,
    online: Option<PinnedMutationAuthorityV1<PassiveOnly>>,
}
impl PassiveBackup {
    fn compose(options: &StateSafetyInspectionOptionsV1, workspace: &Path) -> Result<Self> {
        let manifest = inputs::ManifestFile::load(
            &workspace.join("paper-core/config/autonomous-research-state-databases.v1.json"),
        )?;
        crate::state_backup_authority::manifest::assert_state_database_manifest_v1(
            &manifest.value,
        )?;
        let path = configured_path(
            options,
            "HEPTA_AUTONOMOUS_RESEARCH_STATE_BACKUP_AUTHORITY_CONFIG",
        )?;
        let (authority, configuration, online) = if let Some(path) = path {
            let code = "autonomous_research_state_backup_authority_process_configuration_invalid";
            let mut held = HeldConfiguration::load(&path, code)?;
            let authority = PinnedStateBackupAuthorityV1::load(&path, &held.pin, PassiveOnly)?;
            held.dependency("commandPath", "commandSha256", 256 * 1024 * 1024, code)?;
            held.dependency("publicKeyPath", "publicKeySha256", 64 * 1024, code)?;
            let online = if held.document["version"] == 2 {
                Some(PinnedMutationAuthorityV1::load(
                    Path::new(text(
                        &held.document,
                        "onlineMutationAuthorityConfigurationPath",
                    )?),
                    text(&held.document, "onlineMutationAuthorityConfigurationSha256")?,
                    PassiveOnly,
                )?)
            } else {
                None
            };
            (Some(authority), Some(held), online)
        } else {
            (None, None, None)
        };
        let value = Self {
            manifest,
            authority,
            configuration,
            online,
        };
        value.current()?;
        Ok(value)
    }
    fn current(&self) -> Result<()> {
        self.manifest.assert_current()?;
        if let Some(configuration) = &self.configuration {
            configuration.current()?;
        }
        if let Some(online) = &self.online {
            online.current()?;
        }
        Ok(())
    }
}
fn failed_inventory(cause: &str) -> Value {
    json!({"version":1,"kind":"AutonomousResearchStateDatabaseInventory",
        "status":"autonomous_research_state_database_inventory_blocked",
        "blockers":[format!("autonomous_research_state_database_inventory_inspection_failed:{cause}")]})
}
fn failed_sources(cause: &str) -> Value {
    json!({"version":1,"kind":"AutonomousResearchStateBackupSources",
        "status":"autonomous_research_state_backup_sources_blocked",
        "blockers":[format!("autonomous_research_state_latest_restore_drill_inspection_failed:{cause}")]})
}
fn unavailable_coordinator() -> Value {
    json!({"version":1,"kind":"ExternallyFencedSqliteMutationCoordinatorStatus",
        "status":"externally_fenced_sqlite_mutation_coordinator_unavailable", "implemented":false,
        "coveredDatabaseRoles":[], "blockers":["externally_fenced_sqlite_mutation_coordinator_unavailable",
            "autonomous_research_online_writer_manifest_100_percent_required"]})
}
fn add_blocker(report: &mut Value, code: String) {
    let mut blockers = report["blockers"].as_array().cloned().unwrap_or_default();
    blockers.push(json!(code));
    blockers.sort_by(|a, b| {
        a.as_str()
            .unwrap_or("")
            .encode_utf16()
            .cmp(b.as_str().unwrap_or("").encode_utf16())
    });
    blockers.dedup();
    report["blockers"] = json!(blockers);
}
fn coordinator_status(
    path: &Path,
    inventory: &ObservedStateDatabaseInventoryV1,
    now: i64,
) -> Result<Value> {
    let code = "autonomous_research_online_mutation_authority_process_configuration_invalid";
    let mut held = HeldConfiguration::load(path, code)?;
    // Validate the complete actual process configuration and command pins, but
    // give the configured coordinator an uncallable transport.
    let _validated_process = ProcessMutationAuthorityTransportV1::load(path, &held.pin)?;
    held.dependency("commandPath", "commandSha256", 128 * 1024 * 1024, code)?;
    let authority = PinnedMutationAuthorityV1::load(
        Path::new(text(&held.document, "authorityConfigurationPath")?),
        text(&held.document, "authorityConfigurationSha256")?,
        PassiveOnly,
    )?;
    let coordinator = compose_configured_online_mutation_coordinator_v1(
        inventory,
        authority,
        Box::new(move || Ok(now)),
    )?;
    let status = coordinator.inspect_status();
    inventory.assert_current()?;
    coordinator.assert_configuration_current()?;
    held.current()?;
    Ok(status)
}
fn observe_cache_presence(runtime: &Path) -> Result<()> {
    use nix::{
        errno::Errno,
        fcntl::{OFlag, open, openat},
        sys::stat::Mode,
    };
    use std::fs::File;
    let flags = OFlag::O_RDONLY | OFlag::O_CLOEXEC | OFlag::O_NOFOLLOW | OFlag::O_NONBLOCK;
    let Ok(root) = open(runtime, flags | OFlag::O_DIRECTORY, Mode::empty()) else {
        return Ok(());
    };
    let mut parent = File::from(root);
    for (name, directory) in [
        ("automation-cache", true),
        ("online-authority-evidence-v1", true),
        ("current.json", false),
    ] {
        match openat(
            &parent,
            Path::new(name),
            flags
                | if directory {
                    OFlag::O_DIRECTORY
                } else {
                    OFlag::empty()
                },
            Mode::empty(),
        ) {
            Ok(file) => parent = File::from(file),
            Err(Errno::ENOENT) => {
                return Err(error(
                    "scoped_materialization_source_unsafe:automation-cache/online-authority-evidence-v1/current.json:scoped_path_missing_or_unreadable",
                ));
            }
            // A present unsafe path is never rewritten as absence. The native
            // cache reader preserves its stricter actual-path refusal below.
            Err(_) => return Ok(()),
        }
    }
    Ok(())
}
fn online_inspection(
    workspace: &Path,
    runtime: &Path,
    path: &Path,
    inventory: &ObservedStateDatabaseInventoryV1,
    writer: &Value,
    coordinator: &Value,
    now: i64,
) -> Result<Value> {
    // Preserve the incumbent failure priority: missing/broken cache is observed
    // before the source scan and authority configuration load.
    inventory.assert_current()?;
    observe_cache_presence(runtime)?;
    read_passive_authority_evidence_cache_v1(
        runtime,
        Some(text(inventory.value(), "databaseScopeHash")?),
        Some(&writer_manifest_hash_v1(writer)?),
        Some(now),
    )?;
    let source = verify_online_writer_static_coverage_v1(workspace, writer)?;
    let code = "autonomous_research_online_mutation_authority_configuration_invalid";
    let held = HeldConfiguration::load(path, code)?;
    let authority = PinnedMutationAuthorityV1::load(path, &held.pin, PassiveOnly)?;
    let mut clock = move || Ok(now);
    let result = inspect_passive_online_authority_v1(
        &authority,
        inventory,
        &source,
        writer,
        coordinator,
        &mut clock,
    )?;
    authority.current()?;
    held.current()?;
    Ok(result.value().clone())
}
/// Compose the full passive state-safety report. It observes actual inventory,
/// selected backup sources, fixed writer source coverage, signed cache receipts,
/// and the real configured coordinator stage. Missing configuration remains a
/// blocker; no externally supplied readiness claim can enter this composition.
pub fn inspect_autonomous_research_state_safety_v1(
    options: &StateSafetyInspectionOptionsV1,
) -> Result<Value> {
    iso(options.now).map_err(|_| error("autonomous_research_state_safety_now_required"))?;
    let workspace = resolve(&options.working_directory, &options.workspace_root)?;
    let runtime = resolve(&options.working_directory, &options.runtime_root)?;
    let writer = super::cli::state_backup_writer_manifest_v1()?;
    let (service, mut inventory) = match PassiveBackup::compose(options, &workspace) {
        Ok(service) => {
            let inventory = inspect_state_database_inventory_v1(&runtime, &service.manifest.value)
                .and_then(|value| {
                    service.current()?;
                    Ok(value)
                })
                .unwrap_or_else(|cause| failed_inventory(&cause.code));
            (Some(service), inventory)
        }
        Err(cause) => (None, failed_inventory(&cause.code)),
    };
    let observed = if inventory["status"] == "autonomous_research_state_database_inventory_ready" {
        match observe_state_database_inventory_v1(
            &runtime,
            &service
                .as_ref()
                .ok_or_else(|| error("state_backup_service_unavailable"))?
                .manifest
                .value,
        )
        .and_then(|observed| {
            ensure(
                observed.value() == &inventory,
                "autonomous_research_state_database_inventory_changed",
            )?;
            Ok(observed)
        }) {
            Ok(observed) => Some(observed),
            Err(cause) => {
                inventory = failed_inventory(&cause.code);
                None
            }
        }
    } else {
        None
    };
    let latest = match service.as_ref() {
        None => failed_sources("state_backup_service_unavailable"),
        Some(service) => {
            let result = (|| {
                service.current()?;
                let value = if let Some(authority) = &service.authority {
                    sources::inspect(
                        &runtime.join("backups/autonomous-research-state"),
                        authority,
                        &service.manifest.value,
                        &inventory,
                        options.now,
                    )?
                } else {
                    // The original source resolver returns before filesystem IO
                    // when trust is absent; the composition replaces its code.
                    json!({"version":1,"kind":"AutonomousResearchStateBackupSources",
                        "status":"autonomous_research_state_backup_sources_blocked",
                        "blockers":["autonomous_research_state_restore_authority_trust_configuration_required"]})
                };
                service.current()?;
                Ok(value)
            })();
            result.unwrap_or_else(
                |cause: crate::sqlite_mutation_coordinator::SqliteMutationCoordinatorError| {
                    failed_sources(&cause.code)
                },
            )
        }
    };
    let mut coordinator = unavailable_coordinator();
    let mut coordinator_failure = None;
    if let (Some(path), Some(observed)) = (
        configured_path(
            options,
            "HEPTA_AUTONOMOUS_RESEARCH_ONLINE_MUTATION_AUTHORITY_PROCESS_CONFIG",
        )?,
        &observed,
    ) {
        match coordinator_status(&path, observed, options.now) {
            Ok(value) => coordinator = value,
            Err(cause) => {
                coordinator_failure = Some(format!(
                    "autonomous_research_online_mutation_coordinator_composition_failed:{}",
                    cause.code
                ))
            }
        }
    }
    let mut online = unavailable_online_anti_rollback_inspection_v1(Some(&writer))?;
    if let (Some(path), Some(observed)) = (
        configured_path(
            options,
            "HEPTA_AUTONOMOUS_RESEARCH_ONLINE_MUTATION_AUTHORITY_CONFIG",
        )?,
        &observed,
    ) {
        match online_inspection(
            &workspace,
            &runtime,
            &path,
            observed,
            &writer,
            &coordinator,
            options.now,
        ) {
            Ok(value) => online = value,
            Err(cause) => add_blocker(
                &mut online,
                format!(
                    "autonomous_research_online_anti_rollback_inspection_failed:{}",
                    cause.code
                ),
            ),
        }
    }
    if let Some(cause) = coordinator_failure {
        add_blocker(&mut online, cause);
    }
    let mut report =
        evaluate_state_safety_readiness_v1(&inventory, &latest, Some(&online), options.now)?;
    report["restoreAuthorityConfigured"] =
        json!(service.as_ref().is_some_and(|s| s.authority.is_some()));
    report["restoreAuthorityConfigurationHash"] = service
        .as_ref()
        .and_then(|s| s.authority.as_ref())
        .map(|a| json!(a.configuration_hash()))
        .unwrap_or(Value::Null);
    report["onlineMutationCoordinatorStatus"] = coordinator;
    Ok(report)
}
