use std::{
    collections::BTreeMap,
    fs::{File, OpenOptions},
    io::{Read, Seek, SeekFrom, Write},
    path::{Path, PathBuf},
};

use hepta_codex_protocol::Sha256Digest;
use hepta_module_platform::ResourceVectorV1;
use serde::{Deserialize, Serialize};

use crate::{ControlPlaneError, canonical_hash_v1};

const MAXIMUM_LEDGER_BYTES_V1: u64 = 256 * 1024 * 1024;
const MAXIMUM_LEDGER_EVENT_BYTES_V1: usize = 256 * 1024;

/// Durable resource-lease lifecycle. Ambiguous consumption is never silently released.
#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum DurableResourceLeaseStateV1 {
    /// Capacity is durably prepared but no dispatch capability may be consumed yet.
    Prepared,
    /// Capacity is finalized and may back one fenced dispatch.
    Finalized,
    /// Consumption cannot be proven released and remains charged.
    Uncertain,
    /// Capacity is reconciled and no longer charged.
    Released,
}

/// Complete immutable input to the durable prepare boundary.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DurableResourcePrepareV1 {
    /// Stable reservation identity.
    pub reservation_id: String,
    /// Principal or worker owner identity.
    pub owner_id: String,
    /// Leaf scheduling-domain identity.
    pub domain_id: String,
    /// Monotonic fence generation.
    pub fence_generation: u64,
    /// Hash of the single-use fence token; raw token bytes are never persisted here.
    pub fence_token_hash: Sha256Digest,
    /// Exact hierarchical resource-policy identity.
    pub policy_hash: Sha256Digest,
    /// Exact plan certificate identity.
    pub plan_hash: Sha256Digest,
    /// Exact action/candidate identity.
    pub action_hash: Sha256Digest,
    /// Complete reserved resource vector.
    pub resources: ResourceVectorV1,
    /// Explicit issue time.
    pub issued_at_unix_ms: u64,
    /// Explicit lease expiry.
    pub expires_at_unix_ms: u64,
}

impl DurableResourcePrepareV1 {
    fn validate(&self) -> Result<(), ControlPlaneError> {
        if !valid_identifier(&self.reservation_id)
            || !valid_identifier(&self.owner_id)
            || !valid_identifier(&self.domain_id)
            || self.fence_generation == 0
            || self.resources.is_zero()
            || self.issued_at_unix_ms == 0
            || self.expires_at_unix_ms <= self.issued_at_unix_ms
        {
            return Err(ControlPlaneError::ResourcePersistenceInvalid);
        }
        Ok(())
    }
}

/// Exact durable lease record including its canonical integrity hash.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DurableResourceLeaseV1 {
    /// Stable reservation identity.
    pub reservation_id: String,
    /// Principal or worker owner identity.
    pub owner_id: String,
    /// Leaf scheduling-domain identity.
    pub domain_id: String,
    /// Monotonic fence generation.
    pub fence_generation: u64,
    /// Hash of the single-use fence token.
    pub fence_token_hash: Sha256Digest,
    /// Exact resource policy identity.
    pub policy_hash: Sha256Digest,
    /// Exact plan identity.
    pub plan_hash: Sha256Digest,
    /// Exact action identity.
    pub action_hash: Sha256Digest,
    /// Complete resource vector retained while this record is active or uncertain.
    pub resources: ResourceVectorV1,
    /// Issue time.
    pub issued_at_unix_ms: u64,
    /// Current expiry.
    pub expires_at_unix_ms: u64,
    /// Durable lifecycle state.
    pub state: DurableResourceLeaseStateV1,
    /// Reconciliation receipt required before finalized or uncertain capacity is released.
    pub reconciliation_receipt_hash: Option<Sha256Digest>,
    /// Canonical record hash excluding this field.
    pub row_hash: Sha256Digest,
}

