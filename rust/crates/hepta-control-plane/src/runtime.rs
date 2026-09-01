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
    C: CommitSequencerV1,
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
    C: CommitSequencerV1,
{
    /// Creates a source composition without production or external authority.
    #[allow(clippy::too_many_arguments)]
    pub fn new(
        registry: ModuleRegistryArtifactV1,
        hard_policy: HardPolicyV1,
        planner_policy: PlannerPolicyV1,
        allocator: ResourceAllocatorV1,
        executor: E,
        verifier: V,
        sequencer: C,
        events: BoundedEventLogV1,
    ) -> Result<Self, ControlPlaneError> {
        registry
            .validate()
            .map_err(|_| ControlPlaneError::ModulePlatformRejected)?;
        hard_policy.validate()?;
        planner_policy.validate()?;
        if hard_policy.external_actions_authorized {
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

    /// Runs snapshot → plan → reserve → prepare → verify → serialized commit.
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
        {
            return Err(ControlPlaneError::SnapshotInvalid);
        }
        frontier.validate(snapshot, &self.registry, &self.hard_policy)?;
        let snapshot_hash = snapshot.snapshot_hash()?;
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
        let plan = select_plan_v1(snapshot, frontier, &self.hard_policy, &self.planner_policy)?;
        self.emit(
            ControlPlaneEventKindV1::PlanSelected,
            &snapshot_hash,
            Some(&plan.plan_hash),
            None,
            None,
            None,
            plan.plan_hash.clone(),
        )?;

        let ordered = dependency_order(frontier, &plan)?;
        let (requests, reservation_ids) = self.reserve_selected(
            snapshot,
            &snapshot_hash,
            &plan,
            &ordered,
            tenant_id,
            now_unix_ms,
        )?;
        let processed = self.process_admitted(&snapshot_hash, &plan, &ordered, &requests);
        let cleanup = self.release_selected(&snapshot_hash, &plan, &ordered, &reservation_ids);
        let processed = match (processed, cleanup) {
            (_, Err(error)) => return Err(error),
            (Err(error), Ok(())) => return Err(error),
            (Ok(processed), Ok(())) => processed,
        };

        let resource_report = self.allocator.report()?;
        if !resource_report.reserved.is_zero() || resource_report.reservation_count != 0 {
            return Err(ControlPlaneError::ReconciliationInvalid);
        }
        let run_events = self
            .events
            .events()
            .get(event_start..)
            .ok_or(ControlPlaneError::ObservabilityBudgetExceeded)?;
        let event_log_hash = canonical_hash_v1(run_events)?;
        let body = ControlPlaneRunBodyV1 {
            version: 1,
            snapshot_hash,
            plan,
            prepared_result_hashes: processed.prepared_result_hashes,
            commit_receipts: processed.commit_receipts,
            resource_report,
            event_log_hash,
            automatic_activation: false,
            production_activation: false,
        };
        let receipt_hash = canonical_hash_v1(&body)?;
        Ok(ControlPlaneRunReceiptV1 {
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
        })
    }

    /// Borrows all emitted bounded events.
    #[must_use]
    pub fn events(&self) -> &[ControlPlaneEventV1] {
        self.events.events()
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
            let reservation = match self.allocator.reserve(AdmissionRequestV1 {
                reservation_id: reservation_id.clone(),
                tenant_id: tenant_id.to_owned(),
                module_id: candidate.module_id.clone(),
                candidate_id: candidate.candidate_id.clone(),
                resources: candidate.resources,
                queued_at_unix_ms: now_unix_ms,
                deadline_unix_ms: None,
            }) {
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
        ordered: &[&ActionCandidateV1],
        requests: &[ExecutionRequestV1],
    ) -> Result<ProcessedRunV1, ControlPlaneError> {
        let prepared = self.executor.execute_batch(requests)?;
        if prepared.len() != requests.len() {
            return Err(ControlPlaneError::ExecutionInvalid);
        }
        let prepared_by_candidate = prepared
            .into_iter()
            .map(|result| (result.candidate_hash.clone(), result))
            .collect::<BTreeMap<_, _>>();
        if prepared_by_candidate.len() != requests.len() {
            return Err(ControlPlaneError::ExecutionInvalid);
        }

        let mut verified = Vec::<VerifiedPreparedResultV1>::with_capacity(requests.len());
        let mut prepared_result_hashes = Vec::with_capacity(requests.len());
        for request in requests {
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
            prepared_result_hashes.push(accepted.result_hash.clone());
            self.emit(
                ControlPlaneEventKindV1::ResultVerified,
                snapshot_hash,
                Some(&plan.plan_hash),
                Some(&request.candidate.candidate_id),
                Some(&request.candidate.module_id),
                Some(&request.reservation.reservation_id),
                accepted.result_hash.clone(),
            )?;
            self.allocator.reconcile(
                &request.reservation.reservation_id,
                accepted.result.actual_resources,
            )?;
            verified.push(accepted);
        }

        let mut commit_receipts = Vec::with_capacity(verified.len());
        for (index, accepted) in verified.into_iter().enumerate() {
            let sequence = u64::try_from(index)
                .ok()
                .and_then(|value| value.checked_add(1))
                .ok_or(ControlPlaneError::CommitInvalid)?;
            let candidate = ordered.get(index).ok_or(ControlPlaneError::CommitInvalid)?;
            let request = requests
                .get(index)
                .ok_or(ControlPlaneError::CommitInvalid)?;
            let receipt = self.sequencer.commit(CommitRequestV1 {
                version: 1,
                plan_hash: plan.plan_hash.clone(),
                sequence,
                verified: accepted,
            })?;
            self.emit(
                ControlPlaneEventKindV1::ResultCommitted,
                snapshot_hash,
                Some(&plan.plan_hash),
                Some(&candidate.candidate_id),
                Some(&candidate.module_id),
                Some(&request.reservation.reservation_id),
                receipt.committed_state_hash.clone(),
            )?;
            commit_receipts.push(receipt);
        }
        Ok(ProcessedRunV1 {
            prepared_result_hashes,
            commit_receipts,
        })
    }

    fn release_selected(
        &mut self,
        snapshot_hash: &Sha256Digest,
        plan: &PlanCertificateV1,
        ordered: &[&ActionCandidateV1],
        reservation_ids: &[String],
    ) -> Result<(), ControlPlaneError> {
        let mut first_error = None;
        for (index, reservation_id) in reservation_ids.iter().enumerate() {
            match self.allocator.release(reservation_id) {
                Ok(released) => {
                    let candidate = ordered.get(index);
                    let event = candidate
                        .ok_or(ControlPlaneError::ReservationInvalid)
                        .and_then(|candidate| {
                            self.emit(
                                ControlPlaneEventKindV1::ResourceReleased,
                                snapshot_hash,
                                Some(&plan.plan_hash),
                                Some(&candidate.candidate_id),
                                Some(&candidate.module_id),
                                Some(reservation_id),
                                released.reservation_hash,
                            )
                        });
                    if first_error.is_none() {
                        first_error = event.err();
                    }
                }
                Err(error) => {
                    if first_error.is_none() {
                        first_error = Some(error);
                    }
                }
            }
        }
        match first_error {
            Some(error) => Err(error),
            None => Ok(()),
        }
    }

    fn release_without_events(
        &mut self,
        reservation_ids: &[String],
    ) -> Result<(), ControlPlaneError> {
        let mut first_error = None;
        for reservation_id in reservation_ids {
            if let Err(error) = self.allocator.release(reservation_id) {
                if first_error.is_none() {
                    first_error = Some(error);
                }
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
        self.events.push(ControlPlaneEventV1 {
            ordinal: 0,
            kind,
            snapshot_hash: snapshot_hash.clone(),
            plan_hash: plan_hash.cloned(),
            candidate_id: candidate_id.map(str::to_owned),
            module_id: module_id.map(str::to_owned),
            reservation_id: reservation_id.map(str::to_owned),
            subject_hash,
        })
    }
}

struct ProcessedRunV1 {
    prepared_result_hashes: Vec<Sha256Digest>,
    commit_receipts: Vec<CommitReceiptV1>,
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

fn dependency_order<'a>(
    frontier: &'a PlanningFrontierV1,
    plan: &PlanCertificateV1,
) -> Result<Vec<&'a ActionCandidateV1>, ControlPlaneError> {
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
    let mut ordered = Vec::with_capacity(selected.len());
    let mut visiting = BTreeSet::new();
    let mut visited = BTreeSet::new();
    for candidate_id in &plan.selected_candidate_ids {
        visit_selected(
            candidate_id,
            &selected,
            &by_id,
            &mut visiting,
            &mut visited,
            &mut ordered,
        )?;
    }
    Ok(ordered)
}

fn visit_selected<'a>(
    candidate_id: &str,
    selected: &BTreeSet<String>,
    by_id: &BTreeMap<&str, &'a ActionCandidateV1>,
    visiting: &mut BTreeSet<String>,
    visited: &mut BTreeSet<String>,
    ordered: &mut Vec<&'a ActionCandidateV1>,
) -> Result<(), ControlPlaneError> {
    if visited.contains(candidate_id) {
        return Ok(());
    }
    if !selected.contains(candidate_id) || !visiting.insert(candidate_id.to_owned()) {
        return Err(ControlPlaneError::PlanInvalid);
    }
    let candidate = by_id
        .get(candidate_id)
        .copied()
        .ok_or(ControlPlaneError::PlanInvalid)?;
    for dependency_id in &candidate.dependency_candidate_ids {
        visit_selected(dependency_id, selected, by_id, visiting, visited, ordered)?;
    }
    visiting.remove(candidate_id);
    visited.insert(candidate_id.to_owned());
    ordered.push(candidate);
    Ok(())
}
