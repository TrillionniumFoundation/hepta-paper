import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { selectReceiptHash } from '../../paper-domain/evidence/receipt-hash-selector.mjs';
import {
  buildHeptaStoreRestoreDrillLedgerSubjectV3,
  verifyHeptaStoreRestoreDrillReceipt,
} from '../../paper-domain/evidence/hepta-store-restore-drill-receipt-contract.mjs';
import {
  resolveReceiptIssuerPolicy,
} from '../../paper-domain/evidence/receipt-issuer-policy-registry.mjs';
import { hasExactObjectKeys } from '../../workflow-kernel/exact-object-keys.mjs';
import { hashRecord } from '../../workflow-kernel/record-hash.mjs';
import {
  assertMachineIntakeAuthorityState,
} from './autonomous-research-machine-intake-authority.mjs';
import {
  AUTONOMOUS_RESEARCH_ONLINE_AUTHORITY_JOURNAL_SCHEMA_CONTRACT_ID,
  AUTONOMOUS_RESEARCH_ONLINE_AUTHORITY_JOURNAL_SCHEMA_HASH,
  AUTONOMOUS_RESEARCH_ONLINE_AUTHORITY_JOURNAL_SCHEMA_VERSION,
} from './autonomous-research-online-authority-journal.mjs';
import {
  AUTONOMOUS_SUBMISSION_HANDOFF_SCHEMA_MIGRATIONS,
} from '../persistence/autonomous-submission-handoff-store.mjs';

const COMMON_BASELINE_ROW_COUNTS = Object.freeze({
  autonomous_research_online_mutation_authority_marker: Object.freeze([0]),
  autonomous_research_online_mutation_authority_metadata: Object.freeze([1]),
  autonomous_research_online_mutation_finalization_receipt: Object.freeze([0]),
});

const ROLE_BASELINE_ROW_COUNTS = Object.freeze({
  'native-store': Object.freeze({
    automation_resource_limits: Object.freeze([1]),
    automation_resource_peaks: Object.freeze([1]),
    autonomous_submission_handoff_cutover: Object.freeze([1]),
    receipt_ledger: 'semantic-any-row-count',
    schema_migrations: Object.freeze([25]),
    store_metadata: Object.freeze([29]),
  }),
  'submission-handoff': Object.freeze({
    handoff_cutover: Object.freeze([1]),
    handoff_instance: Object.freeze([1]),
    handoff_schema_migrations: Object.freeze([1, 2]),
  }),
  'machine-intake': Object.freeze({
    autonomous_research_machine_intake_authority_genesis: Object.freeze([1]),
    autonomous_research_machine_intake_metadata: Object.freeze([1]),
  }),
  'topic-producer': Object.freeze({
    autonomous_research_topic_producer_metadata: Object.freeze([1]),
  }),
  'supervisor-state': Object.freeze({}),
  'resident-instance': Object.freeze({
    autonomous_research_online_authority_journal_metadata: Object.freeze([1]),
  }),
  'runtime-reproducibility-refresh': Object.freeze({
    runtime_reproducibility_refresh_state: Object.freeze([1]),
  }),
  'runtime-reproducibility-publication': Object.freeze({}),
  'external-qualification': Object.freeze({}),
  'full-research-qualification-publication': Object.freeze({
    full_research_qualification_pointer_lease: Object.freeze([1]),
  }),
});

const MAXIMUM_TABLES = 256;
const MAXIMUM_BASELINE_ROWS = 10000;
const MAXIMUM_CANONICAL_ROW_BYTES = 4 * 1024 * 1024;
const SHA256 = /^sha256:[0-9a-f]{64}$/;
const PHASES = new Set(['pre-rebind', 'post-rebind', 'adoption']);
const repositoryRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
);

