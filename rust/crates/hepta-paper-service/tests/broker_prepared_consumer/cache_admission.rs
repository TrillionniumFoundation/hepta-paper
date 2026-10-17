//! Prepared bytes are recovery evidence, not a fresh admission decision.
use super::*;
use hepta_control_plane::ControlPlaneError;
use hepta_paper_service::run_service_with_clock_v1;

fn prepared_records(f: &Fixture) -> Vec<(std::path::PathBuf, Vec<u8>)> {
    let mut records: Vec<_> = fs::read_dir(f.config.state_directory.join("attempts"))
        .unwrap()
        .map(|entry| {
            let path = entry.unwrap().path();
            let bytes = fs::read(&path).unwrap();
            (path, bytes)
        })
        .collect();
    records.sort();
    records
}

// A real owner run prepares output, then its final clock fails. No database
// result is committed and no prepared file is manufactured by the fixture.
fn stage_uncommitted(f: &Fixture, execute: bool) {
    let server = if execute {
        f.serve_execution(f.listener(), OUTPUT, 0)
    } else {
        f.serve(f.listener(), OUTPUT, false, false)
    };
    let mut clock = || {
        if prepared_records(f).iter().any(|(path, _)| {
            path.extension()
                .is_some_and(|extension| extension == "prepared")
        }) {
            Err(ControlPlaneError::ExecutionInvalid)
        } else {
            Ok(f.config.observed_at_unix_ms)
        }
    };
    assert!(run_service_with_clock_v1(f.config.clone(), &mut clock).is_err());
    server.join().unwrap();
    assert_eq!(prepared_records(f).len(), 2);
    fs::remove_file(&f.socket_path).unwrap();
}

#[test]
fn withdrawn_request_cannot_be_bypassed_by_an_uncommitted_prepared_cache() {
    for execute in [false, true] {
        let f = if execute {
            Fixture::new_execution()
        } else {
            Fixture::new()
        };
        stage_uncommitted(&f, execute);
        let retained = prepared_records(&f);
        fs::remove_file(&f.request_path).unwrap();
        let config = f.root.join("cached-run.json");
        fs::write(&config, serde_json::to_vec(&f.config).unwrap()).unwrap();
        let output = Command::new(env!("CARGO_BIN_EXE_hepta-paper-rust"))
            .arg("run")
            .arg(&config)
            .output()
            .unwrap();
        assert!(
            !output.status.success(),
            "withdrawn broker admission was bypassed by prepared cache: {}",
            String::from_utf8_lossy(&output.stdout)
        );
        assert_eq!(prepared_records(&f), retained);
    }
}

#[test]
fn cached_query_requires_current_broker_and_retains_exact_evidence() {
    for execute in [false, true] {
        let f = if execute {
            Fixture::new_execution()
        } else {
            Fixture::new()
        };
        stage_uncommitted(&f, execute);
        let retained = prepared_records(&f);
        // A current broker refusal must not fall back to otherwise valid cache.
        let rejected = f.serve(f.listener(), OUTPUT, true, false);
        assert!(run_service_v1(f.config.clone()).is_err());
        rejected.join().unwrap();
        assert_eq!(prepared_records(&f), retained);
        fs::remove_file(&f.socket_path).unwrap();
        // The same attempt can recover, but this listener accepts QUERY only.
        let recovery = f.serve(f.listener(), OUTPUT, false, false);
        let first = run_service_v1(f.config.clone()).unwrap();
        recovery.join().unwrap();
        assert!(first.commit_receipts[0].newly_committed);
        assert_eq!(prepared_records(&f), retained);
        fs::remove_file(&f.socket_path).unwrap();
        fs::remove_file(&f.request_path).unwrap();
        // A durable commit, unlike a prepared cache, remains historical truth
        // after request withdrawal and broker disappearance; no IPC or re-debit.
        let replay = run_service_v1(f.config.clone()).unwrap();
        assert!(!replay.commit_receipts[0].newly_committed);
        assert_eq!(
            first.commit_receipts[0].result_hash,
            replay.commit_receipts[0].result_hash
        );
        assert_eq!(prepared_records(&f), retained);
    }
}

