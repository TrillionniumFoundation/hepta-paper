//! Synthetic isolated verifiers test real Ed25519 and subprocess/SQLite behavior;
//! no production rebuild, external authority, or image publication is performed.
use hepta_paper_service::runtime_image_reproducibility::*;
use serde_json::{Value, json};
use std::{
    collections::BTreeMap,
    fs,
    io::Write,
    os::unix::fs::{MetadataExt, PermissionsExt, symlink},
    path::{Path, PathBuf},
    process::{Command, Stdio},
    time::Instant,
};
fn oracle(input: Value) -> Value {
    let root = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../..");
    let node = std::env::var("HEPTA_TEST_NODE").unwrap_or_else(|_| "node".into());
    let mut child = Command::new(node)
        .arg(root.join("rust/oracle/runtime-image-reproducibility-v2.mjs"))
        .current_dir(root)
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
    let out = child.wait_with_output().unwrap();
    assert!(
        out.status.success(),
        "{}",
        String::from_utf8_lossy(&out.stderr)
    );
    serde_json::from_slice(&out.stdout).unwrap()
}
struct Fixture {
    data: Value,
    root: PathBuf,
    keys: Vec<String>,
}
impl Fixture {
    fn new(scenario: &str) -> Self {
        let data = oracle(json!({"operation":"fixture","scenario":scenario}));
        assert_eq!(
            data["oracleRuntime"], "v22.23.1",
            "use pinned oracle runtime"
        );
        let root = PathBuf::from(data["root"].as_str().unwrap());
        let keys = data["publicKeys"]
            .as_array()
            .unwrap()
            .iter()
            .map(|k| k.as_str().unwrap().to_owned())
            .collect();
        Self { data, root, keys }
    }
    fn context(&self) -> ReceiptVerificationContext<'_> {
        ReceiptVerificationContext {
            now: "2026-07-16T08:00:45.000Z",
            current_code_provenance_hash: self.data["request"]["codeProvenanceHash"]
                .as_str()
                .unwrap(),
            current_release_identity_hash: self.data["request"]["releaseIdentityHash"]
                .as_str()
                .unwrap(),
            current_inputs: &self.data["inputs"],
            configuration: &self.data["configuration"],
            profile_policies: &self.data["profilePolicies"],
            active_plugin_scope: &self.data["scope"],
            public_keys: &self.keys,
        }
    }
    fn configuration(&self) -> ProcessConfiguration {
        read_runtime_image_reproducibility_process_configuration_v1(
            Path::new(self.data["configPath"].as_str().unwrap()),
            Some(
                self.data["configuration"]["configurationIdentityHash"]
                    .as_str()
                    .unwrap(),
            ),
            &self.data["environment"],
        )
        .unwrap()
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        fs::remove_dir_all(&self.root).unwrap();
    }
}
// Snapshot file bytes and identities while ignoring access times changed by reads.
type FileSnapshot = BTreeMap<PathBuf, (Vec<u8>, u32, u64, i64, i64)>;
fn files(root: &Path) -> FileSnapshot {
    let mut out = BTreeMap::new();
    fn walk(p: &Path, out: &mut FileSnapshot) {
        for e in fs::read_dir(p).unwrap() {
            let p = e.unwrap().path();
            let st = fs::symlink_metadata(&p).unwrap();
            if st.is_dir() {
                walk(&p, out)
            } else if st.is_file() {
                out.insert(
                    p.clone(),
                    (
                        fs::read(p).unwrap(),
                        st.mode(),
                        st.ino(),
                        st.mtime(),
                        st.mtime_nsec(),
                    ),
                );
            }
        }
    }
    walk(root, &mut out);
    out
}
#[test]
fn request_scope_context_crypto_and_configuration_match_real_node_algorithms() {
    let f = Fixture::new("valid");
    let before = files(&f.root);
    let scope = runtime_image_reproducibility_active_plugin_scope_v1(
        &f.data["pluginPackage"],
        &f.data["registry"],
        &f.data["startup"],
    )
    .unwrap();
    assert_eq!(scope, f.data["scope"]);
    for (i, p) in ["python", "pythonGpu", "r"].iter().enumerate() {
        let actual =
            inspect_runtime_image_build_input_closure_v1(&f.root, &f.data["definitions"][*p])
                .unwrap();
        assert_eq!(actual, f.data["inputs"][i]);
    }
    let request =
        build_runtime_image_reproducibility_request_v2(&f.data["options"], &scope).unwrap();
    assert_eq!(request, f.data["request"]);
    let config = f.configuration();
    assert_eq!(config.identity, f.data["configuration"]);
    assert_eq!(config.public_keys, f.keys);
    let receipt = build_runtime_image_reproducibility_receipt_v2(
        &request,
        &f.data["responses"],
        "2026-07-16T08:00:45.000Z",
        "2026-07-17T08:00:45.000Z",
        &scope,
    )
    .unwrap();
    assert_eq!(receipt, f.data["receipt"]);
    assert_eq!(
        verify_runtime_image_reproducibility_receipt_v2(&receipt, &f.context()).unwrap(),
        f.data["expected"]
    );
    assert_eq!(files(&f.root), before);
}
#[test]
fn signed_invalid_oci_proof_and_signature_mutations_match_node_rejections() {
    for scenario in ["oci-mismatch", "invalid-proof"] {
        let f = Fixture::new(scenario);
        let report =
            verify_runtime_image_reproducibility_receipt_v2(&f.data["receipt"], &f.context())
                .unwrap();
        assert_eq!(report["ready"], false);
        assert_eq!(report, f.data["expected"]);
    }
    let f = Fixture::new("valid");
    let paths = [
        "/responses/0/signature",
        "/responses/1/nonce",
        "/responses/0/profileResults/0/contextTarMetadataPolicyApplied",
        "/responses/1/signer/revokedAt",
        "/request/inputs/0/image",
        "/responseHashes/0",
        "/issuedAt",
        "/expiresAt",
    ];
    for path in paths {
        let mut receipt = f.data["receipt"].clone();
        *receipt.pointer_mut(path).unwrap() = json!("tampered");
        let rust = verify_runtime_image_reproducibility_receipt_v2(&receipt, &f.context()).unwrap();
        let node = oracle(json!({"operation":"inspect","fixture":f.data,"receipt":receipt}));
        assert_eq!(rust, node, "{path}");
        assert_eq!(rust["ready"], false);
    }
    let mut receipt = f.data["receipt"].clone();
    receipt["unexpected"] = true.into();
    assert_eq!(
        verify_runtime_image_reproducibility_receipt_v2(&receipt, &f.context()).unwrap()["ready"],
        false
    );
}
#[test]
fn time_current_inputs_trust_and_source_policy_drift_are_rechecked() {
    let f = Fixture::new("valid");
    for now in ["2026-07-16T08:00:44.999Z", "2026-07-17T08:00:45.000Z"] {
        let mut c = f.context();
        c.now = now;
        let rust = verify_runtime_image_reproducibility_receipt_v2(&f.data["receipt"], &c).unwrap();
        assert_eq!(
            rust,
            oracle(
                json!({"operation":"inspect","fixture":f.data,"receipt":f.data["receipt"],"overrides":{"now":now}})
            )
        );
    }
    let mut c = f.context();
    c.current_code_provenance_hash =
        "sha256:0000000000000000000000000000000000000000000000000000000000000000";
    assert_eq!(
        verify_runtime_image_reproducibility_receipt_v2(&f.data["receipt"], &c).unwrap()["ready"],
        false
    );
    let inputs = json!([]);
    c = f.context();
    c.current_inputs = &inputs;
    assert_eq!(
        verify_runtime_image_reproducibility_receipt_v2(&f.data["receipt"], &c).unwrap()["ready"],
        false
    );
    let mut configuration = f.data["configuration"].clone();
    configuration["verifiers"][0]["signer"]["revokedAt"] = json!("2026-07-16T07:00:00.000Z");
    c = f.context();
    c.configuration = &configuration;
    assert_eq!(
        verify_runtime_image_reproducibility_receipt_v2(&f.data["receipt"], &c).unwrap()["ready"],
        false
    );
    let policies = json!({});
    c = f.context();
    c.profile_policies = &policies;
    let report = verify_runtime_image_reproducibility_receipt_v2(&f.data["receipt"], &c).unwrap();
    assert_eq!(report["blockers"].as_array().unwrap().len(), 3);
}
#[test]
fn actual_isolated_verifier_subprocesses_return_signed_attestations_read_only() {
    let f = Fixture::new("valid");
    let config = f.configuration();
    let before = files(&f.root);
    let responses =
        invoke_runtime_image_reproducibility_verifiers_v1(&config, &f.data["request"]).unwrap();
    assert_eq!(responses, f.data["responses"]);
    assert_eq!(files(&f.root), before);
}
#[test]
fn subprocess_timeout_nonzero_duplicate_json_and_output_limits_fail_closed() {
    for scenario in ["timeout", "exit", "duplicate", "oversize"] {
        let f = Fixture::new(scenario);
        let config = f.configuration();
        let before = files(&f.root);
        let started = Instant::now();
        assert!(
            invoke_runtime_image_reproducibility_verifiers_v1(&config, &f.data["request"]).is_err(),
            "{scenario}"
        );
        assert!(
            started.elapsed().as_secs() < 60,
            "{scenario}: includes rehashing both pinned interpreters before the command deadline starts"
        );
        assert_eq!(files(&f.root), before);
    }
}
#[test]
fn escaped_session_pipe_holders_fail_without_waiting_for_their_lifetime() {
    let fixture = Fixture::new("escaped-pipes");
    let configuration = fixture.configuration();
    let before = files(&fixture.root);
    let started = Instant::now();
    assert!(
        invoke_runtime_image_reproducibility_verifiers_v1(&configuration, &fixture.data["request"])
            .is_err()
    );
    assert!(
        started.elapsed().as_secs_f64() < 4.0,
        "escaped descriptors kept process IO alive"
    );
    assert_eq!(files(&fixture.root), before);
}
#[test]
fn command_credential_and_context_changes_are_rejected_before_execution() {
    let f = Fixture::new("valid");
    let config = f.configuration();
    fs::write(f.root.join("credentials-1/identity"), b"changed credential").unwrap();
    assert!(
        invoke_runtime_image_reproducibility_verifiers_v1(&config, &f.data["request"]).is_err()
    );
    let f = Fixture::new("valid");
    let file = f.root.join("context-python/requirements.lock");
    fs::write(&file, b"mutated input").unwrap();
    assert!(
        inspect_runtime_image_build_input_closure_v1(&f.root, &f.data["definitions"]["python"])
            .is_err()
    );
    let f = Fixture::new("valid");
    let file = f.root.join("context-python/requirements.lock");
    fs::rename(&file, f.root.join("moved-lock")).unwrap();
    symlink(f.root.join("moved-lock"), &file).unwrap();
    assert!(
        inspect_runtime_image_build_input_closure_v1(&f.root, &f.data["definitions"]["python"])
            .is_err()
    );
    let f = Fixture::new("valid");
    let file = f.root.join("context-python/requirements.lock");
    fs::hard_link(&file, f.root.join("alias-lock")).unwrap();
    assert!(
        inspect_runtime_image_build_input_closure_v1(&f.root, &f.data["definitions"]["python"])
            .is_err()
    );
}
#[test]
fn offline_sqlite_authority_readonly_status_and_crash_recovery_are_real() {
    let f = Fixture::new("valid");
    let receipt_path = f.root.join("published-receipt.json");
    assert!(
        read_runtime_image_reproducibility_publication_v2(&receipt_path, &f.context())
            .unwrap()
            .is_none()
    );
    let publication = publish_runtime_image_reproducibility_offline_v2(
        &receipt_path,
        &f.data["receipt"],
        &f.context(),
    )
    .unwrap();
    assert_eq!(publication["publicationGeneration"], 1);
    assert_eq!(publication["crossResourceAtomicPublicationClaimed"], false);
    assert!(publication["mirrorSideEffectPermitHash"].is_null());
    let before = files(&f.root);
    let status = read_runtime_image_reproducibility_publication_v2(&receipt_path, &f.context())
        .unwrap()
        .unwrap();
    assert_eq!(status["inspection"]["ready"], true);
    assert_eq!(files(&f.root), before);
    // Simulate a crash after authority commit and before mirror publication.
    fs::remove_file(&receipt_path).unwrap();
    let before = files(&f.root);
    assert!(
        read_runtime_image_reproducibility_publication_v2(&receipt_path, &f.context()).is_err()
    );
    assert_eq!(files(&f.root), before);
    let recovered = publish_runtime_image_reproducibility_offline_v2(
        &receipt_path,
        &f.data["receipt"],
        &f.context(),
    )
    .unwrap();
    assert_eq!(recovered["publicationGeneration"], 2);
    assert_eq!(
        read_runtime_image_reproducibility_publication_v2(&receipt_path, &f.context())
            .unwrap()
            .unwrap()["inspection"]["ready"],
        true
    );
    let before = files(&f.root);
    let mut context = f.context();
    context.now = "2026-07-17T08:00:45.000Z";
    assert_eq!(
        read_runtime_image_reproducibility_publication_v2(&receipt_path, &context)
            .unwrap()
            .unwrap()["inspection"]["ready"],
        false
    );
    assert!(
        publish_runtime_image_reproducibility_offline_v2(
            &receipt_path,
            &f.data["receipt"],
            &context
        )
        .is_err()
    );
    assert_eq!(files(&f.root), before);
}
#[test]
fn invalid_publish_has_no_writes_and_duplicate_json_is_rejected() {
    let f = Fixture::new("invalid-proof");
    let before = files(&f.root);
    assert!(
        publish_runtime_image_reproducibility_offline_v2(
            &f.root.join("absent.json"),
            &f.data["receipt"],
            &f.context()
        )
        .is_err()
    );
    assert_eq!(files(&f.root), before);
    let path = f.root.join("duplicate.json");
    fs::write(&path, b"{\"version\":1,\"version\":2}").unwrap();
    fs::set_permissions(&path, fs::Permissions::from_mode(0o600)).unwrap();
    assert!(read_runtime_image_reproducibility_json_v1(&path).is_err());
}