impl DurableResourceLeaseV1 {
    /// Verifies the persisted self-hash and basic invariants.
    pub fn validate(&self) -> Result<(), ControlPlaneError> {
        DurableResourcePrepareV1 {
            reservation_id: self.reservation_id.clone(),
            owner_id: self.owner_id.clone(),
            domain_id: self.domain_id.clone(),
            fence_generation: self.fence_generation,
            fence_token_hash: self.fence_token_hash.clone(),
            policy_hash: self.policy_hash.clone(),
            plan_hash: self.plan_hash.clone(),
            action_hash: self.action_hash.clone(),
            resources: self.resources,
            issued_at_unix_ms: self.issued_at_unix_ms,
            expires_at_unix_ms: self.expires_at_unix_ms,
        }
        .validate()?;
        if self.state == DurableResourceLeaseStateV1::Released
            && self.reconciliation_receipt_hash.is_none()
        {
            return Err(ControlPlaneError::ResourcePersistenceInvalid);
        }
        if self.row_hash != lease_row_hash(self)? {
            return Err(ControlPlaneError::ResourcePersistenceInvalid);
        }
        Ok(())
    }
}

/// Crash-recovery disposition for the durable resource ledger.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ResourceRecoveryReportV1 {
    /// Expired prepared reservations rolled back before dispatch.
    pub prepared_released: Vec<String>,
    /// Expired finalized reservations moved to `uncertain` and retained as charges.
    pub finalized_marked_uncertain: Vec<String>,
    /// Already uncertain reservation identities retained as charges.
    pub retained_uncertain: Vec<String>,
    /// Canonical report identity.
    pub report_hash: Sha256Digest,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