const EXPECTED_NATIVE_STORE_METADATA = Object.freeze({
  automation_operations: 'enabled',
  automation_plane: 'enabled',
  autonomous_submission_handoff_cutover: 'available_inactive',
  campaign_attempt_fencing: 'enabled',
  campaign_lineage_backfill: 'completed',
  campaign_prepared_results: 'enabled',
  campaign_release_authority: 'current_completed_release',
  evidence_isolation: 'enabled',
  job_lease_fencing: 'generation_v1',
  legacy_catalog_runtime_scan: 'disabled',
  legacy_native_lineage: 'archive_only',
  multiprocess_automation: 'enabled',
  receipt_issuer_policy: 'registered_capability_required',
  receipt_ledger_append_only: 'enabled',
  receipt_ledger_qualification_projection: 'monotonic_terminal_state_machine',
  resource_admission_queue: 'enabled',
  reviewer_identity_backfill: 'completed',
  runtime_ledger: 'enabled',
  schema_version: '25',
  submission_boundary_hardening: 'enabled',
  submission_delivery_leases: 'enabled',
  submission_outbox_delivery_kind: 'enabled',
  submission_outbox_quarantined_legacy_count: '0',
  submission_response_consumption: 'enabled',
  trusted_evidence_writer_policy: 'enabled',
  verification_runtime_policy: 'isolated',
  workflow_state_projection_atomicity: 'projection_and_ledger_same_transaction',
  workspace_lineage_registry: 'enabled',
  workspace_retention_qualification: 'restore_receipt_required',
});

function fail(code, extra = {}) {
  const error = new Error(code);
  Object.assign(error, extra);
  throw error;
}

function identifier(value) {
  return `"${String(value).replaceAll('"', '""')}"`;
}

function baselinePolicy(databaseRole, phase) {
  const rolePolicy = ROLE_BASELINE_ROW_COUNTS[databaseRole];
  if (!rolePolicy) fail('autonomous_research_pristine_state_role_unsupported');
  const policy = { ...COMMON_BASELINE_ROW_COUNTS, ...rolePolicy };
  if (databaseRole === 'submission-handoff') {
    policy.handoff_schema_migrations = Object.freeze([
      phase === 'pre-rebind' ? 1 : 2,
    ]);
  }
  return Object.freeze(policy);
}

export function autonomousResearchPristineRuntimeStatePolicyHash({
  stateDatabaseManifestHash,
} = {}) {
  return hashRecord('AutonomousResearchPristineRuntimeStatePolicy', {
    stateDatabaseManifestHash,
    commonBaselineRowCounts: COMMON_BASELINE_ROW_COUNTS,
    roleBaselineRowCounts: ROLE_BASELINE_ROW_COUNTS,
    phaseSpecificHandoffMigrationCounts: Object.freeze({
      'pre-rebind': 1,
      'post-rebind': 2,
      adoption: 2,
    }),
    unlistedTablePolicy: 'exactly-zero-rows',
  });
}

function canonicalInstant(value) {
  return Number.isFinite(Date.parse(String(value || '')));
}

function expectedNativeMigrations() {
  const migrationRoot = path.join(repositoryRoot, 'store', 'migrations');
  return fs.readdirSync(migrationRoot).filter((name) => /^\d{3}_[a-z0-9_]+\.sql$/.test(name))
    .sort().map((name, index) => Object.freeze({
      version: index + 1,
      name: name.slice(0, -4),
      migrationSha256: `sha256:${crypto.createHash('sha256')
        .update(fs.readFileSync(path.join(migrationRoot, name))).digest('hex')}`,
    }));
}

const BACKUP_RECEIPT_KEYS = Object.freeze([
  'version', 'kind', 'status', 'sourcePath', 'backupPath', 'backupSha256',
  'bytes', 'createdAt',
]);

function validNativeBackupReceipt(receipt) {
  const sourcePath = path.resolve(String(receipt?.sourcePath || ''));
  const backupPath = path.resolve(String(receipt?.backupPath || ''));
  return hasExactObjectKeys(receipt, BACKUP_RECEIPT_KEYS)
    && receipt.version === 1
    && receipt.kind === 'HeptaStoreBackupReceipt'
    && receipt.status === 'hepta_store_backup_recorded'
    && path.isAbsolute(receipt.sourcePath)
    && path.isAbsolute(receipt.backupPath)
    && path.basename(sourcePath) === 'hepta-paper.sqlite'
    && path.dirname(backupPath) === path.join(path.dirname(sourcePath), 'backups')
    && path.basename(backupPath).endsWith('.sqlite')
    && SHA256.test(String(receipt.backupSha256 || ''))
    && Number.isSafeInteger(receipt.bytes)
    && receipt.bytes > 0
    && canonicalInstant(receipt.createdAt);
}

