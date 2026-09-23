import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import {
  createExternallyFencedSqliteStore,
  createReadOnlySqliteStore,
  createSqliteStore,
} from './sqlite-store.mjs';
import {
  AUTONOMOUS_SUBMISSION_HANDOFF_DATABASE_INSTANCE_ID,
  AUTONOMOUS_SUBMISSION_HANDOFF_DATABASE_ROLE,
  AUTONOMOUS_SUBMISSION_HANDOFF_MUTATION_PLANS,
  AUTONOMOUS_SUBMISSION_HANDOFF_SCHEMA_CONTRACT_ID,
  AUTONOMOUS_SUBMISSION_HANDOFF_WRITER_ID,
} from './autonomous-submission-handoff-mutation-plan.mjs';
import { hashRecord } from '../../workflow-kernel/record-hash.mjs';

const SCHEMA_VERSION = 2;
const SCHEMA_V1_SQL = `
PRAGMA foreign_keys=ON;
CREATE TABLE IF NOT EXISTS handoff_schema_migrations(
  version INTEGER PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  migration_sha256 TEXT NOT NULL UNIQUE,
  applied_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS handoff_instance(
  singleton INTEGER PRIMARY KEY CHECK(singleton=1),
  instance_nonce TEXT NOT NULL UNIQUE,
  provisioned_at TEXT NOT NULL
);
CREATE TRIGGER handoff_instance_no_update BEFORE UPDATE ON handoff_instance
BEGIN SELECT RAISE(ABORT,'handoff_instance_is_immutable'); END;
CREATE TRIGGER handoff_instance_no_delete BEFORE DELETE ON handoff_instance
BEGIN SELECT RAISE(ABORT,'handoff_instance_is_immutable'); END;
CREATE TABLE IF NOT EXISTS handoff_cutover(
  singleton INTEGER PRIMARY KEY CHECK(singleton=1),
  cutover_id TEXT NOT NULL UNIQUE,
  native_cutover_identity_hash TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('prepared','active')),
  prepared_at TEXT NOT NULL,
  activated_at TEXT
);
CREATE TABLE IF NOT EXISTS receipt_ledger(
  receipt_id TEXT PRIMARY KEY,
  stream TEXT NOT NULL,
  paper_id TEXT,
  kind TEXT NOT NULL,
  status TEXT NOT NULL,
  receipt_json TEXT NOT NULL,
  receipt_sha256 TEXT NOT NULL,
  created_at TEXT NOT NULL,
  environment TEXT NOT NULL,
  evidence_class TEXT NOT NULL,
  release_commit TEXT,
  writer_id TEXT,
  writer_kind TEXT,
  writer_trusted INTEGER NOT NULL DEFAULT 0,
  issuer_policy_id TEXT,
  issuer_policy_hash TEXT,
  issuer_assurance TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_handoff_receipt_stream_time
  ON receipt_ledger(stream,created_at DESC);
CREATE TRIGGER handoff_receipt_ledger_forbid_update BEFORE UPDATE ON receipt_ledger
BEGIN SELECT RAISE(ABORT,'handoff_receipt_ledger_is_append_only'); END;
CREATE TRIGGER handoff_receipt_ledger_forbid_delete BEFORE DELETE ON receipt_ledger
BEGIN SELECT RAISE(ABORT,'handoff_receipt_ledger_is_append_only'); END;
CREATE TABLE IF NOT EXISTS receipt_ledger_qualifications(
  sequence INTEGER PRIMARY KEY AUTOINCREMENT,
  qualification_id TEXT NOT NULL UNIQUE,
  receipt_id TEXT NOT NULL UNIQUE REFERENCES receipt_ledger(receipt_id),
  disposition TEXT NOT NULL,
  reason TEXT NOT NULL,
  replacement_receipt_id TEXT REFERENCES receipt_ledger(receipt_id),
  qualification_json TEXT NOT NULL,
  qualification_sha256 TEXT NOT NULL,
  issuer_policy_id TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TRIGGER handoff_receipt_qualifications_forbid_update
BEFORE UPDATE ON receipt_ledger_qualifications
BEGIN SELECT RAISE(ABORT,'handoff_receipt_qualifications_are_append_only'); END;
CREATE TRIGGER handoff_receipt_qualifications_forbid_delete
BEFORE DELETE ON receipt_ledger_qualifications
BEGIN SELECT RAISE(ABORT,'handoff_receipt_qualifications_are_append_only'); END;
CREATE VIEW IF NOT EXISTS effective_receipt_ledger AS
SELECT receipt.*,
  qualification.qualification_id AS effective_qualification_id,
  qualification.disposition AS effective_disposition,
  qualification.reason AS effective_qualification_reason,
  qualification.replacement_receipt_id AS effective_replacement_receipt_id,
  qualification.qualification_sha256 AS effective_qualification_sha256,
  qualification.created_at AS effective_qualification_created_at,
  CASE WHEN qualification.sequence IS NULL THEN 1 ELSE 0 END AS effective_receipt_usable
FROM receipt_ledger AS receipt
LEFT JOIN receipt_ledger_qualifications AS qualification
  ON qualification.receipt_id=receipt.receipt_id;
CREATE TABLE IF NOT EXISTS submission_outbox(
  delivery_kind TEXT NOT NULL DEFAULT 'autonomous'
    CHECK(delivery_kind='autonomous'),
  message_id TEXT PRIMARY KEY,
  paper_id TEXT NOT NULL,
  dispatch_hash TEXT NOT NULL UNIQUE,
  provider TEXT NOT NULL,
  account_id TEXT NOT NULL,
  nonce TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL,
  attempt_count INTEGER NOT NULL DEFAULT 0,
  payload_json TEXT NOT NULL,
  next_attempt_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  replay_key TEXT UNIQUE,
  action_scope_key TEXT UNIQUE,
  dispatch_cycle_hash TEXT UNIQUE,
  authorization_receipt_hash TEXT,
  executor_descriptor_hash TEXT,
  response_due_at TEXT,
  claimed_by TEXT,
  lease_token TEXT UNIQUE,
  lease_expires_at TEXT,
  heartbeat_at TEXT,
  executor_capabilities_hash TEXT,
  provider_capability_verification_receipt_hash TEXT,
  portal_route TEXT
);
CREATE INDEX IF NOT EXISTS idx_handoff_outbox_status_time
  ON submission_outbox(status,next_attempt_at,created_at,message_id);
CREATE INDEX IF NOT EXISTS idx_handoff_outbox_campaign
  ON submission_outbox(paper_id,created_at,message_id);
CREATE TRIGGER handoff_outbox_binding_required BEFORE INSERT ON submission_outbox
WHEN COALESCE((
  NEW.message_id GLOB 'autonomous-submission:*'
  AND json_valid(NEW.payload_json)
  AND json_extract(NEW.payload_json,'$.version')=1
  AND json_extract(NEW.payload_json,'$.kind')='AutonomousSubmissionOutboxEnvelope'
  AND json_extract(NEW.payload_json,'$.request.paperId')=NEW.paper_id
  AND json_extract(NEW.payload_json,'$.request.requestHash')=NEW.dispatch_hash
  AND json_extract(NEW.payload_json,'$.request.portalConfigurationHash')=NEW.account_id
  AND json_extract(NEW.payload_json,'$.request.idempotencyKey')=NEW.nonce
  AND json_extract(NEW.payload_json,'$.portalId')=NEW.provider
  AND NEW.message_id='autonomous-submission:'
    || json_extract(NEW.payload_json,'$.request.idempotencyKey')
  AND json_extract(NEW.payload_json,'$.stateReceipt.messageId')=NEW.message_id
  AND json_extract(NEW.payload_json,'$.stateReceipt.portalId')=NEW.provider
),0)<>1
BEGIN SELECT RAISE(ABORT,'autonomous_submission_handoff_binding_invalid'); END;
CREATE TRIGGER handoff_outbox_cutover_required BEFORE INSERT ON submission_outbox
WHEN NOT EXISTS(SELECT 1 FROM handoff_cutover WHERE singleton=1 AND status='active')
BEGIN SELECT RAISE(ABORT,'autonomous_submission_handoff_cutover_required'); END;
`;

