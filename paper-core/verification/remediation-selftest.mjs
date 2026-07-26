import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { buildCoreIntegrityReport, compareCoreFileRows } from '../src/core-integrity.mjs';
import { heptaStorePath } from '../src/hepta-store.mjs';
import { summarizeRows } from '../src/batch-summary.mjs';
import * as contractsFacade from '../src/paper-contracts.mjs';
import { buildRefereeReviewIntake as buildRefereeReviewIntakeDirect } from '../../paper-domain/contracts/referee-planning.mjs';
import { buildRefereeApplyApprovalPacket as buildRefereeApplyApprovalPacketDirect } from '../../paper-domain/contracts/referee-application.mjs';
import { buildRepairReconciliation as buildRepairReconciliationDirect } from '../../paper-domain/contracts/referee-closure.mjs';
import { buildSubmissionApprovalPacket as buildSubmissionApprovalPacketDirect } from '../../paper-domain/contracts/submission.mjs';
import { buildVenueResolutionPacket as buildVenueResolutionPacketDirect } from '../../paper-domain/contracts/intake-resolution.mjs';
import { discoverInventory } from '../../paper-adapters/inventory/index.mjs';
import { buildMigrationMatrixAudit } from '../../migration/retirement/migration-matrix.mjs';
import {
  buildFreshRefereeVerdict,
  JOURNAL_PROFILES as journalProfilesFacade,
} from '../../paper-adapters/journal-manage/index.mjs';
import { JOURNAL_PROFILES as journalProfilesDirect } from '../../paper-domain/journal/journal-registry.mjs';
import { makeExperimentCode } from '../../paper-adapters/empirical-analysis/experiment-runner.mjs';
import { validateAndMaybeApplyPatches } from '../../paper-adapters/referee-revise/repair-executor.mjs';
import { createDefaultPaperStore } from '../../paper-adapters/persistence/store-provider.mjs';
import {
  defaultPaperAssetRoot,
  defaultPaperRuntimeRoot,
} from '../src/workspace-layout.mjs';
import { assertIsolatedVerificationRuntime } from '../src/verification-runtime.mjs';
import { resolveImmutableLegacyMatrixArchive } from '../../migration/legacy-matrix-reference.mjs';

assertIsolatedVerificationRuntime('paper remediation selftest');

const workspaceRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const root = defaultPaperAssetRoot();
const nativeDb = heptaStorePath(root, defaultPaperRuntimeRoot());
const legacyArchive = resolveImmutableLegacyMatrixArchive();
const nativeStore = createDefaultPaperStore({ root, runtimeRoot: defaultPaperRuntimeRoot() });

function hashFile(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function moduleFiles(directory) {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) return moduleFiles(absolute);
    return entry.isFile() && entry.name.endsWith('.mjs') ? [absolute] : [];
  });
}

function sqlite(sql, { json = false } = {}) {
  const result = spawnSync('sqlite3', json ? ['-json', nativeDb] : [nativeDb], {
    input: sql,
    encoding: 'utf8',
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return result.stdout || '';
}

function concurrentSql(sql) {
  return new Promise((resolve, reject) => {
    const child = spawn('sqlite3', [nativeDb], { stdio: ['pipe', 'pipe', 'pipe'] });
    let stderr = '';
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(stderr || `sqlite3 exited ${code}`));
    });
    child.stdin.end(sql);
  });
}

const legacyHashBefore = hashFile(legacyArchive);
const productionModuleBudgetBytes = 64 * 1024;
const productionModules = [
  'paper-core/src',
  'paper-adapters',
  'paper-domain',
  'paper-ports',
  'paper-application',
  'workflow-kernel',
].flatMap((relative) => moduleFiles(path.join(workspaceRoot, relative)))
  .filter((file) => !/selftest/i.test(path.basename(file)));
const oversizedProductionModules = productionModules
  .map((file) => ({
    file: path.relative(workspaceRoot, file),
    sizeBytes: fs.statSync(file).size,
  }))
  .filter((entry) => entry.sizeBytes > productionModuleBudgetBytes);