function verifiedRestoreLedgerSubject(receipt) {
  if (receipt?.version === 2) {
    const verification = verifyHeptaStoreRestoreDrillReceipt(receipt);
    return verification.valid ? verification.ledgerSubject : null;
  }
  if (receipt?.version !== 3 || receipt?.receiptRole !== 'administrative_ledger_subject') {
    return null;
  }
  try {
    const rebuilt = buildHeptaStoreRestoreDrillLedgerSubjectV3(receipt);
    return JSON.stringify(rebuilt) === JSON.stringify(receipt) ? rebuilt : null;
  } catch { return null; }
}

function validateNativeReceiptLedger(database) {
  const policy = resolveReceiptIssuerPolicy('store-administrator');
  const rows = database.prepare('SELECT * FROM receipt_ledger ORDER BY receipt_id;').all();
  const backupsByReceiptHash = new Map();
  const restoreSubjects = [];
  for (const row of rows) {
    let receipt;
    try { receipt = JSON.parse(String(row.receipt_json)); }
    catch { fail('autonomous_research_pristine_state_receipt_ledger_json_invalid'); }
    const receiptHash = selectReceiptHash(receipt);
    const backup = receipt.kind === 'HeptaStoreBackupReceipt'
      && validNativeBackupReceipt(receipt);
    const restoreSubject = receipt.kind === 'HeptaStoreRestoreDrillReceipt'
      ? verifiedRestoreLedgerSubject(receipt) : null;
    const evidenceClass = backup ? 'backup' : restoreSubject ? 'restore_drill' : null;
    const receiptTimestamp = backup ? receipt.createdAt : restoreSubject?.performedAt;
    if (!SHA256.test(String(receiptHash || ''))
      || row.receipt_sha256 !== receiptHash
      || row.receipt_id !== `${row.stream}:${receiptHash}`
      || row.kind !== receipt.kind
      || row.status !== (receipt.status || 'recorded')
      || row.paper_id !== null
      || row.environment !== 'administrative'
      || row.evidence_class !== evidenceClass
      || row.release_commit !== null
      || Number(row.writer_trusted) !== 1
      || row.issuer_policy_id !== 'store-administrator'
      || row.issuer_policy_hash !== policy?.issuerPolicyHash
      || row.writer_id !== policy?.writerId
      || row.writer_kind !== policy?.writerKind
      || row.issuer_assurance !== policy?.assurance
      || !policy.allowedKinds.includes(row.kind)
      || !policy.allowedStreams.includes(row.stream)
      || !canonicalInstant(row.created_at)
      || !canonicalInstant(receiptTimestamp)
      || Date.parse(row.created_at) < Date.parse(receiptTimestamp)) {
      fail('autonomous_research_pristine_state_receipt_ledger_semantics_invalid');
    }
    if (backup) backupsByReceiptHash.set(receiptHash, receipt);
    else restoreSubjects.push(restoreSubject);
  }
  for (const restore of restoreSubjects) {
    const backup = backupsByReceiptHash.get(restore.backupLedgerReceiptSha256);
    if (!backup
      || restore.backupLedgerReceiptId
        !== `store-admin:${restore.backupLedgerReceiptSha256}`
      || restore.backupPath !== backup.backupPath
      || restore.backupSha256 !== backup.backupSha256
      || Date.parse(restore.performedAt) < Date.parse(backup.createdAt)) {
      fail('autonomous_research_pristine_state_receipt_ledger_causal_binding_invalid');
    }
  }
}

