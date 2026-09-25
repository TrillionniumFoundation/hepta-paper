//! A later dependency wave is not a different resource reservation.
use super::*;

#[test]
fn prepared_provider_result_allows_later_wave_of_same_atomic_plan() {
    let mut f = Fixture::new_execution();
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
    second.dependency_candidate_ids = vec!["draft-1".into()];
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
    let requests = f
        .config
        .frontier
        .candidates
        .iter()
        .enumerate()
        .map(|(index, candidate)| {
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
            fs::set_permissions(&path, fs::Permissions::from_mode(0o400)).unwrap();
            request
        })
        .collect();
    let server = f.serve_execution_sequence(f.listener(), requests, OUTPUT, 0);
    let path = f.root.join("two-wave-run.json");
    fs::write(&path, serde_json::to_vec(&f.config).unwrap()).unwrap();
    let output = Command::new(env!("CARGO_BIN_EXE_hepta-paper-rust"))
        .arg("run")
        .arg(&path)
        .output()
        .unwrap();
    server.join().unwrap();
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    let first: serde_json::Value = serde_json::from_slice(&output.stdout).unwrap();
    let receipts = first["commitReceipts"].as_array().unwrap();
    assert_eq!(receipts.len(), 2);
    assert!(
        receipts
            .iter()
            .all(|receipt| receipt["newlyCommitted"] == true)
    );
    assert_eq!(
        fs::read_dir(f.config.state_directory.join("attempts"))
            .unwrap()
            .count(),
        4
    );
    fs::remove_file(&f.socket_path).unwrap();
    let replay = Command::new(env!("CARGO_BIN_EXE_hepta-paper-rust"))
        .arg("run")
        .arg(&path)
        .output()
        .unwrap();
    assert!(
        replay.status.success(),
        "{}",
        String::from_utf8_lossy(&replay.stderr)
    );
    let replay: serde_json::Value = serde_json::from_slice(&replay.stdout).unwrap();
    let replay = replay["commitReceipts"].as_array().unwrap();
    assert_eq!(replay.len(), 2);
    for (original, repeated) in receipts.iter().zip(replay) {
        assert_eq!(repeated["newlyCommitted"], false);
        assert_eq!(original["resultHash"], repeated["resultHash"]);
        assert_eq!(original["sequence"], repeated["sequence"]);
    }
}
