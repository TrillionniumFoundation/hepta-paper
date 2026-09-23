import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import {
  parseGeneration,
} from './autonomous-research-topic-producer-repository-support.mjs';
import {
  parseRow,
} from './autonomous-research-machine-intake-repository-support.mjs';
import {
  assertMachineIntakeAuthorityState,
} from './autonomous-research-machine-intake-authority.mjs';

const STATE_INVALID = 'autonomous_research_machine_intake_authority_rotation_state_invalid';
const STATE_MISSING = 'autonomous_research_machine_intake_authority_rotation_state_missing';
const SHA256 = /^sha256:[0-9a-f]{64}$/;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9_.:@-]{0,255}$/;
const SUPERVISOR_SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9_.:@/-]{0,255}$/;
const MACHINE_SOURCE_KINDS = new Set(['machine', 'recurring-golden', 'static-file']);
const MACHINE_DISPOSITIONS = new Set(['invalid', 'pending', 'enqueued', 'superseded']);
const SUPERVISOR_STATUSES = new Set(['running', 'stopped']);
const TOPIC_GENERATION_STATUSES = new Set(['planned', 'authorized', 'produced', 'failed']);
const DATABASE_SCHEMAS = new Set(['main', 'supervisor', 'topic']);
const DATABASE_TABLES = Object.freeze([
  ['autonomous_research_machine_intake', 'intake_id'],
  ['autonomous_research_machine_intake_lease', 'intake_id'],
  ['autonomous_research_machine_intake_daily_admission', 'epoch_start'],
  ['autonomous_research_machine_intake_migration_quarantine', 'migration_id'],
  ['autonomous_research_machine_intake_authority_rotation', 'authority_generation'],
]);
const TOPIC_TABLES = Object.freeze([
  ['autonomous_research_topic_producer_metadata', 'singleton'],
  ['autonomous_research_topic_producer_lease', 'singleton'],
  ['autonomous_research_topic_producer_generation', 'generation_sequence'],
  ['autonomous_research_topic_producer_daily_budget', 'epoch_start'],
]);

function stateInvalid() {
  throw new Error(STATE_INVALID);
}

function stateBoundary(operation) {
  try {
    return operation();
  } catch (error) {
    if (error?.message === STATE_INVALID || error?.message === STATE_MISSING) throw error;
    return stateInvalid();
  }
}

function schemaName(value) {
  if (!DATABASE_SCHEMAS.has(value)) stateInvalid();
  return value;
}

function safeInteger(value, minimum = 0) {
  return Number.isSafeInteger(value) && value >= minimum;
}

function safeNumber(value, minimum = 0) {
  return typeof value === 'number' && Number.isFinite(value) && value >= minimum;
}

function safeIdentity(value, pattern = SAFE_ID) {
  return typeof value === 'string' && pattern.test(value);
}

function nullable(value) {
  return value === null || value === undefined;
}

function sha256(value) {
  return typeof value === 'string' && SHA256.test(value);
}

function nullableSha256(value) {
  return nullable(value) || sha256(value);
}

function canonicalInstant(value) {
  if (typeof value !== 'string') return false;
  const milliseconds = Date.parse(value);
  return Number.isFinite(milliseconds) && new Date(milliseconds).toISOString() === value;
}

function nullableCanonicalInstant(value) {
  return nullable(value) || canonicalInstant(value);
}

function orderedInstants(first, second, { equal = true } = {}) {
  if (!canonicalInstant(first) || !canonicalInstant(second)) return false;
  return equal ? first <= second : first < second;
}

function validateMachineIntakeRows(intakes) {
  for (const row of intakes) {
    try { parseRow(row); } catch { stateInvalid(); }
    if (!safeIdentity(row.intake_id) || !safeIdentity(row.paper_id)
      || !safeIdentity(row.campaign_id) || !sha256(row.intake_hash)
      || !sha256(row.source_authority_hash)
      || !MACHINE_SOURCE_KINDS.has(row.source_kind)
      || !MACHINE_DISPOSITIONS.has(row.disposition)
      || !safeInteger(row.lease_generation)
      || !safeInteger(row.failure_count)
      || !nullableSha256(row.campaign_plan_hash)
      || !nullableSha256(row.preparation_hash)
      || !nullableCanonicalInstant(row.enqueued_at)
      || !canonicalInstant(row.next_attempt_at)
      || !canonicalInstant(row.created_at)
      || !canonicalInstant(row.updated_at)
      || !orderedInstants(row.created_at, row.updated_at)
      || (Object.hasOwn(row, 'admission_hash') && !sha256(row.admission_hash))) {
      stateInvalid();
    }
  }
}

