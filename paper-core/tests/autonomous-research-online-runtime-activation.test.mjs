import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';

import {
  activateAutonomousResearchOnlineMutationRuntime,
  openAutonomousResearchOnlineRuntimeActivationDatabase,
} from '../../paper-adapters/automation/autonomous-research-online-runtime-activation.mjs';
import {
  openAutonomousResearchStateReconciliationDatabase,
} from '../../paper-adapters/automation/autonomous-research-state-reconciliation-database.mjs';
import {
  AUTONOMOUS_RESEARCH_ONLINE_AUTHORITY_EVIDENCE_CACHE_RELATIVE_PATH,
  createAutonomousResearchOnlineAuthorityEvidenceCacheWriter,
} from '../../paper-adapters/automation/autonomous-research-online-authority-evidence-cache.mjs';
import {
  AUTONOMOUS_RESEARCH_STATE_DATABASE_ROLES,
  autonomousResearchStateDatabaseInventoryHash,
  autonomousResearchStateDatabaseScopeHash,
} from '../../paper-domain/automation/autonomous-research-state-backup-contract.mjs';
import {
  AUTONOMOUS_RESEARCH_ONLINE_MUTATION_PROTOCOL,
} from '../../paper-domain/automation/autonomous-research-online-mutation-contract.mjs';
import {
  autonomousResearchOnlineSchemaTransitionReadyReceiptHash,
  AUTONOMOUS_RESEARCH_ONLINE_SCHEMA_TRANSITION_PROTOCOL,
} from '../../paper-domain/automation/autonomous-research-online-schema-transition-contract.mjs';
import {
  autonomousResearchOnlineWriterOperationManifestHash,
} from '../../paper-domain/automation/autonomous-research-online-writer-manifest.mjs';
import { hashRecord } from '../../workflow-kernel/record-hash.mjs';

const NOW = new Date('2026-07-18T09:00:00.000Z');
const H = (label) => hashRecord('AutonomousResearchOnlineRuntimeActivationTest', { label });
const ROLES = Object.freeze([...AUTONOMOUS_RESEARCH_STATE_DATABASE_ROLES].sort());

function fileIdentity(candidate) {
  const stat = fs.lstatSync(candidate, { bigint: true });
  return Object.freeze({
    device: String(stat.dev),
    inode: String(stat.ino),
    mode: String(stat.mode),
    links: String(stat.nlink),
    bytes: String(stat.size),
    modifiedNs: String(stat.mtimeNs),
    changedNs: String(stat.ctimeNs),
  });
}

function manifest({ coveredRoles = ROLES } = {}) {
  const operations = Object.freeze(ROLES.map((role, index) => Object.freeze({
    operationId: `${role}.testWriter.mutate.v1`,
    databaseRole: role,
    sourceFile: `paper-adapters/automation/runtime-activation-test-${index}.mjs`,
    entrypoint: `mutateRole${index}`,
    mutationClass: 'business-dml',
    protocolStatus: coveredRoles.includes(role)
      ? 'coordinator-integrated-reserve-apply-finalize-v1'
      : 'uncovered-no-coordinator-integration',
    coordinatorIntegrated: coveredRoles.includes(role),
  })));
  const writers = Object.freeze(coveredRoles.map((role) => {
    const operationId = `${role}.testWriter.mutate.v1`;
    return Object.freeze({
      writerId: `writer:${role}:test:v1`,
      databaseRoles: Object.freeze([role]),
      operationIds: Object.freeze([operationId]),
      implementationHash: H(`writer:${role}`),
      protocol: AUTONOMOUS_RESEARCH_ONLINE_MUTATION_PROTOCOL,
    });
  }));
  return Object.freeze({
    version: 1,
    kind: 'AutonomousResearchOnlineWriterCoverageManifest',
    manifestId: 'runtime-activation-test-v1',
    protocol: AUTONOMOUS_RESEARCH_ONLINE_MUTATION_PROTOCOL,
    requiredDatabaseRoles: ROLES,
    writers,
    operations,
    coverage: Object.freeze({
      requiredRoleCount: ROLES.length,
      coveredRoleCount: coveredRoles.length,
      coveredDatabaseRoles: Object.freeze([...coveredRoles].sort()),
      percent: Number((coveredRoles.length * 100 / ROLES.length).toFixed(2)),
    }),
  });
}