enum ResourceLedgerActionV1 {
    Prepare,
    Finalize,
    Renew,
    MarkUncertain,
    Release,
    RecoverPreparedExpiry,
    RecoverFinalizedExpiry,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ResourceLedgerEventV1 {
    version: u16,
    sequence: u64,
    previous_event_hash: Option<Sha256Digest>,
    action: ResourceLedgerActionV1,
    lease: DurableResourceLeaseV1,
    event_hash: Sha256Digest,
}

/// Locked append-only durable resource journal.
///
/// Each complete JSONL event is self-hashed and globally hash chained. A process crash can leave
/// an incomplete trailing line; reopening truncates only that trailing fragment after all earlier
/// complete events have been validated. `File::try_lock` provides process-scoped exclusivity and
/// is released automatically on process death.
pub struct DurableResourceLeaseLedgerV1 {
    path: PathBuf,
    file: File,
    leases: BTreeMap<String, DurableResourceLeaseV1>,
    next_sequence: u64,
    previous_event_hash: Option<Sha256Digest>,
}

impl DurableResourceLeaseLedgerV1 {
    /// Opens or creates the ledger and takes a non-blocking exclusive process lock.
    pub fn open(path: impl AsRef<Path>) -> Result<Self, ControlPlaneError> {
        let path = path.as_ref();
        if path.as_os_str().is_empty()
            || path
                .symlink_metadata()
                .is_ok_and(|metadata| metadata.file_type().is_symlink())
        {
            return Err(ControlPlaneError::ResourcePersistenceInvalid);
        }
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent)
                .map_err(|_| ControlPlaneError::ResourcePersistenceInvalid)?;
        }
        let mut file = OpenOptions::new()
            .read(true)
            .append(true)
            .create(true)
            .open(path)
            .map_err(|_| ControlPlaneError::ResourcePersistenceInvalid)?;
        file.try_lock()
            .map_err(|_| ControlPlaneError::ResourcePersistenceInvalid)?;
        let metadata = file
            .metadata()
            .map_err(|_| ControlPlaneError::ResourcePersistenceInvalid)?;
        if metadata.len() > MAXIMUM_LEDGER_BYTES_V1 {
            return Err(ControlPlaneError::ResourcePersistenceInvalid);
        }
        file.seek(SeekFrom::Start(0))
            .map_err(|_| ControlPlaneError::ResourcePersistenceInvalid)?;
        let mut bytes = Vec::with_capacity(
            usize::try_from(metadata.len()).map_err(|_| ControlPlaneError::ResourcePersistenceInvalid)?,
        );
        file.read_to_end(&mut bytes)
            .map_err(|_| ControlPlaneError::ResourcePersistenceInvalid)?;
        if !bytes.is_empty() && !bytes.ends_with(b"\n") {
            let Some(last_newline) = bytes.iter().rposition(|byte| *byte == b'\n') else {
                return Err(ControlPlaneError::ResourcePersistenceInvalid);
            };
            let retained = last_newline + 1;
            bytes.truncate(retained);
            file.set_len(
                u64::try_from(retained).map_err(|_| ControlPlaneError::ResourcePersistenceInvalid)?,
            )
            .map_err(|_| ControlPlaneError::ResourcePersistenceInvalid)?;
            file.sync_all()
                .map_err(|_| ControlPlaneError::ResourcePersistenceInvalid)?;
        }
        let (leases, next_sequence, previous_event_hash) = replay_events(&bytes)?;
        Ok(Self {
            path: path.to_path_buf(),
            file,
            leases,
            next_sequence,
            previous_event_hash,
        })
    }

    /// Returns the exact backing path for operator evidence binding.
    #[must_use]
    pub fn path(&self) -> &Path {
        &self.path
    }

    /// Durably prepares one resource vector before dispatch. Exact retries are idempotent.
    pub fn prepare(
        &mut self,
        request: DurableResourcePrepareV1,
    ) -> Result<DurableResourceLeaseV1, ControlPlaneError> {
        request.validate()?;
        let candidate = lease_from_prepare(request)?;
        if let Some(existing) = self.leases.get(&candidate.reservation_id) {
            return if existing == &candidate {
                Ok(existing.clone())
            } else {
                Err(ControlPlaneError::ReservationInvalid)
            };
        }
        self.append(ResourceLedgerActionV1::Prepare, candidate.clone())?;
        Ok(candidate)
    }

    /// Finalizes a prepared lease after plan/capacity generations have been revalidated.
    pub fn finalize(
        &mut self,
        reservation_id: &str,
        fence_generation: u64,
        fence_token_hash: &Sha256Digest,
        now_unix_ms: u64,
    ) -> Result<DurableResourceLeaseV1, ControlPlaneError> {
        let current = self.owned_current(
            reservation_id,
            fence_generation,
            fence_token_hash,
        )?;
        if current.state == DurableResourceLeaseStateV1::Finalized {
            return Ok(current);
        }
        if current.state != DurableResourceLeaseStateV1::Prepared
            || current.expires_at_unix_ms <= now_unix_ms
        {
            return Err(ControlPlaneError::ReservationInvalid);
        }
        let next = transitioned(
            &current,
            DurableResourceLeaseStateV1::Finalized,
            current.expires_at_unix_ms,
            None,
        )?;
        self.append(ResourceLedgerActionV1::Finalize, next.clone())?;
        Ok(next)
    }

    /// Renews a finalized lease without changing its generation or token identity.
    pub fn renew(
        &mut self,
        reservation_id: &str,
        fence_generation: u64,
        fence_token_hash: &Sha256Digest,
        now_unix_ms: u64,
        new_expires_at_unix_ms: u64,
    ) -> Result<DurableResourceLeaseV1, ControlPlaneError> {
        let current = self.owned_current(
            reservation_id,
            fence_generation,
            fence_token_hash,
        )?;
        if current.state != DurableResourceLeaseStateV1::Finalized
            || current.expires_at_unix_ms <= now_unix_ms
            || new_expires_at_unix_ms < current.expires_at_unix_ms
            || new_expires_at_unix_ms <= now_unix_ms
        {
            return Err(ControlPlaneError::ReservationInvalid);
        }
        if new_expires_at_unix_ms == current.expires_at_unix_ms {
            return Ok(current);
        }
        let next = transitioned(
            &current,
            DurableResourceLeaseStateV1::Finalized,
            new_expires_at_unix_ms,
            None,
        )?;
        self.append(ResourceLedgerActionV1::Renew, next.clone())?;
        Ok(next)
    }

    /// Marks a finalized lease uncertain after owner loss or ambiguous external disposition.
    pub fn mark_uncertain(
        &mut self,
        reservation_id: &str,
        fence_generation: u64,
        fence_token_hash: &Sha256Digest,
    ) -> Result<DurableResourceLeaseV1, ControlPlaneError> {
        let current = self.owned_current(
            reservation_id,
            fence_generation,
            fence_token_hash,
        )?;
        if current.state == DurableResourceLeaseStateV1::Uncertain {
            return Ok(current);
        }
        if current.state != DurableResourceLeaseStateV1::Finalized {
            return Err(ControlPlaneError::ReservationInvalid);
        }
        let next = transitioned(
            &current,
            DurableResourceLeaseStateV1::Uncertain,
            current.expires_at_unix_ms,
            None,
        )?;
        self.append(ResourceLedgerActionV1::MarkUncertain, next.clone())?;
        Ok(next)
    }

    /// Releases finalized or uncertain capacity only with a trusted reconciliation receipt.
    pub fn reconcile_and_release(
        &mut self,
        reservation_id: &str,
        fence_generation: u64,
        fence_token_hash: &Sha256Digest,
        reconciliation_receipt_hash: Sha256Digest,
    ) -> Result<DurableResourceLeaseV1, ControlPlaneError> {
        let current = self.owned_current(
            reservation_id,
            fence_generation,
            fence_token_hash,
        )?;
        if current.state == DurableResourceLeaseStateV1::Released {
            return if current.reconciliation_receipt_hash.as_ref()
                == Some(&reconciliation_receipt_hash)
            {
                Ok(current)
            } else {
                Err(ControlPlaneError::ReservationInvalid)
            };
        }
        if !matches!(
            current.state,
            DurableResourceLeaseStateV1::Finalized | DurableResourceLeaseStateV1::Uncertain
        ) {
            return Err(ControlPlaneError::ReservationInvalid);
        }
        let next = transitioned(
            &current,
            DurableResourceLeaseStateV1::Released,
            current.expires_at_unix_ms,
            Some(reconciliation_receipt_hash),
        )?;
        self.append(ResourceLedgerActionV1::Release, next.clone())?;
        Ok(next)
    }

    /// Recovers expired reservations conservatively after a crash or restart.
    ///
    /// Prepared-but-never-finalized capacity is released with a deterministic pre-dispatch
    /// receipt. Expired finalized capacity becomes uncertain and remains charged until an
    /// explicit reconciliation receipt is accepted.
    pub fn recover_expired(
        &mut self,
        now_unix_ms: u64,
    ) -> Result<ResourceRecoveryReportV1, ControlPlaneError> {
        if now_unix_ms == 0 {
            return Err(ControlPlaneError::ResourcePersistenceInvalid);
        }
        let current = self.leases.values().cloned().collect::<Vec<_>>();
        let mut prepared_released = Vec::new();
        let mut finalized_marked_uncertain = Vec::new();
        let mut retained_uncertain = Vec::new();
        for lease in current {
            match lease.state {
                DurableResourceLeaseStateV1::Prepared
                    if lease.expires_at_unix_ms <= now_unix_ms =>
                {
                    let receipt = canonical_hash_v1(&(
                        "resource_pre_dispatch_expiry_v1",
                        lease.reservation_id.as_str(),
                        lease.row_hash.clone(),
                        now_unix_ms,
                    ))?;
                    let next = transitioned(
                        &lease,
                        DurableResourceLeaseStateV1::Released,
                        lease.expires_at_unix_ms,
                        Some(receipt),
                    )?;
                    self.append(ResourceLedgerActionV1::RecoverPreparedExpiry, next)?;
                    prepared_released.push(lease.reservation_id);
                }
                DurableResourceLeaseStateV1::Finalized
                    if lease.expires_at_unix_ms <= now_unix_ms =>
                {
                    let next = transitioned(
                        &lease,
                        DurableResourceLeaseStateV1::Uncertain,
                        lease.expires_at_unix_ms,
                        None,
                    )?;
                    self.append(ResourceLedgerActionV1::RecoverFinalizedExpiry, next)?;
                    finalized_marked_uncertain.push(lease.reservation_id);
                }
                DurableResourceLeaseStateV1::Uncertain => {
                    retained_uncertain.push(lease.reservation_id);
                }
                _ => {}
            }
        }
        prepared_released.sort();
        finalized_marked_uncertain.sort();
        retained_uncertain.sort();
        let report_hash = canonical_hash_v1(&(
            prepared_released.clone(),
            finalized_marked_uncertain.clone(),
            retained_uncertain.clone(),
            now_unix_ms,
        ))?;
        Ok(ResourceRecoveryReportV1 {
            prepared_released,
            finalized_marked_uncertain,
            retained_uncertain,
            report_hash,
        })
    }

    /// Returns every lease that still consumes or conservatively retains capacity.
    #[must_use]
    pub fn active_charges(&self) -> Vec<DurableResourceLeaseV1> {
        self.leases
            .values()
            .filter(|lease| lease.state != DurableResourceLeaseStateV1::Released)
            .cloned()
            .collect()
    }

    /// Loads one exact reservation when present.
    pub fn load(&self, reservation_id: &str) -> Result<Option<DurableResourceLeaseV1>, ControlPlaneError> {
        if !valid_identifier(reservation_id) {
            return Err(ControlPlaneError::ReservationInvalid);
        }
        Ok(self.leases.get(reservation_id).cloned())
    }

    /// Checks every current lease self-hash. Event-chain integrity is verified on open and append.
    pub fn validate_integrity(&self) -> Result<(), ControlPlaneError> {
        for lease in self.leases.values() {
            lease.validate()?;
        }
        Ok(())
    }

    fn owned_current(
        &self,
        reservation_id: &str,
        fence_generation: u64,
        fence_token_hash: &Sha256Digest,
    ) -> Result<DurableResourceLeaseV1, ControlPlaneError> {
        let lease = self
            .leases
            .get(reservation_id)
            .cloned()
            .ok_or(ControlPlaneError::ReservationInvalid)?;
        if lease.fence_generation != fence_generation
            || &lease.fence_token_hash != fence_token_hash
        {
            return Err(ControlPlaneError::ReservationInvalid);
        }
        Ok(lease)
    }

    fn append(
        &mut self,
        action: ResourceLedgerActionV1,
        lease: DurableResourceLeaseV1,
    ) -> Result<(), ControlPlaneError> {
        lease.validate()?;
        let current = self.leases.get(&lease.reservation_id);
        validate_transition(action, current, &lease)?;
        let body = ResourceLedgerEventBodyV1 {
            version: 1,
            sequence: self.next_sequence,
            previous_event_hash: self.previous_event_hash.as_ref(),
            action,
            lease: &lease,
        };
        let event_hash = canonical_hash_v1(&body)?;
        let event = ResourceLedgerEventV1 {
            version: 1,
            sequence: self.next_sequence,
            previous_event_hash: self.previous_event_hash.clone(),
            action,
            lease: lease.clone(),
            event_hash: event_hash.clone(),
        };
        let encoded = serde_json::to_vec(&event)
            .map_err(|_| ControlPlaneError::ResourcePersistenceInvalid)?;
        if encoded.len() > MAXIMUM_LEDGER_EVENT_BYTES_V1 {
            return Err(ControlPlaneError::ResourcePersistenceInvalid);
        }
        let current_size = self
            .file
            .metadata()
            .map_err(|_| ControlPlaneError::ResourcePersistenceInvalid)?
            .len();
        let next_size = current_size
            .checked_add(
                u64::try_from(encoded.len() + 1)
                    .map_err(|_| ControlPlaneError::ResourcePersistenceInvalid)?,
            )
            .ok_or(ControlPlaneError::ResourcePersistenceInvalid)?;
        if next_size > MAXIMUM_LEDGER_BYTES_V1 {
            return Err(ControlPlaneError::ResourcePersistenceInvalid);
        }
        self.file
            .write_all(&encoded)
            .and_then(|()| self.file.write_all(b"\n"))
            .and_then(|()| self.file.sync_all())
            .map_err(|_| ControlPlaneError::ResourcePersistenceInvalid)?;
        self.leases.insert(lease.reservation_id.clone(), lease);
        self.previous_event_hash = Some(event_hash);
        self.next_sequence = self
            .next_sequence
            .checked_add(1)
            .ok_or(ControlPlaneError::ResourcePersistenceInvalid)?;
        Ok(())
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ResourceLedgerEventBodyV1<'a> {
    version: u16,
    sequence: u64,
    previous_event_hash: Option<&'a Sha256Digest>,
    action: ResourceLedgerActionV1,
    lease: &'a DurableResourceLeaseV1,
}

