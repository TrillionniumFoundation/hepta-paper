use std::{
    collections::BTreeMap,
    ffi::OsString,
    os::unix::ffi::OsStrExt,
    path::Path,
    str::FromStr,
    sync::{Arc, atomic::AtomicBool},
};

use base64ct::{Base64UrlUnpadded, Encoding};
use ed25519_dalek::VerifyingKey;
use hepta_codex_protocol::{AgentRole, Sha256Digest};
use hepta_codex_runtime::{
    CgroupV2PolicyV1, CodexInvocationPolicyV1, DurableGatePolicyV1, RuntimeIdentityPolicyV1,
    codex_parent_environment_policy_v1, inspect_codex_runtime_identity,
};
use sha2::{Digest, Sha256};

use crate::{
    AdmissionPolicyV1, BrokerClockV1, BrokerJournalPolicyV1, BrokerJournalStoreV1,
    BrokerListenerAccessModeV1, BrokerListenerPolicyV1, BrokerListenerV1,
    BrokerResponseFramePolicyV1, BrokerRolePolicyV1, BrokerServerPolicyV1,
    BrokerServerRunSummaryV1, BrokerServerV1, CapabilityBundleAuthorityV1,
    CapabilityTrustBundleManagerV1, CapabilityTrustBundleSourcePolicyV1, PeerPolicyV1,
    ProductCodexDispatcherConfigurationV1, ProductCodexDispatcherV1, SystemBrokerClockV1,
    load_signed_capability_trust_bundle, verify_capability_trust_bundle,
};

use super::{
    LoadedProductCodexBrokerConfigurationV1, ProductCodexBrokerConfigurationV1,
    ProductCodexBrokerDaemonError,
};

pub fn compose_product_codex_broker(
    loaded: LoadedProductCodexBrokerConfigurationV1,
    shutdown: Arc<AtomicBool>,
) -> Result<BrokerServerV1, ProductCodexBrokerDaemonError> {
    let configuration = loaded.configuration;
    let parent_environment = codex_parent_environment_policy_v1()
        .build(
            configuration
                .runtime
                .parent_environment
                .iter()
                .map(|(key, value)| (OsString::from(key.as_str()), OsString::from(value.as_str()))),
            &BTreeMap::new(),
        )
        .map_err(|_| ProductCodexBrokerDaemonError::Environment)?;
    let mut runtime_identity_policy = RuntimeIdentityPolicyV1::strict(
        configuration.runtime.executable_owner_uid,
        configuration.broker_uid,
    );
    runtime_identity_policy.binary_owner_gid = configuration.runtime.executable_owner_gid;
    runtime_identity_policy.home_owner_gid = Some(configuration.broker_gid);
    runtime_identity_policy.credential_material_paths =
        configuration.runtime.credential_material_paths.clone();
    runtime_identity_policy.maximum_executable_bytes =
        configuration.runtime.maximum_executable_bytes;
    runtime_identity_policy.maximum_config_bytes = configuration.runtime.maximum_config_bytes;
    let runtime = inspect_codex_runtime_identity(
        configuration.runtime.executable.as_os_str(),
        &configuration.runtime.codex_home,
        &configuration.runtime.model_selector,
        parent_environment.policy_hash.clone(),
        configuration.runtime.transport_profile_hash.clone(),
        &BTreeMap::new(),
        &runtime_identity_policy,
    )?;
    let invocation_policy = CodexInvocationPolicyV1::separate_schema_authority(
        configuration.broker_uid,
        configuration.broker_gid,
        configuration.operation_authority_uid,
    );
    let gate_policy = DurableGatePolicyV1::separate_gate_authority(
        configuration.gate_executable.clone(),
        configuration.gate_state_directory.clone(),
        configuration.broker_uid,
        configuration.gate_authority_uid,
    );
    let mut cgroup_policy = CgroupV2PolicyV1::production(
        configuration.cgroup.delegated_root.clone(),
        configuration.broker_uid,
    );
    cgroup_policy.pids_max = configuration.cgroup.pids_max;
    cgroup_policy.memory_max = configuration.cgroup.memory_max;
    cgroup_policy.cpu_quota_us = configuration.cgroup.cpu_quota_us;
    cgroup_policy.cpu_period_us = configuration.cgroup.cpu_period_us;
    cgroup_policy.cleanup_timeout_ms = configuration.cgroup.cleanup_timeout_ms;
    cgroup_policy.poll_interval_ms = configuration.cgroup.poll_interval_ms;
    let clock = Arc::new(SystemBrokerClockV1);
    let dispatcher = Arc::new(ProductCodexDispatcherV1::new(
        ProductCodexDispatcherConfigurationV1 {
            role: configuration.role,
            broker_uid: configuration.broker_uid,
            broker_gid: configuration.broker_gid,
            operation_authority_uid: configuration.operation_authority_uid,
            operation_directory: configuration.operation_directory.clone(),
            runtime: runtime.clone(),
            runtime_identity_policy,
            parent_environment,
            model_child_environment_base: configuration
                .runtime
                .model_child_environment_base
                .clone(),
            invocation_policy,
            process_limits: configuration.process_limits.into(),
            gate_policy,
            cgroup_policy,
            clock: clock.clone(),
        },
    )?);
    let now_unix_ms = clock.now_unix_ms()?;
    let trust_authority = decode_bundle_authority(&configuration)?;
    let trust_source_policy = CapabilityTrustBundleSourcePolicyV1::strict(
        configuration.trust_bundle_authority_uid,
        configuration.trust_bundle_reader_gid,
        configuration.broker_uid,
    );
    let loaded_bundle =
        load_signed_capability_trust_bundle(&configuration.trust_bundle_path, trust_source_policy)?;
    let verified_bundle = verify_capability_trust_bundle(
        &loaded_bundle.envelope,
        configuration.role,
        now_unix_ms,
        &trust_authority,
        None,
    )?;
    let trust_bundle_hash = verified_bundle.bundle_hash().clone();
    let trust_manager = Arc::new(CapabilityTrustBundleManagerV1::new(verified_bundle));
    let peer_policy = PeerPolicyV1::new(configuration.allowed_peers.clone())?;
    let peer_policy_hash = peer_policy.policy_hash()?;
    let role_policy = match configuration.role {
        AgentRole::Author => BrokerRolePolicyV1::author(runtime.identity_hash.clone()),
        AgentRole::Reviewer => BrokerRolePolicyV1::reviewer(runtime.identity_hash.clone()),
        AgentRole::FormalReviewer => {
            BrokerRolePolicyV1::formal_reviewer(runtime.identity_hash.clone())
        }
        AgentRole::Repairer => BrokerRolePolicyV1::repairer(runtime.identity_hash.clone()),
    };
    let admission_policy = AdmissionPolicyV1::for_role(role_policy);
    let journal_policy = BrokerJournalPolicyV1 {
        version: 1,
        owner_uid: configuration.broker_uid,
        owner_gid: Some(configuration.broker_gid),
        busy_timeout_ms: configuration.journal.busy_timeout_ms,
        maximum_database_bytes: configuration.journal.maximum_database_bytes,
    };
    let journal = BrokerJournalStoreV1::open(&configuration.journal.path, journal_policy)?;
    journal.validate_integrity()?;
    drop(journal);
    let listener = BrokerListenerV1::bind(BrokerListenerPolicyV1 {
        version: 1,
        socket_path: configuration.listener.socket_path.clone(),
        parent_owner_uid: configuration.listener.parent_owner_uid,
        parent_owner_gid: Some(configuration.listener.parent_group_gid),
        parent_mode: 0o710,
        service_uid: configuration.broker_uid,
        service_gid: configuration.broker_gid,
        socket_mode: 0o660,
        access_mode: BrokerListenerAccessModeV1::SharedRoleGroup,
        instance_generation: configuration.listener.instance_generation,
        backlog: configuration.listener.listen_backlog,
        role: configuration.role,
        runtime_identity_hash: runtime.identity_hash.clone(),
        trust_bundle_hash,
        journal_path_hash: hash_path("ProductBrokerJournalPathV1", &configuration.journal.path)?,
        peer_policy_hash,
    })?;
    let server_policy = BrokerServerPolicyV1 {
        version: 1,
        worker_threads: configuration.server.worker_threads,
        queue_capacity: configuration.server.queue_capacity,
        accept_poll_ms: configuration.server.accept_poll_ms,
        write_timeout_ms: configuration.server.write_timeout_ms,
        busy_retry_after_ms: configuration.server.busy_retry_after_ms,
        maximum_connections: configuration.server.maximum_connections,
        startup_process_limits: configuration.process_limits.into(),
    };
    Ok(BrokerServerV1::new(
        listener,
        peer_policy,
        trust_manager,
        admission_policy,
        configuration.journal.path,
        journal_policy,
        server_policy,
        BrokerResponseFramePolicyV1 {
            maximum_payload_bytes: configuration.server.maximum_response_bytes,
        },
        clock,
        shutdown,
    )?
    .with_dispatcher(dispatcher))
}

