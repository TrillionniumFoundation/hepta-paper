//! Native local state authority implementation for the separately installed
//! daemon, using an operator-provided private key. OS principal isolation and
//! independent deployment qualification must be established by its deployment;
//! possession of this library API does not prove that process boundary.
use crate::sqlite_mutation_coordinator::{
    Result,
    authority::files::{self, Snapshot},
    clock::{MutationClockV1, SystemMutationClockV1, iso},
    contracts::online_mutation_signed_payload_v1,
    error, hash, hash_bytes, int, integer, keys, safe, sha, text, timestamp,
};
use base64ct::{Base64, Encoding};
use ed25519_dalek::{Signature, Signer, SigningKey};
use rusqlite::{Connection, OptionalExtension};
use serde_json::{Value, json};
use std::cell::Cell;

mod backup;
pub mod migration;
mod mutation;
mod schema;
mod schema_rebind;
mod server;
mod storage;
pub use server::LocalStateAuthorityServerV1;
#[cfg(test)]
mod tests;

/// This service owns authority state, not a business database. Its private key
/// is loaded only from the configured authority installation. No key creation,
/// subprocess transport, deployment approval or writer activation happens here.
pub struct LocalStateAuthorityRuntimeV1 {
    // Field order closes SQLite before any input descriptor on every drop path.
    connection: Connection,
    context: Context,
    inputs: storage::Inputs,
}
impl LocalStateAuthorityRuntimeV1 {
    pub fn open(configuration_path: &std::path::Path) -> Result<Self> {
        let (mut inputs, context) = storage::Inputs::load(configuration_path)?;
        let (connection, database_identity) = storage::open_database(&context)?;
        inputs.bind_database(database_identity)?;
        inputs.assert_current()?;
        Ok(Self {
            connection,
            context,
            inputs,
        })
    }
    pub fn socket_path(&self) -> Result<&std::path::Path> {
        Ok(std::path::Path::new(text(
            &self.context.configuration,
            "socketPath",
        )?))
    }
    pub fn handle(&mut self, request: &Value) -> Result<Value> {
        self.inputs.assert_current()?;
        if !request.is_object() {
            return Err(error("local_state_authority_request_invalid"));
        }
        let transaction = self
            .connection
            .transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)?;
        assert_current_identity(&transaction, &self.context)?;
        let kind = text(request, "kind")?;
        let value = match kind {
            "AutonomousResearchOnlineSchemaTransitionReserveRequest"
            | "AutonomousResearchOnlineSchemaTransitionFinalizeRequest"
            | "AutonomousResearchOnlineSchemaTransitionObserveRequest" => {
                schema::handle(&transaction, &self.context, request)?
            }
            "AutonomousResearchOnlineMutationReserveRequest"
            | "AutonomousResearchOnlineMutationFinalizeRequest"
            | "AutonomousResearchOnlineMutationAbortRequest"
            | "AutonomousResearchOnlineMutationResolutionRequest"
            | "AutonomousResearchOnlineUnresolvedReservationListRequest"
            | "AutonomousResearchOnlineMutationCurrentHeadRequest"
            | "AutonomousResearchOnlineMutationActiveChallengeRequest"
            | "AutonomousResearchOnlineMutationScopeRequest" => {
                mutation::handle(&transaction, &self.context, request)?
            }
            "AutonomousResearchStateBackupAuthorityReserveRequest"
            | "AutonomousResearchStateBackupAuthorityFinalizeRequest"
            | "AutonomousResearchStateBackupAuthorityCurrentHeadRequest"
            | "AutonomousResearchStateBackupAuthorityJournalRangeRequest" => {
                backup::handle(&transaction, &self.context, request)?
            }
            _ => return Err(error("local_state_authority_request_kind_unsupported")),
        };
        self.inputs.assert_current()?;
        self.context.now()?;
        transaction.commit()?;
        Ok(value)
    }
    pub fn inspect(&mut self) -> Result<Value> {
        self.inputs.assert_current()?;
        let tx = self
            .connection
            .transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)?;
        assert_current_identity(&tx, &self.context)?;
        let current = metadata(&tx)?;
        let rebind = schema_rebind::inspect(&tx, &self.context)?;
        let unresolved: i64 = tx.query_row(
            "SELECT count(*) FROM authority_mutation WHERE status='reserved'",
            [],
            |r| r.get(0),
        )?;
        let mut value = json!({"version":1,"kind":"HeptaLocalAutonomousResearchStateAuthorityInspection",
            "status":if rebind["schemaRebindRestartRequired"]==true {"local_state_authority_schema_rebind_target_configuration_restart_required"}
                else if current.schema_transition_state=="finalized" {"local_state_authority_ready"} else {"local_state_authority_waiting_for_schema_transition"},
            "authorityId":current.authority_id,"keyId":current.key_id,"scopeId":current.scope_id,
            "databaseScopeHash":current.database_scope_hash,"writerManifestHash":current.writer_manifest_hash,
            "globalSequence":current.global_sequence,"globalHash":current.global_hash,"databaseHeads":database_heads(&tx)?,
            "unresolvedReservationCount":unresolved,"schemaTransitionState":current.schema_transition_state});
        if let Some(fields) = rebind.as_object() {
            value
                .as_object_mut()
                .expect("object")
                .extend(fields.clone());
        }
        self.inputs.assert_current()?;
        tx.commit()?;
        Ok(value)
    }
}

