//! Bounded command surface for the Node autonomous-research campaign route.
//!
//! The campaign planner, durable DAG, provider workers, qualification renewal,
//! and external authority composition remain unported. This module exposes the
//! strict action/launch-mode boundary and a truthful fail-closed report.

#![forbid(unsafe_code)]

use crate::{ServiceError, ServiceRunV1, run_service_v1};
use serde_json::{Value, json};
use std::path::PathBuf;

pub const AUTONOMOUS_RESEARCH_USAGE: &str = r#"{
  "version": 4,
  "kind": "AutonomousResearchCampaignUsage",
  "usage": "hepta-paper operator autonomous-research -- [--launch-mode local-run|production-run|golden-bootstrap] [--action prepare|launch|status|resume|converge] --paper-id ID [--campaign-id ID] [--run-config PATH]",
  "defaultLaunchMode": "local-run",
  "safety": {
    "operatorApprovalClaimed": false,
    "selfSignedExternalTrustClaimed": false,
    "externalSubmissionEnabled": false,
    "universalResearchValidityClaimed": false,
    "naturalLanguageToLeanEquivalenceMachineProven": false,
    "automaticBudgetExpansionEnabled": false
  },
  "rustBoundary": "prepare/status remain diagnostic; local-run launch/resume may execute one supplied ServiceRunV1 through the durable Rust control plane; production/provider/external/submission authority remains unavailable"
}"#;

#[derive(Clone, Debug)]
pub struct AutonomousResearchOptions {
    pub action: String,
    pub launch_mode: String,
    pub paper_id: Option<String>,
    pub campaign_id: Option<String>,
    pub run_config: Option<PathBuf>,
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
    let mut run_config = None;
    let mut require_full_ready = false;
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
            "--run-config" => {
                run_config = Some(PathBuf::from(value(args, &mut index, "run_config")?))
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
            run_config,
            require_full_ready,
            help,
        });
    }
    if !matches!(
        action.as_str(),
        "prepare" | "launch" | "status" | "resume" | "converge"
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
    if run_config.is_some()
        && (!matches!(action.as_str(), "launch" | "resume") || launch_mode != "local-run")
    {
        return Err("autonomous_research_run_config_requires_local_launch_or_resume".to_owned());
    }
    Ok(AutonomousResearchOptions {
        action,
        launch_mode,
        paper_id,
        campaign_id,
        run_config,
        require_full_ready,
        help,
    })
}

pub fn autonomous_research_help_json_v1() -> Value {
    json!({
        "version": 4,
        "kind": "AutonomousResearchCampaignUsage",
        "usage": "hepta-paper operator autonomous-research -- [--launch-mode local-run|production-run|golden-bootstrap] [--action prepare|launch|status|resume|converge] --paper-id ID [--campaign-id ID] [--run-config PATH]",
        "defaultLaunchMode": "local-run",
        "safety": {
            "operatorApprovalClaimed": false,
            "selfSignedExternalTrustClaimed": false,
            "externalSubmissionEnabled": false,
            "universalResearchValidityClaimed": false,
            "naturalLanguageToLeanEquivalenceMachineProven": false,
            "automaticBudgetExpansionEnabled": false
        },
        "rustBoundary": "prepare/status remain diagnostic; local-run launch/resume may execute one supplied ServiceRunV1 through the durable Rust control plane; production/provider/external/submission authority remains unavailable"
    })
}

pub fn inspect_autonomous_research_v1(options: &AutonomousResearchOptions) -> Value {
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
        "serviceRunConfigProvided": options.run_config.is_some(),
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
    inspect_autonomous_research_v1(options)
}

pub fn execute_autonomous_research_service_v1(
    options: &AutonomousResearchOptions,
    config: ServiceRunV1,
) -> Result<Value, ServiceError> {
    if options.run_config.is_none()
        || options.launch_mode != "local-run"
        || !matches!(options.action.as_str(), "launch" | "resume")
    {
        return Err(ServiceError::Configuration);
    }
    let expected_campaign_id = options.campaign_id.clone().or_else(|| {
        options
            .paper_id
            .as_ref()
            .map(|id| format!("autonomous-research:{id}"))
    });
    if expected_campaign_id.as_deref() != Some(config.snapshot.campaign_id.as_str()) {
        return Err(ServiceError::Configuration);
    }
    let receipt = run_service_v1(config)?;
    let newly_committed = receipt
        .commit_receipts
        .iter()
        .filter(|row| row.newly_committed)
        .count();
    Ok(json!({
        "version": 1,
        "kind": "AutonomousResearchCampaignReport",
        "status": "autonomous_research_local_run_completed",
        "action": options.action,
        "launchMode": options.launch_mode,
        "paperId": options.paper_id,
        "campaignId": expected_campaign_id,
        "ready": false,
        "localRunCompleted": true,
        "campaignPersisted": true,
        "providerExecutionPerformed": false,
        "externalActionPerformed": false,
        "networkActionPerformed": false,
        "productionActivation": false,
        "durableCommitCount": receipt.commit_receipts.len(),
        "newlyCommittedCount": newly_committed,
        "controlPlaneReceipt": receipt,
        "blockers": [
            "rust_autonomous_research_provider_execution_not_ported",
            "rust_autonomous_research_external_qualification_not_ported"
        ],
        "requireFullReady": options.require_full_ready,
        "rustBoundary": "durable_local_service_run"
    }))
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
    fn run_config_is_restricted_to_local_launch_or_resume() {
        let options = parse_autonomous_research_arguments(&[
            "--paper-id".into(),
            "paper-1".into(),
            "--action".into(),
            "launch".into(),
            "--run-config".into(),
            "/tmp/run.json".into(),
        ])
        .unwrap();
        assert_eq!(options.run_config, Some(PathBuf::from("/tmp/run.json")));

        let rejected = parse_autonomous_research_arguments(&[
            "--paper-id".into(),
            "paper-1".into(),
            "--action".into(),
            "launch".into(),
            "--launch-mode".into(),
            "production-run".into(),
            "--run-config".into(),
            "/tmp/run.json".into(),
        ]);
        assert_eq!(
            rejected.unwrap_err(),
            "autonomous_research_run_config_requires_local_launch_or_resume"
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
