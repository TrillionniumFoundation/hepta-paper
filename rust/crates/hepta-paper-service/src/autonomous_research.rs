//! Rust-owned autonomous-research entry over the existing durable local workflow.
//!
//! The local/shadow path reuses the canonical object store, campaign writer,
//! control plane, verifier, and workflow recovery owner. It deliberately cannot
//! activate production, load live provider credentials, or grant external
//! authority. Production and golden-bootstrap remain fail closed until their
//! independently controlled qualification inputs are composed.

#![forbid(unsafe_code)]

use crate::workflow::{
    LocalWorkflowV1, WorkflowActionV1, WorkflowProgressV1, initialize_local_workflow_v1,
    operate_local_workflow_v1,
};
use hepta_codex_protocol::Sha256Digest;
use nix::fcntl::OFlag;
use serde_json::{Value, json};
use std::{
    fs::{self, OpenOptions},
    io::Read,
    os::unix::fs::{MetadataExt, OpenOptionsExt},
    path::{Path, PathBuf},
};

const MAX_WORKFLOW_DEFINITION_BYTES: usize = 16 * 1024 * 1024;

pub const AUTONOMOUS_RESEARCH_USAGE: &str = r#"{
  "version": 5,
  "kind": "AutonomousResearchCampaignUsage",
  "usage": "hepta-paper-rust autonomous-research --action prepare|launch|status|pause|resume|cancel|converge [--launch-mode local-run|production-run|golden-bootstrap] [--paper-id ID|--campaign-id ID] [--workflow-definition ABSOLUTE_PATH] [--state-directory ABSOLUTE_PATH --definition-hash sha256:...] [--through-steps N] [--expected-revision N] [--now UNIX_MILLIS] [--require-full-ready]",
  "defaultLaunchMode": "local-run",
  "safety": {
    "operatorApprovalClaimed": false,
    "selfSignedExternalTrustClaimed": false,
    "externalSubmissionEnabled": false,
    "universalResearchValidityClaimed": false,
    "naturalLanguageToLeanEquivalenceMachineProven": false,
    "automaticBudgetExpansionEnabled": false
  },
  "rustBoundary": "local-run composes the existing durable Rust workflow owner; production-run and golden-bootstrap remain blocked pending independent authority"
}"#;

#[derive(Clone, Debug)]
pub struct AutonomousResearchOptions {
    pub action: String,
    pub launch_mode: String,
    pub paper_id: Option<String>,
    pub campaign_id: Option<String>,
    pub require_full_ready: bool,
    pub help: bool,
    pub workflow_definition: Option<PathBuf>,
    pub state_directory: Option<PathBuf>,
    pub definition_hash: Option<Sha256Digest>,
    pub through_steps: Option<usize>,
    pub expected_revision: Option<u64>,
    pub now_unix_ms: Option<u64>,
}

fn value(args: &[String], index: &mut usize, key: &str) -> Result<String, String> {
    if *index + 1 >= args.len() {
        return Err(format!("autonomous_research_{key}_value_required"));
    }
    let selected = args[*index + 1].clone();
    *index += 2;
    Ok(selected)
}

fn bounded_usize(value: String, key: &str) -> Result<usize, String> {
    let parsed = value
        .parse::<usize>()
        .map_err(|_| format!("autonomous_research_{key}_invalid"))?;
    if parsed == 0 || parsed > 128 {
        return Err(format!("autonomous_research_{key}_invalid"));
    }
    Ok(parsed)
}

fn bounded_u64(value: String, key: &str) -> Result<u64, String> {
    value
        .parse::<u64>()
        .map_err(|_| format!("autonomous_research_{key}_invalid"))
}