function validateNativeBaseline(database) {
  const migrations = database.prepare(`
SELECT version,name,migration_sha256,applied_at FROM schema_migrations ORDER BY version;
`).all();
  const expectedMigrations = expectedNativeMigrations();
  if (migrations.length !== expectedMigrations.length || migrations.some((row, index) => (
    Number(row.version) !== expectedMigrations[index].version
    || row.name !== expectedMigrations[index].name
    || row.migration_sha256 !== expectedMigrations[index].migrationSha256
    || !canonicalInstant(row.applied_at)
  ))) fail('autonomous_research_pristine_state_native_migrations_invalid');
  const metadata = Object.fromEntries(database.prepare(
    'SELECT key,value FROM store_metadata ORDER BY key;',
  ).all().map((row) => [row.key, row.value]));
  if (JSON.stringify(metadata) !== JSON.stringify(EXPECTED_NATIVE_STORE_METADATA)) {
    fail('autonomous_research_pristine_state_native_metadata_invalid');
  }
  const limits = database.prepare('SELECT * FROM automation_resource_limits;').get();
  const peaks = database.prepare('SELECT * FROM automation_resource_peaks;').get();
  if (limits.scope !== 'global' || Number(limits.agent_limit) !== 4
    || Number(limits.cpu_limit) !== 4 || Number(limits.gpu_limit) !== 1
    || Number(limits.memory_mib_limit) !== 8192
    || !canonicalInstant(limits.created_at) || !canonicalInstant(limits.updated_at)
    || peaks.scope !== 'global' || Number(peaks.agent_peak) !== 0
    || Number(peaks.cpu_peak) !== 0 || Number(peaks.gpu_peak) !== 0
    || Number(peaks.memory_mib_peak) !== 0 || !canonicalInstant(peaks.updated_at)) {
    fail('autonomous_research_pristine_state_native_resource_baseline_invalid');
  }
  validateNativeReceiptLedger(database);
  const cutover = database.prepare(
    'SELECT * FROM autonomous_submission_handoff_cutover WHERE singleton=1;',
  ).get();
  if (cutover.cutover_id !== 'autonomous-submission-handoff-cutover-v1'
    || !SHA256.test(String(cutover.handoff_database_identity_hash || ''))
    || Number(cutover.legacy_autonomous_row_count) !== 0
    || Number(cutover.legacy_quarantined_row_count) !== 0
    || !canonicalInstant(cutover.activated_at)) {
    fail('autonomous_research_pristine_state_native_cutover_invalid');
  }
  return Object.freeze({
    handoffDatabaseIdentityHash: cutover.handoff_database_identity_hash,
    cutoverId: cutover.cutover_id,
  });
}

function validateHandoffBaseline(database, phase) {
  const expectedCount = phase === 'pre-rebind' ? 1 : 2;
  const migrations = database.prepare(`
SELECT version,name,migration_sha256,applied_at FROM handoff_schema_migrations ORDER BY version;
`).all();
  const expected = AUTONOMOUS_SUBMISSION_HANDOFF_SCHEMA_MIGRATIONS.slice(0, expectedCount);
  const instance = database.prepare('SELECT * FROM handoff_instance WHERE singleton=1;').get();
  const cutover = database.prepare('SELECT * FROM handoff_cutover WHERE singleton=1;').get();
  if (migrations.length !== expected.length || migrations.some((row, index) => (
    Number(row.version) !== expected[index].version
    || row.name !== expected[index].name
    || row.migration_sha256 !== expected[index].migrationHash
    || !canonicalInstant(row.applied_at)
  )) || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
    .test(String(instance?.instance_nonce || ''))
    || !canonicalInstant(instance?.provisioned_at)
    || cutover?.cutover_id !== 'autonomous-submission-handoff-cutover-v1'
    || !SHA256.test(String(cutover?.native_cutover_identity_hash || ''))
    || cutover?.status !== 'active'
    || !canonicalInstant(cutover?.prepared_at)
    || !canonicalInstant(cutover?.activated_at)) {
    fail('autonomous_research_pristine_state_handoff_baseline_invalid');
  }
  return Object.freeze({
    instanceNonce: instance.instance_nonce,
    nativeCutoverIdentityHash: cutover.native_cutover_identity_hash,
    cutoverId: cutover.cutover_id,
  });
}

function validateMachineIntakeBaseline(database) {
  const state = assertMachineIntakeAuthorityState(database);
  if (state.authorityGeneration !== 1 || state.lastAuthorityRotationReceiptHash !== null
    || !SHA256.test(String(state.configuredSourceAuthorityHash || ''))
    || !SHA256.test(String(state.authorizedMachineProducerProfileHash || ''))) {
    fail('autonomous_research_pristine_state_machine_intake_authority_invalid');
  }
  return Object.freeze({
    machineIntakeConfigurationHash: state.configuredSourceAuthorityHash,
    producerProfileHash: state.authorizedMachineProducerProfileHash,
  });
}

