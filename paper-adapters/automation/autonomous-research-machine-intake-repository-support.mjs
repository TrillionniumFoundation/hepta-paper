import path from 'node:path';

import {
  verifyAutonomousResearchMachineIntake,
  verifyAutonomousResearchRecurringGoldenIntake,
} from '../../paper-domain/automation/autonomous-research-machine-intake-contract.mjs';
import {
  buildAutonomousResearchMachineIntakeAdmission,
  verifyAutonomousResearchMachineIntakeAdmission,
} from '../../paper-domain/automation/autonomous-research-machine-intake-admission-contract.mjs';

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9_.:@-]{0,255}$/;
const SHA256 = /^sha256:[0-9a-f]{64}$/;
const SOURCE_KINDS = new Set(['machine', 'recurring-golden', 'static-file']);
const DISPOSITIONS = new Set(['invalid', 'pending', 'enqueued', 'superseded']);
const DAY_MS = 24 * 60 * 60 * 1000;
const MACHINE_ADMISSION_MAXIMUM_AGE_MS = 5 * 60 * 1000;

function hasControlCharacters(value) {
  return [...value].some((character) => {
    const point = character.codePointAt(0);
    return point < 32 || point === 127;
  });
}

export function observedDate(value) {
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) {
    throw new Error('autonomous_research_machine_intake_clock_invalid');
  }
  return date;
}

export function utcDayStart(date) {
  return new Date(Math.floor(date.getTime() / DAY_MS) * DAY_MS).toISOString();
}

export function canonicalSource({
  intake,
  sourceKind,
  sourceRef,
  sourceAuthorityHash,
  authorizedSourceAuthorityHash,
  sourceTemplate,
} = {}) {
  if (!SOURCE_KINDS.has(sourceKind) || typeof sourceRef !== 'string'
    || Buffer.byteLength(sourceRef) > 4096 || hasControlCharacters(sourceRef)
    || !SHA256.test(String(sourceAuthorityHash || ''))) {
    throw new Error('autonomous_research_machine_intake_source_invalid');
  }
  if (!SHA256.test(String(authorizedSourceAuthorityHash || ''))
    || sourceAuthorityHash !== authorizedSourceAuthorityHash) {
    throw new Error('autonomous_research_machine_intake_source_authority_unauthorized');
  }
  if (sourceKind === 'recurring-golden') {
    const provenance = intake.recurringGoldenProvenance;
    if (!verifyAutonomousResearchRecurringGoldenIntake({
      intake,
      template: sourceTemplate,
      sourceAuthorityHash,
    }) || sourceRef !== `${provenance.templateId}@${provenance.epochStart}`) {
      throw new Error('autonomous_research_recurring_golden_source_invalid');
    }
  } else if (intake.launchMode !== 'production-run'
    || intake.recurringGoldenProvenance !== null) {
    throw new Error('autonomous_research_machine_intake_privileged_launch_source_invalid');
  }
  if (sourceKind === 'static-file' && !path.isAbsolute(sourceRef)) {
    throw new Error('autonomous_research_machine_intake_source_invalid');
  }
  if (sourceKind === 'machine' && sourceRef !== 'machine-api') {
    throw new Error('autonomous_research_machine_intake_source_invalid');
  }
  return Object.freeze({ sourceKind, sourceRef, sourceAuthorityHash });
}

export function leaseDuration(value) {
  if (!Number.isSafeInteger(value) || value < 1000 || value > 30 * 60 * 1000) {
    throw new Error('autonomous_research_machine_intake_lease_duration_invalid');
  }
  return value;
}

export function identity({ intakeId, ownerId, leaseToken, leaseGeneration } = {}) {
  if (![intakeId, ownerId, leaseToken].every((value) => SAFE_ID.test(String(value || '')))
    || !Number.isSafeInteger(leaseGeneration) || leaseGeneration < 1) {
    throw new Error('autonomous_research_machine_intake_lease_identity_invalid');
  }
  return Object.freeze({ intakeId, ownerId, leaseToken, leaseGeneration });
}

export function begin(database) {
  database.exec('BEGIN IMMEDIATE;');
}

