use super::*;
use crate::sqlite_mutation_coordinator::DATABASE_ROLES;
use rusqlite::TransactionBehavior;

const NOW: &str = "2026-07-18T08:00:00.000Z";
fn digest(label: &str) -> String {
    hash_bytes(label.as_bytes())
}
struct Fixture {
    db: Connection,
    ctx: Context,
}
impl Fixture {
    fn new() -> Self {
        Self::with_db(Connection::open_in_memory().unwrap())
    }
    fn with_db(db: Connection) -> Self {
        let config = json!({"version":1,"kind":"HeptaLocalAutonomousResearchStateAuthorityConfiguration",
            "authorityId":"authority:test","keyId":"key:test","scopeId":"scope:test",
            "databaseScopeHash":digest("scope"),"writerManifestHash":digest("writers"),
            "maximumReservationLeaseMs":30000,"maximumObservationAgeMs":30000,
            "privateKeyPath":"/unused/test-key","stateDatabasePath":"/unused/test-db","socketPath":"/unused/test-socket"});
        let ctx = Context::new(config, SigningKey::from_bytes(&[93; 32])).unwrap();
        ctx.fixed_now.set(timestamp(&json!(NOW)));
        db.execute_batch(include_str!("../schema.sql")).unwrap();
        db.execute("INSERT INTO authority_metadata VALUES(1,?1,'authority:test','key:test','scope:test',?2,?3,0,?4,'finalized')",params![digest("configuration"),digest("scope"),digest("writers"),digest("genesis")]).unwrap();
        for role in DATABASE_ROLES {
            db.execute(
                "INSERT INTO authority_database_head VALUES(?1,?2,0,?3,?4,?5)",
                params![
                    format!("instance:{role}"),
                    role,
                    digest(&format!("head:{role}")),
                    digest("schema"),
                    digest(&format!("state:{role}"))
                ],
            )
            .unwrap();
        }
        Self { db, ctx }
    }
    fn call(&mut self, q: &Value) -> Result<Value> {
        let tx = self
            .db
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        let result = handle(&tx, &self.ctx, q)?;
        tx.commit()?;
        Ok(result)
    }
    fn now(&self) -> i64 {
        self.ctx.fixed_now.get().unwrap()
    }
    fn at(&self, offset: i64) {
        self.ctx
            .fixed_now
            .set(Some(timestamp(&json!(NOW)).unwrap() + offset));
    }
    fn base(&self, kind: &str) -> Value {
        json!({"version":1,"kind":kind,"protocol":ONLINE_MUTATION_PROTOCOL,"scopeId":"scope:test","databaseScopeHash":digest("scope"),"writerManifestHash":digest("writers"),"requestedAt":iso(self.now()).unwrap()})
    }
    fn reserve(&self, attempt: &str) -> Value {
        let role = DATABASE_ROLES[0];
        let instance = format!("instance:{role}");
        let current = metadata(&self.db).unwrap();
        let (sequence,head,schema,state)=self.db.query_row("SELECT sequence,hash,schema_hash,state_hash FROM authority_database_head WHERE database_instance_id=?",[&instance],|r|Ok((r.get::<_,i64>(0)?,r.get::<_,String>(1)?,r.get::<_,String>(2)?,r.get::<_,String>(3)?))).unwrap();
        let changes = b"authority opaque changeset bytes";
        let post=contracts::online_mutation_state_hash_v1(&json!({"databaseRole":role,"databaseInstanceId":instance,"writerId":"writer:test","operationId":"operation:test","schemaHash":schema,"previousStateHash":state,"changesetHash":hash_bytes(changes),"databaseSequence":sequence+1,"authorizationReceiptHashes":[],"sideEffectReservationHashes":[]})).unwrap();
        let mut q = self.base("AutonomousResearchOnlineMutationReserveRequest");
        q.as_object_mut().unwrap().extend(json!({"databaseRole":role,"databaseInstanceId":instance,"writerId":"writer:test","operationId":"operation:test","codeProvenanceHash":digest("code"),"mutationAttemptId":attempt,"globalPreviousSequence":current.global_sequence,"globalPreviousHash":current.global_hash,"databasePreviousSequence":sequence,"databasePreviousHash":head,"schemaContractId":"schema:test","schemaHash":schema,"preStateHash":state,"postStateHash":post,"changesetEncoding":"base64","changesetBase64":Base64::encode_string(changes),"changesetByteLength":changes.len(),"changesetHash":hash_bytes(changes),"authorizationReceiptHashes":[],"sideEffectReservationHashes":[],"requestedLeaseMs":30000}).as_object().unwrap().clone());
        q
    }
    fn count(&self) -> i64 {
        self.db
            .query_row("SELECT count(*) FROM authority_mutation", [], |r| r.get(0))
            .unwrap()
    }
    fn verify(&self, r: &Value) -> bool {
        signature(&self.ctx, r)
    }
    fn observations(&mut self) {
        let mut q = self.base("AutonomousResearchOnlineMutationCurrentHeadRequest");
        q["nonce"] = json!("nonce:test");
        let receipt = self.call(&q).unwrap();
        assert!(
            contracts::verify_current_head_v1(
                &receipt,
                &q,
                &self.ctx.trust,
                self.now(),
                None,
                &|r| self.verify(r)
            )
            .unwrap()
        );
        q = self.base("AutonomousResearchOnlineMutationActiveChallengeRequest");
        q["challengeNonce"] = json!("challenge:test");
        let receipt = self.call(&q).unwrap();
        assert!(
            activation::verify_active_challenge_v1(
                &receipt,
                &q,
                &self.ctx.trust,
                self.now(),
                None,
                &|r| self.verify(r)
            )
            .unwrap()
        );
        let mut roles = DATABASE_ROLES.to_vec();
        roles.sort_unstable();
        q = self.base("AutonomousResearchOnlineMutationScopeRequest");
        q.as_object_mut().unwrap().extend(json!({"nonce":"nonce:scope","staticInspectionReceiptHash":digest("static"),"astGateReceiptHash":digest("static"),"codeProvenanceHash":digest("code"),"operationCount":1,"operationIds":["operation:test"],"requiredDatabaseRoles":roles,"coveredDatabaseRoles":roles}).as_object().unwrap().clone());
        let receipt = self.call(&q).unwrap();
        assert!(
            activation::verify_scope_receipt_v1(&receipt, &q, &self.ctx.trust, self.now(), &|r| {
                self.verify(r)
            })
            .unwrap()
        );
    }
}

