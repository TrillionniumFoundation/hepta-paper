import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import {
  assertAutonomousResearchStateDatabaseManifest,
  autonomousResearchStateDatabaseManifestHash,
  AUTONOMOUS_RESEARCH_STATE_DATABASE_ROLES,
} from '../../paper-domain/automation/autonomous-research-state-backup-contract.mjs';
import { hashRecord } from '../../workflow-kernel/record-hash.mjs';
import { pathWithin } from '../../workflow-kernel/runtime/file-utils.mjs';
import {
  schemaTransitionTargetSchema,
} from './autonomous-research-online-schema-transition-schema.mjs';
import {
  resolveAutonomousResearchStateDatabaseInventory,
} from './autonomous-research-state-database-inventory.mjs';

const SHA256 = /^sha256:[0-9a-f]{64}$/;
const SAFE_SERVICE = /^[A-Za-z0-9][A-Za-z0-9@_.-]{0,127}\.service$/;

export const PARTIAL_ROOT_EXISTING_ROLES = Object.freeze([
  'external-qualification',
  'native-store',
  'resident-instance',
  'submission-handoff',
  'supervisor-state',
]);

export const PARTIAL_ROOT_MISSING_ROLES = Object.freeze([
  'full-research-qualification-publication',
  'machine-intake',
  'runtime-reproducibility-publication',
  'runtime-reproducibility-refresh',
  'topic-producer',
]);

export const PARTIAL_ROOT_REQUIRED_QUIESCED_SERVICES = Object.freeze([
  'autonomous-research-state-backup-renew.service',
  'autonomous-research-supervisor.service',
  'autonomous-submission-dispatcher.service',
  'strict-full-auto-acceptance.service',
]);

export const SUPERVISOR_BUSINESS_REPAIR_OBJECTS = Object.freeze([
  'index:idx_autonomous_research_supervisor_external_action_history',
  'index:idx_autonomous_research_supervisor_external_action_one_active',
  'table:autonomous_research_supervisor_external_action_journal',
]);

const IDENTITY_KEYS = Object.freeze([
  'implementationManifestHash',
  'machineIntakeConfigurationHash',
  'machineIntakeGenesisAuthorityMode',
  'providerCanaryPairMaximumCostUsd',
  'providerConfigurationHash',
  'runtimeReproducibilityRefreshPolicyHash',
  'topicProducerProfileHash',
  'writerManifestHash',
]);

function sameStrings(left, right) {
  return [...left].sort().join('\0') === [...right].sort().join('\0');
}

function safeRoot(candidate, label, { mustExist = true } = {}) {
  const resolved = path.resolve(String(candidate || ''));
  if (!candidate || resolved === path.parse(resolved).root) {
    throw new Error(`autonomous_research_state_partial_root_${label}_invalid`);
  }
  const selected = mustExist ? resolved : path.dirname(resolved);
  const stat = fs.lstatSync(selected);
  if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.mode & 0o022) !== 0
    || fs.realpathSync(selected) !== selected) {
    throw new Error(`autonomous_research_state_partial_root_${label}_unsafe`);
  }
  return resolved;
}

function assertMaintenanceIdentity(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || !sameStrings(Object.keys(value), IDENTITY_KEYS)
    || !SHA256.test(String(value.implementationManifestHash || ''))
    || !SHA256.test(String(value.machineIntakeConfigurationHash || ''))
    || !['external', 'root-owned-configuration'].includes(
      value.machineIntakeGenesisAuthorityMode,
    )
    || !SHA256.test(String(value.providerConfigurationHash || ''))
    || !SHA256.test(String(value.runtimeReproducibilityRefreshPolicyHash || ''))
    || !SHA256.test(String(value.topicProducerProfileHash || ''))
    || !SHA256.test(String(value.writerManifestHash || ''))
    || !Number.isFinite(Number(value.providerCanaryPairMaximumCostUsd))
    || Number(value.providerCanaryPairMaximumCostUsd) <= 0) {
    throw new Error('autonomous_research_state_partial_root_identity_invalid');
  }
  return Object.freeze({
    ...value,
    providerCanaryPairMaximumCostUsd: Number(value.providerCanaryPairMaximumCostUsd),
  });
}

