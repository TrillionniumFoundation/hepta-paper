//! Capacity fixtures are inert historical records, not scientific/billing proof.
//! The request under test enters through the real CLI, CAS and SQLite owners.
use super::*;
use hepta_module_platform::{PreparedResultStatusV1, PreparedResultV1, ResourceVectorV1};
use std::{
    io::ErrorKind,
    process::Stdio,
    time::{Duration, Instant},
};

fn inert_history(f: &Fixture, pairs: usize) {
    let objects = ObjectStoreV1::open(&f.config.state_directory).unwrap();
    let artifact = objects.put(b"inert historical capacity fixture").unwrap();
    for index in 0..pairs {
        let identity = hash(format!("inert-capacity-{index}").as_bytes());
        // Bulk inert fixtures need valid bytes and private ownership, not a
        // provider's durable-commit protocol. The actual request below still
        // uses ObjectStore/SQLite fsync, and the guard rehashes every object.
        let evidence_bytes = serde_json::to_vec(&serde_json::json!({
            "version": 1, "requestHash": identity, "fixture": "inert_capacity_history"
        }))
        .unwrap();
        let evidence = hash(&evidence_bytes);
        let evidence_path = objects
            .root()
            .join(evidence.as_str().trim_start_matches("sha256:"));
        fs::write(&evidence_path, evidence_bytes).unwrap();
        fs::set_permissions(evidence_path, fs::Permissions::from_mode(0o600)).unwrap();
        let result = PreparedResultV1 {
            version: 1,
            attempt_id: format!("inert-{index}"),
            snapshot_hash: artifact.clone(),
            plan_hash: artifact.clone(),
            candidate_hash: artifact.clone(),
            module_id: "module.inert".into(),
            module_version: "1.0.0".into(),
            status: PreparedResultStatusV1::Prepared,
            artifact_hashes: vec![artifact.clone()],
            actual_resources: ResourceVectorV1::default(),
            actual_cost_microusd: 0,
            evidence_hash: evidence,
            external_action_may_have_started: false,
        };
        for (suffix, bytes) in [
            ("started", identity.as_str().as_bytes().to_vec()),
            ("prepared", serde_json::to_vec(&result).unwrap()),
        ] {
            let path = f.config.state_directory.join("attempts").join(format!(
                "{}.{}",
                identity.as_str().trim_start_matches("sha256:"),
                suffix
            ));
            fs::write(&path, bytes).unwrap();
            fs::set_permissions(path, fs::Permissions::from_mode(0o600)).unwrap();
        }
    }
}

fn configuration_file(f: &Fixture) -> std::path::PathBuf {
    let path = f.root.join("capacity-run.json");
    fs::write(&path, serde_json::to_vec(&f.config).unwrap()).unwrap();
    path
}

fn record_count(f: &Fixture) -> usize {
    fs::read_dir(f.config.state_directory.join("attempts"))
        .unwrap()
        .count()
}

fn record_snapshot(
    f: &Fixture,
) -> std::collections::BTreeMap<String, hepta_codex_protocol::Sha256Digest> {
    fs::read_dir(f.config.state_directory.join("attempts"))
        .unwrap()
        .map(|entry| {
            let entry = entry.unwrap();
            (
                entry.file_name().into_string().unwrap(),
                hash(&fs::read(entry.path()).unwrap()),
            )
        })
        .collect()
}

fn assert_rejected_before_ipc(f: &Fixture) {
    let retained = record_snapshot(f);
    let listener = f.listener();
    listener.set_nonblocking(true).unwrap();
    let mut child = Command::new(env!("CARGO_BIN_EXE_hepta-paper-rust"))
        .arg("run")
        .arg(configuration_file(f))
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .unwrap();
    let deadline = Instant::now() + Duration::from_secs(20);
    let mut connected = false;
    let status = loop {
        match listener.accept() {
            Ok((stream, _)) => {
                connected = true;
                drop(stream);
            }
            Err(error) if error.kind() == ErrorKind::WouldBlock => (),
            Err(error) => panic!("listener failed: {error}"),
        }
        if let Some(status) = child.try_wait().unwrap() {
            break status;
        }
        if Instant::now() >= deadline {
            child.kill().unwrap();
            child.wait().unwrap();
            panic!("capacity admission did not finish within the test deadline");
        }
        std::thread::sleep(Duration::from_millis(2));
    };
    if let Ok((stream, _)) = listener.accept() {
        connected = true;
        drop(stream);
    }
    assert!(!status.success());
    assert!(
        !connected,
        "full journal reached broker IPC before reserving result slots"
    );
    assert_eq!(
        record_snapshot(f),
        retained,
        "rejected admission changed historical records"
    );
}

#[test]
fn full_attempt_journal_rejects_before_any_broker_connection_or_start_record() {
    let f = Fixture::new_execution();
    inert_history(&f, 2048);
    assert_rejected_before_ipc(&f);
}