function validateTopicProducerBaseline(database) {
  const row = database.prepare(`
SELECT * FROM autonomous_research_topic_producer_metadata WHERE singleton=1;
`).get();
  if (![row?.machine_intake_configuration_hash, row?.producer_profile_hash,
    row?.provider_configuration_hash, row?.implementation_sha256]
    .every((value) => SHA256.test(String(value || '')))
    || Number(row.lease_generation) !== 0
    || Number(row.generation_high_watermark) !== 0
    || row.last_observed_at !== null || row.last_produced_at !== null
    || row.next_attempt_at !== null) {
    fail('autonomous_research_pristine_state_topic_producer_metadata_invalid');
  }
  return Object.freeze({
    machineIntakeConfigurationHash: row.machine_intake_configuration_hash,
    producerProfileHash: row.producer_profile_hash,
    providerConfigurationHash: row.provider_configuration_hash,
    implementationSha256: row.implementation_sha256,
  });
}

function validateRefreshBaseline(database) {
  const row = database.prepare(
    'SELECT * FROM runtime_reproducibility_refresh_state;',
  ).get();
  const epoch = new Date(0).toISOString();
  if (row?.scope_id !== 'resident-runtime-image-reproducibility'
    || row.status !== 'refresh_unobserved' || Number(row.consecutive_failures) !== 0
    || row.next_attempt_at !== epoch || row.last_error !== null
    || row.last_configuration_identity_hash !== null || row.last_receipt_hash !== null
    || row.last_receipt_content_hash !== null || row.last_issued_at !== null
    || row.last_expires_at !== null || Number(row.recovered_lease_count) !== 0
    || row.lease_owner !== null || row.lease_token !== null
    || Number(row.lease_generation) !== 0 || row.lease_expires_at !== null
    || row.created_at !== epoch || row.updated_at !== epoch) {
    fail('autonomous_research_pristine_state_runtime_refresh_baseline_invalid');
  }
  return Object.freeze({});
}

function validateQualificationLeaseBaseline(database) {
  const row = database.prepare('SELECT * FROM full_research_qualification_pointer_lease;').get();
  if (Number(row?.singleton_id) !== 1 || row.lease_owner !== null || row.lease_token !== null
    || Number(row.lease_generation) !== 0 || row.lease_expires_at !== null
    || Number(row.recovered_lease_count) !== 0
    || row.updated_at !== new Date(0).toISOString()) {
    fail('autonomous_research_pristine_state_qualification_lease_baseline_invalid');
  }
  return Object.freeze({});
}

function validateOnlineMutationBaseline({
  database,
  databaseRole,
  databaseInstanceId,
  schemaContractId,
  schemaHash,
}) {
  const row = database.prepare(`
SELECT * FROM autonomous_research_online_mutation_authority_metadata WHERE singleton=1;
`).get();
  if (Number(row?.singleton) !== 1
    || Number(row.schema_version) !== 1
    || row.protocol !== 'external-linearizable-reserve-apply-finalize-v1'
    || row.database_role !== databaseRole
    || row.database_instance_id !== databaseInstanceId
    || row.schema_contract_id !== schemaContractId
    || row.schema_hash !== schemaHash
    || !SHA256.test(String(row.database_scope_hash || ''))
    || !SHA256.test(String(row.writer_manifest_hash || ''))
    || Number(row.genesis_global_sequence) !== 0
    || !SHA256.test(String(row.genesis_global_hash || ''))
    || Number(row.genesis_database_sequence) !== 0
    || !SHA256.test(String(row.genesis_database_hash || ''))
    || !SHA256.test(String(row.genesis_state_hash || ''))
    || !canonicalInstant(row.provisioned_at)) {
    fail('autonomous_research_pristine_state_online_authority_metadata_invalid');
  }
  if (databaseRole === 'resident-instance') {
    const journal = database.prepare(`
SELECT * FROM autonomous_research_online_authority_journal_metadata WHERE singleton=1;
`).get();
    if (Number(journal?.singleton) !== 1
      || Number(journal.schema_version)
        !== AUTONOMOUS_RESEARCH_ONLINE_AUTHORITY_JOURNAL_SCHEMA_VERSION
      || journal.schema_contract_id
        !== AUTONOMOUS_RESEARCH_ONLINE_AUTHORITY_JOURNAL_SCHEMA_CONTRACT_ID
      || journal.schema_contract_hash
        !== AUTONOMOUS_RESEARCH_ONLINE_AUTHORITY_JOURNAL_SCHEMA_HASH) {
      fail('autonomous_research_pristine_state_online_authority_journal_invalid');
    }
  }
  return Object.freeze({
    databaseScopeHash: row.database_scope_hash,
    writerManifestHash: row.writer_manifest_hash,
    globalSequence: Number(row.genesis_global_sequence),
    globalHash: row.genesis_global_hash,
    databaseSequence: Number(row.genesis_database_sequence),
    databaseHash: row.genesis_database_hash,
    stateHash: row.genesis_state_hash,
  });
}

