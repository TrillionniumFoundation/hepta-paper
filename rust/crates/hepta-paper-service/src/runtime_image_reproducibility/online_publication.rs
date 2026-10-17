//! Native online publication adapter. The activation capability deliberately has
//! no public constructor: a configured coordinator is not a production-ready
//! runtime. Integration of verified runtime activation owns that next boundary.
use super::publication as disk;
use super::*;
use crate::sqlite_mutation_coordinator::{
    SqliteMutationCoordinatorError, SqliteMutationCoordinatorV1,
    authority::MutationAuthorityTransportV1,
};
use crate::sqlite_mutation_plan::externally_fenced_sqlite_writer_plan_hash_v1;
use nix::fcntl::OFlag;
use rusqlite::{Connection, OpenFlags, TransactionBehavior, types::Value as SqlValue};
use std::{fs::File, path::PathBuf};

pub const PUBLICATION_DATABASE_ROLE: &str = "runtime-reproducibility-publication";
pub const PUBLICATION_SCHEMA_CONTRACT_ID: &str = "runtime-reproducibility-publication-schema-v1";
pub const PUBLICATION_WRITER_ID: &str =
    "writer:runtime-reproducibility-publication:receipt-repository:v1";
pub const PUBLICATION_OPERATION_ID: &str =
    "runtime-reproducibility-publication.receipt-repository.publish.v1";

/// Raw statements, then the native plan compiler recomputes the implementation
/// hash. No fixed digest or caller-supplied SQL establishes this writer.
pub fn runtime_image_publication_mutation_plans_v1() -> Value {
    json!({PUBLICATION_OPERATION_ID:{"version":1,"operationId":PUBLICATION_OPERATION_ID,"statements":[
        {"statementId":"runtime-publication.current.get.v1","mode":"get","sql":"SELECT receipt_json,receipt_content_hash,receipt_hash,\n          issued_at,expires_at,publication_generation,updated_at\n          FROM runtime_image_reproducibility_receipt WHERE singleton_id=1"},
        {"statementId":"runtime-publication.receipt.upsert.v1","mode":"run","sql":"INSERT INTO runtime_image_reproducibility_receipt(\n          singleton_id,receipt_json,receipt_content_hash,receipt_hash,issued_at,expires_at,\n          publication_generation,updated_at\n        ) VALUES(1,?,?,?,?,?,?,?) ON CONFLICT(singleton_id) DO UPDATE SET\n          receipt_json=excluded.receipt_json,\n          receipt_content_hash=excluded.receipt_content_hash,\n          receipt_hash=excluded.receipt_hash,\n          issued_at=excluded.issued_at,\n          expires_at=excluded.expires_at,\n          publication_generation=excluded.publication_generation,\n          updated_at=excluded.updated_at"}
    ]}})
}
pub fn runtime_image_publication_writer_plan_hash_v1() -> Result<String> {
    externally_fenced_sqlite_writer_plan_hash_v1(
        PUBLICATION_WRITER_ID,
        &[runtime_image_publication_mutation_plans_v1()[PUBLICATION_OPERATION_ID].clone()],
    )
    .map_err(|e| Error(e.to_string()))
}