#[test]
fn publication_rejects_path_aliases_before_creation_and_generation_overflow() {
    let f = Fixture::new("valid");
    let relative = PathBuf::from("runtime-image-relative-parent-must-not-exist/receipt.json");
    assert!(!relative.parent().unwrap().exists());
    assert!(
        publish_runtime_image_reproducibility_offline_v2(
            &relative,
            &f.data["receipt"],
            &f.context()
        )
        .is_err()
    );
    assert!(!relative.parent().unwrap().exists());
    fs::create_dir(f.root.join("real-parent")).unwrap();
    symlink(f.root.join("real-parent"), f.root.join("alias-parent")).unwrap();
    assert!(
        publish_runtime_image_reproducibility_offline_v2(
            &f.root.join("alias-parent/new-parent/receipt.json"),
            &f.data["receipt"],
            &f.context()
        )
        .is_err()
    );
    assert!(!f.root.join("real-parent/new-parent").exists());
    let path = f.root.join("overflow-receipt.json");
    publish_runtime_image_reproducibility_offline_v2(&path, &f.data["receipt"], &f.context())
        .unwrap();
    let db = rusqlite::Connection::open(format!("{}.publication.sqlite", path.display())).unwrap();
    db.execute(
        "UPDATE runtime_image_reproducibility_receipt SET publication_generation=?1",
        [i64::MAX],
    )
    .unwrap();
    drop(db);
    let before = files(&f.root);
    assert_eq!(
        publish_runtime_image_reproducibility_offline_v2(&path, &f.data["receipt"], &f.context())
            .unwrap_err()
            .to_string(),
        "runtime_reproducibility_receipt_generation_exhausted"
    );
    assert_eq!(files(&f.root), before);
}