fn replay_events(
    bytes: &[u8],
) -> Result<
    (
        BTreeMap<String, DurableResourceLeaseV1>,
        u64,
        Option<Sha256Digest>,
    ),
    ControlPlaneError,
> {
    let mut leases = BTreeMap::new();
    let mut expected_sequence = 1_u64;
    let mut previous_event_hash: Option<Sha256Digest> = None;
    for line in bytes.split(|byte| *byte == b'\n').filter(|line| !line.is_empty()) {
        if line.len() > MAXIMUM_LEDGER_EVENT_BYTES_V1 {
            return Err(ControlPlaneError::ResourcePersistenceInvalid);
        }
        let event: ResourceLedgerEventV1 = serde_json::from_slice(line)
            .map_err(|_| ControlPlaneError::ResourcePersistenceInvalid)?;
        if event.version != 1
            || event.sequence != expected_sequence
            || event.previous_event_hash != previous_event_hash
        {
            return Err(ControlPlaneError::ResourcePersistenceInvalid);
        }
        event.lease.validate()?;
        let body = ResourceLedgerEventBodyV1 {
            version: event.version,
            sequence: event.sequence,
            previous_event_hash: event.previous_event_hash.as_ref(),
            action: event.action,
            lease: &event.lease,
        };
        if event.event_hash != canonical_hash_v1(&body)? {
            return Err(ControlPlaneError::ResourcePersistenceInvalid);
        }
        validate_transition(
            event.action,
            leases.get(&event.lease.reservation_id),
            &event.lease,
        )?;
        leases.insert(event.lease.reservation_id.clone(), event.lease);
        previous_event_hash = Some(event.event_hash);
        expected_sequence = expected_sequence
            .checked_add(1)
            .ok_or(ControlPlaneError::ResourcePersistenceInvalid)?;
    }
    Ok((leases, expected_sequence, previous_event_hash))
}

