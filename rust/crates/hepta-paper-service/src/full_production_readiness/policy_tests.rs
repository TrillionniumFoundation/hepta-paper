//! Differential protocol tests. All ready claims here are synthetic policy
//! inputs; they grant no production authority to the runtime composition.
use super::*;
use std::{
    io::Write,
    path::PathBuf,
    process::{Command, Stdio},
};

const OBSERVATION: &str = "2026-09-20T12:00:02.000Z";
fn h() -> String {
    format!("sha256:{}", "a".repeat(64))
}
fn rehash(readiness: &mut Value) {
    readiness
        .as_object_mut()
        .unwrap()
        .remove("packageRetentionRecoveryReadinessHash");
    let digest = production_hash_record_v1("PackageRetentionRecoveryReadiness", readiness).unwrap();
    readiness["packageRetentionRecoveryReadinessHash"] = json!(digest.as_str());
}
fn ready_package() -> Value {
    let mut value = json!({
        "version": 2, "kind": "PackageRetentionRecoveryReadiness",
        "status": "package_retention_recovery_authority_ready",
        "inspectedAt": "2026-09-20T12:00:00.000Z",
        "finalizedAt": "2026-09-20T12:00:01.000Z",
        "recoveryAuthorityValidUntil": "2026-09-20T12:05:00.000Z",
        "recoveryAuthoritySnapshotHash": h(), "recoveryAuthorityInspectionHash": h(),
        "blockers": [],
    });
    for key in PACKAGE_BOOLEAN_KEYS {
        value[key] = json!(true);
    }
    rehash(&mut value);
    value
}
fn inspect_request(readiness: Value, observed_at: &str) -> Value {
    json!({"operation":"inspect-package", "observedAt":observed_at,
        "response":{"status":"paper_campaign_retention-recovery-readiness","result":readiness}})
}
fn ready_input() -> Value {
    let request = inspect_request(ready_package(), OBSERVATION);
    let package = inspect_package_retention_recovery_readiness_response_v1(
        &request["response"],
        &request["observedAt"],
    )
    .unwrap();
    json!({
        "observedAt": OBSERVATION, "offhostWormContractId": "synthetic-contract",
        "automationReport": {
            "version": 2, "kind": "AutomationPlaneStatus", "status":"automation_plane_production_ready",
            "productionReady": true, "fullyAutonomousResearchSystemReady": true,
            "fullyAutonomousResearchSystemStatus":"generic_domain_autonomous_research_system_ready",
            "liveProviderCanaryRequested":true, "liveProviderCanaryReady":true,
            "liveReleaseAttestorVerificationRequested":true, "researchExecutionReleaseAttestorProductionReady":true,
            "retainedUnknownField": {"fixtureOnly":true},
        },
        "packageRetentionRecoveryInspection": package,
        "offhostWormCustodyInspection": {
            "version":1, "kind":"OffhostWormTargetStatus", "status":"offhost_worm_target_ready",
            "contractId":"synthetic-contract", "custodyRequired":true, "custodyDeclaredQualified":true,
            "offHostOrOffsiteCustodyQualified":true, "custodyStatus":"offhost_or_offsite_custody_qualified",
            "custodyEvidenceStatus":"offhost_worm_custody_evidence_verified", "custodyEvidenceBundleHash":h(),
            "custodyTrustStoreHash":h(), "storageIdentityHash":h(), "custodyEvidenceExpiresAt":"2026-09-20T13:00:00.000Z",
            "blockers":[],
        },
        "independentExternalOwnerAcceptanceInspection": {
            "version":1, "kind":"IndependentExternalOwnerAcceptanceInspection",
            "status":"independent_external_owner_acceptance_ready", "required":249, "externallyAccepted":249,
            "localAdminAccepted":0, "familyManifestBound":true, "familyManifestHash":FULL_PRODUCTION_OWNER_FAMILY_MANIFEST_HASH,
            "automaticAcceptanceForbidden":true,
        },
        "independentProductionOperationalProofInspection": {
            "version":1, "kind":"IndependentProductionOperationalProofInspection", "status":"independent_production_operational_proof_ready",
            "releaseCommit":"a".repeat(40), "verified":16, "required":16,
            "externalIndependentRequired":true, "conformanceCannotQualify":true,
            "capabilities":FULL_PRODUCTION_OPERATIONAL_CAPABILITY_IDS.iter().map(|id| json!({
                "capabilityId":id, "verified":true, "operationalReceiptHashes":[h()], "issuerAssurances":["external_independent"],
            })).collect::<Vec<_>>(),
        },
    })
}

