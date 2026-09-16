use hepta_paper_service::nested_runtime_cli::{
    NESTED_RUNTIME_ARGUMENTS_V1, NestedRuntimeCliOutputV1, current_nested_runtime_clock_v1,
    nested_runtime_qualification_cli_v1, nested_runtime_utc_millis_v1,
};
use serde_json::{Value, json};
use std::{
    collections::BTreeMap,
    fs,
    io::Write,
    path::PathBuf,
    process::{Command, Output, Stdio},
};
fn node(script: &str, input: Value) -> Output {
    let repo = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../..");
    let mut child = Command::new("node")
        .arg(repo.join("rust/oracle").join(script))
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    child
        .stdin
        .take()
        .unwrap()
        .write_all(input.to_string().as_bytes())
        .unwrap();
    child.wait_with_output().unwrap()
}
struct Fixture(Value);
impl Fixture {
    fn new() -> Self {
        let output = node(
            "nested-runtime-qualification-v1.mjs",
            json!({"operation":"fixture","scenario":"valid","now":current_nested_runtime_clock_v1().unwrap()}),
        );
        assert!(
            output.status.success(),
            "{}",
            String::from_utf8_lossy(&output.stderr)
        );
        Self(serde_json::from_slice(&output.stdout).unwrap())
    }
    fn environment(&self) -> BTreeMap<String, String> {
        NESTED_RUNTIME_ARGUMENTS_V1
            .iter()
            .map(|(_, env, field)| {
                (
                    (*env).into(),
                    self.0["request"][*field]
                        .as_str()
                        .map(str::to_owned)
                        .unwrap_or_else(|| self.0["request"][*field].to_string()),
                )
            })
            .collect()
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(self.0["root"].as_str().unwrap());
    }
}
fn compare(args: Vec<String>, environment: &BTreeMap<String, String>, now: &str) -> Value {
    let output = node(
        "nested-runtime-cli-v1.mjs",
        json!({"argv":args,"environment":environment,"now":now}),
    );
    let native = nested_runtime_qualification_cli_v1(&args, environment, now);
    match native {
        Ok(NestedRuntimeCliOutputV1::Report(report)) => {
            assert_eq!(
                output.status.code(),
                Some(if report["ready"] == true { 0 } else { 1 })
            );
            assert_eq!(
                serde_json::from_slice::<Value>(&output.stdout).unwrap(),
                report
            );
            report
        }
        Ok(NestedRuntimeCliOutputV1::Help(help)) => {
            assert!(output.status.success());
            assert_eq!(
                String::from_utf8(output.stdout).unwrap(),
                format!("{help}\n")
            );
            Value::Null
        }
        Err(error) => {
            assert_eq!(output.status.code(), Some(1));
            assert!(output.stdout.is_empty());
            assert!(
                String::from_utf8_lossy(&output.stderr).contains(&format!("Error: {error}\n")),
                "{error}: {}",
                String::from_utf8_lossy(&output.stderr)
            );
            Value::Null
        }
    }
}
#[test]
fn every_flag_and_environment_default_runs_the_actual_node_command() {
    let fixture = Fixture::new();
    let env = fixture.environment();
    let now = fixture.0["request"]["now"].as_str().unwrap();
    assert_eq!(compare(vec![], &env, now)["ready"], true);
    let mut flags = Vec::new();
    for (index, (flag, variable, _)) in NESTED_RUNTIME_ARGUMENTS_V1.iter().enumerate() {
        if index % 2 == 0 {
            flags.push(format!("--{flag}={}", env[*variable]));
        } else {
            flags.extend([format!("--{flag}"), env[*variable].clone()]);
        }
    }
    assert_eq!(compare(flags, &BTreeMap::new(), now)["ready"], true);
    for (flag, _, _) in NESTED_RUNTIME_ARGUMENTS_V1 {
        let invalid = if *flag == "config" {
            PathBuf::from(fixture.0["root"].as_str().unwrap())
                .join("trust-store.json")
                .to_string_lossy()
                .into_owned()
        } else {
            "invalid-current-binding".into()
        };
        let report = compare(vec![format!("--{flag}"), invalid], &env, now);
        assert_eq!(
            report["ready"], false,
            "{flag} must override the valid environment value"
        );
    }
    compare(vec![], &BTreeMap::new(), now);
    compare(vec!["--help".into()], &env, now);
}
#[test]
fn malformed_cli_arguments_match_incumbent_error_precedence() {
    for args in [
        vec!["--"],
        vec!["--=x"],
        vec!["value"],
        vec!["--help=true"],
        vec!["--help", "--help"],
        vec!["--config"],
        vec!["--config="],
        vec!["--config", "--help"],
        vec!["--unknown"],
        vec!["--config=a", "--config=b"],
        vec!["--help", "--unknown"],
    ] {
        compare(
            args.into_iter().map(str::to_owned).collect(),
            &BTreeMap::new(),
            "2026-07-24T08:00:00.000Z",
        );
    }
}
#[test]
fn live_rust_binary_preserves_native_flags_and_exit_status() {
    let fixture = Fixture::new();
    let environment = fixture.environment();
    for valid in [true, false] {
        let mut command = Command::new(env!("CARGO_BIN_EXE_hepta-nested-runtime-qualification"));
        for (name, _) in
            std::env::vars().filter(|(name, _)| name.starts_with("HEPTA_NESTED_RUNTIME_"))
        {
            command.env_remove(name);
        }
        command.envs(&environment);
        if !valid {
            command.args(["--pod-uid", "mismatched-pod"]);
        }
        let output = command.output().unwrap();
        assert!(
            output.stderr.is_empty(),
            "{}",
            String::from_utf8_lossy(&output.stderr)
        );
        assert_eq!(output.status.code(), Some(if valid { 0 } else { 1 }));
        let report: Value = serde_json::from_slice(&output.stdout).unwrap();
        let args = if valid {
            vec![]
        } else {
            vec!["--pod-uid".into(), "mismatched-pod".into()]
        };
        assert_eq!(
            compare(args, &environment, report["verifiedAt"].as_str().unwrap()),
            report
        );
    }
}
#[test]
fn utc_clock_format_covers_leap_days_centuries_and_fractional_seconds() {
    for (ms, expected) in [
        (0, "1970-01-01T00:00:00.000Z"),
        (951782400123, "2000-02-29T00:00:00.123Z"),
        (1709164800000, "2024-02-29T00:00:00.000Z"),
        (4107542400000, "2100-03-01T00:00:00.000Z"),
        (253402300799999, "9999-12-31T23:59:59.999Z"),
    ] {
        assert_eq!(nested_runtime_utc_millis_v1(ms).unwrap(), expected);
    }
    assert!(nested_runtime_utc_millis_v1(253402300800000).is_err());
}