function validateMachineLeaseRows(leases, intakes) {
  const intakeById = new Map(intakes.map((row) => [row.intake_id, row]));
  for (const row of leases) {
    const intake = intakeById.get(row.intake_id);
    if (!safeIdentity(row.intake_id) || !safeIdentity(row.owner_id)
      || !safeIdentity(row.lease_token) || !safeInteger(row.lease_generation, 1)
      || !orderedInstants(row.acquired_at, row.renewed_at)
      || !orderedInstants(row.renewed_at, row.expires_at, { equal: false })
      || !intake || intake.lease_generation !== row.lease_generation) {
      stateInvalid();
    }
  }
}

function validateMachineDailyRows(dailyRows) {
  for (const row of dailyRows) {
    if (!canonicalInstant(row.epoch_start) || !canonicalInstant(row.updated_at)
      || !safeInteger(row.machine_append_count)
      || !safeNumber(row.reserved_cost_usd)
      || !safeInteger(row.reserved_agent_calls)
      || !safeInteger(row.reserved_gpu_jobs)) stateInvalid();
  }
}

function validateMachineQuarantineRows(quarantineRows) {
  for (const row of quarantineRows) {
    if (!safeInteger(row.migration_id, 1)
      || (!nullable(row.legacy_intake_id) && !safeIdentity(row.legacy_intake_id))
      || typeof row.legacy_row_json !== 'string' || !row.legacy_row_json
      || typeof row.reason !== 'string' || !row.reason
      || !canonicalInstant(row.quarantined_at)) stateInvalid();
  }
}

function validateMachineRotationRows(rotationRows) {
  for (const row of rotationRows) {
    const requiredHashes = [
      row.previous_configuration_hash,
      row.next_configuration_hash,
      row.next_producer_profile_hash,
      row.next_provider_configuration_hash,
      row.next_implementation_sha256,
      row.plan_hash,
      row.rotation_intent_hash,
      row.authority_trust_store_hash,
      row.owner_trust_store_hash,
      row.bootstrap_receipt_hash,
      row.authority_anchor_hash,
      row.rotator_key_snapshot_hash,
      row.pre_state_hash,
      row.quiescence_state_hash,
      row.post_state_hash,
      row.rotation_receipt_hash,
    ];
    const optionalHashColumns = [
      'previous_producer_profile_hash',
      'previous_rotation_receipt_hash',
    ];
    if (!safeInteger(row.authority_generation, 2)
      || row.transition !== 'v1-to-v2'
      || requiredHashes.some((value) => !sha256(value))
      || optionalHashColumns.some((column) => Object.hasOwn(row, column)
        && !nullableSha256(row[column]))
      || !safeIdentity(row.intent_nonce)
      || !safeIdentity(row.verified_signer_key_id)
      || !safeIdentity(row.verified_signer_subject_id, SUPERVISOR_SAFE_ID)
      || !safeIdentity(row.verified_signer_role)
      || ['bootstrap_verified_signers_json', 'rotator_public_key_snapshot_json',
        'verified_signer_json', 'rotation_intent_json', 'rotation_receipt_json']
        .some((column) => typeof row[column] !== 'string' || !row[column])
      || !safeInteger(row.quarantined_legacy_machine_admission_count)
      || !canonicalInstant(row.rotated_at)) stateInvalid();
  }
}