#[test]
fn signed_reservation_is_idempotent_and_globally_exclusive() {
    let mut f = Fixture::new();
    let q = f.reserve("attempt:first");
    assert_eq!(
        handle(&f.db, &f.ctx, &q).unwrap_err().code,
        "local_state_authority_transaction_required"
    );
    let r = f.call(&q).unwrap();
    assert!(
        contracts::verify_reservation_v1(&r, &q, &f.ctx.trust, f.now(), &|r| f.verify(r)).unwrap()
    );
    assert_eq!(f.call(&q).unwrap(), r);
    let mut changed = q.clone();
    changed["requestedLeaseMs"] = json!(20000);
    assert_eq!(
        f.call(&changed).unwrap_err().code,
        "local_state_authority_mutation_attempt_conflict"
    );
    let second = f.reserve("attempt:second");
    assert_eq!(
        f.call(&second).unwrap_err().code,
        "local_state_authority_global_head_conflict"
    );
    assert_eq!(f.count(), 1);
    assert_eq!(metadata(&f.db).unwrap().global_sequence, 0);
}

#[test]
fn abort_retains_signed_evidence_and_reuses_unconsumed_sequence_then_finalizes_once() {
    let mut f = Fixture::new();
    let q = f.reserve("attempt:first");
    let reservation = f.call(&q).unwrap();
    let abort =
        contracts::build_abort_request_v1(&reservation, "local-apply-failed", &json!(NOW)).unwrap();
    let receipt = f.call(&abort).unwrap();
    assert!(
        contracts::verify_abort_v1(
            &receipt,
            &abort,
            &reservation,
            &f.ctx.trust,
            f.now(),
            &|r| f.verify(r)
        )
        .unwrap()
    );
    assert_eq!(f.call(&abort).unwrap(), receipt);
    let old_finalize = contracts::build_finalize_request_v1(&reservation, &json!(NOW)).unwrap();
    assert_eq!(
        f.call(&old_finalize).unwrap_err().code,
        "local_state_authority_mutation_not_reserved"
    );
    let q = f.reserve("attempt:second");
    let reservation = f.call(&q).unwrap();
    assert_eq!(reservation["globalSequence"], 1);
    assert_eq!(f.count(), 2);
    let finalize = contracts::build_finalize_request_v1(&reservation, &json!(NOW)).unwrap();
    // Recovery may finalize after lease expiry when the actual local commit was inside it.
    f.at(40000);
    let receipt = f.call(&finalize).unwrap();
    assert!(
        contracts::verify_finalization_v1(
            &receipt,
            &finalize,
            &reservation,
            &f.ctx.trust,
            f.now(),
            &|r| f.verify(r)
        )
        .unwrap()
    );
    assert_eq!(f.call(&finalize).unwrap(), receipt);
    assert_eq!(metadata(&f.db).unwrap().global_sequence, 1);
    assert_eq!(
        database_heads(&f.db)
            .unwrap()
            .as_array()
            .unwrap()
            .iter()
            .find(|h| h["databaseInstanceId"] == reservation["databaseInstanceId"])
            .unwrap()["stateHash"],
        reservation["postStateHash"]
    );
    assert_eq!(
        f.db.query_row(
            "SELECT count(*) FROM authority_mutation WHERE status='aborted'",
            [],
            |r| r.get::<_, i64>(0)
        )
        .unwrap(),
        1
    );
    f.observations();
}

