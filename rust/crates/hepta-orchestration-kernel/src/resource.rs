use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, BTreeSet};
use thiserror::Error;

const MAX_SCOPES: usize = 4_096;
const MAX_RESERVATIONS: usize = 100_000;

/// Cumulative resource budget expressed without floating point.
#[derive(Clone, Copy, Debug, Default, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ResourceVectorV1 {
    pub cpu_millis: u64,
    pub memory_mib_millis: u64,
    pub gpu_millis: u64,
    pub storage_byte_millis: u64,
    pub cost_microusd: u64,
}

impl ResourceVectorV1 {
    fn checked_add(self, other: Self) -> Option<Self> {
        Some(Self {
            cpu_millis: self.cpu_millis.checked_add(other.cpu_millis)?,
            memory_mib_millis: self
                .memory_mib_millis
                .checked_add(other.memory_mib_millis)?,
            gpu_millis: self.gpu_millis.checked_add(other.gpu_millis)?,
            storage_byte_millis: self
                .storage_byte_millis
                .checked_add(other.storage_byte_millis)?,
            cost_microusd: self.cost_microusd.checked_add(other.cost_microusd)?,
        })
    }

    fn checked_sub(self, other: Self) -> Option<Self> {
        Some(Self {
            cpu_millis: self.cpu_millis.checked_sub(other.cpu_millis)?,
            memory_mib_millis: self
                .memory_mib_millis
                .checked_sub(other.memory_mib_millis)?,
            gpu_millis: self.gpu_millis.checked_sub(other.gpu_millis)?,
            storage_byte_millis: self
                .storage_byte_millis
                .checked_sub(other.storage_byte_millis)?,
            cost_microusd: self.cost_microusd.checked_sub(other.cost_microusd)?,
        })
    }

    fn fits(self, limit: Self) -> bool {
        self.cpu_millis <= limit.cpu_millis
            && self.memory_mib_millis <= limit.memory_mib_millis
            && self.gpu_millis <= limit.gpu_millis
            && self.storage_byte_millis <= limit.storage_byte_millis
            && self.cost_microusd <= limit.cost_microusd
    }

    fn is_zero(self) -> bool {
        self == Self::default()
    }
}

/// One scope in the campaign/tenant/module hierarchy.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ResourceScopeV1 {
    pub scope_id: String,
    pub parent_scope_id: Option<String>,
    pub generation: u64,
    pub limit: ResourceVectorV1,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ReservationStateV1 {
    Prepared,
    Committed,
    Finalized,
    Cancelled,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ReservationV1 {
    reservation_id: String,
    scope_id: String,
    scope_generation: u64,
    requested: ResourceVectorV1,
    actual: Option<ResourceVectorV1>,
    created_at_unix_ms: u64,
    expires_at_unix_ms: u64,
    state: ReservationStateV1,
}

/// Stable operation receipt for prepare, commit, finalize, cancel and fence.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ReservationReceiptV1 {
    pub version: u16,
    pub reservation_id: String,
    pub scope_id: String,
    pub scope_generation: u64,
    pub state: ReservationStateV1,
    pub requested: ResourceVectorV1,
    pub actual: Option<ResourceVectorV1>,
    pub receipt_hash: String,
}

/// Conservative restart result. Prepared work can be cancelled; committed work
/// remains ambiguous and is never refunded automatically.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RecoveryDispositionV1 {
    pub cancelled_prepared: Vec<String>,
    pub ambiguous_committed: Vec<String>,
}

/// Hierarchical, generation-fenced resource ledger.
#[derive(Clone, Debug)]
pub struct ResourceLedgerV1 {
    scopes: BTreeMap<String, ResourceScopeV1>,
    reserved: BTreeMap<String, ResourceVectorV1>,
    consumed: BTreeMap<String, ResourceVectorV1>,
    reservations: BTreeMap<String, ReservationV1>,
}

