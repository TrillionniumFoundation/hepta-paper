import assert from 'node:assert/strict';
import test from 'node:test';

import {
  assertAutonomousResearchOnlineMutationFinalizeRequest,
  assertAutonomousResearchOnlineMutationReserveRequest,
  autonomousResearchOnlineMutationLocalMarkerHash,
  autonomousResearchOnlineMutationReceiptHash,
  autonomousResearchOnlineMutationStateHash,
  AUTONOMOUS_RESEARCH_ONLINE_MUTATION_PROTOCOL,
} from '../../paper-domain/automation/autonomous-research-online-mutation-contract.mjs';
import {
  assertAutonomousResearchOnlineWriterOperationManifest,
  autonomousResearchOnlineWriterOperationManifestHash,
  AUTONOMOUS_RESEARCH_ONLINE_WRITER_INTEGRATED_PROTOCOL_STATUS,
  AUTONOMOUS_RESEARCH_ONLINE_WRITER_MANIFEST_KIND,
  AUTONOMOUS_RESEARCH_ONLINE_WRITER_PROTOCOL_STATUS,
} from '../../paper-domain/automation/autonomous-research-online-writer-manifest.mjs';
import {
  assertAutonomousResearchOnlineMutationAbortRequest,
} from '../../paper-domain/automation/autonomous-research-online-mutation-recovery-contract.mjs';
import {
  AUTONOMOUS_RESEARCH_STATE_DATABASE_ROLES,
} from '../../paper-domain/automation/autonomous-research-state-backup-contract.mjs';
import { hashBytes, hashRecord } from '../../workflow-kernel/record-hash.mjs';
import {
  discoverAutonomousResearchOnlineWriterMutationEntrypoints,
} from '../../paper-adapters/automation/autonomous-research-online-writer-static-inspection.mjs';
import {
  AUTONOMOUS_RESEARCH_ONLINE_WRITER_OPERATION_MANIFEST,
} from '../../paper-adapters/automation/autonomous-research-online-writer-operation-manifest.mjs';
import {
  autonomousResearchNativeStoreOnlineMutationRouting,
} from '../../paper-composition/bootstrap/autonomous-research-native-store-composition.mjs';

const H = (label) => hashRecord('AutonomousResearchOnlineMutationContractTest', { label });

function operation(role, integrated = false) {
  return Object.freeze({
    operationId: `${role}.commit.v1`,
    databaseRole: role,
    sourceFile: `paper-adapters/automation/${role}-writer.mjs`,
    entrypoint: `${role}.commit`,
    mutationClass: 'business-dml',
    protocolStatus: integrated
      ? AUTONOMOUS_RESEARCH_ONLINE_WRITER_INTEGRATED_PROTOCOL_STATUS
      : AUTONOMOUS_RESEARCH_ONLINE_WRITER_PROTOCOL_STATUS,
    coordinatorIntegrated: integrated,
  });
}

function partialManifest(integratedRole = 'resident-instance') {
  const operations = AUTONOMOUS_RESEARCH_STATE_DATABASE_ROLES.map(
    (role) => operation(role, role === integratedRole),
  );
  return {
    version: 1,
    kind: AUTONOMOUS_RESEARCH_ONLINE_WRITER_MANIFEST_KIND,
    manifestId: 'online-writer-contract-test-v1',
    protocol: AUTONOMOUS_RESEARCH_ONLINE_MUTATION_PROTOCOL,
    requiredDatabaseRoles: Object.freeze(
      [...AUTONOMOUS_RESEARCH_STATE_DATABASE_ROLES].sort(),
    ),
    writers: Object.freeze([{
      writerId: `writer:${integratedRole}`,
      databaseRoles: Object.freeze([integratedRole]),
      operationIds: Object.freeze([`${integratedRole}.commit.v1`]),
      implementationHash: H(`writer:${integratedRole}`),
      protocol: AUTONOMOUS_RESEARCH_ONLINE_MUTATION_PROTOCOL,
    }]),
    operations: Object.freeze(operations),
    coverage: Object.freeze({
      requiredRoleCount: AUTONOMOUS_RESEARCH_STATE_DATABASE_ROLES.length,
      coveredRoleCount: 1,
      coveredDatabaseRoles: Object.freeze([integratedRole]),
      percent: Number((100 / AUTONOMOUS_RESEARCH_STATE_DATABASE_ROLES.length).toFixed(2)),
    }),
  };
}

