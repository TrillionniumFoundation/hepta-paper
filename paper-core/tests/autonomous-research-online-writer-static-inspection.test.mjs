import assert from 'node:assert/strict';
import test from 'node:test';

import {
  AUTONOMOUS_RESEARCH_ONLINE_WRITER_OPERATION_MANIFEST,
} from '../../paper-adapters/automation/autonomous-research-online-writer-operation-manifest.mjs';
import {
  discoverAutonomousResearchOnlineWriterMutationEntrypoints,
  inspectAutonomousResearchOnlineWriterStaticCoverage,
} from '../../paper-adapters/automation/autonomous-research-online-writer-static-inspection.mjs';
import { hashRecord } from '../../workflow-kernel/record-hash.mjs';

test('production writer discovery is complete and binds derived-cache provenance', () => {
  const inspection = inspectAutonomousResearchOnlineWriterStaticCoverage({
    workspaceRoot: process.cwd(),
    manifest: AUTONOMOUS_RESEARCH_ONLINE_WRITER_OPERATION_MANIFEST,
  });
  assert.equal(inspection.status, 'autonomous_research_online_writer_static_coverage_complete');
  assert.equal(inspection.operationCount, 204);
  assert.equal(
    AUTONOMOUS_RESEARCH_ONLINE_WRITER_OPERATION_MANIFEST.operations
      .filter((operation) => operation.coordinatorIntegrated).length,
    132,
  );
  assert.deepEqual(inspection.blockers, []);
  const sources = new Set(inspection.codeProvenanceSources.map((entry) => entry.sourceFile));
  assert.equal(
    sources.has(
      'paper-adapters/automation/autonomous-research-online-authority-evidence-cache.mjs',
    ),
    true,
  );
  assert.equal(
    sources.has(
      'paper-domain/automation/autonomous-research-online-authority-evidence-cache-contract.mjs',
    ),
    true,
  );
  assert.equal(
    sources.has(
      'paper-adapters/automation/autonomous-research-online-authority-evidence-renewal.mjs',
    ),
    true,
  );
  assert.equal(
    sources.has(
      'paper-application/automation/autonomous-research-online-authority-evidence-renewal-controller.mjs',
    ),
    true,
  );
  for (const sourceFile of [
    'paper-adapters/automation/autonomous-research-online-writer-operation-manifest.mjs',
    'paper-adapters/automation/autonomous-research-online-writer-static-callback-boundary.mjs',
    'paper-adapters/automation/autonomous-research-online-writer-static-config.mjs',
    'paper-adapters/automation/autonomous-research-online-writer-static-discovery.mjs',
    'paper-adapters/automation/autonomous-research-online-writer-static-inspection.mjs',
    'paper-adapters/automation/autonomous-research-public-deployment-identity-readers.mjs',
    'paper-adapters/automation/autonomous-research-qualification-attempt-infrastructure-operations.mjs',
    'paper-adapters/automation/autonomous-research-online-mutation-startup-reconciliation.mjs',
    'paper-adapters/automation/autonomous-research-state-backup-authority.mjs',
    'paper-adapters/automation/autonomous-research-state-backup-journal-replay.mjs',
    'paper-adapters/automation/autonomous-research-state-backup-repository.mjs',
    'paper-adapters/automation/autonomous-research-state-backup-source-operations.mjs',
    'paper-adapters/automation/autonomous-research-state-reconciliation-database.mjs',
    'paper-adapters/automation/autonomous-research-state-restore-receipt-validation.mjs',
    'paper-adapters/automation/externally-fenced-sqlite-mutation-coordinator-validation.mjs',
    'paper-adapters/persistence/native-store-campaign-parameter-projection.mjs',
    'paper-application/automation/autonomous-research-resident-lifecycle.mjs',
    'paper-application/automation/autonomous-research-resident-reactivation-required.mjs',
    'paper-application/automation/autonomous-research-supervisor-campaign-processor.mjs',
    'paper-application/automation/autonomous-research-state-backup-renewal.mjs',
    'paper-application/automation/autonomous-research-state-reconcile-and-renew.mjs',
    'paper-application/automation/autonomous-research-state-recoverability-controller.mjs',
    'paper-application/automation/autonomous-research-supervisor-autonomy-fence.mjs',
    'paper-application/automation/autonomous-research-supervisor.mjs',
    'paper-application/automation/autonomous-submission-delivery.mjs',
    'paper-application/automation/campaign-engine.mjs',
    'paper-application/automation/campaign-node-infrastructure-control.mjs',
    'paper-adapters/build-package/research-evidence-capsule-attestation.mjs',
    'paper-composition/automation/autonomous-research-provider-canary.mjs',
    'paper-composition/automation/autonomous-research-resident-deployment-identity.mjs',
    'paper-composition/automation/autonomous-research-state-safety-inspection.mjs',
    'paper-composition/automation/autonomous-research-supervisor-composition.mjs',
    'paper-composition/automation/autonomous-research-supervisor-external-action-composition.mjs',
    'paper-composition/automation/autonomous-research-supervisor-prerequisites.mjs',
    'paper-composition/bootstrap/autonomous-research-online-mutation-composition.mjs',
    'paper-composition/bootstrap/autonomous-research-state-business-schema-provisioning-composition.mjs',
    'paper-core/bin/autonomous-research-supervisor.mjs',
    'paper-core/config/autonomous-research-state-databases.v1.json',
    'paper-domain/automation/autonomous-research-online-writer-manifest.mjs',
    'paper-domain/automation/autonomous-research-state-safety-contract.mjs',
  ]) {
    assert.equal(sources.has(sourceFile), true);
  }
  const journalExclusions = inspection.excludedCandidates.filter((entry) => (
    entry.sourceFile ===
      'paper-adapters/automation/autonomous-research-online-authority-journal.mjs'
  ));
  assert.deepEqual(
    journalExclusions.map((entry) => entry.entrypoint).sort(),
    ['expectedAuthorityJournalSqliteSchemaIdentity', 'moduleSchemaProvisioning'],
  );
  const maintenanceEntrypoints = AUTONOMOUS_RESEARCH_ONLINE_WRITER_OPERATION_MANIFEST.operations
    .filter((operation) => operation.mutationClass === 'cross-database-maintenance')
    .map((operation) => `${operation.sourceFile}:${operation.entrypoint}`);
  for (const entrypoint of [
    'paper-adapters/automation/autonomous-research-resident-cycle-intent-repository.mjs:complete',
    'paper-adapters/automation/autonomous-research-resident-cycle-intent-repository.mjs:completeAutonomousResearchResidentCycleIntent',
    'paper-adapters/automation/autonomous-research-state-backup-journal-replay.mjs:drillDatabaseCopiesWithReplay',
    'paper-adapters/automation/autonomous-research-state-backup-journal-replay.mjs:insertReplayedAuthorityRecords',
    'paper-adapters/automation/runtime-image-reproducibility-receipt-repository.mjs:recoverPendingPublication',
    'paper-adapters/automation/full-research-qualification-receipt-pointer-repository.mjs:recoverPendingPublication',
  ]) {
    assert.equal(maintenanceEntrypoints.includes(entrypoint), true);
  }
});