function validateSemanticBaseline(database, databaseRole, phase) {
  switch (databaseRole) {
    case 'native-store': return validateNativeBaseline(database);
    case 'submission-handoff': return validateHandoffBaseline(database, phase);
    case 'machine-intake': return validateMachineIntakeBaseline(database);
    case 'topic-producer': return validateTopicProducerBaseline(database);
    case 'runtime-reproducibility-refresh': return validateRefreshBaseline(database);
    case 'full-research-qualification-publication':
      return validateQualificationLeaseBaseline(database);
    default: return Object.freeze({});
  }
}

function canonicalTableRows(database, tableName, rowCount) {
  if (rowCount > MAXIMUM_BASELINE_ROWS) {
    fail('autonomous_research_pristine_state_baseline_row_limit_exceeded', { tableName });
  }
  const columns = database.prepare(`
SELECT name FROM pragma_table_xinfo(?) WHERE hidden=0 ORDER BY cid;
`).all(tableName).map((row) => String(row.name));
  if (columns.length === 0) {
    fail('autonomous_research_pristine_state_table_columns_missing', { tableName });
  }
  const projection = columns.map((column, index) => (
    `quote(${identifier(column)}) AS ${identifier(`c${index}`)}`
  )).join(',');
  const rows = database.prepare(`SELECT ${projection} FROM ${identifier(tableName)};`)
    .all().map((row) => columns.map((_, index) => String(row[`c${index}`])));
  rows.sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)));
  const canonicalBytes = Buffer.byteLength(JSON.stringify(rows), 'utf8');
  if (canonicalBytes > MAXIMUM_CANONICAL_ROW_BYTES) {
    fail('autonomous_research_pristine_state_canonical_row_limit_exceeded', { tableName });
  }
  return Object.freeze({
    columns: Object.freeze(columns),
    rowsHash: hashRecord('AutonomousResearchPristineDatabaseTableRows', {
      tableName,
      columns,
      rows,
    }),
  });
}

export function inspectAutonomousResearchPristineDatabaseState({
  database,
  databaseRole,
  databaseInstanceId,
  schemaContractId,
  schemaHash,
  stateDatabaseManifestHash,
  phase,
} = {}) {
  if (!database?.prepare || !databaseRole || !databaseInstanceId
    || !schemaContractId || !schemaHash || !stateDatabaseManifestHash
    || !PHASES.has(phase)) {
    fail('autonomous_research_pristine_state_inspection_input_invalid');
  }
  const policy = baselinePolicy(databaseRole, phase);
  const tables = database.prepare(`
SELECT name FROM sqlite_schema
WHERE type='table' AND name NOT LIKE 'sqlite_%'
ORDER BY name;
`).all().map((row) => String(row.name));
  if (tables.length > MAXIMUM_TABLES) {
    fail('autonomous_research_pristine_state_table_limit_exceeded');
  }
  const tableSet = new Set(tables);
  for (const requiredTable of Object.keys(policy)) {
    if (!tableSet.has(requiredTable)) {
      fail('autonomous_research_pristine_state_baseline_table_missing', {
        databaseRole,
        databaseInstanceId,
        tableName: requiredTable,
      });
    }
  }
  const semanticBindings = Object.freeze({
    ...validateSemanticBaseline(database, databaseRole, phase),
    onlineAuthority: validateOnlineMutationBaseline({
      database,
      databaseRole,
      databaseInstanceId,
      schemaContractId,
      schemaHash,
    }),
  });
  let businessRowCount = 0;
  const tableStates = [];
  for (const tableName of tables) {
    const rowCount = Number(database.prepare(
      `SELECT count(*) AS count FROM ${identifier(tableName)};`,
    ).get().count);
    const permittedCounts = policy[tableName] || Object.freeze([0]);
    const baseline = Object.hasOwn(policy, tableName);
    if (permittedCounts !== 'semantic-any-row-count'
      && !permittedCounts.includes(rowCount)) {
      if (!baseline) businessRowCount += rowCount;
      fail(baseline
        ? 'autonomous_research_pristine_state_baseline_row_count_invalid'
        : 'autonomous_research_pristine_state_business_rows_present', {
        databaseRole,
        databaseInstanceId,
        tableName,
        rowCount,
      });
    }
    const canonical = canonicalTableRows(database, tableName, rowCount);
    tableStates.push(Object.freeze({
      tableName,
      classification: baseline ? 'permitted-baseline' : 'business-empty',
      rowCount,
      columns: canonical.columns,
      rowsHash: canonical.rowsHash,
    }));
  }
  const policyHash = autonomousResearchPristineRuntimeStatePolicyHash({
    stateDatabaseManifestHash,
  });
  const payload = Object.freeze({
    databaseRole,
    databaseInstanceId,
    schemaContractId,
    schemaHash,
    phase,
    stateDatabaseManifestHash,
    policyHash,
    tableStates: Object.freeze(tableStates),
    semanticBindings,
    businessRowCount,
  });
  return Object.freeze({
    version: 1,
    kind: 'AutonomousResearchPristineDatabaseStateInspection',
    status: 'autonomous_research_pristine_database_state_ready',
    ...payload,
    pristineStateHash: hashRecord('AutonomousResearchPristineDatabaseState', payload),
  });
}

