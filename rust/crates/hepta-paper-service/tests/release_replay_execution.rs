use hepta_paper_service::release_attest::ReleaseAttestationSourceRequestV2;
use hepta_paper_service::release_replay::{
    ReleaseAttestationReplayRequestV3, inspect_release_attestation_replay_v3,
    inspect_release_attestation_replay_with_cancellation_v3,
};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{
    fs,
    path::{Path, PathBuf},
    process::Command,
    sync::atomic::{AtomicBool, AtomicU64, Ordering},
    time::{Duration, Instant},
};
static NEXT: AtomicU64 = AtomicU64::new(0);
struct Fixture {
    root: PathBuf,
    node: PathBuf,
}
fn digest(file: &Path) -> String {
    format!("sha256:{:x}", Sha256::digest(fs::read(file).unwrap()))
}
impl Fixture {
    fn new() -> Self {
        let source = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../..");
        let root = std::env::temp_dir().join(format!(
            "hepta-release-replay-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ));
        fs::create_dir(&root).unwrap();
        for name in [
            "migration/retirement/production-state-compat.mjs",
            "migration/legacy-reference-fixture.mjs",
            "migration/fixtures/legacy-differential-reference-v1.json",
            "migration/fixtures/legacy-differential-reference-v1.tar.gz",
            "workflow-kernel/record-hash.mjs",
            "paper-adapters/referee-revise/decision-routing.mjs",
            "paper-domain/repair/command-contract.mjs",
        ] {
            let destination = root.join(name);
            fs::create_dir_all(destination.parent().unwrap()).unwrap();
            fs::copy(source.join(name), destination).unwrap();
        }
        fs::create_dir_all(root.join("paper-core/docs")).unwrap();
        fs::write(root.join("package.json"),json!({"name":"fixture","version":"1.2.3","engines":{"node":">=22.23.1 <23"},"packageManager":"npm@10.9.8"}).to_string()).unwrap();
        fs::write(root.join("package-lock.json"),json!({"name":"fixture","version":"1.2.3","packages":{"":{"name":"fixture","version":"1.2.3"}}}).to_string()).unwrap();
        fs::write(
            root.join("paper-core/docs/CURRENT_STATUS.md"),
            "This is the normative status for the unreleased v1.2.3 development candidate.",
        )
        .unwrap();
        fs::write(
            root.join("RELEASE.md"),
            "Version 1.2.3 is an unreleased automation-first research-production candidate.",
        )
        .unwrap();
        fs::write(
            root.join("CHANGELOG.md"),
            "## Unreleased (1.2.3 development)",
        )
        .unwrap();
        let node = std::env::split_paths(&std::env::var_os("PATH").unwrap())
            .map(|dir| dir.join("node"))
            .find(|p| p.is_file())
            .unwrap();
        let fixture = Self {
            root,
            node: fs::canonicalize(node).unwrap(),
        };
        fixture.git(&["init", "--quiet"]);
        fixture.git(&["config", "user.name", "Private replay fixture"]);
        fixture.git(&["config", "user.email", "fixture@example.invalid"]);
        fixture.commit();
        fixture
    }
    fn git(&self, args: &[&str]) -> String {
        let o = Command::new("/usr/bin/git")
            .args(args)
            .current_dir(&self.root)
            .env("GIT_CONFIG_GLOBAL", "/dev/null")
            .env("GIT_CONFIG_NOSYSTEM", "1")
            .output()
            .unwrap();
        assert!(o.status.success(), "{}", String::from_utf8_lossy(&o.stderr));
        String::from_utf8(o.stdout).unwrap().trim().to_string()
    }
    fn commit(&self) {
        self.git(&["add", "--all"]);
        self.git(&[
            "-c",
            "commit.gpgsign=false",
            "commit",
            "--quiet",
            "-m",
            "Private reference fixture",
        ]);
    }
    fn request(&self) -> ReleaseAttestationReplayRequestV3 {
        let source = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../..");
        let snapshot = source.join("paper-adapters/runtime/release-state-repository.mjs");
        let script = format!(
            "import{{inspectWorkspaceReleaseState}}from {};console.log(JSON.stringify(inspectWorkspaceReleaseState({{workspaceRoot:process.argv[1]}})))",
            json!(format!("file://{}", snapshot.display()))
        );
        let out = Command::new(&self.node)
            .args(["--input-type=module", "--eval", &script])
            .arg(&self.root)
            .env_remove("NODE_OPTIONS")
            .output()
            .unwrap();
        assert!(
            out.status.success(),
            "{}",
            String::from_utf8_lossy(&out.stderr)
        );
        let snapshot: Value = serde_json::from_slice(&out.stdout).unwrap();
        ReleaseAttestationReplayRequestV3 {
            version: 3,
            kind: "ReleaseAttestationReplayRequest".into(),
            source: ReleaseAttestationSourceRequestV2 {
                version: 2,
                kind: "ReleaseAttestationSourceRequest".into(),
                workspace_root: self.root.clone(),
                git_executable: "/usr/bin/git".into(),
                git_executable_sha256: digest(Path::new("/usr/bin/git")),
                expected_commit: self.git(&["rev-parse", "HEAD"]),
                expected_tree: self.git(&["rev-parse", "HEAD^{tree}"]),
                expected_release_state_snapshot_hash: snapshot["workspaceReleaseStateSnapshotHash"]
                    .as_str()
                    .unwrap()
                    .into(),
                timeout_ms: 60_000,
            },
            node_executable: self.node.clone(),
            node_executable_sha256: digest(&self.node),
            timeout_ms: 60_000,
        }
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.root);
        let _ = fs::remove_dir_all(self.root.with_extension("node-tools"));
        let _ = fs::remove_file(self.root.with_extension("oracle-pids"));
    }
}
#[test]
fn ordinary_release_attest_runs_actual_source_bound_p0_p1_replay_and_reports_remaining_gaps() {
    let fixture = Fixture::new();
    let request = fixture.request();
    let path = fixture
        .root
        .parent()
        .unwrap()
        .join(format!("replay-cli-request-{}.json", std::process::id()));
    fs::write(&path, serde_json::to_vec(&request).unwrap()).unwrap();
    let result = Command::new(env!("CARGO_BIN_EXE_hepta-paper-rust"))
        .args(["release-attest", path.to_str().unwrap()])
        .env("NODE_OPTIONS", "--require /a/caller/injected/file")
        .output()
        .unwrap();
    fs::remove_file(path).unwrap();
    assert!(!result.status.success());
    assert!(
        !result.stdout.is_empty(),
        "ordinary owner {:?}: {}",
        result.status,
        String::from_utf8_lossy(&result.stderr)
    );
    let report: Value = serde_json::from_slice(&result.stdout).unwrap();
    assert_eq!(report["sourceBound"], true);
    assert_eq!(
        report["sourceGraph"]["namespaceAndHeldFdStabilityVerified"],
        true
    );
    assert_eq!(
        report["sourceGraph"]["arbitraryDynamicImportGraphClaimed"],
        false
    );
    assert_eq!(report["sourceGraph"]["inputs"].as_array().unwrap().len(), 7);
    let tool_file_bytes = fs::metadata(&fixture.node).unwrap().len()
        + fs::metadata("/usr/bin/python3").unwrap().len()
        + fs::metadata("/usr/bin/tar").unwrap().len();
    assert_eq!(report["toolReadBytes"], json!(2 * tool_file_bytes + 12));
    let graph_bytes = report["sourceGraph"]["observedReadBytes"].as_u64().unwrap();
    let graph_file_bytes: u64 = report["sourceGraph"]["inputs"]
        .as_array()
        .unwrap()
        .iter()
        .map(|row| row["bytes"].as_u64().unwrap())
        .sum();
    assert_eq!(graph_bytes, 2 * graph_file_bytes);
    assert_eq!(
        report["observedReadBytes"],
        json!(2 * tool_file_bytes + 12 + graph_bytes)
    );
    assert_eq!(
        report["nativeDifferentialReplay"]["sameInputRustNodeVerified"],
        true
    );
    assert_eq!(report["nativeDifferentialReplay"]["refereeCaseCount"], 866);
    let process = &report["nativeDifferentialReplay"]["productionProcess"];
    assert_eq!(process["stdoutTailTruncated"], true);
    assert_eq!(process["stdoutBytes"], process["capturedStdoutBytes"]);
    assert!(process["capturedStdoutBytes"].as_u64().unwrap() > 64 * 1024);
    assert_eq!(
        report["nativeDifferentialReplay"]["fullRestoredArchiveAndRuntimeReplayComplete"],
        false
    );
    assert_eq!(
        report["nativeDifferentialReplay"]["policyReplayComplete"],
        false
    );
    assert_eq!(
        report["implementationBlockers"].as_array().unwrap().len(),
        5
    );
    assert_eq!(
        report["externalQualificationBlockers"]
            .as_array()
            .unwrap()
            .len(),
        4
    );
    for flag in [
        "releaseEvidenceReady",
        "signingKeyRead",
        "runtimeEvidenceWritten",
        "physicalDeletionAllowed",
        "nodeRetirement",
        "externalActionPerformed",
    ] {
        assert_eq!(report[flag], false, "{flag}")
    }
    assert!(
        String::from_utf8_lossy(&result.stderr)
            .contains("implementationBlockers and externalQualificationBlockers")
    );
    assert_eq!(fixture.git(&["status", "--porcelain"]), "");
}
#[test]
fn replay_owner_refuses_wrong_tool_pin_dirty_source_or_committed_node_semantic_divergence() {
    let fixture = Fixture::new();
    let mut request = fixture.request();
    request.node_executable_sha256 = format!("sha256:{}", "a".repeat(64));
    assert!(
        inspect_release_attestation_replay_v3(request)
            .unwrap_err()
            .contains("tool_pin_mismatch")
    );
    let path = fixture
        .root
        .join("migration/retirement/production-state-compat.mjs");
    let source = fs::read_to_string(&path).unwrap();
    let changed = source.replace(
        "const sourceReady = Boolean(snapshot.source_ready);",
        "const sourceReady = false;",
    );
    assert_ne!(source, changed);
    fs::write(&path, changed).unwrap();
    let rejected = inspect_release_attestation_replay_v3(fixture.request()).unwrap_err();
    assert!(rejected.contains("tracked_bytes_mismatch"), "{rejected}");
    fixture.commit();
    assert!(
        inspect_release_attestation_replay_v3(fixture.request())
            .unwrap_err()
            .contains("production_differential_mismatch")
    );
}
#[test]
fn replay_owner_cancellation_and_strict_json_refuse_execution_before_any_oracle() {
    let fixture = Fixture::new();
    let request = fixture.request();
    let cancelled = AtomicBool::new(true);
    assert!(
        inspect_release_attestation_replay_with_cancellation_v3(request.clone(), &cancelled)
            .unwrap_err()
            .contains("cancelled")
    );
    let mut unknown = serde_json::to_value(&request).unwrap();
    unknown["callerReplayPassCount"] = json!(1000);
    assert!(serde_json::from_value::<ReleaseAttestationReplayRequestV3>(unknown).is_err());
    let json = serde_json::to_string(&request).unwrap();
    let duplicate = json.replacen("{", "{\"version\":3,", 1);
    assert!(serde_json::from_str::<ReleaseAttestationReplayRequestV3>(&duplicate).is_err());
}

fn process_identity(pid: u32) -> Option<String> {
    let stat = fs::read_to_string(format!("/proc/{pid}/stat")).ok()?;
    let tail = stat.get(stat.rfind(')')? + 1..)?;
    Some(format!("{pid}:{}", tail.split_whitespace().nth(19)?))
}

#[test]
fn replay_owner_live_cancellation_and_deadline_reap_the_actual_oracle_process_group() {
    for cancellation in [true, false] {
        let fixture = Fixture::new();
        let marker = fixture.root.with_extension("oracle-pids");
        let module = fixture
            .root
            .join("migration/retirement/production-state-compat.mjs");
        let busy = format!(
            "\nimport{{spawn as replaySpawn}}from'node:child_process';\nimport replayMarkerFs from'node:fs';\nconst replayChild=replaySpawn('/usr/bin/python3',['-I','-B','-c','import time;time.sleep(60)'],{{stdio:'ignore'}});\nreplayMarkerFs.writeFileSync({},JSON.stringify([process.pid,replayChild.pid]));\nwhile(true){{}}\n",
            json!(marker.to_string_lossy())
        );
        let original = fs::read_to_string(&module).unwrap();
        fs::write(&module, format!("{original}{busy}")).unwrap();
        fixture.commit();
        let mut request = fixture.request();
        request.timeout_ms = if cancellation { 30_000 } else { 4_000 };
        request.source.timeout_ms = request.timeout_ms;
        let cancelled = AtomicBool::new(false);
        let started = Instant::now();
        let (pids, identities, rejection) = std::thread::scope(|scope| {
            let worker = scope.spawn(|| {
                inspect_release_attestation_replay_with_cancellation_v3(request, &cancelled)
            });
            let pids: Vec<u32> = loop {
                if let Ok(bytes) = fs::read(&marker)
                    && let Ok(pids) = serde_json::from_slice::<Vec<u32>>(&bytes)
                {
                    assert_eq!(pids.len(), 2);
                    break pids;
                }
                assert!(
                    started.elapsed() < Duration::from_secs(10),
                    "ordinary oracle never started"
                );
                std::thread::sleep(Duration::from_millis(10));
            };
            let identities = pids
                .iter()
                .map(|pid| process_identity(*pid).expect("actual live oracle process"))
                .collect::<Vec<_>>();
            if cancellation {
                cancelled.store(true, Ordering::Release);
            }
            (pids, identities, worker.join().unwrap().unwrap_err())
        });
        fs::remove_file(marker).unwrap();
        assert!(
            rejection.contains(if cancellation {
                "Cancelled"
            } else {
                "TimedOut"
            }),
            "{rejection}"
        );
        assert!(rejection.contains("groupCleanup=true"), "{rejection}");
        assert!(started.elapsed() < Duration::from_secs(15));
        for (pid, identity) in pids.into_iter().zip(identities) {
            assert_ne!(
                process_identity(pid).as_deref(),
                Some(identity.as_str()),
                "oracle descendant survived cleanup"
            );
        }
    }
}

#[test]
fn replay_owner_refuses_same_byte_source_rewrite_and_private_elf_metadata_rewrite() {
    for tool_rewrite in [false, true] {
        let mut fixture = Fixture::new();
        let module = fixture
            .root
            .join("migration/retirement/production-state-compat.mjs");
        if tool_rewrite {
            let directory = fixture.root.with_extension("node-tools");
            fs::create_dir(&directory).unwrap();
            let copy = directory.join("node");
            fs::copy(&fixture.node, &copy).unwrap();
            fixture.node = copy;
        }
        let source = fs::read_to_string(&module).unwrap();
        let mutation = if tool_rewrite {
            "replayRewriteFs.utimesSync(process.execPath,1,1);"
        } else {
            "const bytes=replayRewriteFs.readFileSync(import.meta.filename);replayRewriteFs.writeFileSync(import.meta.filename,bytes);"
        };
        let committed = format!(
            "{source}\nimport replayRewriteFs from'node:fs';\nsetTimeout(()=>{{{mutation}}},1);\n"
        );
        fs::write(&module, &committed).unwrap();
        fixture.commit();
        let rejected = inspect_release_attestation_replay_v3(fixture.request()).unwrap_err();
        assert!(
            rejected.contains(if tool_rewrite {
                "tool_changed"
            } else {
                "source_graph_changed"
            }),
            "{rejected}"
        );
        assert_eq!(fs::read_to_string(&module).unwrap(), committed);
        assert_eq!(fixture.git(&["status", "--porcelain"]), "");
    }
}
