import { sha256Text } from '../../workflow-kernel/runtime/file-utils.mjs';

export function buildRepairApplyProof({ row, preimageSnapshotLedger, patchApplyResult } = {}) {
  const blockers = [];
  if (!patchApplyResult?.applied) blockers.push('repair_apply_not_performed');
  if (!(patchApplyResult?.targetPreimageChecks || []).every((entry) => entry.status === 'preimage_check_passed')) blockers.push('repair_preimage_checks_not_verified');
  if (!(patchApplyResult?.postimageRecords || []).length) blockers.push('repair_postimages_missing');
  if (!patchApplyResult?.sourceDiffHash) blockers.push('repair_source_diff_hash_missing');
  const payload = {
    version: 1,
    kind: 'RepairApplyProof',
    paperId: row?.task?.paperId || null,
    status: blockers.length ? 'repair_apply_proof_blocked' : 'repair_apply_proof_ready',
    preimageLedgerHash: preimageSnapshotLedger?.preimageSnapshotLedgerHash || null,
    acceptedPreimages: patchApplyResult?.targetPreimageChecks || [],
    appliedPatchHashes: patchApplyResult?.appliedPatchHashes || [],
    postimageRecords: patchApplyResult?.postimageRecords || [],
    sourceDiffHash: patchApplyResult?.sourceDiffHash || null,
    blockers,
    reconciliation: {
      preimageCount: (patchApplyResult?.targetPreimageChecks || []).length,
      postimageCount: (patchApplyResult?.postimageRecords || []).length,
      everyPreimageAccountedFor: (patchApplyResult?.targetPreimageChecks || []).length === (patchApplyResult?.postimageRecords || []).length,
    },
  };
  if (!payload.reconciliation.everyPreimageAccountedFor) payload.blockers.push('repair_preimage_postimage_count_mismatch');
  if (payload.blockers.length) payload.status = 'repair_apply_proof_blocked';
  return { ...payload, repairApplyProofHash: sha256Text(JSON.stringify(payload)) };
}
