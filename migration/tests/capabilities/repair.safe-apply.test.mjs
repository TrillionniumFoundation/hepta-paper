import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import test from 'node:test';
import {
  buildRepairApplyProof,
  rollbackAppliedPatches,
  validateAndMaybeApplyPatches,
} from '../../../paper-adapters/referee-revise/repair-executor.mjs';
import { sha256File } from '../../../paper-core/src/runtime/file-utils.mjs';
import { temporaryDirectory } from './test-support.mjs';

test('repair.safe-apply proves preimage, apply-check, postimage, reconciliation and rollback', async (t) => {
  const root = await temporaryDirectory(t);
  await fsp.mkdir(path.join(root, 'paper'));
  const target = path.join(root, 'paper', 'main.tex');
  const patchPath = path.join(root, 'change.patch');
  await fsp.writeFile(target, 'old\n');
  await fsp.writeFile(patchPath, [
    'diff --git a/paper/main.tex b/paper/main.tex',
    '--- a/paper/main.tex',
    '+++ b/paper/main.tex',
    '@@ -1 +1 @@',
    '-old',
    '+new',
    '',
  ].join('\n'));
  execFileSync('git', ['init', '-q'], { cwd: root });
  execFileSync('git', ['config', 'user.email', 'test@example.invalid'], { cwd: root });
  execFileSync('git', ['config', 'user.name', 'Hepta Test'], { cwd: root });
  execFileSync('git', ['add', 'paper/main.tex'], { cwd: root });
  execFileSync('git', ['commit', '-qm', 'baseline'], { cwd: root });
  const preimageHash = await sha256File(target);
  const patchHash = await sha256File(patchPath);
  const row = { task: { paperId: 'p', sourceWorkspace: 'paper' } };
  const preimageSnapshotLedger = { preimageSnapshotLedgerHash: 'sha256:ledger', entries: [{ targetPath: 'paper/main.tex', exists: true, preimageHash }] };
  const execution = { plannedPatchInputs: [{ patchId: 'change', patchPath: 'change.patch', patchSha256: patchHash, targetPaths: ['paper/main.tex'] }] };
  const dryRun = await validateAndMaybeApplyPatches({ root, row, patchApplyExecution: execution, preimageSnapshotLedger, execute: false });
  assert.equal(dryRun.blockers.length, 0);
  assert.equal(dryRun.validationRecords[0].cleanApplyCheck, 'clean_apply_check_passed');
  const applied = await validateAndMaybeApplyPatches({ root, row, patchApplyExecution: execution, preimageSnapshotLedger, execute: true });
  assert.equal(applied.applied, true);
  assert.equal(await fsp.readFile(target, 'utf8'), 'new\n');
  const proof = buildRepairApplyProof({ row, preimageSnapshotLedger, patchApplyResult: applied });
  assert.equal(proof.status, 'repair_apply_proof_ready');
  assert.equal(proof.reconciliation.everyPreimageAccountedFor, true);
  const rollback = await rollbackAppliedPatches({ root, row, patchApplyResult: applied });
  assert.equal(rollback.status, 'repair_rollback_verified');
  assert.equal(await sha256File(target), preimageHash);
});

test('repair.safe-apply fails closed for escape and preimage mismatch', async (t) => {
  const root = await temporaryDirectory(t);
  const escaped = await validateAndMaybeApplyPatches({ root, row: { task: { paperId: 'p', sourceWorkspace: '.' } }, patchApplyExecution: { plannedPatchInputs: [{ patchPath: '../escape.patch', targetPaths: ['../escape.tex'] }] }, preimageSnapshotLedger: { entries: [] }, execute: false });
  assert.ok(escaped.blockers.includes('patch_path_outside_repo_root'));
  const target = path.join(root, 'main.tex');
  await fsp.writeFile(target, 'current\n');
  const mismatch = await validateAndMaybeApplyPatches({ root, row: { task: { paperId: 'p', sourceWorkspace: '.' } }, patchApplyExecution: { plannedPatchInputs: [{ patchPath: 'missing.patch', targetPaths: ['main.tex'] }] }, preimageSnapshotLedger: { entries: [{ targetPath: 'main.tex', exists: true, preimageHash: 'sha256:not-current' }] }, execute: false });
  assert.ok(mismatch.blockers.includes('target_preimage_hash_mismatch'));
});
