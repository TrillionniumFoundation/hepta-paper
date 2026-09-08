//! Externally authorized production composition for the Rust control plane.
//!
//! The ordinary [`crate::run_service_v1`] path is permanently local/shadow. This
//! module is the only source path that may report production activation. It
//! requires an opaque complete external-qualification closure and an independent,
//! short-lived writer-cutover authorization bound to the exact repository, tree,
//! executable, configuration, host, service unit, database preimage and first
//! writer lease. JSON booleans, environment variables and worker payloads cannot
//! construct either authority value.

use std::{
    collections::BTreeMap,
    fs::{self, OpenOptions},
    io::Read,
    os::unix::fs::{MetadataExt, OpenOptionsExt},
    path::{Path, PathBuf},
    str::FromStr,
};

use hepta_campaign_writer::{
    CampaignWriterPolicyV1, CampaignWriterStoreV1, VerifiedWriterCutoverV1,
};
use hepta_codex_protocol::Sha256Digest;
use hepta_control_plane::{
    BoundedEventLogV1, ControlPlaneRunReceiptV1, ControlPlaneV1,
    FilesystemPreparedResultVerifierV1, ResourceAllocatorV1, SqliteCommitSequencerV1,
    canonical_hash_v1,
};
use hepta_module_platform::{
    ActivationStateV1, ModuleExecutionV1, ModuleKindV1, ModuleRegistryArtifactV1,
    QualificationTierV1,
};
use hepta_qualification_ingest::VerifiedExternalQualificationClosureV1;
use serde::Serialize;
use sha2::{Digest, Sha256};

use crate::{
    ObjectStoreV1, ServiceError, ServiceExecutorV1, ServiceRunV1, VerifiedLegacyNodeFreezeV1,
    VerifiedProductionDeploymentV1, WorkerBindingV1, native_implementation_hash_v1,
    service_configuration_hash_v1,
};

const MAXIMUM_PRODUCTION_BINARY_BYTES: u64 = 512 * 1024 * 1024;

/// Explicit activation stage reviewed by the external qualification subject.
#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ProductionActivationStageV1 {
    /// Bounded production canary with the unique Rust writer.
    Canary,
    /// Current authoritative Rust implementation.
    Authoritative,
}

/// Non-serializable production run input. Authority values are supplied
/// separately as already verified opaque types.
#[derive(Clone, Debug)]
pub struct ProductionServiceRunV1 {
    /// Contract version, exactly one.
    pub version: u16,
    /// Explicit canary or authoritative stage.
    pub stage: ProductionActivationStageV1,
    /// The canonical executable path for the currently running process.
    pub executable_path: PathBuf,
    /// Ordinary service plan. Its self-declared production flag remains false.
    pub service: ServiceRunV1,
}

/// Canonical proof that the Rust writer ran only after all independent gates.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProductionServiceReceiptV1 {
    /// Contract version.
    pub version: u16,
    /// Canary or authoritative activation.
    pub stage: ProductionActivationStageV1,
    /// Exact repository.
    pub repository: String,
    /// Exact commit SHA.
    pub commit: String,
    /// Exact tree SHA.
    pub tree: String,
    /// Complete seven-package qualification receipt.
    pub qualification_closure_hash: Sha256Digest,
    /// Independent writer-cutover authorization identity.
    pub writer_cutover_authorization_hash: Sha256Digest,
    /// Filesystem-verified Node-free deployment identity.
    pub deployment_identity_hash: Sha256Digest,
    /// Actual immutable legacy database drain/freeze receipt.
    pub legacy_node_freeze_hash: Sha256Digest,
    /// Exact running executable identity.
    pub executable_hash: Sha256Digest,
    /// Exact service configuration identity.
    pub configuration_hash: Sha256Digest,
    /// Non-activating core run receipt retained without rewriting its semantics.
    pub control_plane_receipt: ControlPlaneRunReceiptV1,
    /// This API never auto-promotes modules.
    pub automatic_activation: bool,
    /// True only because both opaque authorities and all runtime bindings passed.
    pub production_activation: bool,
    /// Canonical receipt hash excluding this field.
    pub receipt_hash: Sha256Digest,
}

