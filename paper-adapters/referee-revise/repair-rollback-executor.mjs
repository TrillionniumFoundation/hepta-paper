import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileRecord, pathWithin, sha256Text } from '../../workflow-kernel/runtime/file-utils.mjs';
import { uniqueStrings } from '../../workflow-kernel/runtime/text-utils.mjs';
import { shaDigest } from './repair-shared.mjs';

export async function rollbackAppliedPatches({ root, row, patchApplyResult } = {}) {
  const blockers = [];
  const patches = (patchApplyResult?.validationRecords || []).filter((record) => !record.blockers?.length && record.patchPath);
  if (!patchApplyResult?.applied) blockers.push('applied_patch_result_required');
  if (!patches.length) blockers.push('applied_patch_records_missing');
  const patchPaths = patches.map((record) => path.isAbsolute(record.patchPath) ? record.patchPath : path.join(root, record.patchPath));
  if (!blockers.length) {
    const check = spawnSync('git', ['apply', '--reverse', '--check', '--whitespace=nowarn', ...patchPaths], { cwd: root, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
    if (check.status !== 0) blockers.push('repair_rollback_check_failed');
    if (!blockers.length) {
      const rollback = spawnSync('git', ['apply', '--reverse', '--whitespace=nowarn', ...patchPaths], { cwd: root, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
      if (rollback.status !== 0) blockers.push('repair_rollback_apply_failed');
    }
  }
  const restoredPreimages = [];
  for (const preimage of patchApplyResult?.targetPreimageChecks || []) {
    const candidate = path.isAbsolute(preimage.targetPath) ? preimage.targetPath : path.join(root, preimage.targetPath);
    const record = pathWithin(root, candidate) ? await fileRecord(root, candidate, 'repair_rollback_preimage') : null;
    const restored = Boolean(record?.hash && preimage.expectedPreimageHash && shaDigest(record.hash) === shaDigest(preimage.expectedPreimageHash));
    if (!restored) blockers.push(`repair_rollback_preimage_mismatch:${preimage.targetPath}`);
    restoredPreimages.push({ targetPath: preimage.targetPath, expectedHash: preimage.expectedPreimageHash || null, actualHash: record?.hash || null, restored });
  }
  const payload = {
    version: 1,
    kind: 'RepairRollbackReceipt',
    paperId: row?.task?.paperId || null,
    status: blockers.length ? 'repair_rollback_blocked' : 'repair_rollback_verified',
    appliedPatchHashes: patchApplyResult?.appliedPatchHashes || [],
    restoredPreimages,
    blockers: uniqueStrings(blockers, 64),
    safety: { sourceRestored: blockers.length === 0, externalActionPerformed: false },
  };
  return { ...payload, repairRollbackReceiptHash: sha256Text(JSON.stringify(payload)) };
}
