//! Actual ordinary frontend and durable owner. Response peers below are bounded
//! local protocol fixtures, not independently authenticated provider accounts.
use super::*;

fn retained(c: &Campaign) -> Value {
    let definition: hepta_paper_service::workflow::LocalWorkflowV1 =
        serde_json::from_slice(&fs::read(c.root.join("workflow.json")).unwrap()).unwrap();
    assert_eq!(definition.template.snapshot.budget_microusd, 80);
    assert_eq!(
        definition.template.writer_lease.expires_at_unix_ms
            - definition.template.observed_at_unix_ms,
        300_000
    );
    serde_json::from_slice(
        &ObjectStoreV1::open(&c.root)
            .unwrap()
            .read(&definition.template.initial_state_hash)
            .unwrap(),
    )
    .unwrap()
}

#[test]
fn normal_budget_caps_are_persisted_and_plain_recovery_keeps_the_first_request() {
    let mut c = Campaign::new();
    let config_path = c.author.root.join("autonomous-research-request.v1.json");
    let configured = fs::read(&config_path).unwrap();
    let configured_hash = hepta_control_plane::canonical_hash_v1(&c.request).unwrap();
    let overrides = ["--max-cost-usd", "0.00008", "--max-wall-ms", "300000"];
    let prepared = c.invoke_with("prepare", None, &overrides);
    assert_eq!(prepared["ready"], true, "{prepared}");
    assert_eq!(prepared["budgetMicrousd"], 80);
    assert_eq!(prepared["maximumWallMs"], 300_000);
    assert!(prepared["campaignPersisted"].is_null());
    assert!(!c.root.exists());
    let launched = c.invoke_with("launch", Some(1), &overrides);
    assert_eq!(
        launched["ready"], false,
        "unavailable peer cannot produce a result: {launched}"
    );
    assert_eq!(launched["configuredRequestHash"], configured_hash.as_str());
    let subject = retained(&c);
    assert_eq!(subject[2]["budgetMicrousd"], 80);
    assert_eq!(subject[2]["maximumWallMs"], 300_000);
    assert_eq!(subject[3], configured_hash.as_str());
    let first_hash = launched["requestHash"].clone();
    let manifest = c.stage(0, DRAFT, 6, true);
    assert_eq!(manifest["objective"], c.request.objective);
    let accepted = serde_json::to_vec(
        &json!({"accepted":true,"manuscriptHash":hash(DRAFT),"review":"accepted"}),
    )
    .unwrap();
    c.stage(1, &accepted, 3, true);
    let before = c.status();
    assert_eq!(before["budgetRemainingMicrousd"], 71);
    let replay = c.advance(None);
    assert_eq!(replay["ready"], true, "{replay}");
    assert_eq!(replay["requestHash"], first_hash);
    assert_eq!(replay["budgetMicrousd"], 80);
    assert_eq!(replay["maximumWallMs"], 300_000);
    assert_eq!(c.invoke_with("converge", None, &overrides)["ready"], true);
    assert_eq!(
        c.invoke_with("converge", None, &["--max-cost-usd", "8e-5"])["ready"],
        true,
        "the same incumbent Number cannot silently amend the retained budget"
    );
    for changed in [
        ["--max-cost-usd", "0.000079"],
        ["--max-cost-usd", "0.0001"],
        ["--max-wall-ms", "299999"],
        ["--max-wall-ms", "600000"],
    ] {
        assert_eq!(
            c.invoke_with("converge", None, &changed)["error"],
            "autonomous_research_campaign_request_rejected"
        );
        assert_eq!(c.status(), before);
    }
    assert_eq!(fs::read(config_path).unwrap(), configured);
    assert_eq!(retained(&c), subject);
}

#[test]
fn normal_unknown_result_recovers_by_query_with_reduced_budget_without_redispatch() {
    let mut c = Campaign::new();
    let configured = fs::read(c.author.root.join("autonomous-research-request.v1.json")).unwrap();
    let first = c.invoke_with(
        "converge",
        Some(1),
        &["--max-cost-usd", "0.00008", "--max-wall-ms", "300000"],
    );
    assert_eq!(first["ready"], false);
    c.capture(0);
    let request = fs::read(&c.author.request_path).unwrap();
    let server = c.author.serve_execution(c.author.listener(), DRAFT, 1);
    let unknown = c.advance(Some(1));
    server.join().unwrap();
    fs::remove_file(&c.author.socket_path).unwrap();
    assert_eq!(unknown["ready"], false);
    assert_eq!(c.status()["committedSteps"], 0);
    assert_eq!(c.status()["pendingStep"], true);
    assert_eq!(c.status()["budgetRemainingMicrousd"], 80);
    c.author.publish_cost_settlement(DRAFT, 6);
    let server = c.author.serve(c.author.listener(), DRAFT, false, false);
    let recovered = c.advance(Some(1));
    server.join().unwrap();
    fs::remove_file(&c.author.socket_path).unwrap();
    assert_eq!(recovered["requestHash"], first["requestHash"]);
    assert_eq!(c.status()["committedSteps"], 1);
    assert_eq!(c.status()["budgetRemainingMicrousd"], 74);
    assert_eq!(fs::read(&c.author.request_path).unwrap(), request);
    let ack = c.author.publish_commit_acknowledgement(DRAFT);
    let server = c
        .author
        .serve_commit_acknowledgement(c.author.listener(), ack, false);
    assert_eq!(c.advance(Some(1))["ready"], true);
    server.join().unwrap();
    fs::remove_file(&c.author.socket_path).unwrap();
    assert_eq!(retained(&c)[2]["budgetMicrousd"], 80);
    assert_eq!(
        fs::read(c.author.root.join("autonomous-research-request.v1.json")).unwrap(),
        configured
    );
}