impl ResourceLedgerV1 {
    pub fn new(scopes: Vec<ResourceScopeV1>) -> Result<Self, ResourceLedgerError> {
        if scopes.is_empty() || scopes.len() > MAX_SCOPES {
            return Err(ResourceLedgerError::Contract);
        }
        let mut by_id = BTreeMap::new();
        for scope in scopes {
            validate_scope(&scope)?;
            if by_id.insert(scope.scope_id.clone(), scope).is_some() {
                return Err(ResourceLedgerError::DuplicateScope);
            }
        }
        validate_hierarchy(&by_id)?;
        let reserved = by_id
            .keys()
            .cloned()
            .map(|scope_id| (scope_id, ResourceVectorV1::default()))
            .collect();
        let consumed = by_id
            .keys()
            .cloned()
            .map(|scope_id| (scope_id, ResourceVectorV1::default()))
            .collect();
        Ok(Self {
            scopes: by_id,
            reserved,
            consumed,
            reservations: BTreeMap::new(),
        })
    }

    pub fn prepare(
        &mut self,
        reservation_id: String,
        scope_id: String,
        scope_generation: u64,
        requested: ResourceVectorV1,
        created_at_unix_ms: u64,
        expires_at_unix_ms: u64,
    ) -> Result<ReservationReceiptV1, ResourceLedgerError> {
        if !valid_identifier(&reservation_id, 256)
            || !valid_identifier(&scope_id, 256)
            || requested.is_zero()
            || created_at_unix_ms == 0
            || expires_at_unix_ms <= created_at_unix_ms
            || self.reservations.len() >= MAX_RESERVATIONS
            || self.reservations.contains_key(&reservation_id)
        {
            return Err(ResourceLedgerError::Contract);
        }
        let scope = self
            .scopes
            .get(&scope_id)
            .ok_or(ResourceLedgerError::ScopeMissing)?;
        if scope.generation != scope_generation {
            return Err(ResourceLedgerError::StaleGeneration);
        }
        let hierarchy = self.hierarchy(&scope_id)?;
        for current_scope_id in &hierarchy {
            let current_scope = self
                .scopes
                .get(current_scope_id)
                .ok_or(ResourceLedgerError::ScopeMissing)?;
            let consumed = *self
                .consumed
                .get(current_scope_id)
                .ok_or(ResourceLedgerError::Invariant)?;
            let reserved = *self
                .reserved
                .get(current_scope_id)
                .ok_or(ResourceLedgerError::Invariant)?;
            let total = consumed
                .checked_add(reserved)
                .and_then(|value| value.checked_add(requested))
                .ok_or(ResourceLedgerError::Arithmetic)?;
            if !total.fits(current_scope.limit) {
                return Err(ResourceLedgerError::LimitExceeded);
            }
        }
        for current_scope_id in &hierarchy {
            let value = self
                .reserved
                .get_mut(current_scope_id)
                .ok_or(ResourceLedgerError::Invariant)?;
            *value = value
                .checked_add(requested)
                .ok_or(ResourceLedgerError::Arithmetic)?;
        }
        let reservation = ReservationV1 {
            reservation_id: reservation_id.clone(),
            scope_id,
            scope_generation,
            requested,
            actual: None,
            created_at_unix_ms,
            expires_at_unix_ms,
            state: ReservationStateV1::Prepared,
        };
        self.reservations
            .insert(reservation_id, reservation.clone());
        receipt(&reservation)
    }

    pub fn commit(
        &mut self,
        reservation_id: &str,
        observed_at_unix_ms: u64,
    ) -> Result<ReservationReceiptV1, ResourceLedgerError> {
        let reservation = self
            .reservations
            .get_mut(reservation_id)
            .ok_or(ResourceLedgerError::ReservationMissing)?;
        if reservation.state != ReservationStateV1::Prepared
            || observed_at_unix_ms == 0
            || observed_at_unix_ms > reservation.expires_at_unix_ms
        {
            return Err(ResourceLedgerError::StateTransition);
        }
        let scope = self
            .scopes
            .get(&reservation.scope_id)
            .ok_or(ResourceLedgerError::ScopeMissing)?;
        if scope.generation != reservation.scope_generation {
            return Err(ResourceLedgerError::StaleGeneration);
        }
        reservation.state = ReservationStateV1::Committed;
        receipt(reservation)
    }

