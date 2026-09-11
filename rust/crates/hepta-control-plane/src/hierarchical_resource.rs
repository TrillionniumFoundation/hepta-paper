use std::collections::{BTreeMap, BTreeSet};

use hepta_codex_protocol::Sha256Digest;
use hepta_module_platform::ResourceVectorV1;
use serde::{Deserialize, Serialize};
use thiserror::Error;

use crate::canonical_hash_v1;

const MAXIMUM_SCOPES: usize = 16_384;
const MAXIMUM_DEPTH: usize = 32;

/// One explicit capacity scope in the host -> service -> team -> campaign hierarchy.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ResourceScopeV1 {
    pub scope_id: String,
    pub parent_scope_id: Option<String>,
    pub hard_limit: ResourceVectorV1,
    pub guaranteed_share: ResourceVectorV1,
    pub burst_allowance: ResourceVectorV1,
    pub weight: u32,
    pub maximum_reservation_horizon_ms: u64,
}

/// Exact request for conservative prepare-before-dispatch resource admission.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct HierarchicalReservationRequestV1 {
    pub reservation_id: String,
    pub attempt_id: String,
    pub owner_principal: String,
    pub worker_identity: String,
    pub leaf_scope_id: String,
    pub plan_hash: Sha256Digest,
    pub action_hash: Sha256Digest,
    pub resources: ResourceVectorV1,
    pub capacity_generation: u64,
    pub accounting_generation: u64,
    pub requested_at_unix_ms: u64,
    pub expires_at_unix_ms: u64,
}

/// Prepared reservation: charged to all ancestors but not dispatch-authorized.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PreparedHierarchicalReservationV1 {
    pub request: HierarchicalReservationRequestV1,
    pub fence_generation: u64,
    pub prepared_hash: Sha256Digest,
}

/// Finalized renewable lease. Its dispatch capability is single-operation identity,
/// not a provider credential or authority grant.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ResourceLeaseV1 {
    pub request: HierarchicalReservationRequestV1,
    pub fence_generation: u64,
    pub finalized_at_unix_ms: u64,
    pub dispatch_capability_hash: Sha256Digest,
    pub lease_hash: Sha256Digest,
}

/// Complete hierarchical accounting snapshot.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct HierarchicalAccountingReportV1 {
    pub version: u16,
    pub capacity_generation: u64,
    pub accounting_generation: u64,
    pub scope_reserved: BTreeMap<String, ResourceVectorV1>,
    pub prepared_count: usize,
    pub finalized_count: usize,
    pub last_observed_unix_ms: Option<u64>,
    pub report_hash: Sha256Digest,
}

/// Source-level hierarchical allocator with prepared/finalized reservations,
/// generation fencing, deterministic weighted DRF+aging, renewals and recovery.
#[derive(Clone, Debug)]
pub struct HierarchicalResourceAllocatorV1 {
    scopes: BTreeMap<String, ResourceScopeV1>,
    root_scope_id: String,
    scope_reserved: BTreeMap<String, ResourceVectorV1>,
    prepared: BTreeMap<String, PreparedHierarchicalReservationV1>,
    finalized: BTreeMap<String, ResourceLeaseV1>,
    capacity_generation: u64,
    accounting_generation: u64,
    next_fence_generation: u64,
    aging_micros_per_ms: u64,
    last_observed_unix_ms: Option<u64>,
}

impl HierarchicalResourceAllocatorV1 {
    pub fn new(
        scopes: Vec<ResourceScopeV1>,
        capacity_generation: u64,
        accounting_generation: u64,
        aging_micros_per_ms: u64,
    ) -> Result<Self, HierarchicalResourceError> {
        if scopes.is_empty()
            || scopes.len() > MAXIMUM_SCOPES
            || capacity_generation == 0
            || accounting_generation == 0
            || aging_micros_per_ms == 0
        {
            return Err(HierarchicalResourceError::HierarchyInvalid);
        }
        let mut map = BTreeMap::new();
        for scope in scopes {
            validate_scope(&scope)?;
            if map.insert(scope.scope_id.clone(), scope).is_some() {
                return Err(HierarchicalResourceError::HierarchyInvalid);
            }
        }
        let roots = map
            .values()
            .filter(|scope| scope.parent_scope_id.is_none())
            .map(|scope| scope.scope_id.clone())
            .collect::<Vec<_>>();
        if roots.len() != 1 {
            return Err(HierarchicalResourceError::HierarchyInvalid);
        }
        for scope in map.values() {
            if let Some(parent_id) = &scope.parent_scope_id {
                let parent = map
                    .get(parent_id)
                    .ok_or(HierarchicalResourceError::HierarchyInvalid)?;
                if !scope.hard_limit.fits_within(parent.hard_limit) {
                    return Err(HierarchicalResourceError::HierarchyInvalid);
                }
            }
            validate_path(&map, &scope.scope_id)?;
        }
        Ok(Self {
            scopes: map,
            root_scope_id: roots[0].clone(),
            scope_reserved: BTreeMap::new(),
            prepared: BTreeMap::new(),
            finalized: BTreeMap::new(),
            capacity_generation,
            accounting_generation,
            next_fence_generation: 1,
            aging_micros_per_ms,
            last_observed_unix_ms: None,
        })
    }