fn validate_transition(
    action: ResourceLedgerActionV1,
    current: Option<&DurableResourceLeaseV1>,
    next: &DurableResourceLeaseV1,
) -> Result<(), ControlPlaneError> {
    match (action, current) {
        (ResourceLedgerActionV1::Prepare, None)
            if next.state == DurableResourceLeaseStateV1::Prepared =>
        {
            Ok(())
        }
        (ResourceLedgerActionV1::Prepare, _) => Err(ControlPlaneError::ReservationInvalid),
        (_, None) => Err(ControlPlaneError::ResourcePersistenceInvalid),
        (action, Some(current)) => {
            if !same_immutable_identity(current, next) {
                return Err(ControlPlaneError::ResourcePersistenceInvalid);
            }
            let valid = match action {
                ResourceLedgerActionV1::Prepare => false,
                ResourceLedgerActionV1::Finalize => {
                    current.state == DurableResourceLeaseStateV1::Prepared
                        && next.state == DurableResourceLeaseStateV1::Finalized
                        && next.expires_at_unix_ms == current.expires_at_unix_ms
                        && next.reconciliation_receipt_hash.is_none()
                }
                ResourceLedgerActionV1::Renew => {
                    current.state == DurableResourceLeaseStateV1::Finalized
                        && next.state == DurableResourceLeaseStateV1::Finalized
                        && next.expires_at_unix_ms >= current.expires_at_unix_ms
                        && next.reconciliation_receipt_hash.is_none()
                }
                ResourceLedgerActionV1::MarkUncertain
                | ResourceLedgerActionV1::RecoverFinalizedExpiry => {
                    current.state == DurableResourceLeaseStateV1::Finalized
                        && next.state == DurableResourceLeaseStateV1::Uncertain
                        && next.expires_at_unix_ms == current.expires_at_unix_ms
                        && next.reconciliation_receipt_hash.is_none()
                }
                ResourceLedgerActionV1::Release => {
                    matches!(
                        current.state,
                        DurableResourceLeaseStateV1::Finalized
                            | DurableResourceLeaseStateV1::Uncertain
                    ) && next.state == DurableResourceLeaseStateV1::Released
                        && next.reconciliation_receipt_hash.is_some()
                }
                ResourceLedgerActionV1::RecoverPreparedExpiry => {
                    current.state == DurableResourceLeaseStateV1::Prepared
                        && next.state == DurableResourceLeaseStateV1::Released
                        && next.reconciliation_receipt_hash.is_some()
                }
            };
            if valid {
                Ok(())
            } else {
                Err(ControlPlaneError::ResourcePersistenceInvalid)
            }
        }
    }
}