test('writer manifest derives partial coverage from assigned integrated DML operations', () => {
  const manifest = partialManifest();
  assert.equal(assertAutonomousResearchOnlineWriterOperationManifest(manifest), manifest);
  assert.match(autonomousResearchOnlineWriterOperationManifestHash(manifest), /^sha256:/);

  const ddl = structuredClone(manifest);
  ddl.operations.find((entry) => entry.databaseRole === 'resident-instance')
    .mutationClass = 'schema-or-genesis-ddl';
  assert.throws(
    () => assertAutonomousResearchOnlineWriterOperationManifest(ddl),
    /autonomous_research_online_writer_operation_invalid/,
  );

  const wrongRole = structuredClone(manifest);
  wrongRole.writers[0].databaseRoles = ['native-store'];
  wrongRole.coverage.coveredDatabaseRoles = ['native-store'];
  assert.throws(
    () => assertAutonomousResearchOnlineWriterOperationManifest(wrongRole),
    /autonomous_research_online_writer_role_assignment_invalid/,
  );
});

test('covered roles reject any remaining unintegrated online DML operation', () => {
  const manifest = structuredClone(partialManifest());
  manifest.operations.push({
    operationId: 'resident-instance.second-commit.v1',
    databaseRole: 'resident-instance',
    sourceFile: 'paper-adapters/automation/resident-instance-second-writer.mjs',
    entrypoint: 'resident-instance.second-commit',
    mutationClass: 'business-dml',
    protocolStatus: AUTONOMOUS_RESEARCH_ONLINE_WRITER_PROTOCOL_STATUS,
    coordinatorIntegrated: false,
  });
  assert.throws(
    () => assertAutonomousResearchOnlineWriterOperationManifest(manifest),
    /autonomous_research_online_writer_role_dml_coverage_incomplete:resident-instance.second-commit.v1/,
  );
});

test('canonical native-store routing covers every integrated native operation exactly once', () => {
  const manifest = assertAutonomousResearchOnlineWriterOperationManifest(
    AUTONOMOUS_RESEARCH_ONLINE_WRITER_OPERATION_MANIFEST,
  );
  const routing = autonomousResearchNativeStoreOnlineMutationRouting({ manifest });
  const nativeOperations = manifest.operations.filter((operation) => (
    operation.databaseRole === 'native-store'
    && operation.coordinatorIntegrated === true
  ));
  const nativeWriters = manifest.writers.filter((writer) => (
    writer.databaseRoles.includes('native-store')
  ));

  assert.equal(
    manifest.coverage.coveredRoleCount,
    AUTONOMOUS_RESEARCH_STATE_DATABASE_ROLES.length,
  );
  assert.equal(manifest.coverage.percent, 100);
  assert.equal(routing.writerManifestHash, autonomousResearchOnlineWriterOperationManifestHash(
    manifest,
  ));
  assert.equal(routing.writerIds.length, 7);
  assert.equal(routing.operationIds.length, 67);
  assert.deepEqual(routing.writerIds, nativeWriters.map((writer) => writer.writerId).sort());
  assert.deepEqual(
    routing.operationIds,
    nativeOperations.map((operation) => operation.operationId).sort(),
  );
  assert.equal(new Set(Object.keys(routing.operationWriters)).size, 67);
  for (const writer of nativeWriters) {
    for (const operationId of writer.operationIds) {
      assert.equal(routing.operationWriters[operationId], writer.writerId);
    }
  }
});

