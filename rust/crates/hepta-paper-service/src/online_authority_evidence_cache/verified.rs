//! A cache write is never sufficient to recover an active capability. This
//! narrow type requires the original verified evidence again at every use.
use super::*;
use crate::{
    online_runtime_activation::active_refresh::VerifiedActiveAuthorityEvidenceV1,
    online_writer_static::VerifiedWriterStaticCoverageV1,
    sqlite_mutation_coordinator::{
        authority::{MutationAuthorityTransportV1, PinnedMutationAuthorityV1},
        clock::MutationClockV1,
    },
    state_database_inventory::ObservedStateDatabaseInventoryV1,
};
use std::path::PathBuf;
#[allow(dead_code)] // Retained local inputs; the admitted transaction is separate.
mod retained;
#[allow(unused_imports)]
pub(crate) use retained::RetainedVerifiedAuthorityCacheV1;
pub struct VerifiedAuthorityCacheWriteV1 {
    receipt: Value,
    root: PathBuf,
    authority_configuration_hash: String,
    evidence_hash: String,
}
fn expires(evidence: &VerifiedActiveAuthorityEvidenceV1) -> Result<i64> {
    ["currentHead", "activeChallenge", "brokerScope"]
        .iter()
        .map(|kind| {
            timestamp(&evidence.value()["authorityEvidence"][kind]["receipt"]["expiresAt"])
                .ok_or_else(|| failure("verified_evidence_invalid"))
        })
        .collect::<Result<Vec<_>>>()?
        .into_iter()
        .min()
        .ok_or_else(|| failure("verified_evidence_invalid"))
}
fn current_time<T: MutationAuthorityTransportV1>(
    authority: &PinnedMutationAuthorityV1<T>,
    evidence: &VerifiedActiveAuthorityEvidenceV1,
    now: i64,
) -> Result<()> {
    let maximum_age =
        crate::sqlite_mutation_coordinator::int(authority.trust(), "maximumObservationAgeMs")?;
    if now >= expires(evidence)?
        || [
            ("currentHead", "observedAt"),
            ("activeChallenge", "challengedAt"),
            ("brokerScope", "observedAt"),
        ]
        .iter()
        .any(|(kind, field)| {
            timestamp(&evidence.value()["authorityEvidence"][kind]["receipt"][field])
                .is_none_or(|observed| now.saturating_sub(observed) > maximum_age)
        })
    {
        return Err(failure("verified_evidence_expired"));
    }
    Ok(())
}
impl VerifiedAuthorityCacheWriteV1 {
    pub fn value(&self) -> &Value {
        &self.receipt
    }
    pub fn assert_current<T: MutationAuthorityTransportV1>(
        &self,
        authority: &PinnedMutationAuthorityV1<T>,
        evidence: &VerifiedActiveAuthorityEvidenceV1,
        inventory: &ObservedStateDatabaseInventoryV1,
        source: &VerifiedWriterStaticCoverageV1,
        clock: &mut dyn MutationClockV1,
    ) -> Result<()> {
        inventory.assert_current()?;
        if inventory.runtime_root() != self.root
            || self.authority_configuration_hash != authority.configuration_hash()
            || self.evidence_hash != evidence.receipt_hash()?
        {
            return Err(failure("verified_evidence_subject_changed"));
        }
        let observed = read_passive_authority_evidence_cache_v1(
            &self.root,
            Some(text(inventory.value(), "databaseScopeHash")?),
            Some(text(authority.trust(), "writerManifestHash")?),
            None,
        )?;
        if observed["cacheHash"] != self.receipt["cacheHash"]
            || observed["activeRefreshReceiptHash"] != self.evidence_hash
        {
            return Err(failure("verified_cache_changed"));
        }
        let before = clock.now_millis()?;
        evidence.assert_current(authority, inventory.value(), source, before)?;
        let after = clock.now_millis()?;
        if after < before
            || after >= expires(evidence)?
            || timestamp(&self.receipt["expiresAt"]).is_none_or(|t| after >= t)
        {
            return Err(failure("verified_evidence_expired"));
        }
        current_time(authority, evidence, after)?;
        Ok(())
    }
}
/// Requires actual current inventory, complete source scan and all three signed
/// authority receipts. Reading cached JSON cannot reconstruct this private type.
pub fn record_verified_authority_evidence_cache_v1<T: MutationAuthorityTransportV1>(
    root: &Path,
    authority: &PinnedMutationAuthorityV1<T>,
    evidence: &VerifiedActiveAuthorityEvidenceV1,
    inventory: &ObservedStateDatabaseInventoryV1,
    source: &VerifiedWriterStaticCoverageV1,
    clock: &mut dyn MutationClockV1,
) -> Result<VerifiedAuthorityCacheWriteV1> {
    inventory.assert_current()?;
    if root != inventory.runtime_root() {
        return Err(failure("verified_evidence_subject_changed"));
    }
    let before = clock.now_millis()?;
    evidence.assert_current(authority, inventory.value(), source, before)?;
    let expiry = expires(evidence)?;
    let checked = clock.now_millis()?;
    if checked < before || checked >= expiry {
        return Err(failure("verified_evidence_expired"));
    }
    current_time(authority, evidence, checked)?;
    let receipt = record_passive_authority_evidence_cache_v1(
        root,
        evidence.value(),
        text(inventory.value(), "databaseScopeHash")?,
        text(authority.trust(), "writerManifestHash")?,
        &crate::sqlite_mutation_coordinator::clock::iso(expiry)?,
    )?;
    let written = VerifiedAuthorityCacheWriteV1 {
        receipt,
        root: root.into(),
        authority_configuration_hash: authority.configuration_hash().into(),
        evidence_hash: evidence.receipt_hash()?,
    };
    written.assert_current(authority, evidence, inventory, source, clock)?;
    let after = clock.now_millis()?;
    if after < checked || after >= expiry {
        return Err(failure("verified_evidence_expired"));
    }
    current_time(authority, evidence, after)?;
    Ok(written)
}
