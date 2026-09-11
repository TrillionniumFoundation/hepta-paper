use std::collections::{BTreeMap, BTreeSet};

use hepta_module_platform::ResourceVectorV1;
use serde::{Deserialize, Serialize};

use crate::{ControlPlaneError, canonical_hash_v1};

const MAXIMUM_SCOPES: usize = 4_096;
const MAXIMUM_SCOPE_DEPTH: usize = 32;

/// One hard-capacity scope in the hierarchical allocator.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct HierarchicalResourceScopeV1 {
    pub scope_id: String,
    pub parent_scope_id: Option<String>,
    pub weight: u32,
    pub limit: ResourceVectorV1,
}

/// One bounded request against a leaf scheduling scope.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct HierarchicalAdmissionRequestV1 {
    pub reservation_id: String,
    pub scope_id: String,
    pub module_id: String,
    pub candidate_id: String,
    pub resources: ResourceVectorV1,
    pub queued_at_unix_ms: u64,
    pub deadline_unix_ms: Option<u64>,
}

impl HierarchicalAdmissionRequestV1 {
    fn validate(&self, now_unix_ms: u64) -> Result<(), ControlPlaneError> {
        if !valid_identifier(&self.reservation_id)
            || !valid_identifier(&self.scope_id)
            || !valid_module_id(&self.module_id)
            || !valid_identifier(&self.candidate_id)
            || self.resources.is_zero()
            || self.queued_at_unix_ms > now_unix_ms
            || self
                .deadline_unix_ms
                .is_some_and(|deadline| deadline <= now_unix_ms)
        {
            return Err(ControlPlaneError::ResourcePolicyInvalid);
        }
        Ok(())
    }
}

/// Exact reservation including the complete charged ancestor path.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct HierarchicalResourceReservationV1 {
    pub reservation_id: String,
    pub scope_id: String,
    pub module_id: String,
    pub candidate_id: String,
    pub charged_scope_ids: Vec<String>,
    pub reserved: ResourceVectorV1,
    pub admission_sequence: u64,
    pub reservation_hash: hepta_codex_protocol::Sha256Digest,
}

/// Reconciled snapshot of all hierarchy charges.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct HierarchicalResourceAccountingReportV1 {
    pub version: u16,
    pub reserved_by_scope: BTreeMap<String, ResourceVectorV1>,
    pub reservation_count: usize,
    pub last_observed_unix_ms: Option<u64>,
    pub report_hash: hepta_codex_protocol::Sha256Digest,
}

/// Hierarchical hard ceilings combined with deterministic weighted DRF and aging.
///
/// A reservation is charged atomically to the requested leaf and every ancestor.
/// Ranking uses the maximum weighted projected dominant share over that path,
/// then bounded age, deadline, queue time and reservation identity. The allocator
/// owns no execution or external authority.
#[derive(Clone, Debug)]
pub struct HierarchicalResourceAllocatorV1 {
    scopes: BTreeMap<String, HierarchicalResourceScopeV1>,
    reserved_by_scope: BTreeMap<String, ResourceVectorV1>,
    reservations: BTreeMap<String, HierarchicalResourceReservationV1>,
    next_sequence: u64,
    aging_micros_per_ms: u64,
    last_observed_unix_ms: Option<u64>,
}

