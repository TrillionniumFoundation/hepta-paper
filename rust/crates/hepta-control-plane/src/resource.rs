use std::collections::BTreeMap;

use hepta_codex_protocol::Sha256Digest;
use hepta_module_platform::ResourceVectorV1;
use serde::{Deserialize, Serialize};

use crate::{ControlPlaneError, canonical_hash_v1};

/// One queued request for hierarchical multi-resource admission.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AdmissionRequestV1 {
    /// Stable reservation ID.
    pub reservation_id: String,
    /// Tenant or campaign scheduling domain.
    pub tenant_id: String,
    /// Producing module ID.
    pub module_id: String,
    /// Candidate ID.
    pub candidate_id: String,
    /// Maximum reserved resources.
    pub resources: ResourceVectorV1,
    /// Monotonic queue timestamp.
    pub queued_at_unix_ms: u64,
    /// Optional hard deadline.
    pub deadline_unix_ms: Option<u64>,
}

impl AdmissionRequestV1 {
    fn validate(&self) -> Result<(), ControlPlaneError> {
        if !valid_identifier(&self.reservation_id)
            || !valid_identifier(&self.tenant_id)
            || !valid_module_id(&self.module_id)
            || !valid_identifier(&self.candidate_id)
            || self.resources.is_zero()
            || self
                .deadline_unix_ms
                .is_some_and(|deadline| deadline < self.queued_at_unix_ms)
        {
            return Err(ControlPlaneError::ResourcePolicyInvalid);
        }
        Ok(())
    }
}

/// Active exact reservation.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ResourceReservationV1 {
    /// Stable reservation ID.
    pub reservation_id: String,
    /// Tenant scheduling domain.
    pub tenant_id: String,
    /// Module ID.
    pub module_id: String,
    /// Candidate ID.
    pub candidate_id: String,
    /// Reserved maximum.
    pub reserved: ResourceVectorV1,
    /// Admission order.
    pub admission_sequence: u64,
    /// Canonical reservation hash.
    pub reservation_hash: Sha256Digest,
}

/// Deterministic allocator snapshot and accounting proof.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ResourceAccountingReportV1 {
    /// Contract version.
    pub version: u16,
    /// Global capacity.
    pub capacity: ResourceVectorV1,
    /// Total active reservations.
    pub reserved: ResourceVectorV1,
    /// Unreserved capacity.
    pub remaining: ResourceVectorV1,
    /// Active usage by tenant.
    pub tenant_reserved: BTreeMap<String, ResourceVectorV1>,
    /// Number of active reservations.
    pub reservation_count: usize,
    /// Canonical report hash.
    pub report_hash: Sha256Digest,
}

/// Fail-closed multi-resource allocator with weighted dominant-share ranking.
#[derive(Clone, Debug)]
pub struct ResourceAllocatorV1 {
    capacity: ResourceVectorV1,
    reserved: ResourceVectorV1,
    tenant_limits: BTreeMap<String, ResourceVectorV1>,
    tenant_weights: BTreeMap<String, u32>,
    tenant_reserved: BTreeMap<String, ResourceVectorV1>,
    reservations: BTreeMap<String, ResourceReservationV1>,
    next_sequence: u64,
    aging_micros_per_ms: u64,
}

impl ResourceAllocatorV1 {
    /// Creates an allocator with exact global and tenant capacities.
    pub fn new(
        capacity: ResourceVectorV1,
        tenant_limits: BTreeMap<String, ResourceVectorV1>,
        tenant_weights: BTreeMap<String, u32>,
        aging_micros_per_ms: u64,
    ) -> Result<Self, ControlPlaneError> {
        if capacity.is_zero()
            || tenant_limits.is_empty()
            || tenant_limits.keys().ne(tenant_weights.keys())
            || tenant_limits
                .values()
                .any(|limit| limit.is_zero() || !limit.fits_within(capacity))
            || tenant_weights.values().any(|weight| *weight == 0)
            || aging_micros_per_ms == 0
        {
            return Err(ControlPlaneError::ResourcePolicyInvalid);
        }
        Ok(Self {
            capacity,
            reserved: ResourceVectorV1::default(),
            tenant_limits,
            tenant_weights,
            tenant_reserved: BTreeMap::new(),
            reservations: BTreeMap::new(),
            next_sequence: 1,
            aging_micros_per_ms,
        })
    }

    /// Returns the immutable global capacity.
    #[must_use]
    pub fn capacity(&self) -> ResourceVectorV1 {
        self.capacity
    }