#[test]
fn publication_cas_rejects_previously_valid_older_receipt_without_mutation() {
    let f = Fixture::new("valid");
    let path = f.root.join("cas-receipt.json");
    let newer = build_runtime_image_reproducibility_receipt_v2(
        &f.data["request"],
        &f.data["responses"],
        "2026-07-16T08:00:46.000Z",
        "2026-07-17T08:00:46.000Z",
        &f.data["scope"],
    )
    .unwrap();
    let mut context = f.context();
    context.now = "2026-07-16T08:00:46.000Z";
    publish_runtime_image_reproducibility_offline_v2(&path, &newer, &context).unwrap();
    let before = files(&f.root);
    let error =
        publish_runtime_image_reproducibility_offline_v2(&path, &f.data["receipt"], &context)
            .unwrap_err();
    assert_eq!(
        error.to_string(),
        "runtime_reproducibility_receipt_monotonic_cas_rejected"
    );
    assert_eq!(files(&f.root), before);
}
#[test]
fn current_release_binding_tracks_actual_git_and_uncommitted_source_bytes() {
    let f = Fixture::new("valid");
    let root = f.root.join("source");
    fs::create_dir(&root).unwrap();
    fs::write(root.join("package.json"), b"{\"version\":\"1.2.3\"}\n").unwrap();
    fs::write(root.join("source.rs"), b"first source\n").unwrap();
    for args in [
        vec!["init", "--quiet"],
        vec!["add", "package.json", "source.rs"],
        vec![
            "-c",
            "user.name=Isolated Test",
            "-c",
            "user.email=isolated@example.invalid",
            "commit",
            "--quiet",
            "-m",
            "fixture",
        ],
    ] {
        assert!(
            Command::new("git")
                .args(args)
                .current_dir(&root)
                .status()
                .unwrap()
                .success()
        );
    }
    let before = current_runtime_image_release_binding_v1(&root).unwrap();
    assert_eq!(before, oracle(json!({"operation":"release","root":root})));
    assert_eq!(before["codeProvenance"]["treeDirty"], false);
    fs::write(root.join("source.rs"), b"changed source\n").unwrap();
    let after = current_runtime_image_release_binding_v1(&root).unwrap();
    assert_eq!(after, oracle(json!({"operation":"release","root":root})));
    assert_eq!(after["codeProvenance"]["treeDirty"], true);
    assert_ne!(before["releaseIdentityHash"], after["releaseIdentityHash"]);
    assert_ne!(before["codeProvenanceHash"], after["codeProvenanceHash"]);
}

