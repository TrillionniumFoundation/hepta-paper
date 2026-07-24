import {
  AUTONOMOUS_RESEARCH_STATE_DATABASE_ROLES,
} from './autonomous-research-state-backup-contract.mjs';
import {
  AUTONOMOUS_RESEARCH_ONLINE_MUTATION_PROTOCOL,
} from './autonomous-research-online-mutation-contract.mjs';
import { hasExactObjectKeys } from '../../workflow-kernel/exact-object-keys.mjs';
import { hashRecord } from '../../workflow-kernel/record-hash.mjs';

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{1,191}$/;
const SOURCE_FILE = /^(?:paper-(?:adapters|application|composition)\/[A-Za-z0-9._/-]+\.mjs|paper-core\/bin\/[A-Za-z0-9._/-]+\.mjs|store\/migrations\/[A-Za-z0-9._-]+\.sql)$/;
const MUTATION_CLASSES = new Set([
  'business-dml',
  'lease-or-budget-dml',
  'publication-dml',
  'schema-or-genesis-ddl',
  'cross-database-maintenance',
]);
const ONLINE_DML_MUTATION_CLASSES = new Set([
  'business-dml',
  'lease-or-budget-dml',
  'publication-dml',
]);

export const AUTONOMOUS_RESEARCH_ONLINE_WRITER_MANIFEST_KIND =
  'AutonomousResearchOnlineWriterCoverageManifest';
export const AUTONOMOUS_RESEARCH_ONLINE_WRITER_PROTOCOL_STATUS =
  'uncovered-no-coordinator-integration';
export const AUTONOMOUS_RESEARCH_ONLINE_WRITER_INTEGRATED_PROTOCOL_STATUS =
  'coordinator-integrated-reserve-apply-finalize-v1';

function fail(code) {
  throw new Error(code);
}

function sameValues(left, right) {
  return Array.isArray(left)
    && Array.isArray(right)
    && left.length === right.length
    && left.every((value, index) => value === right[index]);
}

