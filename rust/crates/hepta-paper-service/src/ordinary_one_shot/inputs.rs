//! Retained write-free input collection shared by the ordinary preflight.
//! Facts are diagnostics; no projection creates reservation or action authority.
use super::{
    binding, contract::contract, dataset, execution_inputs::OneShotBusinessReadOwnerV1,
    inspect_report, json::*, preflight::from_value,
};
use crate::{
    automation_runtime_reconciliation::ordinary::ReconciliationReadControlV1,
    native_research_source::inspect_native_one_shot_workspace_snapshot_v1,
    operational_status::current_operational_code_provenance_with_deadline_v1,
};
use hepta_legacy_compatibility::ProductionJsonValue as Json;
use std::path::Path;

pub(super) struct PreflightFactsV1 {
    pub(super) codes: Vec<String>,
    pub(super) dataset_receipt_hash: Option<String>,
    pub(super) mounts_hash: Option<String>,
    pub(super) provider_hash: Option<String>,
    pub(super) protected_hash: Option<String>,
    pub(super) target_absent: Json,
    pub(super) native_inspected: bool,
    pub(super) native_unchanged: bool,
    pub(super) journal_inspected: bool,
    pub(super) journal_absent: Json,
    pub(super) provenance_hash: Option<String>,
    pub(super) snapshot_hash: Option<String>,
}

fn provider_configuration_hash(
    runtime: &Path,
    control: &ReconciliationReadControlV1,
) -> Result<String, String> {
    let managed = runtime
        .parent()
        .unwrap_or(runtime)
        .join("openclaw-managed-codex");
    let binary = runtime.join("local-run/bin/codex-openclaw-managed");
    let binary = binary
        .to_str()
        .ok_or("autonomous_research_one_shot_provider_configuration_invalid")?;
    let principal = |role: &str| -> Result<Json, String> {
        let home = managed.join(role);
        let home = home
            .to_str()
            .ok_or("autonomous_research_one_shot_provider_configuration_invalid")?;
        Ok(object([
            ("provider", string("codex")),
            ("codexBinary", string(binary)),
            ("codexHome", string(home)),
            ("model", string("gpt-5.6-sol")),
        ]))
    };
    hash(
        "AutonomousResearchProviderConfiguration",
        &object([
            ("version", Json::Number(1.0)),
            ("kind", string("AutonomousResearchProviderConfiguration")),
            (
                "status",
                string("autonomous_research_provider_configuration_resolved"),
            ),
            ("researchAuthor", principal("research-author")?),
            ("formalReviewer", principal("formal-reviewer")?),
        ]),
        &control.cancelled,
    )
}