export function rollback(database) {
  if (database.isTransaction) {
    try { database.exec('ROLLBACK;'); } catch { /* retain the original failure */ }
  }
}

export function parseRow(row) {
  if (!row) return null;
  let intake;
  let admission;
  try { intake = JSON.parse(row.intake_json); }
  catch { throw new Error('autonomous_research_machine_intake_state_invalid'); }
  try { admission = JSON.parse(row.admission_json); }
  catch { throw new Error('autonomous_research_machine_intake_state_invalid'); }
  if (!verifyAutonomousResearchMachineIntake(intake)
    || !verifyAutonomousResearchMachineIntakeAdmission(admission, { intake })
    || admission.autonomousResearchMachineIntakeAdmissionHash !== row.admission_hash
    || admission.sourceKind !== row.source_kind
    || admission.sourceAuthorityHash !== row.source_authority_hash
    || intake.intakeId !== row.intake_id || intake.intakeHash !== row.intake_hash
    || intake.paperId !== row.paper_id || intake.campaignId !== row.campaign_id
    || !SOURCE_KINDS.has(row.source_kind)
    || !DISPOSITIONS.has(row.disposition)
    || !SHA256.test(String(row.source_authority_hash || ''))
    || !Number.isSafeInteger(Number(row.failure_count)) || Number(row.failure_count) < 0
    || !Number.isFinite(Date.parse(row.next_attempt_at))
    || (row.source_kind === 'recurring-golden' && (
      intake.launchMode !== 'golden-bootstrap'
      || intake.recurringGoldenProvenance?.sourceAuthorityHash !== row.source_authority_hash
      || row.source_ref !== `${intake.recurringGoldenProvenance?.templateId}@${intake.recurringGoldenProvenance?.epochStart}`
    ))
    || (row.source_kind !== 'recurring-golden' && (
      intake.launchMode !== 'production-run' || intake.recurringGoldenProvenance !== null
    ))) {
    throw new Error('autonomous_research_machine_intake_state_invalid');
  }
  const lease = row.lease_owner ? Object.freeze({
    ownerId: row.lease_owner,
    leaseToken: row.lease_token,
    leaseGeneration: Number(row.active_lease_generation),
    expiresAt: row.lease_expires_at,
  }) : null;
  return Object.freeze({
    intake,
    admission,
    admissionHash: admission.autonomousResearchMachineIntakeAdmissionHash,
    intakeId: intake.intakeId,
    intakeHash: intake.intakeHash,
    paperId: intake.paperId,
    campaignId: intake.campaignId,
    disposition: row.disposition,
    sourceKind: row.source_kind,
    sourceRef: row.source_ref,
    sourceAuthorityHash: row.source_authority_hash,
    leaseGeneration: Number(row.lease_generation),
    lease,
    campaignPlanHash: row.campaign_plan_hash || null,
    preparationHash: row.preparation_hash || null,
    enqueuedAt: row.enqueued_at || null,
    failureCount: Number(row.failure_count),
    nextAttemptAt: row.next_attempt_at,
    lastError: row.last_error || null,
    invalidReason: row.invalid_reason || null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  });
}

export function recurringEpochCurrent(row, observedAt) {
  if (row?.source_kind !== 'recurring-golden') return true;
  let intake;
  try { intake = JSON.parse(row.intake_json); }
  catch { throw new Error('autonomous_research_machine_intake_state_invalid'); }
  if (!verifyAutonomousResearchMachineIntake(intake)
    || intake.launchMode !== 'golden-bootstrap') {
    throw new Error('autonomous_research_machine_intake_state_invalid');
  }
  const start = Date.parse(intake.recurringGoldenProvenance.epochStart);
  return observedAt.getTime() >= start
    && observedAt.getTime() < start + intake.recurringGoldenProvenance.epochDurationMs;
}

export const SELECT_RECORD = `SELECT i.*,
  l.owner_id AS lease_owner,l.lease_token,
  l.lease_generation AS active_lease_generation,l.expires_at AS lease_expires_at
  FROM autonomous_research_machine_intake i
  LEFT JOIN autonomous_research_machine_intake_lease l ON l.intake_id=i.intake_id`;

