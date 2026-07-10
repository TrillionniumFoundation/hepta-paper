import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { buildCoreIntegrityReport, compareCoreFileRows } from './core-integrity.mjs';
import { heptaStorePath, legacyStorePath } from './hepta-store.mjs';
import { discoverInventory } from '../../paper-adapters/inventory/index.mjs';
import { buildMigrationMatrixAudit } from '../../paper-adapters/legacy-cleanup/migration-matrix.mjs';
import { buildFreshRefereeVerdict } from '../../paper-adapters/journal-manage/index.mjs';

const workspaceRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const root = path.resolve(workspaceRoot, '..');
const nativeDb = heptaStorePath(root);
const legacyDb = legacyStorePath(root);

function hashFile(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
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

const legacyHashBefore = hashFile(legacyDb);

const integrity = buildCoreIntegrityReport({ workspaceRoot });
assert.equal(integrity.ok, true, JSON.stringify(integrity.drift));
assert.equal(integrity.coreSnapshotModified, false);
const driftProbe = compareCoreFileRows(
  [{ path: 'src/example.mjs', size: 1, sha256: 'a' }],
  [{ path: 'src/example.mjs', size: 1, sha256: 'b' }],
);
assert.equal(driftProbe.ok, false);
assert.equal(driftProbe.changed.length, 1);

const inventory = await discoverInventory({ root, limit: 1 });
assert.equal(inventory.inventorySource, 'hepta_sqlite');
assert.ok(inventory.rows.length > 0);

const matrixAudit = buildMigrationMatrixAudit({
  root,
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
assert.ok(verdict.blockers.includes('independent_referee_review_not_performed'));

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

const legacyHashAfter = hashFile(legacyDb);
assert.equal(legacyHashAfter, legacyHashBefore, 'remediation tests must not mutate legacy paper_factory.sqlite');

process.stdout.write(`${JSON.stringify({
  ok: true,
  status: 'pass_remediation_selftest',
  inventorySource: inventory.inventorySource,
  coreIntegrityStatus: integrity.status,
  migrationMatrixFailClosed: true,
  deterministicRefereeCannotAccept: true,
  rollbackVerified: true,
  concurrentWritersVerified: 2,
  legacyStoreUnchanged: true,
})}\n`);