assert.deepEqual(oversizedProductionModules, []);

assert.equal(contractsFacade.buildRefereeReviewIntake, buildRefereeReviewIntakeDirect);
assert.equal(contractsFacade.buildRefereeApplyApprovalPacket, buildRefereeApplyApprovalPacketDirect);
assert.equal(contractsFacade.buildRepairReconciliation, buildRepairReconciliationDirect);
assert.equal(contractsFacade.buildSubmissionApprovalPacket, buildSubmissionApprovalPacketDirect);
assert.equal(contractsFacade.buildVenueResolutionPacket, buildVenueResolutionPacketDirect);
assert.equal(journalProfilesFacade, journalProfilesDirect);
assert.equal(journalProfilesDirect.length, 98);

const summaryBoundary = summarizeRows([{
  draft_status: 'source_tex_present',
  compile_status: 'build_passed',
  research_verify_status: 'verified',
  package_status: 'package_ready',
  readiness_status: 'ready_for_local_dry_run',
  runner_status: 'dry_run_receipt_recorded',
  next_action: contractsFacade.PAPER_ACTIONS.REVIEWED_SUBMIT,
  production_disposition: 'active_submission',
  submission_intent: 'ready_for_submission',
}], 'selftest');
assert.equal(summaryBoundary.total, 1);
assert.equal(summaryBoundary.dryRunReceipts, 1);
assert.equal(summaryBoundary.reviewedSubmitBlocked, 1);

