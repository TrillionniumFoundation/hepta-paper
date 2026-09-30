//! Bounded command surface for the Node autonomous-research campaign route.
//!
//! Explicit local workflows use the existing SQLite/CAS and dispatch owners.
//! Ordinary campaign requests assemble broker author/reviewer and bounded
//! revision through the same durable owner; research admission remains separate.

#![forbid(unsafe_code)]

use hepta_codex_protocol::Sha256Digest;
use serde_json::{Value, json};
use std::{
    collections::BTreeSet,
    path::PathBuf,
    sync::{Arc, atomic::AtomicBool},
};

mod campaign;
mod local;
pub use campaign::{AutonomousResearchCampaignRequestV1, AutonomousResearchRoleV1};

pub const AUTONOMOUS_RESEARCH_USAGE: &str = r#"{
  "version": 4,
  "kind": "AutonomousResearchCampaignUsage",
  "usage": "hepta-paper operator autonomous-research -- [--launch-mode local-run|production-run|golden-bootstrap] [--action prepare|launch|status|resume|converge] --paper-id ID",
  "defaultLaunchMode": "local-run",
  "campaignUsage": "--paper-id ID --runtime-root ABSOLUTE_PRIVATE_ROOT [--objective TEXT] [--revision-rounds N] --action prepare|launch|status|converge|pause|resume|cancel; fixed autonomous-research-request.v1.json supplies broker policy and bounded resources",
  "localWorkflowUsage": "--campaign-id ID --workflow-file ABSOLUTE_JSON --action prepare|launch|status|converge|pause|resume|cancel [--research-qualification-request ABSOLUTE_JSON] [--through-steps N] [--expected-revision N]",
  "persistedWorkflowUsage": "--campaign-id ID --workflow-root ABSOLUTE_STATE --definition-hash SHA256 --action launch|status|converge|pause|resume|cancel|amend [--research-qualification-request ABSOLUTE_JSON] [--amendment-file ABSOLUTE_JSON] [--through-steps N] [--expected-revision N]",
  "safety": {
    "operatorApprovalClaimed": false,
    "selfSignedExternalTrustClaimed": false,
    "externalSubmissionEnabled": false,
    "universalResearchValidityClaimed": false,
    "naturalLanguageToLeanEquivalenceMachineProven": false,
    "automaticBudgetExpansionEnabled": false
  },
  "rustBoundary": "ordinary campaign requests and explicit local workflows reuse the existing durable owner; a persisted research profile requires a matching authority-owned V3/V4 research request for every new dispatch; no production, release or submission authority"
}"#;

#[derive(Clone, Debug)]
pub struct AutonomousResearchOptions {
    pub action: String,
    pub launch_mode: String,
    pub paper_id: Option<String>,
    pub campaign_id: Option<String>,
    pub runtime_root: Option<PathBuf>,
    pub objective: Option<String>,
    pub revision_rounds: Option<usize>,
    pub workflow_file: Option<PathBuf>,
    pub workflow_root: Option<PathBuf>,
    pub definition_hash: Option<Sha256Digest>,
    pub amendment_file: Option<PathBuf>,
    pub research_qualification_request: Option<PathBuf>,
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
    let mut runtime_root = None;
    let mut objective = None;
    let mut revision_rounds = None;
    let mut workflow_file = None;
    let mut workflow_root = None;
    let mut definition_hash = None;
    let mut amendment_file = None;
    let mut research_qualification_request = None;
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
            "--runtime-root" => {
                runtime_root = Some(PathBuf::from(value(args, &mut index, "runtime_root")?))
            }
            "--objective" => objective = Some(value(args, &mut index, "objective")?),
            "--revision-rounds" => {
                revision_rounds = Some(
                    value(args, &mut index, "revision_rounds")?
                        .parse::<usize>()
                        .map_err(|_| "invalid_autonomous_research_revision_rounds".to_owned())?,
                )
            }
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
            "--research-qualification-request" => {
                research_qualification_request = Some(PathBuf::from(value(
                    args,
                    &mut index,
                    "research_qualification_request",
                )?))
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
            runtime_root,
            objective,
            revision_rounds,
            workflow_file,
            workflow_root,
            definition_hash,
            amendment_file,
            research_qualification_request,
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
    if (runtime_root.is_some() || objective.is_some() || revision_rounds.is_some())
        && (workflow_root.is_some()
            || workflow_file.is_some()
            || amendment_file.is_some()
            || definition_hash.is_some())
    {
        return Err("autonomous_research_campaign_and_workflow_modes_conflict".to_owned());
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
    if research_qualification_request.is_some()
        && (workflow_file.is_none() && workflow_root.is_none() && runtime_root.is_none()
            || !matches!(action.as_str(), "launch" | "converge"))
    {
        return Err("autonomous_research_qualification_request_scope_invalid".to_owned());
    }
    if workflow_file.is_none()
        && workflow_root.is_none()
        && runtime_root.is_none()
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
        runtime_root,
        objective,
        revision_rounds,
        workflow_file,
        workflow_root,
        definition_hash,
        amendment_file,
        research_qualification_request,
        through_steps,
        expected_revision,
        require_full_ready,
        help,
    })
}

pub fn autonomous_research_help_json_v1() -> Value {
    serde_json::from_str(AUTONOMOUS_RESEARCH_USAGE).unwrap_or_else(|_| {
        json!({"version":1,"kind":"AutonomousResearchCampaignUsage","error":"autonomous_research_usage_definition_invalid","ready":false})
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
    campaign::run(options, false, &Arc::new(AtomicBool::new(false)))
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
    campaign::run(options, true, &cancelled)
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
    fn qualification_request_is_scoped_to_advancing_explicit_workflows() {
        assert_eq!(
            parse_autonomous_research_arguments(&[
                "--campaign-id".into(),
                "campaign-1".into(),
                "--workflow-file".into(),
                "/tmp/workflow.json".into(),
                "--action".into(),
                "status".into(),
                "--research-qualification-request".into(),
                "/tmp/qualification.json".into(),
            ])
            .unwrap_err(),
            "autonomous_research_qualification_request_scope_invalid"
        );
        let parsed = parse_autonomous_research_arguments(&[
            "--campaign-id".into(),
            "campaign-1".into(),
            "--workflow-file".into(),
            "/tmp/workflow.json".into(),
            "--action".into(),
            "launch".into(),
            "--research-qualification-request".into(),
            "/tmp/qualification.json".into(),
        ])
        .unwrap();
        assert_eq!(
            parsed.research_qualification_request.as_deref(),
            Some(std::path::Path::new("/tmp/qualification.json"))
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
