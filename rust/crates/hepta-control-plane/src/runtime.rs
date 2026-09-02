use std::collections::{BTreeMap, BTreeSet};

use hepta_codex_protocol::Sha256Digest;
use hepta_module_platform::{ActionCandidateV1, ModuleRegistryArtifactV1};
use serde::{Deserialize, Serialize};

use crate::{
    AdmissionRequestV1, BoundedEventLogV1, CommitReceiptV1, CommitRequestV1, CommitSequencerV1,
    ControlPlaneError, ControlPlaneEventKindV1, ControlPlaneEventV1, ControlPlaneSnapshotV1,
    ExecutionRequestV1, HardPolicyV1, ModuleExecutorV1, PlanCertificateV1, PlannerPolicyV1,
    PlanningFrontierV1, PreparedResultVerifierV1, ResourceAccountingReportV1, ResourceAllocatorV1,
    VerifiedPreparedResultV1, canonical_hash_v1, select_plan_v1,
};

/// Complete non-activating receipt for one source-qualified vertical slice.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ControlPlaneRunReceiptV1 {
    /// Contract version.
    pub version: u16,
    /// Exact snapshot hash.
    pub snapshot_hash: Sha256Digest,
    /// Selected plan certificate.
    pub plan: PlanCertificateV1,
    /// Prepared-result hashes in dependency order.
    pub prepared_result_hashes: Vec<Sha256Digest>,
    /// Serialized commit receipts.
    pub commit_receipts: Vec<CommitReceiptV1>,
    /// Final resource-accounting report.
    pub resource_report: ResourceAccountingReportV1,
    /// Privacy-bounded per-run event-log hash.
    pub event_log_hash: Sha256Digest,
    /// Source execution never changes module activation.
    pub automatic_activation: bool,
    /// Source execution never authorizes production.
    pub production_activation: bool,
    /// Canonical receipt hash.
    pub receipt_hash: Sha256Digest,
}

/// Generic authority-separated control-plane composition.
#[derive(Debug)]
pub struct ControlPlaneV1<E, V, C>
where
    E: ModuleExecutorV1,
    V: PreparedResultVerifierV1,
    C: CommitSequencerV1 + Clone,
{
    registry: ModuleRegistryArtifactV1,
    hard_policy: HardPolicyV1,
    planner_policy: PlannerPolicyV1,
    allocator: ResourceAllocatorV1,
    executor: E,
    verifier: V,
    sequencer: C,
    events: BoundedEventLogV1,
}

