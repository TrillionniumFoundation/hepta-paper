import {
  inspectAutonomousResearchReleaseReviewerEvidence,
} from '../../paper-domain/automation/autonomous-research-release-reviewer-evidence-contract.mjs';

export function assertCampaignReleaseReviewerEvidenceForPackaging({
  campaign,
  releaseBinding,
  reviewerEvidenceAuthority,
  expectedManuscriptHash,
  errorCode = 'campaign_release_reviewer_evidence_invalid',
} = {}) {
  if (campaign?.spec?.autonomousResearchPreparation?.launchMode !== 'production-run') {
    return null;
  }
  const inspection = inspectAutonomousResearchReleaseReviewerEvidence(
    releaseBinding?.releaseReviewerEvidence,
    {
      runtimePrincipalBinding:
        campaign.spec.autonomousResearchPreparation.runtimePrincipalBinding,
      reviewerEvidenceAuthority,
      expected: {
        campaignId: campaign.campaignId,
        paperId: campaign.paperId,
        campaignPlanHash: campaign.spec.campaignPlanHash,
        expectedManuscriptHash,
      },
    },
  );
  if (!inspection.valid) {
    throw new Error(`${errorCode}:${inspection.blockers.join(',')}`);
  }
  return inspection;
}
