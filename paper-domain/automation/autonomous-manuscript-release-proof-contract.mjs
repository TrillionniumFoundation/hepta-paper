import { hashRecord } from '../../workflow-kernel/record-hash.mjs';
import {
  verifyIsolatedAgentMergeReceipt,
} from '../evidence/isolated-agent-merge-receipt-contract.mjs';
import {
  verifyTrustedAutonomousManuscriptRenderReceipt,
} from './trusted-autonomous-manuscript-render-contract.mjs';

const SHA256 = /^sha256:[0-9a-f]{64}$/i;

export function inspectAutonomousManuscriptReleaseProof(
  proof,
  expected = {},
  { requireAgentAuthored = false } = {},
) {
  const result = proof?.result || null;
  const receipt = result?.trustedAutonomousManuscriptRenderReceipt || null;
  const { campaignTrustedAutonomousManuscriptResultHash: claimedResultHash, ...resultPayload } = result || {};
  const agentReceipt = result?.agentExecutionReceipt || null;
  const mergeReceipt = agentReceipt?.isolatedAgentMergeReceipt || null;
  const verification = verifyTrustedAutonomousManuscriptRenderReceipt(receipt, {
    paperId: expected.paperId,
    campaignId: expected.campaignId,
    manuscriptPath: expected.manuscriptPath,
    manuscriptHash: expected.renderedManuscriptHash,
    evidenceBoundManuscriptIrHash: expected.evidenceBoundManuscriptIrHash,
    manuscriptIrFileHash: expected.manuscriptIrFileHash,
    agentAuthoredSourceDraftHash: expected.agentAuthoredSourceDraftHash,
    agentAuthoredSourceDraftFileHash: expected.agentAuthoredSourceDraftFileHash,
    venueProfileSelectionHash: expected.venueProfileSelectionHash,
    venueRequirementIrHash: expected.venueRequirementIrHash,
    venueTemplateAssetHash: expected.venueTemplateAssetHash,
    venueTemplateAssetPath: expected.venueTemplateAssetPath,
    submissionMetadataReceiptHash: expected.submissionMetadataReceiptHash,
    agentExecutionReceipt: agentReceipt,
    requireAgentAuthored,
    requireExternalSubmission: expected.requireExternalSubmission === true,
  });
  const valid = Boolean(proof)
    && Boolean(result)
    && result.kind === 'CampaignTrustedAutonomousManuscriptResult'
    && result.status === 'campaign_trusted_autonomous_manuscript_completed'
    && SHA256.test(String(proof.resultHash || ''))
    && hashRecord('PaperCampaignNodeResult', result) === proof.resultHash
    && SHA256.test(String(claimedResultHash || ''))
    && hashRecord('CampaignTrustedAutonomousManuscriptResult', resultPayload)
      === claimedResultHash
    && result.trustedAutonomousManuscriptRenderReceiptHash
      === receipt?.trustedAutonomousManuscriptRenderReceiptHash
    && result.agentExecutionReceiptHash === receipt?.agentAuthoredRenderedProseReceiptHash
    && agentReceipt?.isolatedAgentMergeReceiptHash
      === mergeReceipt?.isolatedAgentMergeReceiptHash
    && verifyIsolatedAgentMergeReceipt(mergeReceipt, {
      delegateAgentExecutionReceipt: agentReceipt,
    })
    && JSON.stringify(agentReceipt?.changedPaths || [])
      === JSON.stringify(mergeReceipt?.changedPaths || [])
    && JSON.stringify(agentReceipt?.agentWorkspacePostimageBinding || null)
      === JSON.stringify(mergeReceipt?.agentWorkspacePostimageBinding || null)
    && verification.valid;
  return Object.freeze({ valid, result, receipt, verification });
}