export function createMachineIntakeSchema(database) {
  database.exec(`CREATE TABLE IF NOT EXISTS autonomous_research_machine_intake (
    intake_id TEXT PRIMARY KEY,
    intake_hash TEXT NOT NULL UNIQUE,
    paper_id TEXT NOT NULL,
    campaign_id TEXT NOT NULL UNIQUE,
    intake_json TEXT NOT NULL,
    admission_json TEXT NOT NULL,
    admission_hash TEXT NOT NULL,
    source_kind TEXT NOT NULL CHECK(source_kind IN ('machine','recurring-golden','static-file')),
    source_ref TEXT NOT NULL,
    source_authority_hash TEXT NOT NULL,
    disposition TEXT NOT NULL CHECK(disposition IN ('invalid','pending','enqueued','superseded')),
    lease_generation INTEGER NOT NULL DEFAULT 0 CHECK(lease_generation >= 0),
    campaign_plan_hash TEXT,
    preparation_hash TEXT,
    enqueued_at TEXT,
    failure_count INTEGER NOT NULL DEFAULT 0 CHECK(failure_count >= 0),
    next_attempt_at TEXT NOT NULL,
    last_error TEXT,
    invalid_reason TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  ) STRICT;
  CREATE TABLE IF NOT EXISTS autonomous_research_machine_intake_lease (
    intake_id TEXT PRIMARY KEY REFERENCES autonomous_research_machine_intake(intake_id),
    owner_id TEXT NOT NULL,
    lease_token TEXT NOT NULL,
    lease_generation INTEGER NOT NULL CHECK(lease_generation >= 1),
    acquired_at TEXT NOT NULL,
    renewed_at TEXT NOT NULL,
    expires_at TEXT NOT NULL
  ) STRICT;
  CREATE TABLE IF NOT EXISTS autonomous_research_machine_intake_daily_admission (
    epoch_start TEXT PRIMARY KEY,
    machine_append_count INTEGER NOT NULL CHECK(machine_append_count >= 0),
    reserved_cost_usd REAL NOT NULL CHECK(reserved_cost_usd >= 0),
    reserved_agent_calls INTEGER NOT NULL CHECK(reserved_agent_calls >= 0),
    reserved_gpu_jobs INTEGER NOT NULL CHECK(reserved_gpu_jobs >= 0),
    updated_at TEXT NOT NULL
  ) STRICT;
  CREATE TABLE IF NOT EXISTS autonomous_research_machine_intake_migration_quarantine (
    migration_id INTEGER PRIMARY KEY AUTOINCREMENT,
    legacy_intake_id TEXT,
    legacy_row_json TEXT NOT NULL,
    reason TEXT NOT NULL,
    quarantined_at TEXT NOT NULL
  ) STRICT;
  CREATE TABLE IF NOT EXISTS autonomous_research_machine_intake_metadata (
    singleton INTEGER PRIMARY KEY CHECK(singleton=1),
    configured_source_authority_hash TEXT NOT NULL,
    authorized_machine_producer_profile_hash TEXT,
    authority_generation INTEGER NOT NULL DEFAULT 1 CHECK(authority_generation >= 1),
    last_authority_rotation_receipt_hash TEXT
  ) STRICT;
  CREATE TABLE IF NOT EXISTS autonomous_research_machine_intake_authority_genesis (
    singleton INTEGER PRIMARY KEY CHECK(singleton=1),
    origin TEXT NOT NULL CHECK(origin IN(
      'fresh-v2-genesis','fresh-v2-root-owned-configuration'
    )),
    configuration_hash TEXT NOT NULL,
    producer_profile_hash TEXT NOT NULL,
    authority_generation INTEGER NOT NULL CHECK(authority_generation=1),
    external_genesis_envelope_hash TEXT NOT NULL,
    external_genesis_envelope_json TEXT NOT NULL,
    owner_trust_store_hash TEXT NOT NULL,
    owner_trust_store_snapshot_json TEXT NOT NULL,
    verified_signers_json TEXT NOT NULL,
    genesis_payload_json TEXT NOT NULL,
    genesis_hash TEXT NOT NULL UNIQUE,
    created_at TEXT NOT NULL
  ) STRICT;
  CREATE TABLE IF NOT EXISTS autonomous_research_machine_intake_authority_rotation (
    authority_generation INTEGER PRIMARY KEY CHECK(authority_generation >= 2),
    transition TEXT NOT NULL,
    previous_configuration_hash TEXT NOT NULL,
    previous_producer_profile_hash TEXT,
    previous_rotation_receipt_hash TEXT,
    next_configuration_hash TEXT NOT NULL,
    next_producer_profile_hash TEXT NOT NULL,
    next_provider_configuration_hash TEXT NOT NULL,
    next_implementation_sha256 TEXT NOT NULL,
    plan_hash TEXT NOT NULL UNIQUE,
    plan_json TEXT NOT NULL,
    rotation_intent_hash TEXT NOT NULL UNIQUE,
    intent_nonce TEXT NOT NULL UNIQUE,
    authority_trust_store_hash TEXT NOT NULL,
    owner_trust_store_hash TEXT NOT NULL,
    bootstrap_receipt_hash TEXT NOT NULL,
    authority_anchor_hash TEXT NOT NULL,
    bootstrap_receipt_json TEXT NOT NULL,
    owner_trust_store_snapshot_json TEXT NOT NULL,
    rotation_trust_store_snapshot_json TEXT NOT NULL,
    bootstrap_verified_signers_json TEXT NOT NULL,
    rotator_key_snapshot_hash TEXT NOT NULL,
    rotator_public_key_snapshot_json TEXT NOT NULL,
    verified_signer_key_id TEXT NOT NULL,
    verified_signer_subject_id TEXT NOT NULL,
    verified_signer_role TEXT NOT NULL,
    verified_signer_json TEXT NOT NULL,
    rotation_intent_json TEXT NOT NULL,
    pre_state_hash TEXT NOT NULL,
    quiescence_state_hash TEXT NOT NULL,
    post_state_hash TEXT NOT NULL,
    quarantined_legacy_machine_admission_count INTEGER NOT NULL
      CHECK(quarantined_legacy_machine_admission_count >= 0),
    rotation_receipt_hash TEXT NOT NULL UNIQUE,
    rotation_receipt_json TEXT NOT NULL,
    rotated_at TEXT NOT NULL
  ) STRICT;`);
  const metadataColumns = new Set(database.prepare(
    'PRAGMA table_info(autonomous_research_machine_intake_metadata)',
  ).all().map((column) => column.name));
  if (!metadataColumns.has('authorized_machine_producer_profile_hash')) {
    database.exec(`ALTER TABLE autonomous_research_machine_intake_metadata
      ADD COLUMN authorized_machine_producer_profile_hash TEXT;`);
  }
  if (!metadataColumns.has('authority_generation')) {
    database.exec(`ALTER TABLE autonomous_research_machine_intake_metadata
      ADD COLUMN authority_generation INTEGER NOT NULL DEFAULT 1
      CHECK(authority_generation >= 1);`);
  }
  if (!metadataColumns.has('last_authority_rotation_receipt_hash')) {
    database.exec(`ALTER TABLE autonomous_research_machine_intake_metadata
      ADD COLUMN last_authority_rotation_receipt_hash TEXT;`);
  }
  const genesisColumns = new Set(database.prepare(
    'PRAGMA table_info(autonomous_research_machine_intake_authority_genesis)',
  ).all().map((column) => column.name));
  for (const column of [
    'external_genesis_envelope_hash', 'external_genesis_envelope_json',
    'owner_trust_store_hash', 'owner_trust_store_snapshot_json', 'verified_signers_json',
  ]) {
    if (!genesisColumns.has(column)) {
      database.exec(`ALTER TABLE autonomous_research_machine_intake_authority_genesis
        ADD COLUMN ${column} TEXT;`);
    }
  }
  const rotationColumns = new Set(database.prepare(
    'PRAGMA table_info(autonomous_research_machine_intake_authority_rotation)',
  ).all().map((column) => column.name));
  if (!rotationColumns.has('previous_rotation_receipt_hash')) {
    database.exec(`ALTER TABLE autonomous_research_machine_intake_authority_rotation
      ADD COLUMN previous_rotation_receipt_hash TEXT;`);
  }
  for (const column of [
    'transition', 'plan_json', 'rotation_intent_hash', 'intent_nonce',
    'authority_trust_store_hash',
    'owner_trust_store_hash', 'bootstrap_receipt_hash', 'authority_anchor_hash',
    'bootstrap_receipt_json', 'owner_trust_store_snapshot_json',
    'rotation_trust_store_snapshot_json', 'bootstrap_verified_signers_json',
    'rotator_key_snapshot_hash',
    'rotator_public_key_snapshot_json', 'quiescence_state_hash',
    'verified_signer_key_id', 'verified_signer_subject_id', 'verified_signer_role',
    'verified_signer_json', 'rotation_intent_json',
  ]) {
    if (!rotationColumns.has(column)) {
      database.exec(`ALTER TABLE autonomous_research_machine_intake_authority_rotation
        ADD COLUMN ${column} TEXT;`);
    }
  }
  database.exec(`CREATE TRIGGER IF NOT EXISTS
    autonomous_research_machine_intake_authority_genesis_no_update
    BEFORE UPDATE ON autonomous_research_machine_intake_authority_genesis
    BEGIN SELECT RAISE(ABORT,
      'autonomous_research_machine_intake_authority_genesis_append_only'); END;
  CREATE TRIGGER IF NOT EXISTS
    autonomous_research_machine_intake_authority_genesis_no_delete
    BEFORE DELETE ON autonomous_research_machine_intake_authority_genesis
    BEGIN SELECT RAISE(ABORT,
      'autonomous_research_machine_intake_authority_genesis_append_only'); END;
  CREATE TRIGGER IF NOT EXISTS
    autonomous_research_machine_intake_authority_rotation_no_update
    BEFORE UPDATE ON autonomous_research_machine_intake_authority_rotation
    BEGIN SELECT RAISE(ABORT,
      'autonomous_research_machine_intake_authority_rotation_append_only'); END;
  CREATE TRIGGER IF NOT EXISTS
    autonomous_research_machine_intake_authority_rotation_no_delete
    BEFORE DELETE ON autonomous_research_machine_intake_authority_rotation
    BEGIN SELECT RAISE(ABORT,
      'autonomous_research_machine_intake_authority_rotation_append_only'); END;`);
}

