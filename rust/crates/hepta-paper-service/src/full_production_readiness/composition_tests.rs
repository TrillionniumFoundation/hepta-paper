use super::*;
use std::{
    io::Write,
    process::{Command, Stdio},
};

struct Fixture(PathBuf);
impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

fn oracle(repository: &Path, name: &str, request: Value) -> Value {
    let mut child = Command::new("node")
        .arg(repository.join("rust/oracle").join(name))
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    child
        .stdin
        .take()
        .unwrap()
        .write_all(request.to_string().as_bytes())
        .unwrap();
    let result = child.wait_with_output().unwrap();
    assert!(
        result.status.success(),
        "{}",
        String::from_utf8_lossy(&result.stderr)
    );
    let result: Value = serde_json::from_slice(&result.stdout).unwrap();
    assert_eq!(result["profile"]["node"], "v22.23.1");
    assert!(result.get("error").is_none(), "{result}");
    result
}

#[test]
fn composition_verifies_pinned_evidence_without_promoting_unimplemented_gates() {
    let fixture = Fixture(std::env::temp_dir().join(format!(
        "hepta-production-composition-{}-{}", std::process::id(),
        SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_nanos(),
    )));
    let repository = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../..")
        .canonicalize()
        .unwrap();
    let operational = oracle(
        &repository,
        "operational-status-v1.mjs",
        json!({
            "root": fixture.0, "prepare": true, "productionTrustOverride": "valid",
        }),
    );
    let owner = oracle(
        &repository,
        "owner-status-v1.mjs",
        json!({
            "root": fixture.0.join("owner"), "mode": "complete",
        }),
    );
    let workspace = fixture.0.join("workspace");
    for (relative, value) in [
        (
            "migration/legacy-semantic-migration-matrix.json",
            &owner["matrix"],
        ),
        (
            "paper-domain/governance/legacy-owner-acceptance-family-manifest.v1.json",
            &owner["manifest"],
        ),
    ] {
        let path = workspace.join(relative);
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(path, serde_json::to_vec(value).unwrap()).unwrap();
    }
    let contract = "paper-core/config/offhost-worm-contract.v1.json";
    fs::create_dir_all(workspace.join(contract).parent().unwrap()).unwrap();
    fs::copy(repository.join(contract), workspace.join(contract)).unwrap();
    let public = fixture.0.join("capabilities-public");
    fs::set_permissions(&public, fs::Permissions::from_mode(0o700)).unwrap();
    let trust_path = public.join("OWNER_TRUST_STORE.json");
    let acceptance_path = public.join("CAPABILITY_OWNER_ACCEPTANCE.json");
    let mut trust: Value = serde_json::from_slice(&fs::read(&trust_path).unwrap()).unwrap();
    trust["keys"]
        .as_array_mut()
        .unwrap()
        .extend(owner["trust"]["keys"].as_array().unwrap().iter().cloned());
    fs::write(&trust_path, serde_json::to_vec(&trust).unwrap()).unwrap();
    fs::write(
        &acceptance_path,
        serde_json::to_vec(&owner["document"]).unwrap(),
    )
    .unwrap();
    fs::set_permissions(&acceptance_path, fs::Permissions::from_mode(0o600)).unwrap();
    let command = fixture.0.join("unexecuted-helper");
    fs::write(
        &command,
        b"#!/bin/sh\nprintf 'must never execute'\nexit 99\n",
    )
    .unwrap();
    fs::set_permissions(&command, fs::Permissions::from_mode(0o555)).unwrap();
    let mut options = FullProductionReadinessOptions {
        root: Some(fixture.0.join("assets")),
        runtime_root: Some(fixture.0.join("runtime")),
        owner_trust_store: Some(trust_path.clone()),
        owner_trust_store_sha256: Some(digest(&fs::read(&trust_path).unwrap())),
        owner_acceptance_document: Some(acceptance_path.clone()),
        owner_acceptance_document_sha256: Some(digest(&fs::read(&acceptance_path).unwrap())),
        package_recovery_readiness_command: Some(command.clone()),
        package_recovery_readiness_command_sha256: Some(digest(&fs::read(&command).unwrap())),
        ..Default::default()
    };
    let uid = fs::metadata(&public).unwrap().uid();
    let inspect = |options: &FullProductionReadinessOptions| {
        inspect_with_owner_references(
            options,
            &workspace,
            |trust, trust_hash, acceptance, acceptance_hash| {
                owner::PinnedOwnerReferences::open_with_required_uid(
                    trust,
                    trust_hash,
                    acceptance,
                    acceptance_hash,
                    uid,
                )
            },
        )
        .unwrap()
    };
    let mut report = inspect(&options);
    assert!(
        report["inspectionErrors"]
            .as_array()
            .unwrap()
            .iter()
            .any(|error| error == "full_production_package_readiness_command_reference_invalid"),
        "{report}"
    );
    assert_eq!(
        report["independentExternalOwnerAcceptanceReady"], true,
        "{report}"
    );
    assert_eq!(
        report["independentExternalOwnerAcceptanceInspection"]["externallyAccepted"],
        249
    );
    assert_eq!(report["independentProductionOperationalProofReady"], true);
    assert_eq!(
        report["independentProductionOperationalProofInspection"],
        operational["productionInspection"]
    );
    assert_eq!(report["fullProductionReady"], false);
    assert_eq!(report["externalActionPerformed"], false);
    assert_eq!(report["packageRetentionRecoveryReady"], false);
    assert_eq!(report["offhostWormCustodyReady"], false);
    assert_eq!(report["automationPlaneReady"], false);
    assert!(report["observedAt"].is_string());
    assert!(
        !report["blockers"]
            .as_array()
            .unwrap()
            .iter()
            .any(|blocker| {
                blocker == "rust_full_production_external_owner_signature_verification_not_ported"
                    || blocker == "rust_full_production_operational_proof_aggregation_not_ported"
            })
    );
    let declared_hash = report
        .as_object_mut()
        .unwrap()
        .remove("fullProductionReadinessStatusHash")
        .unwrap();
    assert_eq!(
        declared_hash,
        production_hash_record_v1("FullProductionReadinessStatus", &report)
            .unwrap()
            .as_str()
    );

    // The public production entry point has no caller-selected UID policy.
    if uid != 0 {
        let production = inspect_full_production_readiness_v1(&options, &workspace).unwrap();
        assert_eq!(production["independentExternalOwnerAcceptanceReady"], false);
        assert_eq!(
            production["independentProductionOperationalProofReady"],
            false
        );
    }
    let mut document = owner["document"].clone();
    document["acceptedAt"] = json!("2026-09-15T00:00:00.000Z");
    fs::write(&acceptance_path, serde_json::to_vec(&document).unwrap()).unwrap();
    options.owner_acceptance_document_sha256 = Some(digest(&fs::read(&acceptance_path).unwrap()));
    let tampered = inspect(&options);
    assert_eq!(tampered["independentExternalOwnerAcceptanceReady"], false);
    assert_eq!(tampered["independentProductionOperationalProofReady"], true);

    // Valid runtime-local trust cannot replace the explicitly pinned public store.
    trust["keys"] = json!([]);
    fs::write(&trust_path, serde_json::to_vec(&trust).unwrap()).unwrap();
    options.owner_trust_store_sha256 = Some(digest(&fs::read(&trust_path).unwrap()));
    let untrusted = inspect(&options);
    assert_eq!(
        untrusted["independentProductionOperationalProofInspection"]["verified"],
        0
    );
    assert_eq!(
        untrusted["independentProductionOperationalProofReady"],
        false
    );
}