fn compare(requests: &[Value]) -> Value {
    let repository = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../..");
    let mut child = Command::new("node")
        .arg(repository.join("rust/oracle/full-production-readiness-policy-v1.mjs"))
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    child
        .stdin
        .take()
        .unwrap()
        .write_all(serde_json::to_vec(requests).unwrap().as_slice())
        .unwrap();
    let result = child.wait_with_output().unwrap();
    assert!(
        result.status.success(),
        "{}",
        String::from_utf8_lossy(&result.stderr)
    );
    let node: Value = serde_json::from_slice(&result.stdout).unwrap();
    assert_eq!(node["profile"]["node"], "v22.23.1");
    assert_eq!(
        node["constants"]["operationalCapabilityIds"],
        json!(FULL_PRODUCTION_OPERATIONAL_CAPABILITY_IDS)
    );
    assert_eq!(
        node["constants"]["ownerAcceptanceRequired"],
        FULL_PRODUCTION_OWNER_ACCEPTANCE_REQUIRED
    );
    assert_eq!(
        node["constants"]["ownerFamilyManifestHash"],
        FULL_PRODUCTION_OWNER_FAMILY_MANIFEST_HASH
    );
    for (index, request) in requests.iter().enumerate() {
        let actual = if request["operation"] == "inspect-package" {
            inspect_package_retention_recovery_readiness_response_v1(
                &request["response"],
                &request["observedAt"],
            )
        } else {
            evaluate_full_production_readiness_v1(&request["input"])
        };
        let actual = match actual {
            Ok(value) => json!({"ok":true,"value":value}),
            Err(error) => json!({"ok":false,"error":error.to_string()}),
        };
        assert_eq!(actual, node["results"][index], "case {index}: {request}");
    }
    node
}

#[test]
fn package_protocol_freshness_and_tampering_match_node() {
    let mut requests = vec![inspect_request(ready_package(), OBSERVATION)];
    for observed in [
        "2026-09-20T12:05:00.000Z",
        "2026-09-20T12:00:00.500Z",
        "2026-09-20T12:00:02Z",
        "invalid",
    ] {
        requests.push(inspect_request(ready_package(), observed));
    }
    for (key, value) in [
        ("recoveryAuthorityAuthenticated", json!(false)),
        ("deletionFailClosedWhenUnavailable", json!(false)),
        ("lifecycleLockOperational", json!("true")),
        ("blockers", json!(["same", "same"])),
        ("blockers", json!([""])),
        ("blockers", json!(["blocked"])),
        ("finalizedAt", json!("2026-09-20T12:00:30.001Z")),
        ("finalizedAt", json!("2026-09-20T11:59:59.000Z")),
        (
            "recoveryAuthorityValidUntil",
            json!("2026-09-20T12:05:00.001Z"),
        ),
        (
            "recoveryAuthorityValidUntil",
            json!("2026-09-20T12:00:01.000Z"),
        ),
        ("recoveryAuthoritySnapshotHash", Value::Null),
        ("extra", json!(true)),
    ] {
        let mut package = ready_package();
        package[key] = value;
        rehash(&mut package);
        requests.push(inspect_request(package, OBSERVATION));
    }
    let mut unavailable = ready_package();
    unavailable["status"] = json!("package_retention_recovery_authority_unavailable");
    for key in PACKAGE_BOOLEAN_KEYS {
        unavailable[key] = json!(key == "deletionFailClosedWhenUnavailable");
    }
    for key in [
        "recoveryAuthorityValidUntil",
        "recoveryAuthoritySnapshotHash",
        "recoveryAuthorityInspectionHash",
    ] {
        unavailable[key] = Value::Null;
    }
    unavailable["blockers"] = json!(["missing-authority"]);
    rehash(&mut unavailable);
    requests.push(inspect_request(unavailable, OBSERVATION));
    let mut tampered = ready_package();
    tampered["inspectedAt"] = json!("2026-09-20T11:59:59.000Z");
    requests.push(inspect_request(tampered, OBSERVATION));
    let mut missing = ready_package();
    missing.as_object_mut().unwrap().remove("blockers");
    rehash(&mut missing);
    requests.push(inspect_request(missing, OBSERVATION));
    let mut outer = requests[0].clone();
    outer["response"]["extra"] = json!(true);
    requests.push(outer);
    let node = compare(&requests);
    assert_eq!(node["results"][0]["value"]["ready"], true);
    assert_eq!(node["results"][1]["value"]["ready"], false);
}

