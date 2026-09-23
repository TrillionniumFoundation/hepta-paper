//! Explicit socket profile through the actual CLI, real ten-database state and
//! Rust authority. A supplied-key fixture is not installed-host acceptance.
#[path = "state_recoverability_socket/support.rs"]
#[allow(dead_code)]
mod support;
use hepta_paper_service::local_state_authority::LocalStateAuthorityRuntimeV1;
use rusqlite::{Connection, OpenFlags};
use serde_json::{Value, json};
use std::{
    fs,
    io::Read,
    os::unix::net::UnixListener,
    path::Path,
    process::{Command, Output},
    sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
    },
    thread,
    time::{Duration, Instant},
};
use support::*;

fn command(root: &Root, args: &[String]) -> Output {
    Command::new(env!("CARGO_BIN_EXE_hepta-state-backup"))
        .args(args)
        .current_dir(&root.0)
        .env_remove("HEPTA_PAPER_RUNTIME_ROOT")
        .output()
        .unwrap()
}
fn assert_error(output: Output, code: &str) {
    assert_eq!(output.status.code(), Some(1), "{output:?}");
    assert!(output.stdout.is_empty(), "{output:?}");
    assert_eq!(String::from_utf8(output.stderr).unwrap().trim(), code);
}
fn report(output: Output, expected_exit: i32) -> Value {
    assert_eq!(output.status.code(), Some(expected_exit), "{output:?}");
    assert!(output.stderr.is_empty(), "{output:?}");
    serde_json::from_slice(&output.stdout).unwrap()
}
fn args(fixture: &Value, path: &Path, pin: &str, action: &str) -> Vec<String> {
    vec![
        "--action".into(),
        action.into(),
        "--root".into(),
        fixture["workspace"].as_str().unwrap().into(),
        "--runtime-root".into(),
        fixture["runtime"].as_str().unwrap().into(),
        "--authority-socket-config".into(),
        path.display().to_string(),
        "--authority-socket-config-sha256".into(),
        pin.into(),
    ]
}

#[test]
fn explicit_socket_arguments_are_closed_and_keep_original_help() {
    let root = Root::new();
    let pin = digest("independent supplied pin");
    let cases: Vec<(Vec<&str>, &str)> = vec![
        (
            vec!["--action", "backup", "--authority-socket-config", "missing"],
            "autonomous_research_state_backup_socket_configuration_required",
        ),
        (
            vec![
                "--action",
                "backup",
                "--authority-socket-config-sha256",
                &pin,
            ],
            "autonomous_research_state_backup_socket_configuration_required",
        ),
        (
            vec![
                "--action",
                "backup",
                "--authority-socket-config",
                "missing",
                "--authority-socket-config-sha256",
                "wrong",
            ],
            "autonomous_research_state_backup_socket_configuration_hash_invalid",
        ),
        (
            vec![
                "--authority-socket-config",
                "missing",
                "--authority-socket-config-sha256",
                &pin,
            ],
            "autonomous_research_state_backup_socket_status_unsupported",
        ),
        (
            vec![
                "--action",
                "backup",
                "--authority-config",
                "process",
                "--authority-socket-config",
                "socket",
                "--authority-socket-config-sha256",
                &pin,
            ],
            "autonomous_research_state_backup_authority_profiles_conflict",
        ),
        (
            vec![
                "--action",
                "backup",
                "--online-authority-process-config",
                "process",
                "--authority-socket-config",
                "socket",
                "--authority-socket-config-sha256",
                &pin,
            ],
            "autonomous_research_state_backup_authority_profiles_conflict",
        ),
        (
            vec![
                "--help",
                "--authority-socket-config",
                "x",
                "--authority-socket-config",
                "y",
            ],
            "duplicate_cli_option:--authority-socket-config",
        ),
        (
            vec!["--help", "--unknown-socket-option", "x"],
            "unknown_cli_option:--unknown-socket-option",
        ),
    ];
    for (arguments, expected) in cases {
        assert_error(
            command(
                &root,
                &arguments.into_iter().map(str::to_owned).collect::<Vec<_>>(),
            ),
            expected,
        );
    }
    let legacy = command(&root, &["--help".into()]);
    let socket_help = command(
        &root,
        &[
            "--help".into(),
            "--authority-socket-config".into(),
            "missing".into(),
        ],
    );
    assert!(legacy.status.success());
    assert!(socket_help.status.success());
    assert_eq!(legacy.stdout, socket_help.stdout);
    assert_eq!(legacy.stderr, socket_help.stderr);
}