/// The callback consumes facts while the original borrowed owners remain held.
/// Its error does not skip final identity/control checks. No owner is rebased.
pub(super) fn with_retained_preflight_facts<T>(
    workspace: &Path,
    runtime: &Path,
    control_root: &Path,
    mount_file: Option<&str>,
    control: &ReconciliationReadControlV1,
    project: impl FnOnce(PreflightFactsV1) -> Result<T, String>,
) -> Result<T, String> {
    control.checkpoint().map_err(|e| e.to_string())?;
    let c = contract()?;
    let mut codes = Vec::<String>::new();
    let mount_document = dataset::load_mount_document(workspace, mount_file, control)
        .and_then(|owner| owner.canonical_for_preflight(&control.cancelled, control.deadline))
        .ok();
    control.checkpoint().map_err(|e| e.to_string())?;
    let empty = Json::Array(Vec::new());
    let mounts = mount_document
        .as_ref()
        .map_or(&empty, |owner| owner.mounts());
    let mut dataset_observation = None;
    let mut dataset_receipt_hash = None;
    let mut mounts_hash = None;
    if canonical_bytes(mounts, 64 * 1024, &control.cancelled).is_err() {
        codes.push("autonomous_research_one_shot_dataset_mounts_invalid".into());
    } else {
        let actual = hash(
            "AutonomousResearchOneShotCampaignDatasetMounts",
            mounts,
            &control.cancelled,
        )?;
        if c["currentTarget"]["datasetMountsHash"].as_str() != Some(&actual) {
            codes.push("autonomous_research_one_shot_dataset_binding_mismatch".into());
        }
        mounts_hash = Some(actual);
        match mounts {
            Json::Array(v) if v.len() == 1 => {
                let document = mount_document
                    .as_ref()
                    .ok_or("autonomous_research_one_shot_dataset_mounts_invalid")?;
                let environment = dataset::plugin_environment();
                let observation = environment.and_then(|environment| {
                    dataset::ObservedOneShotDatasetV1::inspect(
                        document,
                        runtime,
                        workspace,
                        control,
                        &environment,
                    )
                });
                control.checkpoint().map_err(|e| e.to_string())?;
                match observation {
                    Ok(owner) => {
                        let receipt = owner.receipt(&control.cancelled, control.deadline)?;
                        if let Some(candidate) =
                            text(field(receipt, "operatorDatasetHarnessAuthorityReceiptHash"))
                            && candidate.len() == 71
                            && candidate.starts_with("sha256:")
                            && candidate[7..]
                                .bytes()
                                .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
                        {
                            dataset_receipt_hash = Some(candidate);
                        }
                        codes.extend(dataset::receipt_blockers(receipt, &v[0]));
                        dataset_observation = Some(owner);
                    }
                    Err(error) => codes.push(dataset::inspection_blocker(&error).into()),
                }
            }
            _ => codes.push("autonomous_research_one_shot_dataset_mounts_invalid".into()),
        }
    }
    let mut provider_hash = None;
    match provider_configuration_hash(runtime, control) {
        Ok(value) if c["providerConfigurationHash"].as_str() == Some(&value) => {
            provider_hash = Some(value);
            codes.push("autonomous_research_one_shot_provider_runtime_not_proven".into());
        }
        Ok(_) => codes.push("autonomous_research_one_shot_provider_configuration_mismatch".into()),
        Err(_) => codes.push("autonomous_research_one_shot_provider_configuration_invalid".into()),
    }
    codes.push("autonomous_research_one_shot_reviewer_independence_not_proven".into());
    let mut protected_hash = None;
    let mut target_absent = Json::Null;
    let mut native_inspected = false;
    let mut native_unchanged = false;
    let mut business_observation = None;
    if let Ok(owner) =
        OneShotBusinessReadOwnerV1::open(runtime, &control.cancelled, control.deadline)
    {
        native_inspected = true;
        match owner.project() {
            Ok((definition, target)) => {
                target_absent = Json::Bool(matches!(target, Json::Null));
                if !matches!(target, Json::Null) {
                    codes
                        .push("autonomous_research_one_shot_target_campaign_already_exists".into());
                }
                if binding::protected(&definition, &control.cancelled)? {
                    protected_hash = Some(hash(
                        "AutonomousResearchOneShotProtectedCampaignFingerprint",
                        &definition,
                        &control.cancelled,
                    )?);
                } else {
                    codes.push(
                        "autonomous_research_one_shot_protected_campaign_fingerprint_invalid"
                            .into(),
                    );
                }
            }
            Err(error) => codes.push(
                if error == "autonomous_research_one_shot_protected_campaign_missing" {
                    error
                } else {
                    "autonomous_research_one_shot_native_store_not_ready".into()
                },
            ),
        }
        if owner.assert_current().is_ok() {
            native_unchanged = true;
            business_observation = Some(owner);
        } else {
            codes.push("autonomous_research_one_shot_native_store_not_ready".into());
        }
    } else {
        codes.push("autonomous_research_one_shot_native_store_not_ready".into());
    }
    control.checkpoint().map_err(|e| e.to_string())?;
    let mut journal_inspected = false;
    let mut journal_absent = Json::Null;
    let mut journal_observation = None;
    match inspect_report(runtime, control_root, None, control, &mut journal_inspected) {
        Ok(owner) => {
            let absent = owner.project_recovery(control, |value| Ok(value.is_absent()))?;
            journal_absent = Json::Bool(absent);
            if !absent {
                codes.push(
                    "autonomous_research_one_shot_target_campaign_attempt_already_recorded".into(),
                );
            }
            journal_observation = Some(owner);
        }
        Err(_) => codes.push("autonomous_research_one_shot_attempt_journal_not_ready".into()),
    }
    let mut provenance_hash = None;
    let mut snapshot_hash = None;
    let mut workspace_observation = None;
    let provenance = current_operational_code_provenance_with_deadline_v1(
        workspace,
        &control.cancelled,
        control.deadline,
    );
    match provenance {
        Ok(value) if value["treeDirty"] != false => codes
            .push("autonomous_research_one_shot_source_snapshot_blocked:dirty_git_worktree".into()),
        Ok(value) => {
            let projected = from_value(&value)?;
            if !binding::provenance(&projected) {
                codes.push("autonomous_research_one_shot_source_provenance_invalid".into());
            } else {
                provenance_hash = Some(hash(
                    "AutonomousResearchOneShotCampaignCodeProvenance",
                    &projected,
                    &control.cancelled,
                )?);
                match inspect_native_one_shot_workspace_snapshot_v1(
                    workspace.to_owned(),
                    &control.cancelled,
                    control.deadline,
                ) {
                    Ok(snapshot) => {
                        let workspace_snapshot = &snapshot.snapshot()["workspaceSnapshot"];
                        let summary = object([
                            ("version", Json::Number(1.0)),
                            ("merkleHash", from_value(&workspace_snapshot["merkleHash"])?),
                            (
                                "manifestHash",
                                from_value(&workspace_snapshot["manifestHash"])?,
                            ),
                        ]);
                        snapshot.verify_unchanged()?;
                        let after = current_operational_code_provenance_with_deadline_v1(
                            workspace,
                            &control.cancelled,
                            control.deadline,
                        )
                        .map_err(|e| e.to_string())?;
                        snapshot.verify_unchanged()?;
                        if after != value {
                            return Err(
                                "autonomous_research_one_shot_source_provenance_changed".into()
                            );
                        }
                        snapshot_hash = Some(hash(
                            "AutonomousResearchOneShotCampaignSourceExecutionSnapshot",
                            &summary,
                            &control.cancelled,
                        )?);
                        workspace_observation = Some((snapshot, value));
                    }
                    Err(_) => {
                        codes.push("autonomous_research_one_shot_source_snapshot_invalid".into())
                    }
                }
            }
        }
        Err(_) => codes.push("autonomous_research_one_shot_source_provenance_invalid".into()),
    }
    control.checkpoint().map_err(|e| e.to_string())?;
    let assert_report_observations_current = || -> Result<(), String> {
        if let Some(owner) = &dataset_observation {
            owner.assert_current(&control.cancelled, control.deadline)?;
        }
        if let Some(document) = &mount_document {
            document.assert_current(&control.cancelled, control.deadline)?;
        }
        if let Some(owner) = &business_observation {
            owner.assert_current()?;
        }
        if let Some(owner) = &journal_observation {
            owner.assert_current(control)?;
        }
        if let Some((owner, provenance)) = &workspace_observation {
            let (cancelled, deadline) = owner.controls_v1();
            if !std::ptr::eq(cancelled, &*control.cancelled) || deadline != control.deadline {
                return Err("native_source_observation_control_context_mismatch".into());
            }
            owner.verify_unchanged()?;
            // Operational provenance is an existing cooperative identity, not
            // an opaque release authority. Compare to the original value;
            // this fresh check cannot rebaseline the retained snapshot.
            if current_operational_code_provenance_with_deadline_v1(
                workspace,
                &control.cancelled,
                control.deadline,
            )
            .map_err(|error| error.to_string())?
                != *provenance
            {
                return Err("autonomous_research_one_shot_source_provenance_changed".into());
            }
            owner.verify_unchanged()?;
        }
        control.checkpoint().map_err(|error| error.to_string())
    };
    assert_report_observations_current()?;
    let result = project(PreflightFactsV1 {
        codes,
        dataset_receipt_hash,
        mounts_hash,
        provider_hash,
        protected_hash,
        target_absent,
        native_inspected,
        native_unchanged,
        journal_inspected,
        journal_absent,
        provenance_hash,
        snapshot_hash,
    });
    assert_report_observations_current()?;
    result
}