pub fn parse_autonomous_research_arguments(
    args: &[String],
) -> Result<AutonomousResearchOptions, String> {
    let mut action = "prepare".to_owned();
    let mut launch_mode = "local-run".to_owned();
    let mut paper_id = None;
    let mut campaign_id = None;
    let mut require_full_ready = false;
    let mut help = false;
    let mut workflow_definition = None;
    let mut state_directory = None;
    let mut definition_hash = None;
    let mut through_steps = None;
    let mut expected_revision = None;
    let mut now_unix_ms = None;
    let mut index = 0;
    while index < args.len() {
        match args[index].as_str() {
            "--help" if !help => {
                help = true;
                index += 1;
            }
            "--action" => action = value(args, &mut index, "action")?,
            "--launch-mode" => launch_mode = value(args, &mut index, "launch_mode")?,
            "--paper-id" => paper_id = Some(value(args, &mut index, "paper_id")?),
            "--campaign-id" => campaign_id = Some(value(args, &mut index, "campaign_id")?),
            "--require-full-ready" if !require_full_ready => {
                require_full_ready = true;
                index += 1;
            }
            "--workflow-definition" => {
                workflow_definition = Some(PathBuf::from(value(
                    args,
                    &mut index,
                    "workflow_definition",
                )?));
            }
            "--state-directory" => {
                state_directory = Some(PathBuf::from(value(args, &mut index, "state_directory")?));
            }
            "--definition-hash" => {
                let supplied = value(args, &mut index, "definition_hash")?;
                definition_hash = Some(
                    supplied
                        .parse()
                        .map_err(|_| "autonomous_research_definition_hash_invalid".to_owned())?,
                );
            }
            "--through-steps" => {
                through_steps = Some(bounded_usize(
                    value(args, &mut index, "through_steps")?,
                    "through_steps",
                )?);
            }
            "--expected-revision" => {
                expected_revision = Some(bounded_u64(
                    value(args, &mut index, "expected_revision")?,
                    "expected_revision",
                )?);
            }
            "--now" => {
                now_unix_ms = Some(bounded_u64(
                    value(args, &mut index, "now")?,
                    "now",
                )?);
            }
            token => return Err(format!("unsupported_autonomous_research_argument:{token}")),
        }
    }
    if help {
        return Ok(AutonomousResearchOptions {
            action,
            launch_mode,
            paper_id,
            campaign_id,
            require_full_ready,
            help,
            workflow_definition,
            state_directory,
            definition_hash,
            through_steps,
            expected_revision,
            now_unix_ms,
        });
    }
    if !matches!(
        action.as_str(),
        "prepare" | "launch" | "status" | "pause" | "resume" | "cancel" | "converge"
    ) {
        return Err(format!(
            "autonomous_research_campaign_action_invalid:{action}"
        ));
    }
    if !matches!(
        launch_mode.as_str(),
        "local-run" | "production-run" | "golden-bootstrap"
    ) {
        return Err(format!(
            "autonomous_research_launch_mode_invalid:{launch_mode}"
        ));
    }
    if paper_id.as_deref().unwrap_or("").trim().is_empty()
        && campaign_id.as_deref().unwrap_or("").trim().is_empty()
    {
        return Err("autonomous_research_paper_or_campaign_id_required".to_owned());
    }
    Ok(AutonomousResearchOptions {
        action,
        launch_mode,
        paper_id,
        campaign_id,
        require_full_ready,
        help,
        workflow_definition,
        state_directory,
        definition_hash,
        through_steps,
        expected_revision,
        now_unix_ms,
    })
}

pub fn autonomous_research_help_json_v1() -> Value {
    json!({
        "version": 5,
        "kind": "AutonomousResearchCampaignUsage",
        "usage": "hepta-paper-rust autonomous-research --action prepare|launch|status|pause|resume|cancel|converge [--launch-mode local-run|production-run|golden-bootstrap] [--paper-id ID|--campaign-id ID] [--workflow-definition ABSOLUTE_PATH] [--state-directory ABSOLUTE_PATH --definition-hash sha256:...] [--through-steps N] [--expected-revision N] [--now UNIX_MILLIS] [--require-full-ready]",
        "defaultLaunchMode": "local-run",
        "safety": {
            "operatorApprovalClaimed": false,
            "selfSignedExternalTrustClaimed": false,
            "externalSubmissionEnabled": false,
            "universalResearchValidityClaimed": false,
            "naturalLanguageToLeanEquivalenceMachineProven": false,
            "automaticBudgetExpansionEnabled": false
        },
        "rustBoundary": "local-run composes the existing durable Rust workflow owner; production-run and golden-bootstrap remain blocked pending independent authority"
    })
}