function inventory() {
  const instances = Object.freeze(ROLES.map((role) => Object.freeze({
    instanceId: role,
    role,
    paperId: null,
    sourceRelativePath: `autonomous-research/${role}.sqlite`,
    schemaContractId: `${role}-schema-v1`,
    missingSchemaObjects: Object.freeze([]),
    sourceFileIdentity: Object.freeze({ marker: role }),
    sourceSha256: H(`source:${role}`),
    walFileIdentity: null,
    walSha256: null,
    quickCheck: 'ok',
    foreignKeyViolationCount: 0,
    schemaHash: H(`schema:${role}`),
    schemaObjects: Object.freeze([]),
    userVersion: 1,
    applicationId: 0,
  })));
  const databaseScopeHash = autonomousResearchStateDatabaseScopeHash(instances);
  const base = Object.freeze({
    version: 1,
    kind: 'AutonomousResearchStateDatabaseInventory',
    status: 'autonomous_research_state_database_inventory_ready',
    manifestId: 'hepta-paper-autonomous-research-state-databases-v1',
    manifestHash: H('state-manifest'),
    databaseScopeHash,
    instances,
    blockers: Object.freeze([]),
  });
  return Object.freeze({
    ...base,
    inventoryHash: autonomousResearchStateDatabaseInventoryHash(base),
  });
}

function restoreDrill(closedInventory) {
  return Object.freeze({
    version: 1,
    kind: 'AutonomousResearchStateBackupSourcesInspection',
    status: 'autonomous_research_state_backup_sources_ready',
    bundlePath: '/backup/bundle',
    manifestId: closedInventory.manifestId,
    manifestHash: closedInventory.manifestHash,
    bundleManifestHash: H('bundle'),
    snapshotContentHash: H('snapshot'),
    inventoryHash: closedInventory.inventoryHash,
    databaseScopeHash: closedInventory.databaseScopeHash,
    databaseInstanceIds: Object.freeze(closedInventory.instances
      .map((entry) => entry.instanceId).sort()),
    restoreDrillReceiptHash: H('restore'),
    restoreDrillPerformedAt: '2026-07-18T08:59:00.000Z',
    authorityId: 'backup-authority',
    keyId: 'backup-key',
    headSequence: 3,
    headHash: H('backup-head'),
    sources: Object.freeze([
      { role: 'autonomous_state_backup_manifest', path: '/backup/manifest.json' },
      { role: 'autonomous_state_restore_drill_receipt', path: '/backup/restore.json' },
      ...closedInventory.instances.map((entry) => Object.freeze({
        role: `autonomous_state_database:${entry.instanceId}`,
        path: `/backup/${entry.instanceId}.sqlite`,
      })),
    ]),
    skippedCandidates: Object.freeze([]),
    blockers: Object.freeze([]),
  });
}

function onlineInspection(fullManifest, closedInventory) {
  const manifestHash = autonomousResearchOnlineWriterOperationManifestHash(fullManifest);
  const current = Object.freeze({
    status: 'autonomous_research_online_authority_head_current',
    authorityId: 'online-authority', keyId: 'online-key', sequence: 17,
    hash: H('global'), observedAt: NOW.toISOString(),
    expiresAt: '2026-07-18T09:05:00.000Z', receiptHash: H('current'),
    signatureVerified: true,
    verificationSource: 'pinned-external-authority-public-key-v1',
  });
  return Object.freeze({
    version: 1,
    kind: 'AutonomousResearchOnlineAntiRollbackInspection',
    status: 'autonomous_research_online_anti_rollback_ready',
    inspectionSource: 'pinned-external-authority-receipt-verifier-v1',
    inspectionMode: 'active-external-authority-challenge',
    protocol: AUTONOMOUS_RESEARCH_ONLINE_MUTATION_PROTOCOL,
    externalActionPerformed: true,
    currentHeadReceipt: current,
    activeChallengeReceipt: Object.freeze({
      ...current,
      status: 'autonomous_research_online_authority_active_challenge_verified',
      challengedAt: NOW.toISOString(),
      receiptHash: H('challenge'),
    }),
    writerCoverage: Object.freeze({
      version: 1,
      kind: 'AutonomousResearchOnlineWriterCoverageInspection',
      status: 'autonomous_research_online_writer_coverage_complete',
      manifest: fullManifest,
      manifestHash,
      staticInspection: Object.freeze({
        version: 1,
        kind: 'AutonomousResearchOnlineWriterStaticCoverageInspection',
        status: 'autonomous_research_online_writer_static_coverage_complete',
        inspectionSource: 'repository-ast-import-gate-v1',
        manifestHash,
        coveredDatabaseRoles: ROLES,
        astGateReceiptHash: H('ast'),
        codeProvenanceHash: H('code'),
      }),
      brokerScopeReceipt: Object.freeze({
        version: 1,
        kind: 'AutonomousResearchOnlineWriterBrokerScopeReceipt',
        status: 'autonomous_research_online_writer_broker_scope_complete',
        manifestHash,
        coveredDatabaseRoles: ROLES,
        authorityId: current.authorityId,
        keyId: current.keyId,
        sequence: current.sequence,
        hash: current.hash,
        observedAt: NOW.toISOString(),
        expiresAt: '2026-07-18T09:05:00.000Z',
        receiptHash: H('scope'),
        signatureVerified: true,
        verificationSource: 'pinned-external-authority-public-key-v1',
      }),
      blockers: Object.freeze([]),
    }),
    blockers: Object.freeze([]),
    inventoryHash: closedInventory.inventoryHash,
  });
}

