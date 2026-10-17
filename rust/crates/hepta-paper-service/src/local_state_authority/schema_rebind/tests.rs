use super::*;
use crate::sqlite_mutation_coordinator::DATABASE_ROLES;
use rusqlite::TransactionBehavior;
const NOW: &str = "2026-07-18T08:00:00.000Z";
fn h(s: &str) -> String {
    hash_bytes(s.as_bytes())
}
fn context(config: Value, key: u8) -> Context {
    let c = Context::new(config, SigningKey::from_bytes(&[key; 32])).unwrap();
    c.fixed_now.set(timestamp(&json!(NOW)));
    c
}
struct Fixture {
    db: Connection,
    ctx: Context,
}
impl Fixture {
    fn new() -> Self {
        Self::from_db(Connection::open_in_memory().unwrap())
    }
    fn from_db(db: Connection) -> Self {
        db.execute_batch(include_str!("../schema.sql")).unwrap();
        let mut instances=DATABASE_ROLES.iter().map(|role|json!({"databaseRole":role,"databaseInstanceId":format!("instance:{role}"),"sourceRelativePath":format!("{role}.sqlite"),"preSchemaContractId":"schema:old","schemaContractId":"schema:initial","preSchemaHash":h("schema:old"),"expectedPostSchemaHash":h("schema:initial"),"sourceSha256":h(role),"sourceFileIdentityHash":h("identity"),"journalPreimageHash":h("journal"),"expectedNormalizedSourceSha256":h("normalized"),"prePristineStateHash":h("pristine")})).collect::<Vec<_>>();
        instances.sort_by(|a, b| {
            a["databaseInstanceId"]
                .as_str()
                .cmp(&b["databaseInstanceId"].as_str())
        });
        let scope_rows=json!(instances.iter().map(|i|json!({"instanceId":i["databaseInstanceId"],"role":i["databaseRole"],"sourceRelativePath":i["sourceRelativePath"]})).collect::<Vec<_>>());
        let scope =
            crate::online_runtime_activation::inventory::state_database_scope_hash_v1(&scope_rows)
                .unwrap();
        let config = json!({"version":1,"kind":CONFIG_DOMAIN,"authorityId":"authority:test","keyId":"key:test","scopeId":"scope:test","databaseScopeHash":scope,"writerManifestHash":h("writer:source"),"maximumReservationLeaseMs":30000,"maximumObservationAgeMs":30000,"privateKeyPath":"/unused/key","stateDatabasePath":"/unused/authority.sqlite","socketPath":"/unused/socket"});
        let ctx = context(config, 91);
        db.execute("INSERT INTO authority_metadata VALUES(1,?1,'authority:test','key:test','scope:test',?2,?3,0,?4,'uninitialized')",params![hash(CONFIG_DOMAIN,&ctx.configuration).unwrap(),scope,h("writer:source"),h("global:initial")]).unwrap();
        let mut f = Self { db, ctx };
        let mut q = json!({"version":1,"kind":"AutonomousResearchOnlineSchemaTransitionReserveRequest","protocol":SCHEMA_TRANSITION_PROTOCOL_V1,"scopeId":"scope:test","databaseScopeHash":scope,"writerManifestHash":h("writer:source"),"stateDatabaseManifestHash":h("manifest"),"schemaBundleHash":h("bundle:initial"),"authorityJournalSchemaContractId":"journal:v1","authorityJournalSchemaHash":h("journal:schema"),"markerSchemaHash":h("marker"),"instances":instances,"requestedAt":NOW,"requestedLeaseMs":30000,"requiredExecutionWindowMs":1000});
        q["transitionInventoryHash"] = json!(schema_transition_inventory_hash_v1(&q).unwrap());
        q["transitionId"] = json!(schema_transition_identity_v1(&q).unwrap());
        let tx =
            f.db.transaction_with_behavior(TransactionBehavior::Immediate)
                .unwrap();
        let r = super::super::schema::handle(&tx, &f.ctx, &q).unwrap();
        let finish = finalize_request(&r, NOW);
        let finalized = super::super::schema::handle(&tx, &f.ctx, &finish).unwrap();
        assert!(
            verify_schema_transition_finalization_v1(
                &finalized,
                &finish,
                &r,
                &f.ctx.trust,
                f.ctx.fixed_now.get().unwrap(),
                &|r| f.ctx.verify_online(r)
            )
            .unwrap()
        );
        tx.commit().unwrap();
        f
    }
    fn request(&self, target: &str) -> Value {
        let initial: Value = serde_json::from_str(
            &self
                .db
                .query_row(
                    "SELECT reserve_request_json FROM authority_schema_transition",
                    [],
                    |r| r.get::<_, String>(0),
                )
                .unwrap(),
        )
        .unwrap();
        let mut q = initial.clone();
        q["version"] = json!(2);
        q["protocol"] = json!(PRISTINE_SCHEMA_REBIND_PROTOCOL_V2);
        q["writerManifestHash"] = json!(h(target));
        q["sourceWriterManifestHash"] = self.ctx.configuration["writerManifestHash"].clone();
        q["transitionMode"] = json!("pristine-finalized-writer-manifest-rebind");
        q["prePristineRuntimeStateHash"] = json!(h("runtime:pristine"));
        q["schemaBundleHash"] = json!(h(target));
        let heads = database_heads(&self.db).unwrap();
        for (row, head) in q["instances"]
            .as_array_mut()
            .unwrap()
            .iter_mut()
            .zip(heads.as_array().unwrap())
        {
            row["preSchemaHash"] = head["schemaHash"].clone();
            row["expectedPostSchemaHash"] = json!(h(&format!("schema:{target}")));
        }
        q["transitionInventoryHash"] = json!(schema_transition_inventory_hash_v1(&q).unwrap());
        q["transitionId"] = json!(schema_transition_identity_v1(&q).unwrap());
        q
    }
    fn call(&mut self, q: &Value) -> Result<Value> {
        let tx = self
            .db
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        let r = handle(&tx, &self.ctx, q)?;
        tx.commit()?;
        Ok(r)
    }
    fn activate(&mut self) -> Result<bool> {
        let tx = self
            .db
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        let v = activate_finalized(&tx, &self.ctx)?;
        tx.commit()?;
        Ok(v)
    }
    fn inspect(&mut self) -> Value {
        let tx = self
            .db
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .unwrap();
        let v = inspect(&tx, &self.ctx).unwrap();
        tx.commit().unwrap();
        v
    }
    fn snapshot(&self) -> Value {
        let c = metadata(&self.db).unwrap();
        json!({"config":c.configuration_hash,"scope":c.database_scope_hash,"writer":c.writer_manifest_hash,"state":c.schema_transition_state,"sequence":c.global_sequence,"hash":c.global_hash,"heads":database_heads(&self.db).unwrap()})
    }
    fn finalized(&mut self) -> (Value, Value, Value) {
        let q = self.request("writer:target");
        let r = self.call(&q).unwrap();
        let finish = finalize_request(&r, NOW);
        let finalization = self.call(&finish).unwrap();
        (q, r, finalization)
    }
}
fn finalize_request(r: &Value, completed: &str) -> Value {
    let receipt_hash = schema_transition_receipt_hash_v1(r).unwrap();
    let rows=r["instances"].as_array().unwrap().iter().map(|i| {
        let mut row=json!({"databaseRole":i["databaseRole"],"databaseInstanceId":i["databaseInstanceId"],"schemaContractId":i["schemaContractId"],"preSchemaHash":i["preSchemaHash"],"postSchemaHash":i["expectedPostSchemaHash"],"prePristineStateHash":i["prePristineStateHash"],"postPristineStateHash":h("post:pristine")});
        let mut payload=row.clone();payload["transitionId"]=r["transitionId"].clone();payload["reservationReceiptHash"]=json!(receipt_hash);
        row["installationHash"]=json!(hash("AutonomousResearchOnlineSchemaTransitionDatabaseInstallation",&payload).unwrap());row
    }).collect::<Vec<_>>();
    json!({"version":r["version"],"kind":"AutonomousResearchOnlineSchemaTransitionFinalizeRequest","protocol":r["protocol"],"scopeId":r["scopeId"],"databaseScopeHash":r["databaseScopeHash"],"writerManifestHash":r["writerManifestHash"],"transitionId":r["transitionId"],"transitionInventoryHash":r["transitionInventoryHash"],"schemaBundleHash":r["schemaBundleHash"],"reservationId":r["reservationId"],"reservationReceiptHash":receipt_hash,"postInventoryHash":h("post:inventory"),"postPristineRuntimeStateHash":h("post:runtime"),"installations":rows,"completedAt":completed})
}
fn observe_request(q: &Value, r: &Value) -> Value {
    json!({"version":2,"kind":"AutonomousResearchOnlineSchemaTransitionObserveRequest","protocol":PRISTINE_SCHEMA_REBIND_PROTOCOL_V2,"scopeId":q["scopeId"],"databaseScopeHash":q["databaseScopeHash"],"writerManifestHash":q["writerManifestHash"],"transitionId":q["transitionId"],"transitionInventoryHash":q["transitionInventoryHash"],"schemaBundleHash":q["schemaBundleHash"],"finalizationReceiptHash":schema_transition_receipt_hash_v1(r).unwrap(),"postInventoryHash":r["postInventoryHash"],"postPristineRuntimeStateHash":r["postPristineRuntimeStateHash"],"nonce":"nonce:test","requestedAt":NOW,"transitionMode":q["transitionMode"],"sourceWriterManifestHash":q["sourceWriterManifestHash"]})
}