fn campaign_id(options: &AutonomousResearchOptions) -> Option<String> {
    options.campaign_id.clone().or_else(|| {
        options
            .paper_id
            .as_ref()
            .map(|id| format!("autonomous-research:{id}"))
    })
}

pub fn inspect_autonomous_research_v1(options: &AutonomousResearchOptions) -> Value {
    let mut blockers = vec![
        "rust_autonomous_research_external_qualification_not_complete".to_owned(),
        "rust_autonomous_research_live_provider_authority_not_composed".to_owned(),
    ];
    if options.launch_mode == "production-run" {
        blockers.push("autonomous_research_production_external_authority_required".to_owned());
    }
    if options.launch_mode == "golden-bootstrap" {
        blockers.push("autonomous_research_golden_bootstrap_authority_required".to_owned());
    }
    if options.workflow_definition.is_none()
        && (options.state_directory.is_none() || options.definition_hash.is_none())
    {
        blockers.push("rust_autonomous_research_workflow_subject_required".to_owned());
    }
    blockers.sort();
    blockers.dedup();
    json!({
        "version": 2,
        "kind": "AutonomousResearchCampaignReport",
        "status": "autonomous_research_campaign_blocked",
        "action": options.action,
        "launchMode": options.launch_mode,
        "paperId": options.paper_id,
        "campaignId": campaign_id(options),
        "ready": false,
        "operationSucceeded": false,
        "localWorkflowReady": false,
        "campaignPersisted": false,
        "workerExecutionPerformed": false,
        "providerExecutionPerformed": false,
        "externalActionPerformed": false,
        "networkActionPerformed": false,
        "blockers": blockers,
        "requireFullReady": options.require_full_ready,
        "rustBoundary": "durable-local-workflow-owner-available-but-subject-or-authority-missing"
    })
}

fn read_definition(path: &Path) -> Result<LocalWorkflowV1, String> {
    if !path.is_absolute() {
        return Err("autonomous_research_workflow_definition_not_absolute".to_owned());
    }
    let named = fs::symlink_metadata(path)
        .map_err(|_| "autonomous_research_workflow_definition_unavailable".to_owned())?;
    if !named.is_file()
        || named.file_type().is_symlink()
        || named.nlink() != 1
        || named.len() == 0
        || named.len() > MAX_WORKFLOW_DEFINITION_BYTES as u64
    {
        return Err("autonomous_research_workflow_definition_invalid".to_owned());
    }
    let mut file = OpenOptions::new()
        .read(true)
        .custom_flags((OFlag::O_NOFOLLOW | OFlag::O_NONBLOCK).bits())
        .open(path)
        .map_err(|_| "autonomous_research_workflow_definition_unavailable".to_owned())?;
    let opened = file
        .metadata()
        .map_err(|_| "autonomous_research_workflow_definition_unavailable".to_owned())?;
    if opened.ino() != named.ino()
        || opened.dev() != named.dev()
        || opened.nlink() != 1
        || opened.len() != named.len()
    {
        return Err("autonomous_research_workflow_definition_changed".to_owned());
    }
    let mut bytes = Vec::new();
    Read::by_ref(&mut file)
        .take(MAX_WORKFLOW_DEFINITION_BYTES as u64 + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| "autonomous_research_workflow_definition_unavailable".to_owned())?;
    let after = file
        .metadata()
        .map_err(|_| "autonomous_research_workflow_definition_unavailable".to_owned())?;
    let current = fs::symlink_metadata(path)
        .map_err(|_| "autonomous_research_workflow_definition_unavailable".to_owned())?;
    if bytes.len() as u64 != opened.len()
        || opened.ino() != current.ino()
        || opened.dev() != current.dev()
        || opened.mtime() != after.mtime()
        || opened.mtime_nsec() != after.mtime_nsec()
        || opened.ctime() != after.ctime()
        || opened.ctime_nsec() != after.ctime_nsec()
    {
        return Err("autonomous_research_workflow_definition_changed".to_owned());
    }
    serde_json::from_slice(&bytes)
        .map_err(|_| "autonomous_research_workflow_definition_invalid".to_owned())
}

