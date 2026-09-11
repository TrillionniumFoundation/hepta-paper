use std::collections::BTreeMap;

use hepta_codex_protocol::Sha256Digest;
use hepta_module_platform::ResourceVectorV1;
use serde::{Deserialize, Serialize};

use crate::{
    ControlPlaneError, HierarchicalResourcePolicyV1, ResourceEntitlementV1, canonical_hash_v1,
};

/// One bounded request to the hierarchical resource allocator.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct HierarchicalAdmissionRequestV1 {
    /// Stable reservation identity.
    pub reservation_id: String,
    /// Leaf scheduling domain receiving the reservation.
    pub domain_id: String,
    /// Requested maximum resource vector.
    pub resources: ResourceVectorV1,
    /// Monotonic queue observation time.
    pub queued_at_unix_ms: u64,
    /// Optional hard deadline.
    pub deadline_unix_ms: Option<u64>,
}

impl HierarchicalAdmissionRequestV1 {
    fn validate(&self, now_unix_ms: u64) -> Result<(), ControlPlaneError> {
        if !valid_identifier(&self.reservation_id)
            || !valid_identifier(&self.domain_id)
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

/// Exact hierarchical reservation with its ancestor accounting path.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct HierarchicalResourceReservationV1 {
    /// Stable reservation identity.
    pub reservation_id: String,
    /// Leaf scheduling domain.
    pub domain_id: String,
    /// Leaf-to-root domain path charged by this reservation.
    pub charged_domain_ids: Vec<String>,
    /// Current reserved resource vector.
    pub reserved: ResourceVectorV1,
    /// Monotonic admission sequence.
    pub admission_sequence: u64,
    /// Exact policy identity.
    pub policy_hash: Sha256Digest,
    /// Canonical reservation identity.
    pub reservation_hash: Sha256Digest,
}

/// Explicit queue disposition when the head request cannot be admitted.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum HierarchicalAdmissionOutcomeV1 {
    /// The head request was admitted exactly.
    Admitted {
        /// Exact reservation.
        reservation: HierarchicalResourceReservationV1,
    },
    /// The head request remains blocked by an ancestor or global hard limit.
    CapacityBlocked {
        /// Request that blocked progress.
        reservation_id: String,
        /// Whether the configured starvation bound has already been reached.
        starvation_bound_reached: bool,
    },
}

/// In-memory deterministic source implementation of hierarchical hard accounting.
#[derive(Clone, Debug)]
pub struct HierarchicalResourceAllocatorV1 {
    policy: HierarchicalResourcePolicyV1,
    policy_hash: Sha256Digest,
    global_reserved: ResourceVectorV1,
    reserved_by_domain: BTreeMap<String, ResourceVectorV1>,
    reservations: BTreeMap<String, HierarchicalResourceReservationV1>,
    next_sequence: u64,
    last_observed_unix_ms: Option<u64>,
}

impl HierarchicalResourceAllocatorV1 {
    /// Creates an empty allocator bound to one exact policy.
    pub fn new(policy: HierarchicalResourcePolicyV1) -> Result<Self, ControlPlaneError> {
        policy.validate()?;
        let policy_hash = policy.policy_hash()?;
        Ok(Self {
            policy,
            policy_hash,
            global_reserved: ResourceVectorV1::default(),
            reserved_by_domain: BTreeMap::new(),
            reservations: BTreeMap::new(),
            next_sequence: 1,
            last_observed_unix_ms: None,
        })
    }

