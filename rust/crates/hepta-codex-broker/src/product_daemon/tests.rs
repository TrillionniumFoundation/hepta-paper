use std::{collections::BTreeMap, path::PathBuf, str::FromStr};

use hepta_codex_protocol::{AgentRole, Sha256Digest};

use crate::PeerPrincipalV1;

use super::{
    ProductBundleAuthorityKeyV1, ProductCgroupConfigurationV1,
    ProductCodexBrokerConfigurationV1, ProductJournalConfigurationV1,
    ProductListenerConfigurationV1, ProductProcessLimitsConfigurationV1,
    ProductRuntimeConfigurationV1, ProductServerConfigurationV1,
    config::validate_configuration_shape,
};

fn digest() -> Sha256Digest {
    Sha256Digest::from_str(&format!("sha256:{}", "1".repeat(64))).unwrap()
}

fn configuration() -> ProductCodexBrokerConfigurationV1 {
    ProductCodexBrokerConfigurationV1 {
        version: 1,
        configuration_authority_uid: 0,
        configuration_reader_gid: 1000,
        broker_uid: 1001,
        broker_gid: 1002,
        role: AgentRole::Author,
        operation_authority_uid: 1003,
        operation_directory: PathBuf::from("/etc/hepta/operations"),
        trust_bundle_path: PathBuf::from("/etc/hepta/trust/bundle.json"),
        trust_bundle_authority_uid: 1004,
        trust_bundle_reader_gid: 1005,
        trust_bundle_authority_keys: vec![ProductBundleAuthorityKeyV1 {
            key_id: "authority-key-1".to_owned(),
            public_key_base64: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA".to_owned(),
        }],
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
    let mut configuration = configuration();
    configuration.operation_authority_uid = configuration.broker_uid;
    assert!(validate_configuration_shape(&configuration).is_err());

    let mut configuration = configuration();
    configuration.journal.path = PathBuf::from("relative.sqlite");
    assert!(validate_configuration_shape(&configuration).is_err());
}
