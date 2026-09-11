//! Runnable, durable Rust campaign composition for controlled local/shadow use.
//!
//! The process worker boundary supports gradual migration without pretending a
//! Node bridge is native Rust. Credentials, production handoff and scientific
//! acceptance require their independent contracts; this service cannot mint them.

#![forbid(unsafe_code)]

mod deployment;
pub mod native_business;
mod objects;
mod production;
mod worker;

use hepta_campaign_writer::{CampaignWriterPolicyV1, CampaignWriterStoreV1, WriterLeaseV1};
use hepta_codex_protocol::Sha256Digest;
use hepta_control_plane::{
    BoundedEventLogV1, ControlPlaneRunReceiptV1, ControlPlaneSnapshotV1, ControlPlaneV1,
    FilesystemPreparedResultVerifierV1, HardPolicyV1, PlannerPolicyV1, PlanningFrontierV1,
    ResourceAllocatorV1, SqliteCommitSequencerV1, canonical_hash_v1,
};
pub use hepta_cutover::{
    LegacyNodeFreezeError, LegacyNodeFreezeReceiptV1, LegacyNodeFreezeSubjectV1,
    LegacyRollbackModeV1, VerifiedLegacyNodeFreezeV1, verify_legacy_node_freeze_v1,
};
use hepta_module_platform::ModuleRegistryArtifactV1;
use serde::{Deserialize, Serialize};
use std::{collections::BTreeMap, fs, os::unix::fs::MetadataExt, path::PathBuf};
use thiserror::Error;

pub use deployment::{
    LegacyNodeRuntimeDispositionV1, ProductionDeploymentError, ProductionDeploymentManifestV1,
    ProductionServiceRoleV1, ProductionServiceUnitV1, ProductionWritableRootV1,
    VerifiedProductionDeploymentV1, verify_production_deployment_v1,
};
pub use objects::ObjectStoreV1;
pub use production::{
    ProductionActivationStageV1, ProductionServiceReceiptV1, ProductionServiceRunV1,
    run_production_service_v1,
};
pub use worker::{
    NativeJobV1, ServiceExecutorV1, WorkerBindingV1, WorkerResponseV1,
    native_implementation_hash_v1,
};

/// Closed run configuration. A shadow database is a distinct marked database.
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ServiceRunV1 {
    /// Protocol version, exactly one.
    pub version: u16,
    /// Must be false: external production authorization is never a JSON boolean.
    pub production_activation: bool,
    /// Private durable state directory, canonical and absolute.
    pub state_directory: PathBuf,
    /// Exact canonical registry JSON bytes, retained as a string to preserve
    /// the registry protocol's required field ordering during transport.
    pub registry_json: String,
    /// Hard constraints, including no external effects.
    pub hard_policy: HardPolicyV1,
    /// Bounded optimizer policy.
    pub planner_policy: PlannerPolicyV1,
    /// Frozen state subject; fresh starts use revision one.
    pub snapshot: ControlPlaneSnapshotV1,
    /// Canonical candidate set, with payloads stored by content hash.
    pub frontier: PlanningFrontierV1,
    /// Independent verifier implementation/configuration identity.
    pub verifier_hash: Sha256Digest,
    /// Initial state hash for this persistent campaign history.
    pub initial_state_hash: Sha256Digest,
    /// Locally issued generation and unguessable token, never a production grant.
    pub writer_lease: WriterLeaseV1,
    /// Explicit qualification/drill clock, must be monotonic and within lease.
    pub observed_at_unix_ms: u64,
    /// Allowlisted workers keyed by registered module ID. No shell command parsing.
    pub workers: BTreeMap<String, WorkerBindingV1>,
}

/// Closed operational failures; error output never contains worker stdout/secrets.
#[derive(Debug, Error)]
pub enum ServiceError {
    /// Malformed configuration or production-authority request.
    #[error("invalid service configuration or authority boundary")]
    Configuration,
    /// Content identity/size/path validation failed.
    #[error("artifact content or private path validation failed")]
    Artifact,
    /// Failed durable filesystem operation.
    #[error("service filesystem operation failed")]
    Filesystem,
    /// Worker contract failed or an uncertain earlier attempt requires reconciliation.
    #[error("worker failed or previous execution requires reconciliation")]
    Execution,
    /// Database lease/state validation failed.
    #[error("campaign database or lease rejected operation")]
    Persistence,
    /// Scheduling, verification or commit rejected operation.
    #[error("control-plane operation rejected")]
    Control,
}

