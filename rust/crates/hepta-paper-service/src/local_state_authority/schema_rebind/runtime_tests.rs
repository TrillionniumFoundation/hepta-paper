//! Real installed-input/runtime boundary: two unchanged configuration files,
//! one supplied private key, one live SQLite journal, no qualification fixture.
use super::*;
use crate::sqlite_mutation_coordinator::{DATABASE_ROLES, ONLINE_MUTATION_PROTOCOL, contracts};
use ed25519_dalek::pkcs8::EncodePrivateKey;
use std::{
    fs,
    os::unix::fs::PermissionsExt,
    path::{Path, PathBuf},
};
const NOW: &str = "2026-09-21T00:00:00.000Z";
fn h(value: &str) -> String {
    hash_bytes(value.as_bytes())
}
struct Installation {
    root: PathBuf,
    source_path: PathBuf,
    target_path: PathBuf,
    source: Value,
    initial: Value,
}
impl Installation {
    fn new() -> Self {
        let root = std::env::temp_dir().join(new_id("hepta-rebind-live-runtimes").unwrap());
        fs::create_dir(&root).unwrap();
        fs::set_permissions(&root, fs::Permissions::from_mode(0o700)).unwrap();
        let key_path = root.join("provided-private.pem");
        let pem = SigningKey::from_bytes(&[87; 32])
            .to_pkcs8_pem(Default::default())
            .unwrap();
        private_file(&key_path, pem.as_bytes());
        let mut instances=DATABASE_ROLES.iter().map(|role|json!({"databaseRole":role,"databaseInstanceId":format!("instance:{role}"),"sourceRelativePath":format!("state/{role}.sqlite"),"preSchemaContractId":"schema:before","schemaContractId":"schema:initial","preSchemaHash":h("before"),"expectedPostSchemaHash":h("initial"),"sourceSha256":h(role),"sourceFileIdentityHash":h("identity"),"journalPreimageHash":h("journal"),"expectedNormalizedSourceSha256":h("normalized"),"prePristineStateHash":h("pristine")})).collect::<Vec<_>>();
        instances.sort_by(|a, b| {
            a["databaseInstanceId"]
                .as_str()
                .cmp(&b["databaseInstanceId"].as_str())
        });
        let rows=json!(instances.iter().map(|i|json!({"instanceId":i["databaseInstanceId"],"role":i["databaseRole"],"sourceRelativePath":i["sourceRelativePath"]})).collect::<Vec<_>>());
        let scope =
            crate::online_runtime_activation::inventory::state_database_scope_hash_v1(&rows)
                .unwrap();
        let source = json!({"version":1,"kind":CONFIG_DOMAIN,"authorityId":"authority:runtime-test","keyId":"key:provided","scopeId":"scope:runtime-test","databaseScopeHash":scope,"writerManifestHash":h("source-writers"),"privateKeyPath":key_path,"stateDatabasePath":root.join("authority.sqlite"),"socketPath":root.join("authority.sock"),"maximumReservationLeaseMs":60000,"maximumObservationAgeMs":60000});
        let source_path = root.join("source.json");
        let target_path = root.join("target.json");
        private_file(&source_path, source.to_string().as_bytes());
        let mut target = source.clone();
        target["writerManifestHash"] = json!(h("target-writers"));
        private_file(&target_path, target.to_string().as_bytes());
        let mut initial = json!({"version":1,"kind":"AutonomousResearchOnlineSchemaTransitionReserveRequest","protocol":SCHEMA_TRANSITION_PROTOCOL_V1,"scopeId":source["scopeId"],"databaseScopeHash":scope,"writerManifestHash":source["writerManifestHash"],"stateDatabaseManifestHash":h("manifest"),"schemaBundleHash":h("initial-bundle"),"authorityJournalSchemaContractId":"schema:authority-journal","authorityJournalSchemaHash":h("journal-schema"),"markerSchemaHash":h("marker"),"instances":instances,"requestedAt":NOW,"requestedLeaseMs":60000,"requiredExecutionWindowMs":1000});
        bind_request(&mut initial);
        Self {
            root,
            source_path,
            target_path,
            source,
            initial,
        }
    }
    fn runtime(&self, target: bool) -> LocalStateAuthorityRuntimeV1 {
        let r = LocalStateAuthorityRuntimeV1::open(if target {
            &self.target_path
        } else {
            &self.source_path
        })
        .unwrap();
        r.context.fixed_now.set(timestamp(&json!(NOW)));
        r
    }
    fn rebind(&self) -> Value {
        let mut q = self.initial.clone();
        q["version"] = json!(2);
        q["protocol"] = json!(PRISTINE_SCHEMA_REBIND_PROTOCOL_V2);
        q["sourceWriterManifestHash"] = q["writerManifestHash"].clone();
        q["writerManifestHash"] = json!(h("target-writers"));
        q["transitionMode"] = json!("pristine-finalized-writer-manifest-rebind");
        q["prePristineRuntimeStateHash"] = json!(h("pristine-runtime"));
        q["schemaBundleHash"] = json!(h("target-bundle"));
        for i in q["instances"].as_array_mut().unwrap() {
            i["preSchemaHash"] = i["expectedPostSchemaHash"].clone();
            i["expectedPostSchemaHash"] = json!(h("target-schema"));
        }
        bind_request(&mut q);
        q
    }
}
impl Drop for Installation {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.root);
    }
}
fn private_file(path: &Path, bytes: &[u8]) {
    fs::write(path, bytes).unwrap();
    fs::set_permissions(path, fs::Permissions::from_mode(0o600)).unwrap();
}
fn bind_request(q: &mut Value) {
    q["transitionInventoryHash"] = json!(schema_transition_inventory_hash_v1(q).unwrap());
    q["transitionId"] = json!(schema_transition_identity_v1(q).unwrap());
}
fn finalize(r: &Value) -> Value {
    let receipt_hash = schema_transition_receipt_hash_v1(r).unwrap();
    let mut rows = Vec::new();
    for i in r["instances"].as_array().unwrap() {
        let mut row = json!({"databaseRole":i["databaseRole"],"databaseInstanceId":i["databaseInstanceId"],"schemaContractId":i["schemaContractId"],"preSchemaHash":i["preSchemaHash"],"postSchemaHash":i["expectedPostSchemaHash"],"prePristineStateHash":i["prePristineStateHash"],"postPristineStateHash":h("post-pristine")});
        let mut p = row.clone();
        p["transitionId"] = r["transitionId"].clone();
        p["reservationReceiptHash"] = json!(receipt_hash);
        row["installationHash"] = json!(
            hash(
                "AutonomousResearchOnlineSchemaTransitionDatabaseInstallation",
                &p
            )
            .unwrap()
        );
        rows.push(row);
    }
    json!({"version":r["version"],"kind":"AutonomousResearchOnlineSchemaTransitionFinalizeRequest","protocol":r["protocol"],"scopeId":r["scopeId"],"databaseScopeHash":r["databaseScopeHash"],"writerManifestHash":r["writerManifestHash"],"transitionId":r["transitionId"],"transitionInventoryHash":r["transitionInventoryHash"],"schemaBundleHash":r["schemaBundleHash"],"reservationId":r["reservationId"],"reservationReceiptHash":receipt_hash,"postInventoryHash":h("post-inventory"),"postPristineRuntimeStateHash":h("post-runtime"),"installations":rows,"completedAt":NOW})
}
fn head(config: &Value) -> Value {
    json!({"version":1,"kind":"AutonomousResearchOnlineMutationCurrentHeadRequest","protocol":ONLINE_MUTATION_PROTOCOL,"scopeId":config["scopeId"],"databaseScopeHash":config["databaseScopeHash"],"writerManifestHash":config["writerManifestHash"],"nonce":"nonce:runtime-head","requestedAt":NOW})
}

