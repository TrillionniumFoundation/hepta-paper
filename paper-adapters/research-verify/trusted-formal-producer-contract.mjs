import { hashRecord } from '../../workflow-kernel/record-hash.mjs';

const SHA256 = /^sha256:[0-9a-f]{64}$/;
const ISSUED_AUTHORITIES = new WeakSet();

export const MAXIMUM_TRUSTED_FORMAL_REQUEST_HINTS = 1;
export const TRUSTED_FORMAL_EXECUTION_TIMEOUT_MS = 120_000;
export const TRUSTED_FORMAL_TOTAL_BUDGET_MS = 120_000;

export function uniqueTrustedFormalBlockers(values) {
  return Object.freeze([...new Set(values.filter(Boolean).map(String))]);
}

function authorityPayload(input = {}) {
  return {
    version: 1,
    kind: 'TrustedFormalCampaignExecutionAuthority',
    status: 'trusted_formal_campaign_execution_authorized',
    paperId: input.paperId || null,
    campaignId: input.campaignId || null,
    researchNodeId: input.researchNodeId || null,
    researchAttemptId: input.researchAttemptId || null,
    researchLeaseGeneration: Number(input.researchLeaseGeneration),
    researchSourceSnapshotHash: input.researchSourceSnapshotHash || null,
    formalNodeId: input.formalNodeId || null,
    formalAttemptId: input.formalAttemptId || null,
    formalLeaseGeneration: Number(input.formalLeaseGeneration),
    formalNodeResultHash: input.formalNodeResultHash || null,
    formalVerificationReceiptHash:
      input.formalVerificationReceiptHash || null,
    nativeResearchWorkerExecutionReportHash:
      input.nativeResearchWorkerExecutionReportHash || null,
  };
}

export function issueTrustedFormalCampaignExecutionAuthority(input = {}) {
  const payload = authorityPayload(input);
  if (!payload.paperId || !payload.campaignId || !payload.researchNodeId
    || !payload.researchAttemptId
    || !Number.isSafeInteger(payload.researchLeaseGeneration)
    || payload.researchLeaseGeneration < 1
    || !SHA256.test(payload.researchSourceSnapshotHash)
    || !payload.formalNodeId || !payload.formalAttemptId
    || !Number.isSafeInteger(payload.formalLeaseGeneration)
    || payload.formalLeaseGeneration < 1
    || !SHA256.test(payload.formalNodeResultHash)
    || !SHA256.test(payload.formalVerificationReceiptHash)
    || !SHA256.test(payload.nativeResearchWorkerExecutionReportHash)) {
    throw new Error('trusted_formal_campaign_execution_authority_input_invalid');
  }
  const authority = Object.freeze({
    ...payload,
    trustedFormalCampaignExecutionAuthorityHash:
      hashRecord('TrustedFormalCampaignExecutionAuthority', payload),
  });
  ISSUED_AUTHORITIES.add(authority);
  return authority;
}

export function trustedFormalAuthorityBlockers({
  authority,
  paperTask,
  campaignEvidenceContext,
  campaignResearchSourceSnapshot,
  authoritativeFormalReceipt,
  authoritativeFormalNode,
  nativeResearchWorkerExecution,
} = {}) {
  const blockers = [];
  const {
    trustedFormalCampaignExecutionAuthorityHash: claimedHash,
    ...payload
  } = authority || {};
  if (!ISSUED_AUTHORITIES.has(authority)
    || authority?.version !== 1
    || authority?.kind !== 'TrustedFormalCampaignExecutionAuthority'
    || authority?.status !== 'trusted_formal_campaign_execution_authorized'
    || !SHA256.test(String(claimedHash || ''))
    || hashRecord('TrustedFormalCampaignExecutionAuthority', payload) !== claimedHash) {
    blockers.push('trusted_formal_campaign_execution_authority_invalid');
  }
  for (const [actual, expected, blocker] of [
    [authority?.paperId, paperTask?.paperId,
      'trusted_formal_authority_paper_mismatch'],
    [authority?.campaignId, campaignEvidenceContext?.campaignId,
      'trusted_formal_authority_campaign_mismatch'],
    [authority?.researchNodeId, campaignEvidenceContext?.researchNodeId,
      'trusted_formal_authority_research_node_mismatch'],
    [authority?.researchAttemptId, campaignEvidenceContext?.researchAttemptId,
      'trusted_formal_authority_research_attempt_mismatch'],
    [authority?.researchLeaseGeneration,
      campaignEvidenceContext?.researchLeaseGeneration,
      'trusted_formal_authority_research_lease_mismatch'],
    [authority?.researchSourceSnapshotHash,
      campaignResearchSourceSnapshot?.campaignResearchSourceSnapshotHash,
      'trusted_formal_authority_source_snapshot_mismatch'],
    [authority?.formalNodeId, authoritativeFormalReceipt?.formalNodeId,
      'trusted_formal_authority_formal_node_mismatch'],
    [authority?.formalAttemptId, authoritativeFormalReceipt?.formalAttemptId,
      'trusted_formal_authority_formal_attempt_mismatch'],
    [authority?.formalLeaseGeneration,
      authoritativeFormalReceipt?.formalLeaseGeneration,
      'trusted_formal_authority_formal_lease_mismatch'],
    [authority?.formalNodeResultHash,
      authoritativeFormalNode?.resultSha256,
      'trusted_formal_authority_formal_node_result_mismatch'],
    [authority?.formalVerificationReceiptHash,
      authoritativeFormalReceipt?.campaignFormalVerificationReceiptHash,
      'trusted_formal_authority_formal_receipt_mismatch'],
    [authority?.nativeResearchWorkerExecutionReportHash,
      nativeResearchWorkerExecution?.nativeResearchWorkerExecutionReportHash,
      'trusted_formal_authority_native_execution_mismatch'],
  ]) if (actual !== expected) blockers.push(blocker);
  return uniqueTrustedFormalBlockers(blockers);
}

export function blockedTrustedFormalEvidence({
  phase,
  blockers,
  authorityHash = null,
  canonicalRequestHash = null,
  externalActionId = null,
  requestHintCount = 0,
  executionPerformed = false,
  writesPerformed = false,
  partialMutation = false,
  sandboxReceipt = null,
} = {}) {
  const normalizedBlockers = uniqueTrustedFormalBlockers(
    blockers || ['trusted_formal_evidence_blocked'],
  );
  const attempt = Object.freeze({
    version: 1,
    kind: 'TrustedFormalEvidenceAttempt',
    status: 'trusted_formal_evidence_attempt_blocked',
    phase: phase || 'preflight',
    authorityHash,
    canonicalRequestHash,
    externalActionId,
    requestHintCount,
    maximumRequestHintCount: MAXIMUM_TRUSTED_FORMAL_REQUEST_HINTS,
    timeoutMs: TRUSTED_FORMAL_EXECUTION_TIMEOUT_MS,
    totalBudgetMs: TRUSTED_FORMAL_TOTAL_BUDGET_MS,
    executionPerformed: executionPerformed === true,
    writesPerformed: writesPerformed === true,
    partialMutation: partialMutation === true,
    blockers: normalizedBlockers,
  });
  return Object.freeze({
    status: 'trusted_formal_evidence_blocked',
    attempt,
    ...(sandboxReceipt ? { sandboxReceipt } : {}),
    blockers: normalizedBlockers,
  });
}
