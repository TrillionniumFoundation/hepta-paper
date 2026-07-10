import assert from 'node:assert/strict';
import test from 'node:test';
import { validateAndMaybeApplyPatches } from '../../../paper-adapters/referee-revise/repair-executor.mjs';
import { temporaryDirectory } from './test-support.mjs';

test('repair.safe-apply rejects target and patch paths outside declared workspace', async (t) => {
  const root = await temporaryDirectory(t);
  const result = await validateAndMaybeApplyPatches({ root, row: { task: { paperId: 'p', sourceWorkspace: '.' } }, patchApplyExecution: { plannedPatchInputs: [{ patchPath: '../escape.patch', targetPaths: ['../escape.tex'] }] }, preimageSnapshotLedger: { entries: [] }, execute: false });
  assert.ok(result.blockers.includes('patch_path_outside_repo_root'));
  assert.notEqual(result.status, 'referee_applied_patch_receipt_recorded');
});