function schemaTransitionReadiness(fullManifest, closedInventory, {
  expiresAt = '2026-07-18T09:05:00.000Z',
} = {}) {
  const base = Object.freeze({
    version: 1,
    kind: 'AutonomousResearchOnlineSchemaTransitionReadyReceipt',
    status: 'autonomous_research_online_schema_transition_ready',
    protocol: AUTONOMOUS_RESEARCH_ONLINE_SCHEMA_TRANSITION_PROTOCOL,
    transitionId: H('transition'),
    databaseScopeHash: closedInventory.databaseScopeHash,
    writerManifestHash: autonomousResearchOnlineWriterOperationManifestHash(fullManifest),
    inventoryHash: closedInventory.inventoryHash,
    schemaTransitionReceiptHash: H('schema-transition-receipt'),
    liveObservationReceiptHash: H('schema-transition-observation'),
    observedAt: NOW.toISOString(),
    expiresAt,
    externalAuthorityVerified: true,
    blockers: Object.freeze([]),
  });
  return Object.freeze({
    ...base,
    readinessReceiptHash: autonomousResearchOnlineSchemaTransitionReadyReceiptHash(base),
  });
}

test('canonical database activation persists derived evidence before exposing the ready wrapper', (t) => {
  const runtimeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'hepta-runtime-activation-'));
  t.after(() => fs.rmSync(runtimeRoot, { recursive: true, force: true }));
  const fullManifest = manifest();
  const closedInventory = inventory();
  const manifestHash = autonomousResearchOnlineWriterOperationManifestHash(fullManifest);
  const events = [];
  const configuredCoordinator = Object.freeze({
    implemented: true,
    protocol: AUTONOMOUS_RESEARCH_ONLINE_MUTATION_PROTOCOL,
    coveredDatabaseRoles: ROLES,
    executeMutation(input) { events.push(`execute:${input.operationId}`); return 'executed'; },
    recoverPendingMutations() { return 'recovered'; },
    inspectStatus() {
      return Object.freeze({
        implemented: true,
        status: 'externally_fenced_sqlite_mutation_coordinator_configured',
        coveredDatabaseRoles: ROLES,
        blockers: Object.freeze([
          'autonomous_research_online_mutation_runtime_activation_required',
        ]),
      });
    },
  });
  const authorityClient = Object.freeze({
    trust: Object.freeze({
      writerManifestHash: manifestHash,
      databaseScopeHash: closedInventory.databaseScopeHash,
    }),
  });
  const activationOptions = {
    workspaceRoot: '/workspace',
    runtimeRoot,
    inventory: closedInventory,
    latestRestoreDrill: restoreDrill(closedInventory),
    authorityProcessConfigurationPath: '/online-process.json',
    authorityConfigurationPath: '/online-public.json',
    configuredCoordinator,
    writerManifest: fullManifest,
    authorityClient,
    schemaTransitionReadiness: schemaTransitionReadiness(fullManifest, closedInventory),
    clock: { now: () => new Date(NOW) },
    openDatabase: ({ instance }) => Object.freeze({
      instanceId: instance.instanceId,
      close() { events.push(`close:${instance.instanceId}`); },
    }),
    reconcileDatabaseStartup({ databaseRole, databaseInstanceId }) {
      events.push(`reconcile:${databaseInstanceId}`);
      return Object.freeze({
        status: 'autonomous_research_online_mutation_unresolved_reservations_reconciled',
        databaseRole,
        databaseInstanceId,
        runtimeReady: false,
      });
    },
    resolveInventory() { events.push('inventory:refresh'); return closedInventory; },
    refreshAuthorityEvidence({ recordJournalEvidence }) {
      events.push(`challenge:${recordJournalEvidence}`);
      return Object.freeze({
        version: 1,
        kind: 'AutonomousResearchOnlineMutationActiveRefreshReceipt',
        status: 'autonomous_research_online_mutation_active_refresh_complete',
        externalActionPerformed: true,
        globalSequence: 17,
        globalHash: H('global'),
        currentHeadReceiptHash: H('current'),
        activeChallengeReceiptHash: H('challenge'),
        brokerScopeReceiptHash: H('scope'),
        authorityEvidence: Object.freeze({
          currentHead: Object.freeze({ receipt: Object.freeze({
            authorityId: 'online-authority', keyId: 'online-key',
          }) }),
          activeChallenge: Object.freeze({ receipt: Object.freeze({}) }),
          brokerScope: Object.freeze({ receipt: Object.freeze({}) }),
        }),
        journalRecorded: false,
        journalReceipt: null,
        recordedAt: NOW.toISOString(),
      });
    },
    inspectFinalizedDatabaseHead({ databaseInstanceId, inventory: observedInventory }) {
      events.push(`finalized:${databaseInstanceId}`);
      assert.equal(observedInventory, closedInventory);
      const instance = closedInventory.instances.find((entry) => (
        entry.instanceId === databaseInstanceId
      ));
      return Object.freeze({
        status: 'autonomous_research_online_finalized_head_reconciled',
        runtimeReady: false,
        databaseRole: instance.role,
        databaseInstanceId,
        authorityGlobalSequence: 17,
        authorityGlobalHash: H('global'),
        localDatabaseSequence: 0,
        localDatabaseHash: H(`database:${databaseInstanceId}`),
        localStateHash: H(`state:${databaseInstanceId}`),
        inspectionReceiptHash: H(`finalized:${databaseInstanceId}`),
      });
    },
    inspectActiveEvidence() {
      events.push('active:inspect');
      return onlineInspection(fullManifest, closedInventory);
    },
    createAuthorityEvidenceCacheWriter(input) {
      const writer = createAutonomousResearchOnlineAuthorityEvidenceCacheWriter(input);
      return Object.freeze({
        recordActiveAuthorityEvidence(cacheInput) {
          events.push('cache:record');
          return writer.recordActiveAuthorityEvidence(cacheInput);
        },
      });
    },
  };
  const result = activateAutonomousResearchOnlineMutationRuntime(activationOptions);
  assert.equal(result.receipt.databaseActivations.length, ROLES.length);
  assert.equal(result.receipt.coordinatorRuntimeReady, true);
  assert.equal(result.receipt.schemaTransitionReceiptHash, H('schema-transition-receipt'));
  assert.equal(result.coordinator.inspectStatus().blockers.length, 0);
  assert.equal(
    result.coordinator.inspectStatus().status,
    'externally_fenced_sqlite_mutation_coordinator_ready',
  );
  assert.equal(result.coordinator.executeMutation({ operationId: 'example' }), 'executed');
  const firstChallenge = events.findIndex((entry) => entry.startsWith('challenge:'));
  const lastReconcile = events.reduce((index, entry, candidate) => (
    entry.startsWith('reconcile:') ? candidate : index
  ), -1);
  const firstFinalized = events.findIndex((entry) => entry.startsWith('finalized:'));
  assert.ok(lastReconcile < firstChallenge && firstChallenge < firstFinalized);
  assert.ok(events.includes('challenge:false'));
  assert.ok(events.indexOf('active:inspect') < events.indexOf('cache:record'));
  assert.ok(events.indexOf('cache:record') < events.lastIndexOf('inventory:refresh'));
  assert.equal(
    fs.existsSync(path.join(
      runtimeRoot,
      ...AUTONOMOUS_RESEARCH_ONLINE_AUTHORITY_EVIDENCE_CACHE_RELATIVE_PATH.split('/'),
    )),
    true,
  );
  assert.match(result.receipt.authorityEvidenceCacheReceiptHash, /^sha256:[0-9a-f]{64}$/);

  assert.throws(
    () => activateAutonomousResearchOnlineMutationRuntime({
      ...activationOptions,
      createAuthorityEvidenceCacheWriter: () => Object.freeze({
        recordActiveAuthorityEvidence() { throw new Error('cache_write_failed'); },
      }),
    }),
    /cache_write_failed/,
  );

  const driftBase = Object.freeze({
    ...closedInventory,
    instances: Object.freeze(closedInventory.instances.map((entry, index) => (
      index === 0 ? Object.freeze({ ...entry, sourceSha256: H('source-drift') }) : entry
    ))),
  });
  const driftedInventory = Object.freeze({
    ...driftBase,
    inventoryHash: autonomousResearchStateDatabaseInventoryHash(driftBase),
  });
  let inventoryReads = 0;
  assert.throws(
    () => activateAutonomousResearchOnlineMutationRuntime({
      ...activationOptions,
      resolveInventory() {
        inventoryReads += 1;
        return inventoryReads === 1 ? closedInventory : driftedInventory;
      },
    }),
    /autonomous_research_online_runtime_activation_cache_mutated_state_inventory/,
  );
});

