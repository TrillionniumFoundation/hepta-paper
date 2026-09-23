//! Bounded command surface for the Node autonomous-research campaign route.
//!
//! Explicit local workflows use the existing SQLite/CAS and dispatch owners.
//! Automatic research planning, live models, production qualification renewal
//! and the complete incumbent business surface remain outside this local path.

#![forbid(unsafe_code)]

use hepta_codex_protocol::Sha256Digest;
use serde_json::{Value, json};
use std::{
    collections::BTreeSet,
    path::PathBuf,
    sync::{Arc, atomic::AtomicBool},
};

mod local;

pub const AUTONOMOUS_RESEARCH_USAGE: &str = r#"{
  "version": 4,
  "kind": "AutonomousResearchCampaignUsage",
  "usage": "hepta-paper operator autonomous-research -- [--launch-mode local-run|production-run|golden-bootstrap] [--action prepare|launch|status|resume|converge] --paper-id ID",
  "defaultLaunchMode": "local-run",
  "localWorkflowUsage": "--campaign-id ID --workflow-file ABSOLUTE_JSON --action prepare|launch|status|converge|pause|resume|cancel [--through-steps N] [--expected-revision N]",
  "persistedWorkflowUsage": "--campaign-id ID --workflow-root ABSOLUTE_STATE --definition-hash SHA256 --action launch|status|converge|pause|resume|cancel|amend [--amendment-file ABSOLUTE_JSON] [--through-steps N] [--expected-revision N]",
  "safety": {
    "operatorApprovalClaimed": false,
    "selfSignedExternalTrustClaimed": false,
    "externalSubmissionEnabled": false,
    "universalResearchValidityClaimed": false,
    "naturalLanguageToLeanEquivalenceMachineProven": false,
    "automaticBudgetExpansionEnabled": false
  },
  "rustBoundary": "explicit local workflow reuses the existing durable owner; without an explicit workflow file or persisted reference this remains diagnostic-only; no production, live-model or submission authority"
}"#;

