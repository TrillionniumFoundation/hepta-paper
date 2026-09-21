use super::*;
use crate::sqlite_mutation_coordinator::DATABASE_ROLES;
use ed25519_dalek::pkcs8::{EncodePrivateKey, spki::der::pem::LineEnding};
use rusqlite::{TransactionBehavior, types::ValueRef};
use std::{
    io::Write,
    path::Path,
    process::{Command, Stdio},
};
const NOW: &str = "2026-07-18T08:00:00.000Z";
fn digest(value: &str) -> String {
    hash_bytes(value.as_bytes())
}
struct Fixture {
    db: Connection,
    ctx: Context,
}
impl Fixture {
    fn new() -> Self {
        let config = json!({"version":1,"kind":"HeptaLocalAutonomousResearchStateAuthorityConfiguration","authorityId":"authority:test","keyId":"key:test","scopeId":"scope:test","databaseScopeHash":digest("scope"),"writerManifestHash":digest("writers"),"maximumReservationLeaseMs":30000,"maximumObservationAgeMs":30000,"privateKeyPath":"/unused/test-key","stateDatabasePath":"/unused/test-db","socketPath":"/unused/test-socket"});
        let ctx = Context::new(config, SigningKey::from_bytes(&[73; 32])).unwrap();
        ctx.fixed_now.set(timestamp(&json!(NOW)));
        let db = Connection::open_in_memory().unwrap();
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
    fn at(&self, offset: i64) {
        self.ctx
            .fixed_now
            .set(Some(timestamp(&json!(NOW)).unwrap() + offset));
    }
    fn now(&self) -> String {
        iso(self.ctx.fixed_now.get().unwrap()).unwrap()
    }
    fn call(&mut self, q: &Value) -> Result<Value> {
        let tx = self
            .db
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        let r = handle(&tx, &self.ctx, q)?;
        tx.commit()?;
        Ok(r)
    }
    fn mutate(&mut self, q: &Value) -> Result<Value> {
        let tx = self
            .db
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        let r = super::super::mutation::handle(&tx, &self.ctx, q)?;
        tx.commit()?;
        Ok(r)
    }
    fn reserve(&self) -> Value {
        json!({"version":1,"kind":RESERVE,"inventoryHash":digest("inventory"),"databaseScopeHash":digest("scope"),"databaseInstanceIds":database_heads(&self.db).unwrap().as_array().unwrap().iter().map(|h|h["databaseInstanceId"].clone()).collect::<Vec<_>>(),"requestedAt":self.now(),"maximumLeaseMs":30000})
    }
    fn finalize(&self, r: &Value) -> Value {
        json!({"version":1,"kind":FINALIZE,"reservationId":r["reservationId"],"inventoryHash":r["inventoryHash"],"databaseScopeHash":r["databaseScopeHash"],"snapshotContentHash":digest("snapshot"),"requestedAt":self.now()})
    }
    fn head(&self) -> Value {
        json!({"version":1,"kind":HEAD,"reservationId":"backup:restore","databaseScopeHash":digest("scope"),"snapshotContentHash":digest("snapshot"),"requestedAt":self.now(),"maximumLeaseMs":30000})
    }
    fn journal(&self, from: i64, from_hash: &str) -> Value {
        let c = metadata(&self.db).unwrap();
        json!({"version":1,"kind":JOURNAL,"reservationId":"backup:restore","databaseScopeHash":digest("scope"),"snapshotContentHash":digest("snapshot"),"onlineAuthorityId":"authority:test","onlineKeyId":"key:test","scopeId":"scope:test","writerManifestHash":digest("writers"),"fromGlobalSequence":from,"fromGlobalHash":from_hash,"toGlobalSequence":c.global_sequence,"toGlobalHash":c.global_hash,"requestedAt":self.now(),"maximumLeaseMs":30000,"maximumEntries":4096})
    }
    fn mutation(&self, attempt: &str) -> Value {
        let role = "native-store";
        let id = format!("instance:{role}");
        let c = metadata(&self.db).unwrap();
        let heads = database_heads(&self.db).unwrap();
        let h = heads
            .as_array()
            .unwrap()
            .iter()
            .find(|h| h["databaseInstanceId"] == id)
            .unwrap();
        let changes = b"opaque authority journal transport test changeset";
        let post=contracts::online_mutation_state_hash_v1(&json!({"databaseRole":role,"databaseInstanceId":id,"writerId":"writer:test","operationId":"operation:test","schemaHash":h["schemaHash"],"previousStateHash":h["stateHash"],"changesetHash":hash_bytes(changes),"databaseSequence":h["sequence"].as_i64().unwrap()+1,"authorizationReceiptHashes":[],"sideEffectReservationHashes":[]})).unwrap();
        json!({"version":1,"kind":"AutonomousResearchOnlineMutationReserveRequest","protocol":ONLINE_MUTATION_PROTOCOL,"scopeId":"scope:test","databaseScopeHash":digest("scope"),"writerManifestHash":digest("writers"),"databaseRole":role,"databaseInstanceId":id,"writerId":"writer:test","operationId":"operation:test","codeProvenanceHash":digest("code"),"mutationAttemptId":attempt,"globalPreviousSequence":c.global_sequence,"globalPreviousHash":c.global_hash,"databasePreviousSequence":h["sequence"],"databasePreviousHash":h["hash"],"schemaContractId":"schema:test","schemaHash":h["schemaHash"],"preStateHash":h["stateHash"],"postStateHash":post,"changesetEncoding":"base64","changesetBase64":Base64::encode_string(changes),"changesetByteLength":changes.len(),"changesetHash":hash_bytes(changes),"authorizationReceiptHashes":[],"sideEffectReservationHashes":[],"requestedAt":self.now(),"requestedLeaseMs":30000})
    }
    fn commit_mutation(&mut self, attempt: &str) -> Value {
        let q = self.mutation(attempt);
        let r = self.mutate(&q).unwrap();
        let q = contracts::build_finalize_request_v1(&r, &json!(self.now())).unwrap();
        self.mutate(&q).unwrap()
    }
    fn snapshot(&self) -> Value {
        let mut all = serde_json::Map::new();
        for table in [
            "authority_metadata",
            "authority_database_head",
            "authority_mutation",
            "authority_backup_reservation",
        ] {
            let mut statement = self
                .db
                .prepare(&format!("SELECT * FROM {table} ORDER BY rowid"))
                .unwrap();
            let names = statement
                .column_names()
                .into_iter()
                .map(str::to_owned)
                .collect::<Vec<_>>();
            let rows = statement
                .query_map([], |r| {
                    let mut row = serde_json::Map::new();
                    for (i, name) in names.iter().enumerate() {
                        row.insert(
                            name.clone(),
                            match r.get_ref(i)? {
                                ValueRef::Null => Value::Null,
                                ValueRef::Integer(v) => json!(v),
                                ValueRef::Text(v) => json!(std::str::from_utf8(v).unwrap()),
                                _ => panic!("unexpected fixture scalar"),
                            },
                        );
                    }
                    Ok(Value::Object(row))
                })
                .unwrap()
                .collect::<std::result::Result<Vec<_>, _>>()
                .unwrap();
            all.insert(table.into(), json!(rows));
        }
        Value::Object(all)
    }
    fn oracle(&self, mut input: Value) -> Value {
        input["configuration"] = self.ctx.configuration.clone();
        input["privateKeyPem"] = json!(
            self.ctx
                .signing_key
                .to_pkcs8_pem(LineEnding::LF)
                .unwrap()
                .as_str()
        );
        input["now"] = json!(self.now());
        input["tables"] = self.snapshot();
        let mut child = Command::new("node")
            .arg(
                Path::new(env!("CARGO_MANIFEST_DIR"))
                    .join("../../oracle/local-state-authority-backup-v1.mjs"),
            )
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .unwrap();
        child
            .stdin
            .take()
            .unwrap()
            .write_all(&serde_json::to_vec(&input).unwrap())
            .unwrap();
        let output = child.wait_with_output().unwrap();
        assert!(
            output.status.success(),
            "{}",
            String::from_utf8_lossy(&output.stderr)
        );
        let v: Value = serde_json::from_slice(&output.stdout).unwrap();
        hepta_legacy_compatibility::qualify_production_node_profile_v1(&v["profile"]).unwrap();
        v["result"].clone()
    }
    fn verify(&self, kind: &str, q: &Value, r: &Value, reservation: Option<&Value>) {
        assert!(signature(&self.ctx, r, false));
        assert_eq!(self.oracle(json!({"operation":"verify","type":kind,"request":q,"receipt":r,"reservation":reservation})),json!({"ok":true,"value":true}));
    }
}

#[test]
fn genuine_signed_backup_reserve_finalize_head_match_original_node_and_replay_idempotently() {
    let mut f = Fixture::new();
    let q = f.reserve();
    let node = f.oracle(json!({"operation":"reserveBackup","request":q}));
    assert_eq!(node["ok"], true);
    let r = f.call(&q).unwrap();
    f.verify("reserve", &q, &r, None);
    let mut a = r.clone();
    let mut b = node["value"].clone();
    for v in [&mut a, &mut b] {
        v.as_object_mut().unwrap().remove("signature");
        v.as_object_mut().unwrap().remove("reservationId");
    }
    assert_eq!(a, b);
    let q = f.finalize(&r);
    let node = f.oracle(json!({"operation":"finalizeBackup","request":q}));
    let finalized = f.call(&q).unwrap();
    assert_eq!(node, json!({"ok":true,"value":finalized}));
    f.verify("finalize", &q, &finalized, Some(&r));
    f.at(60000);
    assert_eq!(
        f.call(&q).unwrap(),
        finalized,
        "already completed results survive lease expiry"
    );
    let q = f.head();
    let node = f.oracle(json!({"operation":"observeBackupHead","request":q}));
    let observed = f.call(&q).unwrap();
    assert_eq!(node, json!({"ok":true,"value":observed}));
    f.verify("head", &q, &observed, None);
}

#[test]
fn live_signed_backup_blocks_actual_mutation_and_release_allows_progress() {
    let mut f = Fixture::new();
    let q = f.reserve();
    let r = f.call(&q).unwrap();
    let before = f.snapshot();
    assert_eq!(
        f.call(&q).unwrap_err().code,
        "local_state_authority_backup_scope_not_quiescent"
    );
    assert_eq!(
        f.mutate(&f.mutation("attempt:blocked")).unwrap_err().code,
        "local_state_authority_backup_scope_not_quiescent"
    );
    assert_eq!(f.snapshot(), before);
    let q = f.finalize(&r);
    f.call(&q).unwrap();
    f.commit_mutation("attempt:released");
    assert_eq!(metadata(&f.db).unwrap().global_sequence, 1);
}

#[test]
fn expired_backup_cannot_claim_fencing_after_real_mutation_or_pending_reservation() {
    let mut f = Fixture::new();
    let r = f.call(&f.reserve()).unwrap();
    f.at(30000);
    let q = f.finalize(&r);
    let before = f.snapshot();
    assert_eq!(
        f.call(&q).unwrap_err().code,
        "local_state_authority_backup_lease_expired"
    );
    assert_eq!(f.snapshot(), before);
    let mutation = f.mutate(&f.mutation("attempt:after-expiry")).unwrap();
    let before = f.snapshot();
    assert_eq!(
        f.call(&q).unwrap_err().code,
        "local_state_authority_backup_scope_not_quiescent"
    );
    assert_eq!(
        f.call(&f.head()).unwrap_err().code,
        "local_state_authority_backup_scope_not_quiescent"
    );
    assert_eq!(f.snapshot(), before);
    let finalize = contracts::build_finalize_request_v1(&mutation, &json!(f.now())).unwrap();
    f.mutate(&finalize).unwrap();
    let before = f.snapshot();
    // Reproduce the actual incumbent false claim against exactly this real journal.
    let old = f.oracle(json!({"operation":"finalizeBackup","request":q}));
    assert_eq!(old["ok"], true);
    assert_eq!(old["value"]["headSequence"], 0);
    assert_eq!(
        old["value"]["allRegisteredMutationsFencedThroughFinalize"],
        true
    );
    assert_eq!(metadata(&f.db).unwrap().global_sequence, 1);
    assert_eq!(
        f.call(&q).unwrap_err().code,
        "local_state_authority_backup_head_conflict"
    );
    assert_eq!(f.snapshot(), before);
}

#[test]
fn finalized_journal_uses_real_signed_history_and_rejects_stale_or_forged_ranges() {
    let mut f = Fixture::new();
    f.commit_mutation("attempt:first");
    let first = metadata(&f.db).unwrap();
    f.commit_mutation("attempt:second");
    let q = f.journal(0, &digest("genesis"));
    let node = f.oracle(json!({"operation":"readBackupJournal","request":q}));
    let r = f.call(&q).unwrap();
    assert_eq!(node, json!({"ok":true,"value":r}));
    f.verify("journal", &q, &r, None);
    assert_eq!(r["entries"].as_array().unwrap().len(), 2);
    let mut bad = q.clone();
    bad["fromGlobalHash"] = json!(digest("wrong"));
    let before = f.snapshot();
    assert_eq!(
        f.call(&bad).unwrap_err().code,
        "local_state_authority_backup_journal_chain_invalid"
    );
    assert_eq!(f.snapshot(), before);
    let mut stale = q.clone();
    stale["toGlobalSequence"] = json!(first.global_sequence);
    stale["toGlobalHash"] = json!(first.global_hash);
    assert_eq!(
        f.oracle(json!({"operation":"readBackupJournal","request":stale}))["ok"],
        true
    );
    assert_eq!(
        f.call(&stale).unwrap_err().code,
        "local_state_authority_backup_journal_head_unavailable"
    );
    let raw: String =
        f.db.query_row(
            "SELECT finalization_receipt_json FROM authority_mutation WHERE global_sequence=2",
            [],
            |r| r.get(0),
        )
        .unwrap();
    let mut tampered = parse_record(&raw, "bad").unwrap();
    tampered["signature"] = json!(Base64::encode_string(&[0; 64]));
    f.db.execute(
        "UPDATE authority_mutation SET finalization_receipt_json=? WHERE global_sequence=2",
        [encoded(&tampered).unwrap()],
    )
    .unwrap();
    let before = f.snapshot();
    assert_eq!(
        f.call(&q).unwrap_err().code,
        "local_state_authority_mutation_state_invalid"
    );
    assert_eq!(f.snapshot(), before);
    f.db.execute(
        "UPDATE authority_mutation SET finalization_receipt_json=? WHERE global_sequence=2",
        [raw],
    )
    .unwrap();
    f.db.execute("DELETE FROM authority_mutation WHERE global_sequence=1", [])
        .unwrap();
    assert_eq!(
        f.call(&q).unwrap_err().code,
        "local_state_authority_backup_journal_incomplete"
    );
}

#[test]
fn persisted_receipt_binding_signature_and_idempotent_conflict_are_checked() {
    let mut f = Fixture::new();
    let r = f.call(&f.reserve()).unwrap();
    let q = f.finalize(&r);
    let original = f.call(&q).unwrap();
    let mut conflicting = q.clone();
    conflicting["snapshotContentHash"] = json!(digest("other"));
    assert_eq!(
        f.call(&conflicting).unwrap_err().code,
        "local_state_authority_backup_finalize_conflict"
    );
    let mut receipt = original.clone();
    receipt["headHash"] = json!(digest("forged"));
    f.db.execute(
        "UPDATE authority_backup_reservation SET finalization_receipt_json=?",
        [encoded(&receipt).unwrap()],
    )
    .unwrap();
    let before = f.snapshot();
    assert_eq!(
        f.call(&q).unwrap_err().code,
        "local_state_authority_backup_state_invalid"
    );
    assert_eq!(f.snapshot(), before);
    f.db.execute(
        "UPDATE authority_backup_reservation SET finalization_receipt_json=?",
        [encoded(&original).unwrap()],
    )
    .unwrap();
    let mut tampered = r;
    tampered["signature"] = json!(Base64::encode_string(&[0; 64]));
    f.db.execute(
        "UPDATE authority_backup_reservation SET reservation_receipt_json=?",
        [encoded(&tampered).unwrap()],
    )
    .unwrap();
    assert_eq!(
        f.call(&q).unwrap_err().code,
        "local_state_authority_backup_state_invalid"
    );
}

#[test]
fn backup_rows_roll_back_after_real_signed_writes_until_owner_commits() {
    let mut f = Fixture::new();
    let q = f.reserve();
    assert_eq!(
        handle(&f.db, &f.ctx, &q).unwrap_err().code,
        "local_state_authority_transaction_required"
    );
    let before = f.snapshot();
    {
        let tx =
            f.db.transaction_with_behavior(TransactionBehavior::Immediate)
                .unwrap();
        let r = handle(&tx, &f.ctx, &q).unwrap();
        assert!(signature(&f.ctx, &r, false));
    }
    assert_eq!(f.snapshot(), before);
    let r = f.call(&q).unwrap();
    let q = f.finalize(&r);
    let before = f.snapshot();
    {
        let tx =
            f.db.transaction_with_behavior(TransactionBehavior::Immediate)
                .unwrap();
        let r = handle(&tx, &f.ctx, &q).unwrap();
        assert!(signature(&f.ctx, &r, false));
    }
    assert_eq!(f.snapshot(), before);
    f.call(&q).unwrap();
}

#[test]
fn malformed_backup_requests_match_node_and_leave_journal_unchanged() {
    let mut f = Fixture::new();
    let original = f.reserve();
    let mut cases = Vec::new();
    for (key, value) in [
        ("extra", json!(true)),
        ("maximumLeaseMs", json!(999)),
        ("maximumLeaseMs", json!(30001)),
        ("inventoryHash", json!("invalid")),
        ("requestedAt", json!("invalid")),
        ("databaseInstanceIds", json!(["instance:z", "instance:a"])),
    ] {
        let mut q = original.clone();
        q[key] = value;
        cases.push(q);
    }
    for q in cases {
        let expected = f.oracle(json!({"operation":"reserveBackup","request":q}));
        let before = f.snapshot();
        assert_eq!(
            expected,
            json!({"ok":false,"error":f.call(&q).unwrap_err().code})
        );
        assert_eq!(f.snapshot(), before);
    }
    f.db.execute(
        "UPDATE authority_metadata SET schema_transition_state='reserved'",
        [],
    )
    .unwrap();
    assert_eq!(
        f.call(&f.head()).unwrap_err().code,
        "local_state_authority_backup_scope_not_quiescent"
    );
}