test('activation rejects a historically valid transition whose live observation expired', () => {
  const fullManifest = manifest();
  const closedInventory = inventory();
  assert.throws(() => activateAutonomousResearchOnlineMutationRuntime({
    workspaceRoot: '/workspace',
    runtimeRoot: '/runtime',
    inventory: closedInventory,
    latestRestoreDrill: restoreDrill(closedInventory),
    authorityProcessConfigurationPath: '/process',
    authorityConfigurationPath: '/public',
    configuredCoordinator: Object.freeze({
      implemented: true,
      protocol: AUTONOMOUS_RESEARCH_ONLINE_MUTATION_PROTOCOL,
      coveredDatabaseRoles: ROLES,
      executeMutation() {},
      recoverPendingMutations() {},
      inspectStatus: () => Object.freeze({
        implemented: true,
        status: 'externally_fenced_sqlite_mutation_coordinator_configured',
        coveredDatabaseRoles: ROLES,
        blockers: Object.freeze([
          'autonomous_research_online_mutation_runtime_activation_required',
        ]),
      }),
    }),
    writerManifest: fullManifest,
    authorityClient: Object.freeze({ trust: Object.freeze({
      writerManifestHash: autonomousResearchOnlineWriterOperationManifestHash(fullManifest),
      databaseScopeHash: closedInventory.databaseScopeHash,
    }) }),
    schemaTransitionReadiness: schemaTransitionReadiness(fullManifest, closedInventory, {
      expiresAt: '2026-07-18T08:59:59.000Z',
    }),
    clock: { now: () => new Date(NOW) },
  }), /autonomous_research_online_runtime_activation_schema_transition_required/);
});