test('static discovery rejects an integrated callback that captures the raw database', () => {
  const inspection = discoverAutonomousResearchOnlineWriterMutationEntrypoints(
    'paper-adapters/automation/resident-instance-writer.mjs',
    `export function commit(database, coordinator) {
      return coordinator.executeMutation({
        databaseRole: 'resident-instance',
        operationId: 'resident-instance.commit.v1',
        mutate() { database.exec('UPDATE resident SET generation=generation+1'); },
      });
    }`,
  );
  assert.deepEqual(inspection.coordinatorBindings, [{
    entrypoint: 'commit',
    databaseRole: 'resident-instance',
    operationId: 'resident-instance.commit.v1',
  }]);
  assert.ok(inspection.entrypoints.includes('commit'));
  assert.deepEqual(inspection.callbackBoundaryViolations.map((violation) => ({
    entrypoint: violation.entrypoint,
    operationId: violation.operationId,
    capabilityBinding: violation.capabilityBinding,
    method: violation.method,
  })), [{
    entrypoint: 'commit',
    operationId: 'resident-instance.commit.v1',
    capabilityBinding: 'database',
    method: 'exec',
  }]);
});

test('static discovery rejects an arrow callback that captures an aliased database', () => {
  const inspection = discoverAutonomousResearchOnlineWriterMutationEntrypoints(
    'paper-adapters/automation/resident-instance-writer.mjs',
    `export function commit(db, coordinator) {
      const rawAlias = db;
      return coordinator.executeMutation({
        databaseRole: 'resident-instance',
        operationId: 'resident-instance.commit.v1',
        mutate: (transaction) => rawAlias.prepare('UPDATE resident SET generation=1').run(),
      });
    }`,
  );
  assert.deepEqual(inspection.callbackBoundaryViolations.map((violation) => ({
    capabilityBinding: violation.capabilityBinding,
    method: violation.method,
  })), [{ capabilityBinding: 'rawAlias', method: 'prepare' }]);
});

test('static discovery resolves an assigned arrow callback before checking captures', () => {
  const inspection = discoverAutonomousResearchOnlineWriterMutationEntrypoints(
    'paper-adapters/automation/resident-instance-writer.mjs',
    `export function commit(database, coordinator) {
      const rawAlias = database;
      const mutate = (transaction) => rawAlias.exec('UPDATE resident SET generation=1');
      return coordinator.executeMutation({
        databaseRole: 'resident-instance',
        operationId: 'resident-instance.commit.v1',
        mutate,
      });
    }`,
  );
  assert.deepEqual(inspection.callbackBoundaryViolations.map((violation) => ({
    capabilityBinding: violation.capabilityBinding,
    method: violation.method,
  })), [{ capabilityBinding: 'rawAlias', method: 'exec' }]);
});

test('static discovery rejects a callback that captures an aliased StorePort', () => {
  const inspection = discoverAutonomousResearchOnlineWriterMutationEntrypoints(
    'paper-adapters/persistence/native-writer.mjs',
    `export function put(store, method) {
      const escapedStore = store;
      return store.mutate({
        databaseRole: 'native-store',
        operationId: 'native-store.native-writer.put.v1',
        mutate: (transaction) => escapedStore[method]('UPDATE state SET value=1'),
      });
    }`,
  );
  assert.deepEqual(inspection.callbackBoundaryViolations.map((violation) => ({
    capabilityBinding: violation.capabilityBinding,
    method: violation.method,
  })), [{ capabilityBinding: 'escapedStore', method: 'dynamic' }]);
});