const SCHEMA_V2_SQL = `
CREATE TABLE IF NOT EXISTS submission_authorization_consumptions(
  nonce TEXT PRIMARY KEY,
  authorization_receipt_hash TEXT NOT NULL UNIQUE,
  replay_key TEXT NOT NULL UNIQUE,
  dispatch_cycle_hash TEXT NOT NULL UNIQUE,
  paper_id TEXT NOT NULL,
  message_id TEXT NOT NULL UNIQUE REFERENCES submission_outbox(message_id),
  consumed_at TEXT NOT NULL
);
`;

function schemaMigration(version, name, sql) {
  return Object.freeze({
    version,
    name,
    sql,
    migrationHash: `sha256:${crypto.createHash('sha256').update(sql).digest('hex')}`,
  });
}

const SCHEMA_V1_MIGRATION = schemaMigration(
  1,
  '001_autonomous_submission_handoff',
  SCHEMA_V1_SQL,
);
const SCHEMA_V2_MIGRATION = schemaMigration(
  2,
  '002_submission_authorization_consumptions',
  SCHEMA_V2_SQL,
);
const EXPECTED_DEPLOYED_SCHEMA_V1_MIGRATION_HASH =
  'sha256:3e1f32963c656e8f6ae3f0f0d2b9754a3eca03b3a7ba6959423da4277c6e6fd1';