impl HierarchicalResourceAllocatorV1 {
    pub fn new(
        scopes: Vec<HierarchicalResourceScopeV1>,
        aging_micros_per_ms: u64,
    ) -> Result<Self, ControlPlaneError> {
        if scopes.is_empty() || scopes.len() > MAXIMUM_SCOPES || aging_micros_per_ms == 0 {
            return Err(ControlPlaneError::ResourcePolicyInvalid);
        }
        let mut by_id = BTreeMap::new();
        for scope in scopes {
            if !valid_identifier(&scope.scope_id)
                || scope.weight == 0
                || scope.limit.is_zero()
                || scope
                    .parent_scope_id
                    .as_ref()
                    .is_some_and(|parent| !valid_identifier(parent) || parent == &scope.scope_id)
                || by_id.insert(scope.scope_id.clone(), scope).is_some()
            {
                return Err(ControlPlaneError::ResourcePolicyInvalid);
            }
        }
        if by_id
            .values()
            .filter(|scope| scope.parent_scope_id.is_none())
            .count()
            != 1
        {
            return Err(ControlPlaneError::ResourcePolicyInvalid);
        }
        for scope in by_id.values() {
            if let Some(parent_id) = &scope.parent_scope_id {
                let parent = by_id
                    .get(parent_id)
                    .ok_or(ControlPlaneError::ResourcePolicyInvalid)?;
                if !scope.limit.fits_within(parent.limit) {
                    return Err(ControlPlaneError::ResourcePolicyInvalid);
                }
            }
            validate_path(&by_id, &scope.scope_id)?;
        }
        Ok(Self {
            scopes: by_id,
            reserved_by_scope: BTreeMap::new(),
            reservations: BTreeMap::new(),
            next_sequence: 1,
            aging_micros_per_ms,
            last_observed_unix_ms: None,
        })
    }

    /// Returns queued work in deterministic hierarchical DRF/aging order.
    pub fn rank_requests(
        &mut self,
        requests: &[HierarchicalAdmissionRequestV1],
        now_unix_ms: u64,
    ) -> Result<Vec<HierarchicalAdmissionRequestV1>, ControlPlaneError> {
        self.validate_observation(now_unix_ms)?;
        let mut keyed = Vec::with_capacity(requests.len());
        for request in requests {
            request.validate(now_unix_ms)?;
            let path = scope_path(&self.scopes, &request.scope_id)?;
            keyed.push((
                self.rank_key(request, &path, now_unix_ms)?,
                request.clone(),
            ));
        }
        keyed.sort_by(|left, right| {
            left.0
                .cmp(&right.0)
                .then_with(|| left.1.reservation_id.cmp(&right.1.reservation_id))
        });
        self.last_observed_unix_ms = Some(now_unix_ms);
        Ok(keyed.into_iter().map(|(_, request)| request).collect())
    }

    /// Atomically reserves a vector at the leaf and every ancestor hard ceiling.
    pub fn reserve(
        &mut self,
        request: HierarchicalAdmissionRequestV1,
        now_unix_ms: u64,
    ) -> Result<HierarchicalResourceReservationV1, ControlPlaneError> {
        self.validate_observation(now_unix_ms)?;
        request.validate(now_unix_ms)?;
        if self.reservations.contains_key(&request.reservation_id) {
            return Err(ControlPlaneError::ReservationInvalid);
        }
        let path = scope_path(&self.scopes, &request.scope_id)?;
        let updates = self.project_path(&path, request.resources)?;
        let body = HierarchicalReservationBodyV1 {
            reservation_id: request.reservation_id.clone(),
            scope_id: request.scope_id.clone(),
            module_id: request.module_id.clone(),
            candidate_id: request.candidate_id.clone(),
            charged_scope_ids: path.clone(),
            reserved: request.resources,
            admission_sequence: self.next_sequence,
        };
        let reservation_hash = canonical_hash_v1(&body)?;
        let reservation = HierarchicalResourceReservationV1 {
            reservation_id: body.reservation_id,
            scope_id: body.scope_id,
            module_id: body.module_id,
            candidate_id: body.candidate_id,
            charged_scope_ids: body.charged_scope_ids,
            reserved: body.reserved,
            admission_sequence: body.admission_sequence,
            reservation_hash,
        };
        self.next_sequence = self
            .next_sequence
            .checked_add(1)
            .ok_or(ControlPlaneError::ResourcePolicyInvalid)?;
        for (scope_id, projected) in updates {
            if projected.is_zero() {
                self.reserved_by_scope.remove(&scope_id);
            } else {
                self.reserved_by_scope.insert(scope_id, projected);
            }
        }
        self.reservations
            .insert(reservation.reservation_id.clone(), reservation.clone());
        self.last_observed_unix_ms = Some(now_unix_ms);
        Ok(reservation)
    }