    #[must_use]
    pub fn root_scope_id(&self) -> &str {
        &self.root_scope_id
    }

    /// Deterministically ranks pending requests by leaf dominant share, weight,
    /// deadline and bounded age. Admission still rechecks every ancestor ceiling.
    pub fn rank_requests(
        &mut self,
        requests: &[HierarchicalReservationRequestV1],
        now_unix_ms: u64,
    ) -> Result<Vec<HierarchicalReservationRequestV1>, HierarchicalResourceError> {
        self.validate_clock(now_unix_ms)?;
        let mut keyed = Vec::with_capacity(requests.len());
        for request in requests {
            self.validate_request(request, now_unix_ms)?;
            let scope = self
                .scopes
                .get(&request.leaf_scope_id)
                .ok_or(HierarchicalResourceError::RequestInvalid)?;
            let current = self
                .scope_reserved
                .get(&request.leaf_scope_id)
                .copied()
                .unwrap_or_default();
            let projected = current
                .checked_add(request.resources)
                .map_err(|_| HierarchicalResourceError::CapacityDenied)?;
            let entitlement = scope
                .guaranteed_share
                .checked_add(scope.burst_allowance)
                .map_err(|_| HierarchicalResourceError::HierarchyInvalid)?;
            let dominant = dominant_share_ppm(projected, entitlement);
            let weighted = dominant.saturating_mul(1_000_000) / u128::from(scope.weight);
            let waited = now_unix_ms.saturating_sub(request.requested_at_unix_ms);
            let age = u128::from(waited).saturating_mul(u128::from(self.aging_micros_per_ms));
            keyed.push((
                weighted.saturating_sub(age),
                request.expires_at_unix_ms,
                request.requested_at_unix_ms,
                request.reservation_id.clone(),
                request.clone(),
            ));
        }
        keyed.sort_by(|left, right| left.0.cmp(&right.0).then_with(|| left.1.cmp(&right.1)).then_with(|| left.2.cmp(&right.2)).then_with(|| left.3.cmp(&right.3)));
        self.last_observed_unix_ms = Some(now_unix_ms);
        Ok(keyed.into_iter().map(|item| item.4).collect())
    }

    /// Charges the complete vector at every ancestor before any dispatch is possible.
    pub fn prepare(
        &mut self,
        request: HierarchicalReservationRequestV1,
        now_unix_ms: u64,
    ) -> Result<PreparedHierarchicalReservationV1, HierarchicalResourceError> {
        self.validate_clock(now_unix_ms)?;
        self.validate_request(&request, now_unix_ms)?;
        if self.prepared.contains_key(&request.reservation_id)
            || self.finalized.contains_key(&request.reservation_id)
        {
            return Err(HierarchicalResourceError::ReservationConflict);
        }
        let path = self.scope_path(&request.leaf_scope_id)?;
        for scope_id in &path {
            let scope = self.scopes.get(scope_id).ok_or(HierarchicalResourceError::HierarchyInvalid)?;
            let current = self.scope_reserved.get(scope_id).copied().unwrap_or_default();
            let next = current.checked_add(request.resources).map_err(|_| HierarchicalResourceError::CapacityDenied)?;
            if !next.fits_within(scope.hard_limit) {
                return Err(HierarchicalResourceError::CapacityDenied);
            }
        }
        let body = PreparedBodyV1 {
            request: &request,
            fence_generation: self.next_fence_generation,
        };
        let prepared_hash = canonical_hash_v1(&body).map_err(|_| HierarchicalResourceError::Encoding)?;
        let prepared = PreparedHierarchicalReservationV1 {
            request,
            fence_generation: body.fence_generation,
            prepared_hash,
        };
        for scope_id in &path {
            let current = self.scope_reserved.get(scope_id).copied().unwrap_or_default();
            let next = current.checked_add(prepared.request.resources).map_err(|_| HierarchicalResourceError::CapacityDenied)?;
            self.scope_reserved.insert(scope_id.clone(), next);
        }
        self.next_fence_generation = self
            .next_fence_generation
            .checked_add(1)
            .ok_or(HierarchicalResourceError::NumericOverflow)?;
        self.last_observed_unix_ms = Some(now_unix_ms);
        self.prepared.insert(prepared.request.reservation_id.clone(), prepared.clone());
        Ok(prepared)
    }