const generatedExperimentCode = makeExperimentCode({
  paperId: 'selftest',
  title: 'Selftest',
  experimentFamily: 'generic_benchmark',
  benchmarkSuiteId: 'selftest-suite',
  benchmarkSuiteLabel: 'Selftest suite',
  datasetMode: 'generated_local_dataset',
  primaryDatasetAbsolutePath: null,
  seeds: [1],
  repetitions: 1,
  figureSpec: null,
});
assert.match(generatedExperimentCode, /externalActionPerformed: false/);
assert.doesNotMatch(generatedExperimentCode, /https?:\/\//);

const repairBoundary = await validateAndMaybeApplyPatches({
  root,
  row: { task: { paperId: 'selftest', sourceWorkspace: 'hepta-paper-workspace' } },
  patchApplyExecution: {
    plannedPatchInputs: [{
      patchId: 'outside-root',
      patchPath: '../outside.patch',
      targetPaths: ['../outside.tex'],
    }],
  },
  preimageSnapshotLedger: { entries: [] },
  execute: false,
});
assert.ok(repairBoundary.blockers.includes('target_path_outside_repo_root'));
assert.ok(repairBoundary.blockers.includes('patch_path_outside_repo_root'));

const integrity = buildCoreIntegrityReport({ workspaceRoot });
assert.equal(integrity.ok, true, JSON.stringify(integrity.drift));
assert.equal(integrity.coreSnapshotModified, false);
const driftProbe = compareCoreFileRows(
  [{ path: 'src/example.mjs', size: 1, sha256: 'a' }],
  [{ path: 'src/example.mjs', size: 1, sha256: 'b' }],
);
assert.equal(driftProbe.ok, false);
assert.equal(driftProbe.changed.length, 1);

const inventory = await discoverInventory({ root, store: nativeStore, limit: 1 });
assert.equal(inventory.inventorySource, 'hepta_sqlite');
assert.ok(inventory.rows.length > 0);

const matrixAudit = buildMigrationMatrixAudit({
  root,
  matrixOverride: { version: 2, entries: [] },
  entries: [{
    path: 'bin/paperctl',
    hash: 'sha256:test',
    priority: 'P0',
    migrationAction: 'replace_entrypoint_with_paper_production_core',
    targetAdapter: 'paper-core/bin/paper-production-core.mjs',
    retirementWaveFamily: 'wave_0_freeze_legacy_entrypoints',
  }],
});
assert.equal(matrixAudit.ok, false);
assert.equal(matrixAudit.missingEntryCount, 1);
assert.ok(matrixAudit.blockers.includes('p0_p1_migration_matrix_coverage_incomplete'));

const verdict = buildFreshRefereeVerdict({
  paperTask: { paperId: 'selftest', taskKey: 'selftest:paper' },
  targetProfile: { status: 'journal_target_profile_ready', profile: { id: 'test' } },
  rubricPacket: { status: 'journal_rubric_packet_ready' },
  refereePool: {
    status: 'fresh_referee_pool_ready',
    safety: { academicAcceptanceAuthority: false },
  },
  evidenceGate: { status: 'venue_evidence_gate_ready', blockers: [] },
  lifecyclePolicy: { status: 'venue_lifecycle_policy_ready', blockers: [] },
  reviewReport: { status: 'agent_referee_review_clear', findingCount: 0 },
  packageResult: { artifactPackage: { submitReady: true } },
  lifecycle: {
    reviewedSubmitPreflightPacket: { status: 'reviewed_submit_preflight_ready_for_external_executor' },
    controlledExecutorReceipt: { status: 'controlled_external_executor_receipt_recorded' },
  },
});
assert.equal(verdict.verdict, 'revise');
assert.ok(verdict.blockers.includes('independent_referee_acceptance_authority_required'));

const quickCheck = sqlite('PRAGMA quick_check;').trim();
assert.equal(quickCheck, 'ok');
assert.equal(sqlite('PRAGMA foreign_key_check;').trim(), '');

const probePrefix = `remediation_selftest_${process.pid}_${Date.now()}`;
sqlite(`
BEGIN IMMEDIATE;
INSERT INTO audit_receipts(receipt_id,kind,status,receipt_json,receipt_sha256)
VALUES('${probePrefix}_rollback','RollbackProbe','test','{}','sha256:test');
ROLLBACK;
`);
const rollbackRows = JSON.parse(sqlite(
  `SELECT receipt_id FROM audit_receipts WHERE receipt_id='${probePrefix}_rollback';`,
  { json: true },
) || '[]');
assert.equal(rollbackRows.length, 0);

await Promise.all([1, 2].map((index) => concurrentSql(`
PRAGMA busy_timeout=5000;
BEGIN IMMEDIATE;
INSERT INTO audit_receipts(receipt_id,kind,status,receipt_json,receipt_sha256)
VALUES('${probePrefix}_${index}','ConcurrencyProbe','test','{}','sha256:test');
COMMIT;
`)));
const concurrentRows = JSON.parse(sqlite(
  `SELECT receipt_id FROM audit_receipts WHERE receipt_id LIKE '${probePrefix}_%';`,
  { json: true },
) || '[]');
assert.equal(concurrentRows.length, 2);
sqlite(`DELETE FROM audit_receipts WHERE receipt_id LIKE '${probePrefix}_%';`);

const legacyHashAfter = hashFile(legacyArchive);
assert.equal(legacyHashAfter, legacyHashBefore, 'remediation tests must not mutate the immutable legacy archive');

process.stdout.write(`${JSON.stringify({
  ok: true,
  status: 'pass_remediation_selftest',
  inventorySource: inventory.inventorySource,
  coreIntegrityStatus: integrity.status,
  migrationMatrixFailClosed: true,
  deterministicRefereeCannotAccept: true,
  decomposedContractFacadeVerified: true,
  batchSummaryBoundaryVerified: true,
  journalRegistryBoundaryVerified: journalProfilesDirect.length,
  empiricalRunnerNetworkFree: true,
  refereeRepairPathBoundaryVerified: true,
  productionModuleBudgetBytes,
  productionModuleCount: productionModules.length,
  rollbackVerified: true,
  concurrentWritersVerified: 2,
  legacyStoreUnchanged: true,
  immutableLegacyArchiveUnchanged: true,
})}\n`);