    pub fn finalize(
        &mut self,
        reservation_id: &str,
        actual: ResourceVectorV1,
    ) -> Result<ReservationReceiptV1, ResourceLedgerError> {
        let reservation = self
            .reservations
            .get(reservation_id)
            .cloned()
            .ok_or(ResourceLedgerError::ReservationMissing)?;
        if reservation.state != ReservationStateV1::Committed || !actual.fits(reservation.requested)
        {
            return Err(ResourceLedgerError::StateTransition);
        }
        self.release_reserved(&reservation)?;
        let hierarchy = self.hierarchy(&reservation.scope_id)?;
        for current_scope_id in &hierarchy {
            let value = self
                .consumed
                .get_mut(current_scope_id)
                .ok_or(ResourceLedgerError::Invariant)?;
            *value = value
                .checked_add(actual)
                .ok_or(ResourceLedgerError::Arithmetic)?;
        }
        let current = self
            .reservations
            .get_mut(reservation_id)
            .ok_or(ResourceLedgerError::ReservationMissing)?;
        current.actual = Some(actual);
        current.state = ReservationStateV1::Finalized;
        receipt(current)
    }

    pub fn cancel(
        &mut self,
        reservation_id: &str,
    ) -> Result<ReservationReceiptV1, ResourceLedgerError> {
        let reservation = self
            .reservations
            .get(reservation_id)
            .cloned()
            .ok_or(ResourceLedgerError::ReservationMissing)?;
        if reservation.state != ReservationStateV1::Prepared {
            return Err(ResourceLedgerError::StateTransition);
        }
        self.release_reserved(&reservation)?;
        let current = self
            .reservations
            .get_mut(reservation_id)
            .ok_or(ResourceLedgerError::ReservationMissing)?;
        current.state = ReservationStateV1::Cancelled;
        receipt(current)
    }

    pub fn recover_expired(
        &mut self,
        observed_at_unix_ms: u64,
    ) -> Result<RecoveryDispositionV1, ResourceLedgerError> {
        if observed_at_unix_ms == 0 {
            return Err(ResourceLedgerError::Contract);
        }
        let mut cancelled_prepared = Vec::new();
        let mut ambiguous_committed = Vec::new();
        let expired = self
            .reservations
            .values()
            .filter(|reservation| reservation.expires_at_unix_ms < observed_at_unix_ms)
            .map(|reservation| (reservation.reservation_id.clone(), reservation.state))
            .collect::<Vec<_>>();
        for (reservation_id, state) in expired {
            match state {
                ReservationStateV1::Prepared => {
                    self.cancel(&reservation_id)?;
                    cancelled_prepared.push(reservation_id);
                }
                ReservationStateV1::Committed => ambiguous_committed.push(reservation_id),
                ReservationStateV1::Finalized | ReservationStateV1::Cancelled => {}
            }
        }
        cancelled_prepared.sort();
        ambiguous_committed.sort();
        Ok(RecoveryDispositionV1 {
            cancelled_prepared,
            ambiguous_committed,
        })
    }

    pub fn fence_scope(&mut self, scope_id: &str) -> Result<u64, ResourceLedgerError> {
        if !self.scopes.contains_key(scope_id) {
            return Err(ResourceLedgerError::ScopeMissing);
        }
        for reservation in self.reservations.values() {
            if matches!(
                reservation.state,
                ReservationStateV1::Prepared | ReservationStateV1::Committed
            ) && self.hierarchy(&reservation.scope_id)?.iter().any(|item| item == scope_id)
            {
                return Err(ResourceLedgerError::ActiveReservation);
            }
        }
        let scope = self
            .scopes
            .get_mut(scope_id)
            .ok_or(ResourceLedgerError::ScopeMissing)?;
        scope.generation = scope
            .generation
            .checked_add(1)
            .ok_or(ResourceLedgerError::Arithmetic)?;
        Ok(scope.generation)
    }

    pub fn consumed(&self, scope_id: &str) -> Option<ResourceVectorV1> {
        self.consumed.get(scope_id).copied()
    }

    pub fn reserved(&self, scope_id: &str) -> Option<ResourceVectorV1> {
        self.reserved.get(scope_id).copied()
    }

    fn release_reserved(
        &mut self,
        reservation: &ReservationV1,
    ) -> Result<(), ResourceLedgerError> {
        let hierarchy = self.hierarchy(&reservation.scope_id)?;
        for current_scope_id in hierarchy {
            let value = self
                .reserved
                .get_mut(&current_scope_id)
                .ok_or(ResourceLedgerError::Invariant)?;
            *value = value
                .checked_sub(reservation.requested)
                .ok_or(ResourceLedgerError::Invariant)?;
        }
        Ok(())
    }

