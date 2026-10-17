use std::{collections::BTreeMap, path::PathBuf, str::FromStr};

use base64ct::{Base64UrlUnpadded, Encoding};
use ed25519_dalek::SigningKey;
use hepta_codex_protocol::{AgentRole, Sha256Digest};

use crate::{
    CommitBindingDatabaseScopeV2, CommitBoundAcknowledgementError, PeerPrincipalV1,
    ProductCommitBindingSourceV2, TrustBundleError,
};

use super::{
    ProductBundleAuthorityKeyV1, ProductCgroupConfigurationV1, ProductCodexBrokerConfigurationV1,
    ProductCodexBrokerDaemonError, ProductCommitAcknowledgementConfigurationV2,
    ProductJournalConfigurationV1, ProductListenerConfigurationV1,
    ProductProcessLimitsConfigurationV1, ProductRuntimeConfigurationV1,
    ProductServerConfigurationV1,
    compose::{decode_bundle_authority, decode_commit_acknowledgement_trust},
    config::validate_configuration_shape,
};

fn digest() -> Sha256Digest {
    Sha256Digest::from_str(&format!("sha256:{}", "1".repeat(64))).unwrap()
}

pub(super) fn configuration() -> ProductCodexBrokerConfigurationV1 {
    ProductCodexBrokerConfigurationV1 {
        version: 1,
        configuration_authority_uid: 0,
        configuration_reader_gid: 1000,
        broker_uid: 1001,
        broker_gid: 1002,
        role: AgentRole::Author,
        purpose: crate::ProductCodexOperationPurposeV1::Business,
        operation_authority_uid: 1003,
        operation_directory: PathBuf::from("/etc/hepta/operations"),
        trust_bundle_path: PathBuf::from("/etc/hepta/trust/bundle.json"),
        trust_bundle_authority_uid: 1004,
        trust_bundle_reader_gid: 1005,
        trust_bundle_authority_keys: vec![ProductBundleAuthorityKeyV1 {
            key_id: "authority-key-1".to_owned(),
            public_key_base64: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA".to_owned(),
        }],
        commit_acknowledgement: None,
        allowed_peers: vec![PeerPrincipalV1 {
            uid: 1006,
            gid: 1007,
        }],
        listener: ProductListenerConfigurationV1 {
            socket_path: PathBuf::from("/run/hepta/author/broker.sock"),
            parent_owner_uid: 1001,
            parent_group_gid: 1002,
            instance_generation: 1,
            listen_backlog: 8,
        },
        journal: ProductJournalConfigurationV1 {
            path: PathBuf::from("/var/lib/hepta/author/journal.sqlite"),
            busy_timeout_ms: 5_000,
            maximum_database_bytes: 1024 * 1024,
        },
        runtime: ProductRuntimeConfigurationV1 {
            executable: PathBuf::from("/usr/libexec/hepta/codex"),
            executable_owner_uid: 0,
            executable_owner_gid: Some(0),
            codex_home: PathBuf::from("/var/lib/hepta/author/codex-home"),
            model_selector: "model-1".to_owned(),
            credential_material_paths: vec!["auth.json".to_owned()],
            parent_environment: BTreeMap::from([
                ("PATH".to_owned(), "/usr/bin:/bin".to_owned()),
                ("HOME".to_owned(), "/var/lib/hepta/author".to_owned()),
                ("TMPDIR".to_owned(), "/var/lib/hepta/author/tmp".to_owned()),
                (
                    "CODEX_HOME".to_owned(),
                    "/var/lib/hepta/author/codex-home".to_owned(),
                ),
            ]),
            model_child_environment_base: BTreeMap::from([(
                "PATH".to_owned(),
                "/usr/bin:/bin".to_owned(),
            )]),
            transport_profile_hash: digest(),
            maximum_executable_bytes: 1024 * 1024,
            maximum_config_bytes: 1024 * 1024,
        },
        gate_executable: PathBuf::from("/usr/libexec/hepta/preexec-gate"),
        gate_authority_uid: 1008,
        gate_state_directory: PathBuf::from("/var/lib/hepta/author/gate"),
        cgroup: ProductCgroupConfigurationV1 {
            delegated_root: PathBuf::from("/sys/fs/cgroup/hepta-author"),
            pids_max: 32,
            memory_max: 1024 * 1024 * 1024,
            cpu_quota_us: 100_000,
            cpu_period_us: 100_000,
            cleanup_timeout_ms: 5_000,
            poll_interval_ms: 20,
        },
        process_limits: ProductProcessLimitsConfigurationV1 {
            timeout_ms: 30_000,
            termination_grace_ms: 1_000,
            cleanup_timeout_ms: 5_000,
            poll_interval_ms: 20,
            maximum_stdin_bytes: 1024 * 1024,
            maximum_stdout_bytes: 1024 * 1024,
            maximum_stderr_bytes: 1024 * 1024,
            maximum_tail_bytes: 64 * 1024,
        },
        server: ProductServerConfigurationV1 {
            worker_threads: 1,
            queue_capacity: 4,
            accept_poll_ms: 20,
            write_timeout_ms: 1_000,
            busy_retry_after_ms: 100,
            maximum_connections: 1,
            maximum_response_bytes: 64 * 1024,
        },
    }
}