test('static discovery scans typed-only coordinator writers without raw database access', () => {
  const inspection = discoverAutonomousResearchOnlineWriterMutationEntrypoints(
    'paper-adapters/automation/typed-supervisor-writer.mjs',
    `export function commit(coordinator) {
      return coordinator.executeMutation({
        databaseRole: 'supervisor-state',
        operationId: 'supervisor-state.commit.v1',
        mutate(transaction) { transaction.run('supervisor-state.apply.v1', 'value'); },
      });
    }`,
  );
  assert.deepEqual(inspection.entrypoints, ['commit']);
  assert.deepEqual(inspection.coordinatorBindings, [{
    entrypoint: 'commit',
    databaseRole: 'supervisor-state',
    operationId: 'supervisor-state.commit.v1',
  }]);
  assert.deepEqual(inspection.callbackBoundaryViolations, []);
});

test('static discovery binds a literal strict StorePort mutation to its public operation', () => {
  const inspection = discoverAutonomousResearchOnlineWriterMutationEntrypoints(
    'paper-adapters/persistence/native-writer.mjs',
    `export function put(store) {
      return store.mutate({
        databaseRole: 'native-store',
        operationId: 'native-store.native-writer.put.v1',
        mutate(transaction) { transaction.run('native-writer.put.v1', 'value'); },
      });
    }`,
  );
  assert.deepEqual(inspection.entrypoints, ['put']);
  assert.deepEqual(inspection.coordinatorBindings, [{
    entrypoint: 'put',
    databaseRole: 'native-store',
    operationId: 'native-store.native-writer.put.v1',
  }]);
  assert.deepEqual(inspection.callbackBoundaryViolations, []);
});

test('static discovery allows a transaction alias and a pure helper call', () => {
  const inspection = discoverAutonomousResearchOnlineWriterMutationEntrypoints(
    'paper-adapters/persistence/native-writer.mjs',
    `function canonicalValue(value) { return String(value).trim(); }
    export function put(store, value) {
      return store.mutate({
        databaseRole: 'native-store',
        operationId: 'native-store.native-writer.put.v1',
        mutate(transaction) {
          const authorizedTransaction = transaction;
          return authorizedTransaction.run(
            'native-writer.put.v1',
            canonicalValue(value),
          );
        },
      });
    }`,
  );
  assert.deepEqual(inspection.callbackBoundaryViolations, []);
});

test('static discovery canonicalizes repeated call sites for one public operation', () => {
  const inspection = discoverAutonomousResearchOnlineWriterMutationEntrypoints(
    'paper-adapters/persistence/native-writer.mjs',
    `export function put(store, retry) {
      store.mutate({
        databaseRole: 'native-store',
        operationId: 'native-store.native-writer.put.v1',
        mutate(transaction) { transaction.run('native-writer.put.v1', 'first'); },
      });
      if (retry) store.mutate({
        databaseRole: 'native-store',
        operationId: 'native-store.native-writer.put.v1',
        mutate(transaction) { transaction.run('native-writer.put.v1', 'retry'); },
      });
    }`,
  );
  assert.deepEqual(inspection.coordinatorBindings, [{
    entrypoint: 'put',
    databaseRole: 'native-store',
    operationId: 'native-store.native-writer.put.v1',
  }]);
});

test('static discovery excludes only coordinator transaction and marker internals', () => {
  const inspection = discoverAutonomousResearchOnlineWriterMutationEntrypoints(
    'paper-adapters/automation/externally-fenced-sqlite-mutation-coordinator.mjs',
    `function insertMarker(database) {
      database.prepare('INSERT INTO system_marker(value) VALUES(?)').run('marker');
    }
    export function createCoordinator(database) {
      function executeMutation() {
        database.exec('BEGIN IMMEDIATE');
        insertMarker(database);
      }
      function businessWriter() { database.exec('UPDATE research_result SET value=1'); }
      return { executeMutation, businessWriter };
    }`,
  );
  assert.deepEqual(inspection.entrypoints, ['businessWriter']);
  assert.deepEqual(inspection.excludedEntrypoints.map((entry) => entry.entrypoint), [
    'insertMarker', 'executeMutation',
  ]);
});