    /// Reconciles actual use without permitting any scope to exceed the original
    /// reservation or corrupting ancestor accounting on failure.
    pub fn reconcile(
        &mut self,
        reservation_id: &str,
        actual: ResourceVectorV1,
    ) -> Result<HierarchicalResourceReservationV1, ControlPlaneError> {
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
        let updates = self.release_projection(&current.charged_scope_ids, released)?;
        let body = HierarchicalReservationBodyV1 {
            reservation_id: current.reservation_id.clone(),
            scope_id: current.scope_id.clone(),
            module_id: current.module_id.clone(),
            candidate_id: current.candidate_id.clone(),
            charged_scope_ids: current.charged_scope_ids.clone(),
            reserved: actual,
            admission_sequence: current.admission_sequence,
        };
        let reconciled = HierarchicalResourceReservationV1 {
            reservation_hash: canonical_hash_v1(&body)?,
            reservation_id: body.reservation_id,
            scope_id: body.scope_id,
            module_id: body.module_id,
            candidate_id: body.candidate_id,
            charged_scope_ids: body.charged_scope_ids,
            reserved: body.reserved,
            admission_sequence: body.admission_sequence,
        };
        apply_projection(&mut self.reserved_by_scope, updates);
        self.reservations
            .insert(reservation_id.to_owned(), reconciled.clone());
        Ok(reconciled)
    }

    /// Releases one reservation from the entire hierarchy exactly once.
    pub fn release(
        &mut self,
        reservation_id: &str,
    ) -> Result<HierarchicalResourceReservationV1, ControlPlaneError> {
        let reservation = self
            .reservations
            .get(reservation_id)
            .cloned()
            .ok_or(ControlPlaneError::ReservationInvalid)?;
        let updates = self.release_projection(&reservation.charged_scope_ids, reservation.reserved)?;
        apply_projection(&mut self.reserved_by_scope, updates);
        let _removed = self.reservations.remove(reservation_id);
        Ok(reservation)
    }

    pub fn report(&self) -> Result<HierarchicalResourceAccountingReportV1, ControlPlaneError> {
        let body = HierarchicalAccountingBodyV1 {
            version: 1,
            reserved_by_scope: &self.reserved_by_scope,
            reservation_count: self.reservations.len(),
            last_observed_unix_ms: self.last_observed_unix_ms,
        };
        Ok(HierarchicalResourceAccountingReportV1 {
            version: body.version,
            reserved_by_scope: self.reserved_by_scope.clone(),
            reservation_count: body.reservation_count,
            last_observed_unix_ms: body.last_observed_unix_ms,
            report_hash: canonical_hash_v1(&body)?,
        })
    }

    fn validate_observation(&self, now_unix_ms: u64) -> Result<(), ControlPlaneError> {
        if self
            .last_observed_unix_ms
            .is_some_and(|previous| now_unix_ms < previous)
        {
            return Err(ControlPlaneError::ResourceClockRollback);
        }
        Ok(())
    }

    fn rank_key(
        &self,
        request: &HierarchicalAdmissionRequestV1,
        path: &[String],
        now_unix_ms: u64,
    ) -> Result<(u128, u64, u64), ControlPlaneError> {
        let mut hierarchical_share = 0_u128;
        for scope_id in path {
            let scope = self
                .scopes
                .get(scope_id)
                .ok_or(ControlPlaneError::ResourcePolicyInvalid)?;
            let current = self
                .reserved_by_scope
                .get(scope_id)
                .copied()
                .unwrap_or_default();
            let projected = current
                .checked_add(request.resources)
                .map_err(|_| ControlPlaneError::ResourceDenied)?;
            if !projected.fits_within(scope.limit) {
                return Err(ControlPlaneError::ResourceDenied);
            }
            let weighted = dominant_share_ppm(projected, scope.limit)
                .saturating_mul(1_000_000)
                / u128::from(scope.weight);
            hierarchical_share = hierarchical_share.max(weighted);
        }
        let waited = now_unix_ms.saturating_sub(request.queued_at_unix_ms);
        let aging = u128::from(waited).saturating_mul(u128::from(self.aging_micros_per_ms));
        Ok((
            hierarchical_share.saturating_sub(aging),
            request.deadline_unix_ms.unwrap_or(u64::MAX),
            request.queued_at_unix_ms,
        ))
    }