if (SCHEMA_V1_MIGRATION.migrationHash !== EXPECTED_DEPLOYED_SCHEMA_V1_MIGRATION_HASH) {
  throw new Error('autonomous_submission_handoff_deployed_schema_v1_definition_changed');
}

export const AUTONOMOUS_SUBMISSION_HANDOFF_SCHEMA_MIGRATIONS = Object.freeze([
  SCHEMA_V1_MIGRATION,
  SCHEMA_V2_MIGRATION,
]);

export {
  AUTONOMOUS_SUBMISSION_HANDOFF_DATABASE_ROLE,
  AUTONOMOUS_SUBMISSION_HANDOFF_SCHEMA_CONTRACT_ID,
};

export function autonomousSubmissionHandoffDatabasePath({ runtimeRoot } = {}) {
  if (!runtimeRoot) throw new Error('autonomous_submission_handoff_runtime_root_required');
  return path.join(path.resolve(runtimeRoot), 'autonomous-research',
    'submission-handoff', 'submission-handoff.sqlite');
}

function pathInside(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative);
}

function fileIdentity(candidate) {
  const stat = fs.lstatSync(candidate, { bigint: true });
  return Object.freeze({
    device: String(stat.dev), inode: String(stat.ino), mode: String(stat.mode),
    links: String(stat.nlink), size: String(stat.size),
  });
}

function assertSameIdentity(left, right, code) {
  if (JSON.stringify(left) !== JSON.stringify(right)) throw new Error(code);
}

function assertSafeRuntimeRoot(runtimeRoot) {
  const resolved = path.resolve(String(runtimeRoot || ''));
  const stat = fs.lstatSync(resolved);
  if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.mode & 0o002) !== 0
    || fs.realpathSync(resolved) !== resolved) {
    throw new Error('autonomous_submission_handoff_runtime_root_unsafe');
  }
  return resolved;
}

function assertOrCreateSafeDirectoryTree(runtimeRoot, { create = false } = {}) {
  const root = assertSafeRuntimeRoot(runtimeRoot);
  let current = root;
  for (const segment of ['autonomous-research', 'submission-handoff']) {
    const candidate = path.join(current, segment);
    if (!fs.existsSync(candidate)) {
      if (!create) throw new Error('autonomous_submission_handoff_directory_missing');
      fs.mkdirSync(candidate, { mode: 0o770 });
    }
    if (create && segment === 'submission-handoff') fs.chmodSync(candidate, 0o2770);
    const stat = fs.lstatSync(candidate);
    if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.mode & 0o002) !== 0
      || !pathInside(root, candidate) || !pathInside(root, fs.realpathSync(candidate))) {
      throw new Error('autonomous_submission_handoff_directory_unsafe');
    }
    current = candidate;
  }
  return Object.freeze({ root, directory: current, identity: fileIdentity(current) });
}