pub fn run_product_codex_broker(
    configuration_path: &Path,
    shutdown: Arc<AtomicBool>,
) -> Result<BrokerServerRunSummaryV1, ProductCodexBrokerDaemonError> {
    compose_product_codex_broker(
        super::load_product_codex_broker_configuration(configuration_path)?,
        shutdown,
    )?
    .run()
    .map_err(ProductCodexBrokerDaemonError::Server)
}

fn decode_bundle_authority(
    configuration: &ProductCodexBrokerConfigurationV1,
) -> Result<CapabilityBundleAuthorityV1, ProductCodexBrokerDaemonError> {
    let mut keys = Vec::with_capacity(configuration.trust_bundle_authority_keys.len());
    for entry in &configuration.trust_bundle_authority_keys {
        let bytes = Base64UrlUnpadded::decode_vec(&entry.public_key_base64)
            .map_err(|_| ProductCodexBrokerDaemonError::AuthorityKeys)?;
        if Base64UrlUnpadded::encode_string(&bytes) != entry.public_key_base64 {
            return Err(ProductCodexBrokerDaemonError::AuthorityKeys);
        }
        let value: [u8; 32] = bytes
            .try_into()
            .map_err(|_| ProductCodexBrokerDaemonErDaemonError::AuthorityKeys)?;
        let key = VerifyingKey::from_bytes(&value)
            .map_err(|_| ProductCodexBrokerDaemonError::AuthorityKeys)?;
        keys.push((entry.key_id.clone(), key));
    }
    CapabilityBundleAuthorityV1::new(keys).map_err(ProductCodexBrokerDaemonErDaemonError::TrustBundle)
}

fn hash_path(domain: &str, path: &Path) -> Result<Sha256Digest, ProductCodexBrokerDaemonError> {
    let mut hasher = Sha256::new();
    update_length_prefixed(&mut hasher, domain.as_bytes());
    update_length_prefixed(&mut hasher, path.as_os_str().as_bytes());
    Sha256Digest::from_str(&format!("sha256:{}", hex::encode(hasher.finalize())))
        .map_err(|_| ProductCodexBrokerDaemonError::Digest)
}

fn update_length_prefixed(hasher: &mut Sha256, bytes: &[u8]) {
    hasher.update(u64::try_from(bytes.len()).unwrap_or(u64::MAX).to_be_bytes());
    hasher.update(bytes);
}