test('an added journal business writer cannot hide behind the exact DDL exclusions', () => {
  const source = `
import { DatabaseSync } from 'node:sqlite';
export function businessWriter(databasePath) {
  const database = new DatabaseSync(databasePath);
  database.exec('INSERT INTO business_state(value) VALUES(1);');
  database.close();
}
`;
  const discovery = discoverAutonomousResearchOnlineWriterMutationEntrypoints(
    'paper-adapters/automation/autonomous-research-online-authority-journal.mjs',
    source,
  );
  assert.deepEqual(discovery.entrypoints, ['businessWriter']);
  assert.equal(discovery.exclusionReason, null);
});

test('changing a provenance-only cache source necessarily changes the provenance hash', () => {
  const inspection = inspectAutonomousResearchOnlineWriterStaticCoverage({
    workspaceRoot: process.cwd(),
    manifest: AUTONOMOUS_RESEARCH_ONLINE_WRITER_OPERATION_MANIFEST,
  });
  const changed = inspection.codeProvenanceSources.map((entry) => (
    entry.sourceFile
      === 'paper-adapters/automation/autonomous-research-online-authority-evidence-cache.mjs'
      ? Object.freeze({ ...entry, sourceHash: hashRecord('ChangedCacheSource', entry) })
      : entry
  ));
  assert.notEqual(
    hashRecord('AutonomousResearchOnlineWriterCodeProvenance', changed),
    inspection.codeProvenanceHash,
  );
});
