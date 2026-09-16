//! The state machine never starts from a caller-supplied verified head.
use super::observation::LiveBackupHeadObservationV1;
use super::resident::{ObservedResidentLeaseV1, ResidentLeaseV1};
use super::service::{BackupRecoveryServiceV1, CurrentRestoreSourcesV1};
use super::*;
use crate::sqlite_mutation_coordinator::{
    RecoverabilityEpochFenceV1, SqliteMutationCoordinatorError,
    authority::MutationAuthorityTransportV1,
};
use crate::state_backup_authority::StateBackupAuthorityTransportV1;
#[derive(Clone, Copy)]
pub struct RecoverabilityPolicyV1 {
    pub fresh_snapshot_age_ms: i64,
    pub transient_backoff_ms: i64,
}
impl Default for RecoverabilityPolicyV1 {
    fn default() -> Self {
        Self {
            fresh_snapshot_age_ms: 43_200_000,
            transient_backoff_ms: 900_000,
        }
    }
}
/// Read-only receipt projection. The private constructor requires a freshly
/// verified source/head, a real inventory, a live resident lease and clean state.
#[derive(Debug)]
pub struct RecoverabilityEpochPermitV1 {
    value: Value,
}
impl RecoverabilityEpochPermitV1 {
    pub fn value(&self) -> &Value {
        &self.value
    }
}
struct Evidence {
    sources: CurrentRestoreSourcesV1,
    observation: LiveBackupHeadObservationV1,
    resident: ObservedResidentLeaseV1,
}
pub struct StateRecoverabilityControllerV1<
    B: StateBackupAuthorityTransportV1,
    O: MutationAuthorityTransportV1,
