use super::*;
use sha2::{Digest, Sha256};
use std::{
    fs,
    os::unix::fs::{PermissionsExt, symlink},
    process::Command,
};
struct Fixture {
    root: PathBuf,
    prepared: Value,
}
impl Fixture {
    fn new() -> Self {
        let mut nonce = [0; 16];
        getrandom::fill(&mut nonce).unwrap();
        let root =
            std::env::temp_dir().join(format!("hepta-published-recovery-{}", hex::encode(nonce)));
        fs::create_dir(&root).unwrap();
        fs::set_permissions(&root, fs::Permissions::from_mode(0o700)).unwrap();
        let runtime = root.join("runtime");
        fs::create_dir(&runtime).unwrap();
        fs::set_permissions(&runtime, fs::Permissions::from_mode(0o700)).unwrap();
        let manifest: Value = serde_json::from_slice(include_bytes!(
            "../../../../../../paper-core/config/autonomous-research-state-databases.v1.json"
        ))
        .unwrap();
        let mut images = Vec::new();
        let mut roles = Vec::new();
        for row in manifest["databases"].as_array().unwrap() {
            let path = runtime.join(row["relativePath"].as_str().unwrap());
            fs::create_dir_all(path.parent().unwrap()).unwrap();
            let mut parent = path.parent();
            while let Some(dir) = parent {
                if dir == root {
                    break;
                }
                fs::set_permissions(dir, fs::Permissions::from_mode(0o700)).unwrap();
                parent = dir.parent();
            }
            // This layer verifies selected owned bytes, not scientific/SQL truth.
            // Real ten-database construction and CLI recovery have a separate integration test.
            let bytes = format!("owned byte fixture for {}", row["role"]);
            fs::write(&path, bytes.as_bytes()).unwrap();
            fs::set_permissions(&path, fs::Permissions::from_mode(0o600)).unwrap();
            roles.push(row["role"].as_str().unwrap().to_owned());
            images.push(json!({"role":row["role"],"sourceRelativePath":row["relativePath"],"bytes":bytes.len(),
                "sourceSha256":format!("sha256:{:x}",Sha256::digest(bytes.as_bytes())),"businessSchemaHash":format!("sha256:{}","1".repeat(64))}));
        }
        roles.sort();
        let hash = format!("sha256:{}", "a".repeat(64));
        let mut prepared = json!({"version":1,"kind":"AutonomousResearchStateBusinessSchemaProvisioningReceipt",
            "status":"autonomous_research_state_business_schemas_prepared","ready":false,"runtimeRoot":runtime,
            "provisioningPlanId":hash,"stateDatabaseManifestHash":input_hash("AutonomousResearchStateDatabaseManifest",&manifest).unwrap(),
            "databaseRoles":roles,"databaseInstances":images,"schemaBundleHash":schema::bundle_hash().unwrap(),
            "provisioningIdentity":{"machineIntakeConfigurationHash":hash,"machineIntakeGenesisAuthorityMode":"external",
                "providerCanaryPairMaximumCostUsd":1.0,"providerConfigurationHash":hash,
                "runtimeReproducibilityRefreshPolicyHash":hash,"topicProducerProfileHash":hash,"writerManifestHash":hash},
            "nativeExecutionProfile":"pinned-external-genesis-v1","nativeExecution":true,"freshRuntimeInstalled":false,
            "publicationState":"prepared","externalAuthoritySelfSigned":false,"providerInvocationPerformed":false,
            "networkAccessPerformed":false,"onlineSchemaTransitionRequired":true,"productionActivation":false,"nodeRetirement":false,
            "recoveryPolicy":"retain_staging_or_published_target_never_automatically_retry"});
        prepared["provisioningReceiptHash"] = json!(
            input_hash(
                "AutonomousResearchStateBusinessSchemaProvisioningReceipt",
                &prepared
            )
            .unwrap()
        );
        let fixture = Self { root, prepared };
        fixture.write(PREPARED, &serde_json::to_vec(&fixture.prepared).unwrap());
        fixture
    }
    fn runtime(&self) -> PathBuf {
        self.root.join("runtime")
    }
    fn write(&self, name: &str, bytes: &[u8]) {
        let path = self.runtime().join(name);
        fs::write(&path, bytes).unwrap();
        fs::set_permissions(path, fs::Permissions::from_mode(0o600)).unwrap();
    }
    fn request(&self) -> Request {
        Request {
            version: 1,
            kind: "NativeStatePublicationRecoveryRequestV1".into(),
            action: "inspect".into(),
            runtime_root: self.runtime(),
            expected_prepared_receipt_hash: self.prepared["provisioningReceiptHash"]
                .as_str()
                .unwrap()
                .into(),
            execute: false,
            expected_plan_hash: None,
        }
    }
    fn select(&self) -> Request {
        let mut request = self.request();
        let inspected = run(&request).unwrap();
        request.action = "finalize".into();
        request.execute = true;
        request.expected_plan_hash = Some(
            inspected["plan"]["recoveryPlanHash"]
                .as_str()
                .unwrap()
                .into(),
        );
        request
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.root);
    }
}
fn run(request: &Request) -> Result<Value> {
    reconcile(request, &|| Ok(()), &mut |_| Ok(()))
}
#[test]
fn missing_terminal_is_reconstructed_once_and_replay_is_exact() {
    let f = Fixture::new();
    let before = fs::read(f.runtime().join("hepta-paper.sqlite")).unwrap();
    let inspection = run(&f.request()).unwrap();
    assert_eq!(inspection["mutationPerformed"], false);
    assert!(!f.runtime().join(TERMINAL).exists());
    let request = f.select();
    let result = run(&request).unwrap();
    assert_eq!(result, publication::terminal_receipt(&f.prepared).unwrap());
    assert_eq!(result["productionActivation"], false);
    assert_eq!(result["nodeRetirement"], false);
    assert_eq!(run(&request).unwrap(), result);
    assert_eq!(
        fs::read(f.runtime().join("hepta-paper.sqlite")).unwrap(),
        before
    );
}
#[test]
fn original_terminal_replays_without_rewriting_its_identity() {
    let f = Fixture::new();
    let expected = publication::terminal_receipt(&f.prepared).unwrap();
    f.write(TERMINAL, &serde_json::to_vec(&expected).unwrap());
    let path = f.runtime().join(TERMINAL);
    let before = fs::metadata(&path).unwrap();
    assert_eq!(run(&f.select()).unwrap(), expected);
    let after = fs::metadata(path).unwrap();
    assert_eq!(
        (before.ino(), before.ctime(), before.ctime_nsec()),
        (after.ino(), after.ctime(), after.ctime_nsec())
    );
}
#[test]
fn newer_database_bytes_are_not_repaired_or_replaced() {
    let f = Fixture::new();
    let request = f.select();
    f.write("hepta-paper.sqlite", b"new committed work");
    assert!(
        run(&request)
            .unwrap_err()
            .0
            .contains("published_database_changed")
    );
    assert!(!f.runtime().join(TERMINAL).exists());
    assert_eq!(
        fs::read(f.runtime().join("hepta-paper.sqlite")).unwrap(),
        b"new committed work"
    );
}
#[test]
fn matching_bytes_at_a_replacement_inode_require_a_new_explicit_snapshot() {
    let f = Fixture::new();
    let request = f.select();
    let path = f.runtime().join("hepta-paper.sqlite");
    let bytes = fs::read(&path).unwrap();
    fs::rename(&path, f.root.join("original-held-file")).unwrap();
    f.write("hepta-paper.sqlite", &bytes);
    assert!(run(&request).unwrap_err().0.contains("plan_mismatch"));
    assert!(!f.runtime().join(TERMINAL).exists());
}
#[test]
fn wrong_prepared_pin_and_recomputed_authority_claims_are_rejected() {
    let f = Fixture::new();
    let mut request = f.request();
    request.expected_prepared_receipt_hash = format!("sha256:{}", "b".repeat(64));
    assert!(run(&request).is_err());
    for field in [
        "ready",
        "productionActivation",
        "nodeRetirement",
        "externalAuthoritySelfSigned",
    ] {
        let mut changed = f.prepared.clone();
        changed[field] = json!(true);
        changed
            .as_object_mut()
            .unwrap()
            .remove("provisioningReceiptHash");
        changed["provisioningReceiptHash"] = json!(
            input_hash(
                "AutonomousResearchStateBusinessSchemaProvisioningReceipt",
                &changed
            )
            .unwrap()
        );
        f.write(PREPARED, &serde_json::to_vec(&changed).unwrap());
        request.expected_prepared_receipt_hash =
            changed["provisioningReceiptHash"].as_str().unwrap().into();
        assert!(run(&request).is_err());
    }
    assert!(!f.runtime().join(TERMINAL).exists());
}
#[test]
fn partial_extra_linked_or_symlinked_names_block_recovery() {
    for case in 0..5 {
        let f = Fixture::new();
        let path = f.runtime().join("hepta-paper.sqlite");
        match case {
            0 => fs::remove_file(path).unwrap(),
            1 => f.write("unregistered", b"unknown"),
            2 => {
                fs::remove_file(&path).unwrap();
                symlink("/dev/null", path).unwrap();
            }
            3 => fs::hard_link(path, f.root.join("outside-link")).unwrap(),
            _ => f.write(TERMINAL, b"{partial"),
        }
        assert!(run(&f.request()).is_err());
    }
}
#[test]
fn terminal_collision_after_observation_never_overwrites_the_other_file() {
    let f = Fixture::new();
    let request = f.select();
    let result = reconcile(&request, &|| Ok(()), &mut |cut| {
        if cut == "before_terminal" {
            f.write(TERMINAL, b"different owner");
        }
        Ok(())
    });
    assert!(result.is_err());
    assert_eq!(
        fs::read(f.runtime().join(TERMINAL)).unwrap(),
        b"different owner"
    );
}
#[test]
fn publication_reconciliation_shares_the_publication_and_staging_owner_lock() {
    let f = Fixture::new();
    let target = Target::open_parent(&f.runtime()).unwrap();
    let lock = target.lock().unwrap();
    assert!(run(&f.request()).unwrap_err().0.contains("owner_busy"));
    drop(lock);
    assert!(run(&f.request()).is_ok());
}
#[test]
fn terminal_failure_and_late_database_mutation_preserve_published_truth() {
    for mutate in [false, true] {
        let f = Fixture::new();
        let request = f.select();
        let failure = reconcile(&request, &|| Ok(()), &mut |cut| {
            if cut == "after_terminal" {
                if mutate {
                    f.write("hepta-paper.sqlite", b"newer");
                } else {
                    return Err(error("injected_failure"));
                }
            }
            Ok(())
        })
        .unwrap_err();
        assert!(failure.0.contains("publicationState=published"));
        assert!(f.runtime().join(TERMINAL).exists());
        if mutate {
            assert!(run(&request).is_err());
            assert_eq!(
                fs::read(f.runtime().join("hepta-paper.sqlite")).unwrap(),
                b"newer"
            );
        } else {
            assert!(run(&request).is_ok());
        }
    }
}
#[test]
fn missing_confirmation_wrong_version_and_unselected_mutation_fail_before_writes() {
    for case in 0..5 {
        let f = Fixture::new();
        let mut request = f.select();
        match case {
            0 => request.execute = false,
            1 => request.expected_plan_hash = None,
            2 => request.version = 2,
            3 => request.action = "repair".into(),
            _ => request.runtime_root = PathBuf::from("relative"),
        };
        assert!(run(&request).is_err());
        assert!(!f.runtime().join(TERMINAL).exists());
    }
}
#[test]
fn published_recovery_crash_child() {
    let Ok(path) = std::env::var("HEPTA_PUBLISHED_RECOVERY_TEST_REQUEST") else {
        return;
    };
    let path = PathBuf::from(path);
    assert!(path.starts_with(std::env::temp_dir()));
    let request: Request = serde_json::from_slice(&fs::read(path).unwrap()).unwrap();
    let cut = std::env::var("HEPTA_PUBLISHED_RECOVERY_TEST_CUT").unwrap();
    let _ = reconcile(&request, &|| Ok(()), &mut |point| {
        if point == cut {
            nix::sys::signal::raise(nix::sys::signal::Signal::SIGKILL).unwrap();
        }
        Ok(())
    });
    panic!("crash point missing");
}
#[test]
fn real_process_death_before_after_and_after_verified_terminal_is_reconciled() {
    for cut in [
        "before_terminal",
        "after_terminal",
        "after_terminal_verified",
    ] {
        let f = Fixture::new();
        let request = f.select();
        let path = f.root.join("request.json");
        fs::write(&path,serde_json::to_vec(&json!({"version":request.version,"kind":request.kind,"action":request.action,"runtimeRoot":request.runtime_root,
            "expectedPreparedReceiptHash":request.expected_prepared_receipt_hash,"execute":request.execute,"expectedPlanHash":request.expected_plan_hash})).unwrap()).unwrap();
        let output=Command::new(std::env::current_exe().unwrap()).args(["--exact","autonomous_state_provision::publication_recovery::tests::published_recovery_crash_child"])
            .env("HEPTA_PUBLISHED_RECOVERY_TEST_REQUEST",path).env("HEPTA_PUBLISHED_RECOVERY_TEST_CUT",cut).output().unwrap();
        assert!(!output.status.success());
        let completed = run(&request).unwrap();
        assert_eq!(
            completed,
            publication::terminal_receipt(&f.prepared).unwrap()
        );
        assert_eq!(run(&request).unwrap(), completed);
    }
}

#[test]
fn native_recovery_plan_distinguishes_adjacent_u64_kernel_identities() {
    let first = json!({"kind":"NativeStatePublicationRecoveryPlanV1","inode":9007199254740992_u64});
    let second =
        json!({"kind":"NativeStatePublicationRecoveryPlanV1","inode":9007199254740993_u64});
    assert_ne!(
        recovery_plan_hash(&first).unwrap(),
        recovery_plan_hash(&second).unwrap()
    );
    assert_eq!(
        recovery_plan_hash(&first).unwrap(),
        recovery_plan_hash(&first).unwrap()
    );
}