fn same_immutable_identity(
    current: &DurableResourceLeaseV1,
    next: &DurableResourceLeaseV1,
) -> bool {
    current.reservation_id == next.reservation_id
        && current.owner_id == next.owner_id
        && current.domain_id == next.domain_id
        && current.fence_generation == next.fence_generation
        && current.fence_token_hash == next.fence_token_hash
        && current.policy_hash == next.policy_hash
        && current.plan_hash == next.plan_hash
        && current.action_hash == next.action_hash
        && current.resources == next.resources
        && current.issued_at_unix_ms == next.issued_at_unix_ms
}

fn lease_from_prepare(
    request: DurableResourcePrepareV1,
) -> Result<DurableResourceLeaseV1, ControlPlaneError> {
    request.validate()?;
    let mut lease = DurableResourceLeaseV1 {
        reservation_id: request.reservation_id,
        owner_id: request.owner_id,
        domain_id: request.domain_id,
        fence_generation: request.fence_generation,
        fence_token_hash: request.fence_token_hash,
        policy_hash: request.policy_hash,
        plan_hash: request.plan_hash,
        action_hash: request.action_hash,
        resources: request.resources,
        issued_at_unix_ms: request.issued_at_unix_ms,
        expires_at_unix_ms: request.expires_at_unix_ms,
        state: DurableResourceLeaseStateV1::Prepared,
        reconciliation_receipt_hash: None,
        row_hash: canonical_hash_v1(&"durable_resource_placeholder_v1")?,
    };
    lease.row_hash = lease_row_hash(&lease)?;
    Ok(lease)
}