    fn project_path(
        &self,
        path: &[String],
        resources: ResourceVectorV1,
    ) -> Result<BTreeMap<String, ResourceVectorV1>, ControlPlaneError> {
        let mut updates = BTreeMap::new();
        for scope_id in path {
            let scope = self
                .scopes
                .get(scope_id)
                .ok_or(ControlPlaneError::ResourcePolicyInvalid)?;
            let current = self
                .reserved_by_scope
                .get(scope_id)
                .copied()
                .unwrap_or_default();
            let projected = current
                .checked_add(resources)
                .map_err(|_| ControlPlaneError::ResourceDenied)?;
            if !projected.fits_within(scope.limit) {
                return Err(ControlPlaneError::ResourceDenied);
            }
            updates.insert(scope_id.clone(), projected);
        }
        Ok(updates)
    }

    fn release_projection(
        &self,
        path: &[String],
        resources: ResourceVectorV1,
    ) -> Result<BTreeMap<String, ResourceVectorV1>, ControlPlaneError> {
        let mut updates = BTreeMap::new();
        for scope_id in path {
            let current = self
                .reserved_by_scope
                .get(scope_id)
                .copied()
                .ok_or(ControlPlaneError::ReconciliationInvalid)?;
            let next = current
                .checked_sub(resources)
                .map_err(|_| ControlPlaneError::ReconciliationInvalid)?;
            updates.insert(scope_id.clone(), next);
        }
        Ok(updates)
    }
}

fn validate_path(
    scopes: &BTreeMap<String, HierarchicalResourceScopeV1>,
    leaf: &str,
) -> Result<(), ControlPlaneError> {
    let _ = scope_path(scopes, leaf)?;
    Ok(())
}

fn scope_path(
    scopes: &BTreeMap<String, HierarchicalResourceScopeV1>,
    leaf: &str,
) -> Result<Vec<String>, ControlPlaneError> {
    let mut path = Vec::new();
    let mut seen = BTreeSet::new();
    let mut current = leaf.to_owned();
    loop {
        if path.len() >= MAXIMUM_SCOPE_DEPTH || !seen.insert(current.clone()) {
            return Err(ControlPlaneError::ResourcePolicyInvalid);
        }
        let scope = scopes
            .get(&current)
            .ok_or(ControlPlaneError::ResourcePolicyInvalid)?;
        path.push(current.clone());
        match &scope.parent_scope_id {
            Some(parent) => current = parent.clone(),
            None => break,
        }
    }
    Ok(path)
}