    /// Finalizes a prepared reservation only while its exact generations and
    /// prepared identity remain current.
    pub fn finalize(
        &mut self,
        reservation_id: &str,
        expected_prepared_hash: &Sha256Digest,
        now_unix_ms: u64,
    ) -> Result<ResourceLeaseV1, HierarchicalResourceError> {
        self.validate_clock(now_unix_ms)?;
        let prepared = self
            .prepared
            .get(reservation_id)
            .cloned()
            .ok_or(HierarchicalResourceError::ReservationMissing)?;
        if &prepared.prepared_hash != expected_prepared_hash
            || prepared.request.capacity_generation != self.capacity_generation
            || prepared.request.accounting_generation != self.accounting_generation
            || now_unix_ms >= prepared.request.expires_at_unix_ms
        {
            return Err(HierarchicalResourceError::FenceRejected);
        }
        let dispatch_body = DispatchBodyV1 {
            reservation_id,
            attempt_id: &prepared.request.attempt_id,
            fence_generation: prepared.fence_generation,
            plan_hash: &prepared.request.plan_hash,
            action_hash: &prepared.request.action_hash,
        };
        let dispatch_capability_hash = canonical_hash_v1(&dispatch_body)
            .map_err(|_| HierarchicalResourceError::Encoding)?;
        let lease_body = LeaseBodyV1 {
            request: &prepared.request,
            fence_generation: prepared.fence_generation,
            finalized_at_unix_ms: now_unix_ms,
            dispatch_capability_hash: &dispatch_capability_hash,
        };
        let lease_hash = canonical_hash_v1(&lease_body).map_err(|_| HierarchicalResourceError::Encoding)?;
        let lease = ResourceLeaseV1 {
            request: prepared.request,
            fence_generation: prepared.fence_generation,
            finalized_at_unix_ms: now_unix_ms,
            dispatch_capability_hash,
            lease_hash,
        };
        self.prepared.remove(reservation_id);
        self.finalized.insert(reservation_id.to_owned(), lease.clone());
        self.last_observed_unix_ms = Some(now_unix_ms);
        Ok(lease)
    }

    /// Renews only the exact live owner/fence within the configured horizon.
    pub fn renew(
        &mut self,
        reservation_id: &str,
        owner_principal: &str,
        fence_generation: u64,
        now_unix_ms: u64,
        new_expires_at_unix_ms: u64,
    ) -> Result<ResourceLeaseV1, HierarchicalResourceError> {
        self.validate_clock(now_unix_ms)?;
        let mut lease = self
            .finalized
            .get(reservation_id)
            .cloned()
            .ok_or(HierarchicalResourceError::ReservationMissing)?;
        if lease.request.owner_principal != owner_principal
            || lease.fence_generation != fence_generation
            || lease.request.capacity_generation != self.capacity_generation
            || lease.request.accounting_generation != self.accounting_generation
            || now_unix_ms >= lease.request.expires_at_unix_ms
            || new_expires_at_unix_ms <= now_unix_ms
        {
            return Err(HierarchicalResourceError::FenceRejected);
        }
        let maximum_horizon = self.maximum_horizon(&lease.request.leaf_scope_id)?;
        if new_expires_at_unix_ms > now_unix_ms.saturating_add(maximum_horizon) {
            return Err(HierarchicalResourceError::FenceRejected);
        }
        lease.request.expires_at_unix_ms = new_expires_at_unix_ms;
        let lease_body = LeaseBodyV1 {
            request: &lease.request,
            fence_generation: lease.fence_generation,
            finalized_at_unix_ms: lease.finalized_at_unix_ms,
            dispatch_capability_hash: &lease.dispatch_capability_hash,
        };
        lease.lease_hash = canonical_hash_v1(&lease_body).map_err(|_| HierarchicalResourceError::Encoding)?;
        self.finalized.insert(reservation_id.to_owned(), lease.clone());
        self.last_observed_unix_ms = Some(now_unix_ms);
        Ok(lease)
    }