    /// Ranks requests deterministically by starvation status, weighted dominant share, deadline,
    /// queue time, and stable reservation identity.
    pub fn rank_requests(
        &mut self,
        requests: &[HierarchicalAdmissionRequestV1],
        now_unix_ms: u64,
    ) -> Result<Vec<HierarchicalAdmissionRequestV1>, ControlPlaneError> {
        self.validate_observation(now_unix_ms)?;
        let mut ranked = Vec::with_capacity(requests.len());
        for request in requests {
            request.validate(now_unix_ms)?;
            let entitlement = self.entitlement(&request.domain_id)?;
            let current = self
                .reserved_by_domain
                .get(&request.domain_id)
                .copied()
                .unwrap_or_default();
            let projected = current
                .checked_add(request.resources)
                .map_err(|_| ControlPlaneError::ResourceDenied)?;
            let dominant = dominant_share_ppm(projected, entitlement.hard_limit);
            let weighted = dominant.saturating_mul(1_000_000) / u128::from(entitlement.weight);
            let age_ms = now_unix_ms.saturating_sub(request.queued_at_unix_ms);
            let starvation_rank = u8::from(age_ms < self.policy.starvation_bound_ms);
            ranked.push((
                (
                    starvation_rank,
                    weighted,
                    request.deadline_unix_ms.unwrap_or(u64::MAX),
                    request.queued_at_unix_ms,
                    request.reservation_id.clone(),
                ),
                request.clone(),
            ));
        }
        ranked.sort_by(|left, right| left.0.cmp(&right.0));
        self.last_observed_unix_ms = Some(now_unix_ms);
        Ok(ranked.into_iter().map(|(_, request)| request).collect())
    }

    /// Considers only the deterministic queue head. Once the starvation bound is reached, lower
    /// ranked work cannot bypass a blocked head silently.
    pub fn admit_next(
        &mut self,
        requests: &[HierarchicalAdmissionRequestV1],
        now_unix_ms: u64,
    ) -> Result<Option<HierarchicalAdmissionOutcomeV1>, ControlPlaneError> {
        let ranked = self.rank_requests(requests, now_unix_ms)?;
        let Some(head) = ranked.into_iter().next() else {
            return Ok(None);
        };
        let starvation_bound_reached =
            now_unix_ms.saturating_sub(head.queued_at_unix_ms) >= self.policy.starvation_bound_ms;
        match self.reserve(head.clone(), now_unix_ms) {
            Ok(reservation) => Ok(Some(HierarchicalAdmissionOutcomeV1::Admitted {
                reservation,
            })),
            Err(ControlPlaneError::ResourceDenied) => {
                Ok(Some(HierarchicalAdmissionOutcomeV1::CapacityBlocked {
                    reservation_id: head.reservation_id,
                    starvation_bound_reached,
                }))
            }
            Err(error) => Err(error),
        }
    }

    /// Reserves capacity against the global ceiling and every leaf-to-root ancestor ceiling.
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
        let charged_domain_ids = self.charged_path(&request.domain_id)?;
        let global_next = self
            .global_reserved
            .checked_add(request.resources)
            .map_err(|_| ControlPlaneError::ResourceDenied)?;
        if !global_next.fits_within(self.policy.capacity) {
            return Err(ControlPlaneError::ResourceDenied);
        }

        let mut next_by_domain = Vec::with_capacity(charged_domain_ids.len());
        for domain_id in &charged_domain_ids {
            let entitlement = self.entitlement(domain_id)?;
            let current = self
                .reserved_by_domain
                .get(domain_id)
                .copied()
                .unwrap_or_default();
            let next = current
                .checked_add(request.resources)
                .map_err(|_| ControlPlaneError::ResourceDenied)?;
            if !next.fits_within(entitlement.hard_limit) {
                return Err(ControlPlaneError::ResourceDenied);
            }
            next_by_domain.push((domain_id.clone(), next));
        }