test('false-positive exclusions remain entrypoint-scoped beside real business writers', () => {
  const fixtures = [
    {
      category: 'pure repository factory',
      sourceFile: 'paper-adapters/persistence/sqlite-job-receipt-store.mjs',
      excludedEntrypoint: 'createSqliteJobReceiptStore',
      source: `export function createSqliteJobReceiptStore() {
        return Object.freeze({ kind: 'JobReceiptStore' });
      }
      export function businessWriter(database) {
        database.exec("UPDATE jobs SET status='running'");
      }`,
    },
    {
      category: 'filesystem repository',
      sourceFile:
        'paper-adapters/automation/autonomous-research-workspace-repository.mjs',
      excludedEntrypoint: 'createAutonomousResearchWorkspaceRepository',
      source: `export function createAutonomousResearchWorkspaceRepository() {
        return Object.freeze({ writeTextOnce() {} });
      }
      export function businessWriter(database) {
        database.exec("UPDATE campaigns SET status='running'");
      }`,
    },
    {
      category: 'read-only composition',
      sourceFile: 'paper-composition/automation/automation-readiness-query.mjs',
      excludedEntrypoint: 'queryAutomationReadiness',
      source: `import { createFullResearchQualificationReceiptPointerRepository }
        from '../../paper-adapters/automation/full-research-qualification-receipt-pointer-repository.mjs';
      export function queryAutomationReadiness() {
        return createFullResearchQualificationReceiptPointerRepository().read();
      }
      export function businessWriter(database) {
        database.exec('UPDATE readiness_state SET generation=generation+1');
      }`,
    },
    {
      category: 'service-only composition',
      sourceFile: 'paper-composition/bootstrap/capability-scoped-bootstrap.mjs',
      excludedEntrypoint: 'composeBatchServices',
      source: `import { createSqliteJobReceiptStore }
        from '../../paper-adapters/persistence/sqlite-job-receipt-store.mjs';
      export function composeBatchServices() {
        return Object.freeze({ jobs: createSqliteJobReceiptStore() });
      }
      export function businessWriter(database) {
        database.exec('UPDATE batch_state SET generation=generation+1');
      }`,
    },
    {
      category: 'isolated smoke harness',
      sourceFile: 'paper-core/bin/automation-campaign-smoke.mjs',
      excludedEntrypoint: 'moduleSchemaProvisioning',
      source: `const isolatedSchema = 'CREATE TABLE isolated_fixture(id INTEGER PRIMARY KEY)';
      export function businessWriter(database) {
        database.exec('UPDATE production_state SET generation=generation+1');
      }
      export { isolatedSchema };`,
    },
    {
      category: 'internal statement plan',
      sourceFile:
        'paper-adapters/automation/autonomous-research-runtime-refresh-mutation-plan.mjs',
      excludedEntrypoint: 'moduleSchemaProvisioning',
      source: `export const transactionShell =
        'UPDATE runtime_refresh_state SET generation=generation';
      export function businessWriter(database) {
        database.exec('UPDATE runtime_refresh_state SET generation=generation+1');
      }`,
    },
    {
      category: 'supervisor state internal statement plan',
      sourceFile:
        'paper-adapters/automation/autonomous-research-supervisor-state-mutation-plan.mjs',
      excludedEntrypoint: 'moduleSchemaProvisioning',
      source: `export const transactionShell =
        'UPDATE supervisor_state SET generation=generation';
      export function businessWriter(database) {
        database.exec('UPDATE supervisor_state SET generation=generation+1');
      }`,
    },
  ];
  for (const fixture of fixtures) {
    const inspection = discoverAutonomousResearchOnlineWriterMutationEntrypoints(
      fixture.sourceFile,
      fixture.source,
    );
    assert.equal(inspection.exclusionReason, null, fixture.category);
    assert.deepEqual(inspection.entrypoints, ['businessWriter'], fixture.category);
    assert.deepEqual(
      inspection.excludedEntrypoints.map((entry) => entry.entrypoint),
      [fixture.excludedEntrypoint],
      fixture.category,
    );
  }
});

