use super::*;
use crate::release_integrity_key::{
    LoadedReleaseIntegrityKeyV1, provision_local_release_integrity_key_v1,
};
use crate::release_replay::local_signature::verify_local_release_integrity_signature_v1;
use hepta_codex_runtime::{
    BoundedProcessRequestV1, EnvironmentPolicyV1, ProcessLimitsV1, ProcessTerminationReason,
    run_bounded_process_capturing_stdout_with_cancellation,
};
use std::{
    ffi::OsString,
    fs,
    os::unix::fs::{PermissionsExt, symlink},
    sync::atomic::AtomicU64,
    time::Duration,
};
static NEXT: AtomicU64 = AtomicU64::new(0);
struct Fixture {
    root: PathBuf,
    context: ReleaseIntegrityKeyContextV1,
}
impl Fixture {
    fn new() -> Self {
        let root = PathBuf::from("/tmp").join(format!(
            "hepta-release-evidence-rust-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ));
        fs::create_dir(&root).unwrap();
        fs::set_permissions(&root, fs::Permissions::from_mode(0o700)).unwrap();
        let context = ReleaseIntegrityKeyContextV1 {
            workspace_root: root.join("workspace"),
            runtime_root: root.join("runtime"),
            asset_root: root.join("assets"),
            legacy_root: root.join("legacy"),
            isolated: false,
        };
        fs::create_dir(&context.workspace_root).unwrap();
        fs::create_dir(&context.runtime_root).unwrap();
        fs::set_permissions(&context.runtime_root, fs::Permissions::from_mode(0o700)).unwrap();
        provision_local_release_integrity_key_v1(&context, true).unwrap();
        Self { root, context }
    }
    fn key(&self) -> LoadedReleaseIntegrityKeyV1 {
        load_existing_local_release_integrity_key_v1(&self.context, true).unwrap()
    }
    fn directory(&self) -> Directory {
        Directory::open_or_create(
            &self
                .context
                .runtime_root
                .join("legacy-retirement/deletion-drills"),
            true,
        )
        .unwrap()
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.root);
    }
}
fn payload() -> Value {
    let mut value = json!({"version":13,"kind":"ReleaseAttestationPolicyReplayInspection","status":"release_attestation_blocked","sourceBound":true,"releaseEvidenceReady":false,"physicalDeletionAllowed":false,"nodeRetirement":false,"externalActionPerformed":false,"nativeSourceCapture":{"version":2,"kind":"UnitSourceBindingOnlyNoQualification","commit":"test_source_a"},"matrixPolicyReplay":{"policyReplayComplete":false,"rustBehavioralSuiteMatchingComplete":false,"fullRestoredArchiveAndRuntimeReplayComplete":false,"fullRustProductImplementationClaimed":false},"wireCorpus":{"10":"integer-key-order","2":"integer-key-order","emoji":"🛰️","nul":"\u{0}","quote":"\"\\\n","small":1e-7,"large":1e21,"zero":0}});
    value["reportHash"] = json!(
        hepta_control_plane::canonical_hash_v1(&json!({"kind":value["kind"],"value":value}))
            .unwrap()
            .to_string()
    );
    value
}
fn signed(
    fixture: &Fixture,
) -> (
    Value,
    crate::release_replay::local_signature::LocalReleaseIntegritySignatureV1,
    Vec<u8>,
) {
    let p = payload();
    let (sig, wire) = sign_blocked_replay_diagnostic_v1(&p, &fixture.key()).unwrap();
    (p, sig, wire)
}
fn final_name(
    signature: &crate::release_replay::local_signature::LocalReleaseIntegritySignatureV1,
) -> String {
    format!(
        "NATIVE_BLOCKED_DRILL_v1_{}.json",
        signature.payload_hash.strip_prefix("sha256:").unwrap()
    )
}
fn recover(f: &Fixture, p: &Value) -> Result<Value, String> {
    recovery::recover(
        &f.directory(),
        &p["nativeSourceCapture"],
        &f.key(),
        &AtomicBool::new(false),
        Instant::now(),
    )
}
#[test]
fn actual_original_node_signature_matches_native_public_wire_and_pinned_verifier() {
    let f = Fixture::new();
    let (p, sig, wire) = signed(&f);
    let envelope: Value = serde_json::from_slice(&wire).unwrap();
    let manifest = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../..")
        .canonicalize()
        .unwrap();
    let node = std::env::split_paths(&std::env::var_os("PATH").unwrap())
        .map(|v| v.join("node"))
        .find(|v| v.is_file())
        .unwrap()
        .canonicalize()
        .unwrap();
    let env = EnvironmentPolicyV1::new(
        "release-signature-differential-v1",
        ["PATH", "LANG", "LC_ALL"],
        ["PATH", "LANG", "LC_ALL"],
    )
    .unwrap()
    .build(
        std::iter::empty::<(OsString, OsString)>(),
        &BTreeMap::from([
            ("PATH".into(), "/usr/bin:/bin".into()),
            ("LANG".into(), "C.UTF-8".into()),
            ("LC_ALL".into(), "C.UTF-8".into()),
        ]),
    )
    .unwrap();
    let request=BoundedProcessRequestV1{executable:node,arguments:vec![manifest.join("rust/oracle/native-release-signature-v1.mjs").into_os_string()],working_directory:manifest,environment:env,stdin:Some(serde_json::to_vec(&json!({"version":1,"kind":"NativeReleaseSignatureDifferentialRequest","runtimeRoot":f.context.runtime_root,"assetRoot":f.context.asset_root,"legacyRoot":f.context.legacy_root,"payload":envelope["payload"],"signature":sig})).unwrap())};
    let out = run_bounded_process_capturing_stdout_with_cancellation(
        &request,
        ProcessLimitsV1 {
            timeout_ms: 60_000,
            maximum_stdin_bytes: 65536,
            maximum_stdout_bytes: 65536,
            maximum_stderr_bytes: 65536,
            maximum_tail_bytes: 1024,
            ..ProcessLimitsV1::default()
        },
        &AtomicBool::new(false),
    )
    .unwrap();
    assert_eq!(
        out.process.termination_reason,
        ProcessTerminationReason::Exited
    );
    assert_eq!(
        out.process.exit_code,
        Some(0),
        "original Node signature owner failed"
    );
    assert!(out.process.process_group_cleanup_verified);
    let expected: Value = serde_json::from_slice(&out.stdout).unwrap();
    hepta_legacy_compatibility::qualify_production_node_profile_v1(&expected["profile"]).unwrap();
    assert_eq!(serde_json::to_value(&sig).unwrap(), expected["signature"]);
    assert_eq!(expected["nativeVerified"], true);
    verify_local_release_integrity_signature_v1(
        &p,
        &sig,
        &sig.public_key_pem,
        &sig.public_key_fingerprint,
    )
    .unwrap();
    assert!(
        !String::from_utf8(out.stdout)
            .unwrap()
            .contains("BEGIN PRIVATE KEY")
    );
}
#[test]
fn pending_recovery_completes_no_clobber_and_retries_without_authority_promotion() {
    let f = Fixture::new();
    let (p, sig, wire) = signed(&f);
    let dir = f.directory();
    let pending = format!(".pending-{}", "a".repeat(32));
    dir.write_new(&pending, &wire).unwrap();
    let first = recover(&f, &p).unwrap();
    assert_eq!(first["receipts"][0]["newNoClobberPublication"], true);
    assert_eq!(first["releaseEvidenceReady"], false);
    assert_eq!(first["nodeRetirement"], false);
    assert_eq!(fs::read(dir.path.join(final_name(&sig))).unwrap(), wire);
    assert_eq!(fs::read(dir.path.join(&pending)).unwrap(), wire);
    let second = recover(&f, &p).unwrap();
    assert_eq!(second["receipts"].as_array().unwrap().len(), 2);
    assert!(
        second["receipts"]
            .as_array()
            .unwrap()
            .iter()
            .all(|v| v["newNoClobberPublication"] == false)
    );
    assert!(!dir.path.join("CURRENT.json").exists());
    assert!(
        !f.context
            .runtime_root
            .join("release-evidence/CURRENT.json")
            .exists()
    );
}
#[test]
fn cancellation_deadline_and_namespace_refusals_preserve_pending_and_competing_bytes() {
    let f = Fixture::new();
    let (p, sig, wire) = signed(&f);
    let dir = f.directory();
    let pending = format!(".pending-{}", "b".repeat(32));
    dir.write_new(&pending, &wire).unwrap();
    let path = dir.path.join(final_name(&sig));
    for (cancelled, started) in [
        (true, Instant::now()),
        (
            false,
            Instant::now() - Duration::from_millis(TIMEOUT_MS + 1),
        ),
    ] {
        assert!(
            recovery::recover(
                &dir,
                &p["nativeSourceCapture"],
                &f.key(),
                &AtomicBool::new(cancelled),
                started
            )
            .is_err()
        );
        assert!(!path.exists());
        assert_eq!(fs::read(dir.path.join(&pending)).unwrap(), wire);
    }
    let rival = b"{\"competing\":\"preserve\"}";
    dir.write_new(&final_name(&sig), rival).unwrap();
    assert!(recover(&f, &p).is_err());
    assert_eq!(fs::read(&path).unwrap(), rival);
    assert_eq!(fs::read(dir.path.join(&pending)).unwrap(), wire);
}
#[test]
fn signed_receipt_tamper_stale_source_revoked_key_and_resource_budgets_fail_closed() {
    let f = Fixture::new();
    let (p, sig, wire) = signed(&f);
    let dir = f.directory();
    let name = final_name(&sig);
    dir.write_new(&name, &wire).unwrap();
    let other = Fixture::new();
    assert!(
        verify_local_release_integrity_signature_v1(
            &p,
            &sig,
            &other.key().public_key_pem,
            &other.key().public_key_fingerprint
        )
        .is_err()
    );
    let mut changed = p.clone();
    changed["nativeSourceCapture"]["commit"] = json!("test_source_b");
    assert!(
        recover(&f, &changed)
            .unwrap_err()
            .contains("source_or_scope_mismatch")
    );
    let mut forged = sig.clone();
    forged.authority_limit = "release_submission_authority".into();
    assert!(
        verify_local_release_integrity_signature_v1(
            &p,
            &forged,
            &sig.public_key_pem,
            &sig.public_key_fingerprint
        )
        .is_err()
    );
    let mut tampered = p.clone();
    tampered["wireCorpus"]["emoji"] = json!("changed");
    assert!(
        verify_local_release_integrity_signature_v1(
            &tampered,
            &sig,
            &sig.public_key_pem,
            &sig.public_key_fingerprint
        )
        .is_err()
    );
    let loaded = f.key();
    let public = f
        .context
        .runtime_root
        .join("release-signing/release-integrity-ed25519-public.pem");
    fs::set_permissions(&public, fs::Permissions::from_mode(0o644)).unwrap();
    assert!(loaded.assert_current().is_err());
    assert!(
        recovery::recover(
            &dir,
            &p["nativeSourceCapture"],
            &loaded,
            &AtomicBool::new(false),
            Instant::now()
        )
        .is_err()
    );
    assert_eq!(fs::read(dir.path.join(&name)).unwrap(), wire);
    let g = Fixture::new();
    let (gp, gs, gw) = signed(&g);
    let gd = g.directory();
    let target = gd.path.join(final_name(&gs));
    symlink(g.root.join("unrelated"), &target).unwrap();
    assert!(recover(&g, &gp).is_err());
    assert!(
        fs::symlink_metadata(&target)
            .unwrap()
            .file_type()
            .is_symlink()
    );
    fs::remove_file(target).unwrap();
    for i in 0..=16 {
        gd.write_new(&format!(".pending-{i:032x}"), &gw).unwrap();
    }
    assert!(
        recover(&g, &gp)
            .unwrap_err()
            .contains("receipt_count_budget")
    );
    let mut deep = json!(null);
    for _ in 0..40 {
        deep = json!([deep]);
    }
    assert!(
        verify_local_release_integrity_signature_v1(
            &deep,
            &gs,
            &gs.public_key_pem,
            &gs.public_key_fingerprint
        )
        .is_err()
    );
}
#[test]
fn canonical_release_attest_inserts_execute_and_refuses_every_forwarded_argument() {
    let v = |args: &[&str]| args.iter().map(|s| (*s).to_owned()).collect::<Vec<_>>();
    for args in [
        &["maintenance", "release-attest"][..],
        &["maintenance", "release-attest", "--"][..],
    ] {
        assert_eq!(
            crate::canonical_cli::resolve_canonical_cli_arguments_v1(&v(args)).unwrap(),
            Some(v(&["release-evidence", "--execute"]))
        );
    }
    for args in [
        &["maintenance", "release-attest", "--help"][..],
        &["maintenance", "release-attest", "--", "--help"][..],
        &["maintenance", "release-attest", "--", "--execute"][..],
        &["maintenance", "release-attest", "--", "--"][..],
    ] {
        assert!(crate::canonical_cli::resolve_canonical_cli_arguments_v1(&v(args)).is_err());
    }
    assert!(
        crate::canonical_cli::resolve_canonical_cli_arguments_v1(&v(&[
            "maintenance",
            "release-evidence"
        ]))
        .is_err()
    );
}

#[test]
fn producer_rejects_non_json_stable_typed_numbers_instead_of_silently_rewriting_signed_values() {
    let f = Fixture::new();
    let mut p = payload();
    p["wireCorpus"]["typedNegativeZero"] = json!(-0.0);
    p.as_object_mut().unwrap().remove("reportHash");
    p["reportHash"] = json!(
        hepta_control_plane::canonical_hash_v1(&json!({"kind":p["kind"],"value":p}))
            .unwrap()
            .to_string()
    );
    assert!(
        sign_blocked_replay_diagnostic_v1(&p, &f.key())
            .unwrap_err()
            .contains("payload_wire_value_changed")
    );
    assert!(!f.context.runtime_root.join("legacy-retirement").exists());
}

#[test]
fn ordinary_v3_profile_is_closed_and_refuses_old_versions_authority_and_unbound_inputs() {
    let f = Fixture::new();
    let path = f.context.workspace_root.join(PROFILE_PATH);
    fs::create_dir_all(path.parent().unwrap()).unwrap();
    let valid = json!({"version":3,"kind":"OrdinaryNativeReleaseReplayProfile","profile":"immutable_source_only_blocked_integrity_v3","nodeExecutable":"/qualified/node22/bin/node","nodeExecutableSha256":format!("sha256:{}", "a".repeat(64)),"archivePath":"/qualified/reference/archive.tar.gz","archiveSha256":"sha256:e431c4c7a51a15d64866b17a07c09dd17c15c32c8dddaccf1a769b1a5942cb9d"});
    fs::write(&path, serde_json::to_vec(&valid).unwrap()).unwrap();
    fs::set_permissions(&path, fs::Permissions::from_mode(0o644)).unwrap();
    assert_eq!(profile(&f.context.workspace_root).unwrap().0.version, 3);
    for (field, value) in [
        ("version", json!(1)),
        ("version", json!(2)),
        (
            "profile",
            json!("immutable_source_only_blocked_integrity_v1"),
        ),
        (
            "profile",
            json!("immutable_source_only_blocked_integrity_v2"),
        ),
        ("nodeExecutable", json!("relative/node")),
        (
            "nodeExecutableSha256",
            json!(format!("sha256:{}", "z".repeat(64))),
        ),
        ("archiveSha256", json!(format!("sha256:{}", "b".repeat(64)))),
        ("releaseAuthority", json!(true)),
        ("timeoutMs", json!(600001)),
    ] {
        let mut invalid = valid.clone();
        invalid[field] = value;
        fs::write(&path, serde_json::to_vec(&invalid).unwrap()).unwrap();
        assert!(
            profile(&f.context.workspace_root)
                .err()
                .unwrap()
                .contains("release_evidence_profile_invalid"),
            "{field}"
        );
        assert!(
            !f.context
                .runtime_root
                .join("legacy-retirement/deletion-drills")
                .exists()
        );
    }
    fs::write(&path, b"{\"version\":3,\"version\":3}").unwrap();
    assert!(
        profile(&f.context.workspace_root)
            .err()
            .unwrap()
            .contains("release_evidence_profile_invalid")
    );
}

#[test]
fn v13_recovery_preserves_and_refuses_predecessor_receipts_without_reinterpretation() {
    for version in [3, 10, 11, 12] {
        let f = Fixture::new();
        let key = f.key();
        let directory = f.directory();
        let mut old = payload();
        old.as_object_mut().unwrap().remove("reportHash");
        old["version"] = json!(version);
        old["reportHash"] = json!(
            hepta_control_plane::canonical_hash_v1(&json!({"kind":old["kind"],"value":old}))
                .unwrap()
                .to_string()
        );
        let (signature, wire) = sign_blocked_replay_diagnostic_v1(&old, &key).unwrap();
        let name = final_name(&signature);
        directory.write_new(&name, &wire).unwrap();
        assert!(
            recover(&f, &payload())
                .unwrap_err()
                .contains("source_or_scope_mismatch")
        );
        assert_eq!(fs::read(directory.path.join(name)).unwrap(), wire);
        assert!(!directory.path.join("CURRENT.json").exists());
    }
}
