use hepta_paper_service::{
    release_attest::ReleaseAttestationSourceRequestV2,
    release_replay::{
        ReleaseAttestationMeasuredPolicyReplayRequestV8,
        ReleaseAttestationNativeAstPolicyReplayRequestV9,
        ReleaseAttestationNativeRetirementPolicyReplayRequestV10,
        ReleaseAttestationPolicyReplayRequestV4, ReleaseAttestationReplayRequestV3,
        inspect_release_attestation_measured_policy_replay_with_cancellation_v8,
        inspect_release_attestation_native_ast_policy_replay_with_cancellation_v9,
        inspect_release_attestation_native_retirement_policy_replay_with_cancellation_v10,
        inspect_release_attestation_policy_replay_with_cancellation_v4,
    },
};
use serde_json::json;
use std::sync::atomic::AtomicBool;
fn request() -> ReleaseAttestationPolicyReplayRequestV4 {
    ReleaseAttestationPolicyReplayRequestV4 {
        version: 4,
        kind: "ReleaseAttestationPolicyReplayRequest".into(),
        replay: ReleaseAttestationReplayRequestV3 {
            version: 3,
            kind: "ReleaseAttestationReplayRequest".into(),
            source: ReleaseAttestationSourceRequestV2 {
                version: 2,
                kind: "ReleaseAttestationSourceRequest".into(),
                workspace_root: "/nonexistent".into(),
                git_executable: "/usr/bin/git".into(),
                git_executable_sha256: format!("sha256:{}", "0".repeat(64)),
                expected_commit: "0".repeat(40),
                expected_tree: "0".repeat(40),
                expected_release_state_snapshot_hash: format!("sha256:{}", "0".repeat(64)),
                timeout_ms: 600000,
            },
            node_executable: "/nonexistent/node".into(),
            node_executable_sha256: format!("sha256:{}", "0".repeat(64)),
            timeout_ms: 600000,
        },
        archive_path: "/nonexistent/archive.tar.gz".into(),
        archive_sha256: format!("sha256:{}", "0".repeat(64)),
    }
}

#[test]
fn native_ast_profile_refuses_caller_parser_selection_and_preserves_v8_archive_limits() {
    let mut policy = request();
    policy.archive_sha256 =
        "sha256:e431c4c7a51a15d64866b17a07c09dd17c15c32c8dddaccf1a769b1a5942cb9d".into();
    let actual = ReleaseAttestationNativeAstPolicyReplayRequestV9 {
        version: 9,
        kind: "ReleaseAttestationNativeAstPolicyReplayRequest".into(),
        native_profile: "immutable_245_python_ast_observation_v1".into(),
        policy: ReleaseAttestationMeasuredPolicyReplayRequestV8 {
            version: 8,
            kind: "ReleaseAttestationMeasuredPolicyReplayRequest".into(),
            resource_profile: "immutable_263_source_inspection_v1".into(),
            policy,
        },
    };
    let cancelled = AtomicBool::new(true);
    assert!(
        inspect_release_attestation_native_ast_policy_replay_with_cancellation_v9(
            actual.clone(),
            &cancelled
        )
        .unwrap_err()
        .ends_with("cancelled")
    );
    for field in [
        "parserPath",
        "parserSha256",
        "maximumSourceBytes",
        "callerVerified",
        "acceptedCaseCount",
    ] {
        let mut value = serde_json::to_value(&actual).unwrap();
        value[field] = json!(true);
        assert!(
            serde_json::from_value::<ReleaseAttestationNativeAstPolicyReplayRequestV9>(value)
                .is_err()
        );
    }
    let mut invalid = actual.clone();
    invalid.native_profile = "unlimited".into();
    assert_eq!(
        inspect_release_attestation_native_ast_policy_replay_with_cancellation_v9(
            invalid, &cancelled
        )
        .unwrap_err(),
        "release_attestation_replay_native_ast_profile_identity_invalid"
    );
    let mut invalid = actual;
    invalid.policy.policy.archive_sha256 = format!("sha256:{}", "0".repeat(64));
    assert_eq!(
        inspect_release_attestation_native_ast_policy_replay_with_cancellation_v9(
            invalid, &cancelled
        )
        .unwrap_err(),
        "release_attestation_replay_measured_profile_identity_invalid"
    );
}

