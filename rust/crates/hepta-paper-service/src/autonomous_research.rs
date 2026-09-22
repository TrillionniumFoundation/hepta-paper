//! Bounded Rust product entry for autonomous research.
//!
//! Local/shadow actions reuse the existing durable LocalWorkflowV1 owner:
//! campaign SQLite, CAS, executor, verifier and commit sequencer. Production
//! activation, provider credentials and external effects remain separately
//! qualified and therefore fail closed here.

#![forbid(unsafe_code)]

use crate::workflow::{
    LocalWorkflowV1, WorkflowActionV1, WorkflowProgressV1, initialize_local_workflow_v1,
    operate_local_workflow_v1,
};
use hepta_codex_protocol::Sha256Digest;
use nix::fcntl::OFlag;
use serde_json::{Value, json};
use std::{
    fs::OpenOptions,
    io::Read,
    os::unix::fs::{MetadataExt, OpenOptionsExt},
    path::{Path, PathBuf},
};

const MAX_DEFINITION_BYTES: usize = 16 * 1024 * 1024;

pub const AUTONOMOUS_RESEARCH_USAGE: &str = r#"{
  "version": 5,
  "kind": "AutonomousResearchCampaignUsage",
  "usage": "hepta-paper operator autonomous-research -- [--launch-mode local-run|production-run|golden-bootstrap] [--action prepare|launch|status|resume|cancel|converge] --paper-id ID [--campaign-id ID] [--workflow-definition PATH] [--workflow-state PATH --definition-hash sha256:... --through-steps N --expected-revision N --now-unix-ms N]",
  "defaultLaunchMode": "local-run",
  "safety": {
    "operatorApprovalClaimed": false,
    "selfSignedExternalTrustClaimed": false,
    "externalSubmissionEnabled": false,
    "universalResearchValidityClaimed": false,
    "naturalLanguageToLeanEquivalenceMachineProven": false,
    "automaticBudgetExpansionEnabled": false
  },
  "rustBoundary": "durable local/shadow workflow composition; production provider, external authority, release and submission remain disabled"
}"#;

#[derive(Clone, Debug)]
pub struct AutonomousResearchOptions {
    pub action: String,
    pub launch_mode: String,
    pub paper_id: Option<String>,
    pub campaign_id: Option<String>,
    pub require_full_ready: bool,
    pub workflow_definition: Option<PathBuf>,
    pub workflow_state: Option<PathBuf>,
    pub definition_hash: Option<Sha256Digest>,
    pub through_steps: Option<usize>,
    pub expected_revision: Option<u64>,
    pub now_unix_ms: Option<u64>,
    pub help: bool,
}

fn value(args: &[String], index: &mut usize, key: &str) -> Result<String, String> {
    if *index + 1 >= args.len() {
        return Err(format!("autonomous_research_{key}_value_required"));
    }
    let selected = args[*index + 1].clone();
    *index += 2;
    Ok(selected)
}

fn number<T: std::str::FromStr>(
    args: &[String],
    index: &mut usize,
    key: &str,
) -> Result<T, String> {
    value(args, index, key)?
        .parse()
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
    let mut workflow_definition = None;
    let mut workflow_state = None;
    let mut definition_hash = None;
    let mut through_steps = None;
    let mut expected_revision = None;
    let mut now_unix_ms = None;
    let mut help = false;
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
            "--workflow-definition" if workflow_definition.is_none() => {
                workflow_definition = Some(PathBuf::from(value(
                    args,
                    &mut index,
                    "workflow_definition",
                )?));
            }
            "--workflow-state" if workflow_state.is_none() => {
                workflow_state = Some(PathBuf::from(value(args, &mut index, "workflow_state")?));
            }
            "--definition-hash" if definition_hash.is_none() => {
                definition_hash = Some(number(args, &mut index, "definition_hash")?);
            }
            "--through-steps" if through_steps.is_none() => {
                through_steps = Some(number(args, &mut index, "through_steps")?);
            }
            "--expected-revision" if expected_revision.is_none() => {
                expected_revision = Some(number(args, &mut index, "expected_revision")?);
            }
            "--now-unix-ms" if now_unix_ms.is_none() => {
                now_unix_ms = Some(number(args, &mut index, "now_unix_ms")?);
            }
            "--require-full-ready" if !require_full_ready => {
                require_full_ready = true;
                index += 1;
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
            workflow_definition,
            workflow_state,
            definition_hash,
            through_steps,
            expected_revision,
            now_unix_ms,
            help,
        });
    }
    if !matches!(
        action.as_str(),
        "prepare" | "launch" | "status" | "resume" | "cancel" | "converge"
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
    if through_steps == Some(0) || now_unix_ms == Some(0) {
        return Err("autonomous_research_numeric_bound_invalid".to_owned());
    }
    Ok(AutonomousResearchOptions {
        action,
        launch_mode,
        paper_id,
        campaign_id,
        require_full_ready,
        workflow_definition,
        workflow_state,
        definition_hash,
        through_steps,
        expected_revision,
        now_unix_ms,
        help,
    })
}