    /// Returns requests in deterministic weighted dominant-resource/aging order.
    pub fn rank_requests(
        &self,
        requests: &[AdmissionRequestV1],
        now_unix_ms: u64,
    ) -> Result<Vec<AdmissionRequestV1>, ControlPlaneError> {
        let mut keyed = Vec::with_capacity(requests.len());
        for request in requests {
            request.validate()?;
            if !self.tenant_limits.contains_key(&request.tenant_id) {
                return Err(ControlPlaneError::ResourcePolicyInvalid);
            }
            keyed.push((self.rank_key(request, now_unix_ms)?, request.clone()));
        }
        keyed.sort_by(|left, right| {
            left.0
                .cmp(&right.0)
                .then_with(|| left.1.reservation_id.cmp(&right.1.reservation_id))
        });
        Ok(keyed.into_iter().map(|(_, request)| request).collect())
    }

    /// Reserves the request exactly when global and tenant ceilings permit it.
    pub fn reserve(
        &mut self,
        request: AdmissionRequestV1,
    ) -> Result<ResourceReservationV1, ControlPlaneError> {
        request.validate()?;
        if self.reservations.contains_key(&request.reservation_id) {
            return Err(ControlPlaneError::ReservationInvalid);
        }
        let tenant_limit = self
            .tenant_limits
            .get(&request.tenant_id)
            .copied()
            .ok_or(ControlPlaneError::ResourcePolicyInvalid)?;
        let tenant_current = self
            .tenant_reserved
            .get(&request.tenant_id)
            .copied()
            .unwrap_or_default();
        let global_next = self
            .reserved
            .checked_add(request.resources)
            .map_err(|_| ControlPlaneError::ResourceDenied)?;
        let tenant_next = tenant_current
            .checked_add(request.resources)
            .map_err(|_| ControlPlaneError::ResourceDenied)?;
        if !global_next.fits_within(self.capacity) || !tenant_next.fits_within(tenant_limit) {
            return Err(ControlPlaneError::ResourceDenied);
        }
        let body = ReservationBodyV1 {
            reservation_id: request.reservation_id.clone(),
            tenant_id: request.tenant_id.clone(),
            module_id: request.module_id.clone(),
            candidate_id: request.candidate_id.clone(),
            reserved: request.resources,
            admission_sequence: self.next_sequence,
        };
        let reservation = ResourceReservationV1 {
            reservation_id: body.reservation_id,
            tenant_id: body.tenant_id,
            module_id: body.module_id,
            candidate_id: body.candidate_id,
            reserved: body.reserved,
            admission_sequence: body.admission_sequence,
            reservation_hash: canonical_hash_v1(&body)?,
        };
        self.next_sequence = self
            .next_sequence
            .checked_add(1)
            .ok_or(ControlPlaneError::ResourcePolicyInvalid)?;
        self.reserved = global_next;
        self.tenant_reserved
            .insert(reservation.tenant_id.clone(), tenant_next);
        self.reservations
            .insert(reservation.reservation_id.clone(), reservation.clone());
        Ok(reservation)
    }

    /// Reconciles actual use against the admitted maximum without releasing it.
    pub fn reconcile(
        &mut self,
        reservation_id: &str,
        actual: ResourceVectorV1,
    ) -> Result<ResourceReservationV1, ControlPlaneError> {
        let current = self
            .reservations
            .get(reservation_id)
            .cloned()
            .ok_or(ControlPlaneError::ReservationInvalid)?;
        if !actual.fits_within(current.reserved) {
            return Err(ControlPlaneError::ReconciliationInvalid);
        }
        if actual == current.reserved {
            return Ok(current);
        }
        let released = current
            .reserved
            .checked_sub(actual)
            .map_err(|_| ControlPlaneError::ReconciliationInvalid)?;
        self.reserved = self
            .reserved
            .checked_sub(released)
            .map_err(|_| ControlPlaneError::ReconciliationInvalid)?;
        let tenant_current = self
            .tenant_reserved
            .get(&current.tenant_id)
            .copied()
            .ok_or(ControlPlaneError::ReconciliationInvalid)?;
        let tenant_next = tenant_current
            .checked_sub(released)
            .map_err(|_| ControlPlaneError::ReconciliationInvalid)?;
        self.tenant_reserved
            .insert(current.tenant_id.clone(), tenant_next);
        let body = ReservationBodyV1 {
            reservation_id: current.reservation_id.clone(),
            tenant_id: current.tenant_id.clone(),
            module_id: current.module_id.clone(),
            candidate_id: current.candidate_id.clone(),
            reserved: actual,
            admission_sequence: current.admission_sequence,
        };
        let reconciled = ResourceReservationV1 {
            reservation_id: body.reservation_id,
            tenant_id: body.tenant_id,
            module_id: body.module_id,
            candidate_id: body.candidate_id,
            reserved: body.reserved,
            admission_sequence: body.admission_sequence,
            reservation_hash: canonical_hash_v1(&body)?,
        };
        self.reservations
            .insert(reservation_id.to_owned(), reconciled.clone());
        Ok(reconciled)
    }

