import path from 'node:path';
import { spawnSync } from 'node:child_process';
import {
  fileRecord,
  pathWithin,
  readTextIfExists,
  sha256Text,
} from '../../workflow-kernel/runtime/file-utils.mjs';
import { inspectScopedPathSync, readScopedFileSync } from '../../workflow-kernel/runtime/scoped-file-identity.mjs';
import { normalizeText, uniqueStrings } from '../../workflow-kernel/runtime/text-utils.mjs';
import { AGENT_REPAIR_BEGIN, shaDigest, stderrLines } from './repair-shared.mjs';

async function readPostimageRecords({ root, paperId, targetPaths }) {
  return (await Promise.all(targetPaths.map(async (targetPath) => {
    const targetAbs = path.isAbsolute(targetPath) ? targetPath : path.join(root, targetPath);
    const record = await fileRecord(root, targetAbs, 'referee_apply_postimage');
    return record ? {
      id: `${paperId}:postimage:${targetPath}`,
      targetPath,
      postimageHash: record.hash,
      sizeBytes: record.sizeBytes,
    } : null;
  }))).filter(Boolean);
}

function readSourceDiffHash({ root, targetPaths }) {
  const diff = spawnSync('git', ['diff', '--', ...targetPaths], {
    cwd: root,
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024,
  });
  return sha256Text(diff.stdout || '');
}