        let body = ReservationBodyV1 {
            reservation_id: request.reservation_id.clone(),
            domain_id: request.domain_id.clone(),
            charged_domain_ids: charged_domain_ids.clone(),
            reserved: request.resources,
            admission_sequence: self.next_sequence,
            policy_hash: self.policy_hash.clone(),
        };
        let reservation_hash = canonical_hash_v1(&body)?;
        let reservation = HierarchicalResourceReservationV1 {
            reservation_id: body.reservation_id,
            domain_id: body.domain_id,
            charged_domain_ids: body.charged_domain_ids,
            reserved: body.reserved,
            admission_sequence: body.admission_sequence,
            policy_hash: body.policy_hash,
            reservation_hash,
        };
        self.next_sequence = self
            .next_sequence
            .checked_add(1)
            .ok_or(ControlPlaneError::ResourcePolicyInvalid)?;
        self.global_reserved = global_next;
        for (domain_id, next) in next_by_domain {
            self.reserved_by_domain.insert(domain_id, next);
        }
        self.reservations
            .insert(reservation.reservation_id.clone(), reservation.clone());
        self.last_observed_unix_ms = Some(now_unix_ms);
        Ok(reservation)
    }

    /// Reconciles actual usage downward across every charged ancestor.
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
        self.global_reserved = self
            .global_reserved
            .checked_sub(released)
            .map_err(|_| ControlPlaneError::ReconciliationInvalid)?;
        for domain_id in &current.charged_domain_ids {
            self.subtract_domain(domain_id, released)?;
        }
        let body = ReservationBodyV1 {
            reservation_id: current.reservation_id.clone(),
            domain_id: current.domain_id.clone(),
            charged_domain_ids: current.charged_domain_ids.clone(),
            reserved: actual,
            admission_sequence: current.admission_sequence,
            policy_hash: current.policy_hash.clone(),
        };
        let reservation_hash = canonical_hash_v1(&body)?;
        let reconciled = HierarchicalResourceReservationV1 {
            reservation_id: body.reservation_id,
            domain_id: body.domain_id,
            charged_domain_ids: body.charged_domain_ids,
            reserved: body.reserved,
            admission_sequence: body.admission_sequence,
            policy_hash: body.policy_hash,
            reservation_hash,
        };
        self.reservations
            .insert(reservation_id.to_owned(), reconciled.clone());
        Ok(reconciled)
    }

    /// Releases one reservation from global and all ancestor ledgers exactly once.
    pub fn release(
        &mut self,
        reservation_id: &str,
    ) -> Result<HierarchicalResourceReservationV1, ControlPlaneError> {
        let reservation = self
            .reservations
            .remove(reservation_id)
            .ok_or(ControlPlaneError::ReservationInvalid)?;
        self.global_reserved = self
            .global_reserved
            .checked_sub(reservation.reserved)
            .map_err(|_| ControlPlaneError::ReservationInvalid)?;
        for domain_id in &reservation.charged_domain_ids {
            self.subtract_domain(domain_id, reservation.reserved)?;
        }
        Ok(reservation)
    }

    /// Current exact global reservation total.
    #[must_use]
    pub fn global_reserved(&self) -> ResourceVectorV1 {
        self.global_reserved
    }

    /// Current exact reservation at one domain, including descendant charges.
    #[must_use]
    pub fn domain_reserved(&self, domain_id: &str) -> ResourceVectorV1 {
        self.reserved_by_domain
            .get(domain_id)
            .copied()
            .unwrap_or_default()
    }

    fn entitlement(&self, domain_id: &str) -> Result<&ResourceEntitlementV1, ControlPlaneError> {
        self.policy
            .entitlements
            .get(domain_id)
            .ok_or(ControlPlaneError::ResourcePolicyInvalid)
    }

    fn charged_path(&self, domain_id: &str) -> Result<Vec<String>, ControlPlaneError> {
        let mut path = Vec::new();
        let mut current = Some(domain_id);
        while let Some(candidate) = current {
            let entitlement = self.entitlement(candidate)?;
            path.push(candidate.to_owned());
            current = entitlement.parent_domain_id.as_deref();
        }
        Ok(path)
    }

    fn subtract_domain(
        &mut self,
        domain_id: &str,
        released: ResourceVectorV1,
    ) -> Result<(), ControlPlaneError> {
        let current = self
            .reserved_by_domain
            .get(domain_id)
            .copied()
            .ok_or(ControlPlaneError::ReconciliationInvalid)?;
        let next = current
            .checked_sub(released)
            .map_err(|_| ControlPlaneError::ReconciliationInvalid)?;
        if next.is_zero() {
            self.reserved_by_domain.remove(domain_id);
        } else {
            self.reserved_by_domain.insert(domain_id.to_owned(), next);
        }
        Ok(())
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
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ReservationBodyV1 {
    reservation_id: String,
    domain_id: String,
    charged_domain_ids: Vec<String>,
    reserved: ResourceVectorV1,
    admission_sequence: u64,
    policy_hash: Sha256Digest,
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

#[cfg(test)]
mod tests {
    use super::*;

    fn resources(cpu: u64) -> ResourceVectorV1 {
        ResourceVectorV1 {
            cpu_millis: cpu,
            ..ResourceVectorV1::default()
        }
    }

    fn policy() -> HierarchicalResourcePolicyV1 {
        let mut entitlements = BTreeMap::new();
        entitlements.insert(
            "root".to_owned(),
            ResourceEntitlementV1 {
                domain_id: "root".to_owned(),
                parent_domain_id: None,
                hard_limit: resources(100),
                weight: 1,
            },
        );
        entitlements.insert(
            "team-a".to_owned(),
            ResourceEntitlementV1 {
                domain_id: "team-a".to_owned(),
                parent_domain_id: Some("root".to_owned()),
                hard_limit: resources(80),
                weight: 1,
            },
        );
        entitlements.insert(
            "team-b".to_owned(),
            ResourceEntitlementV1 {
                domain_id: "team-b".to_owned(),
                parent_domain_id: Some("root".to_owned()),
                hard_limit: resources(80),
                weight: 1,
            },
        );
        HierarchicalResourcePolicyV1 {
            version: 1,
            capacity: resources(100),
            entitlements,
            maximum_depth: 8,
            starvation_bound_ms: 1_000,
        }
    }

    fn request(
        id: &str,
        domain: &str,
        cpu: u64,
        queued_at_unix_ms: u64,
    ) -> HierarchicalAdmissionRequestV1 {
        HierarchicalAdmissionRequestV1 {
            reservation_id: id.to_owned(),
            domain_id: domain.to_owned(),
            resources: resources(cpu),
            queued_at_unix_ms,
            deadline_unix_ms: None,
        }
    }

    #[test]
    fn sibling_reservations_cannot_overcommit_parent() {
        let mut allocator = HierarchicalResourceAllocatorV1::new(policy()).expect("allocator");
        allocator
            .reserve(request("a", "team-a", 70, 0), 10)
            .expect("team a");
        assert_eq!(
            allocator.reserve(request("b", "team-b", 40, 0), 10),
            Err(ControlPlaneError::ResourceDenied)
        );
        assert_eq!(allocator.domain_reserved("root"), resources(70));
        allocator.release("a").expect("release");
        allocator
            .reserve(request("b", "team-b", 40, 0), 11)
            .expect("team b");
        assert_eq!(allocator.domain_reserved("root"), resources(40));
    }

    #[test]
    fn starved_head_is_explicitly_blocked_instead_of_bypassed() {
        let mut allocator = HierarchicalResourceAllocatorV1::new(policy()).expect("allocator");
        allocator
            .reserve(request("active", "team-a", 80, 0), 10)
            .expect("active");
        let outcome = allocator
            .admit_next(
                &[
                    request("old", "team-b", 30, 0),
                    request("young", "team-b", 10, 1_900),
                ],
                2_000,
            )
            .expect("decision")
            .expect("outcome");
        assert_eq!(
            outcome,
            HierarchicalAdmissionOutcomeV1::CapacityBlocked {
                reservation_id: "old".to_owned(),
                starvation_bound_reached: true,
            }
        );
    }
}