    /// Reconciles observed use conservatively; excess use never creates capacity.
    pub fn reconcile(
        &mut self,
        reservation_id: &str,
        actual: ResourceVectorV1,
    ) -> Result<ResourceLeaseV1, HierarchicalResourceError> {
        let mut lease = self
            .finalized
            .get(reservation_id)
            .cloned()
            .ok_or(HierarchicalResourceError::ReservationMissing)?;
        if !actual.fits_within(lease.request.resources) {
            return Err(HierarchicalResourceError::ReconciliationRejected);
        }
        let released = lease
            .request
            .resources
            .checked_sub(actual)
            .map_err(|_| HierarchicalResourceError::ReconciliationRejected)?;
        if released.is_zero() {
            return Ok(lease);
        }
        self.release_vector(&lease.request.leaf_scope_id, released)?;
        lease.request.resources = actual;
        let lease_body = LeaseBodyV1 {
            request: &lease.request,
            fence_generation: lease.fence_generation,
            finalized_at_unix_ms: lease.finalized_at_unix_ms,
            dispatch_capability_hash: &lease.dispatch_capability_hash,
        };
        lease.lease_hash = canonical_hash_v1(&lease_body).map_err(|_| HierarchicalResourceError::Encoding)?;
        self.finalized.insert(reservation_id.to_owned(), lease.clone());
        Ok(lease)
    }

    /// Releases one exact finalized lease and all ancestor accounting.
    pub fn release(&mut self, reservation_id: &str) -> Result<ResourceLeaseV1, HierarchicalResourceError> {
        let lease = self
            .finalized
            .remove(reservation_id)
            .ok_or(HierarchicalResourceError::ReservationMissing)?;
        self.release_vector(&lease.request.leaf_scope_id, lease.request.resources)?;
        Ok(lease)
    }

    /// Advances externally observed capacity/accounting generations. Existing
    /// finalized leases remain charged but cannot renew; stale prepared entries
    /// are removed by `reap_stale_prepared` before their capacity is reused.
    pub fn advance_generations(
        &mut self,
        capacity_generation: u64,
        accounting_generation: u64,
    ) -> Result<(), HierarchicalResourceError> {
        if capacity_generation <= self.capacity_generation
            || accounting_generation <= self.accounting_generation
        {
            return Err(HierarchicalResourceError::FenceRejected);
        }
        self.capacity_generation = capacity_generation;
        self.accounting_generation = accounting_generation;
        Ok(())
    }

    /// Recovers expired or generation-stale prepared reservations. It never
    /// assumes a finalized lease is safe to reclaim merely because its owner vanished.
    pub fn reap_stale_prepared(&mut self, now_unix_ms: u64) -> Result<Vec<String>, HierarchicalResourceError> {
        self.validate_clock(now_unix_ms)?;
        let stale = self
            .prepared
            .values()
            .filter(|prepared| {
                prepared.request.capacity_generation != self.capacity_generation
                    || prepared.request.accounting_generation != self.accounting_generation
                    || prepared.request.expires_at_unix_ms <= now_unix_ms
            })
            .map(|prepared| prepared.request.reservation_id.clone())
            .collect::<Vec<_>>();
        for reservation_id in &stale {
            let prepared = self
                .prepared
                .remove(reservation_id)
                .ok_or(HierarchicalResourceError::ReservationMissing)?;
            self.release_vector(&prepared.request.leaf_scope_id, prepared.request.resources)?;
        }
        self.last_observed_unix_ms = Some(now_unix_ms);
        Ok(stale)
    }