#[test]
fn genuine_signed_resolution_and_unresolved_observations_track_pending_state() {
    let mut f = Fixture::new();
    f.observations();
    let q = f.reserve("attempt:observe");
    let resolve = contracts::build_resolution_request_v1(&q, &json!(NOW)).unwrap();
    let absent = f.call(&resolve).unwrap();
    assert!(
        contracts::verify_resolution_v1(&absent, &resolve, &q, &f.ctx.trust, f.now(), &|r| f
            .verify(r))
        .unwrap()
    );
    assert_eq!(absent["resolution"], "not-found");
    let reservation = f.call(&q).unwrap();
    let found = f.call(&resolve).unwrap();
    assert!(
        contracts::verify_resolution_v1(&found, &resolve, &q, &f.ctx.trust, f.now(), &|r| f
            .verify(r))
        .unwrap()
    );
    assert_eq!(found["reservation"], reservation);
    let mut list = f.base("AutonomousResearchOnlineUnresolvedReservationListRequest");
    list["databaseRole"] = q["databaseRole"].clone();
    list["databaseInstanceId"] = q["databaseInstanceId"].clone();
    list["nonce"] = json!("nonce:list");
    let receipt = f.call(&list).unwrap();
    assert!(
        activation::verify_unresolved_list_v1(&receipt, &list, &f.ctx.trust, f.now(), &|r| f
            .verify(r))
        .unwrap()
    );
    assert_eq!(receipt["unresolvedReservationCount"], 1);
    let mut head = f.base("AutonomousResearchOnlineMutationCurrentHeadRequest");
    head["nonce"] = json!("nonce:head");
    let receipt = f.call(&head).unwrap();
    assert_eq!(receipt["unresolvedReservationCount"], 1);
    assert!(
        !contracts::verify_current_head_v1(&receipt, &head, &f.ctx.trust, f.now(), None, &|r| f
            .verify(r))
        .unwrap()
    );
    let abort = contracts::build_abort_request_v1(&reservation, "local-marker-failed", &json!(NOW))
        .unwrap();
    f.call(&abort).unwrap();
    let receipt = f.call(&list).unwrap();
    assert_eq!(receipt["unresolvedReservationCount"], 0);
    assert!(
        activation::verify_unresolved_list_v1(&receipt, &list, &f.ctx.trust, f.now(), &|r| f
            .verify(r))
        .unwrap()
    );
}

#[test]
fn invalid_time_scope_extra_fields_and_tampered_receipts_cannot_advance_heads() {
    let mut f = Fixture::new();
    let q = f.reserve("attempt:invalid");
    let mut invalid = q.clone();
    invalid["extra"] = json!(true);
    assert!(f.call(&invalid).is_err());
    invalid = q.clone();
    invalid["scopeId"] = json!("scope:wrong");
    assert!(f.call(&invalid).is_err());
    assert_eq!(f.count(), 0);
    let reservation = f.call(&q).unwrap();
    for offset in [-6000, 30001] {
        let committed = iso(f.now() + offset).unwrap();
        let finalization =
            contracts::build_finalize_request_v1(&reservation, &json!(committed)).unwrap();
        assert!(f.call(&finalization).is_err());
        assert_eq!(metadata(&f.db).unwrap().global_sequence, 0);
        assert_eq!(
            f.db.query_row("SELECT status FROM authority_mutation", [], |r| r
                .get::<_, String>(0))
                .unwrap(),
            "reserved"
        );
    }
    let mut corrupt = reservation.clone();
    corrupt["globalHash"] = json!(digest("tampered"));
    f.db.execute(
        "UPDATE authority_mutation SET reservation_receipt_json=?",
        [corrupt.to_string()],
    )
    .unwrap();
    let finalization = contracts::build_finalize_request_v1(&reservation, &json!(NOW)).unwrap();
    assert_eq!(
        f.call(&finalization).unwrap_err().code,
        "local_state_authority_mutation_state_invalid"
    );
    let resolve = contracts::build_resolution_request_v1(&q, &json!(NOW)).unwrap();
    assert!(f.call(&resolve).is_err());
    assert_eq!(metadata(&f.db).unwrap().global_sequence, 0);
}

