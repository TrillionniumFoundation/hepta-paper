//! Runnable, durable Rust campaign composition for controlled local/shadow use.
//!
//! The process worker boundary supports gradual migration without pretending a
//! Node bridge is native Rust. Credentials, production handoff and scientific
//! acceptance require their independent contracts; this service cannot mint them.

#![forbid(unsafe_code)]

pub mod advanced_numerical;
pub mod architecture_conformance;
pub mod automation_readiness_policy;
pub mod automation_runtime_reconciliation;
pub mod automation_status;
pub mod autonomous_empirical_plugin_release;
pub mod autonomous_intake_authority_rotation;
pub mod autonomous_provider_configuration;
pub mod autonomous_research;
pub mod autonomous_research_one_shot_campaign_attempt;
pub mod autonomous_state_partial_root_maintenance;
pub mod autonomous_state_provision;
pub mod autonomous_submission_dispatcher;
pub mod autonomous_submission_dispatcher_challenge;
pub mod campaign_policy;
pub mod campaign_slo;
pub mod command_surface;
mod control_error;
pub mod critical_module_coverage;
mod deployment;
pub mod deployment_environment;
pub mod external_action_recovery_configuration;
pub mod external_authority_intake;
pub mod external_qualification_configuration;
pub mod full_production_readiness;
pub mod full_suite_verification;
pub mod generic_domain_capability_evidence;
pub mod journal_connector_coverage;
pub mod local_golden_dataset;
pub mod local_state_authority;
pub mod local_state_authority_client;
pub mod machine_intake;
pub mod maintenance;
pub mod native_business;
pub mod native_workspace;
pub mod nested_runtime_cli;
pub mod nested_runtime_qualification;
pub mod node_migration;
pub(crate) mod node_package_deletion_writer;
mod objects;
pub mod online_authority_evidence_cache;
pub mod online_authority_inspection;
pub mod online_mutation_composition;
pub mod online_schema_execution;
pub mod online_schema_transition;
pub mod operational_status;
pub mod owner_status;
pub mod personal_self_hosted_formal;
pub mod personal_self_hosted_gpu;
pub mod personal_self_hosted_readiness;
pub(crate) mod personal_self_hosted_source;

pub mod portal_target_qualification;
pub mod pristine_runtime_state;
mod production;
pub mod qualification_stored_evidence;
pub mod release_attest;
pub mod release_integrity_key;
pub mod release_state;
pub mod release_trust_gate;
pub mod repository_assets;
pub mod resident_prerequisites;
pub mod retirement_matrix;
pub mod retirement_reference;
pub mod retirement_status;
pub mod runtime_image_reproducibility;
pub mod runtime_source_cas;
pub mod scientific_runtime;
pub mod sqlite_changeset;
pub mod sqlite_mutation_coordinator;
pub mod sqlite_mutation_plan;
mod state_access;
pub mod state_database_inventory;
pub mod state_recoverability;
pub mod state_safety;
pub mod store_status;
pub mod strict_full_auto_acceptance;
pub mod strict_machine_intake_reconciliation;
pub mod submission_handoff_export;
pub mod supervisor_health;
mod worker;
pub mod workflow;

use hepta_campaign_writer::{CampaignWriterPolicyV1, CampaignWriterStoreV1, WriterLeaseV1};
use hepta_codex_protocol::Sha256Digest;
use hepta_control_plane::{
    BoundedEventLogV1, ControlPlaneRunInspectionV1, ControlPlaneRunReceiptV1,
    ControlPlaneSnapshotV1, ControlPlaneV1, FilesystemPreparedResultVerifierV1, HardPolicyV1,
    PlannerPolicyV1, PlanningFrontierV1, ResourceAllocatorV1, SqliteCommitSequencerV1,
    canonical_hash_v1,
};
pub use hepta_cutover::{
    LegacyDeletionDrillArchiveCaptureV1, LegacyDeletionDrillAttestError,
    LegacyDeletionDrillAttestationInspectionV1, LegacyDeletionDrillAttestationRequestV1,
    LegacyNodeFreezeError, LegacyNodeFreezeReceiptV1, LegacyNodeFreezeSubjectV1,
    LegacyRollbackModeV1, VerifiedLegacyNodeFreezeV1, inspect_legacy_deletion_drill_attest_v1,
    verify_legacy_node_freeze_v1,
};
use hepta_module_platform::ModuleRegistryArtifactV1;
use serde::{Deserialize, Serialize};
use std::{collections::BTreeMap, fs, os::unix::fs::MetadataExt, path::PathBuf};
use thiserror::Error;

pub use control_error::service_control_inspection_report_v1;

pub use deployment::{
    LegacyNodeRuntimeDispositionV1, ProductionDeploymentError, ProductionDeploymentManifestV1,
    ProductionServiceRoleV1, ProductionServiceUnitV1, ProductionWritableRootV1,
    VerifiedProductionDeploymentV1, verify_production_deployment_v1,
};
pub use deployment::{
    ProductionAuthorityInstallationV2, ProductionAuthorityIpcRootV2,
    ProductionDeploymentManifestV2, ProductionPublicFileV2, ProductionServiceRoleV2,
    ProductionServiceUnitV2, RetainedProductionDeploymentV2, VerifiedProductionDeploymentV2,
    verify_production_deployment_v2,
};
pub use node_migration::{NodeMigrationError, NodeMigrationReceiptV1, migrate_node_store_v1};
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
    /// An invoked control-plane executor requires inspection; automatic retry is unsafe.
    ///
    /// The diagnostic is copied before the local runtime owner is dropped. It is
    /// not durable resource accounting, a worker outcome, or release authority.
    #[error("control-plane execution requires inspection; automatic retry is not authorized")]
    ControlRequiresInspection {
        /// Original runtime diagnostic, when available. Absence does not make retry safe.
        inspection: Option<Box<ControlPlaneRunInspectionV1>>,
    },
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
    // Outlive both executor and SQLite sequencer, irrespective of their field drop order.
    let _state_access = objects.clone();
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
        .map_err(|error| control_error::map_control_run_error(error, control.inspection_required()))
}

/// Hash the full run configuration, for external binding and review.
pub fn service_configuration_hash_v1(config: &ServiceRunV1) -> Result<Sha256Digest, ServiceError> {
    canonical_hash_v1(config).map_err(|_| ServiceError::Configuration)
}

pub mod online_finalized_head_inspection;
pub mod online_runtime_activation;

pub mod research_capability_matrix;

pub mod state_backup_authority;

pub mod online_writer_static;
pub mod workspace_status;