#[derive(Debug, thiserror::Error)]
#[error("{code}")]
pub struct RuntimeImageOnlinePublicationError {
    pub code: String,
    /// Coordinator fatal/deferred/unknown-commit metadata is preserved intact.
    pub details: Value,
}
pub type OnlineResult<T> = std::result::Result<T, RuntimeImageOnlinePublicationError>;
impl From<Error> for RuntimeImageOnlinePublicationError {
    fn from(value: Error) -> Self {
        Self {
            code: value.to_string(),
            details: json!({}),
        }
    }
}
impl From<rusqlite::Error> for RuntimeImageOnlinePublicationError {
    fn from(value: rusqlite::Error) -> Self {
        Error::from(value).into()
    }
}
impl From<SqliteMutationCoordinatorError> for RuntimeImageOnlinePublicationError {
    fn from(value: SqliteMutationCoordinatorError) -> Self {
        Self {
            code: value.code.clone(),
            details: value.projection(),
        }
    }
}
fn pending(cause: impl ToString, mutation: Option<&Value>) -> RuntimeImageOnlinePublicationError {
    RuntimeImageOnlinePublicationError {
        code: "runtime_reproducibility_receipt_committed_mirror_pending".into(),
        details: json!({"committed":true,"retryableSideEffectOnly":true,"cause":cause.to_string(),
            "reservationId":mutation.map(|m|m["reservationId"].clone()),
            "sideEffectPermitHash":mutation.map(|m|m["sideEffectPermitHash"].clone())}),
    }
}
fn mutation_error(code: &str) -> SqliteMutationCoordinatorError {
    SqliteMutationCoordinatorError {
        code: code.into(),
        details: json!({}),
        state_recoverability_fatal: false,
        state_recoverability_deferred: false,
        retryable: false,
    }
}

/// Only the future verified runtime-activation chain may construct this object.
/// There is no Deserialize, boolean constructor, raw receipt setter or access to
/// its coordinator. Local tests exercise the private adapter core directly.
pub struct ActivatedRuntimeImagePublicationV1<T: MutationAuthorityTransportV1> {
    coordinator: SqliteMutationCoordinatorV1<T>,
    database_instance_id: String,
    schema_contract_id: String,
    activation_receipt_hash: String,
}
impl<T: MutationAuthorityTransportV1> ActivatedRuntimeImagePublicationV1<T> {
    pub fn activation_receipt_hash(&self) -> &str {
        &self.activation_receipt_hash
    }
    pub fn read(
        &self,
        receipt_path: &Path,
        context: &ReceiptVerificationContext<'_>,
    ) -> OnlineResult<Option<Value>> {
        read_with_coordinator(
            receipt_path,
            context,
            &self.coordinator,
            &self.database_instance_id,
        )
    }
    pub fn publish(
        &mut self,
        receipt_path: &Path,
        receipt: &Value,
        context: &ReceiptVerificationContext<'_>,
    ) -> OnlineResult<Value> {
        publish_with_coordinator(
            receipt_path,
            receipt,
            context,
            &mut self.coordinator,
            &self.database_instance_id,
            &self.schema_contract_id,
        )
    }
    pub fn recover_pending_publication(
        &mut self,
        receipt_path: &Path,
        context: &ReceiptVerificationContext<'_>,
    ) -> OnlineResult<Value> {
        recover_with_coordinator(
            receipt_path,
            context,
            &mut self.coordinator,
            &self.database_instance_id,
        )
    }
    pub fn reconcile_mirror(
        &mut self,
        receipt_path: &Path,
        context: &ReceiptVerificationContext<'_>,
    ) -> OnlineResult<Value> {
        let mut output = ExistingPublication::open(receipt_path)?;
        reconcile(
            &mut output,
            receipt_path,
            context,
            &self.coordinator,
            &self.database_instance_id,
            false,
        )
    }
}

