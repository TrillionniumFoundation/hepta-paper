//! Terminal time boundary for the retained opaque producers. This is not a
//! public JSON-based permission check, and never replaces their full checks.
use super::*;
use crate::sqlite_mutation_coordinator::{contracts::live, timestamp};

impl PreparedInitialOnlineMutationCompositionV1 {
    pub(super) fn assert_valid_at(&self, now: i64) -> Result<()> {
        self.assert_evidence_valid_at(now)?;
        // Also binds origin/generation, resident expiry and restore-source age.
        // No filesystem, SQLite, RPC or signature I/O follows the shared sample.
        self.fence
            .assert_activation_binding_time(&self.fence_binding, now)
    }
    pub(super) fn assert_evidence_valid_at(&self, now: i64) -> Result<()> {
        transaction::NativeTransactionEvidenceV1::from(self).assert_evidence_valid_at(now)
    }
}
impl transaction::NativeTransactionEvidenceV1<'_> {
    pub(super) fn assert_evidence_valid_at(&self, now: i64) -> Result<()> {
        if now < self.checked_at.get() {
            return Err(fail("clock_invalid"));
        }
        let trust = self.verifier.trust();
        if !live(self.schema.value(), trust, "observedAt", now) {
            return Err(fail("schema_evidence_expired"));
        }
        for (_, _, proof) in self.startup.database_reconciliations() {
            proof.assert_confirmation_valid_at(trust, now)?;
        }
        let active = &self.active.value()["authorityEvidence"];
        for (kind, field) in [
            ("currentHead", "observedAt"),
            ("activeChallenge", "challengedAt"),
            ("brokerScope", "observedAt"),
        ] {
            if !live(&active[kind]["receipt"], trust, field, now) {
                return Err(fail("active_evidence_expired"));
            }
        }
        for head in self.finalized.database_inspections() {
            if !live(head.current_head(), trust, "observedAt", now) {
                return Err(fail("finalized_evidence_expired"));
            }
        }
        let inspection = self.inspection.value();
        for (receipt, field) in [
            (&inspection["currentHeadReceipt"], "observedAt"),
            (&inspection["activeChallengeReceipt"], "challengedAt"),
            (
                &inspection["writerCoverage"]["brokerScopeReceipt"],
                "observedAt",
            ),
        ] {
            if !live(receipt, trust, field, now) {
                return Err(fail("inspection_evidence_expired"));
            }
        }
        if timestamp(&self.cache.value()["expiresAt"]).is_none_or(|end| now >= end) {
            return Err(fail("cache_evidence_expired"));
        }
        Ok(())
    }
}