#[test]
fn real_signed_rebind_requires_actual_file_restart_under_exact_target_and_supports_another_pristine_rebind()
 {
    let dir = std::env::temp_dir().join(new_id("hepta-rebind-restart").unwrap());
    std::fs::create_dir(&dir).unwrap();
    let path = dir.join("authority.sqlite");
    let mut f = Fixture::from_db(Connection::open(&path).unwrap());
    let old = f.snapshot();
    let (q, reservation, finalization) = f.finalized();
    assert!(
        verify_schema_transition_reservation_v1(
            &reservation,
            &q,
            &f.ctx.trust,
            f.ctx.fixed_now.get().unwrap(),
            &|r| f.ctx.verify_online(r)
        )
        .unwrap()
    );
    let finish = finalize_request(&reservation, NOW);
    assert_eq!(f.call(&finish).unwrap(), finalization);
    assert_eq!(f.snapshot()["heads"], old["heads"]);
    assert_eq!(f.snapshot()["writer"], old["writer"]);
    assert!(!f.activate().unwrap());
    assert_eq!(f.inspect()["schemaRebindRestartRequired"], true);
    let observe = observe_request(&q, &finalization);
    assert!(f.call(&observe).is_err());
    let target = target_configuration(&f.ctx, &q);
    drop(f);
    let mut f = Fixture {
        db: Connection::open(&path).unwrap(),
        ctx: context(target, 91),
    };
    assert!(f.activate().unwrap());
    assert!(!f.activate().unwrap());
    assert_eq!(f.inspect()["schemaRebindActivated"], true);
    assert_ne!(f.snapshot()["heads"], old["heads"]);
    let observed = f.call(&observe).unwrap();
    assert!(
        verify_schema_transition_observation_v1(
            &observed,
            &observe,
            &f.ctx.trust,
            f.ctx.fixed_now.get().unwrap(),
            &|r| f.ctx.verify_online(r)
        )
        .unwrap()
    );
    let q = f.request("writer:third");
    let reservation = f.call(&q).unwrap();
    f.call(&finalize_request(&reservation, NOW)).unwrap();
    let target = target_configuration(&f.ctx, &q);
    drop(f);
    let mut f = Fixture {
        db: Connection::open(&path).unwrap(),
        ctx: context(target, 91),
    };
    assert!(f.activate().unwrap());
    drop(f);
    std::fs::remove_dir_all(dir).unwrap();
}
#[test]
fn renewal_at_expiry_replaces_signed_reservation_and_invalidates_old_installations() {
    let mut f = Fixture::new();
    let q = f.request("writer:target");
    let r = f.call(&q).unwrap();
    assert_eq!(f.call(&q).unwrap(), r);
    f.ctx
        .fixed_now
        .set(Some(timestamp(&json!(NOW)).unwrap() + 30000));
    assert_eq!(
        f.call(&finalize_request(&r, NOW)).unwrap_err().code,
        "local_state_authority_schema_rebind_reservation_expired"
    );
    let renewed = f.call(&q).unwrap();
    assert_ne!(renewed["reservationId"], r["reservationId"]);
    assert_eq!(renewed["databaseGenesis"], r["databaseGenesis"]);
    assert!(
        verify_schema_transition_reservation_v1(
            &renewed,
            &q,
            &f.ctx.trust,
            f.ctx.fixed_now.get().unwrap(),
            &|r| f.ctx.verify_online(r)
        )
        .unwrap()
    );
    assert!(f.call(&finalize_request(&r, NOW)).is_err());
    let completed = iso(f.ctx.fixed_now.get().unwrap()).unwrap();
    f.call(&finalize_request(&renewed, &completed)).unwrap();
}
#[test]
fn exact_target_key_signed_receipts_and_unchanged_pristine_heads_are_required_for_activation() {
    for change in [
        "key",
        "config",
        "signature",
        "head",
        "extra-head",
        "mutation",
    ] {
        let mut f = Fixture::new();
        let (q, _, _) = f.finalized();
        let mut target = target_configuration(&f.ctx, &q);
        if change == "config" {
            target["socketPath"] = json!("/unused/other-socket");
        }
        f.ctx = context(target, if change == "key" { 92 } else { 91 });
        match change {
            "signature" => {
                let mut r: Value = serde_json::from_str(
                    &f.db
                        .query_row(
                            "SELECT finalization_receipt_json FROM authority_schema_rebind",
                            [],
                            |r| r.get::<_, String>(0),
                        )
                        .unwrap(),
                )
                .unwrap();
                r["globalHash"] = json!(h("corrupt"));
                f.db.execute(
                    "UPDATE authority_schema_rebind SET finalization_receipt_json=?",
                    [r.to_string()],
                )
                .unwrap();
            }
            "head" => {
                f.db.execute(
                    "UPDATE authority_database_head SET hash=? WHERE database_role='native-store'",
                    [h("corrupt")],
                )
                .unwrap();
            }
            "extra-head" => {
                f.db.execute("INSERT INTO authority_database_head VALUES('instance:extra','native-store',0,?1,?1,?1)",[h("extra")]).unwrap();
            }
            "mutation" => {
                f.db.execute("INSERT INTO authority_mutation(mutation_attempt_id,reservation_id,status,global_sequence,database_instance_id,reserve_request_json,reservation_receipt_json) VALUES('attempt:unexpected','reservation:unexpected','aborted',1,'instance:native-store','{}','{}')",[]).unwrap();
            }
            _ => {}
        }
        let before = f.snapshot();
        assert!(f.activate().is_err(), "{change}");
        assert_eq!(f.snapshot(), before, "{change}");
    }
}
#[test]
fn activation_failure_rolls_back_all_ten_head_updates_and_leaves_restart_pending() {
    let mut f = Fixture::new();
    let (q, _, _) = f.finalized();
    f.ctx = context(target_configuration(&f.ctx, &q), 91);
    let before = f.snapshot();
    f.db.execute_batch("CREATE TRIGGER injected_activation_failure BEFORE UPDATE OF configuration_hash ON authority_metadata BEGIN SELECT RAISE(ABORT,'injected activation failure'); END;").unwrap();
    assert!(f.activate().is_err());
    assert_eq!(f.snapshot(), before);
    f.db.execute_batch("DROP TRIGGER injected_activation_failure")
        .unwrap();
    assert!(f.activate().unwrap());
}
#[test]
fn first_reserve_requires_signed_initial_genesis_zero_sequences_and_no_unfinished_backups() {
    for change in [
        "initial-signature",
        "head-sequence",
        "global-sequence",
        "backup",
        "mutations",
    ] {
        let mut f = Fixture::new();
        let q = f.request("writer:target");
        match change {
            "initial-signature" => {
                let mut r: Value = serde_json::from_str(
                    &f.db
                        .query_row(
                            "SELECT finalization_receipt_json FROM authority_schema_transition",
                            [],
                            |r| r.get::<_, String>(0),
                        )
                        .unwrap(),
                )
                .unwrap();
                r["globalHash"] = json!(h("corrupt"));
                f.db.execute(
                    "UPDATE authority_schema_transition SET finalization_receipt_json=?",
                    [r.to_string()],
                )
                .unwrap();
            }
            "head-sequence" => {
                f.db.execute("UPDATE authority_database_head SET sequence=1 WHERE database_role='native-store'",[]).unwrap();
            }
            "global-sequence" => {
                f.db.execute("UPDATE authority_metadata SET global_sequence=1", [])
                    .unwrap();
            }
            "backup" => {
                let request = json!({"version":1,"kind":"AutonomousResearchStateBackupAuthorityReserveRequest","inventoryHash":h("inventory"),"databaseScopeHash":f.ctx.configuration["databaseScopeHash"],"databaseInstanceIds":database_heads(&f.db).unwrap().as_array().unwrap().iter().map(|r|r["databaseInstanceId"].clone()).collect::<Vec<_>>(),"requestedAt":NOW,"maximumLeaseMs":30000});
                let tx =
                    f.db.transaction_with_behavior(TransactionBehavior::Immediate)
                        .unwrap();
                super::super::backup::handle(&tx, &f.ctx, &request).unwrap();
                tx.commit().unwrap();
            }
            "mutations" => {
                f.db.execute("INSERT INTO authority_mutation(mutation_attempt_id,reservation_id,status,global_sequence,database_instance_id,reserve_request_json,reservation_receipt_json) VALUES('attempt:unexpected','reservation:unexpected','aborted',1,'instance:native-store','{}','{}')",[]).unwrap();
            }
            _ => {}
        }
        let before = f.snapshot();
        assert!(f.call(&q).is_err(), "{change}");
        assert_eq!(f.snapshot(), before);
        assert_eq!(
            count(&f.db, "SELECT count(*) FROM authority_schema_rebind").unwrap(),
            0
        );
    }
}