#[derive(Clone, Debug)]
pub struct AutonomousResearchOptions {
    pub action: String,
    pub launch_mode: String,
    pub paper_id: Option<String>,
    pub campaign_id: Option<String>,
    pub workflow_file: Option<PathBuf>,
    pub workflow_root: Option<PathBuf>,
    pub definition_hash: Option<Sha256Digest>,
    pub amendment_file: Option<PathBuf>,
    pub through_steps: Option<usize>,
    pub expected_revision: Option<u64>,
    pub require_full_ready: bool,
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

pub fn parse_autonomous_research_arguments(
    args: &[String],
) -> Result<AutonomousResearchOptions, String> {
    let mut action = "prepare".to_owned();
    let mut launch_mode = "local-run".to_owned();
    let mut paper_id = None;
    let mut campaign_id = None;
    let mut require_full_ready = false;
    let mut help = false;
    let mut workflow_file = None;
    let mut workflow_root = None;
    let mut definition_hash = None;
    let mut amendment_file = None;
    let mut through_steps = None;
    let mut expected_revision = None;
    let mut seen = BTreeSet::new();
    let mut index = 0;
    while index < args.len() {
        if !seen.insert(args[index].clone()) {
            return Err("duplicate_autonomous_research_argument".to_owned());
        }
        match args[index].as_str() {
            "--help" if !help => {
                help = true;
                index += 1;
            }
            "--action" => action = value(args, &mut index, "action")?,
            "--launch-mode" => launch_mode = value(args, &mut index, "launch_mode")?,
            "--paper-id" => paper_id = Some(value(args, &mut index, "paper_id")?),
            "--campaign-id" => campaign_id = Some(value(args, &mut index, "campaign_id")?),
            "--workflow-file" => {
                workflow_file = Some(PathBuf::from(value(args, &mut index, "workflow_file")?))
            }
            "--workflow-root" => {
                workflow_root = Some(PathBuf::from(value(args, &mut index, "workflow_root")?))
            }
            "--definition-hash" => {
                definition_hash = Some(
                    value(args, &mut index, "definition_hash")?
                        .parse::<Sha256Digest>()
                        .map_err(|_| "invalid_autonomous_research_definition_hash".to_owned())?,
                )
            }
            "--amendment-file" => {
                amendment_file = Some(PathBuf::from(value(args, &mut index, "amendment_file")?))
            }
            "--through-steps" => {
                through_steps = Some(
                    value(args, &mut index, "through_steps")?
                        .parse::<usize>()
                        .map_err(|_| "invalid_autonomous_research_through_steps".to_owned())?,
                )
            }
            "--expected-revision" => {
                expected_revision = Some(
                    value(args, &mut index, "expected_revision")?
                        .parse::<u64>()
                        .map_err(|_| "invalid_autonomous_research_expected_revision".to_owned())?,
                )
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
            workflow_file,
            workflow_root,
            definition_hash,
            amendment_file,
            through_steps,
            expected_revision,
            require_full_ready,
            help,
        });
    }
    if !matches!(
        action.as_str(),
        "prepare" | "launch" | "status" | "resume" | "converge" | "pause" | "cancel" | "amend"
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
    if workflow_root.is_some() != definition_hash.is_some()
        || (workflow_root.is_some() && workflow_file.is_some())
        || (workflow_root.is_some() && action == "prepare")
        || (action == "amend"
            && (workflow_root.is_none()
                || amendment_file.is_none()
                || through_steps.is_some()
                || expected_revision.is_some()))
        || (action != "amend" && amendment_file.is_some())
    {
        return Err("autonomous_research_local_reference_or_amendment_invalid".to_owned());
    }
    if workflow_file.is_none()
        && workflow_root.is_none()
        && (through_steps.is_some()
            || expected_revision.is_some()
            || matches!(action.as_str(), "pause" | "cancel"))
    {
        return Err("autonomous_research_workflow_file_required".to_owned());
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
        workflow_file,
        workflow_root,
        definition_hash,
        amendment_file,
        through_steps,
        expected_revision,
        require_full_ready,
        help,
    })
}

pub fn autonomous_research_help_json_v1() -> Value {
    json!({
          "version": 4,
          "kind": "AutonomousResearchCampaignUsage",
          "usage": "hepta-paper operator autonomous-research -- [--launch-mode local-run|production-run|golden-bootstrap] [--action prepare|launch|status|resume|converge] --paper-id ID",
          "defaultLaunchMode": "local-run",
    "localWorkflowUsage": "--campaign-id ID --workflow-file ABSOLUTE_JSON --action prepare|launch|status|converge|pause|resume|cancel [--through-steps N] [--expected-revision N]",
          "persistedWorkflowUsage": "--campaign-id ID --workflow-root ABSOLUTE_STATE --definition-hash SHA256 --action launch|status|converge|pause|resume|cancel|amend [--amendment-file ABSOLUTE_JSON] [--through-steps N] [--expected-revision N]",
          "safety": {
              "operatorApprovalClaimed": false,
              "selfSignedExternalTrustClaimed": false,
              "externalSubmissionEnabled": false,
              "universalResearchValidityClaimed": false,
              "naturalLanguageToLeanEquivalenceMachineProven": false,
              "automaticBudgetExpansionEnabled": false
          },
          "rustBoundary": "explicit local workflow reuses the existing durable owner; without an explicit workflow file or persisted reference this remains diagnostic-only; no production, live-model or submission authority"
      })
}

pub fn inspect_autonomous_research_v1(options: &AutonomousResearchOptions) -> Value {
    if options.workflow_file.is_some()
        || options.workflow_root.is_some()
        || options.definition_hash.is_some()
        || options.amendment_file.is_some()
    {
        return local::run(options, false, &Arc::new(AtomicBool::new(false)));
    }
    let campaign_id = options.campaign_id.clone().or_else(|| {
        options
            .paper_id
            .as_ref()
            .map(|id| format!("autonomous-research:{id}"))
    });
    let mut blockers = vec![
        "rust_autonomous_research_campaign_persistence_not_ported".to_owned(),
        "rust_autonomous_research_provider_execution_not_ported".to_owned(),
        "rust_autonomous_research_external_qualification_not_ported".to_owned(),
    ];
    if options.launch_mode == "production-run" {
        blockers.push("autonomous_research_production_external_authority_required".to_owned());
    }
    blockers.sort();
    blockers.dedup();
    json!({
        "version": 1,
        "kind": "AutonomousResearchCampaignReport",
        "status": "autonomous_research_campaign_blocked",
        "action": options.action,
        "launchMode": options.launch_mode,
        "paperId": options.paper_id,
        "campaignId": campaign_id,
        "ready": false,
        "campaignPersisted": false,
        "providerExecutionPerformed": false,
        "externalActionPerformed": false,
        "networkActionPerformed": false,
        "blockers": blockers,
        "requireFullReady": options.require_full_ready,
        "rustBoundary": "diagnostic-only"
    })
}

pub fn execute_autonomous_research_v1(options: &AutonomousResearchOptions) -> Value {
    execute_autonomous_research_with_cancellation_v1(options, Arc::new(AtomicBool::new(false)))
}

/// The command's signal token is not serialized and cannot confer authority.
/// Existing non-signal callers retain the same owner and explicit lifecycle API.
pub fn execute_autonomous_research_with_cancellation_v1(
    options: &AutonomousResearchOptions,
    cancelled: Arc<AtomicBool>,
) -> Value {
    if options.workflow_file.is_some()
        || options.workflow_root.is_some()
        || options.definition_hash.is_some()
        || options.amendment_file.is_some()
    {
        return local::run(options, true, &cancelled);
    }
    inspect_autonomous_research_v1(options)
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
    fn report_never_claims_campaign_or_provider_execution() {
        let options = parse_autonomous_research_arguments(&[
            "--paper-id".into(),
            "paper-1".into(),
            "--action".into(),
            "launch".into(),
        ])
        .unwrap();
        let report = inspect_autonomous_research_v1(&options);
        assert_eq!(report["ready"], false);
        assert_eq!(report["campaignPersisted"], false);
        assert_eq!(report["providerExecutionPerformed"], false);
        assert_eq!(report["externalActionPerformed"], false);
    }
}
