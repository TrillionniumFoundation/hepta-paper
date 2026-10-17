//! Actual Git/source observations and qualified Node differential coverage.
//! These private fixture repositories grant no production release authority.
use hepta_paper_service::release_attest::{
    ReleaseAttestationSourceRequestV2, inspect_release_attestation_source_v2,
    inspect_release_attestation_source_with_cancellation_v2,
};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{
    fs,
    os::unix::fs::{PermissionsExt, symlink},
    path::{Path, PathBuf},
    process::Command,
    sync::{
        Arc,
        atomic::{AtomicBool, AtomicU64, Ordering},
    },
    time::{Duration, Instant},
};
static NEXT: AtomicU64 = AtomicU64::new(0);
struct Fixture {
    root: PathBuf,
}
impl Fixture {
    fn new(state: &str) -> Self {
        let parent = std::env::var_os("HEPTA_RELEASE_SOURCE_TEST_ROOT")
            .map(PathBuf::from)
            .unwrap_or_else(std::env::temp_dir);
        fs::create_dir_all(&parent).unwrap();
        let root = parent.join(format!(
            "hepta-release-source-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ));
        fs::create_dir(&root).unwrap();
        fs::create_dir_all(root.join("paper-core/docs")).unwrap();
        fs::write(root.join("package.json"), json!({"name":"fixture","version":"1.2.3","engines":{"node":">=22.23.1 <23"},"packageManager":"npm@10.9.8"}).to_string()).unwrap();
        fs::write(root.join("package-lock.json"), json!({"name":"fixture","version":"1.2.3","packages":{"":{"name":"fixture","version":"1.2.3"}}}).to_string()).unwrap();
        let (current, release, changelog) = if state == "development" {
            (
                "This is the normative status for the unreleased v1.2.3 development candidate.",
                "Version 1.2.3 is an unreleased automation-first research-production candidate.",
                "## Unreleased (1.2.3 development)",
            )
        } else {
            (
                "Release state: finalized v1.2.3 source.",
                "Version 1.2.3 is finalized from this exact source commit.",
                "## 1.2.3 (finalized source)",
            )
        };
        fs::write(root.join("paper-core/docs/CURRENT_STATUS.md"), current).unwrap();
        fs::write(root.join("RELEASE.md"), release).unwrap();
        fs::write(root.join("CHANGELOG.md"), changelog).unwrap();
        fs::write(root.join("source.txt"), "original-source\n").unwrap();
        let fixture = Self { root };
        fixture.git(&["init", "--quiet"]);
        fixture.git(&["config", "user.name", "Private fixture"]);
        fixture.git(&["config", "user.email", "private-fixture@example.invalid"]);
        fixture.commit();
        if state == "released" {
            fixture.git(&["tag", "v1.2.3"]);
        }
        fixture
    }
    fn git(&self, args: &[&str]) -> Vec<u8> {
        let output = Command::new("/usr/bin/git")
            .args(args)
            .current_dir(&self.root)
            .env("GIT_CONFIG_GLOBAL", "/dev/null")
            .env("GIT_CONFIG_NOSYSTEM", "1")
            .output()
            .unwrap();
        assert!(
            output.status.success(),
            "{}",
            String::from_utf8_lossy(&output.stderr)
        );
        output.stdout
    }
    fn commit(&self) {
        self.git(&["add", "--all"]);
        self.git(&[
            "-c",
            "commit.gpgsign=false",
            "commit",
            "--quiet",
            "--allow-empty",
            "-m",
            "Private source fixture",
        ]);
    }
    fn oracle(&self) -> Value {
        let source = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../..");
        let snapshot_module = source.join("paper-adapters/runtime/release-state-repository.mjs");
        let provenance_module = source.join("paper-adapters/runtime/code-provenance.mjs");
        let script = format!(
            "import {{inspectWorkspaceReleaseState}} from {}; import {{currentCodeProvenance}} from {}; const root=process.argv[1]; console.log(JSON.stringify({{profile:{{node:process.version,icu:process.versions.icu,cldr:process.versions.cldr}},snapshot:inspectWorkspaceReleaseState({{workspaceRoot:root}}),provenance:{{...currentCodeProvenance({{workspaceRoot:root,allowReleaseCommitEnvironment:false}}),evidenceEnvironment:'administrative',evidenceClass:'release_attestation'}}}}));",
            json!(format!("file://{}", snapshot_module.display())),
            json!(format!("file://{}", provenance_module.display()))
        );
        let output = Command::new("node")
            .args(["--input-type=module", "--eval", &script])
            .arg(&self.root)
            .env_remove("HEPTA_RELEASE_ENV_LAUNCHER")
            .env_remove("HEPTA_RELEASE_COMMIT")
            .output()
            .unwrap();
        assert!(
            output.status.success(),
            "{}",
            String::from_utf8_lossy(&output.stderr)
        );
        let value: Value = serde_json::from_slice(&output.stdout).unwrap();
        assert_eq!(value["profile"]["node"], "v22.23.1");
        assert_eq!(value["profile"]["icu"], "78.2");
        assert_eq!(value["profile"]["cldr"], "48.0");
        value
    }
    fn request(&self) -> ReleaseAttestationSourceRequestV2 {
        let oracle = self.oracle();
        ReleaseAttestationSourceRequestV2 {
            version: 2,
            kind: "ReleaseAttestationSourceRequest".into(),
            workspace_root: self.root.clone(),
            git_executable: "/usr/bin/git".into(),
            git_executable_sha256: format!(
                "sha256:{:x}",
                Sha256::digest(fs::read("/usr/bin/git").unwrap())
            ),
            expected_commit: oracle["provenance"]["commit"].as_str().unwrap().into(),
            expected_tree: oracle["provenance"]["commitTree"].as_str().unwrap().into(),
            expected_release_state_snapshot_hash:
                oracle["snapshot"]["workspaceReleaseStateSnapshotHash"]
                    .as_str()
                    .unwrap()
                    .into(),
            timeout_ms: 30_000,
        }
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.root);
    }
}
fn refused(request: ReleaseAttestationSourceRequestV2) -> String {
    inspect_release_attestation_source_v2(request)
        .unwrap_err()
        .to_string()
}

#[test]
fn actual_release_source_capture_accepts_only_unmaterialized_exact_gitlink_references() {
    let fixture = Fixture::new("development");
    let oid = String::from_utf8(fixture.git(&["rev-parse", "HEAD"])).unwrap();
    let oid = oid.trim();
    fs::create_dir(fixture.root.join("nested")).unwrap();
    fs::write(fixture.root.join(".gitmodules"), "[submodule \"reference\"]\n\tpath = nested/reference\n\turl = https://example.invalid/immutable-reference.git\n").unwrap();
    fixture.git(&["add", ".gitmodules"]);
    fixture.git(&[
        "update-index",
        "--add",
        "--cacheinfo",
        &format!("160000,{oid},nested/reference"),
    ]);
    fixture.git(&[
        "-c",
        "commit.gpgsign=false",
        "commit",
        "--quiet",
        "-m",
        "Exact unmaterialized reference",
    ]);
    let request = fixture.request();
    assert!(refused(request.clone()).contains("tracked_source_missing"));
    fs::create_dir(fixture.root.join("nested/reference")).unwrap();
    // rev-parse in this empty directory would discover the parent HEAD. The
    // reference observer performs no query there and accepts only the recorded
    // older commit plus the actual empty directory witness.
    assert_ne!(
        String::from_utf8(fixture.git(&["rev-parse", "HEAD"]))
            .unwrap()
            .trim(),
        oid
    );
    let empty = inspect_release_attestation_source_v2(request.clone()).unwrap();
    assert_eq!(empty["gitlinkReferences"][0]["commit"], oid);
    assert_eq!(empty["gitlinkReferences"][0]["state"], "empty_directory");
    assert_eq!(
        empty["nativeSourceCapture"]["codeProvenance"],
        fixture.oracle()["provenance"]
    );
    fs::write(
        fixture.root.join("nested/reference/.hidden"),
        b"nested bytes are not source accepted",
    )
    .unwrap();
    assert!(refused(request.clone()).contains("gitlink_materialized"));
    fs::remove_file(fixture.root.join("nested/reference/.hidden")).unwrap();
    fixture.git(&[
        "update-index",
        "--cacheinfo",
        &format!("160000,{},nested/reference", "a".repeat(40)),
    ]);
    assert!(refused(request).contains("tree_index_mismatch"));
}

#[test]
fn ordinary_cli_captures_actual_source_and_prints_remaining_internal_and_external_blockers() {
    let fixture = Fixture::new("development");
    let request = fixture.request();
    // The request is outside the observed repository, so it does not make its
    // own selected source dirty or enter the source snapshot.
    let input = fixture.root.with_extension("request.json");
    fs::write(&input, serde_json::to_vec(&request).unwrap()).unwrap();
    let output = Command::new(env!("CARGO_BIN_EXE_hepta-paper-rust"))
        .args(["release-attest", input.to_str().unwrap()])
        .output()
        .unwrap();
    fs::remove_file(&input).unwrap();
    assert!(!output.status.success());
    let report: Value = serde_json::from_slice(&output.stdout).unwrap();
    assert_eq!(report["version"], 2);
    assert_eq!(report["sourceBound"], true);
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
    assert_eq!(
        report["nativeSourceCapture"]["codeProvenance"]["commit"],
        request.expected_commit
    );
    for flag in [
        "releaseEvidenceReady",
        "signingKeyRead",
        "runtimeEvidenceWritten",
        "physicalDeletionAllowed",
        "nodeRetirement",
        "externalActionPerformed",
    ] {
        assert_eq!(report[flag], false);
    }
    assert!(String::from_utf8_lossy(&output.stderr).contains("implementationBlockers"));
}

#[test]
fn ordinary_cli_refuses_duplicate_or_unknown_source_request_fields_before_source_inspection() {
    let fixture = Fixture::new("development");
    let request = serde_json::to_string(&fixture.request()).unwrap();
    let input = fixture.root.with_extension("request.json");
    for changed in [
        request.replacen('{', "{\"version\":2,", 1),
        request.replacen('{', "{\"releaseAuthority\":true,", 1),
    ] {
        fs::write(&input, changed).unwrap();
        let output = Command::new(env!("CARGO_BIN_EXE_hepta-paper-rust"))
            .args(["release-attest", input.to_str().unwrap()])
            .output()
            .unwrap();
        assert!(!output.status.success());
        assert!(output.stdout.is_empty());
        let error = String::from_utf8_lossy(&output.stderr);
        assert!(
            error.contains("duplicate field") || error.contains("unknown field"),
            "{error}"
        );
    }
    fs::remove_file(input).unwrap();
}

#[test]
fn actual_source_snapshot_and_provenance_match_node_for_development_finalized_and_tagged_states() {
    for state in ["development", "finalized", "released"] {
        let fixture = Fixture::new(state);
        // Locale ordering differs from byte order; the incumbent snapshot's
        // qualified en-US order remains part of the asserted snapshot hash.
        for tag in ["xA", "xa", "xé", "xe", "x\u{e000}", "x\u{10000}"] {
            fixture.git(&["tag", tag]);
        }
        let expected = fixture.oracle();
        let request = fixture.request();
        let report = inspect_release_attestation_source_v2(request.clone()).unwrap();
        assert_eq!(
            report["nativeSourceCapture"]["codeProvenance"],
            expected["provenance"]
        );
        assert_eq!(
            report["nativeSourceCapture"]["releaseStateSnapshot"],
            expected["snapshot"]
        );
        assert_eq!(
            report["nativeSourceCapture"]["treeBlobAndModeBindingVerified"],
            true
        );
        assert_eq!(report["sourceBound"], true);
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
            assert_eq!(report[flag], false, "{flag}");
        }
        assert_eq!(
            inspect_release_attestation_source_v2(request).unwrap(),
            report
        );
    }
}
#[test]
fn source_capture_rejects_dirty_wrong_subject_and_forged_projections() {
    let fixture = Fixture::new("development");
    let base = fixture.request();
    for field in [
        "expectedCommit",
        "expectedTree",
        "expectedReleaseStateSnapshotHash",
        "gitExecutableSha256",
    ] {
        let mut json = serde_json::to_value(&base).unwrap();
        json[field] = json!(if field.ends_with("Hash") || field.ends_with("Sha256") {
            format!("sha256:{}", "a".repeat(64))
        } else {
            "a".repeat(40)
        });
        assert!(!refused(serde_json::from_value(json).unwrap()).is_empty());
    }
    for field in [
        "releaseState",
        "releaseTrustGate",
        "codeProvenance",
        "implementationVerified",
        "arguments",
    ] {
        let mut json = serde_json::to_value(&base).unwrap();
        json[field] = json!({"ready":true});
        assert!(serde_json::from_value::<ReleaseAttestationSourceRequestV2>(json).is_err());
    }
    fs::write(fixture.root.join("source.txt"), "changed-source!\n").unwrap();
    assert!(refused(base).contains("tracked_bytes_mismatch"));
}
#[test]
fn source_capture_refuses_index_ignore_flags_and_core_worktree_redirection() {
    for flag in ["--assume-unchanged", "--skip-worktree"] {
        let fixture = Fixture::new("development");
        let request = fixture.request();
        fixture.git(&["update-index", flag, "source.txt"]);
        fs::write(fixture.root.join("source.txt"), "hidden-change!!\n").unwrap();
        assert!(refused(request).contains("index_ignore_flags_forbidden"));
    }
    let fixture = Fixture::new("development");
    let request = fixture.request();
    let redirect = fixture.root.with_extension("redirect");
    fs::create_dir(&redirect).unwrap();
    fixture.git(&["config", "core.worktree", redirect.to_str().unwrap()]);
    assert!(refused(request).contains("worktree_redirection"));
    fs::remove_dir(redirect).unwrap();
}
#[test]
fn raw_tree_bytes_and_modes_refuse_stat_cache_and_filemode_hiding() {
    let fixture = Fixture::new("development");
    let request = fixture.request();
    let path = fixture.root.join("source.txt");
    let original = std::time::SystemTime::now() - Duration::from_secs(10);
    fs::File::options()
        .write(true)
        .open(&path)
        .unwrap()
        .set_times(fs::FileTimes::new().set_modified(original))
        .unwrap();
    fixture.git(&["update-index", "--refresh"]);
    fixture.git(&["config", "core.trustctime", "false"]);
    fixture.git(&["config", "core.checkStat", "minimal"]);
    fs::write(&path, b"modified-source\n").unwrap();
    fs::File::options()
        .write(true)
        .open(&path)
        .unwrap()
        .set_times(fs::FileTimes::new().set_modified(original))
        .unwrap();
    assert!(
        fixture.git(&["status", "--porcelain=v1"]).is_empty(),
        "adversarial fixture must defeat ordinary status"
    );
    assert!(refused(request).contains("tracked_bytes_mismatch"));
    let fixture = Fixture::new("development");
    let request = fixture.request();
    fixture.git(&["config", "core.filemode", "false"]);
    fs::set_permissions(
        fixture.root.join("source.txt"),
        fs::Permissions::from_mode(0o755),
    )
    .unwrap();
    assert!(fixture.git(&["status", "--porcelain=v1"]).is_empty());
    assert!(refused(request).contains("tracked_mode_mismatch"));
}
#[test]
fn source_capture_refuses_replace_refs_symlinks_and_oversize_reads() {
    let fixture = Fixture::new("development");
    fixture.commit();
    let request = fixture.request();
    fixture.git(&["replace", "HEAD", "HEAD^"]);
    assert!(refused(request).contains("replace_refs_forbidden"));
    let fixture = Fixture::new("development");
    let request = fixture.request();
    let release = fixture.root.join("RELEASE.md");
    fs::rename(&release, fixture.root.join(".git/outside.md")).unwrap();
    symlink(".git/outside.md", &release).unwrap();
    assert!(refused(request).contains("tracked_mode_mismatch"));
    let fixture = Fixture::new("development");
    let request = fixture.request();
    fs::rename(
        fixture.root.join("paper-core"),
        fixture.root.join(".git/outside-core"),
    )
    .unwrap();
    symlink(".git/outside-core", fixture.root.join("paper-core")).unwrap();
    let message = refused(request);
    assert!(
        message.contains("directory_symlink_or_invalid") || message.contains("untracked_source"),
        "{message}"
    );
    let fixture = Fixture::new("development");
    fs::File::create(fixture.root.join("large.bin"))
        .unwrap()
        .set_len(33 * 1024 * 1024)
        .unwrap();
    fixture.commit();
    let request = fixture.request();
    assert!(refused(request).contains("file_budget_exceeded"));
}
#[test]
fn corrupted_loose_blob_cannot_rebind_hidden_bytes_to_the_original_tree() {
    let fixture = Fixture::new("development");
    let path = fixture.root.join("source.txt");
    let original = std::time::SystemTime::now() - Duration::from_secs(10);
    fs::File::options()
        .write(true)
        .open(&path)
        .unwrap()
        .set_times(fs::FileTimes::new().set_modified(original))
        .unwrap();
    fixture.git(&["update-index", "--refresh"]);
    let request = fixture.request();
    let oid = String::from_utf8(fixture.git(&["rev-parse", "HEAD:source.txt"]))
        .unwrap()
        .trim()
        .to_owned();
    fixture.git(&["config", "core.trustctime", "false"]);
    fixture.git(&["config", "core.checkStat", "minimal"]);
    fs::write(&path, b"modified-source\n").unwrap();
    fs::File::options()
        .write(true)
        .open(&path)
        .unwrap()
        .set_times(fs::FileTimes::new().set_modified(original))
        .unwrap();
    let object = fixture
        .root
        .join(".git/objects")
        .join(&oid[..2])
        .join(&oid[2..]);
    fs::set_permissions(&object, fs::Permissions::from_mode(0o600)).unwrap();
    let output = Command::new("node").args(["--eval", "const fs=require('node:fs'),z=require('node:zlib');const content=fs.readFileSync(process.argv[1]);fs.writeFileSync(process.argv[2],z.deflateSync(Buffer.concat([Buffer.from('blob '+content.length),Buffer.from([0]),content])));" ]).arg(&path).arg(object).output().unwrap();
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    assert_eq!(
        fixture.git(&["cat-file", "blob", &oid]),
        b"modified-source\n"
    );
    assert!(fixture.git(&["status", "--porcelain=v1"]).is_empty());
    assert!(refused(request).contains("tree_object_integrity_failed"));
}

