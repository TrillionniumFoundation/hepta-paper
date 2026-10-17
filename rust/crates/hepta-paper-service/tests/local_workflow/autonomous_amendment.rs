//! Persisted-reference and amendment regressions through the actual product CLI.
use super::autonomous_entrypoint::{invoke, request, success};
use super::*;
use serde_json::{Value, json};
use std::time::{SystemTime, UNIX_EPOCH};

fn now() -> u64 {
    u64::try_from(
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_millis(),
    )
    .unwrap()
}

fn persisted(temp: &Temp, hash: &str, action: &str, extra: &[&str]) -> std::process::Output {
    Command::new(env!("CARGO_BIN_EXE_hepta-paper-rust"))
        .args([
            "autonomous-research",
            "--campaign-id",
            "campaign-service",
            "--workflow-root",
        ])
        .arg(temp.state())
        .args(["--definition-hash", hash, "--action", action])
        .args(extra)
        .output()
        .unwrap()
}

fn amendment_file(temp: &Temp, revision: u64) -> PathBuf {
    let mut change = amendment(revision);
    change.lease_expires_at_unix_ms = now() + 900_000;
    let path = temp.0.join("autonomous-amendment.json");
    fs::write(&path, serde_json::to_vec(&change).unwrap()).unwrap();
    fs::set_permissions(&path, fs::Permissions::from_mode(0o600)).unwrap();
    path
}

#[test]
fn autonomous_persisted_reference_renews_replays_and_completes_without_definition_copy() {
    let temp = Temp::new();
    let path = request(&temp, definition(&temp));
    let first = success(invoke(&path, "launch", &["--through-steps", "2"]));
    let previous = first["definitionHash"].as_str().unwrap();
    let input = amendment_file(
        &temp,
        first["workflow"]["campaignRevision"].as_u64().unwrap(),
    );
    let original = fs::read(temp.state().join("workflow.json")).unwrap();
    fs::remove_file(&path).unwrap();
    let count = attempt_count(&temp);
    let arguments = ["--amendment-file", input.to_str().unwrap()];
    let amended = success(persisted(&temp, previous, "amend", &arguments));
    let digest = amended["definitionHash"].as_str().unwrap();
    assert_ne!(digest, previous);
    assert_eq!(
        attempt_count(&temp),
        count,
        "amendment cannot dispatch a worker"
    );
    assert_eq!(
        amended,
        success(persisted(&temp, previous, "amend", &arguments))
    );
    assert!(!persisted(&temp, previous, "converge", &[]).status.success());
    let current = success(persisted(&temp, digest, "status", &[]));
    assert_eq!(current["workflow"]["amendmentCount"], 1);
    assert_eq!(current["workflow"]["budgetRemainingMicrousd"], 148);
    let done = success(persisted(&temp, digest, "converge", &[]));
    assert_eq!(done["workflow"]["committedSteps"], 7);
    assert_eq!(done["workflow"]["budgetRemainingMicrousd"], 143);
    assert_eq!(done["workflow"]["campaignState"], "completed");
    assert_eq!(
        original,
        fs::read(temp.state().join("workflow.json")).unwrap()
    );
    let count = attempt_count(&temp);
    // Lost-response replay remains exact even after the campaign is terminal.
    assert_eq!(
        amended,
        success(persisted(&temp, previous, "amend", &arguments))
    );
    assert_eq!(
        done["workflow"],
        success(persisted(&temp, digest, "converge", &[]))["workflow"]
    );
    assert_eq!(attempt_count(&temp), count);
}