#[test]
fn cached_query_cannot_replace_original_receipt_or_output() {
    let mut f = Fixture::new_execution();
    stage_uncommitted(&f, true);
    let retained = prepared_records(&f);
    let original = f.request.clone();
    // A completely valid replacement receipt is not the original preparation.
    f.request.request_capability.nonce.push('x');
    f.publish(&f.request);
    let substituted = f.serve(f.listener(), OUTPUT, false, false);
    assert!(run_service_v1(f.config.clone()).is_err());
    substituted.join().unwrap();
    assert_eq!(prepared_records(&f), retained);
    fs::remove_file(&f.socket_path).unwrap();
    f.request = original;
    f.publish(&f.request);
    let changed = f.serve(
        f.listener(),
        br#"{"manuscript":"replacement result"}"#,
        false,
        false,
    );
    assert!(run_service_v1(f.config.clone()).is_err());
    changed.join().unwrap();
    assert_eq!(prepared_records(&f), retained);
    fs::remove_file(&f.socket_path).unwrap();
    let recovered = f.serve(f.listener(), OUTPUT, false, false);
    assert!(run_service_v1(f.config.clone()).unwrap().commit_receipts[0].newly_committed);
    recovered.join().unwrap();
    assert_eq!(prepared_records(&f), retained);
}

#[test]
fn unsettled_provider_preparation_fences_a_different_plan_before_ipc() {
    use std::{
        io::Read,
        sync::{
            Arc,
            atomic::{AtomicBool, Ordering},
        },
        thread,
        time::Duration,
    };
    let f = Fixture::new_execution();
    stage_uncommitted(&f, true);
    let retained = prepared_records(&f);
    let mut different = f.config.clone();
    different.frontier.candidates[0].utility_micros += 1;
    let plan = hepta_control_plane::select_plan_v1(
        &different.snapshot,
        &different.frontier,
        &different.hard_policy,
        &different.planner_policy,
    )
    .unwrap();
    let mut request = f.request.clone();
    request.attempt_id = format!("{}:attempt:1", plan.plan_hash.as_str());
    request.operation_id = request.attempt_id.clone();
    request.idempotency_key = plan.plan_hash;
    request.validate().unwrap();
    let path = f.request_path.parent().unwrap().join(
        hepta_paper_service::broker_prepared::broker_prepared_request_filename_v1(
            &request.attempt_id,
        )
        .unwrap(),
    );
    assert_ne!(path, f.request_path);
    fs::write(&path, serde_json::to_vec(&request).unwrap()).unwrap();
    fs::set_permissions(&path, fs::Permissions::from_mode(0o400)).unwrap();
    let listener = f.listener();
    listener.set_nonblocking(true).unwrap();
    let done = Arc::new(AtomicBool::new(false));
    let peer_done = Arc::clone(&done);
    let peer = thread::spawn(move || {
        loop {
            match listener.accept() {
                Ok((mut stream, _)) => {
                    stream
                        .set_read_timeout(Some(Duration::from_secs(2)))
                        .unwrap();
                    let mut magic = [0_u8; 8];
                    let _ = stream.read_exact(&mut magic);
                    return Some(magic);
                }
                Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                    if peer_done.load(Ordering::Acquire) {
                        return None;
                    }
                    thread::sleep(Duration::from_millis(2));
                }
                Err(error) => panic!("listener: {error}"),
            }
        }
    });
    let result = run_service_v1(different);
    done.store(true, Ordering::Release);
    let unexpected = peer.join().unwrap();
    assert!(result.is_err());
    assert!(
        unexpected.is_none(),
        "unsettled provider result allowed a new plan to reach IPC: {unexpected:?}"
    );
    assert_eq!(prepared_records(&f), retained);
    fs::remove_file(&f.socket_path).unwrap();
    let recovery = f.serve(f.listener(), OUTPUT, false, false);
    assert!(run_service_v1(f.config.clone()).unwrap().commit_receipts[0].newly_committed);
    recovery.join().unwrap();
    assert_eq!(prepared_records(&f), retained);
}