const MAX_SAFE: i64 = 9_007_199_254_740_991;

fn assert_current_identity(db: &Connection, context: &Context) -> Result<()> {
    let current = metadata(db)?;
    let config = &context.configuration;
    let key_hash: String = db.query_row(
        "SELECT key_hash FROM authority_native_identity WHERE singleton=1",
        [],
        |r| r.get(0),
    )?;
    if current.configuration_hash
        != hash(
            "HeptaLocalAutonomousResearchStateAuthorityConfiguration",
            config,
        )?
        || current.authority_id != text(config, "authorityId")?
        || current.key_id != text(config, "keyId")?
        || current.scope_id != text(config, "scopeId")?
        || current.database_scope_hash != text(config, "databaseScopeHash")?
        || current.writer_manifest_hash != text(config, "writerManifestHash")?
        || key_hash != hash_bytes(context.signing_key.verifying_key().as_bytes())
    {
        return Err(error("local_state_authority_persisted_identity_mismatch"));
    }
    Ok(())
}

pub(super) struct Context {
    configuration: Value,
    trust: Value,
    signing_key: SigningKey,
    checked_at: Cell<i64>,
    #[cfg(test)]
    fixed_now: Cell<Option<i64>>,
}
impl Context {
    fn new(configuration: Value, signing_key: SigningKey) -> Result<Self> {
        let mut trust = configuration
            .as_object()
            .cloned()
            .ok_or_else(|| error("local_state_authority_configuration_invalid"))?;
        for key in ["privateKeyPath", "stateDatabasePath", "socketPath"] {
            trust.remove(key);
        }
        trust.insert(
            "kind".into(),
            json!("AutonomousResearchOnlineMutationAuthorityTrust"),
        );
        let trust = Value::Object(trust);
        crate::sqlite_mutation_coordinator::contracts::assert_authority_trust_v1(&trust)?;
        Ok(Self {
            configuration,
            trust,
            signing_key,
            checked_at: Cell::new(0),
            #[cfg(test)]
            fixed_now: Cell::new(None),
        })
    }
    fn now(&self) -> Result<String> {
        #[cfg(test)]
        let now = match self.fixed_now.get() {
            Some(value) => value,
            None => SystemMutationClockV1.now_millis()?,
        };
        #[cfg(not(test))]
        let now = SystemMutationClockV1.now_millis()?;
        if now <= 0 || now < self.checked_at.get() || now > MAX_SAFE {
            return Err(error("local_state_authority_clock_invalid"));
        }
        self.checked_at.set(now);
        iso(now)
    }
    fn expiry(&self, issued: &str, duration: i64) -> Result<String> {
        expiry(issued, duration)
    }
    fn new_id(&self, prefix: &str) -> Result<String> {
        new_id(prefix)
    }
    fn sign_online(&self, receipt: &Value) -> Result<Value> {
        self.sign(receipt, online_mutation_signed_payload_v1(receipt)?)
    }
    fn verify_online(&self, receipt: &Value) -> bool {
        let Some(encoded) = receipt["signature"].as_str() else {
            return false;
        };
        let Ok(bytes) = Base64::decode_vec(encoded) else {
            return false;
        };
        let Ok(signature) = Signature::from_slice(&bytes) else {
            return false;
        };
        let Ok(payload) = online_mutation_signed_payload_v1(receipt) else {
            return false;
        };
        self.signing_key
            .verifying_key()
            .verify_strict(payload.as_bytes(), &signature)
            .is_ok()
    }
    fn sign_backup(&self, receipt: &Value) -> Result<Value> {
        self.sign(
            receipt,
            crate::state_backup_authority::state_backup_authority_signature_payload_v1(receipt)?,
        )
    }
    fn sign(&self, receipt: &Value, payload: String) -> Result<Value> {
        let mut value = receipt
            .as_object()
            .cloned()
            .ok_or_else(|| error("local_state_authority_receipt_invalid"))?;
        value.insert(
            "signature".into(),
            json!(Base64::encode_string(
                &self.signing_key.sign(payload.as_bytes()).to_bytes()
            )),
        );
        Ok(Value::Object(value))
    }
}