#[test]
fn clock_rollback_and_sequence_exhaustion_fail_without_new_reservations() {
    let mut f = Fixture::new();
    f.observations();
    f.at(-1);
    let q = f.reserve("attempt:clock");
    assert_eq!(
        f.call(&q).unwrap_err().code,
        "local_state_authority_clock_invalid"
    );
    assert_eq!(f.count(), 0);
    f.at(0);
    f.db.execute(
        "UPDATE authority_metadata SET global_sequence=?",
        [MAX_SAFE],
    )
    .unwrap();
    let q = f.reserve("attempt:overflow");
    assert_eq!(
        f.call(&q).unwrap_err().code,
        "local_state_authority_sequence_exhausted"
    );
    assert_eq!(f.count(), 0);
}

#[test]
fn failed_finalization_rolls_back_both_heads_and_retains_pending_reservation() {
    let mut f = Fixture::new();
    let request = f.reserve("attempt:rollback");
    let reservation = f.call(&request).unwrap();
    let before = database_heads(&f.db).unwrap();
    f.db.execute_batch("CREATE TRIGGER injected_finalization_failure BEFORE UPDATE OF status ON authority_mutation WHEN NEW.status='finalized' BEGIN SELECT RAISE(ABORT,'injected failure'); END;").unwrap();
    let finalize = contracts::build_finalize_request_v1(&reservation, &json!(NOW)).unwrap();
    assert!(f.call(&finalize).is_err());
    assert_eq!(metadata(&f.db).unwrap().global_sequence, 0);
    assert_eq!(
        metadata(&f.db).unwrap().global_hash,
        request["globalPreviousHash"]
    );
    assert_eq!(database_heads(&f.db).unwrap(), before);
    assert_eq!(
        f.db.query_row("SELECT status FROM authority_mutation", [], |r| r
            .get::<_, String>(0))
            .unwrap(),
        "reserved"
    );
    assert!(
        f.db.query_row(
            "SELECT finalization_receipt_json IS NULL FROM authority_mutation",
            [],
            |r| r.get::<_, bool>(0)
        )
        .unwrap()
    );
    f.db.execute_batch("DROP TRIGGER injected_finalization_failure")
        .unwrap();
    f.call(&finalize).unwrap();
    assert_eq!(metadata(&f.db).unwrap().global_sequence, 1);
}

#[test]
fn two_actual_sqlite_connections_cannot_reserve_the_same_global_head() {
    use std::sync::{Arc, Barrier};
    let directory = std::env::temp_dir().join(new_id("hepta-native-authority-race").unwrap());
    std::fs::create_dir(&directory).unwrap();
    let path = directory.join("authority.sqlite");
    let f = Fixture::with_db(Connection::open(&path).unwrap());
    let first = f.reserve("attempt:actor1");
    let second = f.reserve("attempt:actor2");
    let barrier = Arc::new(Barrier::new(3));
    let mut children = Vec::new();
    for request in [first, second] {
        let barrier = barrier.clone();
        let path = path.clone();
        let config = f.ctx.configuration.clone();
        children.push(std::thread::spawn(move || {
            let mut db = Connection::open(path).unwrap();
            db.busy_timeout(std::time::Duration::from_secs(5)).unwrap();
            let ctx = Context::new(config, SigningKey::from_bytes(&[93; 32])).unwrap();
            ctx.fixed_now.set(timestamp(&json!(NOW)));
            barrier.wait();
            let tx = db
                .transaction_with_behavior(TransactionBehavior::Immediate)
                .unwrap();
            match handle(&tx, &ctx, &request) {
                Ok(value) => {
                    tx.commit().unwrap();
                    Ok(value)
                }
                Err(error) => Err(error.code),
            }
        }));
    }
    barrier.wait();
    let outcomes = children
        .into_iter()
        .map(|c| c.join().unwrap())
        .collect::<Vec<_>>();
    assert_eq!(outcomes.iter().filter(|r| r.is_ok()).count(), 1);
    assert_eq!(
        outcomes
            .iter()
            .filter_map(|r| r.as_ref().err())
            .collect::<Vec<_>>(),
        vec![&"local_state_authority_global_head_conflict".to_owned()]
    );
    assert_eq!(f.count(), 1);
    assert_eq!(metadata(&f.db).unwrap().global_sequence, 0);
    drop(f);
    std::fs::remove_dir_all(directory).unwrap();
}
