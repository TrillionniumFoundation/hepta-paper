use hepta_legacy_compatibility::production_hash_record_v1;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{
    fs,
    os::unix::fs::symlink,
    path::PathBuf,
    process::{Command, Output},
};

const ROUTE: &str = "autonomous-research-one-shot-campaign-attempt";
fn run(args: &[&str]) -> Output {
    Command::new(env!("CARGO_BIN_EXE_hepta-paper-rust"))
        .arg(ROUTE)
        .args(args)
        .output()
        .unwrap()
}
fn report(output: &Output) -> Value {
    assert_eq!(
        output.status.code(),
        Some(2),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    serde_json::from_slice(&output.stdout).unwrap()
}
fn temp_root() -> PathBuf {
    let root = std::env::temp_dir().join(format!(
        "hepta-one-shot-rust-{}-{}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ));
    fs::create_dir_all(&root).unwrap();
    root
}

#[test]
fn strict_actions_fixed_campaign_and_status_fail_closed_without_dataset_reads() {
    let help = run(&["--help"]);
    assert_eq!(help.status.code(), Some(0));
    let usage: Value = serde_json::from_slice(&help.stdout).unwrap();
    assert_eq!(
        usage["fixedCampaignId"],
        "autonomous-research:local-auto-20260730-57"
    );
    for args in [
        vec!["--action", "status"],
        vec!["--action", "launch", "--attempt-id", "a"],
        vec![
            "--action",
            "status",
            "--attempt-id",
            "a",
            "--action",
            "status",
        ],
        vec![
            "--action",
            "status",
            "--attempt-id",
            "a",
            "--campaign-id",
            "override",
        ],
        vec!["--action", "status", "--attempt-id", "../unsafe"],
        vec!["--action", "plan"],
    ] {
        assert_eq!(run(&args).status.code(), Some(1));
    }
    let observed = report(&run(&[
        "--action",
        "status",
        "--attempt-id",
        "attempt-1",
        "--dataset-mount-file",
        "/does/not/exist",
    ]));
    assert_eq!(observed["dataset"]["inspected"], false);
    assert_eq!(observed["executionAuthorized"], false);
    assert_eq!(
        observed["campaignId"],
        "autonomous-research:local-auto-20260730-57"
    );
    assert!(
        observed["blockers"]
            .as_array()
            .unwrap()
            .iter()
            .any(|value| value == "rust_autonomous_research_one_shot_status_inspection_not_ported")
    );
}

#[test]
fn preflight_hashes_only_stable_single_link_input_and_execute_has_no_effects() {
    let root = temp_root();
    let runtime = root.join("runtime");
    let control = root.join("control");
    fs::create_dir(&runtime).unwrap();
    fs::create_dir(&control).unwrap();
    let mount = root.join("mounts.json");
    let mounts = json!([{"name":"dataset", "manifestHash": format!("sha256:{}", "a".repeat(64)), "readOnly":true, "opaqueCredential":"private-value-must-not-be-output"}]);
    let bytes = serde_json::to_vec(&mounts).unwrap();
    fs::write(&mount, &bytes).unwrap();
    let arguments = |action| {
        vec![
            "--action",
            action,
            "--root",
            root.to_str().unwrap(),
            "--runtime-root",
            runtime.to_str().unwrap(),
            "--control-root",
            control.to_str().unwrap(),
            "--dataset-mount-file",
            mount.to_str().unwrap(),
        ]
    };
    for action in ["plan", "preflight", "execute"] {
        let output = run(&arguments(action));
        let observed = report(&output);
        assert_eq!(observed["dataset"]["inspected"], true);
        assert_eq!(
            observed["dataset"]["mount"]["observedSha256"],
            format!("sha256:{:x}", Sha256::digest(&bytes))
        );
        assert_eq!(
            observed["dataset"]["mountsHash"],
            production_hash_record_v1("AutonomousResearchOneShotCampaignDatasetMounts", &mounts)
                .unwrap()
                .as_str()
        );
        assert_eq!(observed["executionAuthorized"], false);
        assert!(
            observed["sideEffects"]
                .as_object()
                .unwrap()
                .values()
                .all(|value| value == false)
        );
        assert!(
            !String::from_utf8_lossy(&output.stdout).contains("private-value-must-not-be-output")
        );
    }
    assert_eq!(fs::read(&mount).unwrap(), bytes);
    assert_eq!(fs::read_dir(&runtime).unwrap().count(), 0);
    assert_eq!(fs::read_dir(&control).unwrap().count(), 0);
    fs::rename(&mount, root.join("real.json")).unwrap();
    symlink(root.join("real.json"), &mount).unwrap();
    let blocked = report(&run(&arguments("preflight")));
    assert_eq!(blocked["dataset"]["inspected"], false);
    assert!(
        blocked["blockers"].as_array().unwrap().iter().any(
            |value| value == "autonomous_research_one_shot_dataset_mount_file_identity_invalid"
        )
    );
    fs::remove_file(&mount).unwrap();
    fs::hard_link(root.join("real.json"), &mount).unwrap();
    assert_eq!(
        report(&run(&arguments("preflight")))["dataset"]["inspected"],
        false
    );
    fs::remove_dir_all(root).unwrap();
}
