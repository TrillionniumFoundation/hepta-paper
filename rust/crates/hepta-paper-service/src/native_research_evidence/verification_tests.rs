use super::tests::Temp;
use super::verification::*;
use super::*;
use hepta_codex_runtime::{
    BoundedProcessRequestV1, EnvironmentPolicyV1, ProcessLimitsV1, ProcessTerminationReason,
    run_bounded_process_capturing_stdout_with_cancellation,
};
use sha2::{Digest, Sha256};
use std::{collections::BTreeMap, fs, os::unix::fs::symlink, time::Duration};
const NOW: &str = "2026-10-02T00:00:00.000Z";
fn input(root: &Path) -> NativeEvidenceArtifactVerificationRequestV1 {
    let bytes = b"Actual locally verified evidence bytes.\n";
    NativeEvidenceArtifactVerificationRequestV1 {
        version: 1,
        source_root: Some(root.into()),
        evidence_items: vec![
            json!({"id":"actual","path":root.join("evidence.bin"),"hash":format!("sha256:{:x}",Sha256::digest(bytes)),"sourceSnapshotHash":"sha256:declared-snapshot","provenance":"observed_local_data"}),
        ],
        expected_source_snapshot_hash: Some(json!("sha256:declared-snapshot")),
    }
}
#[test]
fn actual_safe_artifact_verifier_matches_original_whole_receipts_with_positive_integrity() {
    let temp = Temp::new();
    fs::write(
        temp.0.join("evidence.bin"),
        b"Actual locally verified evidence bytes.\n",
    )
    .unwrap();
    let mut inputs = Vec::new();
    for mode in [
        "positive",
        "wrong-hash",
        "missing-provenance",
        "wrong-snapshot",
        "no-authority-verifier",
        "missing-file",
        "no-source-root",
        "relative-path",
        "false-fields",
        "structured-provenance",
        "non-string-hash",
        "large-integer-id",
        "nested-large-provenance",
    ] {
        let mut r = input(&temp.0);
        match mode {
            "wrong-hash" => r.evidence_items[0]["hash"] = json!("sha256:wrong"),
            "missing-provenance" => r.evidence_items[0]["provenance"] = Value::Null,
            "wrong-snapshot" => r.evidence_items[0]["sourceSnapshotHash"] = json!("sha256:other"),
            "no-authority-verifier" => {
                r.evidence_items[0]["authorityAttestation"] = json!({"status":"caller-not-trusted"})
            }
            "missing-file" => {
                r.evidence_items[0]["path"] = json!(temp.0.join("absent-evidence.bin"))
            }
            "no-source-root" => r.source_root = None,
            "relative-path" => r.evidence_items[0]["path"] = json!("evidence.bin"),
            "false-fields" => {
                r.evidence_items[0]["id"] = json!(0);
                r.evidence_items[0]["hash"] = json!(false);
                r.evidence_items[0]["sourceSnapshotHash"] = json!(false);
            }
            "structured-provenance" => {
                r.evidence_items[0]["provenance"] = json!({"kind":"observed","authorized":false})
            }
            "non-string-hash" => r.evidence_items[0]["hash"] = json!(true),
            "large-integer-id" => r.evidence_items[0]["id"] = json!(9007199254740993_u64),
            "nested-large-provenance" => {
                r.evidence_items[0]["provenance"] = json!({"observed":[9007199254740993_u64,18446744073709551615_u64],"nested":{"id":-9007199254740993_i64}})
            }
            _ => (),
        }
        inputs.push(r);
    }
    let script = r#"import{verifyEvidenceBatch}from'./paper-adapters/research-verify/evidence-verifier.mjs';let raw='';for await(const c of process.stdin){raw+=c;if(Buffer.byteLength(raw)>65536)throw Error('input');}const values=[];for(const input of JSON.parse(raw)){const{version,...options}=input;values.push(await verifyEvidenceBatch({...options,clock:{nowIso:()=> '2026-10-02T00:00:00.000Z'}}));}process.stdout.write(JSON.stringify({profile:{node:process.version,icu:process.versions.icu,cldr:process.versions.cldr},values}));"#;
    let env = EnvironmentPolicyV1::new(
        "actual-local-integrity-verifier",
        ["PATH", "LANG", "LC_ALL"],
        ["PATH"],
    )
    .unwrap()
    .build(
        std::iter::empty::<(std::ffi::OsString, std::ffi::OsString)>(),
        &BTreeMap::from([
            ("PATH".into(), "/usr/bin:/bin".into()),
            ("LANG".into(), "C.UTF-8".into()),
            ("LC_ALL".into(), "C.UTF-8".into()),
        ]),
    )
    .unwrap();
    let node = run_bounded_process_capturing_stdout_with_cancellation(
        &BoundedProcessRequestV1 {
            executable: std::env::var_os("HEPTA_TEST_NODE")
                .map(PathBuf::from)
                .expect("qualified Node required"),
            arguments: vec!["--input-type=module".into(), "--eval".into(), script.into()],
            working_directory: PathBuf::from(env!("CARGO_MANIFEST_DIR"))
                .join("../../..")
                .canonicalize()
                .unwrap(),
            environment: env,
            stdin: Some(serde_json::to_vec(&inputs).unwrap()),
        },
        ProcessLimitsV1 {
            timeout_ms: 60_000,
            termination_grace_ms: 100,
            cleanup_timeout_ms: 2000,
            maximum_stdin_bytes: 65536,
            maximum_stdout_bytes: 4 * 1024 * 1024,
            maximum_stderr_bytes: 65536,
            maximum_tail_bytes: 32768,
            ..ProcessLimitsV1::default()
        },
        &AtomicBool::new(false),
    )
    .unwrap();
    assert_eq!(
        node.process.termination_reason,
        ProcessTerminationReason::Exited
    );
    assert_eq!(node.process.exit_code, Some(0));
    assert_eq!(node.process.stderr_bytes, 0);
    assert!(node.process.process_group_cleanup_verified);
    let actual: Value = serde_json::from_slice(&node.stdout).unwrap();
    assert_eq!(
        actual["profile"],
        json!({"node":"v22.23.1","icu":"78.2","cldr":"48.0"})
    );
    for (i, input) in inputs.iter().enumerate() {
        let c = AtomicBool::new(false);
        let mut ctx =
            NativeResearchReadContextV1::new(&c, Instant::now() + Duration::from_secs(60));
        let observed = verify_with_context(input, &mut ctx, &mut || Ok(NOW.into())).unwrap();
        assert_eq!(
            json!(observed.receipts()),
            actual["values"][i],
            "whole original actual artifact receipt case{i}"
        );
        observed.verify_unchanged().unwrap();
    }
    assert_eq!(
        actual["values"][11][0]["evidenceId"],
        json!(9007199254740992_u64)
    );
    assert_eq!(
        actual["values"][12][0]["provenance"]["observed"][0],
        json!(9007199254740992_u64)
    );
    assert_eq!(
        actual["values"][0][0]["status"],
        "evidence_artifact_verified"
    );
    assert!(actual["values"][0][0]["verifiedHash"].is_string());
    assert_eq!(actual["values"][0][0]["authorityReceiptHash"], Value::Null);
    assert_eq!(
        actual["values"][4][0]["status"],
        "evidence_artifact_blocked"
    );
    println!(
        "actual_native_artifact_verifier={}",
        json!({"nodePid":node.process.process_id,"stdoutBytes":node.process.stdout_bytes,"stdoutSha256":node.process.stdout_hash,"actualWholeCases":inputs.len(),"actualPositiveIntegrity":true,"scientificOrAcademicAuthorityGranted":false,"fullResearchAdapterAccepted":false})
    );
}
#[test]
fn actual_verifier_retains_members_absence_cancel_deadline_preclone_bounds_and_fresh_retry() {
    let temp = Temp::new();
    fs::write(
        temp.0.join("evidence.bin"),
        b"Actual locally verified evidence bytes.\n",
    )
    .unwrap();
    let c = AtomicBool::new(false);
    let deadline = || Instant::now() + Duration::from_secs(60);
    let observed = verify_native_evidence_artifacts_v1(input(&temp.0), &c, deadline()).unwrap();
    fs::write(temp.0.join("evidence.bin"), b"changed actual bytes").unwrap();
    assert!(observed.verify_unchanged().is_err());
    drop(observed);
    let fresh = verify_native_evidence_artifacts_v1(input(&temp.0), &c, deadline()).unwrap();
    assert_eq!(fresh.receipts()[0]["status"], "evidence_artifact_blocked");
    fresh.verify_unchanged().unwrap();
    drop(fresh);
    assert!(
        verify_native_evidence_artifacts_v1(input(&temp.0), &AtomicBool::new(true), deadline())
            .is_err()
    );
    assert!(verify_native_evidence_artifacts_v1(input(&temp.0), &c, Instant::now()).is_err());
    let mut missing = input(&temp.0);
    missing.evidence_items[0]["path"] = json!(temp.0.join("absent.bin"));
    let observed = verify_native_evidence_artifacts_v1(missing, &c, deadline()).unwrap();
    fs::write(temp.0.join("absent.bin"), b"later").unwrap();
    assert!(observed.verify_unchanged().is_err());
    drop(observed);
    symlink("evidence.bin", temp.0.join("alias.bin")).unwrap();
    let mut bad = input(&temp.0);
    bad.evidence_items[0]["path"] = json!("alias.bin");
    assert!(verify_native_evidence_artifacts_v1(bad, &c, deadline()).is_err());
    fs::hard_link(temp.0.join("evidence.bin"), temp.0.join("linked.bin")).unwrap();
    assert!(verify_native_evidence_artifacts_v1(input(&temp.0), &c, deadline()).is_err());
    fs::remove_file(temp.0.join("linked.bin")).unwrap();
    let mut request = input(&temp.0);
    request.evidence_items = vec![request.evidence_items[0].clone(); 16];
    for item in &mut request.evidence_items {
        item["provenance"] = json!("x".repeat(65000));
    }
    assert!(
        values_budget(request.evidence_items.iter()).is_ok(),
        "actual input stays within existing1Mi/64Ki budget"
    );
    let mut ctx = NativeResearchReadContextV1::new(&c, deadline());
    assert!(
        verify_with_context(&request, &mut ctx, &mut || Ok(NOW.into())).is_err(),
        "derived output reserve before clone"
    );
    request.evidence_items.truncate(1);
    assert!(verify_with_context(&request, &mut ctx, &mut || Ok(NOW.into())).is_err());
    drop(ctx);
    verify_native_evidence_artifacts_v1(request, &c, deadline())
        .unwrap()
        .verify_unchanged()
        .unwrap();
    let mut over = input(&temp.0);
    over.evidence_items = vec![Value::Null; 129];
    over.source_root = Some(temp.0.join("must-not-be-created"));
    assert!(verify_native_evidence_artifacts_v1(over, &c, deadline()).is_err());
    assert!(!temp.0.join("must-not-be-created").exists());
    fs::write(temp.0.join("evidence.bin"), vec![b'x'; 1024 * 1024 + 1]).unwrap();
    assert!(verify_native_evidence_artifacts_v1(input(&temp.0), &c, deadline()).is_err());
}