#[test]
fn measured_profile_is_closed_and_cannot_raise_limits_or_replace_original_archive() {
    let mut policy = request();
    policy.archive_sha256 =
        "sha256:e431c4c7a51a15d64866b17a07c09dd17c15c32c8dddaccf1a769b1a5942cb9d".into();
    let actual = ReleaseAttestationMeasuredPolicyReplayRequestV8 {
        version: 8,
        kind: "ReleaseAttestationMeasuredPolicyReplayRequest".into(),
        resource_profile: "immutable_263_source_inspection_v1".into(),
        policy,
    };
    let cancelled = AtomicBool::new(true);
    assert!(
        inspect_release_attestation_measured_policy_replay_with_cancellation_v8(
            actual.clone(),
            &cancelled
        )
        .unwrap_err()
        .ends_with("cancelled")
    );
    for field in [
        "maximumSourceBytes",
        "callerVerified",
        "policyReplayComplete",
    ] {
        let mut input = serde_json::to_value(&actual).unwrap();
        input[field] = json!(true);
        assert!(
            serde_json::from_value::<ReleaseAttestationMeasuredPolicyReplayRequestV8>(input)
                .is_err()
        );
    }
    let mut bad = actual.clone();
    bad.resource_profile = "unlimited".into();
    assert_eq!(
        inspect_release_attestation_measured_policy_replay_with_cancellation_v8(bad, &cancelled)
            .unwrap_err(),
        "release_attestation_replay_measured_profile_identity_invalid"
    );
    let mut bad = actual;
    bad.policy.archive_sha256 = format!("sha256:{}", "0".repeat(64));
    assert_eq!(
        inspect_release_attestation_measured_policy_replay_with_cancellation_v8(bad, &cancelled)
            .unwrap_err(),
        "release_attestation_replay_measured_profile_identity_invalid"
    );
}
#[test]
fn policy_request_refuses_claimed_acceptance_counts_and_duplicate_identity() {
    let actual = request();
    let mut input = serde_json::to_value(&actual).unwrap();
    input["verifiedEntryCount"] = json!(263);
    assert!(serde_json::from_value::<ReleaseAttestationPolicyReplayRequestV4>(input).is_err());
    let mut input = serde_json::to_value(&actual).unwrap();
    input["replay"]["policyReplayComplete"] = json!(true);
    assert!(serde_json::from_value::<ReleaseAttestationPolicyReplayRequestV4>(input).is_err());
    let input = serde_json::to_string(&actual).unwrap().replacen(
        "\"version\":4",
        "\"version\":4,\"version\":4",
        1,
    );
    assert!(serde_json::from_str::<ReleaseAttestationPolicyReplayRequestV4>(&input).is_err());
}
#[test]
fn policy_cancellation_precedes_tool_and_archive_reads_and_resource_escalation_fails() {
    let cancelled = AtomicBool::new(true);
    let error =
        inspect_release_attestation_policy_replay_with_cancellation_v4(request(), &cancelled)
            .unwrap_err();
    assert!(error.ends_with("cancelled"), "{error}");
    for timeout in [0, 600001, u64::MAX] {
        let mut input = request();
        input.replay.timeout_ms = timeout;
        let error =
            inspect_release_attestation_policy_replay_with_cancellation_v4(input, &cancelled)
                .unwrap_err();
        assert_eq!(error, "release_attestation_replay_policy_request_invalid");
    }
    let mut input = request();
    input.archive_sha256 = "SHA256:fake".into();
    assert_eq!(
        inspect_release_attestation_policy_replay_with_cancellation_v4(input, &cancelled)
            .unwrap_err(),
        "release_attestation_replay_policy_request_invalid"
    );
}

#[test]
fn complete_retirement_profile_refuses_caller_acceptance_and_preserves_cancellation() {
    let mut policy = request();
    policy.archive_sha256 =
        "sha256:e431c4c7a51a15d64866b17a07c09dd17c15c32c8dddaccf1a769b1a5942cb9d".into();
    let request = ReleaseAttestationNativeRetirementPolicyReplayRequestV10 {
        version: 10,
        kind: "ReleaseAttestationNativeRetirementPolicyReplayRequest".into(),
        native_profile: "immutable_referee_venue_retirement_policy_v1".into(),
        policy: ReleaseAttestationNativeAstPolicyReplayRequestV9 {
            version: 9,
            kind: "ReleaseAttestationNativeAstPolicyReplayRequest".into(),
            native_profile: "immutable_245_python_ast_observation_v1".into(),
            policy: ReleaseAttestationMeasuredPolicyReplayRequestV8 {
                version: 8,
                kind: "ReleaseAttestationMeasuredPolicyReplayRequest".into(),
                resource_profile: "immutable_263_source_inspection_v1".into(),
                policy,
            },
        },
    };
    let cancelled = AtomicBool::new(true);
    assert!(
        inspect_release_attestation_native_retirement_policy_replay_with_cancellation_v10(
            request.clone(),
            &cancelled
        )
        .unwrap_err()
        .ends_with("cancelled")
    );
    for key in [
        "acceptedSourceCount",
        "productionReferences",
        "policyReplayComplete",
        "catalogPath",
        "maximumReadBytes",
        "signingAuthority",
    ] {
        let mut value = serde_json::to_value(&request).unwrap();
        value[key] = json!(true);
        assert!(
            serde_json::from_value::<ReleaseAttestationNativeRetirementPolicyReplayRequestV10>(
                value
            )
            .is_err()
        );
    }
    let mut wrong = request;
    wrong.native_profile = "unlimited".into();
    assert!(
        inspect_release_attestation_native_retirement_policy_replay_with_cancellation_v10(
            wrong, &cancelled
        )
        .unwrap_err()
        .ends_with("native_retirement_profile_identity_invalid")
    );
}