fn transitioned(
    current: &DurableResourceLeaseV1,
    state: DurableResourceLeaseStateV1,
    expires_at_unix_ms: u64,
    reconciliation_receipt_hash: Option<Sha256Digest>,
) -> Result<DurableResourceLeaseV1, ControlPlaneError> {
    let mut next = current.clone();
    next.state = state;
    next.expires_at_unix_ms = expires_at_unix_ms;
    next.reconciliation_receipt_hash = reconciliation_receipt_hash;
    next.row_hash = lease_row_hash(&next)?;
    next.validate()?;
    Ok(next)
}

fn lease_row_hash(lease: &DurableResourceLeaseV1) -> Result<Sha256Digest, ControlPlaneError> {
    canonical_hash_v1(&ResourceLeaseHashBodyV1 {
        reservation_id: lease.reservation_id.as_str(),
        owner_id: lease.owner_id.as_str(),
        domain_id: lease.domain_id.as_str(),
        fence_generation: lease.fence_generation,
        fence_token_hash: &lease.fence_token_hash,
        policy_hash: &lease.policy_hash,
        plan_hash: &lease.plan_hash,
        action_hash: &lease.action_hash,
        resources: lease.resources,
        issued_at_unix_ms: lease.issued_at_unix_ms,
        expires_at_unix_ms: lease.expires_at_unix_ms,
        state: lease.state,
        reconciliation_receipt_hash: lease.reconciliation_receipt_hash.as_ref(),
    })
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ResourceLeaseHashBodyV1<'a> {
    reservation_id: &'a str,
    owner_id: &'a str,
    domain_id: &'a str,
    fence_generation: u64,
    fence_token_hash: &'a Sha256Digest,
    policy_hash: &'a Sha256Digest,
    plan_hash: &'a Sha256Digest,
    action_hash: &'a Sha256Digest,
    resources: ResourceVectorV1,
    issued_at_unix_ms: u64,
    expires_at_unix_ms: u64,
    state: DurableResourceLeaseStateV1,
    reconciliation_receipt_hash: Option<&'a Sha256Digest>,
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
    use std::{
        fs,
        process,
        sync::atomic::{AtomicU64, Ordering},
    };

    use super::*;

    static TEST_COUNTER: AtomicU64 = AtomicU64::new(1);

    fn digest(byte: char) -> Sha256Digest {
        format!("sha256:{}", byte.to_string().repeat(64))
            .parse()
            .expect("digest")
    }

    fn test_path(label: &str) -> PathBuf {
        let ordinal = TEST_COUNTER.fetch_add(1, Ordering::Relaxed);
        std::env::temp_dir().join(format!(
            "hepta-resource-ledger-{label}-{}-{ordinal}.jsonl",
            process::id()
        ))
    }

    fn prepare(id: &str, issued: u64, expires: u64) -> DurableResourcePrepareV1 {
        DurableResourcePrepareV1 {
            reservation_id: id.to_owned(),
            owner_id: "worker-a".to_owned(),
            domain_id: "campaign-a".to_owned(),
            fence_generation: 7,
            fence_token_hash: digest('a'),
            policy_hash: digest('b'),
            plan_hash: digest('c'),
            action_hash: digest('d'),
            resources: ResourceVectorV1 {
                cpu_millis: 100,
                memory_bytes: 1024,
                ..ResourceVectorV1::default()
            },
            issued_at_unix_ms: issued,
            expires_at_unix_ms: expires,
        }
    }

    #[test]
    fn expired_finalized_capacity_becomes_uncertain_and_survives_reopen() {
        let path = test_path("uncertain");
        {
            let mut ledger = DurableResourceLeaseLedgerV1::open(&path).expect("open");
            let lease = ledger.prepare(prepare("r1", 10, 20)).expect("prepare");
            ledger
                .finalize("r1", lease.fence_generation, &lease.fence_token_hash, 11)
                .expect("finalize");
            let report = ledger.recover_expired(21).expect("recover");
            assert_eq!(report.finalized_marked_uncertain, vec!["r1"]);
        }
        {
            let ledger = DurableResourceLeaseLedgerV1::open(&path).expect("reopen");
            let active = ledger.active_charges();
            assert_eq!(active.len(), 1);
            assert_eq!(active[0].state, DurableResourceLeaseStateV1::Uncertain);
            ledger.validate_integrity().expect("integrity");
        }
        let _ = fs::remove_file(path);
    }

    #[test]
    fn stale_fence_cannot_renew_or_release() {
        let path = test_path("fence");
        let mut ledger = DurableResourceLeaseLedgerV1::open(&path).expect("open");
        let lease = ledger.prepare(prepare("r2", 10, 30)).expect("prepare");
        ledger
            .finalize("r2", lease.fence_generation, &lease.fence_token_hash, 11)
            .expect("finalize");
        assert_eq!(
            ledger.renew("r2", 6, &lease.fence_token_hash, 12, 40),
            Err(ControlPlaneError::ReservationInvalid)
        );
        assert_eq!(
            ledger.reconcile_and_release("r2", 6, &lease.fence_token_hash, digest('e')),
            Err(ControlPlaneError::ReservationInvalid)
        );
        ledger
            .reconcile_and_release("r2", 7, &lease.fence_token_hash, digest('e'))
            .expect("release");
        assert!(ledger.active_charges().is_empty());
        drop(ledger);
        let _ = fs::remove_file(path);
    }

    #[test]
    fn second_process_handle_cannot_take_the_same_ledger_lock() {
        let path = test_path("lock");
        let ledger = DurableResourceLeaseLedgerV1::open(&path).expect("first");
        assert!(DurableResourceLeaseLedgerV1::open(&path).is_err());
        drop(ledger);
        DurableResourceLeaseLedgerV1::open(&path).expect("after release");
        let _ = fs::remove_file(path);
    }
}
