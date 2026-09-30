//! Ordinary CLI composition over the existing ten-database schema planner.
//! Installed execution requires the separate physical owner; planning is read-only.
pub(in crate::online_schema_execution) mod arguments;
pub(crate) mod node_history;
use super::plan::{
    SchemaTransitionPlanOptionsV1, build_schema_transition_plan_v1,
    inspect_schema_transition_pristine_preimage_v1,
    installation_support::validate_schema_transition_plan_identity_v1,
};
use crate::{
    online_schema_transition::audit::verify_audit,
    sqlite_mutation_coordinator::{
        authority::{
            MutationAuthorityTransportV1, PinnedMutationAuthorityV1,
            ProcessMutationAuthorityTransportV1,
            files::{Snapshot, parse},
        },
        clock::MutationClockV1,
        error, hash, hash_bytes, text,
    },
    state_recoverability::{
        cli::state_backup_writer_manifest_v1,
        publication::{Directory as PublicationDirectory, ObservedEmptyLock},
        schema_installation_repository::ObservedInstallationPreimages,
    },
};
use serde_json::{Value, json};
use std::{
    collections::BTreeSet,
    fs,
    path::{Component, Path, PathBuf},
};
const STATE_MANIFEST: &str =
    include_str!("../../../../../paper-core/config/autonomous-research-state-databases.v1.json");
const PREFIX: &str = "autonomous_research_online_schema_transition_";
const MAX_CONTROL_BYTES: u64 = 16 * 1024 * 1024;

