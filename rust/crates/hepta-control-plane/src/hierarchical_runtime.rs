use std::collections::BTreeMap;

use hepta_codex_protocol::Sha256Digest;
use hepta_module_platform::{ActionCandidateV1, ModuleRegistryArtifactV1};
use serde::{Deserialize, Serialize};

use crate::{
    BoundedEventLogV1, CommitSequencerV1, ControlPlaneError, ControlPlaneRunReceiptV1,
    ControlPlaneSnapshotV1, ControlPlaneV1, HardPolicyV1, HierarchicalAccountingReportV1,
    HierarchicalReservationRequestV1, HierarchicalResourceAllocatorV1, ModuleExecutorV1,
    PlannerPolicyV1, PlanningFrontierV1, PreparedResultVerifierV1, ResourceAllocatorV1,
    canonical_hash_v1, select_plan_v1,
};

/// Deployment-owned mapping from a module to the exact hierarchical resource scope
/// and runtime principal/worker identity used before dispatch.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ModuleAdmissionBindingV1 {
    /// Leaf capacity scope charged for this module.
    pub leaf_scope_id: String,
    /// Principal that owns the lease and may renew it.
    pub owner_principal: String,
    /// Exact worker identity receiving the admitted operation.
    pub worker_identity: String,
    /// Maximum local lease duration requested by this composition.
    pub lease_duration_ms: u64,
}

/// Receipt proving that the selected plan crossed the hierarchical prepare/finalize
/// resource gate before ordinary execution and that every lease was released after
/// the inner control-plane transaction completed.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct HierarchicalControlPlaneRunReceiptV1 {
    /// Contract version.
    pub version: u16,
    /// Exact plan selected independently before hierarchical admission.
    pub plan_hash: Sha256Digest,
    /// Accounting state before this run's hierarchy reservations.
    pub hierarchy_baseline: HierarchicalAccountingReportV1,
    /// Accounting state after every selected action obtained a finalized lease.
    pub hierarchy_admitted: HierarchicalAccountingReportV1,
    /// Finalized lease hashes in deterministic selected-action order.
    pub hierarchy_lease_hashes: Vec<Sha256Digest>,
    /// Existing durable control-plane receipt for execution/verification/commit.
    pub control_plane_receipt: ControlPlaneRunReceiptV1,
    /// Accounting state after every lease created by this run was released.
    pub hierarchy_released: HierarchicalAccountingReportV1,
    /// Canonical receipt identity.
    pub receipt_hash: Sha256Digest,
}

/// Composition that makes hierarchical admission a mandatory pre-dispatch gate
/// while retaining the already qualified local allocator inside `ControlPlaneV1`
/// as an independent second resource check.
#[derive(Debug)]
pub struct HierarchicalControlPlaneV1<E, V, C>
where
    E: ModuleExecutorV1,
    V: PreparedResultVerifierV1,
    C: CommitSequencerV1,
{
    inner: ControlPlaneV1<E, V, C>,
    registry: ModuleRegistryArtifactV1,
    hard_policy: HardPolicyV1,
    planner_policy: PlannerPolicyV1,
    hierarchy: HierarchicalResourceAllocatorV1,
    bindings: BTreeMap<String, ModuleAdmissionBindingV1>,
}