/// Runs one production-authorized Rust control-plane plan.
///
/// This API deliberately accepts no Node/process bridge. Real external provider
/// work must arrive through separately qualified broker-prepared artifacts; this
/// composition itself owns only the unique campaign writer.
pub fn run_production_service_v1(
    config: ProductionServiceRunV1,
    qualification: &VerifiedExternalQualificationClosureV1,
    cutover: &VerifiedWriterCutoverV1,
    deployment: &VerifiedProductionDeploymentV1,
    legacy_freeze: &VerifiedLegacyNodeFreezeV1,
) -> Result<ProductionServiceReceiptV1, ServiceError> {
    validate_authority_bindings(&config, qualification, cutover, deployment, legacy_freeze)?;
    let registry = validate_production_registry(&config)?;
    let objects = ObjectStoreV1::open(&config.service.state_directory)?;
    let owner = fs::metadata(&config.service.state_directory)
        .map_err(|_| ServiceError::Filesystem)?
        .uid();
    let database_path = config.service.state_directory.join("campaign.sqlite");
    let policy = CampaignWriterPolicyV1::strict(owner);
    let mut store = CampaignWriterStoreV1::open_for_cutover(
        &database_path,
        policy,
        cutover,
        config.service.observed_at_unix_ms,
    )
    .map_err(|_| ServiceError::Persistence)?;
    let writer = store
        .acquire_writer(
            config.service.writer_lease.clone(),
            config.service.observed_at_unix_ms,
        )
        .map_err(|_| ServiceError::Persistence)?;
    match store.load_campaign(&config.service.snapshot.campaign_id) {
        Ok(_) => {}
        Err(_) => {
            store
                .create_campaign(
                    &writer,
                    &config.service.snapshot.campaign_id,
                    config.service.snapshot.budget_microusd,
                    config.service.snapshot.resource_limit.cpu_millis,
                    config.service.snapshot.resource_limit.gpu_millis,
                    config.service.observed_at_unix_ms,
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
        config.service.snapshot.campaign_id.clone(),
        config.service.initial_state_hash.clone(),
        config.service.verifier_hash.clone(),
        config.service.observed_at_unix_ms,
    )
    .map_err(|_| ServiceError::Persistence)?;
    let tenant = config.service.snapshot.campaign_id.clone();
    let allocator = ResourceAllocatorV1::new(
        config.service.snapshot.resource_limit,
        BTreeMap::from([(tenant.clone(), config.service.snapshot.resource_limit)]),
        BTreeMap::from([(tenant.clone(), 1)]),
        1,
    )
    .map_err(|_| ServiceError::Control)?;
    let verifier = FilesystemPreparedResultVerifierV1::new(
        objects.root(),
        config.service.verifier_hash.clone(),
        objects.maximum_object_bytes(),
    )
    .map_err(|_| ServiceError::Artifact)?;
    let executor = ServiceExecutorV1::new(objects, config.service.workers.clone())?;
    let mut control = ControlPlaneV1::new(
        registry,
        config.service.hard_policy.registry_policy_hash.clone(),
        config.service.hard_policy.clone(),
        config.service.planner_policy.clone(),
        allocator,
        executor,
        verifier,
        sequencer,
        BoundedEventLogV1::new(100_000, 100_000).map_err(|_| ServiceError::Control)?,
    )
    .map_err(|_| ServiceError::Control)?;
    let control_plane_receipt = control
        .run(
            &config.service.snapshot,
            &config.service.frontier,
            &tenant,
            config.service.observed_at_unix_ms,
        )
        .map_err(|_| ServiceError::Control)?;
    if control_plane_receipt.automatic_activation || control_plane_receipt.production_activation {
        return Err(ServiceError::Control);
    }
    for receipt in &control_plane_receipt.commit_receipts {
        if receipt.production_activation {
            return Err(ServiceError::Control);
        }
    }
    build_receipt(
        &config,
        qualification,
        cutover,
        deployment,
        legacy_freeze,
        control_plane_receipt,
    )
}

fn validate_authority_bindings(
    config: &ProductionServiceRunV1,
    qualification: &VerifiedExternalQualificationClosureV1,
    cutover: &VerifiedWriterCutoverV1,
    deployment: &VerifiedProductionDeploymentV1,
    legacy_freeze: &VerifiedLegacyNodeFreezeV1,
) -> Result<(), ServiceError> {
    if config.version != 1
        || config.service.version != 1
        || config.service.production_activation
        || config.service.hard_policy.external_actions_authorized
        || config.service.observed_at_unix_ms == 0
        || config.service.writer_lease.expires_at_unix_ms <= config.service.observed_at_unix_ms
        || config.service.workers.is_empty()
        || config.service.workers.len() > 256
    {
        return Err(ServiceError::Configuration);
    }
    qualification
        .assert_current(config.service.observed_at_unix_ms)
        .map_err(|_| ServiceError::Configuration)?;
    let qualified_subject = qualification.subject();
    let cutover_subject = cutover.subject();
    if qualified_subject.repository != cutover_subject.repository
        || qualified_subject.commit != cutover_subject.commit_sha
        || qualified_subject.tree != cutover_subject.tree_sha
        || qualified_subject.repository != deployment.repository()
        || qualified_subject.commit != deployment.commit()
        || qualified_subject.tree != deployment.tree()
        || qualified_subject.repository != legacy_freeze.subject().repository
        || qualified_subject.commit != legacy_freeze.subject().commit
        || qualified_subject.tree != legacy_freeze.subject().tree
    {
        return Err(ServiceError::Configuration);
    }
    let facts = qualification.runtime_facts();
    let host = parse_digest(&facts.host_identity_hash)?;
    let service = parse_digest(&facts.service_identity_hash)?;
    let database = parse_digest(&facts.database_identity_hash)?;
    if host != cutover_subject.host_identity_hash
        || service != cutover_subject.service_identity_hash
        || service != *deployment.identity_hash()
        || database != *cutover.database_preimage_hash()
    {
        return Err(ServiceError::Configuration);
    }
    let executable_hash = stable_current_executable_hash(&config.executable_path)?;
    let configuration_hash = service_configuration_hash_v1(&config.service)?;
    if executable_hash != cutover_subject.binary_hash
        || executable_hash != *deployment.control_executable_hash()
        || config.executable_path.as_path() != deployment.control_executable_path()
        || configuration_hash != cutover_subject.configuration_hash
    {
        return Err(ServiceError::Configuration);
    }
    Ok(())
}

fn validate_production_registry(
    config: &ProductionServiceRunV1,
) -> Result<ModuleRegistryArtifactV1, ServiceError> {
    let registry = ModuleRegistryArtifactV1::decode_json(
        config.service.registry_json.as_bytes(),
        &config.service.hard_policy.registry_policy_hash,
    )
    .map_err(|_| ServiceError::Configuration)?;
    for registered in registry.modules().values() {
        if registered.manifest.module_kind == ModuleKindV1::LegacyNodeAdapter
            && registered.manifest.requested_activation != ActivationStateV1::Retired
        {
            return Err(ServiceError::Configuration);
        }
    }
    let required_activation = match config.stage {
        ProductionActivationStageV1::Canary => ActivationStateV1::Canary,
        ProductionActivationStageV1::Authoritative => ActivationStateV1::Authoritative,
    };
    for (module_id, worker) in &config.service.workers {
        if !matches!(worker, WorkerBindingV1::Native) {
            return Err(ServiceError::Configuration);
        }
        let registered = registry
            .module(module_id)
            .map_err(|_| ServiceError::Configuration)?;
        if registered.manifest.requested_activation != required_activation
            || registered.manifest.qualification != QualificationTierV1::ExternalAuthority
        {
            return Err(ServiceError::Configuration);
        }
        let ModuleExecutionV1::InProcess {
            implementation_hash,
        } = &registered.manifest.execution
        else {
            return Err(ServiceError::Configuration);
        };
        if implementation_hash != &native_implementation_hash_v1()? {
            return Err(ServiceError::Configuration);
        }
    }
    Ok(registry)
}

fn build_receipt(
    config: &ProductionServiceRunV1,
    qualification: &VerifiedExternalQualificationClosureV1,
    cutover: &VerifiedWriterCutoverV1,
    deployment: &VerifiedProductionDeploymentV1,
    legacy_freeze: &VerifiedLegacyNodeFreezeV1,
    control_plane_receipt: ControlPlaneRunReceiptV1,
) -> Result<ProductionServiceReceiptV1, ServiceError> {
    let qualification_closure_hash = parse_digest(qualification.receipt_hash())?;
    let executable_hash = stable_current_executable_hash(&config.executable_path)?;
    let configuration_hash = service_configuration_hash_v1(&config.service)?;
    let body = ProductionReceiptBodyV1 {
        version: 1,
        stage: config.stage,
        repository: &qualification.subject().repository,
        commit: &qualification.subject().commit,
        tree: &qualification.subject().tree,
        qualification_closure_hash: &qualification_closure_hash,
        writer_cutover_authorization_hash: cutover.authorization_hash(),
        deployment_identity_hash: deployment.identity_hash(),
        legacy_node_freeze_hash: legacy_freeze.receipt_hash(),
        executable_hash: &executable_hash,
        configuration_hash: &configuration_hash,
        control_plane_receipt: &control_plane_receipt,
        automatic_activation: false,
        production_activation: true,
    };
    let receipt_hash = canonical_hash_v1(&body).map_err(|_| ServiceError::Configuration)?;
    Ok(ProductionServiceReceiptV1 {
        version: 1,
        stage: config.stage,
        repository: qualification.subject().repository.clone(),
        commit: qualification.subject().commit.clone(),
        tree: qualification.subject().tree.clone(),
        qualification_closure_hash,
        writer_cutover_authorization_hash: cutover.authorization_hash().clone(),
        deployment_identity_hash: deployment.identity_hash().clone(),
        legacy_node_freeze_hash: legacy_freeze.receipt_hash().clone(),
        executable_hash,
        configuration_hash,
        control_plane_receipt,
        automatic_activation: false,
        production_activation: true,
        receipt_hash,
    })
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ProductionReceiptBodyV1<'a> {
    version: u16,
    stage: ProductionActivationStageV1,
    repository: &'a str,
    commit: &'a str,
    tree: &'a str,
    qualification_closure_hash: &'a Sha256Digest,
    writer_cutover_authorization_hash: &'a Sha256Digest,
    deployment_identity_hash: &'a Sha256Digest,
    legacy_node_freeze_hash: &'a Sha256Digest,
    executable_hash: &'a Sha256Digest,
    configuration_hash: &'a Sha256Digest,
    control_plane_receipt: &'a ControlPlaneRunReceiptV1,
    automatic_activation: bool,
    production_activation: bool,
}

fn parse_digest(value: &str) -> Result<Sha256Digest, ServiceError> {
    Sha256Digest::from_str(value).map_err(|_| ServiceError::Configuration)
}

fn stable_current_executable_hash(path: &Path) -> Result<Sha256Digest, ServiceError> {
    if !path.is_absolute()
        || fs::canonicalize(path).ok().as_deref() != Some(path)
        || fs::canonicalize(std::env::current_exe().map_err(|_| ServiceError::Filesystem)?)
            .ok()
            .as_deref()
            != Some(path)
    {
        return Err(ServiceError::Configuration);
    }
    let before = fs::symlink_metadata(path).map_err(|_| ServiceError::Filesystem)?;
    let current_uid = fs::metadata("/proc/self")
        .map_err(|_| ServiceError::Filesystem)?
        .uid();
    if !before.is_file()
        || before.nlink() != 1
        || before.mode() & 0o022 != 0
        || before.uid() == current_uid
        || before.size() == 0
        || before.size() > MAXIMUM_PRODUCTION_BINARY_BYTES
    {
        return Err(ServiceError::Configuration);
    }
    let mut file = OpenOptions::new()
        .read(true)
        .custom_flags(nix::fcntl::OFlag::O_NOFOLLOW.bits())
        .open(path)
        .map_err(|_| ServiceError::Filesystem)?;
    let opened = file.metadata().map_err(|_| ServiceError::Filesystem)?;
    if !same_file(&before, &opened) {
        return Err(ServiceError::Configuration);
    }
    let capacity = usize::try_from(opened.size()).map_err(|_| ServiceError::Configuration)?;
    let mut bytes = Vec::with_capacity(capacity);
    (&mut file)
        .take(MAXIMUM_PRODUCTION_BINARY_BYTES.saturating_add(1))
        .read_to_end(&mut bytes)
        .map_err(|_| ServiceError::Filesystem)?;
    let after_open = file.metadata().map_err(|_| ServiceError::Filesystem)?;
    let after_path = fs::symlink_metadata(path).map_err(|_| ServiceError::Filesystem)?;
    if u64::try_from(bytes.len()).map_err(|_| ServiceError::Configuration)? != opened.size()
        || !same_file(&opened, &after_open)
        || !same_file(&after_open, &after_path)
    {
        return Err(ServiceError::Configuration);
    }
    Sha256Digest::from_str(&format!("sha256:{}", hex::encode(Sha256::digest(bytes))))
        .map_err(|_| ServiceError::Configuration)
}

fn same_file(left: &fs::Metadata, right: &fs::Metadata) -> bool {
    left.dev() == right.dev()
        && left.ino() == right.ino()
        && left.mode() == right.mode()
        && left.uid() == right.uid()
        && left.gid() == right.gid()
        && left.nlink() == right.nlink()
        && left.size() == right.size()
        && left.mtime() == right.mtime()
        && left.mtime_nsec() == right.mtime_nsec()
        && left.ctime() == right.ctime()
        && left.ctime_nsec() == right.ctime_nsec()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn stage_serialization_is_closed() {
        assert_eq!(
            serde_json::to_string(&ProductionActivationStageV1::Canary).expect("stage JSON"),
            "\"canary\""
        );
        assert_eq!(
            serde_json::to_string(&ProductionActivationStageV1::Authoritative).expect("stage JSON"),
            "\"authoritative\""
        );
    }

    #[test]
    fn arbitrary_digest_text_is_rejected() {
        assert!(parse_digest("not-a-digest").is_err());
    }
}