struct ExistingPublication {
    database: Connection,
    database_path: PathBuf,
    parent: File,
    held: File,
}
impl ExistingPublication {
    fn open(receipt_path: &Path) -> Result<Self> {
        Self::open_with_mode(receipt_path, false)
    }
    fn open_with_mode(receipt_path: &Path, read_only: bool) -> Result<Self> {
        // Online execution never provisions schema or creates directories/files.
        let parent = disk::private_parent(receipt_path, false)?;
        let database_path = disk::paths(receipt_path)?;
        let held = disk::open_leaf(
            &parent,
            &database_path,
            if read_only {
                OFlag::O_RDONLY
            } else {
                OFlag::O_RDWR
            },
        )?;
        disk::verify_database(&database_path, &parent, &held)?;
        let database = Connection::open_with_flags(
            &database_path,
            (if read_only {
                OpenFlags::SQLITE_OPEN_READ_ONLY
            } else {
                OpenFlags::SQLITE_OPEN_READ_WRITE
            }) | OpenFlags::SQLITE_OPEN_NO_MUTEX
                | OpenFlags::SQLITE_OPEN_NOFOLLOW,
        )?;
        disk::verify_database(&database_path, &parent, &held)?;
        database.busy_timeout(std::time::Duration::from_secs(10))?;
        database.execute_batch("PRAGMA trusted_schema=OFF;")?;
        if read_only {
            database.execute_batch("PRAGMA query_only=ON;")?;
        }
        Ok(Self {
            database,
            database_path,
            parent,
            held,
        })
    }
    fn current(&self) -> Result<()> {
        disk::verify_database(&self.database_path, &self.parent, &self.held)
    }
}
fn mirror_reservation(
    instance: &str,
    path: &Path,
    receipt_hash: &Value,
    content_hash: &str,
) -> Result<String> {
    hash(
        "RuntimeImageReproducibilityMirrorSideEffectReservation",
        &json!({"version":1,
        "databaseInstanceId":instance,"receiptPath":path,"receiptHash":receipt_hash,"receiptContentHash":content_hash}),
    )
}
fn verify_receipt(receipt: &Value, context: &ReceiptVerificationContext<'_>) -> Result<()> {
    let inspection = verify_runtime_image_reproducibility_receipt_v2(receipt, context)?;
    ensure(
        inspection["ready"] == true
            && inspection["receiptAccepted"] == true
            && inspection["receiptHash"] == receipt["runtimeImageReproducibilityReceiptHash"],
        "runtime_reproducibility_verified_receipt_required",
    )
}
fn checked_generation(current: &Value, receipt: &Value) -> Result<i64> {
    if current.is_null() {
        return Ok(1);
    }
    let bytes = current["receipt_json"]
        .as_str()
        .filter(|s| s.len() <= 32 * 1024 * 1024)
        .ok_or("runtime_reproducibility_receipt_authority_state_invalid")?
        .as_bytes();
    let old = parse(bytes)?;
    let generation = current["publication_generation"]
        .as_i64()
        .filter(|n| (1..9_007_199_254_740_991).contains(n))
        .ok_or("runtime_reproducibility_receipt_generation_exhausted")?;
    ensure(
        rehash(
            "RuntimeImageReproducibilityReceipt",
            &old,
            "runtimeImageReproducibilityReceiptHash",
        ) && digest(bytes) == current["receipt_content_hash"]
            && old["runtimeImageReproducibilityReceiptHash"] == current["receipt_hash"]
            && old["issuedAt"] == current["issued_at"]
            && old["expiresAt"] == current["expires_at"],
        "runtime_reproducibility_receipt_authority_state_invalid",
    )?;
    let identical = old["runtimeImageReproducibilityReceiptHash"]
        == receipt["runtimeImageReproducibilityReceiptHash"]
        && old["issuedAt"] == receipt["issuedAt"];
    let newer = instant(&receipt["issuedAt"])
        .zip(instant(&old["issuedAt"]))
        .is_some_and(|(a, b)| a > b)
        && instant(&receipt["expiresAt"])
            .zip(instant(&old["expiresAt"]))
            .is_some_and(|(a, b)| a > b);
    ensure(
        identical || newer,
        "runtime_reproducibility_receipt_monotonic_cas_rejected",
    )?;
    generation
        .checked_add(1)
        .ok_or_else(|| "runtime_reproducibility_receipt_generation_exhausted".into())
}