impl<E, V, C> HierarchicalControlPlaneV1<E, V, C>
where
    E: ModuleExecutorV1,
    V: PreparedResultVerifierV1,
    C: CommitSequencerV1,
{
    /// Constructs one hierarchy-gated control plane from the exact same registry,
    /// hard policy and planner policy later consumed by the inner execution path.
    #[allow(clippy::too_many_arguments)]
    pub fn new(
        registry: ModuleRegistryArtifactV1,
        expected_registry_policy_hash: Sha256Digest,
        hard_policy: HardPolicyV1,
        planner_policy: PlannerPolicyV1,
        local_allocator: ResourceAllocatorV1,
        hierarchy: HierarchicalResourceAllocatorV1,
        bindings: BTreeMap<String, ModuleAdmissionBindingV1>,
        executor: E,
        verifier: V,
        sequencer: C,
        events: BoundedEventLogV1,
    ) -> Result<Self, ControlPlaneError> {
        if bindings.is_empty()
            || bindings
                .values()
                .any(|binding| binding.lease_duration_ms == 0)
            || bindings
                .keys()
                .any(|module_id| registry.module(module_id).is_err())
        {
            return Err(ControlPlaneError::HierarchicalResourceRejected);
        }
        let preview_registry = registry.clone();
        let preview_hard_policy = hard_policy.clone();
        let preview_planner_policy = planner_policy.clone();
        let inner = ControlPlaneV1::new(
            registry,
            expected_registry_policy_hash,
            hard_policy,
            planner_policy,
            local_allocator,
            executor,
            verifier,
            sequencer,
            events,
        )?;
        Ok(Self {
            inner,
            registry: preview_registry,
            hard_policy: preview_hard_policy,
            planner_policy: preview_planner_policy,
            hierarchy,
            bindings,
        })
    }

    /// Runs one immutable snapshot through global planning, hierarchical admission,
    /// execution, independent verification, durable commit, and complete hierarchy
    /// release. No module dispatch occurs before every selected action has a lease.
    pub fn run(
        &mut self,
        snapshot: &ControlPlaneSnapshotV1,
        frontier: &PlanningFrontierV1,
        tenant_id: &str,
        now_unix_ms: u64,
    ) -> Result<HierarchicalControlPlaneRunReceiptV1, ControlPlaneError> {
        snapshot.validate(&self.registry)?;
        if snapshot.constraint_set_hash != self.hard_policy.policy_hash()?
            || snapshot.registry_policy_hash != self.hard_policy.registry_policy_hash
        {
            return Err(ControlPlaneError::SnapshotInvalid);
        }
        frontier.validate(snapshot, &self.registry, &self.hard_policy)?;
        let plan = select_plan_v1(snapshot, frontier, &self.hard_policy, &self.planner_policy)?;
        let candidates = frontier
            .candidates
            .iter()
            .map(|candidate| (candidate.candidate_id.as_str(), candidate))
            .collect::<BTreeMap<_, _>>();
        let hierarchy_baseline = self
            .hierarchy
            .report()
            .map_err(|_| ControlPlaneError::HierarchicalResourceRejected)?;
        let mut finalized_ids = Vec::with_capacity(plan.selected_candidate_ids.len());
        let mut hierarchy_lease_hashes = Vec::with_capacity(plan.selected_candidate_ids.len());

        for (index, candidate_id) in plan.selected_candidate_ids.iter().enumerate() {
            let candidate = candidates
                .get(candidate_id.as_str())
                .copied()
                .ok_or(ControlPlaneError::FrontierInvalid)?;
            if let Err(error) = self.admit_candidate(
                candidate,
                &plan.plan_hash,
                index,
                now_unix_ms,
                &mut finalized_ids,
                &mut hierarchy_lease_hashes,
            ) {
                self.release_finalized(&finalized_ids)?;
                return Err(error);
            }
        }

        let hierarchy_admitted = self
            .hierarchy
            .report()
            .map_err(|_| ControlPlaneError::HierarchicalResourceRejected)?;
        if hierarchy_admitted.prepared_count != hierarchy_baseline.prepared_count
            || hierarchy_admitted.finalized_count
                != hierarchy_baseline
                    .finalized_count
                    .checked_add(finalized_ids.len())
                    .ok_or(ControlPlaneError::HierarchicalResourceRejected)?
        {
            self.release_finalized(&finalized_ids)?;
            return Err(ControlPlaneError::HierarchicalResourceRejected);
        }

        let control_plane_result = self.inner.run(snapshot, frontier, tenant_id, now_unix_ms);
        let release_result = self.release_finalized(&finalized_ids);
        let control_plane_receipt = match (control_plane_result, release_result) {
            (Ok(receipt), Ok(())) => receipt,
            (Err(error), Ok(())) => return Err(error),
            (_, Err(error)) => return Err(error),
        };
        if control_plane_receipt.plan != plan {
            return Err(ControlPlaneError::PlanInvalid);
        }
        let hierarchy_released = self
            .hierarchy
            .report()
            .map_err(|_| ControlPlaneError::HierarchicalResourceRejected)?;
        if !same_accounting_state(&hierarchy_baseline, &hierarchy_released) {
            return Err(ControlPlaneError::HierarchicalResourceRejected);
        }
        let body = HierarchicalRunBodyV1 {
            version: 1,
            plan_hash: &plan.plan_hash,
            hierarchy_baseline: &hierarchy_baseline,
            hierarchy_admitted: &hierarchy_admitted,
            hierarchy_lease_hashes: &hierarchy_lease_hashes,
            control_plane_receipt: &control_plane_receipt,
            hierarchy_released: &hierarchy_released,
        };
        let receipt_hash = canonical_hash_v1(&body)?;
        Ok(HierarchicalControlPlaneRunReceiptV1 {
            version: body.version,
            plan_hash: plan.plan_hash,
            hierarchy_baseline,
            hierarchy_admitted,
            hierarchy_lease_hashes,
            control_plane_receipt,
            hierarchy_released,
            receipt_hash,
        })
    }

    /// Exposes the inner durable control plane for source diagnostics only.
    #[must_use]
    pub fn inner(&self) -> &ControlPlaneV1<E, V, C> {
        &self.inner
    }

    /// Exposes the exact hierarchy accounting report for recovery diagnostics.
    pub fn hierarchy_report(&self) -> Result<HierarchicalAccountingReportV1, ControlPlaneError> {
        self.hierarchy
            .report()
            .map_err(|_| ControlPlaneError::HierarchicalResourceRejected)
    }

    fn admit_candidate(
        &mut self,
        candidate: &ActionCandidateV1,
        plan_hash: &Sha256Digest,
        index: usize,
        now_unix_ms: u64,
        finalized_ids: &mut Vec<String>,
        lease_hashes: &mut Vec<Sha256Digest>,
    ) -> Result<(), ControlPlaneError> {
        let binding = self
            .bindings
            .get(&candidate.module_id)
            .ok_or(ControlPlaneError::HierarchicalResourceRejected)?;
        let expires_at_unix_ms = now_unix_ms
            .checked_add(binding.lease_duration_ms)
            .ok_or(ControlPlaneError::HierarchicalResourceRejected)?;
        let ordinal = index
            .checked_add(1)
            .ok_or(ControlPlaneError::HierarchicalResourceRejected)?;
        let accounting = self
            .hierarchy
            .report()
            .map_err(|_| ControlPlaneError::HierarchicalResourceRejected)?;
        let candidate_hash = candidate
            .candidate_hash()
            .map_err(|_| ControlPlaneError::ModulePlatformRejected)?;
        let reservation_id = format!("{}:hier:{ordinal}", plan_hash.as_str());
        let attempt_id = format!("{}:hier-attempt:{ordinal}", plan_hash.as_str());
        let prepared = self
            .hierarchy
            .prepare(
                HierarchicalReservationRequestV1 {
                    reservation_id: reservation_id.clone(),
                    attempt_id,
                    owner_principal: binding.owner_principal.clone(),
                    worker_identity: binding.worker_identity.clone(),
                    leaf_scope_id: binding.leaf_scope_id.clone(),
                    plan_hash: plan_hash.clone(),
                    action_hash: candidate_hash,
                    resources: candidate.resources,
                    capacity_generation: accounting.capacity_generation,
                    accounting_generation: accounting.accounting_generation,
                    requested_at_unix_ms: now_unix_ms,
                    expires_at_unix_ms,
                },
                now_unix_ms,
            )
            .map_err(|_| ControlPlaneError::HierarchicalResourceRejected)?;
        let lease =
            match self
                .hierarchy
                .finalize(&reservation_id, &prepared.prepared_hash, now_unix_ms)
            {
                Ok(lease) => lease,
                Err(_) => {
                    self.hierarchy
                        .cancel_prepared(&reservation_id)
                        .map_err(|_| ControlPlaneError::HierarchicalResourceRejected)?;
                    return Err(ControlPlaneError::HierarchicalResourceRejected);
                }
            };
        finalized_ids.push(reservation_id);
        lease_hashes.push(lease.lease_hash);
        Ok(())
    }

    fn release_finalized(&mut self, finalized_ids: &[String]) -> Result<(), ControlPlaneError> {
        for reservation_id in finalized_ids.iter().rev() {
            self.hierarchy
                .release(reservation_id)
                .map_err(|_| ControlPlaneError::HierarchicalResourceRejected)?;
        }
        Ok(())
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct HierarchicalRunBodyV1<'a> {
    version: u16,
    plan_hash: &'a Sha256Digest,
    hierarchy_baseline: &'a HierarchicalAccountingReportV1,
    hierarchy_admitted: &'a HierarchicalAccountingReportV1,
    hierarchy_lease_hashes: &'a [Sha256Digest],
    control_plane_receipt: &'a ControlPlaneRunReceiptV1,
    hierarchy_released: &'a HierarchicalAccountingReportV1,
}

fn same_accounting_state(
    before: &HierarchicalAccountingReportV1,
    after: &HierarchicalAccountingReportV1,
) -> bool {
    before.capacity_generation == after.capacity_generation
        && before.accounting_generation == after.accounting_generation
        && before.scope_reserved == after.scope_reserved
        && before.prepared_count == after.prepared_count
        && before.finalized_count == after.finalized_count
}