function validateSupervisorRows(supervisorRows) {
  for (const row of supervisorRows) {
    const requiredTimes = [row.created_at, row.updated_at];
    const optionalTimes = [
      row.started_at,
      row.last_heartbeat_at,
      row.lease_expires_at,
      row.startup_reconciled_at,
      row.machine_intake_reconciled_at,
      row.machine_intake_reconciliation_failed_at,
      row.last_cycle_at,
      row.stopped_at,
    ];
    const receiptPairsValid = nullable(row.startup_reconciliation_receipt_hash)
      === nullable(row.startup_reconciled_at)
      && nullable(row.machine_intake_reconciliation_receipt_hash)
        === nullable(row.machine_intake_reconciled_at)
      && nullable(row.machine_intake_reconciliation_receipt_hash)
        === nullable(row.machine_intake_configuration_hash)
      && nullable(row.machine_intake_reconciliation_failure)
        === nullable(row.machine_intake_reconciliation_failed_at)
      && nullable(row.last_cycle_receipt_hash) === nullable(row.last_cycle_at);
    if (!safeIdentity(row.scope_id, SUPERVISOR_SAFE_ID)
      || !SUPERVISOR_STATUSES.has(row.status)
      || !safeInteger(row.lease_generation, 1)
      || !safeInteger(row.lease_duration_ms, 1000)
      || row.lease_duration_ms > 30 * 60 * 1000
      || !safeInteger(row.heartbeat_interval_ms, 250)
      || row.heartbeat_interval_ms * 2 >= row.lease_duration_ms
      || !safeInteger(row.recovered_lease_count)
      || requiredTimes.some((value) => !canonicalInstant(value))
      || optionalTimes.some((value) => !nullableCanonicalInstant(value))
      || !orderedInstants(row.created_at, row.updated_at)
      || !receiptPairsValid
      || !nullableSha256(row.startup_reconciliation_receipt_hash)
      || !nullableSha256(row.machine_intake_reconciliation_receipt_hash)
      || !nullableSha256(row.machine_intake_configuration_hash)
      || !nullableSha256(row.last_cycle_receipt_hash)) stateInvalid();
    if (row.status === 'running') {
      if (!safeIdentity(row.owner_id, SUPERVISOR_SAFE_ID)
        || !safeIdentity(row.lease_token, SUPERVISOR_SAFE_ID)
        || !canonicalInstant(row.started_at)
        || !canonicalInstant(row.last_heartbeat_at)
        || !orderedInstants(row.last_heartbeat_at, row.lease_expires_at, { equal: false })
        || !nullable(row.stopped_at) || !nullable(row.stop_reason)) stateInvalid();
    } else if (!nullable(row.owner_id) || !nullable(row.lease_token)
      || !nullable(row.lease_expires_at) || !canonicalInstant(row.stopped_at)) {
      stateInvalid();
    }
  }
}

function validateTopicMetadataRows(metadataRows, generationRows) {
  if (metadataRows.length !== 1) stateInvalid();
  const row = metadataRows[0];
  const highSequence = generationRows.reduce(
    (highest, generation) => Math.max(highest, generation.generation_sequence),
    0,
  );
  if (row.singleton !== 1 || !sha256(row.machine_intake_configuration_hash)
    || !sha256(row.producer_profile_hash) || !sha256(row.provider_configuration_hash)
    || !sha256(row.implementation_sha256) || !safeInteger(row.lease_generation)
    || !safeInteger(row.generation_high_watermark)
    || row.generation_high_watermark < highSequence
    || !nullableCanonicalInstant(row.last_observed_at)
    || !nullableCanonicalInstant(row.last_produced_at)
    || !nullableCanonicalInstant(row.next_attempt_at)) stateInvalid();
}

function validateTopicLeaseRows(leaseRows, metadataRows) {
  if (leaseRows.length > 1) stateInvalid();
  for (const row of leaseRows) {
    if (row.singleton !== 1 || !safeIdentity(row.owner_id) || !safeIdentity(row.lease_token)
      || !safeInteger(row.lease_generation, 1)
      || !orderedInstants(row.acquired_at, row.renewed_at)
      || !orderedInstants(row.renewed_at, row.expires_at, { equal: false })
      || metadataRows.length !== 1
      || metadataRows[0].lease_generation !== row.lease_generation) stateInvalid();
  }
}

function validateTopicGenerationRows(generationRows) {
  for (const row of generationRows) {
    const capabilityAbsent = nullable(row.capability_hash)
      && nullable(row.capability_nonce) && nullable(row.capability_json);
    const capabilityPresent = sha256(row.capability_hash)
      && safeIdentity(row.capability_nonce)
      && typeof row.capability_json === 'string' && row.capability_json.length > 0;
    const intakeAbsent = nullable(row.intake_id)
      && nullable(row.intake_hash) && nullable(row.admission_hash);
    const intakePresent = safeIdentity(row.intake_id)
      && sha256(row.intake_hash) && sha256(row.admission_hash);
    if (!safeInteger(row.generation_sequence, 1)
      || !TOPIC_GENERATION_STATUSES.has(row.status)
      || !safeInteger(row.lease_generation, 1)
      || !safeIdentity(row.producer_topic_id)
      || !sha256(row.topic_fingerprint)
      || !sha256(row.canonical_research_topic_hash)
      || !safeIdentity(row.budget_reservation_id)
      || !canonicalInstant(row.budget_epoch_start)
      || Date.parse(row.budget_epoch_start) % (24 * 60 * 60 * 1000) !== 0
      || !sha256(row.planned_generation_hash)
      || typeof row.planned_generation_json !== 'string' || !row.planned_generation_json
      || !canonicalInstant(row.created_at) || !canonicalInstant(row.updated_at)
      || !orderedInstants(row.created_at, row.updated_at)
      || (!capabilityAbsent && !capabilityPresent)
      || (!intakeAbsent && !intakePresent)
      || (row.status === 'planned' && (!capabilityAbsent || !intakeAbsent))
      || (row.status === 'authorized' && (!capabilityPresent || !intakeAbsent))
      || (row.status === 'produced' && (!capabilityPresent || !intakePresent))
      || (row.status === 'failed' && (typeof row.error !== 'string' || !row.error))) {
      stateInvalid();
    }
    try { parseGeneration(row); } catch { stateInvalid(); }
  }
}

