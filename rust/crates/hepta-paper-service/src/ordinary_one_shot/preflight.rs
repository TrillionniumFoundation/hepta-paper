//! Ordinary write-free preflight composes the existing bounded read owners.
//! A projected report cannot authorize a reservation, provider, or launch.
use super::{contract::contract, dataset, json::*};
#[cfg(test)]
use crate::native_research_source::inspect_native_one_shot_workspace_snapshot_v1;
use crate::{
    automation_runtime_reconciliation::ordinary::ReconciliationReadControlV1,
    ordinary_readonly_frontend::OrdinaryReadonlyOutputV1,
};
use hepta_legacy_compatibility::{ProductionJsonValue as Json, parse_production_json_v1};
use std::path::Path;

pub(super) fn load_dataset_mounts(
    workspace: &Path,
    candidate: Option<&str>,
    control: &ReconciliationReadControlV1,
) -> Result<Json, String> {
    Ok(dataset::load_mount_document(workspace, candidate, control)?
        .mounts()
        .clone())
}
pub(super) fn from_value(value: &serde_json::Value) -> Result<Json, String> {
    parse_production_json_v1(&serde_json::to_vec(value).map_err(|e| e.to_string())?)
        .map_err(|e| e.to_string())
}
fn nullable(value: Option<String>) -> Json {
    value.map_or(Json::Null, |v| string(&v))
}
fn status(blocked: bool) -> Json {
    string(if blocked { "blocked" } else { "passed" })
}
fn policy(code: &str) -> Result<(&'static str, &'static str), String> {
    Ok(match code {
        "autonomous_research_one_shot_dataset_binding_mismatch"
        | "autonomous_research_one_shot_dataset_contract_invalid" => {
            ("dataset_not_ready", "dataset_contract")
        }
        "autonomous_research_one_shot_dataset_manifest_invalid" => {
            ("dataset_not_ready", "dataset_manifest")
        }
        "autonomous_research_one_shot_dataset_mounts_invalid" => {
            ("dataset_not_ready", "dataset_input")
        }
        "autonomous_research_one_shot_dataset_source_unreadable" => {
            ("dataset_not_ready", "dataset_source")
        }
        "autonomous_research_one_shot_dataset_trust_invalid" => {
            ("dataset_not_ready", "dataset_trust")
        }
        "autonomous_research_one_shot_dataset_v4_envelope_invalid" => {
            ("dataset_not_ready", "dataset_envelope")
        }
        "autonomous_research_one_shot_provider_configuration_invalid"
        | "autonomous_research_one_shot_provider_configuration_mismatch" => {
            ("provider_not_ready", "provider_configuration")
        }
        "autonomous_research_one_shot_provider_runtime_not_proven" => {
            ("provider_not_ready", "provider_runtime")
        }
        "autonomous_research_one_shot_reviewer_independence_not_proven" => {
            ("reviewer_not_ready", "reviewer_identity")
        }
        "autonomous_research_one_shot_native_store_not_ready"
        | "autonomous_research_one_shot_attempt_journal_not_ready"
        | "autonomous_research_one_shot_protected_campaign_fingerprint_invalid"
        | "autonomous_research_one_shot_protected_campaign_missing"
        | "autonomous_research_one_shot_target_campaign_already_exists"
        | "autonomous_research_one_shot_target_campaign_attempt_already_recorded" => {
            ("campaign_state_not_ready", "reviewed_target")
        }
        "autonomous_research_one_shot_source_snapshot_blocked:dirty_git_worktree"
        | "autonomous_research_one_shot_source_provenance_invalid" => {
            ("source_not_clean", "source_provenance")
        }
        "autonomous_research_one_shot_source_snapshot_invalid" => {
            ("source_not_clean", "source_snapshot")
        }
        _ => return Err("autonomous_research_one_shot_preflight_blocker_code_invalid".into()),
    })
}
fn blockers(
    codes: &mut Vec<String>,
    control: &ReconciliationReadControlV1,
) -> Result<Json, String> {
    codes.sort();
    codes.dedup();
    let values = codes
        .iter()
        .map(|code| {
            let (class, stage) = policy(code)?;
            let diagnostic = object([
                ("version", Json::Number(1.0)),
                ("errorCode", string(code)),
                ("failureClass", string(class)),
                ("failingStage", string(stage)),
            ]);
            Ok(object([
                ("version", Json::Number(1.0)),
                (
                    "kind",
                    string("AutonomousResearchOneShotCampaignPreflightBlocker"),
                ),
                ("errorCode", string(code)),
                ("failureClass", string(class)),
                ("failingStage", string(stage)),
                (
                    "diagnosticHash",
                    string(&hash(
                        "AutonomousResearchOneShotCampaignPreflightDiagnostic",
                        &diagnostic,
                        &control.cancelled,
                    )?),
                ),
            ]))
        })
        .collect::<Result<Vec<_>, String>>()?;
    Ok(Json::Array(values))
}
pub(super) fn run(
    workspace: &Path,
    runtime: &Path,
    control_root: &Path,
    mount_file: Option<&str>,
    action: &str,
    control: &ReconciliationReadControlV1,
    serialize: impl FnOnce(&Json, &ReconciliationReadControlV1) -> Result<Vec<u8>, String>,
) -> Result<OrdinaryReadonlyOutputV1, String> {
    super::inputs::with_retained_preflight_facts(
        workspace,
        runtime,
        control_root,
        mount_file,
        control,
        |facts| {
            let super::inputs::PreflightFactsV1 {
                mut codes,
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
            } = facts;
            let c = contract()?;
            let typed = blockers(&mut codes, control)?;
            let dataset_blocked = codes
                .iter()
                .any(|v| v.starts_with("autonomous_research_one_shot_dataset_"));
            let provider_blocked = codes
                .iter()
                .any(|v| v.starts_with("autonomous_research_one_shot_provider_"));
            let reviewed_blocked = codes
                .iter()
                .any(|v| policy(v).is_ok_and(|(_, stage)| stage == "reviewed_target"));
            let source_blocked = codes
                .iter()
                .any(|v| policy(v).is_ok_and(|(class, _)| class == "source_not_clean"));
            let payload = object([
                ("version", Json::Number(1.0)),
                (
                    "kind",
                    string("AutonomousResearchOneShotCampaignPreflightReport"),
                ),
                (
                    "status",
                    string(if codes.is_empty() {
                        "autonomous_research_one_shot_campaign_preflight_passed"
                    } else {
                        "autonomous_research_one_shot_campaign_preflight_blocked"
                    }),
                ),
                ("action", string(action)),
                ("campaignId", from_value(&c["currentTarget"]["campaignId"])?),
                (
                    "checks",
                    object([
                        (
                            "dataset",
                            object([
                                ("status", status(dataset_blocked)),
                                ("datasetMountsHash", nullable(mounts_hash)),
                                ("authorityReceiptHash", nullable(dataset_receipt_hash)),
                            ]),
                        ),
                        (
                            "provider",
                            object([
                                ("status", status(provider_blocked)),
                                ("providerConfigurationHash", nullable(provider_hash)),
                                ("providerRuntimeBindingHash", Json::Null),
                            ]),
                        ),
                        (
                            "reviewedTarget",
                            object([
                                ("status", status(reviewed_blocked)),
                                ("protectedCampaignFingerprintHash", nullable(protected_hash)),
                                ("targetCampaignAbsent", target_absent),
                                ("targetJournalAttemptAbsent", journal_absent),
                            ]),
                        ),
                        (
                            "reviewerIndependence",
                            object([
                                ("status", string("not_proven")),
                                ("independentPrincipalVerified", Json::Bool(false)),
                                ("independentServiceVerified", Json::Bool(false)),
                                ("independentOrganizationVerified", Json::Bool(false)),
                                ("independentCredentialRootVerified", Json::Bool(false)),
                            ]),
                        ),
                        (
                            "source",
                            object([
                                ("status", status(source_blocked)),
                                ("codeProvenanceHash", nullable(provenance_hash)),
                                ("sourceExecutionSnapshotHash", nullable(snapshot_hash)),
                            ]),
                        ),
                        (
                            "executionBinding",
                            object([
                                ("status", string("not_proven")),
                                ("executionBindingHash", Json::Null),
                            ]),
                        ),
                    ]),
                ),
                ("blockers", typed),
                ("readyForReservation", Json::Bool(codes.is_empty())),
                ("executionAuthorized", Json::Bool(false)),
                ("campaignPreparationVerified", Json::Bool(false)),
                ("providerCanaryVerified", Json::Bool(false)),
                ("launchReadinessVerified", Json::Bool(false)),
                (
                    "sideEffects",
                    object([
                        ("reservationCreated", Json::Bool(false)),
                        ("journalWriteRepositoryOpened", Json::Bool(false)),
                        (
                            "journalReadOnlyInspectionPerformed",
                            Json::Bool(journal_inspected),
                        ),
                        ("nativeDatabaseWritePerformed", Json::Bool(false)),
                        (
                            "nativeStoreReadOnlyInspectionPerformed",
                            Json::Bool(native_inspected),
                        ),
                        (
                            "nativeStoreImmutableSnapshotVerified",
                            Json::Bool(native_unchanged),
                        ),
                        ("nativeStoreFilesystemWritePerformed", Json::Bool(false)),
                        ("providerInvocationPerformed", Json::Bool(false)),
                        ("campaignLaunchPerformed", Json::Bool(false)),
                        ("networkAccessPerformed", Json::Bool(false)),
                    ]),
                ),
            ]);
            let digest = hash(
                "AutonomousResearchOneShotCampaignPreflightReport",
                &payload,
                &control.cancelled,
            )?;
            let Json::Object(mut fields) = payload else {
                return Err("autonomous_research_one_shot_campaign_preflight_invalid".into());
            };
            fields.push((
                "autonomousResearchOneShotCampaignPreflightHash"
                    .encode_utf16()
                    .collect(),
                string(&digest),
            ));
            let stdout = serialize(&Json::Object(fields), control)?;
            Ok(OrdinaryReadonlyOutputV1 {
                stdout,
                stderr: Vec::new(),
                exit_code: if codes.is_empty() { 0 } else { 2 },
            })
        },
    )
}

#[cfg(test)]
pub(super) mod tests;