fn publish_with_coordinator<T: MutationAuthorityTransportV1>(
    receipt_path: &Path,
    receipt: &Value,
    context: &ReceiptVerificationContext<'_>,
    coordinator: &mut SqliteMutationCoordinatorV1<T>,
    instance: &str,
    schema_contract: &str,
) -> OnlineResult<Value> {
    verify_receipt(receipt, context)?;
    let mut bytes = serde_json::to_vec_pretty(receipt)
        .map_err(|_| Error("runtime_reproducibility_json_invalid".into()))?;
    bytes.push(b'\n');
    ensure(
        bytes.len() <= 32 * 1024 * 1024,
        "runtime_reproducibility_receipt_file_invalid",
    )?;
    let content_hash = digest(&bytes);
    let receipt_hash = &receipt["runtimeImageReproducibilityReceiptHash"];
    let reservation_hash = mirror_reservation(instance, receipt_path, receipt_hash, &content_hash)?;
    let mut output = ExistingPublication::open(receipt_path)?;
    let ExistingPublication {
        database,
        database_path,
        parent,
        held,
    } = &mut output;
    let mutation = coordinator.execute_mutation(database, &json!({
        "databaseRole":PUBLICATION_DATABASE_ROLE,"databaseInstanceId":instance,
        "schemaContractId":schema_contract,"writerId":PUBLICATION_WRITER_ID,"operationId":PUBLICATION_OPERATION_ID,
        "codeProvenanceHash":runtime_image_publication_writer_plan_hash_v1()?,
        "authorizationReceiptHashes":[],"sideEffectReservationHashes":[reservation_hash]}), |transaction| {
            disk::verify_database(database_path, parent, held).map_err(|e|mutation_error(&e.to_string()))?;
            let current = transaction.get("runtime-publication.current.get.v1", &[])?;
            let generation = checked_generation(&current, receipt).map_err(|e|mutation_error(&e.to_string()))?;
            let text = std::str::from_utf8(&bytes).map_err(|_|mutation_error("runtime_reproducibility_json_invalid"))?;
            transaction.run("runtime-publication.receipt.upsert.v1", &[
                SqlValue::Text(text.into()),SqlValue::Text(content_hash.clone()),SqlValue::Text(s(receipt_hash).into()),
                SqlValue::Text(s(&receipt["issuedAt"]).into()),SqlValue::Text(s(&receipt["expiresAt"]).into()),
                SqlValue::Integer(generation),SqlValue::Text(context.now.into())])?;
            disk::verify_database(database_path, parent, held).map_err(|e|mutation_error(&e.to_string()))?;
            Ok(json!({"publicationGeneration":generation,"receiptHash":receipt_hash,"receiptContentHash":content_hash,"reservationHash":reservation_hash}))
        })?;
    let value = &mutation["value"];
    if mutation["status"] != "externally_fenced_sqlite_mutation_finalized"
        || !sha(&mutation["sideEffectPermitHash"])
        || value["receiptHash"] != *receipt_hash
        || value["receiptContentHash"] != content_hash
        || value["reservationHash"] != reservation_hash
        || value["publicationGeneration"]
            .as_i64()
            .is_none_or(|n| n < 1)
    {
        return Err(pending(
            "runtime_reproducibility_publication_mutation_receipt_invalid",
            Some(&mutation),
        ));
    }
    let mirror = reconcile(
        &mut output,
        receipt_path,
        context,
        coordinator,
        instance,
        false,
    )
    .map_err(|e| pending(e, Some(&mutation)))?;
    let payload = json!({"version":2,"kind":"RuntimeImageReproducibilityReceiptPublication",
        "status":"runtime_image_reproducibility_receipt_published","receiptPath":receipt_path,
        "publicationDatabasePath":output.database_path,"publicationGeneration":value["publicationGeneration"],
        "receiptHash":receipt_hash,"receiptContentHash":content_hash,"issuedAt":receipt["issuedAt"],"expiresAt":receipt["expiresAt"],
        "sqliteAuthorityAtomicPublication":true,"sqliteAuthorityDurablePublication":true,"sqliteMonotonicCompareAndSwap":true,
        "derivedJsonMirror":true,"derivedJsonMirrorCrashRecoverable":true,"crossResourceAtomicPublicationClaimed":false,
        "mirrorSideEffectPermitHash":mirror["sideEffectPermitHash"],"mirrorReconciledToReceiptHash":mirror["receiptHash"],
        "receiptRemainedCurrentAtMirrorReconciliation":mirror["receiptHash"] == *receipt_hash,
        "currentCodeReleaseAndInputClosureDriftMustRevalidate":true,"externalActionPerformed":false});
    Ok(seal(
        "RuntimeImageReproducibilityReceiptPublication",
        payload,
        "runtimeImageReproducibilityReceiptPublicationHash",
    )?)
}
fn reconcile<T: MutationAuthorityTransportV1>(
    output: &mut ExistingPublication,
    path: &Path,
    context: &ReceiptVerificationContext<'_>,
    coordinator: &SqliteMutationCoordinatorV1<T>,
    instance: &str,
    only_if_needed: bool,
) -> OnlineResult<Value> {
    output.current()?;
    let tx = output
        .database
        .transaction_with_behavior(TransactionBehavior::Immediate)?;
    let Some(current) = disk::authority(&tx)? else {
        tx.commit()?;
        return Ok(Value::Null);
    };
    verify_receipt(&current.receipt, context)?;
    let permit_hash = verified_mirror_permit(&tx, path, coordinator, instance, &current)?;
    let unchanged =
        only_if_needed && read(path, 32 * 1024 * 1024).is_ok_and(|bytes| bytes == current.bytes);
    disk::verify_database(&output.database_path, &output.parent, &output.held)?;
    if !unchanged {
        disk::durable_mirror(path, &output.parent, &current.bytes)?;
    }
    disk::verify_database(&output.database_path, &output.parent, &output.held)?;
    tx.commit()?;
    Ok(
        json!({"receiptHash":current.receipt_hash,"receiptContentHash":current.content_hash,
        "publicationGeneration":current.generation,"sideEffectPermitHash":if unchanged{Value::Null}else{permit_hash.into()}}),
    )
}