#[test]
fn source_capture_refuses_config_that_can_disable_integrity_or_enable_lazy_fetch() {
    for (key, value) in [
        ("fsck.missingEmail", "ignore"),
        ("remote.origin.promisor", "true"),
        ("include.path", "/definitely/missing/source-include"),
    ] {
        for worktree_config in [false, true] {
            let fixture = Fixture::new("development");
            let request = fixture.request();
            if worktree_config {
                fixture.git(&["config", "extensions.worktreeConfig", "true"]);
                fixture.git(&["config", "--worktree", key, value]);
            } else {
                fixture.git(&["config", key, value]);
            }
            assert!(refused(request).contains("git_configuration_can_bypass_integrity_or_fetch"));
        }
    }
}

fn blocked_git_pid(root: &Path) -> Option<u32> {
    for entry in fs::read_dir("/proc").ok()?.flatten() {
        let Some(pid) = entry
            .file_name()
            .to_str()
            .and_then(|v| v.parse::<u32>().ok())
        else {
            continue;
        };
        if fs::read_link(entry.path().join("cwd")).ok().as_deref() == Some(root)
            && fs::read(entry.path().join("cmdline"))
                .ok()
                .is_some_and(|v| v.windows(8).any(|v| v == b"ls-files"))
        {
            return Some(pid);
        }
    }
    None
}
#[test]
fn cancellation_and_deadline_reap_a_real_blocked_git_group_and_allow_clean_retry() {
    for cancel in [true, false] {
        let fixture = Fixture::new("development");
        let mut request = fixture.request();
        request.timeout_ms = if cancel { 10_000 } else { 1500 };
        let index = fixture.root.join(".git/index");
        let saved = fixture.root.join(".git/index.saved");
        fs::rename(&index, &saved).unwrap();
        nix::unistd::mkfifo(&index, nix::sys::stat::Mode::from_bits_truncate(0o600)).unwrap();
        let cancelled = Arc::new(AtomicBool::new(false));
        let worker = Arc::clone(&cancelled);
        let handle = std::thread::spawn(move || {
            inspect_release_attestation_source_with_cancellation_v2(request, &worker)
        });
        let start = Instant::now();
        let pid = loop {
            if let Some(pid) = blocked_git_pid(&fixture.root) {
                break pid;
            }
            assert!(
                start.elapsed() < Duration::from_secs(5),
                "real blocked Git must appear"
            );
            std::thread::sleep(Duration::from_millis(10));
        };
        if cancel {
            cancelled.store(true, Ordering::Release);
        }
        let message = handle.join().unwrap().unwrap_err().to_string();
        assert!(
            message.contains(if cancel {
                "cancelled"
            } else {
                "deadline_exceeded"
            }),
            "{message}"
        );
        assert!(
            !PathBuf::from(format!("/proc/{pid}")).exists(),
            "owned Git group must be reaped"
        );
        fs::remove_file(index).unwrap();
        fs::rename(saved, fixture.root.join(".git/index")).unwrap();
        assert_eq!(
            inspect_release_attestation_source_v2(fixture.request()).unwrap()["sourceBound"],
            true
        );
    }
}