    fn hierarchy(&self, scope_id: &str) -> Result<Vec<String>, ResourceLedgerError> {
        let mut hierarchy = Vec::new();
        let mut seen = BTreeSet::new();
        let mut current = Some(scope_id);
        while let Some(scope_id) = current {
            if !seen.insert(scope_id.to_owned()) {
                return Err(ResourceLedgerError::HierarchyCycle);
            }
            let scope = self
                .scopes
                .get(scope_id)
                .ok_or(ResourceLedgerError::ScopeMissing)?;
            hierarchy.push(scope.scope_id.clone());
            current = scope.parent_scope_id.as_deref();
        }
        Ok(hierarchy)
    }
}

fn validate_scope(scope: &ResourceScopeV1) -> Result<(), ResourceLedgerError> {
    if !valid_identifier(&scope.scope_id, 256)
        || scope.generation == 0
        || scope.limit.is_zero()
        || scope
            .parent_scope_id
            .as_deref()
            .is_some_and(|parent| !valid_identifier(parent, 256) || parent == scope.scope_id)
    {
        return Err(ResourceLedgerError::Contract);
    }
    Ok(())
}

fn validate_hierarchy(
    scopes: &BTreeMap<String, ResourceScopeV1>,
) -> Result<(), ResourceLedgerError> {
    for scope in scopes.values() {
        if let Some(parent_id) = &scope.parent_scope_id {
            let parent = scopes
                .get(parent_id)
                .ok_or(ResourceLedgerError::ScopeMissing)?;
            if !scope.limit.fits(parent.limit) {
                return Err(ResourceLedgerError::ChildLimitExceeded);
            }
        }
        let mut seen = BTreeSet::new();
        let mut current = Some(scope.scope_id.as_str());
        while let Some(scope_id) = current {
            if !seen.insert(scope_id) {
                return Err(ResourceLedgerError::HierarchyCycle);
            }
            current = scopes
                .get(scope_id)
                .ok_or(ResourceLedgerError::ScopeMissing)?
                .parent_scope_id
                .as_deref();
        }
    }
    Ok(())
}

fn receipt(reservation: &ReservationV1) -> Result<ReservationReceiptV1, ResourceLedgerError> {
    let body = ReservationReceiptBodyV1 {
        version: 1,
        reservation_id: &reservation.reservation_id,
        scope_id: &reservation.scope_id,
        scope_generation: reservation.scope_generation,
        state: reservation.state,
        requested: reservation.requested,
        actual: reservation.actual,
    };
    let receipt_hash = canonical_hash("HeptaResourceReservationReceiptV1", &body)?;
    Ok(ReservationReceiptV1 {
        version: 1,
        reservation_id: reservation.reservation_id.clone(),
        scope_id: reservation.scope_id.clone(),
        scope_generation: reservation.scope_generation,
        state: reservation.state,
        requested: reservation.requested,
        actual: reservation.actual,
        receipt_hash,
    })
}

fn canonical_hash<T: Serialize>(domain: &str, value: &T) -> Result<String, ResourceLedgerError> {
    let bytes = serde_json::to_vec(value).map_err(|_| ResourceLedgerError::Encoding)?;
    let mut hasher = Sha256::new();
    update_hash(&mut hasher, domain.as_bytes());
    update_hash(&mut hasher, &bytes);
    Ok(format!("sha256:{}", hex::encode(hasher.finalize())))
}

fn update_hash(hasher: &mut Sha256, value: &[u8]) {
    hasher.update(u64::try_from(value.len()).unwrap_or(u64::MAX).to_be_bytes());
    hasher.update(value);
}

fn valid_identifier(value: &str, maximum: usize) -> bool {
    !value.is_empty()
        && value.len() <= maximum
        && value.bytes().all(|byte| {
            byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.' | b':' | b'/')
        })
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ReservationReceiptBodyV1<'a> {
    version: u16,
    reservation_id: &'a str,
    scope_id: &'a str,
    scope_generation: u64,
    state: ReservationStateV1,
    requested: ResourceVectorV1,
    actual: Option<ResourceVectorV1>,
}