fn apply_projection(
    reserved_by_scope: &mut BTreeMap<String, ResourceVectorV1>,
    updates: BTreeMap<String, ResourceVectorV1>,
) {
    for (scope_id, value) in updates {
        if value.is_zero() {
            reserved_by_scope.remove(&scope_id);
        } else {
            reserved_by_scope.insert(scope_id, value);
        }
    }
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

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct HierarchicalReservationBodyV1 {
    reservation_id: String,
    scope_id: String,
    module_id: String,
    candidate_id: String,
    charged_scope_ids: Vec<String>,
    reserved: ResourceVectorV1,
    admission_sequence: u64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct HierarchicalAccountingBodyV1<'a> {
    version: u16,
    reserved_by_scope: &'a BTreeMap<String, ResourceVectorV1>,
    reservation_count: usize,
    last_observed_unix_ms: Option<u64>,
}

#[cfg(test)]
mod tests {
    use super::*;

    fn resource(cpu: u64) -> ResourceVectorV1 {
        ResourceVectorV1 {
            cpu_millis: cpu,
            memory_bytes: cpu.saturating_mul(100),
            ..ResourceVectorV1::default()
        }
    }

    fn scopes() -> Vec<HierarchicalResourceScopeV1> {
        vec![
            HierarchicalResourceScopeV1 {
                scope_id: "host".to_owned(),
                parent_scope_id: None,
                weight: 1,
                limit: resource(100),
            },
            HierarchicalResourceScopeV1 {
                scope_id: "team:a".to_owned(),
                parent_scope_id: Some("host".to_owned()),
                weight: 1,
                limit: resource(80),
            },
            HierarchicalResourceScopeV1 {
                scope_id: "team:b".to_owned(),
                parent_scope_id: Some("host".to_owned()),
                weight: 2,
                limit: resource(80),
            },
            HierarchicalResourceScopeV1 {
                scope_id: "campaign:a".to_owned(),
                parent_scope_id: Some("team:a".to_owned()),
                weight: 1,
                limit: resource(70),
            },
            HierarchicalResourceScopeV1 {
                scope_id: "campaign:b".to_owned(),
                parent_scope_id: Some("team:b".to_owned()),
                weight: 1,
                limit: resource(70),
            },
        ]
    }

    fn request(id: &str, scope_id: &str, cpu: u64, queued: u64) -> HierarchicalAdmissionRequestV1 {
        HierarchicalAdmissionRequestV1 {
            reservation_id: id.to_owned(),
            scope_id: scope_id.to_owned(),
            module_id: "module.fixture".to_owned(),
            candidate_id: format!("candidate:{id}"),
            resources: resource(cpu),
            queued_at_unix_ms: queued,
            deadline_unix_ms: None,
        }
    }

    #[test]
    fn parent_ceiling_is_atomic_across_sibling_scopes() {
        let mut allocator = HierarchicalResourceAllocatorV1::new(scopes(), 1_000).expect("allocator");
        allocator
            .reserve(request("a", "campaign:a", 60, 0), 0)
            .expect("first reservation");
        assert_eq!(
            allocator.reserve(request("b", "campaign:b", 50, 0), 0),
            Err(ControlPlaneError::ResourceDenied)
        );
        let report = allocator.report().expect("report");
        assert_eq!(report.reserved_by_scope["host"].cpu_millis, 60);
        assert_eq!(report.reserved_by_scope["team:a"].cpu_millis, 60);
        assert!(!report.reserved_by_scope.contains_key("team:b"));
    }

    #[test]
    fn reconciliation_and_release_update_every_ancestor() {
        let mut allocator = HierarchicalResourceAllocatorV1::new(scopes(), 1_000).expect("allocator");
        let reservation = allocator
            .reserve(request("a", "campaign:a", 60, 0), 0)
            .expect("reservation");
        let reconciled = allocator
            .reconcile(&reservation.reservation_id, resource(20))
            .expect("reconcile");
        assert_eq!(reconciled.reserved.cpu_millis, 20);
        let report = allocator.report().expect("reconciled report");
        for scope_id in ["host", "team:a", "campaign:a"] {
            assert_eq!(report.reserved_by_scope[scope_id].cpu_millis, 20);
        }
        allocator.release(&reservation.reservation_id).expect("release");
        assert!(allocator.report().expect("released report").reserved_by_scope.is_empty());
    }

    #[test]
    fn hierarchy_weight_and_aging_produce_deterministic_fair_order() {
        let mut allocator = HierarchicalResourceAllocatorV1::new(scopes(), 1_000).expect("allocator");
        allocator
            .reserve(request("active", "campaign:a", 40, 0), 0)
            .expect("active reservation");
        let fresh = request("fresh", "campaign:a", 1, 10_000);
        let old = request("old", "campaign:b", 1, 0);
        let ranked = allocator.rank_requests(&[fresh, old.clone()], 10_000).expect("ranked");
        assert_eq!(ranked.first(), Some(&old));
        assert_eq!(
            allocator.rank_requests(&[old], 9_999),
            Err(ControlPlaneError::ResourceClockRollback)
        );
    }

    #[test]
    fn invalid_hierarchy_and_over_reconciliation_fail_closed() {
        let mut invalid = scopes();
        invalid[1].parent_scope_id = Some("missing".to_owned());
        assert!(HierarchicalResourceAllocatorV1::new(invalid, 1_000).is_err());

        let mut allocator = HierarchicalResourceAllocatorV1::new(scopes(), 1_000).expect("allocator");
        let reservation = allocator
            .reserve(request("a", "campaign:a", 10, 0), 0)
            .expect("reservation");
        let before = allocator.report().expect("before");
        assert_eq!(
            allocator.reconcile(&reservation.reservation_id, resource(11)),
            Err(ControlPlaneError::ReconciliationInvalid)
        );
        assert_eq!(allocator.report().expect("after"), before);
    }
}