export function assertAutonomousResearchOnlineWriterOperationManifest(manifest) {
  const requiredRoles = [...AUTONOMOUS_RESEARCH_STATE_DATABASE_ROLES].sort();
  if (!hasExactObjectKeys(manifest, [
    'version', 'kind', 'manifestId', 'protocol', 'requiredDatabaseRoles',
    'writers', 'operations', 'coverage',
  ])
    || manifest.version !== 1
    || manifest.kind !== AUTONOMOUS_RESEARCH_ONLINE_WRITER_MANIFEST_KIND
    || !SAFE_ID.test(String(manifest.manifestId || ''))
    || manifest.protocol !== AUTONOMOUS_RESEARCH_ONLINE_MUTATION_PROTOCOL
    || !sameValues(manifest.requiredDatabaseRoles, requiredRoles)
    || !Array.isArray(manifest.writers)
    || !Array.isArray(manifest.operations)
    || manifest.operations.length === 0
    || !hasExactObjectKeys(manifest.coverage, [
      'requiredRoleCount', 'coveredRoleCount', 'coveredDatabaseRoles', 'percent',
    ])
    || manifest.coverage.requiredRoleCount !== requiredRoles.length
    || !Number.isInteger(manifest.coverage.coveredRoleCount)
    || manifest.coverage.coveredRoleCount < 0
    || manifest.coverage.coveredRoleCount > requiredRoles.length
    || !Array.isArray(manifest.coverage.coveredDatabaseRoles)
    || typeof manifest.coverage.percent !== 'number') {
    fail('autonomous_research_online_writer_operation_manifest_invalid');
  }
  const operationIds = new Set();
  const operationsBySourceAnchor = new Set();
  const enumeratedRoles = new Set();
  for (const operation of manifest.operations) {
    if (!hasExactObjectKeys(operation, [
      'operationId', 'databaseRole', 'sourceFile', 'entrypoint', 'mutationClass',
      'protocolStatus', 'coordinatorIntegrated',
    ])
      || !SAFE_ID.test(String(operation.operationId || ''))
      || operationIds.has(operation.operationId)
      || !requiredRoles.includes(operation.databaseRole)
      || !SOURCE_FILE.test(String(operation.sourceFile || ''))
      || !SAFE_ID.test(String(operation.entrypoint || ''))
      || !MUTATION_CLASSES.has(operation.mutationClass)
      || typeof operation.coordinatorIntegrated !== 'boolean'
      || operation.protocolStatus !== (operation.coordinatorIntegrated
        ? AUTONOMOUS_RESEARCH_ONLINE_WRITER_INTEGRATED_PROTOCOL_STATUS
        : AUTONOMOUS_RESEARCH_ONLINE_WRITER_PROTOCOL_STATUS)
      || (operation.coordinatorIntegrated
        && !ONLINE_DML_MUTATION_CLASSES.has(operation.mutationClass))) {
      fail('autonomous_research_online_writer_operation_invalid');
    }
    // A single repository may route the same named state-machine operation to
    // distinct, independently fenced databases. The database role is part of
    // the authority anchor; duplicates within one role remain forbidden.
    const sourceAnchor = `${operation.databaseRole}\0${operation.sourceFile}\0${operation.entrypoint}`;
    if (operationsBySourceAnchor.has(sourceAnchor)) {
      fail('autonomous_research_online_writer_source_anchor_duplicate');
    }
    operationIds.add(operation.operationId);
    operationsBySourceAnchor.add(sourceAnchor);
    enumeratedRoles.add(operation.databaseRole);
  }
  if (!sameValues([...enumeratedRoles].sort(), requiredRoles)) {
    fail('autonomous_research_online_writer_operation_roles_incomplete');
  }
  const operationsById = new Map(manifest.operations.map((operation) => [
    operation.operationId,
    operation,
  ]));
  const assignedOperationIds = new Set();
  const writerIds = new Set();
  const coveredRoles = new Set();
  for (const writer of manifest.writers) {
    if (!hasExactObjectKeys(writer, [
      'writerId', 'databaseRoles', 'operationIds', 'implementationHash', 'protocol',
    ])
      || !SAFE_ID.test(String(writer.writerId || ''))
      || writerIds.has(writer.writerId)
      || !Array.isArray(writer.databaseRoles)
      || writer.databaseRoles.length === 0
      || !sameValues([...writer.databaseRoles].sort(), writer.databaseRoles)
      || new Set(writer.databaseRoles).size !== writer.databaseRoles.length
      || writer.databaseRoles.some((role) => !requiredRoles.includes(role))
      || !Array.isArray(writer.operationIds)
      || writer.operationIds.length === 0
      || !sameValues([...writer.operationIds].sort(), writer.operationIds)
      || new Set(writer.operationIds).size !== writer.operationIds.length
      || !/^sha256:[0-9a-f]{64}$/.test(String(writer.implementationHash || ''))
      || writer.protocol !== AUTONOMOUS_RESEARCH_ONLINE_MUTATION_PROTOCOL) {
      fail('autonomous_research_online_writer_invalid');
    }
    const writerRoles = new Set();
    for (const operationId of writer.operationIds) {
      const operation = operationsById.get(operationId);
      if (!operation?.coordinatorIntegrated || assignedOperationIds.has(operationId)) {
        fail('autonomous_research_online_writer_operation_assignment_invalid');
      }
      writerRoles.add(operation.databaseRole);
      assignedOperationIds.add(operationId);
    }
    if (!sameValues([...writerRoles].sort(), writer.databaseRoles)) {
      fail('autonomous_research_online_writer_role_assignment_invalid');
    }
    writer.databaseRoles.forEach((role) => coveredRoles.add(role));
    writerIds.add(writer.writerId);
  }
  const integratedOperationIds = manifest.operations
    .filter((operation) => operation.coordinatorIntegrated)
    .map((operation) => operation.operationId)
    .sort();
  if (!sameValues([...assignedOperationIds].sort(), integratedOperationIds)) {
    fail('autonomous_research_online_writer_integrated_operation_unassigned');
  }
  for (const operation of manifest.operations) {
    if (coveredRoles.has(operation.databaseRole)
      && ONLINE_DML_MUTATION_CLASSES.has(operation.mutationClass)
      && operation.coordinatorIntegrated !== true) {
      fail(
        `autonomous_research_online_writer_role_dml_coverage_incomplete:${operation.operationId}`,
      );
    }
  }
  const sortedCoveredRoles = [...coveredRoles].sort();
  const expectedPercent = Number((sortedCoveredRoles.length * 100
    / requiredRoles.length).toFixed(2));
  if (manifest.coverage.coveredRoleCount !== sortedCoveredRoles.length
    || !sameValues(manifest.coverage.coveredDatabaseRoles, sortedCoveredRoles)
    || manifest.coverage.percent !== expectedPercent) {
    fail('autonomous_research_online_writer_coverage_invalid');
  }
  return manifest;
}

export function autonomousResearchOnlineWriterOperationManifestHash(manifest) {
  return hashRecord(
    AUTONOMOUS_RESEARCH_ONLINE_WRITER_MANIFEST_KIND,
    assertAutonomousResearchOnlineWriterOperationManifest(manifest),
  );
}
