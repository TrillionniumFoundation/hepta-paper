//! Integrate an existing native prepared result without running any worker.
//! Planning is read-only; apply is an explicit fenced local database commit.
use super::*;
use crate::{ObjectStoreV1, ServiceRunV1, workflow::prepared_recovery_facts_at};
use hepta_campaign_writer::{CampaignStateV1, CampaignWriterPolicyV1, CampaignWriterStoreV1};
use hepta_control_plane::{
    BoundedEventLogV1, CommitReceiptV1, ControlPlaneError, ControlPlaneV1, ExecutionRequestV1,
    FilesystemPreparedResultVerifierV1, ModuleExecutorV1, ResourceAllocatorV1,
    SqliteCommitSequencerV1,
};
use hepta_module_platform::{ModuleRegistryArtifactV1, PreparedResultV1};
use std::collections::BTreeMap;

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PreparedReconciliationPlanV1 {
    pub version: u16,
    pub state_directory: PathBuf,
    pub definition_hash: Sha256Digest,
    pub inventory_hash: Sha256Digest,
    pub campaign_revision: u64,
    pub sequence: u64,
    pub plan_hash: Sha256Digest,
    pub prepared_result_hash: Sha256Digest,
    pub configuration_hash: Sha256Digest,
    pub production_activation: bool,
}
impl PreparedReconciliationPlanV1 {
    pub fn request_hash(&self) -> Result<Sha256Digest, ServiceError> {
        if self.version != 1
            || self.production_activation
            || self.sequence == 0
            || self.sequence > 128
            || self.campaign_revision == 0
            || !self.state_directory.is_absolute()
        {
            return Err(ServiceError::Configuration);
        }
        digest(
            &serde_json::to_vec(&("HeptaPreparedOnlyReconciliationV1", self))
                .map_err(|_| ServiceError::Artifact)?,
        )
    }
}
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PreparedReconciliationReceiptV1 {
    pub version: u16,
    pub request_hash: Sha256Digest,
    pub commit_receipt: CommitReceiptV1,
    /// True only for a new commit; historical inventory bytes cannot be
    /// reconstructed from the post-commit database during a read-only replay.
    pub source_preimage_verified: bool,
    pub worker_execution_performed: bool,
    pub provider_action_performed: bool,
    pub production_activation: bool,
    pub node_retirement_verified: bool,
}

// This executor has no worker table, process handle, provider interface or
// callable native job. A cache miss is an error, not permission to retry work.
struct PreparedOnlyExecutorV1 {
    result: PreparedResultV1,
}
impl ModuleExecutorV1 for PreparedOnlyExecutorV1 {
    fn execute_batch(
        &mut self,
        requests: &[ExecutionRequestV1],
    ) -> Result<Vec<PreparedResultV1>, ControlPlaneError> {
        if requests.len() != 1 {
            return Err(ControlPlaneError::VerificationInvalid);
        }
        let request = &requests[0];
        self.result
            .validate(&request.candidate, &request.plan_hash)
            .map_err(|_| ControlPlaneError::VerificationInvalid)?;
        if self.result.attempt_id != request.attempt_id
            || self.result.snapshot_hash != request.snapshot_hash
        {
            return Err(ControlPlaneError::VerificationInvalid);
        }
        Ok(vec![self.result.clone()])
    }
}

impl LocalMaintenanceSessionV1 {
    /// Validate exactly one unmatched native started+prepared pair and its plan.
    /// No runtime action is performed and no lease is acquired by this method.
    pub fn plan_prepared_reconciliation(
        &self,
        expected: &Sha256Digest,
    ) -> Result<PreparedReconciliationPlanV1, ServiceError> {
        self.validate()?;
        let inventory = self.inspect()?;
        let objects = ObjectStoreV1::readonly_under_guard(&self.state, self.access.clone())?;
        let facts =
            prepared_recovery_facts_at(&self.state, &self.state, self.owner, &objects, expected)
                .map_err(|_| ServiceError::Persistence)?;
        let pending = facts.pending.ok_or(ServiceError::Configuration)?;
        if self.inspect()? != inventory {
            return Err(ServiceError::Artifact);
        }
        Ok(PreparedReconciliationPlanV1 {
            version: 1,
            state_directory: self.state.clone(),
            definition_hash: expected.clone(),
            inventory_hash: digest(
                &serde_json::to_vec(&inventory.files).map_err(|_| ServiceError::Artifact)?,
            )?,
            campaign_revision: facts.campaign.revision,
            sequence: facts.committed_steps as u64 + 1,
            plan_hash: pending.result.plan_hash.clone(),
            prepared_result_hash: pending
                .result
                .result_hash()
                .map_err(|_| ServiceError::Artifact)?,
            configuration_hash: crate::service_configuration_hash_v1(&pending.config)?,
            production_activation: false,
        })
    }