export function legacySchemaRequiresMigration(database) {
  const table = database.prepare(`SELECT sql FROM sqlite_master
    WHERE type='table' AND name='autonomous_research_machine_intake'`).get();
  if (!table) return false;
  const columns = new Set(database.prepare(
    'PRAGMA table_info(autonomous_research_machine_intake)',
  ).all().map((column) => column.name));
  return !['admission_json', 'admission_hash', 'invalid_reason']
    .every((column) => columns.has(column))
    || !String(table.sql || '').includes("'superseded'")
    || !String(table.sql || '').includes("'invalid'");
}

function migrateLegacyIntakeRow(row, { authorizedSourceAuthorityHash, observedAt }) {
  try {
    const intake = JSON.parse(String(row.intake_json || ''));
    if (!verifyAutonomousResearchMachineIntake(intake)
      || intake.intakeId !== row.intake_id || intake.intakeHash !== row.intake_hash
      || intake.paperId !== row.paper_id || intake.campaignId !== row.campaign_id
      || !SOURCE_KINDS.has(row.source_kind)
      || !SHA256.test(String(row.source_authority_hash || ''))
      || !DISPOSITIONS.has(row.disposition)
      || !Number.isSafeInteger(Number(row.lease_generation))
      || Number(row.lease_generation) < 0
      || !Number.isSafeInteger(Number(row.failure_count)) || Number(row.failure_count) < 0
      || !Number.isFinite(Date.parse(row.next_attempt_at))
      || !Number.isFinite(Date.parse(row.created_at))
      || !Number.isFinite(Date.parse(row.updated_at))) {
      throw new Error('legacy_machine_intake_row_invalid');
    }
    if (row.disposition === 'pending'
      && row.source_authority_hash !== authorizedSourceAuthorityHash) {
      throw new Error('legacy_pending_machine_intake_source_authority_not_current');
    }
    const admissionTime = Date.parse(intake.admissionCreatedAt);
    if (row.disposition === 'pending' && row.source_kind === 'machine'
      && (admissionTime > observedAt.getTime()
        || observedAt.getTime() - admissionTime > MACHINE_ADMISSION_MAXIMUM_AGE_MS)) {
      throw new Error('legacy_pending_machine_intake_admission_expired');
    }
    if (row.source_kind === 'recurring-golden') {
      if (intake.launchMode !== 'golden-bootstrap'
        || intake.recurringGoldenProvenance?.sourceAuthorityHash
          !== row.source_authority_hash
        || row.source_ref
          !== `${intake.recurringGoldenProvenance?.templateId}@${intake.recurringGoldenProvenance?.epochStart}`) {
        throw new Error('legacy_recurring_golden_source_invalid');
      }
      const epochStart = Date.parse(intake.recurringGoldenProvenance.epochStart);
      if (row.disposition === 'pending'
        && (observedAt.getTime() < epochStart
          || observedAt.getTime()
            >= epochStart + intake.recurringGoldenProvenance.epochDurationMs)) {
        throw new Error('legacy_pending_recurring_golden_epoch_expired');
      }
    } else if (intake.launchMode !== 'production-run'
      || intake.recurringGoldenProvenance !== null
      || (row.source_kind === 'machine' && row.source_ref !== 'machine-api')
      || (row.source_kind === 'static-file' && !path.isAbsolute(row.source_ref))) {
      throw new Error('legacy_production_intake_source_invalid');
    }
    if (row.disposition === 'enqueued'
      && (!SHA256.test(String(row.campaign_plan_hash || ''))
        || !SHA256.test(String(row.preparation_hash || '')))) {
      throw new Error('legacy_enqueued_machine_intake_binding_missing');
    }
    const admission = buildAutonomousResearchMachineIntakeAdmission({
      intake,
      sourceKind: row.source_kind,
      sourceAuthorityHash: row.source_authority_hash,
    });
    if (row.admission_json !== undefined && row.admission_json !== null) {
      const supplied = JSON.parse(String(row.admission_json));
      if (!verifyAutonomousResearchMachineIntakeAdmission(supplied, { intake })
        || supplied.autonomousResearchMachineIntakeAdmissionHash
          !== admission.autonomousResearchMachineIntakeAdmissionHash) {
        throw new Error('legacy_machine_intake_admission_invalid');
      }
    }
    return Object.freeze({ row, intake, admission });
  } catch (error) {
    return Object.freeze({ row, error: String(error?.message || error) });
  }
}

