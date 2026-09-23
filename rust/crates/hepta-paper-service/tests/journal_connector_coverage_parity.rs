//! Differential discovery coverage, registry identities, and real CLI behavior.
//! Qualification-registry verification remains explicitly outside this slice.

use hepta_paper_service::journal_connector_coverage::{
    build_journal_connector_coverage_v2, build_journal_submission_target_registry_v1,
    build_submission_connector_family_registry_v1, journal_connector_coverage_cli_v2,
    journal_profiles_v2,
};
use serde_json::{Value, json};
use std::{
    collections::BTreeMap,
    io::Write,
    process::{Command, Stdio},
};

fn oracle(requests: &[Value]) -> Value {
    let root = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../..");
    let mut child = Command::new("node")
        .arg(root.join("rust/oracle/journal-connector-coverage-v2.mjs"))
        .current_dir(root)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .expect("Node oracle");
    child
        .stdin
        .take()
        .expect("oracle stdin")
        .write_all(serde_json::to_string(requests).unwrap().as_bytes())
        .expect("oracle input");
    let output = child.wait_with_output().expect("Node output");
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    let result: Value = serde_json::from_slice(&output.stdout).expect("Node JSON");
    hepta_legacy_compatibility::qualify_production_node_profile_v1(&result["profile"])
        .expect("pinned Node runtime, locale and record-hash source");
    result
}

fn native_result(request: &Value) -> Value {
    if request["operation"] == "cli" {
        let argv: Vec<String> = request["argv"]
            .as_array()
            .unwrap()
            .iter()
            .map(|v| v.as_str().unwrap().to_owned())
            .collect();
        return match journal_connector_coverage_cli_v2(&argv, &BTreeMap::new()) {
            Ok(output) => json!({"ok": true, "value": output.value, "exitCode": output.exit_code}),
            Err(error) => json!({"ok": false, "error": error.to_string()}),
        };
    }
    let profiles = request
        .get("profiles")
        .cloned()
        .unwrap_or_else(|| journal_profiles_v2().unwrap());
    let result = match request["operation"].as_str().unwrap() {
        "profiles" => journal_profiles_v2(),
        "families" => build_submission_connector_family_registry_v1(),
        "targets" => build_journal_submission_target_registry_v1(&profiles),
        "coverage" => build_journal_connector_coverage_v2(&profiles),
        _ => panic!("unknown operation"),
    };
    match result {
        Ok(value) => json!({"ok": true, "value": value}),
        Err(error) => json!({"ok": false, "error": error.to_string()}),
    }
}

fn compare(requests: &[Value]) {
    let expected = oracle(requests);
    for (index, request) in requests.iter().enumerate() {
        assert_eq!(
            native_result(request),
            expected["results"][index],
            "case {index}: {request}"
        );
    }
}

#[test]
fn complete_profiles_families_targets_and_coverage_match_node() {
    compare(&[
        json!({"operation": "profiles"}),
        json!({"operation": "families"}),
        json!({"operation": "targets"}),
        json!({"operation": "coverage"}),
    ]);
}

#[test]
fn input_changes_recompute_hashes_and_preserve_validation_precedence() {
    let profiles = journal_profiles_v2().unwrap();
    let mut reordered = profiles.as_array().unwrap().clone();
    reordered.reverse();
    let mut relabeled = profiles.clone();
    relabeled[0]["label"] = json!("Changed α venue label");
    relabeled[0]["extraMetadata"] = json!({"A": 1, "a": 2, "é": "é", "list": [true, null]});
    let mut wrong_kind = profiles.clone();
    wrong_kind[0]["kind"] = json!("invalid");
    let mut missing_label = profiles.clone();
    missing_label[0].as_object_mut().unwrap().remove("label");
    let mut duplicate = profiles.clone();
    duplicate.as_array_mut().unwrap().push(profiles[0].clone());
    let mut orphan = profiles.clone();
    orphan.as_array_mut().unwrap().remove(0);
    let mut unknown = profiles.clone();
    unknown
        .as_array_mut()
        .unwrap()
        .push(json!({"id": "unknown", "kind": "journal", "label": "Unknown"}));
    let mut requests = vec![];
    for value in [
        Value::Null,
        json!({}),
        json!([]),
        json!([{}]),
        json!(reordered),
        relabeled,
        wrong_kind,
        missing_label,
        duplicate,
        orphan,
        unknown,
    ] {
        requests.push(json!({"operation": "targets", "profiles": value}));
        requests.push(json!({"operation": "coverage", "profiles": value}));
    }
    for identity in [json!(7), json!(true), json!({}), json!(["unknown"])] {
        let mut extended = profiles.clone();
        extended
            .as_array_mut()
            .unwrap()
            .push(json!({"id": identity, "kind": "journal", "label": "Unrouted"}));
        requests.push(json!({"operation": "coverage", "profiles": extended}));
    }
    compare(&requests);
}