#[test]
fn normal_exact_node_microdollar_tail_values_retain_the_effective_request_and_settlement() {
    for (text, expected) in [("0.000123", 123), ("0.000249", 249)] {
        let mut c = Campaign::new();
        c.request.budget_microusd = 250;
        c.write();
        let configured_path = c.author.root.join("autonomous-research-request.v1.json");
        let configured = fs::read(&configured_path).unwrap();
        let launched = c.invoke_with("launch", Some(1), &["--max-cost-usd", text]);
        assert_eq!(launched["ready"], false, "{launched}");
        assert_eq!(launched["budgetMicrousd"], expected);
        assert_eq!(c.status()["budgetRemainingMicrousd"], expected);
        let definition: hepta_paper_service::workflow::LocalWorkflowV1 =
            serde_json::from_slice(&fs::read(c.root.join("workflow.json")).unwrap()).unwrap();
        let raw_subject = ObjectStoreV1::open(&c.root)
            .unwrap()
            .read(&definition.template.initial_state_hash)
            .unwrap();
        let subject: Value = serde_json::from_slice(&raw_subject).unwrap();
        assert_eq!(subject[2]["budgetMicrousd"], expected);
        c.stage(0, DRAFT, 6, true);
        let accepted = serde_json::to_vec(
            &json!({"accepted":true,"manuscriptHash":hash(DRAFT),"review":"accepted"}),
        )
        .unwrap();
        c.stage(1, &accepted, 3, true);
        assert_eq!(c.advance(None)["ready"], true);
        assert_eq!(c.status()["budgetRemainingMicrousd"], expected - 9);
        assert_eq!(fs::read(configured_path).unwrap(), configured);
        assert_eq!(
            ObjectStoreV1::open(&c.root)
                .unwrap()
                .read(&definition.template.initial_state_hash)
                .unwrap(),
            raw_subject
        );
    }
}

#[test]
fn normal_term_and_kill_after_broker_request_keep_budget_and_query_only_fresh_retry() {
    exercise_signal_recovery(None);
}