pub(in crate::online_schema_execution) struct FinalizedPredecessor {
    control: PathBuf,
    control_directory: PublicationDirectory,
    journal: Option<Snapshot>,
    artifacts: Vec<Snapshot>,
    locks: Vec<ObservedEmptyLock>,
    preimages: Option<ObservedInstallationPreimages>,
    final_receipt: Snapshot,
    expected_entries: Vec<String>,
    final_receipt_file_sha256: String,
}
pub(in crate::online_schema_execution) enum ControlGuard {
    Absent(PathBuf),
    Node(Box<node_history::ObservedNodeControlV1>),
    Finalized(Box<FinalizedPredecessor>),
}
impl ControlGuard {
    pub(in crate::online_schema_execution) fn final_receipt_file_sha256(&self) -> Option<&str> {
        match self {
            Self::Absent(_) => None,
            Self::Node(value) => Some(value.final_receipt_file_sha256()),
            Self::Finalized(value) => Some(&value.final_receipt_file_sha256),
        }
    }
    pub(in crate::online_schema_execution) fn assert_current(&self) -> Result<(), String> {
        match self {
            Self::Absent(path) => match fs::symlink_metadata(path) {
                Err(cause) if cause.kind() == std::io::ErrorKind::NotFound => Ok(()),
                _ => Err(format!("{PREFIX}control_state_changed_during_observation")),
            },
            Self::Node(value) => value.assert_current(),
            Self::Finalized(value) => {
                value
                    .control_directory
                    .assert_current()
                    .map_err(|_| format!("{PREFIX}previous_finalized_control_shape_invalid"))?;
                if let Some(journal) = &value.journal {
                    journal
                        .assert_current()
                        .map_err(|_| format!("{PREFIX}previous_final_receipt_changed"))?;
                }
                for artifact in &value.artifacts {
                    artifact
                        .assert_current()
                        .map_err(|_| format!("{PREFIX}previous_finalized_control_shape_invalid"))?;
                }
                for lock in &value.locks {
                    lock.assert_current()
                        .map_err(|_| format!("{PREFIX}previous_finalized_control_shape_invalid"))?;
                }
                if let Some(preimages) = &value.preimages {
                    preimages
                        .assert_current()
                        .map_err(|_| format!("{PREFIX}previous_finalized_control_shape_invalid"))?;
                }
                value
                    .final_receipt
                    .assert_current()
                    .map_err(|_| format!("{PREFIX}previous_final_receipt_changed"))?;
                if control_entries(&value.control)? == value.expected_entries {
                    Ok(())
                } else {
                    Err(format!("{PREFIX}previous_finalized_control_shape_invalid"))
                }
            }
        }
    }
    pub(in crate::online_schema_execution) fn path(&self) -> &Path {
        match self {
            Self::Absent(path) => path,
            Self::Node(value) => value.control_path(),
            Self::Finalized(value) => &value.control,
        }
    }
}
fn validate_runtime_root(root: &Path) -> Result<PathBuf, String> {
    if !root.is_absolute()
        || root
            .components()
            .any(|c| !matches!(c, Component::RootDir | Component::Normal(_)))
        || fs::canonicalize(root).ok().as_deref() != Some(root)
    {
        return Err(format!("{PREFIX}runtime_root_identity_invalid"));
    }
    Ok(root.join("autonomous-research/online-schema-transition"))
}
fn control_entries(path: &Path) -> Result<Vec<String>, String> {
    let metadata =
        fs::symlink_metadata(path).map_err(|_| format!("{PREFIX}control_path_unsafe"))?;
    if !metadata.is_dir() || metadata.is_symlink() {
        return Err(format!("{PREFIX}control_path_unsafe"));
    }
    let mut entries = Vec::new();
    for entry in fs::read_dir(path).map_err(|_| format!("{PREFIX}control_path_unsafe"))? {
        if entries.len() == 4096 {
            return Err(format!("{PREFIX}previous_finalized_control_shape_invalid"));
        }
        entries.push(
            entry
                .map_err(|_| format!("{PREFIX}control_path_unsafe"))?
                .file_name()
                .into_string()
                .map_err(|_| format!("{PREFIX}control_path_unsafe"))?,
        );
    }
    entries.sort();
    Ok(entries)
}
fn provisional_pin(path: &Path) -> Result<String, String> {
    let metadata =
        fs::symlink_metadata(path).map_err(|_| format!("{PREFIX}control_path_unsafe"))?;
    if !metadata.is_file() || metadata.is_symlink() || metadata.len() > MAX_CONTROL_BYTES {
        return Err(format!("{PREFIX}control_path_unsafe"));
    }
    let bytes = fs::read(path).map_err(|_| format!("{PREFIX}control_path_unsafe"))?;
    if bytes.len() as u64 != metadata.len() {
        return Err(format!("{PREFIX}control_path_unsafe"));
    }
    Ok(hash_bytes(&bytes))
}
fn same_fields(left: &Value, right: &Value, fields: &[&str]) -> bool {
    fields
        .iter()
        .all(|field| left.get(field).is_some() && left.get(field) == right.get(field))
}
fn closed_progress(value: &Value, fields: &[&str]) -> bool {
    value.as_object().is_some_and(|object| {
        object.len() == fields.len() && fields.iter().all(|field| object.contains_key(*field))
    })
}
fn validate_progress(
    progress: &Value,
    request_kind: &str,
    final_request: &Value,
    final_receipt: &Value,
) -> Result<(), String> {
    if !closed_progress(progress, &["version", "request", "requestHash", "receipt"])
        || progress["version"] != 1
        || progress["request"] != *final_request
        || progress["receipt"] != *final_receipt
        || progress["requestHash"]
            != hash(request_kind, final_request).map_err(|error| error.code)?
    {
        return Err(format!("{PREFIX}previous_native_journal_invalid"));
    }
    Ok(())
}
fn validate_native_journal<T: MutationAuthorityTransportV1>(
    journal: &Value,
    final_value: &Value,
    authority: &PinnedMutationAuthorityV1<T>,
    historical_source: Option<&PinnedMutationAuthorityV1<T>>,
) -> Result<(), String> {
    validate_schema_transition_plan_identity_v1(&journal["plan"])
        .map_err(|_| format!("{PREFIX}previous_native_journal_invalid"))?;
    let mut expected_request = journal["plan"].clone();
    let object = expected_request
        .as_object_mut()
        .ok_or_else(|| format!("{PREFIX}previous_native_journal_invalid"))?;
    object.remove("planHash");
    let planned_at = object
        .remove("plannedAt")
        .ok_or_else(|| format!("{PREFIX}previous_native_journal_invalid"))?;
    object.insert(
        "kind".into(),
        Value::from("AutonomousResearchOnlineSchemaTransitionReserveRequest"),
    );
    object.insert("requestedAt".into(), planned_at);
    if journal["version"] != 1
        || journal["kind"] != "NativeSchemaJournalNormalizationProgress"
        || journal["request"] != expected_request
        || journal["request"] != final_value["reserveRequest"]
        || journal["reservation"] != final_value["reservation"]
        || journal["installations"] != final_value["installations"]
        || !same_fields(
            &journal["plan"],
            final_value,
            &[
                "version",
                "protocol",
                "transitionId",
                "planHash",
                "databaseScopeHash",
                "writerManifestHash",
                "transitionInventoryHash",
                "schemaBundleHash",
            ],
        )
    {
        return Err(format!("{PREFIX}previous_native_journal_invalid"));
    }
    if journal["plan"]["version"] == 1 {
        if historical_source.is_some()
            || journal["authorityConfigurationHash"] != authority.configuration_hash()
        {
            return Err(format!("{PREFIX}previous_native_journal_invalid"));
        }
    } else if journal["plan"]["version"] == 2 {
        let source = historical_source
            .ok_or_else(|| format!("{PREFIX}historical_source_authority_process_pin_required"))?;
        // These are public verifier-configuration hashes. The signed target hash
        // below belongs to the private daemon configuration and is a different
        // domain; it must never be compared with either public hash.
        if journal["authorityConfigurationHash"] != source.configuration_hash()
            || source.configuration_hash() == authority.configuration_hash()
            || source.trust()["writerManifestHash"] != journal["plan"]["sourceWriterManifestHash"]
            || authority.trust()["writerManifestHash"] != final_value["writerManifestHash"]
            || !same_fields(
                source.trust(),
                authority.trust(),
                &["authorityId", "keyId", "scopeId", "databaseScopeHash"],
            )
        {
            return Err(format!("{PREFIX}previous_native_journal_invalid"));
        }
        let reservation = source
            .verify_historical_schema_transition_reservation(
                &journal["reservation"],
                &journal["request"],
            )
            .map_err(|_| format!("{PREFIX}previous_native_journal_invalid"))?;
        source
            .verify_historical_schema_transition_finalization(
                &final_value["finalization"],
                &final_value["finalizeRequest"],
                &reservation,
            )
            .map_err(|_| format!("{PREFIX}previous_native_journal_invalid"))?;
    } else {
        return Err(format!("{PREFIX}previous_native_journal_invalid"));
    }
    validate_progress(
        &journal["finalizationProgress"],
        "AutonomousResearchOnlineSchemaTransitionFinalizeRequest",
        &final_value["finalizeRequest"],
        &final_value["finalization"],
    )?;
    if journal["plan"]["version"] == 1 {
        validate_progress(
            &journal["observationProgress"],
            "AutonomousResearchOnlineSchemaTransitionObserveRequest",
            &final_value["observeRequest"],
            &final_value["observation"],
        )?;
    } else if journal["plan"]["version"] == 2 {
        let progress = &journal["targetRestartObservationProgress"];
        if !closed_progress(
            progress,
            &[
                "version",
                "sourceAuthorityConfigurationHash",
                "targetAuthorityConfigurationHash",
                "request",
                "requestHash",
                "receipt",
            ],
        ) || progress["version"] != 2
            || progress["sourceAuthorityConfigurationHash"] != journal["authorityConfigurationHash"]
            || progress["targetAuthorityConfigurationHash"]
                != final_value["finalization"]["targetAuthorityConfigurationHash"]
            || progress["request"] != final_value["observeRequest"]
            || progress["receipt"] != final_value["observation"]
            || progress["requestHash"]
                != hash(
                    "AutonomousResearchOnlineSchemaTransitionObserveRequest",
                    &final_value["observeRequest"],
                )
                .map_err(|error| error.code)?
        {
            return Err(format!("{PREFIX}previous_native_journal_invalid"));
        }
    } else {
        return Err(format!("{PREFIX}previous_native_journal_invalid"));
    }
    Ok(())
}
fn exact_lower_hex(value: &str, length: usize) -> bool {
    value.len() == length
        && value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

pub(in crate::online_schema_execution) fn finalized_predecessor<T: MutationAuthorityTransportV1>(
    root: &Path,
    expected: Option<&str>,
    authority: &PinnedMutationAuthorityV1<T>,
    historical_source: Option<&PinnedMutationAuthorityV1<T>>,
) -> Result<ControlGuard, String> {
    let control = validate_runtime_root(root)?;
    match fs::symlink_metadata(&control) {
        Err(cause) if cause.kind() == std::io::ErrorKind::NotFound => {
            if historical_source.is_some() {
                return Err(format!("{PREFIX}historical_source_authority_forbidden"));
            }
            if expected.is_some() {
                return Err(format!("{PREFIX}previous_final_receipt_absent"));
            }
            return Ok(ControlGuard::Absent(control));
        }
        Err(_) => return Err(format!("{PREFIX}control_path_unsafe")),
        Ok(_) if expected.is_none() => {
            return Err(format!("{PREFIX}existing_control_requires_recovery"));
        }
        Ok(_) => {}
    }
    let entries = control_entries(&control)?;
    let node_shape = entries == ["ACTIVE.json", "FINAL.json"]
        || entries == ["ACTIVE.json", "FINAL.json", "history"];
    let native_shape = entries.iter().any(|entry| entry == "FINAL.json")
        && entries
            .iter()
            .any(|entry| entry == "NORMALIZATION.native.v1.json")
        && !entries.iter().any(|entry| entry == "ACTIVE.json");
    if !node_shape && !native_shape {
        return Err(format!("{PREFIX}previous_finalized_control_shape_invalid"));
    }
    if node_shape {
        return node_history::observe_node_control_v1(
            &control,
            expected.ok_or_else(|| format!("{PREFIX}previous_final_receipt_pin_required"))?,
            authority,
            historical_source,
        )
        .map(|value| ControlGuard::Node(Box::new(value)));
    }
    let control_directory = PublicationDirectory::open_or_create(&control, false)
        .map_err(|_| format!("{PREFIX}previous_finalized_control_shape_invalid"))?;
    let expected =
        expected.ok_or_else(|| format!("{PREFIX}previous_final_receipt_pin_required"))?;
    let final_receipt = Snapshot::load(
        &control.join("FINAL.json"),
        expected,
        MAX_CONTROL_BYTES,
        &format!("{PREFIX}previous_final_receipt_invalid"),
    )
    .map_err(|error| error.code)?;
    let final_value = parse(
        final_receipt.bytes(),
        &format!("{PREFIX}previous_final_receipt_invalid"),
    )
    .map_err(|error| error.code)?;
    let (journal, artifacts, locks, preimages) = {
        let path = control.join("NORMALIZATION.native.v1.json");
        let pin = provisional_pin(&path)?;
        let snapshot = Snapshot::load(
            &path,
            &pin,
            MAX_CONTROL_BYTES,
            &format!("{PREFIX}previous_native_journal_invalid"),
        )
        .map_err(|error| error.code)?;
        let value = parse(
            snapshot.bytes(),
            &format!("{PREFIX}previous_native_journal_invalid"),
        )
        .map_err(|error| error.code)?;
        validate_native_journal(&value, &final_value, authority, historical_source)?;
        let plan_hash = text(&value["plan"], "planHash").map_err(|error| error.code)?;
        let suffix = plan_hash
            .strip_prefix("sha256:")
            .filter(|value| exact_lower_hex(value, 64))
            .ok_or_else(|| format!("{PREFIX}previous_native_journal_invalid"))?;
        let preimage_name = format!("preimages-{suffix}");
        let required = [
            "FINAL.json",
            "NORMALIZATION.native.v1.json",
            ".publication-lock-FINAL.json",
            ".publication-lock-NORMALIZATION.native.v1.json",
        ];
        if required
            .iter()
            .any(|name| !entries.iter().any(|entry| entry == name))
            || !entries.iter().any(|entry| entry == &preimage_name)
        {
            return Err(format!("{PREFIX}previous_finalized_control_shape_invalid"));
        }
        let mut artifacts = Vec::new();
        let mut locks = Vec::new();
        let mut total_artifact_bytes = 0u64;
        for name in &entries {
            if name == &preimage_name
                || name == "FINAL.json"
                || name == "NORMALIZATION.native.v1.json"
            {
                continue;
            }
            let owner_lock = matches!(
                name.as_str(),
                ".publication-lock-FINAL.json" | ".publication-lock-NORMALIZATION.native.v1.json"
            );
            if owner_lock {
                locks.push(
                    control_directory
                        .observe_empty_lock(name)
                        .map_err(|error| {
                            format!(
                                "{PREFIX}previous_finalized_control_shape_invalid:{}",
                                error.code
                            )
                        })?,
                );
                continue;
            }
            let pending = name
                .strip_prefix(".pending-")
                .is_some_and(|suffix| exact_lower_hex(suffix, 32));
            if !pending || artifacts.len() >= 512 {
                return Err(format!("{PREFIX}previous_finalized_control_shape_invalid"));
            }
            let path = control.join(name);
            let metadata = fs::symlink_metadata(&path)
                .map_err(|_| format!("{PREFIX}previous_finalized_control_shape_invalid"))?;
            total_artifact_bytes = total_artifact_bytes
                .checked_add(metadata.len())
                .filter(|total| *total <= 64 * 1024 * 1024)
                .ok_or_else(|| format!("{PREFIX}previous_finalized_control_shape_invalid"))?;
            let pin = provisional_pin(&path)?;
            artifacts.push(
                Snapshot::load(
                    &path,
                    &pin,
                    MAX_CONTROL_BYTES,
                    &format!("{PREFIX}previous_finalized_control_shape_invalid"),
                )
                .map_err(|error| error.code)?,
            );
        }
        let preimages = ObservedInstallationPreimages::observe_existing(root, &value["plan"])
            .map_err(|error| {
                format!(
                    "{PREFIX}previous_finalized_control_shape_invalid:{}",
                    error.code
                )
            })?;
        (Some(snapshot), artifacts, locks, Some(preimages))
    };
    let historical_inventory = json!({
        "databaseScopeHash": final_value["databaseScopeHash"],
        "inventoryHash": final_value["postInventoryHash"],
    });
    verify_audit(
        &final_value,
        final_receipt.bytes(),
        &historical_inventory,
        text(&final_value, "writerManifestHash").map_err(|error| error.code)?,
        authority,
    )
    .map_err(|_| format!("{PREFIX}previous_final_receipt_invalid"))?;
    let result = ControlGuard::Finalized(Box::new(FinalizedPredecessor {
        control,
        control_directory,
        journal,
        artifacts,
        locks,
        preimages,
        final_receipt,
        expected_entries: entries,
        final_receipt_file_sha256: expected.to_owned(),
    }));
    result.assert_current()?;
    Ok(result)
}
fn options<'a>(
    args: &'a arguments::Arguments,
    manifest: &'a Value,
    writer: &'a Value,
) -> SchemaTransitionPlanOptionsV1<'a> {
    SchemaTransitionPlanOptionsV1 {
        runtime_root: &args.runtime,
        state_database_manifest: manifest,
        writer_manifest: writer,
        requested_lease_ms: args.requested_lease_ms,
        required_execution_window_ms: args.execution_window_ms,
        expected_pre_rebind_pristine_runtime_state_hash: args.expected_pristine.as_deref(),
        machine_genesis: None,
    }
}
/// Builds a fresh v1/v2 source plan or the separate reviewer preimage. Neither
/// result can construct the opaque maintenance reservation or activate a writer.
pub fn schema_transition_plan_cli_v1(
    args: &[String],
    clock: &mut dyn MutationClockV1,
) -> Result<Value, String> {
    let args = arguments::parse(args)?;
    if args.help {
        return Ok(json!({
            "version": 1,
            "kind": "NativeSchemaTransitionPlanUsage",
            "mutation": "none",
            "usage": "hepta-paper-rust autonomous-online-schema-transition --action plan|inspect-pristine --runtime-root ABSOLUTE_PATH --authority-process-config ABSOLUTE_PATH --authority-process-config-sha256 sha256:HASH [--expected-previous-final-receipt-sha256 sha256:HASH] [--historical-source-authority-process-config ABSOLUTE_PATH --historical-source-authority-process-config-sha256 sha256:HASH] [--requested-lease-ms N] [--required-execution-window-ms N] [--expected-pre-rebind-pristine-runtime-state-hash sha256:HASH]",
            "installedUsage":"hepta-paper-rust autonomous-online-schema-transition --action execute|recover --execute --runtime-root ABSOLUTE_PATH --authority-process-config ABSOLUTE_PATH --authority-process-config-sha256 sha256:HASH --transition-id sha256:HASH --expected-plan-hash sha256:HASH --planned-at ORIGINAL_PLAN_INSTANT --installed-maintenance-profile ABSOLUTE_PATH --installed-maintenance-profile-sha256 sha256:HASH [--expected-previous-final-receipt-sha256 sha256:HASH] [--expected-pre-rebind-pristine-runtime-state-hash sha256:HASH] [--requested-lease-ms N] [--required-execution-window-ms N] [--commit-safety-margin-ms N]",
            "profileInspectionUsage":"hepta-paper-rust autonomous-online-schema-transition --action inspect-installed-profile --runtime-root ABSOLUTE_PATH --authority-process-config ABSOLUTE_PATH --authority-process-config-sha256 sha256:HASH --installed-maintenance-profile ABSOLUTE_PATH --installed-maintenance-profile-sha256 sha256:HASH",
            "scope": "native_source_planning_and_separate_pinned_installed_maintenance",
            "executionAuthority": false
        }));
    }
    if args.action == "inspect-installed-profile" {
        return crate::online_schema_execution::installed_owner::installation::observe_installed_schema_profile_v1(
            args.installed_profile.as_deref().ok_or_else(||format!("{PREFIX}installed_maintenance_profile_pin_required"))?,
            args.installed_profile_hash.as_deref().ok_or_else(||format!("{PREFIX}installed_maintenance_profile_pin_required"))?,
            &args.runtime,
        ).map(|profile|profile.report()).map_err(|error|error.code);
    }
    let manifest: Value = serde_json::from_str(STATE_MANIFEST)
        .map_err(|_| format!("{PREFIX}compiled_manifest_invalid"))?;
    let writer = state_backup_writer_manifest_v1().map_err(|error| error.code)?;
    let mut authority =
        PinnedMutationAuthorityV1::<ProcessMutationAuthorityTransportV1>::load_process(
            &args.process,
            &args.process_hash,
        )
        .map_err(|error| error.code)?;
    authority
        .assert_process_current_v1()
        .map_err(|error| error.code)?;
    let historical_source = match (
        args.historical_source_process.as_deref(),
        args.historical_source_process_hash.as_deref(),
    ) {
        (Some(path), Some(pin)) => {
            let source =
                PinnedMutationAuthorityV1::<ProcessMutationAuthorityTransportV1>::load_process(
                    path, pin,
                )
                .map_err(|error| error.code)?;
            source
                .assert_process_current_v1()
                .map_err(|error| error.code)?;
            Some(source)
        }
        (None, None) => None,
        _ => {
            return Err(format!(
                "{PREFIX}historical_source_authority_process_pin_required"
            ));
        }
    };
    let mut previous = None;
    let mut observed_clock = || {
        let now = clock.now_millis()?;
        if now < 0 || previous.is_some_and(|old| now < old) {
            return Err(error(format!("{PREFIX}clock_regressed")));
        }
        previous = Some(now);
        Ok(now)
    };
    if args.action == "recover" {
        return crate::online_schema_execution::installed_owner::execution::run(
            &args,
            &manifest,
            &writer,
            &mut authority,
            &mut observed_clock,
            None,
            historical_source.as_ref(),
        )
        .map_err(|error| error.code);
    }
    let control = finalized_predecessor(
        &args.runtime,
        args.expected_previous_final.as_deref(),
        &authority,
        historical_source.as_ref(),
    )?;
    if args.action == "execute" {
        return crate::online_schema_execution::installed_owner::execution::run(
            &args,
            &manifest,
            &writer,
            &mut authority,
            &mut observed_clock,
            Some(&control),
            historical_source.as_ref(),
        )
        .map_err(|error| error.code);
    }
    if args.action == "inspect-pristine" {
        let observed = inspect_schema_transition_pristine_preimage_v1(
            options(&args, &manifest, &writer),
            &authority,
            &mut observed_clock,
        )
        .map_err(|error| error.code)?;
        observed_clock().map_err(|error| error.code)?;
        observed
            .assert_current(&authority)
            .map_err(|error| error.code)?;
        authority
            .assert_process_current_v1()
            .map_err(|error| error.code)?;
        control.assert_current()?;
        if let Some(source) = &historical_source {
            source
                .assert_process_current_v1()
                .map_err(|error| error.code)?;
        }
        let mut report = observed.value().clone();
        report["previousFinalReceiptFileSha256"] = control
            .final_receipt_file_sha256()
            .map(Value::from)
            .unwrap_or(Value::Null);
        report["controlPredecessorVerified"] =
            Value::Bool(control.final_receipt_file_sha256().is_some());
        return Ok(report);
    }
    let plan = build_schema_transition_plan_v1(
        options(&args, &manifest, &writer),
        &authority,
        &mut observed_clock,
    )
    .map_err(|error| error.code)?;
    observed_clock().map_err(|error| error.code)?;
    plan.assert_current().map_err(|error| error.code)?;
    authority
        .assert_process_current_v1()
        .map_err(|error| error.code)?;
    control.assert_current()?;
    if let Some(source) = &historical_source {
        source
            .assert_process_current_v1()
            .map_err(|error| error.code)?;
    }
    let mut report = json!({
        "version": 1,
        "kind": "AutonomousResearchOnlineSchemaTransitionPlanReport",
        "status": "autonomous_research_online_schema_transition_plan_ready",
        "ready": true,
        "plan": plan.value(),
        "completedInstanceIds": [],
        "crossDatabaseAtomicityClaimed": false,
        "networkUse": false,
        "publicationPerformed": false,
        "blockers": [],
        "readinessScope": "fresh_native_source_plan_only",
        "authorityInvoked": false,
        "executionAuthority": false,
        "releaseAuthority": false,
        "submissionAuthority": false,
        "productionActivation": false,
        "nodeRetirement": false
    });
    if let Some(pin) = control.final_receipt_file_sha256() {
        report["previousFinalReceiptFileSha256"] = Value::from(pin);
        report["controlPredecessorVerified"] = Value::Bool(true);
        report["readinessScope"] = Value::from("finalized_predecessor_native_source_plan_only");
    }
    Ok(report)
}