> {
    service: BackupRecoveryServiceV1<B, O>,
    lease: ResidentLeaseV1,
    clock: Box<dyn MutationClockV1>,
    policy: RecoverabilityPolicyV1,
    verified: Option<Value>,
    dirty: Option<Value>,
    requirements: Vec<Value>,
    fatal: Vec<String>,
    evidence: Option<Evidence>,
    last_clock: Option<i64>,
}
fn valid_head(v: &Value) -> bool {
    int(v, "globalSequence").is_ok_and(|n| n >= 0)
        && crate::sqlite_mutation_coordinator::sha(&v["globalHash"])
}
fn suffix(s: &str) -> String {
    format!("autonomous_research_state_recoverability_{s}")
}
fn sorted(mut b: Vec<String>) -> Vec<String> {
    b.sort();
    b.dedup();
    b
}
fn transient(code: &str) -> bool {
    [
        "process_failed",
        "temporarily_unavailable",
        "timeout",
        "timed_out",
        "connection",
        "unavailable",
    ]
    .iter()
    .any(|end| code.ends_with(end))
        || code == "autonomous_research_state_backup_current_head_observation_failed"
}
fn fallback(code: &str) -> bool {
    [
        "autonomous_research_state_restore_journal_range_unbounded",
        "autonomous_research_state_backup_bundle_missing",
        "autonomous_research_state_backup_no_valid_restore_drill_bundle",
    ]
    .contains(&code)
}
fn receipt(mut payload: Value) -> Result<Value> {
    payload["recoverabilityControllerReceiptHash"] = hash(
        "AutonomousResearchStateRecoverabilityControllerReceipt",
        &payload,
    )?
    .into();
    Ok(payload)
}
impl<B: StateBackupAuthorityTransportV1, O: MutationAuthorityTransportV1>
    StateRecoverabilityControllerV1<B, O>
{
    pub fn new(
        service: BackupRecoveryServiceV1<B, O>,
        lease: ResidentLeaseV1,
        clock: Box<dyn MutationClockV1>,
        policy: RecoverabilityPolicyV1,
    ) -> Result<Self> {
        ensure(
            (60_000..=9_007_199_254_740_991).contains(&policy.fresh_snapshot_age_ms)
                && (1000..=9_007_199_254_740_991).contains(&policy.transient_backoff_ms),
            &suffix("controller_configuration_invalid"),
        )?;
        Ok(Self {
            service,
            lease,
            clock,
            policy,
            verified: None,
            dirty: Some(json!({"globalSequence":null,"globalHash":null})),
            requirements: vec![],
            fatal: vec![],
            evidence: None,
            last_clock: None,
        })
    }
    fn now(&mut self) -> Result<(i64, String)> {
        let result = clock_now(self.clock.as_mut())?;
        if self.last_clock.is_some_and(|last| result.0 < last) {
            return Err(self.enter_fatal(vec![suffix("clock_invalid")]));
        }
        self.last_clock = Some(result.0);
        Ok(result)
    }
    fn check_fatal(&self) -> Result<()> {
        if self.fatal.is_empty() {
            Ok(())
        } else {
            Err(self.fatal_error())
        }
    }
    fn fatal_error(&self) -> SqliteMutationCoordinatorError {
        let mut e = error(
            self.fatal
                .first()
                .cloned()
                .unwrap_or_else(|| suffix("fatal")),
        );
        e.state_recoverability_fatal = true;
        e.details =
            json!({"name":"AutonomousResearchStateRecoverabilityFatalError","blockers":self.fatal});
        e
    }
    fn enter_fatal(&mut self, b: Vec<String>) -> SqliteMutationCoordinatorError {
        self.fatal = sorted(b);
        self.evidence = None;
        self.fatal_error()
    }
    fn lease(&mut self) -> Result<ObservedResidentLeaseV1> {
        let now = self.now()?.0;
        self.lease
            .assert_current(now)
            .map_err(|_| self.enter_fatal(vec![suffix("resident_lease_lost")]))
    }
    fn deferred(&mut self, blockers: Vec<String>, mode: &str) -> Result<Value> {
        let (now, iso_now) = self.now()?;
        let next = now
            .checked_add(self.policy.transient_backoff_ms)
            .ok_or_else(|| error(suffix("clock_invalid")))?;
        receipt(
            json!({"version":1,"kind":"AutonomousResearchStateRecoverabilityControllerReceipt","status":"autonomous_research_state_recoverability_deferred","mode":mode,"bundlePath":null,"headSequence":null,"headHash":null,"checkedAt":iso_now,"nextAttemptAt":iso(next)?,"productionStateMutated":false,"blockers":sorted(blockers)}),
        )
    }
    fn failure(&mut self, e: SqliteMutationCoordinatorError, mode: &str) -> Result<Value> {
        if e.state_recoverability_fatal {
            return Err(self.enter_fatal(vec![e.code]));
        }
        if transient(&e.code) || e.state_recoverability_deferred || e.retryable {
            self.deferred(vec![e.code], mode)
        } else {
            Err(self.enter_fatal(vec![e.code]))
        }
    }
    pub fn policy(&self) -> RecoverabilityPolicyV1 {
        self.policy
    }
    pub fn epoch_status(&self) -> Value {
        json!({"version":1,"kind":"AutonomousResearchStateRecoverabilityEpochStatus","status":if !self.fatal.is_empty(){"autonomous_research_state_recoverability_epoch_fatal"}else if self.verified.is_none()||self.dirty.is_some()||!self.requirements.is_empty(){"autonomous_research_state_recoverability_epoch_dirty"}else{"autonomous_research_state_recoverability_epoch_current"},"verifiedHead":self.verified,"dirtyHead":self.dirty,"reconciliationRequirements":self.requirements,"blockers":self.fatal})
    }
    pub fn mark_finalized(&mut self, head: &Value) -> Result<Value> {
        self.check_fatal()?;
        let candidate = json!({"globalSequence":int(head,"globalSequence").ok(),"globalHash":head["globalHash"]});
        if !valid_head(&candidate) {
            return Err(self.enter_fatal(vec![suffix("finalized_head_invalid")]));
        }
        let previous = self
            .dirty
            .as_ref()
            .filter(|h| !h["globalSequence"].is_null())
            .or(self.verified.as_ref());
        if let Some(previous) = previous {
            let n = int(&candidate, "globalSequence")?;
            let p = int(previous, "globalSequence")?;
            if n < p || (n == p && candidate["globalHash"] != previous["globalHash"]) {
                return Err(self.enter_fatal(vec![suffix("finalized_head_conflict")]));
            }
        }
        self.dirty = if self.verified.as_ref() == Some(&candidate) {
            None
        } else {
            Some(candidate)
        };
        Ok(
            json!({"version":1,"kind":"AutonomousResearchStateRecoverabilityEpochStatus","status":if self.dirty.is_some(){"autonomous_research_state_recoverability_epoch_dirty"}else{"autonomous_research_state_recoverability_epoch_current"},"verifiedHead":self.verified,"dirtyHead":self.dirty}),
        )
    }
    pub fn require_reconciliation(&mut self, input: &Value) -> Result<Value> {
        self.check_fatal()?;
        let nonempty = |k: &str| input[k].as_str().is_some_and(|v| !v.is_empty());
        let optional = |k: &str| {
            input
                .get(k)
                .is_none_or(|v| v.is_null() || v.as_str().is_some_and(|s| !s.is_empty()))
        };
        let committed = input.get("committed").cloned().unwrap_or(json!(false));
        if !nonempty("reason")
            || input["reason"]
                .as_str()
                .is_none_or(|s| s.encode_utf16().count() > 191)
            || !nonempty("databaseRole")
            || !nonempty("databaseInstanceId")
            || !optional("reservationId")
            || !optional("mutationAttemptId")
            || ![json!(false), json!(true), json!("unknown")].contains(&committed)
        {
            return Err(self.enter_fatal(vec![suffix("reconciliation_requirement_invalid")]));
        }
        let requirement = json!({"reason":input["reason"],"databaseRole":input["databaseRole"],"databaseInstanceId":input["databaseInstanceId"],"reservationId":input.get("reservationId").cloned().unwrap_or(Value::Null),"mutationAttemptId":input.get("mutationAttemptId").cloned().unwrap_or(Value::Null),"committed":committed});
        if !self.requirements.contains(&requirement) {
            if self.requirements.len() >= 4096 {
                return Err(
                    self.enter_fatal(vec![suffix("reconciliation_requirement_limit_exceeded")])
                );
            }
            self.requirements.push(requirement);
        }
        Ok(
            json!({"version":1,"kind":"AutonomousResearchStateRecoverabilityEpochStatus","status":"autonomous_research_state_recoverability_reconciliation_required","verifiedHead":self.verified,"dirtyHead":self.dirty,"reconciliationRequirements":self.requirements}),
        )
    }
    pub fn assert_for_action(&mut self, action: &str) -> Result<RecoverabilityEpochPermitV1> {
        self.check_fatal()?;
        if action.is_empty() || action.encode_utf16().count() > 191 {
            return Err(self.enter_fatal(vec![suffix("fence_action_invalid")]));
        }
        if self.verified.is_none()
            || self.dirty.is_some()
            || !self.requirements.is_empty()
            || self.evidence.is_none()
        {
            let mut e = error(suffix("epoch_reconciliation_required"));
            e.state_recoverability_deferred = true;
            e.retryable = true;
            e.details = json!({"name":"AutonomousResearchStateRecoverabilityDeferredError","action":action,"verifiedHead":self.verified,"dirtyHead":self.dirty,"reconciliationRequirements":self.requirements,"blockers":[e.code]});
            return Err(e);
        }
        let now = self.now()?.0;
        let checked = self
            .evidence
            .as_ref()
            .ok_or_else(|| error(suffix("epoch_reconciliation_required")))
            .and_then(|e| {
                e.sources.assert_current(now)?;
                e.resident.assert_current(now)?;
                self.service.assert_observation(&e.observation, now)?;
                e.observation
                    .assert_current(&e.sources.source, e.sources.inventory.value(), now, 0)
            });
        if let Err(e) = checked {
            let mut failure = e;
            failure.state_recoverability_deferred = true;
            failure.retryable = true;
            self.dirty = Some(json!({"globalSequence":null,"globalHash":null}));
            self.evidence = None;
            return Err(failure);
        }
        // The resident row is observed anew to cover heartbeat/replacement changes;
        // the held prior observation also forbids unnoticed changes since reconcile.
        let resident = self.lease()?;
        let completed = self.now()?.0;
        resident
            .assert_valid_at(completed)
            .map_err(|_| self.enter_fatal(vec![suffix("resident_lease_lost")]))?;
        let current = self
            .evidence
            .as_ref()
            .ok_or_else(|| error(suffix("epoch_reconciliation_required")))?
            .observation
            .assert_valid_at(completed, 0);
        if let Err(mut e) = current {
            e.state_recoverability_deferred = true;
            e.retryable = true;
            self.dirty = Some(json!({"globalSequence":null,"globalHash":null}));
            self.evidence = None;
            return Err(e);
        }
        let head = self
            .verified
            .as_ref()
            .ok_or_else(|| error(suffix("epoch_reconciliation_required")))?;
        Ok(RecoverabilityEpochPermitV1 {
            value: json!({"version":1,"kind":"AutonomousResearchStateRecoverabilityEpochPermit","status":"autonomous_research_state_recoverability_epoch_current","action":action,"globalSequence":head["globalSequence"],"globalHash":head["globalHash"]}),
        })
    }
    fn ready(
        &mut self,
        mode: &str,
        sources: CurrentRestoreSourcesV1,
        observation: LiveBackupHeadObservationV1,
        required: i64,
    ) -> Result<Value> {
        let resident = self.lease()?;
        let now = self.now()?;
        sources.assert_current(now.0)?;
        observation.assert_current(&sources.source, sources.inventory.value(), now.0, required)?;
        let s = sources.source.inspection();
        let live = &observation.value()["authorityCurrentHeadReceipt"];
        let source_sequence = int(s, "headSequence")?;
        let live_sequence = int(live, "headSequence")?;
        if live_sequence < source_sequence
            || (live_sequence == source_sequence && live["headHash"] != s["headHash"])
        {
            return Err(self.enter_fatal(vec![suffix("authority_rollback_or_equivocation")]));
        }
        if live_sequence > source_sequence {
            return self.deferred(
                vec![suffix("finalized_head_not_covered")],
                "concurrent-finalization",
            );
        }
        self.service.assert_observation(&observation, now.0)?;
        let candidate = json!({"globalSequence":s["headSequence"],"globalHash":s["headHash"]});
        if !valid_head(&candidate) {
            return Err(self.enter_fatal(vec![suffix("verified_head_invalid")]));
        }
        let seq = int(&candidate, "globalSequence")?;
        if let Some(dirty) = self
            .dirty
            .as_ref()
            .filter(|h| !h["globalSequence"].is_null())
        {
            let d = int(dirty, "globalSequence")?;
            if seq < d {
                return self.deferred(
                    vec![suffix("finalized_head_not_covered")],
                    "concurrent-finalization",
                );
            }
            if seq == d && candidate["globalHash"] != dirty["globalHash"] {
                return Err(self.enter_fatal(vec![suffix("finalized_head_conflict")]));
            }
        }
        if let Some(v) = &self.verified {
            let previous = int(v, "globalSequence")?;
            if seq < previous || (seq == previous && v["globalHash"] != candidate["globalHash"]) {
                return Err(self.enter_fatal(vec![suffix("verified_head_rollback")]));
            }
        }
        // Take the authorization clock sample after every file, SQLite and
        // signature operation. These final validity checks are memory-only.
        let completed = self.now()?;
        resident
            .assert_valid_at(completed.0)
            .map_err(|_| self.enter_fatal(vec![suffix("resident_lease_lost")]))?;
        observation
            .assert_valid_at(completed.0, required)
            .map_err(|_| self.enter_fatal(vec![suffix("observation_validity_insufficient")]))?;
        let result = receipt(
            json!({"version":1,"kind":"AutonomousResearchStateRecoverabilityControllerReceipt","status":"autonomous_research_state_recoverability_ready","mode":mode,"bundlePath":s["bundlePath"],"headSequence":s["headSequence"],"headHash":s["headHash"],"restoreDrillReceiptHash":s["restoreDrillReceiptHash"],"recoverabilityBindingHash":s.get("recoverabilityBindingHash").cloned().unwrap_or(Value::Null),"checkedAt":completed.1,"nextAttemptAt":null,"productionStateMutated":false,"blockers":[]}),
        )?;
        self.verified = Some(candidate);
        self.dirty = None;
        self.evidence = Some(Evidence {
            sources,
            observation,
            resident,
        });
        Ok(result)
    }
    fn recovered(&mut self, heads: &Value) -> Result<()> {
        let mut heads = heads
            .as_array()
            .ok_or_else(|| error(suffix("pending_reconciliation_invalid")))?
            .iter()
            .map(|head| int(head, "globalSequence").map(|sequence| (sequence, head)))
            .collect::<Result<Vec<_>>>()?;
        heads.sort_by_key(|(sequence, _)| *sequence);
        for (_, head) in heads {
            self.mark_finalized(head)?;
        }
        Ok(())
    }
    fn renew(&mut self, required: i64) -> Result<Value> {
        self.lease()?;
        let renewed = self.service.renew_evidence(self.clock.as_mut());
        self.lease()?;
        let renewal = match renewed {
            Ok(r) => r,
            Err(e) => return self.failure(e, "fresh-snapshot-renewal"),
        };
        self.recovered(&renewal.recovered_heads)?;
        let observed = self.service.observe(&renewal.sources, self.clock.as_mut());
        let observation = match observed {
            Ok(r) => r,
            Err(e) => return self.failure(e, "current-head-observation"),
        };
        self.ready(
            "fresh-snapshot-renewed",
            renewal.sources,
            observation,
            required,
        )
    }
    pub fn reconcile_with_validity(&mut self, required: i64) -> Result<Value> {
        self.check_fatal()?;
        if !(0..=9_007_199_254_740_991).contains(&required) {
            return Err(self.enter_fatal(vec![suffix("required_validity_invalid")]));
        }
        self.lease()?;
        if !self.requirements.is_empty() {
            let pending = self.service.reconcile_pending(self.clock.as_mut());
            self.lease()?;
            match pending {
                Ok(r) => {
                    self.recovered(&r.value()["recovery"]["finalizedHeads"])?;
                    self.requirements.clear();
                }
                Err(e) => return self.failure(e, "pending-reconciliation"),
            }
        }
        let now = self.now()?.0;
        let sources = match self.service.sources(now) {
            Ok(s) => s,
            Err(e) if fallback(&e.code) => return self.renew(required),
            Err(e) => return self.failure(e, "source-inspection"),
        };
        let created = timestamp(&sources.source.inspection()["snapshotCreatedAt"]);
        if created.is_none_or(|t| now.saturating_sub(t) >= self.policy.fresh_snapshot_age_ms) {
            return self.renew(required);
        }
        let observation = self.service.observe(&sources, self.clock.as_mut());
        self.lease()?;
        let observation = match observation {
            Ok(v) => v,
            Err(e) => return self.failure(e, "current-head-observation"),
        };
        let head = &observation.value()["authorityCurrentHeadReceipt"];
        let live = int(head, "headSequence")?;
        let source = int(sources.source.inspection(), "headSequence")?;
        let expires = timestamp(&head["expiresAt"]);
        let now = self.now()?.0;
        if expires.is_none_or(|e| e <= now || e.saturating_sub(now) < required) {
            return Err(self.enter_fatal(vec![suffix("observation_validity_insufficient")]));
        }
        if live < source
            || (live == source && head["headHash"] != sources.source.inspection()["headHash"])
        {
            return Err(self.enter_fatal(vec![suffix("authority_rollback_or_equivocation")]));
        }
        if live == source {
            return self.ready("current", sources, observation, required);
        }
        self.lease()?;
        let drill = self.service.drill_selected(&sources, self.clock.as_mut());
        self.lease()?;
        let next = match drill {
            Ok(s) => s,
            Err(e) if fallback(&e.code) => return self.renew(required),
            Err(e) => return self.failure(e, "journal-restore-drill"),
        };
        if next.source.inspection()["bundlePath"] != sources.source.inspection()["bundlePath"]
            || next.source.inspection()["headSequence"] != head["headSequence"]
            || next.source.inspection()["headHash"] != head["headHash"]
        {
            return Err(self.enter_fatal(vec![suffix("journal_publish_invalid")]));
        }
        // Publishing a drill changes the source binding. Obtain a new signed live
        // observation for that exact source before constructing the new epoch.
        let current = self.service.observe(&next, self.clock.as_mut());
        let current = match current {
            Ok(v) => v,
            Err(e) => return self.failure(e, "current-head-observation"),
        };
        self.ready("journal-renewed", next, current, required)
    }
}
impl<B: StateBackupAuthorityTransportV1, O: MutationAuthorityTransportV1> RecoverabilityEpochFenceV1
    for StateRecoverabilityControllerV1<B, O>
{
    fn mark_mutation_finalized(&mut self, head: &Value) -> Result<()> {
        self.mark_finalized(head).map(|_| ())
    }
    fn mark_mutation_reconciliation_required(&mut self, input: &Value) -> Result<()> {
        self.require_reconciliation(input).map(|_| ())
    }
    fn assert_current(&mut self) -> Result<Value> {
        self.assert_for_action("sqlite_online_mutation")
            .map(|v| v.value)
    }
    fn reconcile(&mut self) -> Result<Value> {
        self.reconcile_with_validity(0)
    }
}