fn validate_definition_identity(
    options: &AutonomousResearchOptions,
    definition: &LocalWorkflowV1,
) -> Result<(), String> {
    let expected = campaign_id(options)
        .ok_or_else(|| "autonomous_research_campaign_identity_required".to_owned())?;
    if definition.template.snapshot.campaign_id != expected {
        return Err("autonomous_research_campaign_identity_mismatch".to_owned());
    }
    if let Some(root) = &options.state_directory
        && &definition.template.state_directory != root
    {
        return Err("autonomous_research_state_directory_mismatch".to_owned());
    }
    Ok(())
}

fn state_subject(
    options: &AutonomousResearchOptions,
) -> Result<(&Path, &Sha256Digest), String> {
    let root = options
        .state_directory
        .as_deref()
        .ok_or_else(|| "autonomous_research_state_directory_required".to_owned())?;
    let hash = options
        .definition_hash
        .as_ref()
        .ok_or_else(|| "autonomous_research_definition_hash_required".to_owned())?;
    Ok((root, hash))
}

fn now(options: &AutonomousResearchOptions) -> Result<u64, String> {
    match options.now_unix_ms {
        Some(value) if value > 0 => Ok(value),
        _ => Err("autonomous_research_now_required".to_owned()),
    }
}

fn progress_report(
    options: &AutonomousResearchOptions,
    definition_hash: &Sha256Digest,
    progress: &WorkflowProgressV1,
    worker_execution_performed: bool,
) -> Result<Value, String> {
    let workflow = serde_json::to_value(progress)
        .map_err(|_| "autonomous_research_progress_encoding_failed".to_owned())?;
    Ok(json!({
        "version": 2,
        "kind": "AutonomousResearchCampaignReport",
        "status": "autonomous_research_local_workflow_observed",
        "action": options.action,
        "launchMode": options.launch_mode,
        "paperId": options.paper_id,
        "campaignId": campaign_id(options),
        "definitionHash": definition_hash,
        "ready": false,
        "operationSucceeded": true,
        "localWorkflowReady": true,
        "campaignPersisted": true,
        "workerExecutionPerformed": worker_execution_performed,
        "providerExecutionPerformed": false,
        "externalActionPerformed": false,
        "networkActionPerformed": false,
        "blockers": [
            "rust_autonomous_research_external_qualification_not_complete",
            "rust_autonomous_research_live_provider_authority_not_composed"
        ],
        "requireFullReady": options.require_full_ready,
        "workflow": workflow,
        "rustBoundary": "durable-local-workflow-owner"
    }))
}