pub(super) fn exercise_signal_recovery(agent_call_limit: Option<u64>) {
    use std::{
        io::Read,
        sync::mpsc,
        time::{Duration, Instant},
    };
    struct OwnedChild(std::process::Child);
    impl Drop for OwnedChild {
        fn drop(&mut self) {
            if self.0.try_wait().ok().flatten().is_none() {
                let _ = self.0.kill();
            }
            let _ = self.0.wait();
        }
    }
    for signal in [
        nix::sys::signal::Signal::SIGTERM,
        nix::sys::signal::Signal::SIGKILL,
    ] {
        let mut c = Campaign::new();

        let listener = c.author.listener();
        listener.set_nonblocking(true).unwrap();
        let (sent, accepted) = mpsc::channel();
        let server = std::thread::spawn(move || {
            let deadline = Instant::now() + Duration::from_secs(15);
            let mut stream = loop {
                match listener.accept() {
                    Ok((stream, _)) => break stream,
                    Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                        assert!(
                            Instant::now() < deadline,
                            "actual normal broker connection timeout"
                        );
                        std::thread::sleep(Duration::from_millis(5));
                    }
                    Err(error) => panic!("actual normal broker accept: {error}"),
                }
            };
            stream
                .set_read_timeout(Some(Duration::from_secs(15)))
                .unwrap();
            let peer = hepta_codex_broker::inspect_peer_identity(&stream).unwrap();
            let request =
                hepta_codex_broker::read_request_frame(&mut stream, Default::default()).unwrap();
            sent.send((peer, request.request)).unwrap();
            // No result is written. The parent is interrupted at an observed
            // real broker transport boundary, not a sleep-selected stage.
            let mut byte = [0];
            assert_eq!(stream.read(&mut byte).unwrap(), 0);
        });
        let mut command = c.command("launch");
        command.args([
            "--through-steps",
            "1",
            "--max-cost-usd",
            "0.00008",
            "--max-wall-ms",
            "300000",
        ]);
        if let Some(limit) = agent_call_limit {
            command.args(["--max-agent-calls", &limit.to_string()]);
        }
        let mut child = OwnedChild(
            command
                .stdout(std::process::Stdio::piped())
                .stderr(std::process::Stdio::piped())
                .spawn()
                .unwrap(),
        );
        let (peer, request) = accepted.recv_timeout(Duration::from_secs(15)).unwrap();
        assert_eq!(peer.pid, i32::try_from(child.0.id()).unwrap());
        assert_eq!(peer.uid, nix::unistd::geteuid().as_raw());
        assert!(child.0.try_wait().unwrap().is_none());
        // The still-held child handle pins this PID: an unreaped child cannot
        // be replaced by another process. Signal only this owned frontend.
        nix::sys::signal::kill(nix::unistd::Pid::from_raw(peer.pid), signal).unwrap();
        let deadline = Instant::now() + Duration::from_secs(15);
        while child.0.try_wait().unwrap().is_none() {
            assert!(
                Instant::now() < deadline,
                "owned normal signal exit timeout"
            );
            std::thread::sleep(Duration::from_millis(5));
        }
        server.join().unwrap();
        c.capture(0);
        let subject = retained(&c);
        assert_eq!(c.author.request, request);
        let raw_request = fs::read(&c.author.request_path).unwrap();
        fs::remove_file(&c.author.socket_path).unwrap();
        assert_eq!(c.status()["pendingStep"], true);
        assert_eq!(c.status()["committedSteps"], 0);
        assert_eq!(c.status()["budgetRemainingMicrousd"], 80);
        if let Some(limit) = agent_call_limit {
            assert_eq!(
                c.status()["providerCallUsage"],
                json!({"version":1,"maximumCalls":limit,"committedCalls":0,"reservedCalls":1})
            );
            assert_eq!(subject[2]["maxAgentCalls"], limit);
        }
        c.author.publish_cost_settlement(DRAFT, 6);
        let server = c.author.serve(c.author.listener(), DRAFT, false, false);
        assert_eq!(
            c.advance(Some(1))["ready"],
            false,
            "independent ACK is still required"
        );
        server.join().unwrap();
        fs::remove_file(&c.author.socket_path).unwrap();
        let ack = c.author.publish_commit_acknowledgement(DRAFT);
        let server = c
            .author
            .serve_commit_acknowledgement(c.author.listener(), ack, false);
        assert_eq!(c.advance(Some(1))["ready"], true);
        server.join().unwrap();
        fs::remove_file(&c.author.socket_path).unwrap();
        assert_eq!(c.status()["budgetRemainingMicrousd"], 74);
        assert_eq!(fs::read(&c.author.request_path).unwrap(), raw_request);
        assert_eq!(retained(&c), subject);
        if let Some(limit) = agent_call_limit {
            assert_eq!(
                c.status()["providerCallUsage"],
                json!({"version":1,"maximumCalls":limit,"committedCalls":1,"reservedCalls":1})
            );
            assert_eq!(
                c.advance(None)["error"],
                "local_workflow_provider_call_budget_exhausted"
            );
            assert!(!c.root.join("step-0001.json").exists());
        }
    }
}

#[test]
fn normal_budget_zero_fractional_missing_authority_and_ceiling_refusals_do_not_create_state() {
    let mut c = Campaign::new();
    for overrides in [
        vec!["--max-cost-usd", "0"],
        vec!["--max-wall-ms", "0"],
        vec!["--max-cost-usd", "0.000059"],
    ] {
        assert_eq!(c.invoke_with("launch", Some(1), &overrides)["ready"], false);
        assert!(!c.root.exists());
    }
    for overrides in [
        ["--max-cost-usd", "0.0000015"],
        ["--max-wall-ms", "1.5"],
        ["--max-cost-usd", "NaN"],
        ["--max-wall-ms", "Infinity"],
        ["--max-cost-usd", "-1"],
        ["--max-wall-ms", "-1"],
    ] {
        let out = c.command("launch").args(overrides).output().unwrap();
        assert!(!out.status.success());
        assert!(out.stdout.is_empty());
        assert!(!c.root.exists());
    }
    // A large legitimate incumbent value is normalized then narrowed by the
    // configured ceiling; it is not denied merely because it is positive.
    let allowed = c.invoke_with(
        "prepare",
        None,
        &["--max-cost-usd", "1e300", "--max-wall-ms", "1e300"],
    );
    assert_eq!(allowed["ready"], true, "{allowed}");
    assert_eq!(allowed["budgetMicrousd"], 100);
    assert_eq!(allowed["maximumWallMs"], 600_000);
    assert!(!c.root.exists());
    c.request.author.source.cost_settlement = None;
    c.write();
    assert_eq!(
        c.invoke_with("launch", Some(1), &["--max-cost-usd", "0.00008"])["ready"],
        false
    );
    assert!(!c.root.exists());
}