export function autonomousResearchPristineRuntimeStateHash(inspections) {
  if (!Array.isArray(inspections) || inspections.length !== 10
    || inspections.some((entry) => (
      entry?.status !== 'autonomous_research_pristine_database_state_ready'
      || entry.businessRowCount !== 0
    ))) {
    fail('autonomous_research_pristine_runtime_state_inspections_invalid');
  }
  const byRole = new Map(inspections.map((entry) => [entry.databaseRole, entry]));
  if (byRole.size !== 10 || new Set(inspections.map((entry) => entry.phase)).size !== 1) {
    fail('autonomous_research_pristine_runtime_state_role_or_phase_invalid');
  }
  const native = byRole.get('native-store')?.semanticBindings;
  const handoff = byRole.get('submission-handoff')?.semanticBindings;
  const machine = byRole.get('machine-intake')?.semanticBindings;
  const topic = byRole.get('topic-producer')?.semanticBindings;
  const onlineAuthorities = inspections.map((entry) => entry.semanticBindings?.onlineAuthority);
  const expectedCutoverIdentityHash = handoff ? hashRecord(
    'AutonomousSubmissionHandoffDatabaseIdentity',
    {
      cutoverId: handoff.cutoverId,
      databasePath: 'submission-handoff.sqlite',
      migrationHash: AUTONOMOUS_SUBMISSION_HANDOFF_SCHEMA_MIGRATIONS[0].migrationHash,
      instanceNonce: handoff.instanceNonce,
    },
  ) : null;
  if (!native || !handoff || !machine || !topic
    || onlineAuthorities.some((entry) => !entry)
    || new Set(onlineAuthorities.map((entry) => entry.databaseScopeHash)).size !== 1
    || new Set(onlineAuthorities.map((entry) => entry.writerManifestHash)).size !== 1
    || new Set(onlineAuthorities.map((entry) => entry.globalSequence)).size !== 1
    || new Set(onlineAuthorities.map((entry) => entry.globalHash)).size !== 1
    || native.cutoverId !== handoff.cutoverId
    || native.handoffDatabaseIdentityHash !== expectedCutoverIdentityHash
    || handoff.nativeCutoverIdentityHash !== expectedCutoverIdentityHash
    || machine.machineIntakeConfigurationHash !== topic.machineIntakeConfigurationHash
    || machine.producerProfileHash !== topic.producerProfileHash) {
    fail('autonomous_research_pristine_runtime_state_cross_database_binding_invalid');
  }
  return hashRecord('AutonomousResearchPristineRuntimeState', inspections.map((entry) => ({
    databaseRole: entry.databaseRole,
    databaseInstanceId: entry.databaseInstanceId,
    schemaContractId: entry.schemaContractId,
    schemaHash: entry.schemaHash,
    phase: entry.phase,
    policyHash: entry.policyHash,
    pristineStateHash: entry.pristineStateHash,
  })).sort((left, right) => left.databaseInstanceId.localeCompare(right.databaseInstanceId)));
}