function assertSafeDatabaseFile(runtimeRoot, databasePath) {
  const tree = assertOrCreateSafeDirectoryTree(runtimeRoot);
  const stat = fs.lstatSync(databasePath);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1
    || (stat.mode & 0o007) !== 0
    || !pathInside(tree.root, databasePath)
    || !pathInside(tree.root, fs.realpathSync(databasePath))) {
    throw new Error('autonomous_submission_handoff_database_file_unsafe');
  }
  return Object.freeze({ tree, identity: fileIdentity(databasePath) });
}

function canonicalSchemaSql(sql) {
  return String(sql || '')
    .replace(/\bIF\s+NOT\s+EXISTS\b/gi, '')
    .replaceAll(';', '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

function verifySchema(store) {
  const migrationRows = store.query(`SELECT version,name,migration_sha256,applied_at
    FROM handoff_schema_migrations ORDER BY version;`).rows;
  if (migrationRows.length !== SCHEMA_VERSION
    || AUTONOMOUS_SUBMISSION_HANDOFF_SCHEMA_MIGRATIONS.some((migration, index) => {
      const row = migrationRows[index];
      return Number(row?.version) !== migration.version
        || row?.name !== migration.name
        || row?.migration_sha256 !== migration.migrationHash
        || !Number.isFinite(Date.parse(String(row?.applied_at || '')));
    })) {
    throw new Error('autonomous_submission_handoff_schema_mismatch');
  }
  const authorizationConsumptionObjects = store.query(`SELECT type,name,sql
    FROM sqlite_schema
    WHERE type='table' AND name='submission_authorization_consumptions';`).rows;
  if (authorizationConsumptionObjects.length !== 1
    || canonicalSchemaSql(authorizationConsumptionObjects[0]?.sql)
      !== canonicalSchemaSql(SCHEMA_V2_SQL)) {
    throw new Error('autonomous_submission_handoff_schema_mismatch');
  }
  const instanceRows = store.query(`SELECT instance_nonce,provisioned_at
    FROM handoff_instance WHERE singleton=1;`).rows;
  const instance = instanceRows[0];
  if (instanceRows.length !== 1
    || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
      .test(String(instance?.instance_nonce || ''))
    || !Number.isFinite(Date.parse(String(instance?.provisioned_at || '')))) {
    throw new Error('autonomous_submission_handoff_instance_identity_invalid');
  }
  return Object.freeze({
    instanceNonce: instance.instance_nonce,
    provisionedAt: new Date(instance.provisioned_at).toISOString(),
  });
}

export function provisionAutonomousSubmissionHandoffStore({ runtimeRoot, now = new Date() } = {}) {
  const databasePath = autonomousSubmissionHandoffDatabasePath({ runtimeRoot });
  if (fs.existsSync(databasePath)) {
    throw new Error('autonomous_submission_handoff_offline_provisioning_requires_fresh_store');
  }
  const tree = assertOrCreateSafeDirectoryTree(runtimeRoot, { create: true });
  const directory = tree.directory;
  assertSameIdentity(tree.identity, fileIdentity(directory),
    'autonomous_submission_handoff_directory_replaced');
  const store = createSqliteStore({ dbPath: databasePath });
  try {
    const appliedAt = new Date(now).toISOString();
    const instanceNonce = crypto.randomUUID();
    const migrationRows = AUTONOMOUS_SUBMISSION_HANDOFF_SCHEMA_MIGRATIONS.map((migration) => `
      INSERT INTO handoff_schema_migrations(version,name,migration_sha256,applied_at)
      VALUES(${migration.version},'${migration.name}',
        '${migration.migrationHash}','${appliedAt}');`).join('');
    const result = store.execute(`BEGIN IMMEDIATE;
      ${SCHEMA_V1_SQL}
      ${SCHEMA_V2_SQL}
      ${migrationRows}
      INSERT INTO handoff_instance(singleton,instance_nonce,provisioned_at)
      VALUES(1,'${instanceNonce}','${appliedAt}');
      COMMIT;`);
    if (!result.ok) throw new Error(result.error || 'autonomous_submission_handoff_schema_failed');
    const checkpoint = store.checkpoint({ mode: 'TRUNCATE' });
    const journal = store.execute('PRAGMA journal_mode=DELETE; PRAGMA synchronous=FULL;');
    if (checkpoint.ok !== true || journal.ok !== true) {
      throw new Error(
        checkpoint.error || journal.error || 'autonomous_submission_handoff_journal_failed',
      );
    }
  } finally { store.close(); }
  fs.chmodSync(databasePath, 0o660);
  assertSameIdentity(tree.identity, fileIdentity(directory),
    'autonomous_submission_handoff_directory_replaced');
  assertSafeDatabaseFile(runtimeRoot, databasePath);
  return databasePath;
}

export function openAutonomousSubmissionHandoffStore({
  runtimeRoot,
  readOnly = false,
  mutationCoordinator = null,
  requireExternallyFenced = false,
} = {}) {
  const databasePath = autonomousSubmissionHandoffDatabasePath({ runtimeRoot });
  if (!fs.existsSync(databasePath)) {
    throw new Error('autonomous_submission_handoff_offline_provisioning_required');
  }
  const before = assertSafeDatabaseFile(runtimeRoot, databasePath);
  if (!readOnly && requireExternallyFenced && !mutationCoordinator) {
    throw new Error('autonomous_submission_handoff_external_mutation_coordinator_required');
  }
  const operationIds = Object.keys(AUTONOMOUS_SUBMISSION_HANDOFF_MUTATION_PLANS).sort();
  const store = readOnly
    ? createReadOnlySqliteStore({ dbPath: databasePath })
    : mutationCoordinator
      ? createExternallyFencedSqliteStore({
        dbPath: databasePath,
        mutationCoordinator,
        databaseRole: AUTONOMOUS_SUBMISSION_HANDOFF_DATABASE_ROLE,
        databaseInstanceId: AUTONOMOUS_SUBMISSION_HANDOFF_DATABASE_INSTANCE_ID,
        schemaContractId: AUTONOMOUS_SUBMISSION_HANDOFF_SCHEMA_CONTRACT_ID,
        writerId: AUTONOMOUS_SUBMISSION_HANDOFF_WRITER_ID,
        operationIds,
        operationWriters: Object.freeze(Object.fromEntries(operationIds.map(
          (operationId) => [operationId, AUTONOMOUS_SUBMISSION_HANDOFF_WRITER_ID],
        ))),
      })
      : createSqliteStore({ dbPath: databasePath });
  try {
    verifySchema(store);
    assertSameIdentity(before.tree.identity, fileIdentity(before.tree.directory),
      'autonomous_submission_handoff_directory_replaced');
    assertSameIdentity(before.identity, fileIdentity(databasePath),
      'autonomous_submission_handoff_database_replaced');
  }
  catch (error) { store.close(); throw error; }
  return store;
}

function cutoverIdentity({ cutoverId, databasePath, migrationHash, instanceNonce }) {
  return hashRecord('AutonomousSubmissionHandoffDatabaseIdentity', {
    cutoverId, databasePath: path.basename(databasePath), migrationHash, instanceNonce,
  });
}

export function activateAutonomousSubmissionHandoffCutover({
  nativeStore,
  handoffStore,
  cutoverId,
  now = new Date(),
} = {}) {
  const activatedAt = new Date(now).toISOString();
  if (!nativeStore?.query || !nativeStore?.execute || !handoffStore?.query
    || !handoffStore?.execute || !cutoverId
    || !Number.isFinite(Date.parse(activatedAt))) {
    throw new Error('autonomous_submission_handoff_cutover_input_invalid');
  }
  const handoffIdentity = verifySchema(handoffStore);
  const databasePath = handoffStore.dbPath || 'submission-handoff.sqlite';
  const identityHash = cutoverIdentity({
    cutoverId: String(cutoverId),
    databasePath,
    migrationHash: SCHEMA_V1_MIGRATION.migrationHash,
    instanceNonce: handoffIdentity.instanceNonce,
  });
  const counts = nativeStore.query(`SELECT
    sum(CASE WHEN delivery_kind='autonomous' THEN 1 ELSE 0 END) AS autonomous_count,
    sum(CASE WHEN delivery_kind='quarantined_legacy' THEN 1 ELSE 0 END) AS quarantine_count,
    sum(CASE WHEN delivery_kind='autonomous'
      AND status NOT IN ('responded','dead_letter') THEN 1 ELSE 0 END) AS active_count
    FROM submission_outbox;`).rows[0] || {};
  if (Number(counts.active_count || 0) !== 0) {
    throw new Error('autonomous_submission_handoff_cutover_drain_required');
  }
  const existingHandoff = handoffStore.query(
    'SELECT * FROM handoff_cutover WHERE singleton=1 LIMIT 1;',
  ).rows[0] || null;
  if (!existingHandoff) {
    const prepared = handoffStore.execute(`INSERT INTO handoff_cutover(
      singleton,cutover_id,native_cutover_identity_hash,status,prepared_at,activated_at
    ) VALUES(1,'${String(cutoverId).replaceAll("'", "''")}','${identityHash}',
      'prepared','${activatedAt}',NULL);`);
    if (!prepared.ok) throw new Error(prepared.error || 'handoff_cutover_prepare_failed');
  } else if (existingHandoff.cutover_id !== cutoverId
    || existingHandoff.native_cutover_identity_hash !== identityHash) {
    throw new Error('autonomous_submission_handoff_cutover_identity_mismatch');
  }
  const existingNative = nativeStore.query(
    'SELECT * FROM autonomous_submission_handoff_cutover WHERE singleton=1 LIMIT 1;',
  ).rows[0] || null;
  if (!existingNative) {
    const native = nativeStore.execute(`INSERT INTO autonomous_submission_handoff_cutover(
      singleton,cutover_id,handoff_database_identity_hash,
      legacy_autonomous_row_count,legacy_quarantined_row_count,activated_at
    ) VALUES(1,'${String(cutoverId).replaceAll("'", "''")}','${identityHash}',
      ${Number(counts.autonomous_count || 0)},${Number(counts.quarantine_count || 0)},
      '${activatedAt}');`);
    if (!native.ok) throw new Error(native.error || 'native_handoff_cutover_failed');
  } else if (existingNative.cutover_id !== cutoverId
    || existingNative.handoff_database_identity_hash !== identityHash) {
    throw new Error('autonomous_submission_handoff_cutover_identity_mismatch');
  }
  const activated = handoffStore.execute(`UPDATE handoff_cutover SET
    status='active',activated_at='${activatedAt}'
    WHERE singleton=1 AND cutover_id='${String(cutoverId).replaceAll("'", "''")}'
      AND native_cutover_identity_hash='${identityHash}' AND status='prepared';`);
  if (!activated.ok) throw new Error(activated.error || 'handoff_cutover_activate_failed');
  return Object.freeze({
    version: 1,
    kind: 'AutonomousSubmissionHandoffCutoverReceipt',
    status: 'autonomous_submission_handoff_cutover_active',
    cutoverId: String(cutoverId),
    handoffInstanceNonce: handoffIdentity.instanceNonce,
    handoffDatabaseIdentityHash: identityHash,
    legacyAutonomousRowCount: Number(counts.autonomous_count || 0),
    legacyQuarantinedRowCount: Number(counts.quarantine_count || 0),
    copiedRowCount: 0,
    dualWriteEnabled: false,
    activatedAt,
  });
}