#[test]
fn target_runtime_reopen_activates_rebind_and_revokes_the_still_live_source_instance() {
    // Installation first; both SQLite-owning runtimes drop before fixture files.
    let fixture = Installation::new();
    let original_source_bytes = fs::read(&fixture.source_path).unwrap();
    let mut source = fixture.runtime(false);
    let initial = source.handle(&fixture.initial).unwrap();
    source.handle(&finalize(&initial)).unwrap();
    let old_request = head(&fixture.source);
    let old_receipt = source.handle(&old_request).unwrap();
    assert!(source.context.verify_online(&old_receipt));
    let q = fixture.rebind();
    let reserved = source.handle(&q).unwrap();
    let finished = source.handle(&finalize(&reserved)).unwrap();
    assert!(
        verify_schema_transition_reservation_v1(
            &reserved,
            &q,
            &source.context.trust,
            timestamp(&json!(NOW)).unwrap(),
            &|r| source.context.verify_online(r)
        )
        .unwrap()
    );
    assert_eq!(
        source.inspect().unwrap()["schemaRebindRestartRequired"],
        true
    );
    let old_heads = database_heads(&source.connection).unwrap();
    // Source remains alive and its own config/key pins remain unchanged. A
    // genuinely separate target configuration reload activates under SQLite.
    let mut target = fixture.runtime(true);
    assert_eq!(
        fs::read(&fixture.source_path).unwrap(),
        original_source_bytes
    );
    source.inputs.assert_current().unwrap();
    assert_eq!(target.inspect().unwrap()["schemaRebindActivated"], true);
    assert_ne!(database_heads(&target.connection).unwrap(), old_heads);
    let state_after_activation = database_heads(&target.connection).unwrap();
    assert_eq!(
        source.handle(&old_request).unwrap_err().code,
        "local_state_authority_persisted_identity_mismatch"
    );
    assert_eq!(
        source.inspect().unwrap_err().code,
        "local_state_authority_persisted_identity_mismatch"
    );
    // A request using target fields cannot rescue an instance whose actual
    // retained configuration and key identity no longer match the journal.
    let target_request = head(&target.context.configuration);
    assert_eq!(
        source.handle(&target_request).unwrap_err().code,
        "local_state_authority_persisted_identity_mismatch"
    );
    assert_eq!(
        database_heads(&target.connection).unwrap(),
        state_after_activation
    );
    let receipt = target.handle(&target_request).unwrap();
    assert!(
        contracts::verify_current_head_v1(
            &receipt,
            &target_request,
            &target.context.trust,
            timestamp(&json!(NOW)).unwrap(),
            None,
            &|r| target.context.verify_online(r)
        )
        .unwrap()
    );
    assert_eq!(receipt["writerManifestHash"], q["writerManifestHash"]);
    assert_eq!(receipt["globalHash"], finished["globalHash"]);
    assert!(LocalStateAuthorityRuntimeV1::open(&fixture.source_path).is_err());
    // An old-instance refusal does not poison the current target instance.
    assert_eq!(target.handle(&target_request).unwrap(), receipt);
}