export async function validateAndMaybeApplyPatches({
  root,
  row,
  patchApplyExecution,
  preimageSnapshotLedger,
  execute = false,
} = {}) {
  const plannedPatches = patchApplyExecution?.plannedPatchInputs || [];
  const sourceRoot = row?.task?.sourceWorkspace
    ? path.join(root, row.task.sourceWorkspace)
    : root;
  const validationRecords = [];
  const targetPreimageChecks = [];
  const blockers = [];
  const warnings = [];
  const patchAbsPaths = [];
  const alreadyAppliedPatchAbsPaths = [];
  const targetPaths = uniqueStrings(plannedPatches.flatMap((patch) => patch.targetPaths || []), 256);
  const preimageByPath = new Map((preimageSnapshotLedger?.entries || [])
    .map((entry) => [normalizeText(entry.targetPath), entry])
    .filter(([key]) => key));

  for (const targetPath of targetPaths) {
    const targetAbs = path.isAbsolute(targetPath) ? targetPath : path.join(root, targetPath);
    const expected = preimageByPath.get(normalizeText(targetPath));
    const checkBlockers = [];
    if (!pathWithin(root, targetAbs)) checkBlockers.push('target_path_outside_repo_root');
    if (!pathWithin(sourceRoot, targetAbs)) checkBlockers.push('target_path_outside_source_workspace');
    const targetIdentity = expected?.exists
      ? inspectScopedPathSync({ scopeRoot: sourceRoot, candidate: targetAbs, expect: 'file' })
      : inspectScopedPathSync({ scopeRoot: sourceRoot, candidate: path.dirname(targetAbs), expect: 'directory', forbidHardlinks: false });
    if (targetIdentity.status !== 'scoped_file_identity_verified') checkBlockers.push(...targetIdentity.blockers.map((item) => `target_identity:${item}`));
    const actual = pathWithin(root, targetAbs) ? await fileRecord(root, targetAbs, 'referee_apply_preimage_check') : null;
    if (expected?.preimageHash && actual?.hash && shaDigest(expected.preimageHash) !== shaDigest(actual.hash)) {
      checkBlockers.push('target_preimage_hash_mismatch');
    }
    if (expected?.exists && !actual) checkBlockers.push('target_preimage_file_missing');
    if (!expected?.exists && actual) checkBlockers.push('target_preimage_unexpected_file_exists');
    targetPreimageChecks.push({
      id: `${row.task.paperId}:target-preimage-check:${targetPreimageChecks.length + 1}`,
      targetPath,
      expectedPreimageHash: expected?.preimageHash || null,
      actualPreimageHash: actual?.hash || null,
      status: checkBlockers.length ? 'preimage_check_failed' : 'preimage_check_passed',
      blockers: checkBlockers,
    });
    blockers.push(...checkBlockers);
  }

  for (const patch of plannedPatches) {
    const patchPath = normalizeText(patch.patchPath || '');
    const patchAbs = patchPath ? path.join(root, patchPath) : '';
    const recordBlockers = [];
    let actualHash = null;
    let cleanApplyCheck = null;
    let stderr = [];
    if (!patchPath) recordBlockers.push('patch_path_missing');
    if (patchPath && !pathWithin(root, patchAbs)) recordBlockers.push('patch_path_outside_repo_root');
    if (patchPath && pathWithin(root, patchAbs)) {
      const patchRead = readScopedFileSync({ scopeRoot: root, candidate: patchAbs, maximumBytes: 16 * 1024 * 1024 });
      if (patchRead.status === 'scoped_file_read_verified') actualHash = patchRead.hash;
      else recordBlockers.push('patch_file_missing_or_unsafe', ...patchRead.blockers);
    }
    if (patch.patchSha256 && actualHash && shaDigest(patch.patchSha256) !== shaDigest(actualHash)) {
      recordBlockers.push('patch_hash_mismatch');
    }
    for (const targetPath of patch.targetPaths || []) {
      const targetAbs = path.isAbsolute(targetPath) ? targetPath : path.join(root, targetPath);
      if (!pathWithin(root, targetAbs)) recordBlockers.push('patch_target_outside_repo_root');
      if (!pathWithin(sourceRoot, targetAbs)) recordBlockers.push('patch_target_outside_source_workspace');
      const parentIdentity = inspectScopedPathSync({ scopeRoot: sourceRoot, candidate: path.dirname(targetAbs), expect: 'directory', forbidHardlinks: false });
      if (parentIdentity.status !== 'scoped_file_identity_verified') recordBlockers.push(...parentIdentity.blockers.map((item) => `patch_target_identity:${item}`));
    }
    if (!recordBlockers.length) {
      const check = spawnSync('git', ['apply', '--check', '--whitespace=nowarn', patchAbs], {
        cwd: root,
        encoding: 'utf8',
        maxBuffer: 8 * 1024 * 1024,
      });
      cleanApplyCheck = check.status === 0 ? 'clean_apply_check_passed' : 'clean_apply_check_failed';
      stderr = stderrLines(check.stderr);
      if (check.status !== 0) {
        const reverseCheck = spawnSync('git', ['apply', '--reverse', '--check', '--whitespace=nowarn', patchAbs], {
          cwd: root,
          encoding: 'utf8',
          maxBuffer: 8 * 1024 * 1024,
        });
        const markerPresent = await Promise.all((patch.targetPaths || []).map(async (targetPath) => {
          const targetAbs = path.isAbsolute(targetPath) ? targetPath : path.join(root, targetPath);
          const text = pathWithin(root, targetAbs) ? await readTextIfExists(targetAbs) : null;
          return Boolean(text && text.includes(AGENT_REPAIR_BEGIN));
        }));
        if (reverseCheck.status === 0 && markerPresent.length && markerPresent.every(Boolean)) {
          cleanApplyCheck = 'already_applied_reverse_check_passed';
          stderr = [];
        } else {
          recordBlockers.push('patch_file_does_not_apply_cleanly');
        }
      }
    }
    if (!recordBlockers.length && cleanApplyCheck === 'already_applied_reverse_check_passed') {
      alreadyAppliedPatchAbsPaths.push(patchAbs);
    } else if (!recordBlockers.length) {
      patchAbsPaths.push(patchAbs);
    }
    validationRecords.push({
      id: `${row.task.paperId}:patch-validation:${patch.patchId}`,
      patchId: patch.patchId,
      patchPath,
      patchHashExpected: patch.patchSha256 || null,
      patchHashActual: actualHash,
      targetPaths: patch.targetPaths || [],
      cleanApplyCheck,
      blockers: recordBlockers,
      stderr,
    });
    blockers.push(...recordBlockers);
  }

  let applied = false;
  let postimageRecords = [];
  let sourceDiffHash = null;
  const appliedPatchHashes = validationRecords
    .filter((record) => !record.blockers.length && record.patchHashActual)
    .map((record) => record.patchHashActual);
  if (execute && !blockers.length && patchAbsPaths.length) {
    const combinedCheck = spawnSync('git', ['apply', '--check', '--whitespace=nowarn', ...patchAbsPaths], {
      cwd: root,
      encoding: 'utf8',
      maxBuffer: 16 * 1024 * 1024,
    });
    if (combinedCheck.status !== 0) {
      blockers.push('combined_patch_queue_does_not_apply_cleanly');
      warnings.push(...stderrLines(combinedCheck.stderr, 4));
    } else {
      const apply = spawnSync('git', ['apply', '--whitespace=nowarn', ...patchAbsPaths], {
        cwd: root,
        encoding: 'utf8',
        maxBuffer: 16 * 1024 * 1024,
      });
      if (apply.status !== 0) {
        blockers.push('git_apply_failed_after_clean_check');
        warnings.push(...stderrLines(apply.stderr, 4));
      } else {
        applied = true;
        postimageRecords = await readPostimageRecords({ root, paperId: row.task.paperId, targetPaths });
        sourceDiffHash = readSourceDiffHash({ root, targetPaths });
      }
    }
  } else if (execute && !blockers.length && alreadyAppliedPatchAbsPaths.length) {
    applied = true;
    warnings.push('agent_repair_patch_already_applied_reusing_current_postimage');
    postimageRecords = await readPostimageRecords({ root, paperId: row.task.paperId, targetPaths });
    sourceDiffHash = readSourceDiffHash({ root, targetPaths });
  }

  return {
    validationRecords,
    targetPreimageChecks,
    appliedPatchHashes,
    postimageRecords,
    sourceDiffHash,
    applied,
    blockers: uniqueStrings(blockers, 128),
    warnings: uniqueStrings(warnings, 32),
  };
}