#[test]
fn five_axis_aggregation_and_final_observation_match_node() {
    let base = ready_input();
    let mut requests = vec![json!({"operation":"evaluate", "input":base})];
    for (pointer, value) in [
        ("/automationReport/liveProviderCanaryReady", json!(false)),
        ("/automationReport/status", json!("")),
        (
            "/packageRetentionRecoveryInspection/observedAt",
            json!("2026-09-20T12:00:03.000Z"),
        ),
        (
            "/packageRetentionRecoveryInspection/readiness/packageRetentionRecoveryReadinessHash",
            json!("wrong"),
        ),
        ("/observedAt", json!("2026-09-20T12:05:00.000Z")),
        ("/observedAt", json!("invalid")),
        (
            "/offhostWormCustodyInspection/custodyEvidenceExpiresAt",
            json!(OBSERVATION),
        ),
        (
            "/offhostWormCustodyInspection/custodyEvidenceExpiresAt",
            Value::Null,
        ),
        ("/offhostWormCustodyInspection/contractId", json!("wrong")),
        (
            "/offhostWormCustodyInspection/storageIdentityHash",
            json!("wrong"),
        ),
        (
            "/independentExternalOwnerAcceptanceInspection/externallyAccepted",
            json!(248),
        ),
        (
            "/independentExternalOwnerAcceptanceInspection/externallyAccepted",
            json!(250),
        ),
        (
            "/independentExternalOwnerAcceptanceInspection/localAdminAccepted",
            json!(-1),
        ),
        (
            "/independentExternalOwnerAcceptanceInspection/familyManifestHash",
            json!(h()),
        ),
        (
            "/independentExternalOwnerAcceptanceInspection/automaticAcceptanceForbidden",
            json!(false),
        ),
        (
            "/independentProductionOperationalProofInspection/verified",
            json!(15),
        ),
        (
            "/independentProductionOperationalProofInspection/releaseCommit",
            json!("wrong"),
        ),
        (
            "/independentProductionOperationalProofInspection/conformanceCannotQualify",
            json!(false),
        ),
        (
            "/independentProductionOperationalProofInspection/capabilities/0/issuerAssurances",
            json!(["local_admin_delegated"]),
        ),
        (
            "/independentProductionOperationalProofInspection/capabilities/0/operationalReceiptHashes",
            json!([]),
        ),
        (
            "/independentProductionOperationalProofInspection/capabilities/0/operationalReceiptHashes",
            json!([h(), h()]),
        ),
        (
            "/independentProductionOperationalProofInspection/capabilities/0/operationalReceiptHashes",
            json!(["wrong"]),
        ),
        (
            "/independentProductionOperationalProofInspection/capabilities/0/capabilityId",
            json!(FULL_PRODUCTION_OPERATIONAL_CAPABILITY_IDS[1]),
        ),
        ("/automationReport", Value::Null),
    ] {
        let mut input = base.clone();
        *input.pointer_mut(pointer).unwrap() = value;
        requests.push(json!({"operation":"evaluate", "input":input}));
    }
    let node = compare(&requests);
    assert_eq!(node["results"][0]["value"]["fullProductionReady"], true);
    assert_eq!(node["results"][0]["value"]["observedAt"], OBSERVATION);
}
