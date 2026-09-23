//! Replay only authenticated schema-checkpoint bytes in private SQLite copies.
//! This compares actual effective state; it grants no current authority or write.
use super::*;
use crate::{
    online_mutation_composition::BuiltinOnlineMutationPlansV1,
    online_schema_transition::history::checkpoint::VerifiedSchemaTransitionCheckpointV1,
    sqlite_mutation_coordinator::{
        authority::PinnedMutationAuthorityV1, finalized_history::VerifiedFinalizedMutationChainV1,
        manifest::writer_manifest_hash_v1,
    },
    state_database_inventory::NativeStoreTransactionInventoryGuardV1,
};

pub(crate) struct VerifiedCheckpointReplayV1 {
    report: Value,
    authority_hash: String,
}
impl VerifiedCheckpointReplayV1 {
    pub(crate) fn value(&self) -> &Value {
        &self.report
    }
    pub(crate) fn assert_matches<T: MutationAuthorityTransportV1>(
        &self,
        checkpoint: &VerifiedSchemaTransitionCheckpointV1,
        current: &ObservedStateDatabaseInventoryV1,
        chain: &VerifiedFinalizedMutationChainV1,
        authority: &PinnedMutationAuthorityV1<T>,
    ) -> Result<()> {
        self.assert_subject(checkpoint, current, chain, authority)?;
        checkpoint.assert_current(current, authority)
    }
    /// Preserve the genuine completed replay's exact input binding. Staged
    /// target writes are checked by the upper restricted operation, never by
    /// replaying a new snapshot or reopening live SQLite during its transaction.
    pub(crate) fn assert_retained_for_native_store_transaction<T: MutationAuthorityTransportV1>(
        &self,
        checkpoint: &VerifiedSchemaTransitionCheckpointV1,
        current: &ObservedStateDatabaseInventoryV1,
        chain: &VerifiedFinalizedMutationChainV1,
        authority: &PinnedMutationAuthorityV1<T>,
        guard: &NativeStoreTransactionInventoryGuardV1<'_>,
    ) -> Result<()> {
        self.assert_subject(checkpoint, current, chain, authority)?;
        checkpoint.assert_retained_for_native_store_transaction(current, authority, guard)
    }
    fn assert_subject<T: MutationAuthorityTransportV1>(
        &self,
        checkpoint: &VerifiedSchemaTransitionCheckpointV1,
        current: &ObservedStateDatabaseInventoryV1,
        chain: &VerifiedFinalizedMutationChainV1,
        authority: &PinnedMutationAuthorityV1<T>,
    ) -> Result<()> {
        ensure(
            self.authority_hash == authority.configuration_hash()
                && self.authority_hash == chain.authority_configuration_hash()
                && self.report["historicalInventoryHash"]
                    == checkpoint.historical_inventory()["inventoryHash"]
                && self.report["currentInventoryHash"] == current.value()["inventoryHash"]
                && self.report["chainHash"] == chain_hash(chain)?,
            "autonomous_research_schema_checkpoint_replay_subject_changed",
        )
    }
}
fn chain_hash(chain: &VerifiedFinalizedMutationChainV1) -> Result<String> {
    hash(
        "AutonomousResearchSchemaCheckpointFinalizedChain",
        chain.value(),
    )
}
fn same_number(a: &Value, b: &Value) -> bool {
    a.is_number() && b.is_number() && a.as_f64() == b.as_f64()
}
fn matches_genesis(head: &Value, genesis: &Value) -> bool {
    [
        ("databaseRole", "databaseRole"),
        ("databaseInstanceId", "databaseInstanceId"),
        ("schemaHash", "schemaHash"),
        ("sequence", "databaseSequence"),
        ("hash", "databaseHash"),
        ("stateHash", "stateHash"),
        ("globalSequence", "globalSequence"),
        ("globalHash", "globalHash"),
    ]
    .iter()
    .all(|(a, b)| {
        head[*a] == genesis[*b]
            || (head[*a].is_number()
                && genesis[*b].is_number()
                && head[*a].as_f64() == genesis[*b].as_f64())
    })
}
/// The source-owned registry is mandatory even for empty history. Every table
/// is compared, including duplicate/NULL-PK rows, rowid and sqlite_sequence.
/// Original DB/WAL bytes and current source paths are never opened for writes.
pub(crate) fn verify_checkpoint_effective_state_v1<T: MutationAuthorityTransportV1>(
    checkpoint: &VerifiedSchemaTransitionCheckpointV1,
    current: &ObservedStateDatabaseInventoryV1,
    chain: &VerifiedFinalizedMutationChainV1,
    authority: &PinnedMutationAuthorityV1<T>,
) -> Result<VerifiedCheckpointReplayV1> {
    checkpoint.assert_current(current, authority)?;
    authority.current()?;
    let builtin = BuiltinOnlineMutationPlansV1::load()?;
    ensure(
        chain.authority_configuration_hash() == authority.configuration_hash()
            && writer_manifest_hash_v1(builtin.writer_manifest())?
                == authority.trust()["writerManifestHash"],
        "autonomous_research_schema_checkpoint_replay_subject_changed",
    )?;
    let entries = chain.value()["entries"].as_array().ok_or_else(invalid)?;
    ensure(
        entries.len() <= 4096,
        "autonomous_research_schema_checkpoint_replay_resource_limit",
    )?;
    let registered = if entries.is_empty() {
        None
    } else {
        Some(
            registered::RegisteredJournalPlansV1::authenticate(
                builtin.writer_manifest(),
                current,
                chain,
            )?
            .ok_or_else(|| {
                error("autonomous_research_schema_checkpoint_original_registry_required")
            })?,
        )
    };
    let audit = checkpoint.schema_audit()?;
    let genesis = audit["reservation"]["databaseGenesis"]
        .as_array()
        .ok_or_else(invalid)?;
    let instances = checkpoint.historical_inventory()["instances"]
        .as_array()
        .ok_or_else(invalid)?;
    ensure(
        genesis.len() == instances.len()
            && same_number(
                &chain.value()["fromGlobalSequence"],
                &audit["finalization"]["globalSequence"],
            )
            && chain.value()["fromGlobalHash"] == audit["finalization"]["globalHash"],
        "autonomous_research_schema_checkpoint_genesis_mismatch",
    )?;
    let scratch = Scratch::new()?;
    let mut compared = Vec::new();
    for (index, expected) in instances.iter().enumerate() {
        let instance_id = text(expected, "instanceId")?;
        let original = checkpoint.database_bytes(instance_id)?;
        ensure(
            original.instance == expected,
            "autonomous_research_schema_checkpoint_genesis_mismatch",
        )?;
        let signed_genesis = genesis
            .iter()
            .find(|g| g["databaseInstanceId"] == instance_id)
            .ok_or_else(invalid)?;
        ensure(
            same_number(
                &signed_genesis["globalSequence"],
                &audit["finalization"]["globalSequence"],
            ) && signed_genesis["globalHash"] == audit["finalization"]["globalHash"],
            "autonomous_research_schema_checkpoint_genesis_mismatch",
        )?;
        let name = format!("replay-{index:03}.sqlite");
        scratch.directory.write_new(&name, original.main)?;
        if let Some(wal) = original.wal {
            scratch.directory.write_new(&format!("{name}-wal"), wal)?;
        }
        scratch.directory.assert_current()?;
        // No immutable=1: any authenticated original WAL must be visible.
        let mut database = Connection::open_with_flags(
            scratch.directory.path.join(&name),
            OpenFlags::SQLITE_OPEN_READ_WRITE
                | OpenFlags::SQLITE_OPEN_NOFOLLOW
                | OpenFlags::SQLITE_OPEN_NO_MUTEX,
        )?;
        equivalence::limit_private_sqlite(&database)?;
        database.pragma_update(None, "trusted_schema", false)?;
        let observed = super::super::sqlite_copy::inspection(&database)?;
        ensure(
            ["schemaHash", "userVersion", "applicationId"]
                .iter()
                .all(|field| observed[*field] == expected[*field]),
            "autonomous_research_schema_checkpoint_schema_mismatch",
        )?;
        let journal_rows: i64 = database.query_row(
            "SELECT (SELECT count(*) FROM autonomous_research_online_mutation_authority_marker) + (SELECT count(*) FROM autonomous_research_online_mutation_finalization_receipt)", [], |row| row.get(0))?;
        let head = checked_snapshot_head_v1(&database, expected, authority)?;
        ensure(
            journal_rows == 0 && matches_genesis(head.value(), signed_genesis),
            "autonomous_research_schema_checkpoint_genesis_mismatch",
        )?;
        if let Some(registered) = &registered {
            registered.assert_database_surface(&database, expected, chain)?;
        }
        let replayed = replay_verified_database_v1(&mut database, expected, chain, authority)?;
        let replay_digest = equivalence::effective_digest(&database)?;
        let current_digest = current.with_database_snapshot(instance_id, |path| {
            let live = Connection::open_with_flags(
                path,
                OpenFlags::SQLITE_OPEN_READ_ONLY
                    | OpenFlags::SQLITE_OPEN_NOFOLLOW
                    | OpenFlags::SQLITE_OPEN_NO_MUTEX,
            )?;
            equivalence::limit_private_sqlite(&live)?;
            live.pragma_update(None, "trusted_schema", false)?;
            let live_head = checked_snapshot_head_v1(&live, expected, authority)?;
            ensure(
                canonical_equal(live_head.value(), replayed.value())?,
                "autonomous_research_schema_checkpoint_current_head_mismatch",
            )?;
            ensure(
                super::super::sqlite_copy::inspection(&live)?
                    == super::super::sqlite_copy::inspection(&database)?,
                "autonomous_research_schema_checkpoint_schema_mismatch",
            )?;
            equivalence::effective_digest(&live)
        })?;
        ensure(
            replay_digest == current_digest,
            "autonomous_research_schema_checkpoint_effective_state_mismatch",
        )?;
        compared.push(json!({"databaseInstanceId":instance_id,"effectiveStateHash":format!("sha256:{}",hex::encode(replay_digest))}));
        drop(database);
        scratch.directory.assert_current()?;
    }
    checkpoint.assert_current(current, authority)?;
    authority.current()?;
    let result = VerifiedCheckpointReplayV1 {
        report: json!({"version":1,"kind":"AutonomousResearchSchemaCheckpointReplay",
            "historicalInventoryHash":checkpoint.historical_inventory()["inventoryHash"],
            "currentInventoryHash":current.value()["inventoryHash"],"chainHash":chain_hash(chain)?,
            "databases":compared,"runtimeReady":false,"productionActivation":false}),
        authority_hash: authority.configuration_hash().into(),
    };
    result.assert_matches(checkpoint, current, chain, authority)?;
    Ok(result)
}