    /// Releases one exact reservation and returns it for audit.
    pub fn release(
        &mut self,
        reservation_id: &str,
    ) -> Result<ResourceReservationV1, ControlPlaneError> {
        let reservation = self
            .reservations
            .remove(reservation_id)
            .ok_or(ControlPlaneError::ReservationInvalid)?;
        self.reserved = self
            .reserved
            .checked_sub(reservation.reserved)
            .map_err(|_| ControlPlaneError::ReservationInvalid)?;
        let tenant_current = self
            .tenant_reserved
            .get(&reservation.tenant_id)
            .copied()
            .ok_or(ControlPlaneError::ReservationInvalid)?;
        let tenant_next = tenant_current
            .checked_sub(reservation.reserved)
            .map_err(|_| ControlPlaneError::ReservationInvalid)?;
        if tenant_next.is_zero() {
            self.tenant_reserved.remove(&reservation.tenant_id);
        } else {
            self.tenant_reserved
                .insert(reservation.tenant_id.clone(), tenant_next);
        }
        Ok(reservation)
    }

    /// Emits a canonical, internally reconciled accounting report.
    pub fn report(&self) -> Result<ResourceAccountingReportV1, ControlPlaneError> {
        let remaining = self
            .capacity
            .checked_sub(self.reserved)
            .map_err(|_| ControlPlaneError::ResourcePolicyInvalid)?;
        let body = ResourceAccountingBodyV1 {
            version: 1,
            capacity: self.capacity,
            reserved: self.reserved,
            remaining,
            tenant_reserved: self.tenant_reserved.clone(),
            reservation_count: self.reservations.len(),
        };
        let report_hash = canonical_hash_v1(&body)?;
        Ok(ResourceAccountingReportV1 {
            version: body.version,
            capacity: body.capacity,
            reserved: body.reserved,
            remaining: body.remaining,
            tenant_reserved: body.tenant_reserved,
            reservation_count: body.reservation_count,
            report_hash,
        })
    }

