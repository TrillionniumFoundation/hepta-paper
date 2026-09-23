import assert from 'node:assert/strict';
import { runRetirementAudit } from '../retirement/audit.mjs';
import { createReadOnlyPaperStore } from '../../paper-adapters/persistence/store-provider.mjs';
import { defaultLegacyPaperFactoryRoot, defaultPaperRuntimeRoot } from '../../paper-adapters/runtime/workspace-layout.mjs';
import { assertIsolatedVerificationRuntime } from '../../paper-core/src/verification-runtime.mjs';
import { immutableLegacyMatrixReferenceStatus, prepareImmutableLegacyMatrixReference } from '../legacy-matrix-reference.mjs';

assertIsolatedVerificationRuntime('legacy migration matrix integrity');
const preparedByParent = process.env.HEPTA_LEGACY_REFERENCE_PREPARED === '1';
const reference = preparedByParent ? null : prepareImmutableLegacyMatrixReference();
if (reference) process.on('exit', reference.cleanup);
const referenceStatus = immutableLegacyMatrixReferenceStatus();
const root = reference?.root || defaultLegacyPaperFactoryRoot();
if (reference) process.env.PAPER_FACTORY_LEGACY_ROOT = root;
const auditStore = createReadOnlyPaperStore({ root, runtimeRoot: defaultPaperRuntimeRoot(), immutable: true });
const report = await runRetirementAudit({
  root,
  runtimeRoot: defaultPaperRuntimeRoot(),
  execute: false,
  store: auditStore,
});
auditStore.close();
const audit = report.retirementPlan.migrationMatrixAudit;

assert.equal(audit.backlogCount, 263);
assert.equal(audit.matrixEntryCount, 263);
assert.equal(audit.orphanEntryCount, 0);
assert.equal(audit.missingByPriority.P0, 0);
assert.ok(audit.verifiedEntryCount >= 13);
assert.equal(audit.verifiedEntryCount + audit.partialEntryCount, audit.matrixEntryCount);
assert.equal(audit.verifiedDispositionCount, audit.verifiedEntryCount);
assert.equal(
  audit.verifiedBehavioralReplacementCount + audit.verifiedExplicitRetirementCount,
  audit.verifiedDispositionCount,
);
assert.equal(audit.invalidEntryCount, audit.partialEntryCount);
assert.equal(audit.missingEntryCount, audit.partialEntryCount);
assert.equal(report.summary.activeP0MigrationBlockerCount, 0);
assert.equal(report.summary.activeP1MigrationBlockerCount, audit.partialEntryCount);
assert.equal(audit.verifiedBehavioralReplacementCount, 14);
assert.equal(audit.verifiedExplicitRetirementCount, 249);
assert.equal(report.summary.verifiedDispositionCount, 263);
assert.equal(report.summary.verifiedBehavioralReplacementCount, 14);
assert.equal(report.summary.verifiedExplicitRetirementCount, 249);
assert.equal(report.summary.semanticMigrationClaimCount, 14);
assert.equal(report.summary.verifiedSemanticMigrationCount, 14);
assert.equal(report.summary.functionalParityClaimAllowed, false);
assert.equal(report.summary.explicitRetirementIsNotBehavioralMigration, true);
assert.equal(
  report.summary.retirementReadinessStatus,
  'paper_factory_retirement_blocked',
);
assert.equal(report.retirementPlan.retirementReadinessGate.canRemoveOldControlPlane, false);
assert.ok(report.retirementPlan.retirementReadinessGate.blockers.includes('legacy_entrypoint_deprecation_not_ready'));
assert.equal(
  report.retirementPlan.retirementReadinessGate.retirementReadinessDoesNotMeanFunctionalParity,
  true,
);

process.stdout.write(JSON.stringify({
  ok: true,
  kind: 'LegacySemanticMigrationMatrixIntegrityTest',
  backlogCount: audit.backlogCount,
  matrixEntryCount: audit.matrixEntryCount,
  verifiedEntryCount: audit.verifiedEntryCount,
  verifiedBehavioralReplacementCount: audit.verifiedBehavioralReplacementCount,
  verifiedExplicitRetirementCount: audit.verifiedExplicitRetirementCount,
  partialEntryCount: audit.partialEntryCount,
  p0Blockers: report.summary.activeP0MigrationBlockerCount,
  p1Blockers: report.summary.activeP1MigrationBlockerCount,
  uniqueBehaviorTestExecutionCount: audit.uniqueBehaviorTestExecutionCount,
  legacyReferenceArchiveHash: referenceStatus.archiveSha256,
  legacyReferenceMatrixHash: referenceStatus.matrixSha256,
  liveLegacyRootRequired: false,
}) + '\n');
reference?.cleanup();