    pub fn report(&self) -> Result<HierarchicalAccountingReportV1, HierarchicalResourceError> {
        let body = AccountingBodyV1 {
            version: 1,
            capacity_generation: self.capacity_generation,
            accounting_generation: self.accounting_generation,
            scope_reserved: self.scope_reserved.clone(),
            prepared_count: self.prepared.len(),
            finalized_count: self.finalized.len(),
            last_observed_unix_ms: self.last_observed_unix_ms,
        };
        let report_hash = canonical_hash_v1(&body).map_err(|_| HierarchicalResourceError::Encoding)?;
        Ok(HierarchicalAccountingReportV1 {
            version: body.version,
            capacity_generation: body.capacity_generation,
            accounting_generation: body.accounting_generation,
            scope_reserved: body.scope_reserved,
            prepared_count: body.prepared_count,
            finalized_count: body.finalized_count,
            last_observed_unix_ms: body.last_observed_unix_ms,
            report_hash,
        })
    }

    fn validate_request(&self, request: &HierarchicalReservationRequestV1, now_unix_ms: u64) -> Result<(), HierarchicalResourceError> {
        if !valid_identifier(&request.reservation_id)
            || !valid_identifier(&request.attempt_id)
            || !valid_identifier(&request.owner_principal)
            || !valid_identifier(&request.worker_identity)
            || !self.scopes.contains_key(&request.leaf_scope_id)
            || request.resources.is_zero()
            || request.capacity_generation != self.capacity_generation
            || request.accounting_generation != self.accounting_generation
            || request.requested_at_unix_ms > now_unix_ms
            || request.expires_at_unix_ms <= now_unix_ms
            || request.expires_at_unix_ms > now_unix_ms.saturating_add(self.maximum_horizon(&request.leaf_scope_id)?)
        {
            return Err(HierarchicalResourceError::RequestInvalid);
        }
        Ok(())
    }

    fn maximum_horizon(&self, leaf_scope_id: &str) -> Result<u64, HierarchicalResourceError> {
        self.scope_path(leaf_scope_id)?
            .iter()
            .map(|scope_id| self.scopes.get(scope_id).map(|scope| scope.maximum_reservation_horizon_ms))
            .collect::<Option<Vec<_>>>()
            .and_then(|values| values.into_iter().min())
            .ok_or(HierarchicalResourceError::HierarchyInvalid)
    }

    fn scope_path(&self, leaf_scope_id: &str) -> Result<Vec<String>, HierarchicalResourceError> {
        scope_path(&self.scopes, leaf_scope_id)
    }

    fn release_vector(&mut self, leaf_scope_id: &str, resources: ResourceVectorV1) -> Result<(), HierarchicalResourceError> {
        let path = self.scope_path(leaf_scope_id)?;
        for scope_id in path {
            let current = self.scope_reserved.get(&scope_id).copied().unwrap_or_default();
            let next = current.checked_sub(resources).map_err(|_| HierarchicalResourceError::AccountingCorrupt)?;
            if next.is_zero() {
                self.scope_reserved.remove(&scope_id);
            } else {
                self.scope_reserved.insert(scope_id, next);
            }
        }
        Ok(())
    }

    fn validate_clock(&self, now_unix_ms: u64) -> Result<(), HierarchicalResourceError> {
        if self.last_observed_unix_ms.is_some_and(|previous| now_unix_ms < previous) {
            return Err(HierarchicalResourceError::ClockRollback);
        }
        Ok(())
    }
}

fn validate_scope(scope: &ResourceScopeV1) -> Result<(), HierarchicalResourceError> {
    if !valid_identifier(&scope.scope_id)
        || scope.parent_scope_id.as_deref().is_some_and(|parent| !valid_identifier(parent) || parent == scope.scope_id)
        || scope.hard_limit.is_zero()
        || scope.guaranteed_share.is_zero()
        || !scope.guaranteed_share.fits_within(scope.hard_limit)
        || scope.weight == 0
        || scope.maximum_reservation_horizon_ms == 0
    {
        return Err(HierarchicalResourceError::HierarchyInvalid);
    }
    let entitled = scope.guaranteed_share.checked_add(scope.burst_allowance).map_err(|_| HierarchicalResourceError::HierarchyInvalid)?;
    if !entitled.fits_within(scope.hard_limit) {
        return Err(HierarchicalResourceError::HierarchyInvalid);
    }
    Ok(())
}