    fn rank_key(
        &self,
        request: &AdmissionRequestV1,
        now_unix_ms: u64,
    ) -> Result<(u128, u64, u64), ControlPlaneError> {
        let current = self
            .tenant_reserved
            .get(&request.tenant_id)
            .copied()
            .unwrap_or_default();
        let tenant_limit = self
            .tenant_limits
            .get(&request.tenant_id)
            .copied()
            .unwrap_or(self.capacity);
        let projected = current
            .checked_add(request.resources)
            .map_err(|_| ControlPlaneError::ResourceDenied)?;
        let dominant = dominant_share_ppm(projected, tenant_limit);
        let weight = u128::from(
            self.tenant_weights
                .get(&request.tenant_id)
                .copied()
                .unwrap_or(1),
        );
        let weighted = dominant.saturating_mul(1_000_000) / weight;
        let waited = now_unix_ms.saturating_sub(request.queued_at_unix_ms);
        let aging = u128::from(waited).saturating_mul(u128::from(self.aging_micros_per_ms));
        let adjusted = weighted.saturating_sub(aging);
        Ok((
            adjusted,
            request.deadline_unix_ms.unwrap_or(u64::MAX),
            request.queued_at_unix_ms,
        ))
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ReservationBodyV1 {
    reservation_id: String,
    tenant_id: String,
    module_id: String,
    candidate_id: String,
    reserved: ResourceVectorV1,
    admission_sequence: u64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ResourceAccountingBodyV1 {
    version: u16,
    capacity: ResourceVectorV1,
    reserved: ResourceVectorV1,
    remaining: ResourceVectorV1,
    tenant_reserved: BTreeMap<String, ResourceVectorV1>,
    reservation_count: usize,
}

fn dominant_share_ppm(usage: ResourceVectorV1, limit: ResourceVectorV1) -> u128 {
    [
        share(usage.cpu_millis, limit.cpu_millis),
        share(usage.gpu_millis, limit.gpu_millis),
        share(usage.memory_bytes, limit.memory_bytes),
        share(usage.storage_bytes, limit.storage_bytes),
        share(usage.tokens, limit.tokens),
        share(usage.provider_calls, limit.provider_calls),
        share(usage.external_actions, limit.external_actions),
        share(usage.central_writer_turns, limit.central_writer_turns),
    ]
    .into_iter()
    .max()
    .unwrap_or_default()
}

fn share(value: u64, limit: u64) -> u128 {
    if value == 0 {
        0
    } else if limit == 0 {
        u128::MAX
    } else {
        u128::from(value).saturating_mul(1_000_000) / u128::from(limit)
    }
}

fn valid_identifier(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 128
        && value.bytes().all(|byte| {
            byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b'-' | b':' | b'/')
        })
}

fn valid_module_id(value: &str) -> bool {
    value.starts_with("module.") && valid_identifier(value)
}

#[cfg(test)]
mod tests {
    use std::collections::BTreeMap;

    use super::*;

    fn capacity(cpu: u64) -> ResourceVectorV1 {
        ResourceVectorV1 {
            cpu_millis: cpu,
            memory_bytes: cpu.saturating_mul(100),
            ..ResourceVectorV1::default()
        }
    }

    fn request(id: &str, tenant: &str, cpu: u64, queued: u64) -> AdmissionRequestV1 {
        AdmissionRequestV1 {
            reservation_id: id.to_owned(),
            tenant_id: tenant.to_owned(),
            module_id: "module.fixture".to_owned(),
            candidate_id: format!("candidate-{id}"),
            resources: capacity(cpu),
            queued_at_unix_ms: queued,
            deadline_unix_ms: None,
        }
    }

    fn allocator() -> ResourceAllocatorV1 {
        ResourceAllocatorV1::new(
            capacity(100),
            BTreeMap::from([
                ("tenant-a".to_owned(), capacity(100)),
                ("tenant-b".to_owned(), capacity(100)),
            ]),
            BTreeMap::from([("tenant-a".to_owned(), 1), ("tenant-b".to_owned(), 1)]),
            1_000,
        )
        .expect("allocator")
    }

    #[test]
    fn allocator_never_oversubscribes_global_or_tenant_capacity() {
        let mut allocator = allocator();
        allocator
            .reserve(request("a", "tenant-a", 60, 0))
            .expect("first reservation");
        assert_eq!(
            allocator.reserve(request("b", "tenant-b", 50, 0)),
            Err(ControlPlaneError::ResourceDenied)
        );
        let report = allocator.report().expect("report");
        assert_eq!(report.reserved.cpu_millis, 60);
        assert_eq!(report.remaining.cpu_millis, 40);
    }

    #[test]
    fn reconciliation_releases_unused_capacity_and_rejects_excess_use() {
        let mut allocator = allocator();
        let reservation = allocator
            .reserve(request("a", "tenant-a", 60, 0))
            .expect("reservation");
        assert_eq!(
            allocator.reconcile(&reservation.reservation_id, capacity(61)),
            Err(ControlPlaneError::ReconciliationInvalid)
        );
        let reconciled = allocator
            .reconcile(&reservation.reservation_id, capacity(20))
            .expect("reconciliation");
        assert_eq!(reconciled.reserved.cpu_millis, 20);
        allocator
            .release(&reservation.reservation_id)
            .expect("release");
        let report = allocator.report().expect("report");
        assert!(report.reserved.is_zero());
        assert_eq!(report.reservation_count, 0);
    }

    #[test]
    fn weighted_drf_and_aging_eventually_prioritize_an_old_waiter() {
        let mut allocator = allocator();
        allocator
            .reserve(request("active-a", "tenant-a", 50, 0))
            .expect("active reservation");
        let fresh = request("fresh-a", "tenant-a", 1, 10_000);
        let old = request("old-b", "tenant-b", 1, 0);
        let ranked = allocator
            .rank_requests(&[fresh, old.clone()], 10_000)
            .expect("rank requests");
        assert_eq!(ranked.first(), Some(&old));
    }

    #[test]
    fn accounting_report_hash_is_deterministic() {
        let allocator = allocator();
        let left = allocator.report().expect("left report");
        let right = allocator.report().expect("right report");
        assert_eq!(left, right);
    }
}