#[test]
fn autonomous_persisted_reference_uses_renewed_owner_lease_not_expired_original() {
    let (temp, original) = fixture();
    let mut change = amendment(0);
    change.lease_expires_at_unix_ms = now() + 600_000;
    // Deterministic local setup renews the old lease while it is still valid.
    // The product CLI then samples real time, well after the original expiry.
    let receipt = amend_local_workflow_v1(&temp.state(), &original, change, 1_100).unwrap();
    let frozen: LocalWorkflowV1 =
        serde_json::from_slice(&fs::read(temp.state().join("workflow.json")).unwrap()).unwrap();
    assert!(frozen.template.writer_lease.expires_at_unix_ms < now());
    let report = success(persisted(
        &temp,
        receipt.definition_hash.as_str(),
        "converge",
        &[],
    ));
    assert_eq!(report["workflow"]["committedSteps"], 7);
    assert_eq!(report["workflow"]["budgetRemainingMicrousd"], 143);
}

#[test]
fn autonomous_amendment_rejects_substitution_wrong_revision_and_terminal_writes() {
    let temp = Temp::new();
    let path = request(&temp, definition(&temp));
    let first = success(invoke(&path, "launch", &["--through-steps", "1"]));
    let digest = first["definitionHash"].as_str().unwrap();
    let count = attempt_count(&temp);
    let bad = amendment_file(&temp, 9999);
    assert!(
        !persisted(
            &temp,
            digest,
            "amend",
            &["--amendment-file", bad.to_str().unwrap()]
        )
        .status
        .success()
    );
    assert_eq!(
        success(persisted(&temp, digest, "status", &[]))["workflow"],
        first["workflow"]
    );
    let input = amendment_file(
        &temp,
        first["workflow"]["campaignRevision"].as_u64().unwrap(),
    );
    let extra = ["--amendment-file", input.to_str().unwrap()];
    let applied = success(persisted(&temp, digest, "amend", &extra));
    let next = applied["definitionHash"].as_str().unwrap();
    let mut substituted: Value = serde_json::from_slice(&fs::read(&input).unwrap()).unwrap();
    substituted["additionalBudgetMicrousd"] = json!(51);
    fs::write(&input, serde_json::to_vec(&substituted).unwrap()).unwrap();
    assert!(!persisted(&temp, digest, "amend", &extra).status.success());
    let state = success(persisted(&temp, next, "status", &[]));
    assert_eq!(state["workflow"]["amendmentCount"], 1);
    let revision = state["workflow"]["campaignRevision"]
        .as_u64()
        .unwrap()
        .to_string();
    let paused = success(persisted(
        &temp,
        next,
        "pause",
        &["--expected-revision", &revision],
    ));
    assert_eq!(paused["workflow"]["campaignState"], "paused");
    assert!(!persisted(&temp, next, "converge", &[]).status.success());
    let paused_revision = paused["workflow"]["campaignRevision"]
        .as_u64()
        .unwrap()
        .to_string();
    let resumed = success(persisted(
        &temp,
        next,
        "resume",
        &["--expected-revision", &paused_revision],
    ));
    assert_eq!(resumed["workflow"]["campaignState"], "running");
    let resumed_revision = resumed["workflow"]["campaignRevision"]
        .as_u64()
        .unwrap()
        .to_string();
    let cancelled = success(persisted(
        &temp,
        next,
        "cancel",
        &["--expected-revision", &resumed_revision],
    ));
    substituted["operationId"] = json!("new-after-cancel");
    substituted["expectedRevision"] = cancelled["workflow"]["campaignRevision"].clone();
    fs::write(&input, serde_json::to_vec(&substituted).unwrap()).unwrap();
    assert!(!persisted(&temp, next, "amend", &extra).status.success());
    assert_eq!(
        success(persisted(&temp, next, "status", &[]))["workflow"],
        cancelled["workflow"]
    );
    assert_eq!(attempt_count(&temp), count);
}