function updateRowValue(digest, key, value) {
  digest.update(`${Buffer.byteLength(key)}:${key}:`);
  if (value === null) digest.update('null:');
  else if (Buffer.isBuffer(value) || value instanceof Uint8Array) {
    digest.update(`bytes:${value.byteLength}:`);
    digest.update(value);
  } else {
    const selected = String(value);
    digest.update(`${typeof value}:${Buffer.byteLength(selected)}:${selected}:`);
  }
}

function tableState(database, table) {
  const quoted = `"${table.replaceAll('"', '""')}"`;
  const schema = database.prepare(
    "SELECT sql FROM sqlite_schema WHERE type='table' AND name=?",
  ).get(table)?.sql;
  const digest = crypto.createHash('sha256');
  let rowCount = 0;
  let iterator;
  try { iterator = database.prepare(`SELECT * FROM ${quoted} ORDER BY rowid`).iterate(); }
  catch { iterator = database.prepare(`SELECT * FROM ${quoted}`).iterate(); }
  for (const row of iterator) {
    rowCount += 1;
    for (const [key, value] of Object.entries(row)) updateRowValue(digest, key, value);
    digest.update('\0');
  }
  return Object.freeze({
    name: table,
    rowCount,
    rowsHash: `sha256:${digest.digest('hex')}`,
    schemaHash: hashRecord('AutonomousResearchStatePartialRootBusinessTableSchema', {
      name: table,
      sql: String(schema || ''),
    }),
  });
}

export function partialRootBusinessStateFromDatabase(database) {
  const ignored = new Set([
    ...schemaTransitionTargetSchema({ role: 'resident-instance' }).objects.keys(),
    'autonomous_research_supervisor_external_action_journal',
  ]);
  const tables = database.prepare(`SELECT name FROM sqlite_schema
    WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name`).all()
    .map((row) => row.name).filter((name) => !ignored.has(name));
  const projection = Object.freeze(tables.map((table) => tableState(database, table)));
  return Object.freeze({
    tables: projection,
    businessStateHash: hashRecord(
      'AutonomousResearchStatePartialRootBusinessState', projection,
    ),
  });
}

export function partialRootBusinessState(sourcePath) {
  const database = new DatabaseSync(sourcePath, { readOnly: true });
  try { return partialRootBusinessStateFromDatabase(database); }
  finally { database.close(); }
}

export function assertPartialRootNoSqliteSidecars(sourcePath) {
  for (const suffix of ['-wal', '-shm', '-journal']) {
    if (fs.existsSync(`${sourcePath}${suffix}`)) {
      throw new Error(`autonomous_research_state_partial_root_sidecar_forbidden:${suffix}`);
    }
  }
}

function targetSchemaObjects(instance) {
  return [...schemaTransitionTargetSchema(instance).objects.values()]
    .map((row) => `${row.type}:${row.name}`).sort();
}

function expectedMissingObjects(instance) {
  return Object.freeze([
    ...targetSchemaObjects(instance),
    ...(instance.role === 'supervisor-state' ? SUPERVISOR_BUSINESS_REPAIR_OBJECTS : []),
  ].sort());
}

function expectedInventoryBlockers(instances) {
  return Object.freeze([
    ...PARTIAL_ROOT_MISSING_ROLES.map((role) => (
      `autonomous_research_state_database_required_missing:${role}`
    )),
    ...instances.map((instance) => (
      `autonomous_research_state_database_schema_contract_mismatch:${instance.instanceId}:` +
      `${instance.schemaContractId}:${instance.missingSchemaObjects.join(',')}`
    )),
  ].sort());
}

