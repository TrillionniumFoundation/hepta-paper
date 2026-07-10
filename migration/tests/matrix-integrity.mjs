import assert from 'node:assert/strict';
import { runLegacyCleanupAdapter } from '../../paper-adapters/legacy-cleanup/index.mjs';

const root = '/data/home-data/paper_factory';
const report = await runLegacyCleanupAdapter({ root, execute: false });
const audit = report.retirementPlan.migrationMatrixAudit;

assert.equal(audit.backlogCount, 263);
assert.equal(audit.matrixEntryCount, 263);
assert.equal(audit.orphanEntryCount, 0);
assert.equal(audit.missingByPriority.P0, 0);
assert.ok(audit.verifiedEntryCount >= 13);
assert.equal(audit.verifiedEntryCount + audit.partialEntryCount, audit.matrixEntryCount);
assert.equal(audit.invalidEntryCount, audit.partialEntryCount);
assert.equal(audit.missingEntryCount, audit.partialEntryCount);
assert.equal(report.summary.activeP0MigrationBlockerCount, 0);
assert.equal(report.summary.activeP1MigrationBlockerCount, audit.partialEntryCount);

process.stdout.write(JSON.stringify({
  ok: true,
  kind: 'LegacySemanticMigrationMatrixIntegrityTest',
  backlogCount: audit.backlogCount,
  matrixEntryCount: audit.matrixEntryCount,
  verifiedEntryCount: audit.verifiedEntryCount,
  partialEntryCount: audit.partialEntryCount,
  p0Blockers: report.summary.activeP0MigrationBlockerCount,
  p1Blockers: report.summary.activeP1MigrationBlockerCount,
  uniqueBehaviorTestExecutionCount: audit.uniqueBehaviorTestExecutionCount,
}) + '\n');