test('known conditional and production writable roots remain discovered', () => {
  const roots = [
    [
      'paper-adapters/automation/autonomous-research-machine-intake-repository.mjs',
      'createAutonomousResearchMachineIntakeRepository',
    ],
    [
      'paper-composition/automation/autonomous-research-campaign-composition.mjs',
      'composeAutonomousResearchCampaignAction',
    ],
    [
      'paper-composition/automation/autonomous-research-qualification-composition.mjs',
      'composeAutonomousResearchQualificationRenewal',
    ],
    [
      'paper-composition/automation/autonomous-research-supervisor-state-composition.mjs',
      'composeAutonomousResearchSupervisorState',
    ],
    [
      'paper-composition/automation/runtime-image-reproducibility-composition.mjs',
      'composeRuntimeImageReproducibilityVerification',
    ],
    [
      'paper-composition/bootstrap/automation-context-bootstrap.mjs',
      'bootstrapAutomationContext',
    ],
    ['paper-core/bin/hepta-store.mjs', 'writableStore'],
  ];
  for (const [sourceFile, entrypoint] of roots) {
    const inspection = discoverAutonomousResearchOnlineWriterMutationEntrypoints(
      sourceFile,
      `export function ${entrypoint}(database) {
        database.exec('UPDATE production_state SET generation=generation+1');
      }`,
    );
    assert.ok(inspection.entrypoints.includes(entrypoint), `${sourceFile}:${entrypoint}`);
    assert.equal(
      inspection.excludedEntrypoints.some((entry) => entry.entrypoint === entrypoint),
      false,
      `${sourceFile}:${entrypoint}`,
    );
  }
});