/// Execute the Rust-owned local migration path. Missing local subjects retain the
/// historical fail-closed diagnostic. Production and golden-bootstrap never
/// enter the local writer or worker graph.
pub fn execute_autonomous_research_v1(
    options: &AutonomousResearchOptions,
) -> Result<Value, String> {
    if options.launch_mode != "local-run" {
        return Ok(inspect_autonomous_research_v1(options));
    }
    match options.action.as_str() {
        "prepare" => {
            let Some(path) = options.workflow_definition.as_deref() else {
                return Ok(inspect_autonomous_research_v1(options));
            };
            let definition = read_definition(path)?;
            validate_definition_identity(options, &definition)?;
            let hash = initialize_local_workflow_v1(definition)
                .map_err(|error| format!("autonomous_research_prepare_failed:{error}"))?;
            let root = options
                .state_directory
                .as_deref()
                .or_else(|| {
                    options.workflow_definition.as_ref().and_then(|_| None)
                });
            let state_root = if let Some(root) = root {
                root
            } else {
                let definition = read_definition(path)?;
                definition.template.state_directory.as_path()
            };
            let progress = operate_local_workflow_v1(
                state_root,
                &hash,
                WorkflowActionV1::Status,
                0,
            )
            .map_err(|error| format!("autonomous_research_prepare_observation_failed:{error}"))?;
            progress_report(options, &hash, &progress, false)
        }
        "status" => {
            let (root, hash) = state_subject(options)?;
            let progress =
                operate_local_workflow_v1(root, hash, WorkflowActionV1::Status, 0)
                    .map_err(|error| format!("autonomous_research_status_failed:{error}"))?;
            progress_report(options, hash, &progress, false)
        }
        "launch" => {
            let (root, hash) = state_subject(options)?;
            let before =
                operate_local_workflow_v1(root, hash, WorkflowActionV1::Status, 0)
                    .map_err(|error| format!("autonomous_research_status_failed:{error}"))?;
            if before.committed_steps >= before.total_steps {
                return progress_report(options, hash, &before, false);
            }
            let target = options.through_steps.unwrap_or_else(|| {
                before
                    .committed_steps
                    .saturating_add(1)
                    .min(before.total_steps)
            });
            if target < before.committed_steps {
                return Err("autonomous_research_through_steps_behind_progress".to_owned());
            }
            let progress = operate_local_workflow_v1(
                root,
                hash,
                WorkflowActionV1::Advance {
                    through_steps: target,
                },
                now(options)?,
            )
            .map_err(|error| format!("autonomous_research_launch_failed:{error}"))?;
            progress_report(
                options,
                hash,
                &progress,
                progress.committed_steps > before.committed_steps,
            )
        }
        "converge" => {
            let (root, hash) = state_subject(options)?;
            let before =
                operate_local_workflow_v1(root, hash, WorkflowActionV1::Status, 0)
                    .map_err(|error| format!("autonomous_research_status_failed:{error}"))?;
            if before.committed_steps >= before.total_steps {
                return progress_report(options, hash, &before, false);
            }
            let progress = operate_local_workflow_v1(
                root,
                hash,
                WorkflowActionV1::Advance {
                    through_steps: before.total_steps,
                },
                now(options)?,
            )
            .map_err(|error| format!("autonomous_research_converge_failed:{error}"))?;
            progress_report(
                options,
                hash,
                &progress,
                progress.committed_steps > before.committed_steps,
            )
        }
        "pause" | "resume" | "cancel" => {
            let (root, hash) = state_subject(options)?;
            let expected_revision = options
                .expected_revision
                .ok_or_else(|| "autonomous_research_expected_revision_required".to_owned())?;
            let action = match options.action.as_str() {
                "pause" => WorkflowActionV1::Pause { expected_revision },
                "resume" => WorkflowActionV1::Resume { expected_revision },
                _ => WorkflowActionV1::Cancel { expected_revision },
            };
            let progress = operate_local_workflow_v1(root, hash, action, now(options)?)
                .map_err(|error| format!("autonomous_research_lifecycle_failed:{error}"))?;
            progress_report(options, hash, &progress, false)
        }
        _ => Err("autonomous_research_action_unreachable".to_owned()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parser_requires_identity_and_rejects_unknown_modes() {
        assert_eq!(
            parse_autonomous_research_arguments(&[]).unwrap_err(),
            "autonomous_research_paper_or_campaign_id_required"
        );
        assert!(
            parse_autonomous_research_arguments(&[
                "--paper-id".into(),
                "p".into(),
                "--launch-mode".into(),
                "bad".into()
            ])
            .is_err()
        );
    }

    #[test]
    fn missing_workflow_subject_remains_fail_closed() {
        let options = parse_autonomous_research_arguments(&[
            "--paper-id".into(),
            "paper-1".into(),
            "--action".into(),
            "launch".into(),
        ])
        .unwrap();
        let report = inspect_autonomous_research_v1(&options);
        assert_eq!(report["ready"], false);
        assert_eq!(report["operationSucceeded"], false);
        assert_eq!(report["campaignPersisted"], false);
        assert_eq!(report["providerExecutionPerformed"], false);
    }

    #[test]
    fn production_run_never_enters_local_execution() {
        let options = parse_autonomous_research_arguments(&[
            "--paper-id".into(),
            "paper-1".into(),
            "--action".into(),
            "launch".into(),
            "--launch-mode".into(),
            "production-run".into(),
            "--state-directory".into(),
            "/tmp/does-not-matter".into(),
            "--definition-hash".into(),
            format!("sha256:{}", "1".repeat(64)),
            "--now".into(),
            "1".into(),
        ])
        .unwrap();
        let report = execute_autonomous_research_v1(&options).unwrap();
        assert_eq!(report["operationSucceeded"], false);
        assert_eq!(report["externalActionPerformed"], false);
    }
}