/// Execute one admitted campaign plan using actual CAS bytes and durable SQLite.
///
/// A started external worker without a prepared cache is never retried on restart.
/// Committed plans can be replayed using their identical snapshot and prepared
/// objects, while new plans must bind the recovered campaign state/revision.
pub fn run_service_v1(config: ServiceRunV1) -> Result<ControlPlaneRunReceiptV1, ServiceError> {
    if config.version != 1
        || config.production_activation
        || config.hard_policy.external_actions_authorized
        || config.observed_at_unix_ms == 0
        || config.workers.len() > 256
        || config.writer_lease.expires_at_unix_ms <= config.observed_at_unix_ms
    {
        return Err(ServiceError::Configuration);
    }
    let registry = ModuleRegistryArtifactV1::decode_json(
        config.registry_json.as_bytes(),
        &config.hard_policy.registry_policy_hash,
    )
    .map_err(|_| ServiceError::Configuration)?;
    for (id, worker) in &config.workers {
        let registered = registry
            .module(id)
            .map_err(|_| ServiceError::Configuration)?;
        let matches = match (&registered.manifest.execution, worker) {
            (
                hepta_module_platform::ModuleExecutionV1::InProcess {
                    implementation_hash,
                },
                WorkerBindingV1::Native,
            ) => implementation_hash == &native_implementation_hash_v1()?,
            (
                hepta_module_platform::ModuleExecutionV1::IsolatedProcess {
                    executable_hash,
                    configuration_hash,
                    network_declared,
                },
                WorkerBindingV1::Process {
                    executable_hash: supplied,
                    network_declared: declared,
                    ..
                },
            ) => {
                executable_hash == supplied
                    && network_declared == declared
                    && configuration_hash
                        == &canonical_hash_v1(worker).map_err(|_| ServiceError::Configuration)?
            }
            _ => false,
        };
        if !matches {
            return Err(ServiceError::Configuration);
        }
    }
    let objects = ObjectStoreV1::open(&config.state_directory)?;
    let owner = fs::metadata(&config.state_directory)
        .map_err(|_| ServiceError::Filesystem)?
        .uid();
    let db_path = config.state_directory.join("campaign.sqlite");
    let policy = CampaignWriterPolicyV1::strict(owner);
    let mut store = if db_path.exists() {
        CampaignWriterStoreV1::open_local(&db_path, policy)
    } else {
        CampaignWriterStoreV1::create_local(&db_path, policy)
    }
    .map_err(|_| ServiceError::Persistence)?;
    let writer = store
        .acquire_writer(config.writer_lease, config.observed_at_unix_ms)
        .map_err(|_| ServiceError::Persistence)?;
    match store.load_campaign(&config.snapshot.campaign_id) {
        Ok(_) => (),
        Err(_) => {
            store
                .create_campaign(
                    &writer,
                    &config.snapshot.campaign_id,
                    config.snapshot.budget_microusd,
                    config.snapshot.resource_limit.cpu_millis,
                    config.snapshot.resource_limit.gpu_millis,
                    config.observed_at_unix_ms,
                )
                .map_err(|_| ServiceError::Persistence)?;
        }
    }
    store
        .validate_integrity()
        .map_err(|_| ServiceError::Persistence)?;
    let sequencer = SqliteCommitSequencerV1::new(
        store,
        writer,
        config.snapshot.campaign_id.clone(),
        config.initial_state_hash,
        config.verifier_hash.clone(),
        config.observed_at_unix_ms,
    )
    .map_err(|_| ServiceError::Persistence)?;
    // Persistent sequencer independently validates plan replay and current state.
    let tenant = config.snapshot.campaign_id.clone();
    let allocator = ResourceAllocatorV1::new(
        config.snapshot.resource_limit,
        BTreeMap::from([(tenant.clone(), config.snapshot.resource_limit)]),
        BTreeMap::from([(tenant.clone(), 1)]),
        1,
    )
    .map_err(|_| ServiceError::Control)?;
    let verifier = FilesystemPreparedResultVerifierV1::new(
        objects.root(),
        config.verifier_hash,
        objects.maximum_object_bytes(),
    )
    .map_err(|_| ServiceError::Artifact)?;
    let executor = ServiceExecutorV1::new(objects, config.workers)?;
    let mut control = ControlPlaneV1::new(
        registry,
        config.hard_policy.registry_policy_hash.clone(),
        config.hard_policy,
        config.planner_policy,
        allocator,
        executor,
        verifier,
        sequencer,
        BoundedEventLogV1::new(100_000, 100_000).map_err(|_| ServiceError::Control)?,
    )
    .map_err(|_| ServiceError::Control)?;
    control
        .run(
            &config.snapshot,
            &config.frontier,
            &tenant,
            config.observed_at_unix_ms,
        )
        .map_err(|_| ServiceError::Control)
}

/// Hash the full run configuration, for external binding and review.
pub fn service_configuration_hash_v1(config: &ServiceRunV1) -> Result<Sha256Digest, ServiceError> {
    canonical_hash_v1(config).map_err(|_| ServiceError::Configuration)
}