fn validate_path(scopes: &BTreeMap<String, ResourceScopeV1>, leaf: &str) -> Result<(), HierarchicalResourceError> {
    let _ = scope_path(scopes, leaf)?;
    Ok(())
}

fn scope_path(scopes: &BTreeMap<String, ResourceScopeV1>, leaf: &str) -> Result<Vec<String>, HierarchicalResourceError> {
    let mut path = Vec::new();
    let mut seen = BTreeSet::new();
    let mut current = Some(leaf.to_owned());
    while let Some(scope_id) = current {
        if path.len() >= MAXIMUM_DEPTH || !seen.insert(scope_id.clone()) {
            return Err(HierarchicalResourceError::HierarchyInvalid);
        }
        let scope = scopes.get(&scope_id).ok_or(HierarchicalResourceError::HierarchyInvalid)?;
        path.push(scope_id);
        current = scope.parent_scope_id.clone();
    }
    Ok(path)
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct PreparedBodyV1<'a> {
    request: &'a HierarchicalReservationRequestV1,
    fence_generation: u64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct DispatchBodyV1<'a> {
    reservation_id: &'a str,
    attempt_id: &'a str,
    fence_generation: u64,
    plan_hash: &'a Sha256Digest,
    action_hash: &'a Sha256Digest,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct LeaseBodyV1<'a> {
    request: &'a HierarchicalReservationRequestV1,
    fence_generation: u64,
    finalized_at_unix_ms: u64,
    dispatch_capability_hash: &'a Sha256Digest,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct AccountingBodyV1 {
    version: u16,
    capacity_generation: u64,
    accounting_generation: u64,
    scope_reserved: BTreeMap<String, ResourceVectorV1>,
    prepared_count: usize,
    finalized_count: usize,
    last_observed_unix_ms: Option<u64>,
}

fn dominant_share_ppm(usage: ResourceVectorV1, entitlement: ResourceVectorV1) -> u128 {
    [
        share(usage.cpu_millis, entitlement.cpu_millis),
        share(usage.gpu_millis, entitlement.gpu_millis),
        share(usage.memory_bytes, entitlement.memory_bytes),
        share(usage.storage_bytes, entitlement.storage_bytes),
        share(usage.tokens, entitlement.tokens),
        share(usage.provider_calls, entitlement.provider_calls),
        share(usage.external_actions, entitlement.external_actions),
        share(usage.central_writer_turns, entitlement.central_writer_turns),
    ]
    .into_iter()
    .max()
    .unwrap_or_default()
}

fn share(value: u64, limit: u64) -> u128 {
    if value == 0 { 0 } else if limit == 0 { u128::MAX } else { u128::from(value).saturating_mul(1_000_000) / u128::from(limit) }
}

fn valid_identifier(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 128
        && value.bytes().all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b'-' | b':' | b'/'))
}

#[derive(Clone, Copy, Debug, Error, Eq, PartialEq)]
pub enum HierarchicalResourceError {
    #[error("resource hierarchy is invalid")]
    HierarchyInvalid,
    #[error("resource request is invalid")]
    RequestInvalid,
    #[error("resource capacity denied")]
    CapacityDenied,
    #[error("resource reservation conflicts with an existing identity")]
    ReservationConflict,
    #[error("resource reservation is missing")]
    ReservationMissing,
    #[error("resource fence or generation rejected the operation")]
    FenceRejected,
    #[error("resource reconciliation rejected observed usage")]
    ReconciliationRejected,
    #[error("resource accounting is internally inconsistent")]
    AccountingCorrupt,
    #[error("resource clock moved backward")]
    ClockRollback,
    #[error("resource arithmetic overflow")]
    NumericOverflow,
    #[error("resource canonical encoding failed")]
    Encoding,
}

#[cfg(test)]
mod tests {
    use super::*;

    fn vector(cpu: u64) -> ResourceVectorV1 {
        ResourceVectorV1 { cpu_millis: cpu, memory_bytes: cpu.saturating_mul(100), ..ResourceVectorV1::default() }
    }

