use std::collections::{BTreeMap, BTreeSet};

use hepta_codex_protocol::Sha256Digest;
use hepta_module_platform::ResourceVectorV1;
use serde::{Deserialize, Serialize};

use crate::{ControlPlaneError, canonical_hash_v1};

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ResourceLeaseStateV1 {
    Active,
    Released,
    Expired,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ResourceLeasePolicyV1 {
    pub version: u16,
    pub lease_duration_ms: u64,
    pub maximum_renewals: u32,
}

impl ResourceLeasePolicyV1 {
    fn validate(&self) -> Result<(), ControlPlaneError> {
        if self.version != 1
            || self.lease_duration_ms == 0
            || self.lease_duration_ms > 86_400_000
            || self.maximum_renewals == 0
            || self.maximum_renewals > 1_000_000
        {
            return Err(ControlPlaneError::ResourcePolicyInvalid);
        }
        Ok(())
    }
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ResourceLeaseV1 {
    pub version: u16,
    pub reservation_id: String,
    pub reservation_hash: Sha256Digest,
    pub owner_principal: String,
    pub fence_generation: u64,
    pub reserved: ResourceVectorV1,
    pub issued_at_unix_ms: u64,
    pub expires_at_unix_ms: u64,
    pub renewal_count: u32,
    pub state: ResourceLeaseStateV1,
    pub lease_hash: Sha256Digest,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ResourceLeaseSnapshotV1 {
    pub version: u16,
    pub policy: ResourceLeasePolicyV1,
    pub leases: Vec<ResourceLeaseV1>,
    pub snapshot_hash: Sha256Digest,
}

/// Generation-fenced lease state machine. The state can be snapshotted and
/// restored by a durable owner; this type itself owns no database authority.
#[derive(Clone, Debug)]
pub struct ResourceLeaseRegistryV1 {
    policy: ResourceLeasePolicyV1,
    leases: BTreeMap<String, ResourceLeaseV1>,
    latest_generation: BTreeMap<String, u64>,
}

impl ResourceLeaseRegistryV1 {
    pub fn new(policy: ResourceLeasePolicyV1) -> Result<Self, ControlPlaneError> {
        policy.validate()?;
        Ok(Self {
            policy,
            leases: BTreeMap::new(),
            latest_generation: BTreeMap::new(),
        })
    }

    pub fn issue(
        &mut self,
        reservation_id: String,
        reservation_hash: Sha256Digest,
        owner_principal: String,
        reserved: ResourceVectorV1,
        now_unix_ms: u64,
    ) -> Result<ResourceLeaseV1, ControlPlaneError> {
        if !valid_identifier(&reservation_id)
            || !valid_identifier(&owner_principal)
            || reserved.is_zero()
            || now_unix_ms == 0
            || self
                .leases
                .get(&reservation_id)
                .is_some_and(|lease| lease.state == ResourceLeaseStateV1::Active)
        {
            return Err(ControlPlaneError::ReservationInvalid);
        }
        let generation = self
            .latest_generation
            .get(&reservation_id)
            .copied()
            .unwrap_or(0)
            .checked_add(1)
            .ok_or(ControlPlaneError::ResourcePolicyInvalid)?;
        let expires_at_unix_ms = now_unix_ms
            .checked_add(self.policy.lease_duration_ms)
            .ok_or(ControlPlaneError::ResourcePolicyInvalid)?;
        let lease = build_lease(ResourceLeaseBodyV1 {
            version: 1,
            reservation_id,
            reservation_hash,
            owner_principal,
            fence_generation: generation,
            reserved,
            issued_at_unix_ms: now_unix_ms,
            expires_at_unix_ms,
            renewal_count: 0,
            state: ResourceLeaseStateV1::Active,
        })?;
        self.latest_generation
            .insert(lease.reservation_id.clone(), generation);
        self.leases
            .insert(lease.reservation_id.clone(), lease.clone());
        Ok(lease)
    }

    pub fn renew(
        &mut self,
        reservation_id: &str,
        owner_principal: &str,
        expected_generation: u64,
        now_unix_ms: u64,
    ) -> Result<ResourceLeaseV1, ControlPlaneError> {
        let current = self
            .leases
            .get(reservation_id)
            .cloned()
            .ok_or(ControlPlaneError::ReservationInvalid)?;
        if current.state != ResourceLeaseStateV1::Active
            || current.owner_principal != owner_principal
            || current.fence_generation != expected_generation
            || now_unix_ms == 0
            || now_unix_ms >= current.expires_at_unix_ms
            || current.renewal_count >= self.policy.maximum_renewals
        {
            return Err(ControlPlaneError::ReservationInvalid);
        }
        let generation = current
            .fence_generation
            .checked_add(1)
            .ok_or(ControlPlaneError::ResourcePolicyInvalid)?;
        let renewal_count = current
            .renewal_count
            .checked_add(1)
            .ok_or(ControlPlaneError::ResourcePolicyInvalid)?;
        let expires_at_unix_ms = now_unix_ms
            .checked_add(self.policy.lease_duration_ms)
            .ok_or(ControlPlaneError::ResourcePolicyInvalid)?;
        let renewed = build_lease(ResourceLeaseBodyV1 {
            version: 1,
            reservation_id: current.reservation_id,
            reservation_hash: current.reservation_hash,
            owner_principal: current.owner_principal,
            fence_generation: generation,
            reserved: current.reserved,
            issued_at_unix_ms: now_unix_ms,
            expires_at_unix_ms,
            renewal_count,
            state: ResourceLeaseStateV1::Active,
        })?;
        self.latest_generation
            .insert(reservation_id.to_owned(), generation);
        self.leases
            .insert(reservation_id.to_owned(), renewed.clone());
        Ok(renewed)
    }

    pub fn release(
        &mut self,
        reservation_id: &str,
        owner_principal: &str,
        expected_generation: u64,
    ) -> Result<ResourceLeaseV1, ControlPlaneError> {
        let current = self
            .leases
            .get(reservation_id)
            .cloned()
            .ok_or(ControlPlaneError::ReservationInvalid)?;
        if current.state != ResourceLeaseStateV1::Active
            || current.owner_principal != owner_principal
            || current.fence_generation != expected_generation
        {
            return Err(ControlPlaneError::ReservationInvalid);
        }
        let released = build_lease(ResourceLeaseBodyV1 {
            version: current.version,
            reservation_id: current.reservation_id,
            reservation_hash: current.reservation_hash,
            owner_principal: current.owner_principal,
            fence_generation: current.fence_generation,
            reserved: current.reserved,
            issued_at_unix_ms: current.issued_at_unix_ms,
            expires_at_unix_ms: current.expires_at_unix_ms,
            renewal_count: current.renewal_count,
            state: ResourceLeaseStateV1::Released,
        })?;
        self.leases
            .insert(reservation_id.to_owned(), released.clone());
        Ok(released)
    }

    pub fn expire(&mut self, now_unix_ms: u64) -> Result<Vec<String>, ControlPlaneError> {
        if now_unix_ms == 0 {
            return Err(ControlPlaneError::ResourcePolicyInvalid);
        }
        let expired_ids = self
            .leases
            .values()
            .filter(|lease| {
                lease.state == ResourceLeaseStateV1::Active
                    && lease.expires_at_unix_ms <= now_unix_ms
            })
            .map(|lease| lease.reservation_id.clone())
            .collect::<Vec<_>>();
        for reservation_id in &expired_ids {
            let current = self
                .leases
                .get(reservation_id)
                .cloned()
                .ok_or(ControlPlaneError::ReservationInvalid)?;
            let expired = build_lease(ResourceLeaseBodyV1 {
                version: current.version,
                reservation_id: current.reservation_id,
                reservation_hash: current.reservation_hash,
                owner_principal: current.owner_principal,
                fence_generation: current.fence_generation,
                reserved: current.reserved,
                issued_at_unix_ms: current.issued_at_unix_ms,
                expires_at_unix_ms: current.expires_at_unix_ms,
                renewal_count: current.renewal_count,
                state: ResourceLeaseStateV1::Expired,
            })?;
            self.leases.insert(reservation_id.clone(), expired);
        }
        Ok(expired_ids)
    }

    pub fn snapshot(&self) -> Result<ResourceLeaseSnapshotV1, ControlPlaneError> {
        let leases = self.leases.values().cloned().collect::<Vec<_>>();
        let body = ResourceLeaseSnapshotBodyV1 {
            version: 1,
            policy: &self.policy,
            leases: &leases,
        };
        let snapshot_hash = canonical_hash_v1(&body)?;
        Ok(ResourceLeaseSnapshotV1 {
            version: 1,
            policy: self.policy.clone(),
            leases,
            snapshot_hash,
        })
    }

    pub fn restore(snapshot: ResourceLeaseSnapshotV1) -> Result<Self, ControlPlaneError> {
        snapshot.policy.validate()?;
        if snapshot.version != 1 {
            return Err(ControlPlaneError::ResourcePolicyInvalid);
        }
        let body = ResourceLeaseSnapshotBodyV1 {
            version: snapshot.version,
            policy: &snapshot.policy,
            leases: &snapshot.leases,
        };
        if canonical_hash_v1(&body)? != snapshot.snapshot_hash {
            return Err(ControlPlaneError::ReservationInvalid);
        }
        let mut leases = BTreeMap::new();
        let mut latest_generation = BTreeMap::new();
        for lease in snapshot.leases {
            validate_lease(&lease)?;
            if leases
                .insert(lease.reservation_id.clone(), lease.clone())
                .is_some()
            {
                return Err(ControlPlaneError::ReservationInvalid);
            }
            latest_generation.insert(lease.reservation_id.clone(), lease.fence_generation);
        }
        Ok(Self {
            policy: snapshot.policy,
            leases,
            latest_generation,
        })
    }
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PreemptionCandidateV1 {
    pub reservation_id: String,
    pub priority_class: u32,
    pub resources: ResourceVectorV1,
    pub safe_preemption_boundary: bool,
    pub point_of_no_return_crossed: bool,
    pub recovery_evidence_hash: Sha256Digest,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PreemptionPlanV1 {
    pub version: u16,
    pub required: ResourceVectorV1,
    pub selected_reservation_ids: Vec<String>,
    pub reclaimable: ResourceVectorV1,
    pub grants_authority: bool,
    pub plan_hash: Sha256Digest,
}

/// Selects only explicitly safe, reversible victims. Reservations carrying an
/// irreversible external action or central-writer turn can never be selected.
pub fn plan_safe_preemption_v1(
    required: ResourceVectorV1,
    mut candidates: Vec<PreemptionCandidateV1>,
) -> Result<PreemptionPlanV1, ControlPlaneError> {
    if required.is_zero() || candidates.is_empty() || candidates.len() > 4_096 {
        return Err(ControlPlaneError::ResourcePolicyInvalid);
    }
    for candidate in &candidates {
        if !valid_identifier(&candidate.reservation_id)
            || candidate.resources.is_zero()
            || candidate.resources.external_actions != 0
            || candidate.resources.central_writer_turns != 0
        {
            return Err(ControlPlaneError::ResourcePolicyInvalid);
        }
    }
    candidates.sort_by(|left, right| {
        left.priority_class
            .cmp(&right.priority_class)
            .then_with(|| left.reservation_id.cmp(&right.reservation_id))
    });
    let mut seen = BTreeSet::new();
    let mut selected_reservation_ids = Vec::new();
    let mut reclaimable = ResourceVectorV1::default();
    for candidate in candidates {
        if !seen.insert(candidate.reservation_id.clone()) {
            return Err(ControlPlaneError::ResourcePolicyInvalid);
        }
        if !candidate.safe_preemption_boundary || candidate.point_of_no_return_crossed {
            continue;
        }
        reclaimable = reclaimable
            .checked_add(candidate.resources)
            .map_err(|_| ControlPlaneError::ResourceDenied)?;
        selected_reservation_ids.push(candidate.reservation_id);
        if required.fits_within(reclaimable) {
            break;
        }
    }
    if !required.fits_within(reclaimable) {
        return Err(ControlPlaneError::ResourceDenied);
    }
    let body = PreemptionPlanBodyV1 {
        version: 1,
        required,
        selected_reservation_ids: &selected_reservation_ids,
        reclaimable,
        grants_authority: false,
    };
    let plan_hash = canonical_hash_v1(&body)?;
    Ok(PreemptionPlanV1 {
        version: 1,
        required,
        selected_reservation_ids,
        reclaimable,
        grants_authority: false,
        plan_hash,
    })
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PriorityDependencyV1 {
    pub waiter_id: String,
    pub holder_id: String,
}

/// Propagates the highest blocked priority through an acyclic dependency graph.
/// Higher integer values mean higher priority. Cycles fail closed rather than
/// manufacturing priority or relying on timeout-based recovery.
pub fn inherit_priorities_v1(
    base_priorities: BTreeMap<String, u32>,
    dependencies: Vec<PriorityDependencyV1>,
) -> Result<BTreeMap<String, u32>, ControlPlaneError> {
    if base_priorities.is_empty() || base_priorities.len() > 4_096 || dependencies.len() > 16_384 {
        return Err(ControlPlaneError::ResourcePolicyInvalid);
    }
    if base_priorities.keys().any(|id| !valid_identifier(id)) {
        return Err(ControlPlaneError::ResourcePolicyInvalid);
    }
    let mut edges = BTreeMap::<String, Vec<String>>::new();
    for dependency in dependencies {
        if dependency.waiter_id == dependency.holder_id
            || !base_priorities.contains_key(&dependency.waiter_id)
            || !base_priorities.contains_key(&dependency.holder_id)
        {
            return Err(ControlPlaneError::ResourcePolicyInvalid);
        }
        edges
            .entry(dependency.waiter_id)
            .or_default()
            .push(dependency.holder_id);
    }
    for holders in edges.values_mut() {
        holders.sort();
        holders.dedup();
    }
    ensure_acyclic(&base_priorities, &edges)?;

    let mut effective = base_priorities.clone();
    for _ in 0..base_priorities.len() {
        let before = effective.clone();
        for (waiter, holders) in &edges {
            let waiter_priority = *effective
                .get(waiter)
                .ok_or(ControlPlaneError::ResourcePolicyInvalid)?;
            for holder in holders {
                let value = effective
                    .get_mut(holder)
                    .ok_or(ControlPlaneError::ResourcePolicyInvalid)?;
                *value = (*value).max(waiter_priority);
            }
        }
        if effective == before {
            return Ok(effective);
        }
    }
    Err(ControlPlaneError::ResourcePolicyInvalid)
}

fn ensure_acyclic(
    nodes: &BTreeMap<String, u32>,
    edges: &BTreeMap<String, Vec<String>>,
) -> Result<(), ControlPlaneError> {
    fn visit(
        node: &str,
        edges: &BTreeMap<String, Vec<String>>,
        temporary: &mut BTreeSet<String>,
        permanent: &mut BTreeSet<String>,
    ) -> Result<(), ControlPlaneError> {
        if permanent.contains(node) {
            return Ok(());
        }
        if !temporary.insert(node.to_owned()) {
            return Err(ControlPlaneError::ResourcePolicyInvalid);
        }
        if let Some(next) = edges.get(node) {
            for child in next {
                visit(child, edges, temporary, permanent)?;
            }
        }
        temporary.remove(node);
        permanent.insert(node.to_owned());
        Ok(())
    }

    let mut temporary = BTreeSet::new();
    let mut permanent = BTreeSet::new();
    for node in nodes.keys() {
        visit(node, edges, &mut temporary, &mut permanent)?;
    }
    Ok(())
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ResourceLeaseBodyV1 {
    version: u16,
    reservation_id: String,
    reservation_hash: Sha256Digest,
    owner_principal: String,
    fence_generation: u64,
    reserved: ResourceVectorV1,
    issued_at_unix_ms: u64,
    expires_at_unix_ms: u64,
    renewal_count: u32,
    state: ResourceLeaseStateV1,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ResourceLeaseHashBodyV1<'a> {
    version: u16,
    reservation_id: &'a str,
    reservation_hash: &'a Sha256Digest,
    owner_principal: &'a str,
    fence_generation: u64,
    reserved: ResourceVectorV1,
    issued_at_unix_ms: u64,
    expires_at_unix_ms: u64,
    renewal_count: u32,
    state: ResourceLeaseStateV1,
}

fn build_lease(body: ResourceLeaseBodyV1) -> Result<ResourceLeaseV1, ControlPlaneError> {
    let hash_body = ResourceLeaseHashBodyV1 {
        version: body.version,
        reservation_id: &body.reservation_id,
        reservation_hash: &body.reservation_hash,
        owner_principal: &body.owner_principal,
        fence_generation: body.fence_generation,
        reserved: body.reserved,
        issued_at_unix_ms: body.issued_at_unix_ms,
        expires_at_unix_ms: body.expires_at_unix_ms,
        renewal_count: body.renewal_count,
        state: body.state,
    };
    let lease_hash = canonical_hash_v1(&hash_body)?;
    Ok(ResourceLeaseV1 {
        version: body.version,
        reservation_id: body.reservation_id,
        reservation_hash: body.reservation_hash,
        owner_principal: body.owner_principal,
        fence_generation: body.fence_generation,
        reserved: body.reserved,
        issued_at_unix_ms: body.issued_at_unix_ms,
        expires_at_unix_ms: body.expires_at_unix_ms,
        renewal_count: body.renewal_count,
        state: body.state,
        lease_hash,
    })
}

fn validate_lease(lease: &ResourceLeaseV1) -> Result<(), ControlPlaneError> {
    if lease.version != 1
        || !valid_identifier(&lease.reservation_id)
        || !valid_identifier(&lease.owner_principal)
        || lease.fence_generation == 0
        || lease.reserved.is_zero()
        || lease.issued_at_unix_ms == 0
        || lease.expires_at_unix_ms <= lease.issued_at_unix_ms
    {
        return Err(ControlPlaneError::ReservationInvalid);
    }
    let body = ResourceLeaseHashBodyV1 {
        version: lease.version,
        reservation_id: &lease.reservation_id,
        reservation_hash: &lease.reservation_hash,
        owner_principal: &lease.owner_principal,
        fence_generation: lease.fence_generation,
        reserved: lease.reserved,
        issued_at_unix_ms: lease.issued_at_unix_ms,
        expires_at_unix_ms: lease.expires_at_unix_ms,
        renewal_count: lease.renewal_count,
        state: lease.state,
    };
    if canonical_hash_v1(&body)? != lease.lease_hash {
        return Err(ControlPlaneError::ReservationInvalid);
    }
    Ok(())
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ResourceLeaseSnapshotBodyV1<'a> {
    version: u16,
    policy: &'a ResourceLeasePolicyV1,
    leases: &'a [ResourceLeaseV1],
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct PreemptionPlanBodyV1<'a> {
    version: u16,
    required: ResourceVectorV1,
    selected_reservation_ids: &'a [String],
    reclaimable: ResourceVectorV1,
    grants_authority: bool,
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
    use std::str::FromStr;

    use super::*;

    fn digest(marker: char) -> Sha256Digest {
        Sha256Digest::from_str(&format!("sha256:{}", marker.to_string().repeat(64)))
            .expect("test digest")
    }

    fn resources(cpu: u64) -> ResourceVectorV1 {
        ResourceVectorV1 {
            cpu_millis: cpu,
            memory_bytes: cpu * 1024,
            ..ResourceVectorV1::default()
        }
    }

    #[test]
    fn renewal_advances_fence_and_stale_owner_cannot_release() {
        let mut registry = ResourceLeaseRegistryV1::new(ResourceLeasePolicyV1 {
            version: 1,
            lease_duration_ms: 100,
            maximum_renewals: 4,
        })
        .expect("registry");
        let first = registry
            .issue(
                "reservation:a".to_owned(),
                digest('a'),
                "principal:a".to_owned(),
                resources(10),
                100,
            )
            .expect("issue");
        let renewed = registry
            .renew("reservation:a", "principal:a", first.fence_generation, 150)
            .expect("renew");
        assert!(renewed.fence_generation > first.fence_generation);
        assert_eq!(
            registry.release("reservation:a", "principal:a", first.fence_generation),
            Err(ControlPlaneError::ReservationInvalid)
        );
        assert!(
            registry
                .release(
                    "reservation:a",
                    "principal:a",
                    renewed.fence_generation,
                )
                .is_ok()
        );
    }

    #[test]
    fn lease_snapshot_round_trips_and_tamper_fails_closed() {
        let mut registry = ResourceLeaseRegistryV1::new(ResourceLeasePolicyV1 {
            version: 1,
            lease_duration_ms: 100,
            maximum_renewals: 4,
        })
        .expect("registry");
        registry
            .issue(
                "reservation:a".to_owned(),
                digest('a'),
                "principal:a".to_owned(),
                resources(10),
                100,
            )
            .expect("issue");
        let snapshot = registry.snapshot().expect("snapshot");
        let restored = ResourceLeaseRegistryV1::restore(snapshot.clone()).expect("restore");
        assert_eq!(restored.snapshot().expect("snapshot"), snapshot);
        let mut tampered = snapshot;
        tampered.leases[0].fence_generation += 1;
        assert_eq!(
            ResourceLeaseRegistryV1::restore(tampered).map(|_| ()),
            Err(ControlPlaneError::ReservationInvalid)
        );
    }

    #[test]
    fn preemption_never_selects_point_of_no_return_or_unsafe_work() {
        let candidates = vec![
            PreemptionCandidateV1 {
                reservation_id: "unsafe".to_owned(),
                priority_class: 0,
                resources: resources(100),
                safe_preemption_boundary: false,
                point_of_no_return_crossed: false,
                recovery_evidence_hash: digest('1'),
            },
            PreemptionCandidateV1 {
                reservation_id: "irreversible".to_owned(),
                priority_class: 1,
                resources: resources(100),
                safe_preemption_boundary: true,
                point_of_no_return_crossed: true,
                recovery_evidence_hash: digest('2'),
            },
            PreemptionCandidateV1 {
                reservation_id: "safe".to_owned(),
                priority_class: 2,
                resources: resources(50),
                safe_preemption_boundary: true,
                point_of_no_return_crossed: false,
                recovery_evidence_hash: digest('3'),
            },
        ];
        let plan = plan_safe_preemption_v1(resources(40), candidates).expect("preemption");
        assert_eq!(plan.selected_reservation_ids, ["safe"]);
        assert!(!plan.grants_authority);
    }

    #[test]
    fn dependency_priority_inherits_transitively_and_cycles_fail_closed() {
        let priorities = BTreeMap::from([
            ("high".to_owned(), 100),
            ("middle".to_owned(), 10),
            ("low".to_owned(), 1),
        ]);
        let inherited = inherit_priorities_v1(
            priorities.clone(),
            vec![
                PriorityDependencyV1 {
                    waiter_id: "high".to_owned(),
                    holder_id: "middle".to_owned(),
                },
                PriorityDependencyV1 {
                    waiter_id: "middle".to_owned(),
                    holder_id: "low".to_owned(),
                },
            ],
        )
        .expect("inheritance");
        assert_eq!(inherited["low"], 100);
        assert_eq!(
            inherit_priorities_v1(
                priorities,
                vec![
                    PriorityDependencyV1 {
                        waiter_id: "high".to_owned(),
                        holder_id: "middle".to_owned(),
                    },
                    PriorityDependencyV1 {
                        waiter_id: "middle".to_owned(),
                        holder_id: "high".to_owned(),
                    },
                ],
            ),
            Err(ControlPlaneError::ResourcePolicyInvalid)
        );
    }
}