test('reserve and finalize requests bind canonical state and local marker hashes', () => {
  const trust = Object.freeze({
    version: 1,
    kind: 'AutonomousResearchOnlineMutationAuthorityTrust',
    authorityId: 'authority:test',
    keyId: 'key:test',
    scopeId: 'scope:test',
    databaseScopeHash: H('database-scope'),
    writerManifestHash: H('writer-manifest'),
    maximumReservationLeaseMs: 60_000,
    maximumObservationAgeMs: 60_000,
  });
  const changesetBase64 = Buffer.from('sqlite-session-changeset').toString('base64');
  const changesetHash = hashBytes(Buffer.from(changesetBase64, 'base64'));
  const stateInput = Object.freeze({
    databaseRole: 'resident-instance',
    databaseInstanceId: 'resident-instance',
    writerId: 'writer:resident-instance',
    operationId: 'resident-instance.commit.v1',
    schemaHash: H('schema'),
    previousStateHash: H('previous-state'),
    changesetHash,
    databaseSequence: 8,
    authorizationReceiptHashes: Object.freeze([H('authorization')]),
    sideEffectReservationHashes: Object.freeze([H('side-effect-reservation')]),
  });
  const postStateHash = autonomousResearchOnlineMutationStateHash(stateInput);
  const request = Object.freeze({
    version: 1,
    kind: 'AutonomousResearchOnlineMutationReserveRequest',
    protocol: AUTONOMOUS_RESEARCH_ONLINE_MUTATION_PROTOCOL,
    scopeId: trust.scopeId,
    databaseScopeHash: trust.databaseScopeHash,
    writerManifestHash: trust.writerManifestHash,
    databaseRole: stateInput.databaseRole,
    databaseInstanceId: stateInput.databaseInstanceId,
    writerId: stateInput.writerId,
    operationId: stateInput.operationId,
    codeProvenanceHash: H('code-provenance'),
    mutationAttemptId: 'mutation:test-attempt',
    globalPreviousSequence: 12,
    globalPreviousHash: H('global-previous'),
    databasePreviousSequence: 7,
    databasePreviousHash: H('database-previous'),
    schemaContractId: 'resident-instance-schema-v1',
    schemaHash: stateInput.schemaHash,
    preStateHash: stateInput.previousStateHash,
    postStateHash,
    changesetEncoding: 'base64',
    changesetBase64,
    changesetByteLength: Buffer.from(changesetBase64, 'base64').length,
    changesetHash,
    authorizationReceiptHashes: stateInput.authorizationReceiptHashes,
    sideEffectReservationHashes: stateInput.sideEffectReservationHashes,
    requestedAt: '2026-07-18T08:00:00.000Z',
    requestedLeaseMs: 30_000,
  });
  assert.equal(assertAutonomousResearchOnlineMutationReserveRequest(request, {
    trust,
    hashChangesetBase64: (value) => hashBytes(Buffer.from(value, 'base64')),
  }), request);

  const reservation = Object.freeze({
    ...request,
    reservationId: 'reservation:test',
    globalSequence: 13,
    globalHash: H('global-current'),
    databaseSequence: 8,
    databaseHash: H('database-current'),
  });
  const committedAt = '2026-07-18T08:00:01.000Z';
  const finalize = Object.freeze({
    version: 1,
    kind: 'AutonomousResearchOnlineMutationFinalizeRequest',
    protocol: request.protocol,
    scopeId: request.scopeId,
    databaseScopeHash: request.databaseScopeHash,
    writerManifestHash: request.writerManifestHash,
    reservationId: reservation.reservationId,
    reservationReceiptHash: autonomousResearchOnlineMutationReceiptHash(reservation),
    databaseRole: reservation.databaseRole,
    databaseInstanceId: reservation.databaseInstanceId,
    writerId: reservation.writerId,
    operationId: reservation.operationId,
    globalSequence: reservation.globalSequence,
    globalHash: reservation.globalHash,
    databaseSequence: reservation.databaseSequence,
    databaseHash: reservation.databaseHash,
    schemaHash: reservation.schemaHash,
    postStateHash: reservation.postStateHash,
    changesetHash: reservation.changesetHash,
    localMarkerHash: autonomousResearchOnlineMutationLocalMarkerHash({
      reservation,
      committedAt,
    }),
    authorizationReceiptHashes: reservation.authorizationReceiptHashes,
    sideEffectReservationHashes: reservation.sideEffectReservationHashes,
    committedAt,
  });
  assert.equal(
    assertAutonomousResearchOnlineMutationFinalizeRequest(finalize, reservation),
    finalize,
  );
  assert.throws(
    () => assertAutonomousResearchOnlineMutationFinalizeRequest({
      ...finalize,
      localMarkerHash: H('forged-marker'),
    }, reservation),
    /autonomous_research_online_mutation_finalize_request_invalid/,
  );
  const abort = Object.freeze({
    version: 1,
    kind: 'AutonomousResearchOnlineMutationAbortRequest',
    protocol: reservation.protocol,
    scopeId: reservation.scopeId,
    databaseScopeHash: reservation.databaseScopeHash,
    writerManifestHash: reservation.writerManifestHash,
    reservationId: reservation.reservationId,
    reservationReceiptHash: autonomousResearchOnlineMutationReceiptHash(reservation),
    databaseRole: reservation.databaseRole,
    databaseInstanceId: reservation.databaseInstanceId,
    writerId: reservation.writerId,
    operationId: reservation.operationId,
    mutationAttemptId: reservation.mutationAttemptId,
    globalSequence: reservation.globalSequence,
    globalHash: reservation.globalHash,
    databaseSequence: reservation.databaseSequence,
    databaseHash: reservation.databaseHash,
    changesetHash: reservation.changesetHash,
    reason: 'local-marker-failed',
    requestedAt: committedAt,
  });
  assert.equal(assertAutonomousResearchOnlineMutationAbortRequest(abort, reservation), abort);
});
