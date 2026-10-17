use serde_json::Value;
use std::{fs, path::PathBuf, process::Command};

fn fixture_root(label: &str) -> PathBuf {
    let root = std::env::temp_dir().join(format!(
        "hepta-intake-rotation-{label}-{}",
        std::process::id()
    ));
    let _ = fs::remove_dir_all(&root);
    fs::create_dir_all(&root).unwrap();
    root
}

fn write_targets(root: &std::path::Path) -> (PathBuf, PathBuf) {
    let config = root.join("config.v2.json");
    let profile = root.join("topic-profile.v2.json");
    let profile_hash = "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    fs::write(
        &config,
        format!(
            "{{\"version\":2,\"kind\":\"AutonomousResearchMachineIntakeConfiguration\",\"machineAppendEnabled\":true,\"machineProducerProfileHash\":\"{profile_hash}\",\"configurationHash\":\"sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb\"}}"
        ),
    )
    .unwrap();
    fs::write(
        &profile,
        format!(
            "{{\"version\":2,\"kind\":\"AutonomousResearchTopicProducerProfile\",\"producerProfileHash\":\"{profile_hash}\",\"providerConfigurationHash\":\"sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc\",\"implementationSha256\":\"sha256:dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd\"}}"
        ),
    )
    .unwrap();
    (config, profile)
}

#[test]
fn plan_is_bounded_and_reports_target_hashes_without_authority() {
    let root = fixture_root("plan");
    let (config, profile) = write_targets(&root);
    let output = Command::new(env!("CARGO_BIN_EXE_hepta-paper-rust"))
        .args([
            "autonomous-intake-authority-rotation",
            "--action",
            "plan",
            "--runtime-root",
            root.to_str().unwrap(),
            "--next-machine-intake-config",
            config.to_str().unwrap(),
            "--topic-producer-profile",
            profile.to_str().unwrap(),
        ])
        .output()
        .unwrap();
    assert_eq!(output.status.code(), Some(2));
    let report: Value = serde_json::from_slice(&output.stdout).unwrap();
    assert_eq!(report["ready"], false);
    assert_eq!(report["externalActionPerformed"], false);
    assert_eq!(report["networkUse"], false);
    assert!(
        report["plan"]["planHash"]
            .as_str()
            .unwrap()
            .starts_with("sha256:")
    );
    assert_eq!(report["plan"]["payload"]["targetV2"], true);
    assert_eq!(report["plan"]["payload"]["topicProfileHashMatches"], true);
    let _ = fs::remove_dir_all(root);
}

#[test]
fn apply_requires_double_confirmation_and_stays_fail_closed() {
    let root = fixture_root("apply");
    let (config, profile) = write_targets(&root);
    let intent = root.join("rotation-intent.json");
    fs::write(
        &intent,
        br#"{"version":1,"kind":"RotationIntent","signature":"opaque"}"#,
    )
    .unwrap();
    let plan_output = Command::new(env!("CARGO_BIN_EXE_hepta-paper-rust"))
        .args([
            "autonomous-intake-authority-rotation",
            "--action",
            "plan",
            "--runtime-root",
            root.to_str().unwrap(),
            "--next-machine-intake-config",
            config.to_str().unwrap(),
            "--topic-producer-profile",
            profile.to_str().unwrap(),
        ])
        .output()
        .unwrap();
    let plan: Value = serde_json::from_slice(&plan_output.stdout).unwrap();
    let plan_hash = plan["plan"]["planHash"].as_str().unwrap();
    let output = Command::new(env!("CARGO_BIN_EXE_hepta-paper-rust"))
        .args([
            "autonomous-intake-authority-rotation",
            "--action",
            "apply",
            "--execute",
            "--runtime-root",
            root.to_str().unwrap(),
            "--next-machine-intake-config",
            config.to_str().unwrap(),
            "--topic-producer-profile",
            profile.to_str().unwrap(),
            "--rotation-intent",
            intent.to_str().unwrap(),
            "--expected-authority-generation",
            "1",
            "--plan-hash",
            plan_hash,
        ])
        .output()
        .unwrap();
    assert_eq!(output.status.code(), Some(2));
    let report: Value = serde_json::from_slice(&output.stdout).unwrap();
    assert_eq!(report["ready"], false);
    assert_eq!(report["externalActionPerformed"], false);
    assert_eq!(
        report["rotationIntent"]["signatureVerificationPerformed"],
        false
    );
    assert!(report["blockers"].as_array().unwrap().iter().any(
        |v| v == "autonomous_intake_authority_rotation_native_mutation_adapter_not_implemented"
    ));
    assert_eq!(
        fs::read_to_string(&intent).unwrap(),
        r#"{"version":1,"kind":"RotationIntent","signature":"opaque"}"#
    );
    let _ = fs::remove_dir_all(root);
}