    fn scopes() -> Vec<ResourceScopeV1> {
        vec![
            ResourceScopeV1 { scope_id: "host".into(), parent_scope_id: None, hard_limit: vector(100), guaranteed_share: vector(100), burst_allowance: ResourceVectorV1::default(), weight: 1, maximum_reservation_horizon_ms: 10_000 },
            ResourceScopeV1 { scope_id: "service".into(), parent_scope_id: Some("host".into()), hard_limit: vector(80), guaranteed_share: vector(60), burst_allowance: vector(20), weight: 1, maximum_reservation_horizon_ms: 5_000 },
            ResourceScopeV1 { scope_id: "team-a".into(), parent_scope_id: Some("service".into()), hard_limit: vector(60), guaranteed_share: vector(40), burst_allowance: vector(20), weight: 1, maximum_reservation_horizon_ms: 3_000 },
            ResourceScopeV1 { scope_id: "campaign-a".into(), parent_scope_id: Some("team-a".into()), hard_limit: vector(50), guaranteed_share: vector(30), burst_allowance: vector(20), weight: 1, maximum_reservation_horizon_ms: 2_000 },
        ]
    }

    fn digest(byte: char) -> Sha256Digest {
        format!("sha256:{}", byte.to_string().repeat(64)).parse().expect("digest")
    }

    fn request(id: &str, cpu: u64, requested: u64, expires: u64) -> HierarchicalReservationRequestV1 {
        HierarchicalReservationRequestV1 {
            reservation_id: id.into(), attempt_id: format!("attempt-{id}"), owner_principal: "principal:worker".into(), worker_identity: "worker:1".into(), leaf_scope_id: "campaign-a".into(), plan_hash: digest('a'), action_hash: digest('b'), resources: vector(cpu), capacity_generation: 1, accounting_generation: 1, requested_at_unix_ms: requested, expires_at_unix_ms: expires,
        }
    }

    #[test]
    fn hierarchy_charges_every_ancestor_and_enforces_child_ceiling() {
        let mut allocator = HierarchicalResourceAllocatorV1::new(scopes(), 1, 1, 1_000).expect("allocator");
        allocator.prepare(request("one", 40, 0, 1_000), 0).expect("first");
        assert_eq!(allocator.prepare(request("two", 20, 0, 1_000), 0), Err(HierarchicalResourceError::CapacityDenied));
        let report = allocator.report().expect("report");
        assert_eq!(report.scope_reserved["host"].cpu_millis, 40);
        assert_eq!(report.scope_reserved["campaign-a"].cpu_millis, 40);
    }

    #[test]
    fn prepare_finalize_renew_and_release_are_generation_fenced() {
        let mut allocator = HierarchicalResourceAllocatorV1::new(scopes(), 1, 1, 1_000).expect("allocator");
        let prepared = allocator.prepare(request("one", 20, 0, 1_000), 0).expect("prepare");
        let lease = allocator.finalize("one", &prepared.prepared_hash, 10).expect("finalize");
        assert_eq!(lease.fence_generation, prepared.fence_generation);
        let renewed = allocator.renew("one", "principal:worker", lease.fence_generation, 20, 1_500).expect("renew");
        assert_eq!(renewed.request.expires_at_unix_ms, 1_500);
        allocator.release("one").expect("release");
        assert!(allocator.report().expect("report").scope_reserved.is_empty());
    }

    #[test]
    fn stale_prepared_capacity_is_recovered_but_finalized_capacity_is_not_invented_free() {
        let mut allocator = HierarchicalResourceAllocatorV1::new(scopes(), 1, 1, 1_000).expect("allocator");
        allocator.prepare(request("prepared", 20, 0, 1_000), 0).expect("prepare");
        let finalized = allocator.prepare(request("finalized", 20, 0, 1_000), 0).expect("prepare two");
        allocator.finalize("finalized", &finalized.prepared_hash, 10).expect("finalize");
        allocator.advance_generations(2, 2).expect("advance");
        let reaped = allocator.reap_stale_prepared(20).expect("reap");
        assert_eq!(reaped, vec!["prepared".to_owned()]);
        assert_eq!(allocator.report().expect("report").scope_reserved["host"].cpu_millis, 20);
    }

    #[test]
    fn aging_promotes_an_old_eligible_request_deterministically() {
        let mut allocator = HierarchicalResourceAllocatorV1::new(scopes(), 1, 1, 10_000).expect("allocator");
        let fresh = request("fresh", 1, 9_000, 10_500);
        let old = request("old", 1, 0, 10_500);
        let ranked = allocator.rank_requests(&[fresh, old.clone()], 10_000).expect("rank");
        assert_eq!(ranked.first(), Some(&old));
    }
}