#[test]
fn autonomous_persisted_reference_is_identity_bound_and_inspection_cannot_amend() {
    let temp = Temp::new();
    let path = request(&temp, definition(&temp));
    let first = success(invoke(&path, "launch", &["--through-steps", "1"]));
    let digest = first["definitionHash"].as_str().unwrap();
    let input = amendment_file(
        &temp,
        first["workflow"]["campaignRevision"].as_u64().unwrap(),
    );
    let parse = hepta_paper_service::autonomous_research::parse_autonomous_research_arguments;
    let args = vec![
        "--campaign-id".into(),
        "campaign-service".into(),
        "--workflow-root".into(),
        temp.state().to_str().unwrap().into(),
        "--definition-hash".into(),
        digest.into(),
        "--action".into(),
        "amend".into(),
        "--amendment-file".into(),
        input.to_str().unwrap().into(),
    ];
    let options = parse(&args).unwrap();
    assert_eq!(
        hepta_paper_service::autonomous_research::inspect_autonomous_research_v1(&options)["ready"],
        false
    );
    let mut foreign = options.clone();
    foreign.campaign_id = Some("foreign-campaign".into());
    assert_eq!(
        hepta_paper_service::autonomous_research::execute_autonomous_research_v1(&foreign)["ready"],
        false
    );
    let mut forged = options.clone();
    forged.workflow_file = Some(path.clone());
    assert_eq!(
        hepta_paper_service::autonomous_research::execute_autonomous_research_v1(&forged)["ready"],
        false
    );
    for extra in [
        vec!["--workflow-file", path.to_str().unwrap()],
        vec!["--expected-revision", "1"],
        vec!["--through-steps", "1"],
        vec!["--require-full-ready"],
        vec!["--launch-mode", "production-run"],
    ] {
        let mut amended = vec!["--amendment-file", input.to_str().unwrap()];
        amended.extend(extra);
        assert!(!persisted(&temp, digest, "amend", &amended).status.success());
    }
    assert!(!persisted(&temp, digest, "prepare", &[]).status.success());
    assert_eq!(
        success(persisted(&temp, digest, "status", &[]))["workflow"],
        first["workflow"]
    );
}

#[test]
fn autonomous_amendment_private_request_bounds_and_aliases_do_not_mutate() {
    let temp = Temp::new();
    let path = request(&temp, definition(&temp));
    let first = success(invoke(&path, "launch", &["--through-steps", "1"]));
    let digest = first["definitionHash"].as_str().unwrap();
    let input = amendment_file(
        &temp,
        first["workflow"]["campaignRevision"].as_u64().unwrap(),
    );
    let alias = temp.0.join("amend-alias.json");
    std::os::unix::fs::symlink(&input, &alias).unwrap();
    assert!(
        !persisted(
            &temp,
            digest,
            "amend",
            &["--amendment-file", alias.to_str().unwrap()]
        )
        .status
        .success()
    );
    fs::set_permissions(&input, fs::Permissions::from_mode(0o644)).unwrap();
    assert!(
        !persisted(
            &temp,
            digest,
            "amend",
            &["--amendment-file", input.to_str().unwrap()]
        )
        .status
        .success()
    );
    fs::set_permissions(&input, fs::Permissions::from_mode(0o600)).unwrap();
    let mut unknown: Value = serde_json::from_slice(&fs::read(&input).unwrap()).unwrap();
    unknown["secret"] = json!("private-amendment-marker");
    fs::write(&input, serde_json::to_vec(&unknown).unwrap()).unwrap();
    let rejected = persisted(
        &temp,
        digest,
        "amend",
        &["--amendment-file", input.to_str().unwrap()],
    );
    assert!(!rejected.status.success());
    assert!(!String::from_utf8_lossy(&rejected.stdout).contains("private-amendment-marker"));
    assert!(!String::from_utf8_lossy(&rejected.stderr).contains("private-amendment-marker"));
    fs::write(&input, vec![b' '; 16 * 1024 * 1024 + 1]).unwrap();
    assert!(
        !persisted(
            &temp,
            digest,
            "amend",
            &["--amendment-file", input.to_str().unwrap()]
        )
        .status
        .success()
    );
    assert_eq!(
        success(persisted(&temp, digest, "status", &[]))["workflow"],
        first["workflow"]
    );
}
