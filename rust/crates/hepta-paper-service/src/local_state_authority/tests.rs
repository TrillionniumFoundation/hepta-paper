use super::*;
mod server_tests;
use crate::sqlite_mutation_coordinator::{DATABASE_ROLES, contracts::schema_transition::*};
use ed25519_dalek::pkcs8::EncodePrivateKey;
use std::{
    fs,
    os::unix::fs::PermissionsExt,
    path::PathBuf,
    sync::atomic::{AtomicU64, Ordering},
};
const NOW: &str = "2026-09-21T00:00:00.000Z";
static NEXT: AtomicU64 = AtomicU64::new(0);
fn h(value: &str) -> String {
    hash_bytes(value.as_bytes())
}
fn pick(value: &Value, names: &[&str]) -> Value {
    Value::Object(
        names
            .iter()
            .map(|k| ((*k).into(), value[*k].clone()))
            .collect(),
    )
}
struct Fixture {
    root: PathBuf,
    config_path: PathBuf,
    config: Value,
    reserve: Value,
}
impl Fixture {
    fn new() -> Self {
        let root = std::env::temp_dir().join(format!(
            "hepta-native-authority-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ));
        fs::create_dir(&root).unwrap();
        fs::set_permissions(&root, fs::Permissions::from_mode(0o700)).unwrap();
        let private = SigningKey::from_bytes(&[94; 32])
            .to_pkcs8_pem(Default::default())
            .unwrap();
        let key_path = root.join("private.pem");
        fs::write(&key_path, private.as_bytes()).unwrap();
        fs::set_permissions(&key_path, fs::Permissions::from_mode(0o600)).unwrap();
        let mut instances=DATABASE_ROLES.iter().map(|role|json!({"databaseRole":role,"databaseInstanceId":format!("instance:{role}"),
            "sourceRelativePath":format!("state/{role}.sqlite"),"preSchemaContractId":"schema:before","schemaContractId":"schema:after",
            "preSchemaHash":h(&format!("before:{role}")),"expectedPostSchemaHash":h(&format!("after:{role}")),"sourceSha256":h(&format!("source:{role}")),
            "sourceFileIdentityHash":h(&format!("identity:{role}")),"journalPreimageHash":h(&format!("journal:{role}")),
            "expectedNormalizedSourceSha256":h(&format!("normalized:{role}")),"prePristineStateHash":h(&format!("pristine:{role}"))})).collect::<Vec<_>>();
        instances.sort_by(|a, b| {
            a["databaseInstanceId"]
                .as_str()
                .cmp(&b["databaseInstanceId"].as_str())
        });
        let scope_rows=json!(instances.iter().map(|v|json!({"instanceId":v["databaseInstanceId"],"role":v["databaseRole"],"sourceRelativePath":v["sourceRelativePath"]})).collect::<Vec<_>>());
        let scope =
            crate::online_runtime_activation::inventory::state_database_scope_hash_v1(&scope_rows)
                .unwrap();
        let config = json!({"version":1,"kind":"HeptaLocalAutonomousResearchStateAuthorityConfiguration","authorityId":"authority:test","keyId":"key:test","scopeId":"scope:test",
            "databaseScopeHash":scope,"writerManifestHash":h("writers"),"privateKeyPath":key_path,"stateDatabasePath":root.join("authority.sqlite"),"socketPath":root.join("authority.sock"),
            "maximumReservationLeaseMs":60000,"maximumObservationAgeMs":60000});
        let config_path = root.join("configuration.json");
        fs::write(&config_path, config.to_string()).unwrap();
        fs::set_permissions(&config_path, fs::Permissions::from_mode(0o600)).unwrap();
        let mut reserve = json!({"version":1,"kind":"AutonomousResearchOnlineSchemaTransitionReserveRequest","protocol":SCHEMA_TRANSITION_PROTOCOL_V1,
            "scopeId":"scope:test","databaseScopeHash":scope,"writerManifestHash":h("writers"),"stateDatabaseManifestHash":h("manifest"),"transitionInventoryHash":h("pending"),
            "schemaBundleHash":h("bundle"),"authorityJournalSchemaContractId":"schema:journal","authorityJournalSchemaHash":h("journal"),"markerSchemaHash":h("marker"),
            "transitionId":h("pending"),"instances":instances,"requestedAt":NOW,"requestedLeaseMs":60000,"requiredExecutionWindowMs":1000});
        reserve["transitionInventoryHash"] =
            json!(schema_transition_inventory_hash_v1(&reserve).unwrap());
        reserve["transitionId"] = json!(schema_transition_identity_v1(&reserve).unwrap());
        Self {
            root,
            config_path,
            config,
            reserve,
        }
    }
    fn runtime(&self) -> LocalStateAuthorityRuntimeV1 {
        let runtime = LocalStateAuthorityRuntimeV1::open(&self.config_path).unwrap();
        runtime.context.fixed_now.set(timestamp(&json!(NOW)));
        runtime
    }
    fn finalize(&self, reservation: &Value) -> Value {
        let hash = schema_transition_receipt_hash_v1(reservation).unwrap();
        let installations = self.reserve["instances"]
            .as_array()
            .unwrap()
            .iter()
            .map(|i| {
                let mut row = pick(
                    i,
                    &[
                        "databaseRole",
                        "databaseInstanceId",
                        "schemaContractId",
                        "preSchemaHash",
                    ],
                );
                row["postSchemaHash"] = i["expectedPostSchemaHash"].clone();
                row["prePristineStateHash"] = i["prePristineStateHash"].clone();
                row["postPristineStateHash"] = json!(h(&format!("post:{}", i["databaseRole"])));
                let mut body = row.clone();
                body["transitionId"] = self.reserve["transitionId"].clone();
                body["reservationReceiptHash"] = json!(hash);
                row["installationHash"] = json!(
                    super::hash(
                        "AutonomousResearchOnlineSchemaTransitionDatabaseInstallation",
                        &body
                    )
                    .unwrap()
                );
                row
            })
            .collect::<Vec<_>>();
        let mut request = pick(
            &self.reserve,
            &[
                "version",
                "protocol",
                "scopeId",
                "databaseScopeHash",
                "writerManifestHash",
                "transitionId",
                "transitionInventoryHash",
                "schemaBundleHash",
            ],
        );
        request.as_object_mut().unwrap().extend(json!({"kind":"AutonomousResearchOnlineSchemaTransitionFinalizeRequest","reservationId":reservation["reservationId"],"reservationReceiptHash":hash,
            "postInventoryHash":h("post-inventory"),"postPristineRuntimeStateHash":h("post-pristine"),"installations":installations,"completedAt":NOW}).as_object().unwrap().clone());
        request
    }
    fn observe(&self, finalize: &Value, receipt: &Value) -> Value {
        let mut request = pick(
            finalize,
            &[
                "version",
                "protocol",
                "scopeId",
                "databaseScopeHash",
                "writerManifestHash",
                "transitionId",
                "transitionInventoryHash",
                "schemaBundleHash",
                "postInventoryHash",
                "postPristineRuntimeStateHash",
            ],
        );
        request["kind"] = json!("AutonomousResearchOnlineSchemaTransitionObserveRequest");
        request["finalizationReceiptHash"] =
            json!(schema_transition_receipt_hash_v1(receipt).unwrap());
        request["nonce"] = json!("nonce:observation");
        request["requestedAt"] = json!(NOW);
        request
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.root);
    }
}

#[test]
fn native_schema_genesis_persists_and_original_node_verifies_real_signatures() {
    let fixture = Fixture::new();
    let mut runtime = fixture.runtime();
    let reservation = runtime.handle(&fixture.reserve).unwrap();
    assert!(
        verify_schema_transition_reservation_v1(
            &reservation,
            &fixture.reserve,
            &runtime.context.trust,
            timestamp(&json!(NOW)).unwrap(),
            &|r| runtime.context.verify_online(r)
        )
        .unwrap()
    );
    assert_eq!(runtime.handle(&fixture.reserve).unwrap(), reservation);
    let finalize = fixture.finalize(&reservation);
    let finalization = runtime.handle(&finalize).unwrap();
    assert_eq!(runtime.handle(&finalize).unwrap(), finalization);
    let observe = fixture.observe(&finalize, &finalization);
    let observation = runtime.handle(&observe).unwrap();
    assert!(
        verify_schema_transition_observation_v1(
            &observation,
            &observe,
            &runtime.context.trust,
            timestamp(&json!(NOW)).unwrap(),
            &|r| runtime.context.verify_online(r)
        )
        .unwrap()
    );
    assert_eq!(
        database_heads(&runtime.connection)
            .unwrap()
            .as_array()
            .unwrap()
            .len(),
        DATABASE_ROLES.len()
    );
    drop(runtime);
    let mut reopened = fixture.runtime();
    assert_eq!(reopened.handle(&observe).unwrap(), observation);
    drop(reopened);
    let input = json!({"configurationPath":fixture.config_path,"reserve":fixture.reserve,"reservation":reservation,
        "finalize":finalize,"finalization":finalization,"observe":observe,"observation":observation,"now":NOW});
    use std::{
        io::Write,
        process::{Command, Stdio},
    };
    let mut child = Command::new("node")
        .arg(
            PathBuf::from(env!("CARGO_MANIFEST_DIR"))
                .join("../../oracle/local-state-authority-runtime-v1.mjs"),
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
        .write_all(input.to_string().as_bytes())
        .unwrap();
    let output = child.wait_with_output().unwrap();
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    let result: Value = serde_json::from_slice(&output.stdout).unwrap();
    assert_eq!(result["accepted"], json!([true, true, true]));
    let mut node = result["reservation"].clone();
    let mut native = reservation;
    for value in [&mut node, &mut native] {
        value.as_object_mut().unwrap().remove("signature");
        value.as_object_mut().unwrap().remove("reservationId");
    }
    assert_eq!(node, native);
}

#[test]
fn schema_expiry_renewal_and_tampered_storage_do_not_publish_false_receipts() {
    let fixture = Fixture::new();
    let mut runtime = fixture.runtime();
    let first = runtime.handle(&fixture.reserve).unwrap();
    runtime
        .context
        .fixed_now
        .set(Some(timestamp(&json!(NOW)).unwrap() + 60000));
    assert_eq!(
        runtime.handle(&fixture.finalize(&first)).unwrap_err().code,
        "local_state_authority_schema_transition_reservation_expired"
    );
    let renewed = runtime.handle(&fixture.reserve).unwrap();
    assert_ne!(renewed["reservationId"], first["reservationId"]);
    let mut tampered = renewed;
    tampered["allRegisteredMutationsFenced"] = json!(false);
    runtime
        .connection
        .execute(
            "UPDATE authority_schema_transition SET reservation_receipt_json=?",
            [tampered.to_string()],
        )
        .unwrap();
    assert!(runtime.handle(&fixture.reserve).is_err());
    assert_eq!(
        metadata(&runtime.connection)
            .unwrap()
            .schema_transition_state,
        "reserved"
    );
    assert_eq!(database_heads(&runtime.connection).unwrap(), json!([]));
}

#[test]
fn provided_key_configuration_and_database_names_are_retained_until_sqlite_closes() {
    for changed in ["key", "configuration", "database"] {
        let fixture = Fixture::new();
        let mut runtime = fixture.runtime();
        let path = match changed {
            "key" => fixture.root.join("private.pem"),
            "configuration" => fixture.config_path.clone(),
            _ => fixture.root.join("authority.sqlite"),
        };
        fs::rename(&path, path.with_extension("saved")).unwrap();
        fs::write(&path, b"replacement").unwrap();
        fs::set_permissions(&path, fs::Permissions::from_mode(0o600)).unwrap();
        assert!(runtime.handle(&fixture.reserve).is_err(), "{changed}");
        assert_eq!(
            metadata(&runtime.connection)
                .unwrap()
                .schema_transition_state,
            "uninitialized"
        );
    }
}

#[test]
fn native_restart_rejects_changed_signing_key_schema_and_implicit_node_migration() {
    for changed in ["key", "schema", "node", "empty-native"] {
        let fixture = Fixture::new();
        drop(fixture.runtime());
        match changed {
            "key" => {
                let value = SigningKey::from_bytes(&[95; 32])
                    .to_pkcs8_pem(Default::default())
                    .unwrap();
                fs::write(fixture.root.join("private.pem"), value.as_bytes()).unwrap();
            }
            "schema" => {
                Connection::open(fixture.root.join("authority.sqlite"))
                    .unwrap()
                    .execute_batch("CREATE TABLE unregistered(id INTEGER)")
                    .unwrap();
            }
            "node" => {
                Connection::open(fixture.root.join("authority.sqlite"))
                    .unwrap()
                    .pragma_update(None, "user_version", 0)
                    .unwrap();
            }
            "empty-native" => {
                let db = Connection::open(fixture.root.join("authority.sqlite")).unwrap();
                for table in [
                    "authority_metadata",
                    "authority_database_head",
                    "authority_schema_transition",
                    "authority_schema_rebind",
                    "authority_mutation",
                    "authority_backup_reservation",
                    "authority_native_identity",
                ] {
                    db.execute_batch(&format!("DROP TABLE {table}")).unwrap();
                }
            }
            _ => unreachable!(),
        }
        assert!(
            LocalStateAuthorityRuntimeV1::open(&fixture.config_path).is_err(),
            "{changed}"
        );
    }
}