fn commit_acknowledgement_configuration() -> ProductCommitAcknowledgementConfigurationV2 {
    let key = SigningKey::from_bytes(&[8_u8; 32]).verifying_key();
    ProductCommitAcknowledgementConfigurationV2 {
        version: 2,
        authority_domain_id: "campaign-writer".into(),
        trust_store_generation: 1,
        maximum_age_ms: 5 * 60 * 1000,
        authority_keys: vec![ProductBundleAuthorityKeyV1 {
            key_id: "campaign-writer-key-1".into(),
            public_key_base64: Base64UrlUnpadded::encode_string(key.as_bytes()),
        }],
        commit_binding_source: ProductCommitBindingSourceV2 {
            version: 2,
            database_path: "/var/lib/hepta-paper/campaign.sqlite".into(),
            database_owner_uid: 1000,
            busy_timeout_ms: 5_000,
            maximum_database_bytes: 4 * 1024 * 1024 * 1024,
            scope: CommitBindingDatabaseScopeV2::ActivatedRustWriter,
        },
    }
}

#[test]
fn configuration_json_is_closed_and_absolute() {
    let configuration = configuration();
    validate_configuration_shape(&configuration).unwrap();
    let mut value = serde_json::to_value(configuration).unwrap();
    value["unknown"] = serde_json::json!(true);
    assert!(serde_json::from_value::<ProductCodexBrokerConfigurationV1>(value).is_err());
}

#[test]
fn authority_collapsing_or_relative_paths_fail_shape_validation() {
    let mut collapsed = configuration();
    collapsed.operation_authority_uid = collapsed.broker_uid;
    assert!(validate_configuration_shape(&collapsed).is_err());

    let mut relative = configuration();
    relative.journal.path = PathBuf::from("relative.sqlite");
    assert!(validate_configuration_shape(&relative).is_err());
}

fn signing_authority_configuration() -> ProductCodexBrokerConfigurationV1 {
    let mut value = configuration();
    let key = SigningKey::from_bytes(&[7_u8; 32]).verifying_key();
    value.trust_bundle_authority_keys[0].public_key_base64 =
        Base64UrlUnpadded::encode_string(key.as_bytes());
    value
}

#[test]
fn authority_key_decoder_accepts_real_keys_and_rejects_bad_encodings() {
    let valid = signing_authority_configuration();
    assert!(decode_bundle_authority(&valid).is_ok());
    for encoded in ["", "AA", "not_base64!"] {
        let mut invalid = valid.clone();
        invalid.trust_bundle_authority_keys[0].public_key_base64 = encoded.to_owned();
        assert!(matches!(
            decode_bundle_authority(&invalid),
            Err(ProductCodexBrokerDaemonError::AuthorityKeys)
        ));
    }
    let mut padded = valid;
    padded.trust_bundle_authority_keys[0]
        .public_key_base64
        .push('=');
    assert!(matches!(
        decode_bundle_authority(&padded),
        Err(ProductCodexBrokerDaemonError::AuthorityKeys)
    ));
}

#[test]
fn authority_key_decoder_preserves_duplicate_and_weak_key_denials() {
    let mut duplicate = signing_authority_configuration();
    duplicate
        .trust_bundle_authority_keys
        .push(duplicate.trust_bundle_authority_keys[0].clone());
    assert!(matches!(
        decode_bundle_authority(&duplicate),
        Err(ProductCodexBrokerDaemonError::TrustBundle(
            TrustBundleError::DuplicateAuthorityKey(_)
        ))
    ));
    let weak = configuration();
    assert!(matches!(
        decode_bundle_authority(&weak),
        Err(ProductCodexBrokerDaemonError::TrustBundle(
            TrustBundleError::WeakAuthorityKey(_)
        ))
    ));
}