#[test]
fn actual_socket_cli_runs_all_write_modes_and_preserves_a_committed_lost_reply() {
    let root = Root::new();
    let fixture = prepare(&root);
    let mut daemon = Daemon::start(&root);
    oracle(&root, "install", None);
    let configuration = socket_configuration(&root, &fixture);
    let path = root.0.join("backup-socket.json");
    let pin = write_json(&path, &configuration);

    // New selection requires the independently supplied raw pin and cannot
    // reinterpret a Process profile. No authority probe reaches this listener.
    let refused_path = root.0.join("refused.sock");
    let refused = UnixListener::bind(&refused_path).unwrap();
    refused.set_nonblocking(true).unwrap();
    let mut candidate = configuration.clone();
    candidate["socketPath"] = json!(refused_path);
    let candidate_path = root.0.join("refused-socket.json");
    write_json(&candidate_path, &candidate);
    assert_error(
        command(
            &root,
            &args(&fixture, &candidate_path, &digest("wrong"), "backup"),
        ),
        "autonomous_research_state_backup_authority_socket_configuration_invalid",
    );
    let process_path = Path::new(fixture["backupConfiguration"].as_str().unwrap());
    assert_error(
        command(
            &root,
            &args(
                &fixture,
                process_path,
                &digest(fs::read(process_path).unwrap()),
                "backup",
            ),
        ),
        "autonomous_research_state_backup_authority_socket_configuration_invalid",
    );
    let reversed = vec![
        "--action".into(),
        "backup".into(),
        "--root".into(),
        fixture["workspace"].as_str().unwrap().into(),
        "--runtime-root".into(),
        fixture["runtime"].as_str().unwrap().into(),
        "--authority-config".into(),
        candidate_path.display().to_string(),
    ];
    assert_error(
        command(&root, &reversed),
        "autonomous_research_state_backup_authority_process_configuration_invalid",
    );
    assert_eq!(empty_connections(&refused), 0);

    let backup = report(command(&root, &args(&fixture, &path, &pin, "backup")), 0);
    assert_eq!(
        backup["status"],
        "autonomous_research_state_backup_recorded"
    );
    assert_eq!(backup["databaseCount"], 10);
    let bundle = Path::new(backup["bundlePath"].as_str().unwrap());
    let manifest = read_json(bundle.join("AUTONOMOUS_RESEARCH_STATE_BACKUP.json"));
    assert_eq!(
        manifest["content"]["databases"].as_array().unwrap().len(),
        10
    );
    let mut drill_args = args(&fixture, &path, &pin, "restore-drill");
    drill_args.extend(["--bundle".into(), bundle.display().to_string()]);
    let drill = report(command(&root, &drill_args), 0);
    assert_eq!(
        drill["status"],
        "autonomous_research_state_restore_drill_passed"
    );
    assert_eq!(drill["databaseCount"], 10);
    assert_eq!(drill["productionStateMutated"], false);
    assert_eq!(read_json(bundle.join("RESTORE_DRILL_RECEIPT.json")), drill);
    let renewal = report(command(&root, &args(&fixture, &path, &pin, "renew")), 0);
    assert_eq!(
        renewal["status"],
        "autonomous_research_state_backup_renewal_complete"
    );
    assert_eq!(
        read_json(Path::new(renewal["bundlePath"].as_str().unwrap()).join("RENEWAL_RECEIPT.json")),
        renewal
    );
    let reconciliation = report(
        command(&root, &args(&fixture, &path, &pin, "reconcile-and-renew")),
        0,
    );
    assert_eq!(
        reconciliation["status"],
        "autonomous_research_state_reconcile_and_renew_complete"
    );
    assert_eq!(reconciliation["reconciledDatabaseCount"], 10);
    assert_eq!(reconciliation["recoveredFinalizationCount"], 0);
    assert_eq!(reconciliation["businessDmlReplayed"], false);

    // Shut down only our test daemon and replace it with an instrumented real
    // authority runtime. This new CLI invocation captures this new origin.
    // The runtime commits the request and deliberately closes without a reply.
    daemon.stop();
    let listener = UnixListener::bind(root.0.join("authority.sock")).unwrap();
    listener.set_nonblocking(true).unwrap();
    let stop = Arc::new(AtomicBool::new(false));
    let finished = Arc::clone(&stop);
    let daemon_path = root.0.join("daemon.json");
    let worker = thread::spawn(move || {
        let mut authority = LocalStateAuthorityRuntimeV1::open(&daemon_path).unwrap();
        let mut requests = Vec::new();
        let mut probes = 0;
        let deadline = Instant::now() + Duration::from_secs(180);
        while !finished.load(Ordering::Acquire) {
            assert!(Instant::now() < deadline, "lost-reply fixture deadline");
            match listener.accept() {
                Ok((mut stream, _)) => {
                    stream
                        .set_read_timeout(Some(Duration::from_secs(5)))
                        .unwrap();
                    let mut bytes = Vec::new();
                    (&mut stream)
                        .take(16 * 1024 * 1024 + 1)
                        .read_to_end(&mut bytes)
                        .unwrap();
                    assert!(bytes.len() <= 16 * 1024 * 1024);
                    if bytes.is_empty() {
                        probes += 1;
                        continue;
                    }
                    let request: Value = serde_json::from_slice(&bytes).unwrap();
                    let receipt = authority.handle(&request).unwrap();
                    assert_eq!(
                        receipt["kind"],
                        "AutonomousResearchStateBackupAuthorityReservation"
                    );
                    requests.push(request);
                }
                Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                    thread::sleep(Duration::from_millis(2))
                }
                Err(error) => panic!("lost-reply accept: {error}"),
            }
        }
        (probes, requests)
    });
    let output = command(&root, &args(&fixture, &path, &pin, "renew"));
    stop.store(true, Ordering::Release);
    let (probes, requests) = worker.join().unwrap();
    assert_eq!(probes, 1);
    assert_eq!(
        requests.len(),
        1,
        "the CLI must not retry an unknown result"
    );
    let unknown = report(output, 2);
    assert_eq!(
        unknown["status"],
        "autonomous_research_state_backup_renewal_blocked"
    );
    let cause = &unknown["backupReceipt"]["authorityError"];
    assert!(cause["code"].as_str().is_some());
    assert_eq!(cause["retryable"], false);
    let details = &cause["details"];
    assert_eq!(details["transport"], "local-state-authority-socket-v1");
    assert!(details["requestBytesSent"].as_u64().unwrap() > 0);
    assert_eq!(details["requestDelivery"], "sent");
    assert_eq!(details["authorityOutcome"], "unknown");
    assert_eq!(details["inspectionRequired"], true);
    assert!(details.get("committed").is_none());
    // The worker has closed every authority SQLite handle before this read.
    let journal = Connection::open_with_flags(
        root.0.join("authority.sqlite"),
        OpenFlags::SQLITE_OPEN_READ_ONLY,
    )
    .unwrap();
    let finalized: i64 = journal.query_row("SELECT count(*) FROM authority_backup_reservation WHERE finalization_receipt_json IS NOT NULL", [], |row| row.get(0)).unwrap();
    assert_eq!(finalized, 3);
    let request: String = journal.query_row("SELECT reserve_request_json FROM authority_backup_reservation WHERE finalization_receipt_json IS NULL", [], |row| row.get(0)).unwrap();
    assert_eq!(
        serde_json::from_str::<Value>(&request).unwrap(),
        requests[0]
    );
    journal.close().unwrap();
}