test('partial writer coverage fails before opening a database or challenging authority', () => {
  const partialManifest = manifest({ coveredRoles: Object.freeze([ROLES[0]]) });
  let sideEffects = 0;
  assert.throws(
    () => activateAutonomousResearchOnlineMutationRuntime({
      workspaceRoot: '/workspace', runtimeRoot: '/runtime',
      inventory: inventory(), latestRestoreDrill: {},
      authorityProcessConfigurationPath: '/process',
      authorityConfigurationPath: '/public',
      configuredCoordinator: {}, writerManifest: partialManifest,
      authorityClient: {},
      openDatabase() { sideEffects += 1; },
    }),
    /autonomous_research_online_runtime_activation_inventory_invalid/,
  );
  assert.equal(sideEffects, 0);
});

test('shared submission handoff database permissions are accepted without weakening other roles', (t) => {
  const runtimeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'hepta-runtime-permissions-'));
  t.after(() => fs.rmSync(runtimeRoot, { recursive: true, force: true }));
  const openers = [
    openAutonomousResearchStateReconciliationDatabase,
    openAutonomousResearchOnlineRuntimeActivationDatabase,
  ];
  const createInstance = (role, mode) => {
    const databasePath = path.join(runtimeRoot, `${role}.sqlite`);
    const database = new DatabaseSync(databasePath);
    database.exec('CREATE TABLE state(value TEXT NOT NULL);');
    database.close();
    fs.chmodSync(databasePath, mode);
    return Object.freeze({
      role,
      sourceRelativePath: path.basename(databasePath),
      sourceFileIdentity: fileIdentity(databasePath),
    });
  };
  const handoff = createInstance('submission-handoff', 0o660);
  for (const openDatabase of openers) openDatabase({ runtimeRoot, instance: handoff }).close();

  const ordinary = createInstance('resident-instance', 0o660);
  for (const openDatabase of openers) {
    assert.throws(
      () => openDatabase({ runtimeRoot, instance: ordinary }),
      /database_unsafe/,
    );
  }

  const worldWritable = createInstance('submission-handoff-world', 0o662);
  const unsafeHandoff = Object.freeze({ ...worldWritable, role: 'submission-handoff' });
  for (const openDatabase of openers) {
    assert.throws(
      () => openDatabase({ runtimeRoot, instance: unsafeHandoff }),
      /database_unsafe/,
    );
  }
});