#[test]
fn last_attempt_pair_commits_and_full_journal_replays_without_broker() {
    let f = Fixture::new_execution();
    inert_history(&f, 2047);
    let config = configuration_file(&f);
    let peer = f.serve_execution(f.listener(), OUTPUT, 0);
    let first = Command::new(env!("CARGO_BIN_EXE_hepta-paper-rust"))
        .arg("run")
        .arg(&config)
        .output()
        .unwrap();
    peer.join().unwrap();
    assert!(
        first.status.success(),
        "{}",
        String::from_utf8_lossy(&first.stderr)
    );
    let first: serde_json::Value = serde_json::from_slice(&first.stdout).unwrap();
    assert_eq!(first["commitReceipts"][0]["newlyCommitted"], true);
    assert_eq!(record_count(&f), 4096);
    fs::remove_file(&f.socket_path).unwrap();
    let replay = Command::new(env!("CARGO_BIN_EXE_hepta-paper-rust"))
        .arg("run")
        .arg(&config)
        .output()
        .unwrap();
    assert!(
        replay.status.success(),
        "{}",
        String::from_utf8_lossy(&replay.stderr)
    );
    let replay: serde_json::Value = serde_json::from_slice(&replay.stdout).unwrap();
    assert_eq!(replay["commitReceipts"][0]["newlyCommitted"], false);
    assert_eq!(
        first["commitReceipts"][0]["resultHash"],
        replay["commitReceipts"][0]["resultHash"]
    );
    assert_eq!(record_count(&f), 4096);
}

#[test]
fn batch_reserves_all_result_pairs_before_its_first_broker_connection() {
    let mut f = Fixture::new_execution();
    inert_history(&f, 2047);
    let limit = &mut f.config.snapshot.resource_limit;
    limit.cpu_millis *= 2;
    limit.memory_bytes *= 2;
    limit.storage_bytes *= 2;
    limit.tokens *= 2;
    limit.provider_calls *= 2;
    let snapshot = f.config.snapshot.snapshot_hash().unwrap();
    f.config.frontier.snapshot_hash = snapshot.clone();
    f.config.frontier.candidates[0].snapshot_hash = snapshot;
    let mut second = f.config.frontier.candidates[0].clone();
    second.candidate_id = "draft-2".into();
    second.decision_group = "draft-2".into();
    f.config.frontier.candidates.push(second);
    f.config.planner_policy.maximum_exact_candidates = 2;
    f.config.planner_policy.maximum_selected_candidates = 2;
    let plan = hepta_control_plane::select_plan_v1(
        &f.config.snapshot,
        &f.config.frontier,
        &f.config.hard_policy,
        &f.config.planner_policy,
    )
    .unwrap();
    assert_eq!(plan.selected_candidate_ids.len(), 2);
    for (index, candidate) in f.config.frontier.candidates.iter().enumerate() {
        let mut request = f.request.clone();
        request.attempt_id = format!("{}:attempt:{}", plan.plan_hash.as_str(), index + 1);
        request.operation_id = request.attempt_id.clone();
        request.idempotency_key = plan.plan_hash.clone();
        request.node_id = candidate.candidate_id.clone();
        request.validate().unwrap();
        let path = f.request_path.parent().unwrap().join(
            hepta_paper_service::broker_prepared::broker_prepared_request_filename_v1(
                &request.attempt_id,
            )
            .unwrap(),
        );
        fs::write(&path, serde_json::to_vec(&request).unwrap()).unwrap();
        fs::set_permissions(path, fs::Permissions::from_mode(0o400)).unwrap();
    }
    assert_rejected_before_ipc(&f);
}

#[test]
fn final_prepared_slot_recovers_a_lost_response_without_reissuing_execution() {
    let f = Fixture::new_execution();
    let config = configuration_file(&f);
    let lost = f.serve_execution(f.listener(), OUTPUT, 1);
    let first = Command::new(env!("CARGO_BIN_EXE_hepta-paper-rust"))
        .arg("run")
        .arg(&config)
        .output()
        .unwrap();
    lost.join().unwrap();
    assert!(!first.status.success());
    assert_eq!(record_count(&f), 1);
    fs::remove_file(&f.socket_path).unwrap();
    inert_history(&f, 2047);
    assert_eq!(record_count(&f), 4095);
    let retained = record_snapshot(&f);
    // This peer verifies HEPTAQX1 and rejects an execution frame.
    let recovery = f.serve(f.listener(), OUTPUT, false, false);
    let replay = Command::new(env!("CARGO_BIN_EXE_hepta-paper-rust"))
        .arg("run")
        .arg(&config)
        .output()
        .unwrap();
    recovery.join().unwrap();
    assert!(
        replay.status.success(),
        "{}",
        String::from_utf8_lossy(&replay.stderr)
    );
    let receipt: serde_json::Value = serde_json::from_slice(&replay.stdout).unwrap();
    assert_eq!(receipt["commitReceipts"][0]["newlyCommitted"], true);
    let after = record_snapshot(&f);
    assert_eq!(after.len(), 4096);
    for (path, hash) in retained {
        assert_eq!(after.get(&path), Some(&hash));
    }
}
