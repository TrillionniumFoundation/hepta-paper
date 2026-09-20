//! Differential checks for the local command-surface package synchronization.

use serde_json::Value;
use std::{
    fs,
    io::Write,
    process::{Command, Stdio},
};

fn temp_fixture() -> std::path::PathBuf {
    let nonce = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .expect("system clock")
        .as_nanos();
    let path = std::env::temp_dir().join(format!(
        "hepta-command-surface-{}-{nonce}",
        std::process::id()
    ));
    let _ = fs::remove_dir_all(&path);
    fs::create_dir_all(&path).expect("fixture directory");
    fs::write(
        path.join("package.json"),
        r#"{"name":"fixture","version":1.0,"zero":-0.0,"large":1e21,"small":1e-7,"scripts":{"test":"old","store:status":"old","custom":"echo custom","gpu:personal-gate":0,"personal:readiness":false},"bin":{"dev":"./bin/dev.js"},"devDependencies":{"z":"1","a":"2"}}"#,
    )
    .expect("fixture package");
    path
}

fn oracle(requests: Value) -> Value {
    let root = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../..");
    let script = root.join("rust/oracle/command-surface-v1.mjs");
    let mut child = Command::new("node")
        .arg(script)
        .current_dir(&root)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .spawn()
        .expect("Node oracle");
    child
        .stdin
        .take()
        .expect("oracle stdin")
        .write_all(requests.to_string().as_bytes())
        .expect("request");
    let output = child.wait_with_output().expect("oracle output");
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    let value: Value = serde_json::from_slice(&output.stdout).expect("oracle JSON");
    assert_eq!(value["profile"]["node"], "v22.23.1");
    value
}

fn rust_output(root: &std::path::Path, flag: Option<&str>) -> std::process::Output {
    let binary = env!("CARGO_BIN_EXE_hepta-paper-rust");
    let mut command = Command::new(binary);
    command.arg("command-surface").arg(root);
    if let Some(flag) = flag {
        command.arg(flag);
    }
    command.output().expect("Rust command")
}

fn rust_result(root: &std::path::Path, flag: Option<&str>) -> Value {
    let output = rust_output(root, flag);
    serde_json::from_slice(&output.stdout).expect("Rust JSON")
}

fn rust_raw_result(root: &std::path::Path, flag: Option<&str>) -> String {
    let output = rust_output(root, flag);
    String::from_utf8(output.stdout)
        .expect("Rust UTF-8")
        .trim_end_matches('\n')
        .to_owned()
}

#[test]
fn package_surface_check_and_write_match_node_oracle() {
    let fixture = temp_fixture();
    let oracle_fixture = fixture.with_file_name(format!(
        "{}-oracle",
        fixture.file_name().unwrap().to_string_lossy()
    ));
    fs::create_dir_all(&oracle_fixture).expect("oracle fixture directory");
    fs::copy(
        fixture.join("package.json"),
        oracle_fixture.join("package.json"),
    )
    .expect("oracle fixture package");
    let requests = serde_json::json!([
        {"root": oracle_fixture, "mode": "check-package"},
        {"root": oracle_fixture, "writePackage": true},
    ]);
    let expected = oracle(requests);
    assert_eq!(
        rust_result(&fixture, Some("--check-package")),
        expected["results"][0]["value"]
    );
    assert_eq!(
        rust_raw_result(&fixture, Some("--check-package")),
        expected["results"][0]["raw"]
    );
    assert_eq!(
        rust_result(&fixture, Some("--write-package")),
        expected["results"][1]["value"]
    );
    assert_eq!(
        rust_raw_result(&fixture, Some("--write-package")),
        expected["results"][1]["raw"]
    );
    assert_eq!(
        fs::read(fixture.join("package.json")).expect("Rust package bytes"),
        fs::read(oracle_fixture.join("package.json")).expect("Node package bytes")
    );
    let _ = fs::remove_dir_all(fixture);
    let _ = fs::remove_dir_all(oracle_fixture);
}

#[test]
fn deterministic_command_surface_flags_match_node_oracle_and_exit_codes() {
    let fixture = temp_fixture();
    let oracle_fixture = fixture.with_file_name(format!(
        "{}-modes-oracle",
        fixture.file_name().unwrap().to_string_lossy()
    ));
    fs::create_dir_all(&oracle_fixture).expect("oracle fixture directory");
    fs::copy(
        fixture.join("package.json"),
        oracle_fixture.join("package.json"),
    )
    .expect("oracle fixture package");

    let requests = serde_json::json!([
        {"root": oracle_fixture, "mode": "check-package"},
        {"root": oracle_fixture, "mode": "npm-aliases"},
        {"root": oracle_fixture, "mode": "ci-matrix"},
    ]);
    let expected = oracle(requests);
    for (flag, index) in [
        ("--check-package", 0_usize),
        ("--npm-aliases", 1),
        ("--ci-matrix", 2),
    ] {
        let output = rust_output(&fixture, Some(flag));
        let expected_result = &expected["results"][index];
        assert_eq!(
            output.status.code(),
            expected_result["exitCode"]
                .as_i64()
                .map(|value| value as i32),
            "{flag}: {}",
            String::from_utf8_lossy(&output.stderr)
        );
        let actual_raw = String::from_utf8(output.stdout)
            .expect("Rust UTF-8")
            .trim_end_matches('\n')
            .to_owned();
        assert_eq!(
            actual_raw,
            expected_result["raw"].as_str().unwrap(),
            "{flag}"
        );
        assert_eq!(
            serde_json::from_str::<Value>(&actual_raw).expect("Rust JSON"),
            expected_result["value"],
            "{flag}"
        );
    }

    let help = rust_output(&fixture, Some("--help-artifact"));
    assert!(help.status.success());
    let _ = fs::remove_dir_all(fixture);
    let _ = fs::remove_dir_all(oracle_fixture);
}