function validateTopicDailyRows(dailyRows) {
  for (const row of dailyRows) {
    if (!canonicalInstant(row.epoch_start) || !canonicalInstant(row.updated_at)
      || !safeInteger(row.provider_canary_attempt_count)
      || !safeNumber(row.provider_canary_reserved_cost_usd)
      || !safeInteger(row.produced_topic_count)) stateInvalid();
  }
}

export function databasePaths(runtimeRoot) {
  if (!runtimeRoot) {
    throw new Error('autonomous_research_machine_intake_authority_rotation_runtime_root_required');
  }
  const root = path.resolve(runtimeRoot);
  return Object.freeze({
    machine: path.join(root, 'autonomous-research', 'machine-intake', 'machine-intake.sqlite'),
    supervisor: path.join(root, 'autonomous-research', 'supervisor', 'resident-instance.sqlite'),
    topic: path.join(root, 'autonomous-research', 'topic-producer', 'topic-producer.sqlite'),
  });
}

export function validateDatabaseFile(candidate, { required = false } = {}) {
  if (!fs.existsSync(candidate)) {
    if (required) throw new Error(STATE_MISSING);
    return false;
  }
  let stat;
  try { stat = fs.lstatSync(candidate); } catch { stateInvalid(); }
  if (!stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o022) !== 0) {
    throw new Error('autonomous_research_machine_intake_authority_rotation_database_invalid');
  }
  return true;
}

export function validateDatabaseIntegrity(database, schemas = ['main']) {
  return stateBoundary(() => {
    const requested = typeof schemas === 'string' ? [schemas] : schemas;
    if (!database || !Array.isArray(requested) || requested.length === 0) stateInvalid();
    for (const requestedSchema of requested) {
      const schema = schemaName(requestedSchema);
      const quickCheck = database.prepare(`PRAGMA ${schema}.quick_check`).all();
      if (quickCheck.length !== 1 || Object.values(quickCheck[0]).length !== 1
        || Object.values(quickCheck[0])[0] !== 'ok') stateInvalid();
      if (database.prepare(`PRAGMA ${schema}.foreign_key_check`).all().length !== 0) {
        stateInvalid();
      }
    }
    return true;
  });
}

export function validateAttachedDatabaseIntegrity(database, {
  supervisorAttached = false,
  topicAttached = false,
} = {}) {
  return validateDatabaseIntegrity(database, [
    'main',
    ...(supervisorAttached ? ['supervisor'] : []),
    ...(topicAttached ? ['topic'] : []),
  ]);
}

export function tableExists(database, table, schema = 'main') {
  const selectedSchema = schemaName(schema);
  return Boolean(database.prepare(`SELECT name FROM ${selectedSchema}.sqlite_master
    WHERE type='table' AND name=?`).get(table));
}

export function rows(database, table, orderBy, schema = 'main') {
  const selectedSchema = schemaName(schema);
  if (!tableExists(database, table, selectedSchema)) return Object.freeze([]);
  return Object.freeze(database.prepare(
    `SELECT * FROM ${selectedSchema}.${table} ORDER BY ${orderBy}`,
  ).all());
}