impl<E, V, C> ControlPlaneV1<E, V, C>
where
    E: ModuleExecutorV1,
    V: PreparedResultVerifierV1,
    C: CommitSequencerV1 + Clone,
{
    /// Creates a source composition without production or external authority.
    #[allow(clippy::too_many_arguments)]
    pub fn new(
        registry: ModuleRegistryArtifactV1,
        expected_registry_policy_hash: Sha256Digest,
        hard_policy: HardPolicyV1,
        planner_policy: PlannerPolicyV1,
        allocator: ResourceAllocatorV1,
        executor: E,
        verifier: V,
        sequencer: C,
        events: BoundedEventLogV1,
    ) -> Result<Self, ControlPlaneError> {
        registry
            .validate(&expected_registry_policy_hash)
            .map_err(|_| ControlPlaneError::ModulePlatformRejected)?;
        hard_policy.validate()?;
        planner_policy.validate()?;
        if hard_policy.external_actions_authorized
            || hard_policy.registry_policy_hash != expected_registry_policy_hash
            || registry.policy_hash() != &expected_registry_policy_hash
            || sequencer.authorized_verifier_hash() != verifier.verifier_hash()
        {
            return Err(ControlPlaneError::PlannerPolicyInvalid);
        }
        Ok(Self {
            registry,
            hard_policy,
            planner_policy,
            allocator,
            executor,
            verifier,
            sequencer,
            events,
        })
    }

    /// Runs snapshot → plan → reserve → prepare → verify → atomic commit/release/event publish.
    pub fn run(
        &mut self,
        snapshot: &ControlPlaneSnapshotV1,
        frontier: &PlanningFrontierV1,
        tenant_id: &str,
        now_unix_ms: u64,
    ) -> Result<ControlPlaneRunReceiptV1, ControlPlaneError> {
        snapshot.validate(&self.registry)?;
        if snapshot.constraint_set_hash != self.hard_policy.policy_hash()?
            || snapshot.resource_limit != self.allocator.capacity()
            || snapshot.registry_policy_hash != self.hard_policy.registry_policy_hash
        {
            return Err(ControlPlaneError::SnapshotInvalid);
        }
        frontier.validate(snapshot, &self.registry, &self.hard_policy)?;
        let snapshot_hash = snapshot.snapshot_hash()?;
        let plan = select_plan_v1(snapshot, frontier, &self.hard_policy, &self.planner_policy)?;
        let waves = dependency_waves(frontier, &plan)?;
        let ordered = waves.iter().flatten().copied().collect::<Vec<_>>();
        let additional_events = ordered
            .len()
            .checked_mul(5)
            .and_then(|count| count.checked_add(3))
            .ok_or(ControlPlaneError::ObservabilityBudgetExceeded)?;
        self.events
            .ensure_capacity(additional_events, additional_events)?;
        let event_start = self.events.events().len();
        self.emit(
            ControlPlaneEventKindV1::SnapshotFrozen,
            &snapshot_hash,
            None,
            None,
            None,
            None,
            snapshot.state_hash.clone(),
        )?;
        self.emit(
            ControlPlaneEventKindV1::FrontierValidated,
            &snapshot_hash,
            None,
            None,
            None,
            None,
            frontier.frontier_hash()?,
        )?;
        self.emit(
            ControlPlaneEventKindV1::PlanSelected,
            &snapshot_hash,
            Some(&plan.plan_hash),
            None,
            None,
            None,
            plan.plan_hash.clone(),
        )?;

        let (requests, reservation_ids) = self.reserve_selected(
            snapshot,
            &snapshot_hash,
            &plan,
            &ordered,
            tenant_id,
            now_unix_ms,
        )?;
        let verified = match self.process_admitted(&snapshot_hash, &plan, &waves, &requests) {
            Ok(value) => value,
            Err(error) => {
                self.release_without_events(&reservation_ids)?;
                return Err(error);
            }
        };
        match self.finalize_atomic(&snapshot_hash, &plan, &requests, verified, event_start) {
            Ok(receipt) => Ok(receipt),
            Err(error) => {
                self.release_without_events(&reservation_ids)?;
                Err(error)
            }
        }
    }

    /// Borrows all emitted bounded events.
    #[must_use]
    pub fn events(&self) -> &[ControlPlaneEventV1] {
        self.events.events()
    }

    /// Borrows the commit sequencer for source tests and diagnostics.
    #[must_use]
    pub fn sequencer(&self) -> &C {
        &self.sequencer
    }

    /// Emits the current exact resource-accounting report.
    pub fn resource_report(&self) -> Result<ResourceAccountingReportV1, ControlPlaneError> {
        self.allocator.report()
    }

    fn reserve_selected(
        &mut self,
        snapshot: &ControlPlaneSnapshotV1,
        snapshot_hash: &Sha256Digest,
        plan: &PlanCertificateV1,
        ordered: &[&ActionCandidateV1],
        tenant_id: &str,
        now_unix_ms: u64,
    ) -> Result<(Vec<ExecutionRequestV1>, Vec<String>), ControlPlaneError> {
        let mut requests = Vec::with_capacity(ordered.len());
        let mut reservation_ids = Vec::with_capacity(ordered.len());
        for (index, candidate) in ordered.iter().enumerate() {
            let ordinal = index
                .checked_add(1)
                .ok_or(ControlPlaneError::ReservationInvalid)?;
            let reservation_id = format!("{}:reservation:{ordinal}", snapshot.campaign_id);
            let reservation = match self.allocator.reserve(
                AdmissionRequestV1 {
                    reservation_id: reservation_id.clone(),
                    tenant_id: tenant_id.to_owned(),
                    module_id: candidate.module_id.clone(),
                    candidate_id: candidate.candidate_id.clone(),
                    resources: candidate.resources,
                    queued_at_unix_ms: now_unix_ms,
                    deadline_unix_ms: None,
                },
                now_unix_ms,
            ) {
                Ok(reservation) => reservation,
                Err(error) => {
                    self.release_without_events(&reservation_ids)?;
                    return Err(error);
                }
            };
            reservation_ids.push(reservation_id);
            if let Err(error) = self.emit(
                ControlPlaneEventKindV1::ResourceReserved,
                snapshot_hash,
                Some(&plan.plan_hash),
                Some(&candidate.candidate_id),
                Some(&candidate.module_id),
                Some(&reservation.reservation_id),
                reservation.reservation_hash.clone(),
            ) {
                self.release_without_events(&reservation_ids)?;
                return Err(error);
            }
            let attempt_id = format!("{}:attempt:{ordinal}", snapshot.campaign_id);
            requests.push(ExecutionRequestV1 {
                version: 1,
                attempt_id,
                snapshot_hash: snapshot_hash.clone(),
                plan_hash: plan.plan_hash.clone(),
                candidate: (*candidate).clone(),
                reservation,
            });
        }
        Ok((requests, reservation_ids))
    }

    fn process_admitted(
        &mut self,
        snapshot_hash: &Sha256Digest,
        plan: &PlanCertificateV1,
        waves: &[Vec<&ActionCandidateV1>],
        requests: &[ExecutionRequestV1],
    ) -> Result<VerifiedRunV1, ControlPlaneError> {
        let requests_by_candidate = requests
            .iter()
            .map(|request| (request.candidate.candidate_id.as_str(), request))
            .collect::<BTreeMap<_, _>>();
        if requests_by_candidate.len() != requests.len() {
            return Err(ControlPlaneError::ExecutionInvalid);
        }

        let mut verified = Vec::<VerifiedPreparedResultV1>::with_capacity(requests.len());
        let mut prepared_result_hashes = Vec::with_capacity(requests.len());
        for wave in waves {
            let wave_requests = wave
                .iter()
                .map(|candidate| {
                    requests_by_candidate
                        .get(candidate.candidate_id.as_str())
                        .copied()
                        .cloned()
                        .ok_or(ControlPlaneError::ExecutionInvalid)
                })
                .collect::<Result<Vec<_>, _>>()?;
            let prepared = self.executor.execute_batch(&wave_requests)?;
            if prepared.len() != wave_requests.len() {
                return Err(ControlPlaneError::ExecutionInvalid);
            }
            let prepared_by_candidate = prepared
                .into_iter()
                .map(|result| (result.candidate_hash.clone(), result))
                .collect::<BTreeMap<_, _>>();
            if prepared_by_candidate.len() != wave_requests.len() {
                return Err(ControlPlaneError::ExecutionInvalid);
            }

            for request in &wave_requests {
                let candidate_hash = request
                    .candidate
                    .candidate_hash()
                    .map_err(|_| ControlPlaneError::ExecutionInvalid)?;
                let result = prepared_by_candidate
                    .get(&candidate_hash)
                    .cloned()
                    .ok_or(ControlPlaneError::ExecutionInvalid)?;
                self.emit(
                    ControlPlaneEventKindV1::ResultPrepared,
                    snapshot_hash,
                    Some(&plan.plan_hash),
                    Some(&request.candidate.candidate_id),
                    Some(&request.candidate.module_id),
                    Some(&request.reservation.reservation_id),
                    result.evidence_hash.clone(),
                )?;
                let accepted = self.verifier.verify(result, &request.candidate, plan)?;
                prepared_result_hashes.push(accepted.result_hash().clone());
                self.emit(
                    ControlPlaneEventKindV1::ResultVerified,
                    snapshot_hash,
                    Some(&plan.plan_hash),
                    Some(&request.candidate.candidate_id),
                    Some(&request.candidate.module_id),
                    Some(&request.reservation.reservation_id),
                    accepted.result_hash().clone(),
                )?;
                verified.push(accepted);
            }
        }
        if verified.len() != requests.len() {
            return Err(ControlPlaneError::ExecutionInvalid);
        }
        Ok(VerifiedRunV1 {
            verified,
            prepared_result_hashes,
        })
    }

    fn finalize_atomic(
        &mut self,
        snapshot_hash: &Sha256Digest,
        plan: &PlanCertificateV1,
        requests: &[ExecutionRequestV1],
        verified_run: VerifiedRunV1,
        event_start: usize,
    ) -> Result<ControlPlaneRunReceiptV1, ControlPlaneError> {
        if requests.len() != verified_run.verified.len() {
            return Err(ControlPlaneError::CommitInvalid);
        }
        let final_event_count = requests
            .len()
            .checked_mul(2)
            .ok_or(ControlPlaneError::ObservabilityBudgetExceeded)?;

        let mut staged_allocator = self.allocator.clone();
        let mut staged_sequencer = self.sequencer.clone();
        let mut staged_events = self.events.clone();
        let mut commit_requests = Vec::with_capacity(verified_run.verified.len());
        let mut released_reservations = Vec::with_capacity(requests.len());

        for (request, verified) in requests.iter().zip(verified_run.verified) {
            staged_allocator.reconcile(
                &request.reservation.reservation_id,
                verified.result().actual_resources,
            )?;
            let released = staged_allocator.release(&request.reservation.reservation_id)?;
            released_reservations.push(released);
            commit_requests.push(CommitRequestV1::new(plan.plan_hash.clone(), verified)?);
        }
        let commit_receipts = staged_sequencer.commit_batch(&commit_requests)?;
        if commit_receipts.len() != requests.len() {
            return Err(ControlPlaneError::CommitInvalid);
        }

        let mut final_events = Vec::with_capacity(final_event_count);
        for ((request, receipt), released) in requests
            .iter()
            .zip(&commit_receipts)
            .zip(&released_reservations)
        {
            final_events.push(event(
                ControlPlaneEventKindV1::ResultCommitted,
                snapshot_hash,
                Some(&plan.plan_hash),
                Some(&request.candidate.candidate_id),
                Some(&request.candidate.module_id),
                Some(&request.reservation.reservation_id),
                receipt.committed_state_hash.clone(),
            ));
            final_events.push(event(
                ControlPlaneEventKindV1::ResourceReleased,
                snapshot_hash,
                Some(&plan.plan_hash),
                Some(&request.candidate.candidate_id),
                Some(&request.candidate.module_id),
                Some(&request.reservation.reservation_id),
                released.reservation_hash.clone(),
            ));
        }
        staged_events.push_batch(final_events)?;

        let resource_report = staged_allocator.report()?;
        if !resource_report.reserved.is_zero() || resource_report.reservation_count != 0 {
            return Err(ControlPlaneError::ReconciliationInvalid);
        }
        let run_events = staged_events
            .events()
            .get(event_start..)
            .ok_or(ControlPlaneError::ObservabilityBudgetExceeded)?;
        let event_log_hash = canonical_hash_v1(run_events)?;
        let body = ControlPlaneRunBodyV1 {
            version: 1,
            snapshot_hash: snapshot_hash.clone(),
            plan: plan.clone(),
            prepared_result_hashes: verified_run.prepared_result_hashes,
            commit_receipts,
            resource_report,
            event_log_hash,
            automatic_activation: false,
            production_activation: false,
        };
        let receipt_hash = canonical_hash_v1(&body)?;
        let receipt = ControlPlaneRunReceiptV1 {
            version: body.version,
            snapshot_hash: body.snapshot_hash,
            plan: body.plan,
            prepared_result_hashes: body.prepared_result_hashes,
            commit_receipts: body.commit_receipts,
            resource_report: body.resource_report,
            event_log_hash: body.event_log_hash,
            automatic_activation: body.automatic_activation,
            production_activation: body.production_activation,
            receipt_hash,
        };

        self.allocator = staged_allocator;
        self.sequencer = staged_sequencer;
        self.events = staged_events;
        Ok(receipt)
    }

    fn release_without_events(
        &mut self,
        reservation_ids: &[String],
    ) -> Result<(), ControlPlaneError> {
        let mut first_error = None;
        for reservation_id in reservation_ids {
            if let Err(error) = self.allocator.release(reservation_id)
                && first_error.is_none()
            {
                first_error = Some(error);
            }
        }
        match first_error {
            Some(error) => Err(error),
            None => Ok(()),
        }
    }

    #[allow(clippy::too_many_arguments)]
    fn emit(
        &mut self,
        kind: ControlPlaneEventKindV1,
        snapshot_hash: &Sha256Digest,
        plan_hash: Option<&Sha256Digest>,
        candidate_id: Option<&str>,
        module_id: Option<&str>,
        reservation_id: Option<&str>,
        subject_hash: Sha256Digest,
    ) -> Result<(), ControlPlaneError> {
        self.events.push(event(
            kind,
            snapshot_hash,
            plan_hash,
            candidate_id,
            module_id,
            reservation_id,
            subject_hash,
        ))
    }
}