fn verified_mirror_permit<T: MutationAuthorityTransportV1>(
    database: &Connection,
    path: &Path,
    coordinator: &SqliteMutationCoordinatorV1<T>,
    instance: &str,
    current: &disk::Authority,
) -> OnlineResult<String> {
    let expected = mirror_reservation(
        instance,
        path,
        &json!(current.receipt_hash),
        &current.content_hash,
    )?;
    // Reverify the actual signed journal, including restart/recovery, rather than
    // accepting an in-memory hash assertion or structurally valid local JSON.
    let verified = coordinator.verify_latest_finalized_mutation(database, instance)?;
    let permit = verified.value();
    ensure(
        permit["databaseRole"] == PUBLICATION_DATABASE_ROLE
            && permit["databaseInstanceId"] == instance
            && permit["writerId"] == PUBLICATION_WRITER_ID
            && permit["operationId"] == PUBLICATION_OPERATION_ID
            && permit["sideEffectReservationHashes"] == json!([expected])
            && sha(&permit["sideEffectPermitHash"]),
        "runtime_reproducibility_receipt_side_effect_permit_invalid",
    )?;
    verify_signed_generation(database, permit, current.generation)?;
    Ok(s(&permit["sideEffectPermitHash"]).into())
}

fn read_with_coordinator<T: MutationAuthorityTransportV1>(
    path: &Path,
    context: &ReceiptVerificationContext<'_>,
    coordinator: &SqliteMutationCoordinatorV1<T>,
    instance: &str,
) -> OnlineResult<Option<Value>> {
    ensure(
        path.is_absolute(),
        "runtime_reproducibility_receipt_path_invalid",
    )?;
    let candidate = PathBuf::from(format!("{}.publication.sqlite", path.display()));
    if !candidate.try_exists().map_err(Error::from)? {
        return Ok(None);
    }
    let mut output = ExistingPublication::open_with_mode(path, true)?;
    let tx = output
        .database
        .transaction_with_behavior(TransactionBehavior::Deferred)?;
    let Some(current) = disk::authority(&tx)? else {
        tx.commit()?;
        return Ok(None);
    };
    let permit = verified_mirror_permit(&tx, path, coordinator, instance, &current)?;
    let mirror = read(path, 32 * 1024 * 1024)
        .map_err(|_| Error("runtime_reproducibility_receipt_mirror_drift".into()))?;
    ensure(
        mirror == current.bytes,
        "runtime_reproducibility_receipt_mirror_drift",
    )?;
    let inspection = verify_runtime_image_reproducibility_receipt_v2(&current.receipt, context)?;
    disk::verify_database(&output.database_path, &output.parent, &output.held)?;
    tx.commit()?;
    Ok(Some(
        json!({"receipt":current.receipt,"inspection":inspection,"receiptContentHash":current.content_hash,
        "publicationGeneration":current.generation,"mirrorSideEffectPermitHash":permit}),
    ))
}