    /// Commit only the hash-selected cached result through the ordinary planner,
    /// resource admission, artifact-byte verifier and persistent sequencer. An
    /// ambiguous start with no prepared bytes is never dispatched by this API.
    pub fn apply_prepared_reconciliation(
        &self,
        plan: &PreparedReconciliationPlanV1,
        expected_hash: &Sha256Digest,
        now: u64,
    ) -> Result<PreparedReconciliationReceiptV1, ServiceError> {
        self.validate()?;
        if plan.state_directory != self.state || &plan.request_hash()? != expected_hash {
            return Err(ServiceError::Configuration);
        }
        self.inspect()?;
        let objects = ObjectStoreV1::readonly_under_guard(&self.state, self.access.clone())?;
        let facts = prepared_recovery_facts_at(
            &self.state,
            &self.state,
            self.owner,
            &objects,
            &plan.definition_hash,
        )
        .map_err(|_| ServiceError::Persistence)?;
        // Lost-response retry is read-only: return the original matching durable
        // receipt even after lease expiry. Never debit again or change lifecycle.
        if let Some(receipt) = facts.receipts.iter().find(|r| r.sequence == plan.sequence) {
            if receipt.plan_hash != plan.plan_hash
                || receipt.result_hash != plan.prepared_result_hash
            {
                return Err(ServiceError::Persistence);
            }
            let saved: ServiceRunV1 = serde_json::from_slice(&read_private(
                &self
                    .state
                    .join(format!("step-{:04}.json", plan.sequence - 1)),
                self.owner,
                MAX_FILE_BYTES,
            )?)
            .map_err(|_| ServiceError::Artifact)?;
            if crate::service_configuration_hash_v1(&saved)? != plan.configuration_hash
                || plan.campaign_revision.checked_add(1) != Some(saved.snapshot.campaign_revision)
            {
                return Err(ServiceError::Persistence);
            }
            let mut receipt = receipt.clone();
            receipt.newly_committed = false;
            return Ok(reconciliation_receipt(expected_hash.clone(), receipt));
        }
        if self.plan_prepared_reconciliation(&plan.definition_hash)? != *plan
            || now < facts.clock_floor
            || now >= facts.definition.template.writer_lease.expires_at_unix_ms
            || facts.campaign.state != CampaignStateV1::Running
        {
            return Err(ServiceError::Persistence);
        }
        let pending = facts.pending.ok_or(ServiceError::Configuration)?;
        if now < pending.config.observed_at_unix_ms {
            return Err(ServiceError::Configuration);
        }
        let receipt = self.commit_prepared(pending.config, pending.result, objects, now)?;
        // The database owns checkpointing/sidecar cleanup. No files are unlinked
        // by this reconciler and no lease is renewed after this commit.
        CampaignWriterStoreV1::quiesce_local_for_backup(
            &self.state.join("campaign.sqlite"),
            CampaignWriterPolicyV1::strict(self.owner),
        )
        .map_err(|_| ServiceError::Persistence)?;
        sync_dir(&self.state)?;
        self.verify_recovery(&plan.definition_hash, now)?;
        Ok(reconciliation_receipt(expected_hash.clone(), receipt))
    }

    fn commit_prepared(
        &self,
        config: ServiceRunV1,
        result: PreparedResultV1,
        objects: ObjectStoreV1,
        now: u64,
    ) -> Result<CommitReceiptV1, ServiceError> {
        let registry = ModuleRegistryArtifactV1::decode_json(
            config.registry_json.as_bytes(),
            &config.hard_policy.registry_policy_hash,
        )
        .map_err(|_| ServiceError::Configuration)?;
        let tenant = config.snapshot.campaign_id.clone();
        let mut store = CampaignWriterStoreV1::open_local(
            self.state.join("campaign.sqlite"),
            CampaignWriterPolicyV1::strict(self.owner),
        )
        .map_err(|_| ServiceError::Persistence)?;
        let writer = store
            .acquire_writer(config.writer_lease.clone(), now)
            .map_err(|_| ServiceError::Persistence)?;
        let sequencer = SqliteCommitSequencerV1::new(
            store,
            writer,
            tenant.clone(),
            config.initial_state_hash,
            config.verifier_hash.clone(),
            now,
        )
        .map_err(|_| ServiceError::Control)?;
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
        let mut control = ControlPlaneV1::new(
            registry,
            config.hard_policy.registry_policy_hash.clone(),
            config.hard_policy,
            config.planner_policy,
            allocator,
            PreparedOnlyExecutorV1 { result },
            verifier,
            sequencer,
            BoundedEventLogV1::new(100_000, 100_000).map_err(|_| ServiceError::Control)?,
        )
        .map_err(|_| ServiceError::Control)?;
        let run = control
            .run(&config.snapshot, &config.frontier, &tenant, now)
            .map_err(|error| {
                crate::control_error::map_control_run_error(error, control.inspection_required())
            })?;
        if run.commit_receipts.len() != 1 {
            return Err(ServiceError::Control);
        }
        run.commit_receipts
            .into_iter()
            .next()
            .ok_or(ServiceError::Control)
    }
}
fn reconciliation_receipt(
    request_hash: Sha256Digest,
    commit_receipt: CommitReceiptV1,
) -> PreparedReconciliationReceiptV1 {
    PreparedReconciliationReceiptV1 {
        version: 1,
        request_hash,
        source_preimage_verified: commit_receipt.newly_committed,
        commit_receipt,
        worker_execution_performed: false,
        provider_action_performed: false,
        production_activation: false,
        node_retirement_verified: false,
    }
}