pub fn autonomous_research_help_json_v1() -> Value {
    json!({
        "version": 5,
        "kind": "AutonomousResearchCampaignUsage",
        "usage": "hepta-paper operator autonomous-research -- [--launch-mode local-run|production-run|golden-bootstrap] [--action prepare|launch|status|resume|cancel|converge] --paper-id ID [--campaign-id ID] [--workflow-definition PATH] [--workflow-state PATH --definition-hash sha256:... --through-steps N --expected-revision N --now-unix-ms N]",
        "defaultLaunchMode": "local-run",
        "safety": {
            "operatorApprovalClaimed": false,
            "selfSignedExternalTrustClaimed": false,
            "externalSubmissionEnabled": false,
            "universalResearchValidityClaimed": false,
            "naturalLanguageToLeanEquivalenceMachineProven": false,
            "automaticBudgetExpansionEnabled": false
        },
        "rustBoundary": "durable local/shadow workflow composition; production provider, external authority, release and submission remain disabled"
    })
}

fn requested_campaign_id(options: &AutonomousResearchOptions) -> String {
    options.campaign_id.clone().unwrap_or_else(|| {
        format!(
            "autonomous-research:{}",
            options.paper_id.as_deref().unwrap_or_default()
        )
    })
}

fn base_report(options: &AutonomousResearchOptions) -> Value {
    json!({
        "version": 2,
        "kind": "AutonomousResearchCampaignReport",
        "action": options.action,
        "launchMode": options.launch_mode,
        "paperId": options.paper_id,
        "campaignId": requested_campaign_id(options),
        "ready": false,
        "operationSucceeded": false,
        "campaignPersisted": false,
        "workflowExecuted": false,
        "providerExecutionPerformed": false,
        "externalActionPerformed": false,
        "networkActionPerformed": false,
        "productionActivation": false,
        "nodeRetirementVerified": false,
        "requireFullReady": options.require_full_ready
    })
}

pub fn inspect_autonomous_research_v1(options: &AutonomousResearchOptions) -> Value {
    let mut report = base_report(options);
    let mut blockers = vec![
        "rust_autonomous_research_durable_workflow_subject_required".to_owned(),
        "rust_autonomous_research_external_qualification_not_ported".to_owned(),
    ];
    if options.launch_mode == "production-run" {
        blockers.push("autonomous_research_production_external_authority_required".to_owned());
    }
    blockers.sort();
    report["status"] = json!("autonomous_research_campaign_blocked");
    report["blockers"] = json!(blockers);
    report["rustBoundary"] = json!("durable_local_shadow_owner_available");
    report
}

fn read_definition(path: &Path) -> Result<LocalWorkflowV1, &'static str> {
    if !path.is_absolute() {
        return Err("workflow_definition_must_be_absolute");
    }
    let mut file = OpenOptions::new()
        .read(true)
        .custom_flags((OFlag::O_NOFOLLOW | OFlag::O_NONBLOCK).bits())
        .open(path)
        .map_err(|_| "workflow_definition_open_failed")?;
    let metadata = file
        .metadata()
        .map_err(|_| "workflow_definition_metadata_failed")?;
    if !metadata.is_file()
        || metadata.nlink() != 1
        || metadata.len() > MAX_DEFINITION_BYTES as u64
    {
        return Err("workflow_definition_identity_rejected");
    }
    let mut bytes = Vec::new();
    Read::by_ref(&mut file)
        .take(MAX_DEFINITION_BYTES as u64 + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| "workflow_definition_read_failed")?;
    if bytes.len() as u64 != metadata.len() || bytes.len() > MAX_DEFINITION_BYTES {
        return Err("workflow_definition_changed_or_oversize");
    }
    serde_json::from_slice(&bytes).map_err(|_| "workflow_definition_invalid")
}

fn workflow_subject(
    options: &AutonomousResearchOptions,
) -> Result<(&Path, &Sha256Digest), &'static str> {
    match (&options.workflow_state, &options.definition_hash) {
        (Some(root), Some(hash)) if root.is_absolute() => Ok((root.as_path(), hash)),
        (Some(_), Some(_)) => Err("workflow_state_must_be_absolute"),
        _ => Err("workflow_state_and_definition_hash_required"),
    }
}

