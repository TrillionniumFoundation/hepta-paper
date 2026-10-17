use super::*;

fn argv(values: &[&str]) -> Vec<String> {
    values.iter().map(|value| (*value).into()).collect()
}
fn pin() -> String {
    format!("sha256:{}", "a".repeat(64))
}
fn socket(action: &str) -> Vec<String> {
    vec![
        "--action".into(),
        action.into(),
        "--authority-socket-config".into(),
        "/explicit/socket.json".into(),
        "--authority-socket-config-sha256".into(),
        pin(),
    ]
}
fn failure(values: &[String]) -> String {
    match parse(values) {
        Ok(_) => panic!("arguments unexpectedly accepted"),
        Err(code) => code,
    }
}

#[test]
fn socket_profile_uses_the_supplied_pin_and_satisfies_reconciliation_requirements() {
    for action in ["backup", "renew", "reconcile-and-renew", "restore-drill"] {
        let mut values = socket(action);
        if action == "restore-drill" {
            values.extend(argv(&["--bundle", "/actual/bundle"]));
        }
        let parsed = parse(&values).unwrap();
        let selected = parsed.socket_configuration.unwrap();
        assert_eq!(selected.path, "/explicit/socket.json");
        assert_eq!(selected.raw_file_hash, pin());
        assert!(parsed.backup_configuration.is_none());
        assert!(parsed.online_configuration.is_none());
    }
    let values = argv(&[
        "--action=backup",
        "--authority-socket-config=/explicit/socket.json",
        &format!("--authority-socket-config-sha256={}", pin()),
    ]);
    assert_eq!(
        parse(&values)
            .unwrap()
            .socket_configuration
            .unwrap()
            .raw_file_hash,
        pin()
    );
}

#[test]
fn socket_profile_requires_both_arguments_and_rejects_process_mixing() {
    for values in [
        argv(&[
            "--action",
            "backup",
            "--authority-socket-config",
            "/explicit/socket.json",
        ]),
        argv(&[
            "--action",
            "backup",
            "--authority-socket-config-sha256",
            &pin(),
        ]),
    ] {
        assert_eq!(
            failure(&values),
            "autonomous_research_state_backup_socket_configuration_required"
        );
    }
    for flag in ["--authority-config", "--online-authority-process-config"] {
        let mut values = socket("backup");
        values.extend(argv(&[flag, "/explicit/process.json"]));
        assert_eq!(
            failure(&values),
            "autonomous_research_state_backup_authority_profiles_conflict"
        );
    }
}

#[test]
fn status_rejects_socket_selection_and_malformed_hashes_fail_before_io() {
    assert_eq!(
        failure(&socket("status")),
        "autonomous_research_state_backup_socket_status_unsupported"
    );
    for invalid in ["self", "sha256:a", &"a".repeat(64)] {
        let mut values = socket("backup");
        *values.last_mut().unwrap() = invalid.into();
        assert_eq!(
            failure(&values),
            "autonomous_research_state_backup_socket_configuration_hash_invalid"
        );
    }
}

#[test]
fn socket_flags_keep_closed_lexical_validation_and_help_precedence() {
    for (values, expected) in [
        (
            argv(&["--help", "--authority-socket-config"]),
            "missing_cli_option_value:--authority-socket-config",
        ),
        (
            argv(&["--help", "--authority-socket-config-sha256="]),
            "empty_cli_option_value:--authority-socket-config-sha256",
        ),
        (
            argv(&[
                "--help",
                "--authority-socket-config=a",
                "--authority-socket-config=b",
            ]),
            "duplicate_cli_option:--authority-socket-config",
        ),
        (
            argv(&["--help", "--unknown-socket-option=value"]),
            "unknown_cli_option:--unknown-socket-option",
        ),
    ] {
        assert_eq!(failure(&values), expected);
    }
    // Syntactically valid help bypasses profile/action requirements, just as
    // incumbent help bypasses its Process reconciliation requirements.
    let parsed = parse(&argv(&[
        "--help",
        "--action=unknown",
        "--authority-socket-config=/not/opened",
        "--authority-config=/also/not/opened",
    ]))
    .unwrap();
    assert!(parsed.help);
    assert_eq!(parsed.action, StateBackupActionV1::Status);
    assert!(parsed.socket_configuration.is_none());
}

#[test]
fn process_default_and_reconciliation_requirements_remain_unchanged() {
    let parsed = parse(&[]).unwrap();
    assert_eq!(parsed.action, StateBackupActionV1::Status);
    assert!(parsed.socket_configuration.is_none());
    for values in [
        argv(&["--action=reconcile-and-renew"]),
        argv(&[
            "--action=reconcile-and-renew",
            "--authority-config=/process.json",
        ]),
    ] {
        assert_eq!(
            failure(&values),
            "autonomous_research_state_reconcile_and_renew_authority_configuration_required"
        );
    }
    let parsed = parse(&argv(&[
        "--action=reconcile-and-renew",
        "--authority-config=/backup-process.json",
        "--online-authority-process-config=/online-process.json",
    ]))
    .unwrap();
    assert_eq!(
        parsed.backup_configuration.as_deref(),
        Some("/backup-process.json")
    );
    assert_eq!(
        parsed.online_configuration.as_deref(),
        Some("/online-process.json")
    );
    assert!(parsed.socket_configuration.is_none());
}