function assertCanonicalPartialInventory({ runtimeRoot, manifest, inventory }) {
  const manifestRoles = manifest.databases.map((entry) => entry.role);
  if (!sameStrings(manifestRoles, AUTONOMOUS_RESEARCH_STATE_DATABASE_ROLES)
    || manifest.databases.some((entry) => entry.cardinality !== 'singleton')
    || !sameStrings(inventory.instances.map((entry) => entry.role), PARTIAL_ROOT_EXISTING_ROLES)
    || inventory.instances.length !== PARTIAL_ROOT_EXISTING_ROLES.length) {
    throw new Error('autonomous_research_state_partial_root_role_closure_invalid');
  }
  for (const instance of inventory.instances) {
    if ((Number(instance.sourceFileIdentity.mode) & 0o022) !== 0
      || instance.sourceFileIdentity.links !== '1') {
      throw new Error(
        `autonomous_research_state_partial_root_database_identity_unsafe:${instance.role}`,
      );
    }
    if (!sameStrings(instance.missingSchemaObjects, expectedMissingObjects(instance))) {
      throw new Error(
        `autonomous_research_state_partial_root_schema_gap_invalid:${instance.role}`,
      );
    }
    assertPartialRootNoSqliteSidecars(path.join(runtimeRoot, instance.sourceRelativePath));
  }
  if (!sameStrings(inventory.blockers, expectedInventoryBlockers(inventory.instances))) {
    throw new Error('autonomous_research_state_partial_root_inventory_blockers_invalid');
  }
  return inventory;
}

function quiescencePayload(value) {
  return Object.freeze({
    version: value.version,
    kind: value.kind,
    status: value.status,
    runtimeRoot: value.runtimeRoot,
    databaseScopeHash: value.databaseScopeHash,
    writerManifestHash: value.writerManifestHash,
    quiescedWriterServices: value.quiescedWriterServices,
    activeWriterProcessIds: value.activeWriterProcessIds,
    serviceInspectionComplete: value.serviceInspectionComplete,
    processInspectionComplete: value.processInspectionComplete,
    observedAt: value.observedAt,
    expiresAt: value.expiresAt,
  });
}

export function buildAutonomousResearchStatePartialRootWriterQuiescenceReceipt(value = {}) {
  const payload = quiescencePayload({
    version: 1,
    kind: 'AutonomousResearchStatePartialRootWriterQuiescenceReceipt',
    status: 'autonomous_research_state_partial_root_writers_quiesced',
    runtimeRoot: path.resolve(String(value.runtimeRoot || '')),
    databaseScopeHash: value.databaseScopeHash,
    writerManifestHash: value.writerManifestHash,
    quiescedWriterServices: Object.freeze(
      [...(value.quiescedWriterServices || [])].sort(),
    ),
    activeWriterProcessIds: Object.freeze([...(value.activeWriterProcessIds || [])]),
    serviceInspectionComplete: value.serviceInspectionComplete === true,
    processInspectionComplete: value.processInspectionComplete === true,
    observedAt: new Date(value.observedAt).toISOString(),
    expiresAt: new Date(value.expiresAt).toISOString(),
  });
  return Object.freeze({
    ...payload,
    receiptHash: hashRecord(
      'AutonomousResearchStatePartialRootWriterQuiescenceReceipt', payload,
    ),
  });
}

function assertWriterQuiescence({ receipt, runtimeRoot, inventory, identity, now }) {
  let normalized;
  try { normalized = buildAutonomousResearchStatePartialRootWriterQuiescenceReceipt(receipt); }
  catch { throw new Error('autonomous_research_state_partial_root_quiescence_invalid'); }
  if (!receipt || receipt.receiptHash !== normalized.receiptHash
    || normalized.runtimeRoot !== runtimeRoot
    || normalized.databaseScopeHash !== inventory.databaseScopeHash
    || normalized.writerManifestHash !== identity.writerManifestHash
    || !sameStrings(
      normalized.quiescedWriterServices, PARTIAL_ROOT_REQUIRED_QUIESCED_SERVICES,
    )
    || normalized.quiescedWriterServices.some((service) => !SAFE_SERVICE.test(service))
    || normalized.activeWriterProcessIds.length !== 0
    || !normalized.serviceInspectionComplete || !normalized.processInspectionComplete
    || Date.parse(normalized.observedAt) > now.getTime()
    || Date.parse(normalized.expiresAt) <= now.getTime()) {
    throw new Error('autonomous_research_state_partial_root_quiescence_invalid');
  }
  return normalized;
}