#[test]
fn default_classify_and_help_artifact_match_node_oracle() {
    let fixture = temp_fixture();
    let package = fixture.join("package.json");
    let mut value: Value = serde_json::from_slice(&fs::read(&package).expect("fixture package"))
        .expect("fixture JSON");
    value["scripts"]["😀-unknown"] = Value::String("echo unknown".to_owned());
    value["scripts"]["zzz-unknown"] = Value::String("echo unknown".to_owned());
    fs::write(
        &package,
        serde_json::to_vec(&value).expect("fixture JSON bytes"),
    )
    .expect("fixture package write");
    let requests = serde_json::json!([
        {"root": fixture, "mode": "classify"},
        {"root": fixture, "mode": "help-artifact"},
    ]);
    let expected = oracle(requests);
    for (flag, index) in [(None, 0_usize), (Some("--help-artifact"), 1)] {
        let output = rust_output(&fixture, flag);
        assert!(
            output.status.success(),
            "{}",
            String::from_utf8_lossy(&output.stderr)
        );
        let actual_raw = String::from_utf8(output.stdout)
            .expect("Rust UTF-8")
            .trim_end_matches('\n')
            .to_owned();
        assert_eq!(actual_raw, expected["results"][index]["raw"]);
        assert_eq!(
            serde_json::from_str::<Value>(&actual_raw).expect("Rust JSON"),
            expected["results"][index]["value"]
        );
    }
    let _ = fs::remove_dir_all(fixture);
}

#[test]
fn malformed_script_containers_follow_node_object_key_coercion() {
    // The incumbent command-surface script uses JavaScript's `scripts || {}`
    // and Object.keys/Object.entries semantics.  Keep the native rewrite and
    // inspection behavior aligned even when a package has an accidentally
    // array- or string-valued scripts field instead of an object.
    let cases = [
        ("array", serde_json::json!(["first", "second"])),
        ("string", serde_json::json!("ab")),
        ("number", serde_json::json!(1)),
        ("false", serde_json::json!(false)),
        ("null", serde_json::Value::Null),
    ];
    for (label, scripts) in cases {
        let fixture = temp_fixture().with_file_name(format!(
            "hepta-command-surface-coercion-{label}-{}",
            std::process::id()
        ));
        let oracle_fixture = fixture.with_file_name(format!("{label}-oracle"));
        let package = serde_json::json!({
            "name": "fixture",
            "version": 1,
            "scripts": scripts,
            "custom": "preserved"
        });
        let package_bytes = serde_json::to_vec(&package).expect("fixture package");
        fs::create_dir_all(&fixture).expect("fixture directory");
        fs::create_dir_all(&oracle_fixture).expect("oracle fixture directory");
        fs::write(fixture.join("package.json"), &package_bytes).expect("fixture package");
        fs::write(oracle_fixture.join("package.json"), &package_bytes)
            .expect("oracle fixture package");

        let expected = oracle(serde_json::json!([
            {"root": oracle_fixture, "mode": "classify"},
            {"root": oracle_fixture, "mode": "check-package"},
            {"root": oracle_fixture, "mode": "write-package", "writePackage": true}
        ]));
        for (flag, index) in [(None, 0_usize), (Some("--check-package"), 1)] {
            let output = rust_output(&fixture, flag);
            let expected_result = &expected["results"][index];
            assert_eq!(
                output.status.code(),
                expected_result["exitCode"]
                    .as_i64()
                    .map(|value| value as i32),
                "{label} {flag:?}: {}",
                String::from_utf8_lossy(&output.stderr)
            );
            let actual_raw = String::from_utf8(output.stdout)
                .expect("Rust UTF-8")
                .trim_end_matches('\n')
                .to_owned();
            assert_eq!(actual_raw, expected_result["raw"], "{label} {flag:?}");
        }

        let output = rust_output(&fixture, Some("--write-package"));
        let expected_result = &expected["results"][2];
        assert_eq!(
            output.status.code(),
            expected_result["exitCode"]
                .as_i64()
                .map(|value| value as i32),
            "{label} write: {}",
            String::from_utf8_lossy(&output.stderr)
        );
        let actual_raw = String::from_utf8(output.stdout)
            .expect("Rust UTF-8")
            .trim_end_matches('\n')
            .to_owned();
        assert_eq!(actual_raw, expected_result["raw"], "{label} write");
        assert_eq!(
            fs::read(fixture.join("package.json")).expect("Rust package bytes"),
            fs::read(oracle_fixture.join("package.json")).expect("Node package bytes"),
            "{label} rewritten package"
        );

        let _ = fs::remove_dir_all(fixture);
        let _ = fs::remove_dir_all(oracle_fixture);
    }
}