fn verify_signed_generation(
    database: &Connection,
    permit: &Value,
    generation: i64,
) -> OnlineResult<()> {
    use rusqlite::{
        fallible_streaming_iterator::FallibleStreamingIterator, hooks::Action,
        session::ChangesetIter, types::ValueRef,
    };
    let encoded: String = database.query_row(
        "SELECT reserve_request_json FROM autonomous_research_online_mutation_authority_marker WHERE reservation_id=?",
        [s(&permit["reservationId"])], |r|r.get(0))?;
    ensure(
        encoded.len() <= 32 * 1024 * 1024,
        "runtime_reproducibility_receipt_side_effect_reservation_invalid",
    )?;
    let request = parse(encoded.as_bytes())?;
    let bytes = crate::sqlite_mutation_coordinator::contracts::canonical_changeset_v1(s(
        &request["changesetBase64"]
    ))?;
    ensure(
        digest(&bytes) == permit["changesetHash"],
        "runtime_reproducibility_receipt_side_effect_reservation_invalid",
    )?;
    let effects = crate::sqlite_changeset::inspect_sqlite_changeset_effects_v1(&bytes)
        .map_err(|e| Error(e.to_string()))?;
    ensure(
        effects.len() == 1
            && effects[0].table == "runtime_image_reproducibility_receipt"
            && ["INSERT", "UPDATE"].contains(&effects[0].operation.as_str()),
        "runtime_reproducibility_receipt_side_effect_reservation_invalid",
    )?;
    let mut input = std::io::Cursor::new(bytes);
    let stream: &mut dyn std::io::Read = &mut input;
    let mut iterator = ChangesetIter::start_strm(&stream)?;
    let change = iterator.next()?.ok_or_else(|| {
        Error("runtime_reproducibility_receipt_side_effect_reservation_invalid".into())
    })?;
    let operation = change.op()?;
    let primary_key = if operation.code() == Action::SQLITE_INSERT {
        change.new_value(0)?
    } else {
        change.old_value(0)?
    };
    ensure(
        operation.table_name() == "runtime_image_reproducibility_receipt"
            && operation.number_of_columns() == 8
            && !operation.indirect()
            && primary_key == ValueRef::Integer(1)
            && change.new_value(6)? == ValueRef::Integer(generation),
        "runtime_reproducibility_receipt_generation_not_signed",
    )?;
    Ok(())
}
fn recover_with_coordinator<T: MutationAuthorityTransportV1>(
    path: &Path,
    context: &ReceiptVerificationContext<'_>,
    coordinator: &mut SqliteMutationCoordinatorV1<T>,
    instance: &str,
) -> OnlineResult<Value> {
    let mut output = ExistingPublication::open(path)?;
    let recovery = coordinator.recover_pending_mutations(&mut output.database)?;
    ensure(
        recovery["version"] == 1
            && recovery["kind"] == "ExternallyFencedSqliteMutationRecoveryReceipt"
            && recovery["status"] == "externally_fenced_sqlite_mutation_recovery_complete"
            && recovery["recoveredReservationIds"].is_array(),
        "runtime_reproducibility_publication_recovery_receipt_invalid",
    )?;
    let mirror = reconcile(&mut output, path, context, coordinator, instance, true)?;
    Ok(
        json!({"version":1,"kind":"RuntimeImageReproducibilityPendingPublicationRecovery",
        "status":"runtime_image_reproducibility_pending_publication_recovered",
        "recoveredReservationIds":recovery["recoveredReservationIds"],"mirror":mirror}),
    )
}

#[cfg(test)]
#[path = "online_publication_tests.rs"]
mod tests;