function planInstances(runtimeRoot, inventory) {
  return Object.freeze(inventory.instances.map((instance) => {
    const sourcePath = path.resolve(runtimeRoot, instance.sourceRelativePath);
    if (!pathWithin(runtimeRoot, sourcePath)) {
      throw new Error('autonomous_research_state_partial_root_path_outside_runtime');
    }
    return Object.freeze({
      instanceId: instance.instanceId,
      role: instance.role,
      sourceRelativePath: instance.sourceRelativePath,
      schemaContractId: instance.schemaContractId,
      schemaHash: instance.schemaHash,
      sourceSha256: instance.sourceSha256,
      sourceFileIdentity: instance.sourceFileIdentity,
      expectedMissingSchemaObjects: expectedMissingObjects(instance),
      businessState: partialRootBusinessState(sourcePath),
    });
  }).sort((left, right) => left.instanceId.localeCompare(right.instanceId)));
}

export function buildAutonomousResearchStatePartialRootMaintenancePlan({
  runtimeRoot,
  rescueRoot,
  stateDatabaseManifest,
  maintenanceIdentity,
  writerQuiescenceReceipt,
  clock = { now: () => new Date() },
} = {}) {
  const resolvedRuntimeRoot = safeRoot(runtimeRoot, 'runtime_root');
  const resolvedRescueRoot = safeRoot(rescueRoot, 'rescue_root');
  if (pathWithin(resolvedRuntimeRoot, resolvedRescueRoot)
    || pathWithin(resolvedRescueRoot, resolvedRuntimeRoot)
    || fs.statSync(resolvedRuntimeRoot).dev !== fs.statSync(resolvedRescueRoot).dev) {
    throw new Error('autonomous_research_state_partial_root_rescue_root_invalid');
  }
  const manifest = assertAutonomousResearchStateDatabaseManifest(stateDatabaseManifest);
  const identity = assertMaintenanceIdentity(maintenanceIdentity);
  const inventory = assertCanonicalPartialInventory({
    runtimeRoot: resolvedRuntimeRoot,
    manifest,
    inventory: resolveAutonomousResearchStateDatabaseInventory({
      runtimeRoot: resolvedRuntimeRoot,
      manifest,
    }),
  });
  const now = new Date(clock.now());
  if (!Number.isFinite(now.getTime())) {
    throw new Error('autonomous_research_state_partial_root_clock_invalid');
  }
  const quiescence = assertWriterQuiescence({
    receipt: writerQuiescenceReceipt,
    runtimeRoot: resolvedRuntimeRoot,
    inventory,
    identity,
    now,
  });
  const payload = Object.freeze({
    version: 1,
    kind: 'AutonomousResearchStatePartialRootMaintenancePlan',
    status: 'autonomous_research_state_partial_root_maintenance_plan_ready',
    ready: true,
    protocol: 'offline-partial-native-root-pre-transition-business-repair-v1',
    runtimeRoot: resolvedRuntimeRoot,
    rescueRoot: resolvedRescueRoot,
    stateDatabaseManifestHash: autonomousResearchStateDatabaseManifestHash(manifest),
    databaseScopeHash: inventory.databaseScopeHash,
    existingRoles: PARTIAL_ROOT_EXISTING_ROLES,
    missingRoles: PARTIAL_ROOT_MISSING_ROLES,
    instances: planInstances(resolvedRuntimeRoot, inventory),
    maintenanceIdentity: identity,
    writerQuiescenceReceiptHash: quiescence.receiptHash,
    rescueBundleAndCopyRestoreVerificationRequired: true,
    exclusiveDatabaseLocksRequired: true,
    onlineSchemaTransitionRequired: true,
    externalAuthorityInvocationAllowed: false,
  });
  return Object.freeze({
    ...payload,
    maintenancePlanId: hashRecord(
      'AutonomousResearchStatePartialRootMaintenancePlan', payload,
    ),
  });
}