struct VerifiedRunV1 {
    verified: Vec<VerifiedPreparedResultV1>,
    prepared_result_hashes: Vec<Sha256Digest>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ControlPlaneRunBodyV1 {
    version: u16,
    snapshot_hash: Sha256Digest,
    plan: PlanCertificateV1,
    prepared_result_hashes: Vec<Sha256Digest>,
    commit_receipts: Vec<CommitReceiptV1>,
    resource_report: ResourceAccountingReportV1,
    event_log_hash: Sha256Digest,
    automatic_activation: bool,
    production_activation: bool,
}

#[allow(clippy::too_many_arguments)]
fn event(
    kind: ControlPlaneEventKindV1,
    snapshot_hash: &Sha256Digest,
    plan_hash: Option<&Sha256Digest>,
    candidate_id: Option<&str>,
    module_id: Option<&str>,
    reservation_id: Option<&str>,
    subject_hash: Sha256Digest,
) -> ControlPlaneEventV1 {
    ControlPlaneEventV1 {
        ordinal: 0,
        kind,
        snapshot_hash: snapshot_hash.clone(),
        plan_hash: plan_hash.cloned(),
        candidate_id: candidate_id.map(str::to_owned),
        module_id: module_id.map(str::to_owned),
        reservation_id: reservation_id.map(str::to_owned),
        subject_hash,
    }
}

fn dependency_waves<'a>(
    frontier: &'a PlanningFrontierV1,
    plan: &PlanCertificateV1,
) -> Result<Vec<Vec<&'a ActionCandidateV1>>, ControlPlaneError> {
    let by_id = frontier
        .candidates
        .iter()
        .map(|candidate| (candidate.candidate_id.as_str(), candidate))
        .collect::<BTreeMap<_, _>>();
    let selected = plan
        .selected_candidate_ids
        .iter()
        .cloned()
        .collect::<BTreeSet<_>>();
    if selected.len() != plan.selected_candidate_ids.len() {
        return Err(ControlPlaneError::PlanInvalid);
    }
    for candidate_id in &selected {
        let candidate = by_id
            .get(candidate_id.as_str())
            .copied()
            .ok_or(ControlPlaneError::PlanInvalid)?;
        if candidate
            .dependency_candidate_ids
            .iter()
            .any(|dependency| !selected.contains(dependency))
        {
            return Err(ControlPlaneError::PlanInvalid);
        }
    }

    let mut remaining = selected;
    let mut completed = BTreeSet::new();
    let mut waves = Vec::new();
    while !remaining.is_empty() {
        let ready_ids = remaining
            .iter()
            .filter(|candidate_id| {
                by_id.get(candidate_id.as_str()).is_some_and(|candidate| {
                    candidate
                        .dependency_candidate_ids
                        .iter()
                        .all(|dependency| completed.contains(dependency))
                })
            })
            .cloned()
            .collect::<Vec<_>>();
        if ready_ids.is_empty() {
            return Err(ControlPlaneError::PlanInvalid);
        }
        let wave = ready_ids
            .iter()
            .map(|candidate_id| {
                by_id
                    .get(candidate_id.as_str())
                    .copied()
                    .ok_or(ControlPlaneError::PlanInvalid)
            })
            .collect::<Result<Vec<_>, _>>()?;
        for candidate_id in ready_ids {
            remaining.remove(&candidate_id);
            completed.insert(candidate_id);
        }
        waves.push(wave);
    }
    Ok(waves)
}