export function normalizedMetadata(database, schema = 'main') {
  return stateBoundary(() => {
    const selectedSchema = schemaName(schema);
    if (!tableExists(
      database,
      'autonomous_research_machine_intake_metadata',
      selectedSchema,
    )) throw new Error(STATE_MISSING);
    const metadataRows = database.prepare(`SELECT * FROM ${selectedSchema}.
      autonomous_research_machine_intake_metadata ORDER BY singleton`).all();
    if (metadataRows.length !== 1) stateInvalid();
    const row = metadataRows[0];
    const generation = row.authority_generation ?? 1;
    if (row.singleton !== 1 || !sha256(row.configured_source_authority_hash)
      || !nullableSha256(row.authorized_machine_producer_profile_hash)
      || !nullableSha256(row.last_authority_rotation_receipt_hash)
      || !safeInteger(generation, 1)) stateInvalid();
    return Object.freeze({
      configuredSourceAuthorityHash: row.configured_source_authority_hash,
      authorizedMachineProducerProfileHash:
        row.authorized_machine_producer_profile_hash ?? null,
      authorityGeneration: generation,
      lastAuthorityRotationReceiptHash: row.last_authority_rotation_receipt_hash ?? null,
    });
  });
}

export function machineSnapshot(database, schema = 'main') {
  return stateBoundary(() => {
    if (schema === 'main') assertMachineIntakeAuthorityState(database);
    const metadata = normalizedMetadata(database, schema);
    const tables = Object.fromEntries(DATABASE_TABLES.map(([table, orderBy]) => [
      table,
      rows(database, table, orderBy, schema),
    ]));
    validateMachineIntakeRows(tables.autonomous_research_machine_intake);
    validateMachineLeaseRows(
      tables.autonomous_research_machine_intake_lease,
      tables.autonomous_research_machine_intake,
    );
    validateMachineDailyRows(tables.autonomous_research_machine_intake_daily_admission);
    validateMachineQuarantineRows(
      tables.autonomous_research_machine_intake_migration_quarantine,
    );
    validateMachineRotationRows(
      tables.autonomous_research_machine_intake_authority_rotation,
    );
    return Object.freeze({ metadata, tables: Object.freeze(tables) });
  });
}

export function supervisorSnapshot(database, schema = 'main') {
  return stateBoundary(() => {
    if (!database || !tableExists(
      database,
      'autonomous_research_supervisor_instance',
      schema,
    )) return Object.freeze({ databasePresent: Boolean(database), rows: Object.freeze([]) });
    const supervisorRows = rows(
      database,
      'autonomous_research_supervisor_instance',
      'scope_id',
      schema,
    );
    validateSupervisorRows(supervisorRows);
    return Object.freeze({ databasePresent: true, rows: supervisorRows });
  });
}

export function topicSnapshot(database, schema = 'main') {
  return stateBoundary(() => {
    if (!database) {
      return Object.freeze({ databasePresent: false, tables: Object.freeze({}) });
    }
    const tables = Object.fromEntries(TOPIC_TABLES.map(([table, orderBy]) => [
      table,
      rows(database, table, orderBy, schema),
    ]));
    const metadataTablePresent = tableExists(
      database,
      'autonomous_research_topic_producer_metadata',
      schema,
    );
    const generationRows = tables.autonomous_research_topic_producer_generation;
    if (metadataTablePresent) validateTopicMetadataRows(
      tables.autonomous_research_topic_producer_metadata,
      generationRows,
    );
    validateTopicLeaseRows(
      tables.autonomous_research_topic_producer_lease,
      tables.autonomous_research_topic_producer_metadata,
    );
    validateTopicGenerationRows(generationRows);
    validateTopicDailyRows(tables.autonomous_research_topic_producer_daily_budget);
    return Object.freeze({ databasePresent: true, tables: Object.freeze(tables) });
  });
}

export function openReadOnly(candidate, { required = false } = {}) {
  if (!validateDatabaseFile(candidate, { required })) return null;
  let database = null;
  try {
    database = new DatabaseSync(candidate, { readOnly: true });
    database.exec('PRAGMA busy_timeout=10000; PRAGMA query_only=ON;');
    validateDatabaseIntegrity(database);
    return database;
  } catch (error) {
    try { database?.close(); } catch { /* retain the validation failure */ }
    if (error?.message === STATE_INVALID) throw error;
    return stateInvalid();
  }
}

export function attachExisting(database, candidate, schema) {
  const selectedSchema = schemaName(schema);
  if (selectedSchema === 'main') stateInvalid();
  if (!validateDatabaseFile(candidate)) return false;
  return stateBoundary(() => {
    database.prepare(`ATTACH DATABASE ? AS ${selectedSchema}`).run(candidate);
    return true;
  });
}