export function migrateLegacyMachineIntakeSchema(database, {
  authorizedSourceAuthorityHash,
  migrationHooks = {},
} = {}) {
  if (!database.isTransaction) {
    throw new Error('autonomous_research_machine_intake_schema_migration_transaction_required');
  }
  if (!legacySchemaRequiresMigration(database)) return null;
  const legacyRows = database.prepare(
    'SELECT * FROM autonomous_research_machine_intake ORDER BY intake_id',
  ).all();
  const leaseTable = database.prepare(`SELECT name FROM sqlite_master
    WHERE type='table' AND name='autonomous_research_machine_intake_lease'`).get();
  const legacyLeases = leaseTable ? database.prepare(
    'SELECT * FROM autonomous_research_machine_intake_lease ORDER BY intake_id',
  ).all() : [];
  const observedAt = new Date();
  const migrated = legacyRows.map((row) => migrateLegacyIntakeRow(row, {
    authorizedSourceAuthorityHash,
    observedAt,
  }));
  const migratedById = new Map(migrated
    .filter((candidate) => !candidate.error)
    .map((candidate) => [candidate.row.intake_id, candidate]));
  const quarantinedAt = observedAt.toISOString();
  try {
    if (leaseTable) database.exec('DROP TABLE autonomous_research_machine_intake_lease;');
    database.exec(`ALTER TABLE autonomous_research_machine_intake
      RENAME TO autonomous_research_machine_intake_legacy_migration;`);
    migrationHooks.afterLegacyTablesRenamed?.();
    createMachineIntakeSchema(database);
    const authorityMetadata = database.prepare(`SELECT * FROM
      autonomous_research_machine_intake_metadata WHERE singleton=1`).get();
    if (!authorityMetadata) {
      database.prepare(`INSERT INTO autonomous_research_machine_intake_metadata(
        singleton,configured_source_authority_hash,
        authorized_machine_producer_profile_hash,authority_generation,
        last_authority_rotation_receipt_hash) VALUES(1,?,NULL,1,NULL)`).run(
        authorizedSourceAuthorityHash,
      );
    } else if (authorityMetadata.configured_source_authority_hash
      !== authorizedSourceAuthorityHash
      || authorityMetadata.authorized_machine_producer_profile_hash !== null
      || Number(authorityMetadata.authority_generation) !== 1
      || authorityMetadata.last_authority_rotation_receipt_hash !== null) {
      throw new Error('autonomous_research_machine_intake_migration_authority_invalid');
    }
    const insert = database.prepare(`INSERT INTO autonomous_research_machine_intake(
      intake_id,intake_hash,paper_id,campaign_id,intake_json,admission_json,admission_hash,
      source_kind,source_ref,source_authority_hash,disposition,lease_generation,
      campaign_plan_hash,preparation_hash,enqueued_at,failure_count,next_attempt_at,
      last_error,invalid_reason,created_at,updated_at
    ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
    for (const candidate of migratedById.values()) {
      const { row, intake, admission } = candidate;
      insert.run(
        row.intake_id, row.intake_hash, row.paper_id, row.campaign_id,
        JSON.stringify(intake), JSON.stringify(admission),
        admission.autonomousResearchMachineIntakeAdmissionHash,
        row.source_kind, row.source_ref, row.source_authority_hash, row.disposition,
        Number(row.lease_generation), row.campaign_plan_hash || null,
        row.preparation_hash || null, row.enqueued_at || null, Number(row.failure_count),
        row.next_attempt_at, row.last_error || null, row.invalid_reason || null,
        row.created_at, row.updated_at,
      );
    }
    const insertLease = database.prepare(`INSERT INTO autonomous_research_machine_intake_lease(
      intake_id,owner_id,lease_token,lease_generation,acquired_at,renewed_at,expires_at
    ) VALUES(?,?,?,?,?,?,?)`);
    for (const lease of legacyLeases) {
      const candidate = migratedById.get(lease.intake_id);
      if (!candidate || candidate.row.disposition !== 'pending'
        || ![lease.owner_id, lease.lease_token].every((value) => SAFE_ID.test(String(value || '')))
        || !Number.isSafeInteger(Number(lease.lease_generation))
        || Number(lease.lease_generation) < 1
        || Number(lease.lease_generation) !== Number(candidate.row.lease_generation)
        || ![lease.acquired_at, lease.renewed_at, lease.expires_at]
          .every((value) => Number.isFinite(Date.parse(value)))) continue;
      insertLease.run(
        lease.intake_id, lease.owner_id, lease.lease_token,
        Number(lease.lease_generation), lease.acquired_at, lease.renewed_at, lease.expires_at,
      );
    }
    const quarantine = database.prepare(`INSERT INTO
      autonomous_research_machine_intake_migration_quarantine(
        legacy_intake_id,legacy_row_json,reason,quarantined_at
      ) VALUES(?,?,?,?)`);
    for (const candidate of migrated.filter((value) => value.error)) {
      quarantine.run(
        candidate.row.intake_id || null,
        JSON.stringify(candidate.row),
        candidate.error.slice(0, 1024),
        quarantinedAt,
      );
    }
    database.exec('DROP TABLE autonomous_research_machine_intake_legacy_migration;');
    return Object.freeze({
      migratedCount: migratedById.size,
      quarantinedCount: migrated.length - migratedById.size,
    });
  } catch (error) {
    throw new Error(`autonomous_research_machine_intake_schema_migration_failed:${error.message}`);
  }
}
