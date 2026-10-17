//! Original fixed operations over SQLite BEGIN IMMEDIATE/COMMIT. Failed or
//! unknown commits retain their journal; no cleanup deletes a durable marker.
use super::{
    record::{self, EVENT_HASH, RECEIPT_HASH, RESERVATION_HASH},
    *,
};
use rusqlite::{Connection, TransactionBehavior, params};

fn value_text(value: &Json, key: &str) -> Result<String, String> {
    text(field(value, key)).ok_or_else(|| "campaign_one_shot_attempt_journal_record_invalid".into())
}
fn canonical_text(value: &Json, control: &ReconciliationReadControlV1) -> Result<String, String> {
    String::from_utf8(canonical_bytes(value, 1024 * 1024, &control.cancelled)?)
        .map_err(|e| e.to_string())
}
fn events(report: &Json) -> Result<&[Json], String> {
    match field(report, "events") {
        Json::Array(values) => Ok(values),
        _ => Err("campaign_one_shot_attempt_journal_event_sequence_invalid".into()),
    }
}
fn head(report: &Json) -> Result<&Json, String> {
    events(report)?
        .last()
        .ok_or_else(|| "campaign_one_shot_attempt_journal_event_sequence_invalid".into())
}
fn current_report(
    connection: &Connection,
    attempt: &str,
    control: &ReconciliationReadControlV1,
) -> Result<Json, String> {
    let report = super::super::journal::inspect_connection(connection, attempt, control)?;
    record::reservation(field(&report, "reservation"), &control.cancelled)?;
    Ok(report)
}
enum RequestedRecord {
    Reservation,
    Event,
    Receipt,
}
struct Intent {
    kind: RequestedRecord,
    record: Json,
    newly_appended: bool,
}
fn insert_event(
    connection: &Connection,
    event: &Json,
    control: &ReconciliationReadControlV1,
) -> Result<(), String> {
    let previous = text(field(event, "previousEventHash"));
    let sequence = match field(event, "sequence") {
        Json::Number(value) => *value as u8,
        _ => return Err("campaign_one_shot_attempt_journal_event_insert_failed".into()),
    };
    let changed=connection.execute(
        "INSERT INTO campaign_one_shot_attempt_events(event_id,attempt_id,sequence,phase,previous_event_hash,event_hash,event_json,recorded_at) VALUES(?1,?2,?3,?4,?5,?6,?7,?8)",
        params![value_text(event,"eventId")?,value_text(event,"attemptId")?,sequence,value_text(event,"phase")?,
            previous,value_text(event,EVENT_HASH)?,canonical_text(event,control)?,value_text(event,"recordedAt")?])
        .map_err(|e|control.map_database(e).to_string())?;
    if changed != 1 {
        return Err("campaign_one_shot_attempt_journal_event_insert_failed".into());
    }
    Ok(())
}
fn compare_head(
    report: &Json,
    sequence: u8,
    phase: &str,
    previous: &str,
    code: &str,
) -> Result<(), String> {
    let selected = head(report)?;
    if !number(field(selected, "sequence"), f64::from(sequence) - 1.0)
        || !is_text(field(selected, "phase"), phase)
        || !is_text(field(selected, EVENT_HASH), previous)
    {
        return Err(code.into());
    }
    Ok(())
}
fn verify_requested(
    report: &Json,
    intent: &Intent,
    control: &ReconciliationReadControlV1,
) -> Result<(), String> {
    let observed = match intent.kind {
        RequestedRecord::Reservation => field(report, "reservation"),
        RequestedRecord::Receipt => field(report, "terminalReceipt"),
        RequestedRecord::Event => events(report)?
            .iter()
            .find(|v| scalar_eq(field(v, "sequence"), field(&intent.record, "sequence")))
            .ok_or("campaign_one_shot_attempt_journal_event_missing")?,
    };
    if !same_json(observed, &intent.record, &control.cancelled) {
        return Err("campaign_one_shot_attempt_journal_post_commit_verification_failed".into());
    }
    if matches!(intent.kind, RequestedRecord::Event)
        && matches!(
            text(field(&intent.record, "phase")).as_deref(),
            Some("provider_started" | "launch_started")
        )
        && (!scalar_eq(
            field(report, "headEventHash"),
            field(&intent.record, EVENT_HASH),
        ) || !matches!(field(report, "terminalReceipt"), Json::Null))
    {
        return Err("campaign_one_shot_attempt_journal_post_commit_marker_not_current".into());
    }
    Ok(())
}
impl OneShotJournalV1<'_> {
    pub(super) fn provision(&mut self, created_at: &str) -> Result<(), String> {
        if self.epoch.len() != 0 {
            // A foreign/nonempty schema is audited before any writable PRAGMA.
            let connection = self.open_connection(false)?;
            super::super::journal::schema(&connection, &self.control)?;
            drop(connection);
            return self.assert_current();
        }
        let mut connection = self.open_connection(true)?;
        let transaction = connection
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(|e| self.control.map_database(e).to_string())?;
        self.assert_current()?;
        let objects: i64 = transaction
            .query_row(
                "SELECT count(*) FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%'",
                [],
                |row| row.get(0),
            )
            .map_err(|e| e.to_string())?;
        if objects != 0 {
            return Err("campaign_one_shot_attempt_journal_schema_invalid".into());
        }
        let c = contract::contract()?;
        for statement in c["schemaStatements"]
            .as_array()
            .ok_or("one_shot_mutation_contract_invalid")?
        {
            self.control.checkpoint().map_err(|e| e.to_string())?;
            transaction
                .execute_batch(
                    statement
                        .as_str()
                        .ok_or("one_shot_mutation_contract_invalid")?,
                )
                .map_err(|e| self.control.map_database(e).to_string())?;
        }
        let schema_hash = super::super::journal::schema_hash(&transaction, &self.control)?;
        transaction.execute(
            "INSERT INTO campaign_one_shot_attempt_journal_metadata(singleton,schema_version,schema_contract_id,schema_contract_hash,sqlite_schema_hash,created_at) VALUES(1,1,?1,?2,?3,?4)",
            params![c["schemaContractId"].as_str().ok_or("one_shot_mutation_contract_invalid")?,
                c["schemaContractHash"].as_str().ok_or("one_shot_mutation_contract_invalid")?,schema_hash,created_at])
            .map_err(|e|self.control.map_database(e).to_string())?;
        super::super::journal::schema(&transaction, &self.control)?;
        self.control.checkpoint().map_err(|e| e.to_string())?;
        self.assert_identity()?;
        transaction
            .commit()
            .map_err(|e| self.control.map_database(e).to_string())?;
        drop(connection);
        self.sidecars_absent()?;
        let observed = self.open_connection(false)?;
        super::super::journal::schema(&observed, &self.control)?;
        drop(observed);
        self.accept_own_mutation()
    }
    fn mutate(
        &mut self,
        attempt: &str,
        callback: impl FnOnce(&Connection, &ReconciliationReadControlV1) -> Result<Intent, String>,
    ) -> Result<OneShotJournalMutationV1, String> {
        self.assert_current()?;
        let result = self.mutate_inner(attempt, callback);
        if result.is_err() {
            self.poisoned.set(true);
        }
        result
    }
    fn mutate_inner(
        &mut self,
        attempt: &str,
        callback: impl FnOnce(&Connection, &ReconciliationReadControlV1) -> Result<Intent, String>,
    ) -> Result<OneShotJournalMutationV1, String> {
        let mut connection = self.open_connection(true)?;
        let transaction = connection
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(|e| self.control.map_database(e).to_string())?;
        // Recheck the original captured epoch under the actual SQLite writer
        // exclusion, then audit the original fixed trigger/schema set.
        self.assert_current()?;
        super::super::journal::schema(&transaction, &self.control)?;
        let intent = callback(&transaction, &self.control)?;
        self.control.checkpoint().map_err(|e| e.to_string())?;
        self.assert_identity()?;
        #[cfg(test)]
        self.process_interruption(true)?;
        #[cfg(test)]
        self.failure_point(FailurePoint::BeforeCommit)?;
        let acknowledged = transaction.commit().is_ok();
        drop(connection);
        #[cfg(test)]
        self.process_interruption(false)?;
        #[cfg(test)]
        let acknowledged = acknowledged && !self.take_failure_point(FailurePoint::AfterCommitLoss);
        self.sidecars_absent()?;
        let observed = self.open_connection(false)?;
        super::super::journal::schema(&observed, &self.control)?;
        let report = current_report(&observed, attempt, &self.control)?;
        verify_requested(&report, &intent, &self.control)?;
        drop(observed);
        self.accept_own_mutation()?;
        // Even a durable independently verified uncertain commit has no
        // acknowledgment for a new external action. Reopening loses this call.
        let marker = if matches!(intent.kind, RequestedRecord::Event)
            && intent.newly_appended
            && acknowledged
        {
            marker::CommittedMarkerV1::from_committed_event(&intent.record)?
        } else {
            None
        };
        Ok(OneShotJournalMutationV1 {
            inspection: report,
            newly_appended: intent.newly_appended,
            commit_acknowledged: acknowledged,
            owner: Arc::clone(&self.owner),
            marker,
        })
    }
    pub(super) fn reserve_inner(
        &mut self,
        reservation: &Json,
    ) -> Result<OneShotJournalMutationV1, String> {
        let attempt = value_text(reservation, "attemptId")?;
        self.mutate(&attempt,|connection,control|{
            match current_report(connection,&attempt,control) {
                Ok(existing)=>{
                    if !same_json(field(&existing,"reservation"),reservation,&control.cancelled) {
                        return Err("campaign_one_shot_attempt_journal_reservation_conflict".into());
                    }
                    return Ok(Intent{kind:RequestedRecord::Reservation,record:reservation.clone(),newly_appended:false});
                },
                Err(e) if e=="autonomous_research_one_shot_attempt_missing"=>{},
                Err(e)=>return Err(e),
            }
            let changed=connection.execute(
                "INSERT INTO campaign_one_shot_attempts(attempt_id,idempotency_key,campaign_id,protected_campaign_id,execution_binding_hash,reservation_hash,reservation_json,reserved_at) VALUES(?1,?2,?3,?4,?5,?6,?7,?8)",
                params![attempt,value_text(reservation,"idempotencyKey")?,value_text(reservation,"campaignId")?,
                    value_text(reservation,"protectedCampaignId")?,value_text(reservation,"executionBindingHash")?,
                    value_text(reservation,RESERVATION_HASH)?,canonical_text(reservation,control)?,value_text(reservation,"reservedAt")?])
                .map_err(|e|control.map_database(e).to_string())?;
            if changed!=1 {return Err("campaign_one_shot_attempt_journal_reservation_insert_failed".into());}
            let initial=record::event(reservation,None,"attempt_reserved",
                &object([("reservationHash",field(reservation,RESERVATION_HASH).clone())]),None,
                &value_text(reservation,"reservedAt")?,&control.cancelled)?;
            insert_event(connection,&initial,control)?;
            Ok(Intent{kind:RequestedRecord::Reservation,record:reservation.clone(),newly_appended:true})
        })
    }
    pub(super) fn append_inner(
        &mut self,
        request: OneShotAppendRequestV1<'_>,
    ) -> Result<OneShotJournalMutationV1, String> {
        validate_compare(
            request.attempt_id,
            request.expected_sequence,
            request.expected_phase,
            request.expected_previous_event_hash,
        )?;
        if matches!(request.phase, "attempt_reserved" | "terminal") {
            return Err("campaign_one_shot_attempt_journal_append_invalid".into());
        }
        canonical_bytes(request.evidence, 128 * 1024, &self.control.cancelled)?;
        self.mutate(request.attempt_id, |connection, control| {
            let report = current_report(connection, request.attempt_id, control)?;
            if !matches!(field(&report, "terminalReceipt"), Json::Null) {
                return Err("campaign_one_shot_attempt_journal_attempt_terminal".into());
            }
            if let Some(existing) = events(&report)?.iter().find(|v| {
                number(field(v, "sequence"), f64::from(request.expected_sequence))
                    || request
                        .event_id
                        .is_some_and(|id| is_text(field(v, "eventId"), id))
            }) {
                let previous = events(&report)?
                    .get(usize::from(request.expected_sequence) - 2)
                    .ok_or("campaign_one_shot_attempt_journal_event_conflict")?;
                if !number(
                    field(existing, "sequence"),
                    f64::from(request.expected_sequence),
                ) || !is_text(field(existing, "phase"), request.phase)
                    || request.event_id.is_some_and(|id| {
                        !id.is_empty() && !is_text(field(existing, "eventId"), id)
                    })
                    || !is_text(field(previous, "phase"), request.expected_phase)
                    || !is_text(
                        field(previous, EVENT_HASH),
                        request.expected_previous_event_hash,
                    )
                    || !same_json(
                        field(existing, "evidence"),
                        request.evidence,
                        &control.cancelled,
                    )
                    || !is_text(field(existing, "recordedAt"), request.recorded_at)
                {
                    return Err("campaign_one_shot_attempt_journal_event_conflict".into());
                }
                return Ok(Intent {
                    kind: RequestedRecord::Event,
                    record: existing.clone(),
                    newly_appended: false,
                });
            }
            compare_head(
                &report,
                request.expected_sequence,
                request.expected_phase,
                request.expected_previous_event_hash,
                "campaign_one_shot_attempt_journal_event_compare_and_append_failed",
            )?;
            let event = record::event(
                field(&report, "reservation"),
                Some(head(&report)?),
                request.phase,
                request.evidence,
                request.event_id,
                request.recorded_at,
                &control.cancelled,
            )?;
            insert_event(connection, &event, control)?;
            Ok(Intent {
                kind: RequestedRecord::Event,
                record: event,
                newly_appended: true,
            })
        })
    }
    pub(super) fn finalize_inner(
        &mut self,
        request: OneShotFinalizeRequestV1<'_>,
    ) -> Result<OneShotJournalMutationV1, String> {
        validate_compare(
            request.attempt_id,
            request.expected_sequence,
            request.expected_phase,
            request.expected_previous_event_hash,
        )?;
        canonical_bytes(request.outcome, 128 * 1024, &self.control.cancelled)?;
        self.mutate(request.attempt_id,|connection,control|{
            let report=current_report(connection,request.attempt_id,control)?;
            if !matches!(field(&report,"terminalReceipt"),Json::Null) {
                let previous=events(&report)?.get(events(&report)?.len().checked_sub(2)
                    .ok_or("campaign_one_shot_attempt_journal_terminal_conflict")?)
                    .ok_or("campaign_one_shot_attempt_journal_terminal_conflict")?;
                let existing=field(&report,"terminalReceipt");
                let terminal=head(&report)?;
                if !number(field(head(&report)?,"sequence"),f64::from(request.expected_sequence))
                    || !is_text(field(previous,"phase"),request.expected_phase)
                    || !is_text(field(previous,EVENT_HASH),request.expected_previous_event_hash)
                    || !is_text(field(existing,"terminalStatus"),request.terminal_status)
                    || !same_json(field(existing,"outcome"),request.outcome,&control.cancelled)
                    || !is_text(field(existing,"completedAt"),request.completed_at)
                    || request.event_id.is_some_and(|id| !id.is_empty() && !is_text(field(terminal,"eventId"),id)) {
                    return Err("campaign_one_shot_attempt_journal_terminal_conflict".into());
                }
                return Ok(Intent{kind:RequestedRecord::Receipt,record:existing.clone(),newly_appended:false});
            }
            compare_head(&report,request.expected_sequence,request.expected_phase,request.expected_previous_event_hash,
                "campaign_one_shot_attempt_journal_terminal_compare_and_append_failed")?;
            let receipt=record::receipt(field(&report,"reservation"),head(&report)?,request.terminal_status,
                request.outcome,request.completed_at,&control.cancelled)?;
            let terminal=record::event(field(&report,"reservation"),Some(head(&report)?),"terminal",
                &object([("terminalReceiptHash",field(&receipt,RECEIPT_HASH).clone())]),request.event_id,request.completed_at,&control.cancelled)?;
            insert_event(connection,&terminal,control)?;
            let changed=connection.execute(
                "INSERT INTO campaign_one_shot_attempt_terminal_receipts(attempt_id,receipt_hash,receipt_json,terminal_event_hash,completed_at) VALUES(?1,?2,?3,?4,?5)",
                params![request.attempt_id,value_text(&receipt,RECEIPT_HASH)?,canonical_text(&receipt,control)?,
                    value_text(&terminal,EVENT_HASH)?,request.completed_at]).map_err(|e|control.map_database(e).to_string())?;
            if changed!=1 {return Err("campaign_one_shot_attempt_journal_terminal_receipt_insert_failed".into());}
            Ok(Intent{kind:RequestedRecord::Receipt,record:receipt,newly_appended:true})
        })
    }
}
fn validate_compare(
    attempt: &str,
    sequence: u8,
    phase: &str,
    previous: &str,
) -> Result<(), String> {
    if attempt.len() > 256
        || !safe_id(&string(attempt))
        || !(2..=7).contains(&sequence)
        || phase.len() > 32
        || super::super::audit::phase(&string(phase)).is_none()
        || previous.len() > 71
        || !sha(&string(previous))
    {
        return Err("campaign_one_shot_attempt_journal_append_invalid".into());
    }
    Ok(())
}
#[cfg(test)]
#[derive(PartialEq, Eq, Clone, Copy)]
pub(super) enum FailurePoint {
    BeforeCommit,
    AfterCommitLoss,
    BeforeCommitTerm,
    AfterCommitKill,
}
#[cfg(test)]
impl OneShotJournalV1<'_> {
    fn take_failure_point(&self, point: FailurePoint) -> bool {
        if self.failure.get() == Some(point) {
            self.failure.set(None);
            true
        } else {
            false
        }
    }
    fn process_interruption(&self, before_commit: bool) -> Result<(), String> {
        let point = if before_commit {
            FailurePoint::BeforeCommitTerm
        } else {
            FailurePoint::AfterCommitKill
        };
        if self.take_failure_point(point) {
            super::interruption_tests::interrupt_process(self, before_commit)?;
        }
        Ok(())
    }
    fn failure_point(&self, point: FailurePoint) -> Result<(), String> {
        if self.take_failure_point(point) {
            Err("one_shot_test_commit_failure".into())
        } else {
            Ok(())
        }
    }
}