#[test]
fn env_shebang_pins_actual_path_selected_node_interpreter() {
    let f = Fixture::new("env-interpreter");
    let config = f.configuration();
    assert_eq!(config.identity, f.data["configuration"]);
    let mut env = f.data["environment"].clone();
    env["PATH"] = json!("");
    assert!(
        read_runtime_image_reproducibility_process_configuration_v1(
            Path::new(f.data["configPath"].as_str().unwrap()),
            Some(
                f.data["configuration"]["configurationIdentityHash"]
                    .as_str()
                    .unwrap()
            ),
            &env
        )
        .is_err()
    );
}

#[test]
fn builtin_plugin_raw_sources_recompile_and_verify_real_repository_signature() {
    let fixture = Fixture::new("valid");
    let actual =
        resolve_runtime_image_plugin_authority_v1(&json!({}), "2026-07-16T08:00:45.000Z").unwrap();
    assert_eq!(actual.package, fixture.data["pluginPackage"]);
    assert_eq!(actual.registry, fixture.data["registry"]);
    assert_eq!(actual.startup_inspection, fixture.data["startup"]);
    assert_eq!(actual.scope, fixture.data["scope"]);
    assert!(
        resolve_runtime_image_plugin_authority_v1(&json!({}), "2100-01-01T00:00:00.000Z").is_err()
    );
    let repository =
        fs::canonicalize(PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../..")).unwrap();
    verify_runtime_image_builtin_plugin_source_binding_v1(&repository).unwrap();
}

#[test]
fn external_plugin_signature_lifetime_role_and_package_bindings_are_recomputed() {
    for scenario in [
        "valid",
        "subset",
        "expired",
        "wrong-role",
        "tamper-signature",
        "tamper-package",
        "inactive-key",
    ] {
        let fixture = Fixture::new("valid");
        let node =
            oracle(json!({"operation":"external-plugin","root":fixture.root,"scenario":scenario}));
        let before = files(&fixture.root);
        let result = resolve_runtime_image_plugin_authority_v1(
            &node["environment"],
            "2026-07-16T08:00:45.000Z",
        );
        if node["expected"]["error"].is_null() {
            let actual = result.unwrap();
            assert_eq!(actual.package, node["expected"]["package"], "{scenario}");
            assert_eq!(actual.registry, node["expected"]["registry"]);
            assert_eq!(
                actual.startup_inspection,
                node["expected"]["startupInspection"]
            );
            if scenario == "subset" {
                assert_eq!(
                    actual.scope["requiredProfiles"],
                    json!(["python", "pythonGpu"])
                );
            }
        } else {
            assert!(result.is_err(), "{scenario}");
        }
        assert_eq!(files(&fixture.root), before);
    }
}

#[test]
fn full_cli_request_verify_publish_status_with_dynamic_signed_scope_and_real_test_processes() {
    let fixture = Fixture::new("valid");
    let plugin =
        oracle(json!({"operation":"external-plugin","root":fixture.root,"scenario":"subset"}));
    let setup = oracle(
        json!({"operation":"workflow","root":fixture.root,"environment":plugin["environment"]}),
    );
    let invoke = |action: &str| {
        let mut cmd = Command::new(env!("CARGO_BIN_EXE_hepta-runtime-image-reproducibility"));
        cmd.args([
            "--action",
            action,
            "--root",
            setup["root"].as_str().unwrap(),
            "--config",
            setup["configPath"].as_str().unwrap(),
            "--runtime-root",
            setup["runtimeRoot"].as_str().unwrap(),
        ])
        .env_clear();
        for (k, v) in setup["environment"].as_object().unwrap() {
            cmd.env(k, v.as_str().unwrap());
        }
        let output = cmd.output().unwrap();
        assert!(
            output.status.success(),
            "{action}: {}",
            String::from_utf8_lossy(&output.stderr)
        );
        serde_json::from_slice::<Value>(&output.stdout).unwrap()
    };
    let before = files(&fixture.root);
    let request = invoke("request");
    assert_eq!(
        request["request"]["requiredProfiles"],
        json!(["python", "pythonGpu"])
    );
    assert_eq!(request["externalActionPerformed"], false);
    assert_eq!(files(&fixture.root), before);
    let verified = invoke("verify");
    assert_eq!(verified["ready"], true);
    assert_eq!(verified["externalActionPerformed"], true);
    assert_eq!(files(&fixture.root), before);
    let published = invoke("publish");
    assert_eq!(published["ready"], true);
    assert_eq!(published["publication"]["publicationGeneration"], 1);
    assert!(published["publication"]["mirrorSideEffectPermitHash"].is_null());
    let before = files(&fixture.root);
    let status = invoke("status");
    assert_eq!(status["ready"], true);
    assert_eq!(status["externalActionPerformed"], false);
    assert_eq!(files(&fixture.root), before);
}

#[test]
fn cli_missing_configuration_is_readonly_blocked_and_flag_errors_match_node() {
    let root =
        fs::canonicalize(PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../..")).unwrap();
    let node = std::env::var("HEPTA_TEST_NODE").unwrap_or_else(|_| "node".into());
    let invoke = |native: bool, args: &[&str]| {
        let mut command = Command::new(if native {
            env!("CARGO_BIN_EXE_hepta-runtime-image-reproducibility")
        } else {
            &node
        });
        if !native {
            command.arg(root.join("paper-core/bin/runtime-image-reproducibility.mjs"));
        }
        command
            .args(args)
            .current_dir(&root)
            .env_remove("HEPTA_RUNTIME_IMAGE_REPRODUCIBILITY_CONFIG")
            .env_remove("HEPTA_RUNTIME_IMAGE_REPRODUCIBILITY_CONFIG_HASH")
            .env_remove("HEPTA_AUTONOMOUS_EMPIRICAL_PLUGIN_BUNDLE")
            .env_remove("HEPTA_AUTONOMOUS_EMPIRICAL_PLUGIN_TRUST_STORE")
            .output()
            .unwrap()
    };
    let native_help = invoke(true, &["--help"]);
    let incumbent_help = invoke(false, &["--help"]);
    assert_eq!(native_help.status.code(), Some(0));
    assert_eq!(incumbent_help.status.code(), Some(0));
    assert_eq!(
        native_help.stdout, incumbent_help.stdout,
        "runtime image help wire contract"
    );
    let native = invoke(true, &[]);
    let incumbent = invoke(false, &[]);
    assert_eq!(native.status.code(), Some(2));
    assert_eq!(incumbent.status.code(), Some(2));
    assert_eq!(
        serde_json::from_slice::<Value>(&native.stdout).unwrap(),
        serde_json::from_slice::<Value>(&incumbent.stdout).unwrap()
    );
    for args in [
        vec!["--bad"],
        vec!["--"],
        vec!["one"],
        vec!["--action"],
        vec!["--action="],
        vec!["--help=true"],
        vec!["--config", "a", "--config", "b"],
        vec!["--action", "bogus"],
    ] {
        let native = invoke(true, &args);
        let incumbent = invoke(false, &args);
        assert_eq!(native.status.code(), Some(1));
        assert_eq!(incumbent.status.code(), Some(1));
        let error = String::from_utf8(native.stderr).unwrap();
        assert!(
            String::from_utf8_lossy(&incumbent.stderr).contains(error.trim()),
            "{args:?}: {error}"
        );
    }
}