fn progress_report(
    options: &AutonomousResearchOptions,
    progress: &WorkflowProgressV1,
    definition_hash: &Sha256Digest,
) -> Value {
    let mut report = base_report(options);
    report["status"] = json!("autonomous_research_local_operation_succeeded");
    report["operationSucceeded"] = json!(true);
    report["campaignPersisted"] = json!(true);
    report["workflowExecuted"] = json!(progress.committed_steps > 0);
    report["definitionHash"] = json!(definition_hash);
    report["campaignState"] = json!(progress.campaign_state);
    report["campaignRevision"] = json!(progress.campaign_revision);
    report["committedSteps"] = json!(progress.committed_steps);
    report["totalSteps"] = json!(progress.total_steps);
    report["budgetRemainingMicrousd"] = json!(progress.budget_remaining_microusd);
    report["pendingStep"] = json!(progress.pending_step);
    report["gateRejected"] = json!(progress.gate_rejected);
    report["blockers"] = json!([
        "production_activation_requires_independent_qualification",
        "live_provider_authority_not_granted"
    ]);
    report["rustBoundary"] = json!("durable_local_shadow_workflow");
    report
}

fn blocked(options: &AutonomousResearchOptions, code: &'static str) -> Value {
    let mut report = inspect_autonomous_research_v1(options);
    report["blockers"] = json!([
        code,
        "rust_autonomous_research_external_qualification_not_ported"
    ]);
    report
}

fn execute_local(options: &AutonomousResearchOptions) -> Result<Value, &'static str> {
    if options.launch_mode == "production-run" {
        return Err("production_external_authority_required");
    }
    if options.action == "prepare" {
        let definition_path = options
            .workflow_definition
            .as_deref()
            .ok_or("workflow_definition_required")?;
        let definition = read_definition(definition_path)?;
        if definition.template.snapshot.campaign_id != requested_campaign_id(options) {
            return Err("workflow_campaign_identity_mismatch");
        }
        let hash =
            initialize_local_workflow_v1(definition).map_err(|_| "workflow_initialize_failed")?;
        let root = options
            .workflow_state
            .as_deref()
            .or_else(|| {
                // The persisted owner root is captured by the definition itself;
                // callers may additionally supply it and it is checked by status.
                None
            });
        let definition = read_definition(definition_path)?;
        let state = &definition.template.state_directory;
        if let Some(requested) = root
            && requested != state
        {
            return Err("workflow_state_identity_mismatch");
        }
        let progress = operate_local_workflow_v1(state, &hash, WorkflowActionV1::Status, 0)
            .map_err(|_| "workflow_status_failed_after_initialize")?;
        return Ok(progress_report(options, &progress, &hash));
    }

    let (state, hash) = workflow_subject(options)?;
    let status = operate_local_workflow_v1(state, hash, WorkflowActionV1::Status, 0)
        .map_err(|_| "workflow_status_failed")?;
    let progress = match options.action.as_str() {
        "status" => status,
        "launch" | "converge" => {
            let through_steps = options.through_steps.unwrap_or(status.total_steps);
            let now = options.now_unix_ms.ok_or("workflow_now_required")?;
            operate_local_workflow_v1(
                state,
                hash,
                WorkflowActionV1::Advance { through_steps },
                now,
            )
            .map_err(|_| "workflow_advance_failed")?
        }
        "resume" => {
            let now = options.now_unix_ms.ok_or("workflow_now_required")?;
            let expected_revision = options
                .expected_revision
                .ok_or("workflow_expected_revision_required")?;
            operate_local_workflow_v1(
                state,
                hash,
                WorkflowActionV1::Resume { expected_revision },
                now,
            )
            .map_err(|_| "workflow_resume_failed")?
        }
        "cancel" => {
            let now = options.now_unix_ms.ok_or("workflow_now_required")?;
            let expected_revision = options
                .expected_revision
                .ok_or("workflow_expected_revision_required")?;
            operate_local_workflow_v1(
                state,
                hash,
                WorkflowActionV1::Cancel { expected_revision },
                now,
            )
            .map_err(|_| "workflow_cancel_failed")?
        }
        _ => return Err("workflow_action_not_supported"),
    };
    Ok(progress_report(options, &progress, hash))
}

pub fn execute_autonomous_research_v1(options: &AutonomousResearchOptions) -> Value {
    match execute_local(options) {
        Ok(report) => report,
        Err(code) => blocked(options, code),
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
        assert!(
            parse_autonomous_research_arguments(&[
                "--paper-id".into(),
                "p".into(),
                "--through-steps".into(),
                "0".into()
            ])
            .is_err()
        );
    }

    #[test]
    fn report_without_durable_subject_remains_fail_closed() {
        let options = parse_autonomous_research_arguments(&[
            "--paper-id".into(),
            "paper-1".into(),
            "--action".into(),
            "launch".into(),
        ])
        .unwrap();
        let report = execute_autonomous_research_v1(&options);
        assert_eq!(report["ready"], false);
        assert_eq!(report["operationSucceeded"], false);
        assert_eq!(report["campaignPersisted"], false);
        assert_eq!(report["providerExecutionPerformed"], false);
        assert_eq!(report["externalActionPerformed"], false);
    }
}