fn expiry(issued: &str, duration: i64) -> Result<String> {
    let start =
        timestamp(&json!(issued)).ok_or_else(|| error("local_state_authority_clock_invalid"))?;
    let end = start
        .checked_add(duration)
        .filter(|v| duration > 0 && *v <= MAX_SAFE)
        .ok_or_else(|| error("local_state_authority_clock_invalid"))?;
    iso(end)
}
fn new_id(prefix: &str) -> Result<String> {
    let mut bytes = [0u8; 16];
    getrandom::fill(&mut bytes)
        .map_err(|_| error("local_state_authority_randomness_unavailable"))?;
    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    let value = hex::encode(bytes);
    Ok(format!(
        "{prefix}:{}-{}-{}-{}-{}",
        &value[..8],
        &value[8..12],
        &value[12..16],
        &value[16..20],
        &value[20..]
    ))
}
fn parse_record(input: &str, code: &str) -> Result<Value> {
    let value = files::parse(input.as_bytes(), code)?;
    if !value.is_object() {
        return Err(error(code));
    }
    Ok(value)
}

struct Metadata {
    configuration_hash: String,
    authority_id: String,
    key_id: String,
    scope_id: String,
    database_scope_hash: String,
    writer_manifest_hash: String,
    global_sequence: i64,
    global_hash: String,
    schema_transition_state: String,
}
fn metadata(db: &Connection) -> Result<Metadata> {
    Ok(db.query_row("SELECT configuration_hash,authority_id,key_id,scope_id,database_scope_hash,writer_manifest_hash,global_sequence,global_hash,schema_transition_state FROM authority_metadata WHERE singleton=1", [], |r| Ok(Metadata {
        configuration_hash:r.get(0)?, authority_id:r.get(1)?, key_id:r.get(2)?, scope_id:r.get(3)?,
        database_scope_hash:r.get(4)?, writer_manifest_hash:r.get(5)?, global_sequence:r.get(6)?,
        global_hash:r.get(7)?, schema_transition_state:r.get(8)?,
    }))?)
}
fn database_heads(db: &Connection) -> Result<Value> {
    let mut statement = db.prepare("SELECT database_role,database_instance_id,sequence,hash,schema_hash,state_hash FROM authority_database_head ORDER BY database_instance_id")?;
    let heads = statement.query_map([], |r| Ok(json!({"databaseRole":r.get::<_,String>(0)?,
        "databaseInstanceId":r.get::<_,String>(1)?,"sequence":r.get::<_,i64>(2)?,
        "hash":r.get::<_,String>(3)?,"schemaHash":r.get::<_,String>(4)?,"stateHash":r.get::<_,String>(5)?})))?
        .collect::<std::result::Result<Vec<_>,_>>()?;
    Ok(json!(heads))
}
/// A live backup blocks new mutations until finalization or expiry. An expired
/// reservation can never subsequently finalize and claim continuous fencing.
fn assert_no_live_backup(db: &Connection, now: &str) -> Result<()> {
    let now = timestamp(&json!(now)).ok_or_else(|| error("local_state_authority_clock_invalid"))?;
    let mut statement = db.prepare("SELECT reservation_receipt_json FROM authority_backup_reservation WHERE finalization_receipt_json IS NULL")?;
    for row in statement.query_map([], |r| r.get::<_, String>(0))? {
        let receipt = parse_record(&row?, "local_state_authority_backup_state_invalid")?;
        let deadline = timestamp(&receipt["expiresAt"])
            .ok_or_else(|| error("local_state_authority_backup_state_invalid"))?;
        if now < deadline {
            return Err(error("local_state_authority_backup_scope_not_quiescent"));
        }
    }
    Ok(())
}