#[derive(Clone, Debug, Error, Eq, PartialEq)]
pub enum ResourceLedgerError {
    #[error("resource ledger contract is invalid")]
    Contract,
    #[error("resource scope is duplicated")]
    DuplicateScope,
    #[error("resource scope is missing")]
    ScopeMissing,
    #[error("resource hierarchy contains a cycle")]
    HierarchyCycle,
    #[error("child resource limit exceeds its parent")]
    ChildLimitExceeded,
    #[error("resource reservation is missing")]
    ReservationMissing,
    #[error("resource reservation exceeds a hierarchy limit")]
    LimitExceeded,
    #[error("resource generation is stale")]
    StaleGeneration,
    #[error("resource reservation state transition is invalid")]
    StateTransition,
    #[error("resource scope still has an active reservation")]
    ActiveReservation,
    #[error("resource arithmetic overflowed")]
    Arithmetic,
    #[error("resource ledger invariant failed")]
    Invariant,
    #[error("resource receipt encoding failed")]
    Encoding,
}

#[cfg(test)]
mod tests {
    use super::*;

    fn vector(value: u64) -> ResourceVectorV1 {
        ResourceVectorV1 {
            cpu_millis: value,
            memory_mib_millis: value,
            gpu_millis: value,
            storage_byte_millis: value,
            cost_microusd: value,
        }
    }

    fn ledger() -> ResourceLedgerV1 {
        match ResourceLedgerV1::new(vec![
            ResourceScopeV1 {
                scope_id: "tenant:one".to_owned(),
                parent_scope_id: None,
                generation: 1,
                limit: vector(100),
            },
            ResourceScopeV1 {
                scope_id: "campaign:one".to_owned(),
                parent_scope_id: Some("tenant:one".to_owned()),
                generation: 1,
                limit: vector(80),
            },
        ]) {
            Ok(value) => value,
            Err(error) => {
                assert!(false, "ledger construction failed: {error}");
                unreachable!()
            }
        }
    }

    #[test]
    fn reservation_is_accounted_through_the_hierarchy() {
        let mut value = ledger();
        let prepared = value.prepare(
            "reservation:one".to_owned(),
            "campaign:one".to_owned(),
            1,
            vector(30),
            10,
            20,
        );
        assert!(prepared.is_ok());
        assert_eq!(value.reserved("campaign:one"), Some(vector(30)));
        assert_eq!(value.reserved("tenant:one"), Some(vector(30)));
        assert!(value.commit("reservation:one", 15).is_ok());
        assert!(value.finalize("reservation:one", vector(20)).is_ok());
        assert_eq!(value.reserved("tenant:one"), Some(ResourceVectorV1::default()));
        assert_eq!(value.consumed("tenant:one"), Some(vector(20)));
    }

    #[test]
    fn stale_generation_and_overcommit_fail_closed() {
        let mut value = ledger();
        assert_eq!(
            value.prepare(
                "reservation:stale".to_owned(),
                "campaign:one".to_owned(),
                2,
                vector(10),
                10,
                20,
            ),
            Err(ResourceLedgerError::StaleGeneration)
        );
        assert_eq!(
            value.prepare(
                "reservation:large".to_owned(),
                "campaign:one".to_owned(),
                1,
                vector(90),
                10,
                20,
            ),
            Err(ResourceLedgerError::LimitExceeded)
        );
    }

    #[test]
    fn restart_never_refunds_committed_ambiguity() {
        let mut value = ledger();
        assert!(
            value
                .prepare(
                    "reservation:ambiguous".to_owned(),
                    "campaign:one".to_owned(),
                    1,
                    vector(10),
                    10,
                    20,
                )
                .is_ok()
        );
        assert!(value.commit("reservation:ambiguous", 15).is_ok());
        let recovery = value.recover_expired(21);
        match recovery {
            Ok(disposition) => {
                assert_eq!(disposition.ambiguous_committed, ["reservation:ambiguous"]);
                assert_eq!(value.reserved("tenant:one"), Some(vector(10)));
            }
            other => assert!(false, "unexpected recovery: {other:?}"),
        }
    }
}