#[test]
fn cli_every_venue_and_all_readiness_gates_match_node() {
    let mut requests = vec![
        json!({"operation": "cli", "argv": []}),
        json!({"operation": "cli", "argv": ["--help"]}),
    ];
    for profile in journal_profiles_v2().unwrap().as_array().unwrap() {
        requests.push(json!({"operation": "cli", "argv": ["--venue", profile["id"], "--kind", profile["kind"]]}));
    }
    for kind in [None, Some("journal"), Some("conference")] {
        for gate in [
            None,
            Some("--require-family-prototype"),
            Some("--require-profile-resolved"),
            Some("--require-adapter-implemented"),
            Some("--require-sandbox-qualified"),
            Some("--require-production-qualified"),
            Some("--require-live-ready"),
        ] {
            let mut argv = vec!["--summary"];
            if let Some(kind) = kind {
                argv.extend(["--kind", kind]);
            }
            if let Some(gate) = gate {
                argv.push(gate);
            }
            requests.push(json!({"operation": "cli", "argv": argv}));
        }
    }
    requests.push(
        json!({"operation": "cli", "argv": ["--venue=iclr", "--require-adapter-implemented"]}),
    );
    requests.push(json!({"operation": "cli", "argv": ["--venue=nature", "--require-family-prototype", "--require-live-ready"]}));
    compare(&requests);
}

#[test]
fn cli_rejects_unknown_duplicate_malformed_and_mismatched_arguments_like_node() {
    let cases: Vec<Vec<&str>> = vec![
        vec!["--"],
        vec!["--=x"],
        vec!["--bogus"],
        vec!["positional"],
        vec!["-h"],
        vec!["--summary=true"],
        vec!["--help=false"],
        vec!["--summary", "--summary"],
        vec!["--kind"],
        vec!["--kind", "--summary"],
        vec!["--kind="],
        vec!["--kind", "journal", "--kind", "conference"],
        vec!["--kind=invalid"],
        vec!["--venue=unknown"],
        vec!["--venue=colt_alt"],
        vec!["--venue=iclr", "--kind=journal"],
        vec!["--venue=nature", "--kind=conference"],
        vec!["--venue=unknown", "--kind=bad"],
        vec!["--venue"],
        vec!["--venue="],
        vec!["--help", "--kind=bad"],
        vec!["--help", "--bogus"],
        vec!["--help", "--qualification-registry=unused"],
        vec!["--qualification-registry-hash=unused", "--summary"],
        vec!["--qualification-trust-store=unused", "--summary"],
        vec!["--qualification-trust-store-hash=unused", "--summary"],
        vec!["--venue", "nature", "--venue"],
        vec!["--venue=nature", "--venue="],
    ];
    compare(
        &cases
            .into_iter()
            .map(|argv| json!({"operation": "cli", "argv": argv}))
            .collect::<Vec<_>>(),
    );
}

#[test]
fn invalid_signed_qualification_never_silently_falls_back_to_discovery() {
    let expected = "portal_target_qualification_registry_blocked:portal_target_qualification_registry_file_invalid:missing,portal_target_qualification_trust_store_pin_required";
    for args in [
        vec!["--qualification-registry=registry.json"],
        vec!["--summary", "--qualification-registry", "registry.json"],
    ] {
        let args = args.into_iter().map(str::to_owned).collect::<Vec<_>>();
        assert_eq!(
            journal_connector_coverage_cli_v2(&args, &BTreeMap::new())
                .unwrap_err()
                .to_string(),
            expected
        );
    }
    let environment = BTreeMap::from([(
        "HEPTA_PORTAL_TARGET_QUALIFICATION_REGISTRY".into(),
        "registry.json".into(),
    )]);
    assert_eq!(
        journal_connector_coverage_cli_v2(&[], &environment)
            .unwrap_err()
            .to_string(),
        expected
    );
    let help = journal_connector_coverage_cli_v2(&["--help".into()], &environment).unwrap();
    assert_eq!(help.exit_code, 0);
    assert_eq!(help.value["kind"], "JournalConnectorCoverageUsage");
}

#[test]
fn shipped_rust_cli_preserves_json_stdout_error_stderr_and_exit_status() {
    let cases = [
        vec!["--help"],
        vec!["--summary"],
        vec!["--venue=tmlr"],
        vec!["--summary", "--require-live-ready"],
        vec!["--venue=colt_alt"],
        vec!["--summary=true"],
        vec!["--venue=nature", "--kind=conference"],
    ];
    let requests = cases
        .iter()
        .map(|argv| json!({"operation": "cli", "argv": argv}))
        .collect::<Vec<_>>();
    let expected = oracle(&requests);
    for (index, argv) in cases.iter().enumerate() {
        let mut command = Command::new(env!("CARGO_BIN_EXE_hepta-journal-connector-coverage"));
        command.args(argv);
        for (key, _) in std::env::vars()
            .filter(|(key, _)| key.starts_with("HEPTA_PORTAL_TARGET_QUALIFICATION_"))
        {
            command.env_remove(key);
        }
        let output = command.output().expect("native CLI");
        let result = &expected["results"][index];
        if result["ok"] == true {
            assert_eq!(
                output.status.code(),
                Some(result["exitCode"].as_i64().unwrap() as i32)
            );
            assert!(output.stderr.is_empty());
            assert_eq!(
                serde_json::from_slice::<Value>(&output.stdout).unwrap(),
                result["value"]
            );
        } else {
            assert_eq!(output.status.code(), Some(1));
            assert!(output.stdout.is_empty());
            assert!(
                String::from_utf8_lossy(&output.stderr).contains(result["error"].as_str().unwrap())
            );
        }
    }
    let output = Command::new(env!("CARGO_BIN_EXE_hepta-journal-connector-coverage"))
        .arg("--summary")
        .env(
            "HEPTA_PORTAL_TARGET_QUALIFICATION_REGISTRY",
            "registry.json",
        )
        .output()
        .expect("native CLI with configured qualification");
    assert_eq!(output.status.code(), Some(1));
    assert!(output.stdout.is_empty());
    assert!(
        String::from_utf8_lossy(&output.stderr)
            .contains("portal_target_qualification_trust_store_pin_required")
    );
}