#[test]
fn absent_commit_acknowledgement_configuration_stays_fail_closed() {
    let configuration = configuration();
    let value = serde_json::to_value(&configuration).unwrap();
    assert!(value.get("commitAcknowledgement").is_none());
    let decoded: ProductCodexBrokerConfigurationV1 = serde_json::from_value(value).unwrap();
    assert!(decoded.commit_acknowledgement.is_none());
    validate_configuration_shape(&decoded).unwrap();
}

#[test]
fn commit_acknowledgement_shape_is_versioned_bounded_and_closed() {
    let mut configuration = configuration();
    configuration.commit_acknowledgement = Some(commit_acknowledgement_configuration());
    validate_configuration_shape(&configuration).unwrap();

    let mut invalid = configuration.clone();
    invalid.commit_acknowledgement.as_mut().unwrap().version = 1;
    assert!(validate_configuration_shape(&invalid).is_err());

    let mut invalid = configuration.clone();
    invalid
        .commit_acknowledgement
        .as_mut()
        .unwrap()
        .trust_store_generation = 0;
    assert!(validate_configuration_shape(&invalid).is_err());

    let mut invalid = configuration.clone();
    invalid
        .commit_acknowledgement
        .as_mut()
        .unwrap()
        .authority_domain_id = "bad domain".into();
    assert!(validate_configuration_shape(&invalid).is_err());

    let mut invalid = configuration.clone();
    invalid
        .commit_acknowledgement
        .as_mut()
        .unwrap()
        .maximum_age_ms = 24 * 60 * 60 * 1000 + 1;
    assert!(validate_configuration_shape(&invalid).is_err());

    let mut invalid = configuration.clone();
    invalid
        .commit_acknowledgement
        .as_mut()
        .unwrap()
        .commit_binding_source
        .database_path = "relative.sqlite".into();
    assert!(validate_configuration_shape(&invalid).is_err());

    let mut invalid = configuration.clone();
    invalid
        .commit_acknowledgement
        .as_mut()
        .unwrap()
        .commit_binding_source
        .busy_timeout_ms = 0;
    assert!(validate_configuration_shape(&invalid).is_err());

    let mut value = serde_json::to_value(configuration).unwrap();
    value["commitAcknowledgement"]["unknown"] = serde_json::json!(true);
    assert!(serde_json::from_value::<ProductCodexBrokerConfigurationV1>(value).is_err());
}

#[test]
fn commit_acknowledgement_key_decoder_is_canonical_and_preserves_denials() {
    let valid = commit_acknowledgement_configuration();
    assert!(decode_commit_acknowledgement_trust(&valid).is_ok());

    for encoded in ["", "AA", "not_base64!"] {
        let mut invalid = valid.clone();
        invalid.authority_keys[0].public_key_base64 = encoded.into();
        assert!(matches!(
            decode_commit_acknowledgement_trust(&invalid),
            Err(ProductCodexBrokerDaemonError::CommitAcknowledgementAuthorityKeys)
        ));
    }

    let mut duplicate = valid.clone();
    duplicate
        .authority_keys
        .push(duplicate.authority_keys[0].clone());
    assert!(matches!(
        decode_commit_acknowledgement_trust(&duplicate),
        Err(ProductCodexBrokerDaemonError::CommitAcknowledgement(
            CommitBoundAcknowledgementError::DuplicateSignerKey(_)
        ))
    ));

    let mut weak = valid;
    weak.authority_keys[0].public_key_base64 = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA".into();
    assert!(matches!(
        decode_commit_acknowledgement_trust(&weak),
        Err(ProductCodexBrokerDaemonError::CommitAcknowledgement(
            CommitBoundAcknowledgementError::WeakSignerKey(_)
        ))
    ));
}

#[test]
fn canary_daemon_profile_is_explicit_and_closed_to_the_two_fixed_roles() {
    let original = configuration();
    assert!(
        serde_json::to_value(&original)
            .unwrap()
            .get("purpose")
            .is_none()
    );
    let decoded: ProductCodexBrokerConfigurationV1 =
        serde_json::from_slice(&serde_json::to_vec(&original).unwrap()).unwrap();
    assert_eq!(decoded, original);
    for role in [
        AgentRole::Author,
        AgentRole::FormalReviewer,
        AgentRole::Reviewer,
        AgentRole::Repairer,
    ] {
        let mut selected = original.clone();
        selected.role = role;
        selected.purpose = crate::ProductCodexOperationPurposeV1::OneShotReadOnlyCanary;
        assert_eq!(
            super::config::validate_configuration_shape(&selected).is_ok(),
            matches!(role, AgentRole::Author | AgentRole::FormalReviewer)
        );
    }
}
