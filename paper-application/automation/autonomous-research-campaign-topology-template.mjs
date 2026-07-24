import { hashRecord } from '../../workflow-kernel/record-hash.mjs';
import { buildCampaignModeNodes } from '../../paper-domain/automation/campaign-mode-graph.mjs';

export function buildAutonomousResearchCampaignTopologyTemplate({
  paperId,
  revisionRounds,
  refereeCount,
  empiricalExecutionProfileSelection,
} = {}) {
  const executionIntent = Object.freeze({
    version: 1,
    kind: 'AutonomousResearchCampaignExecutionIntent',
    formalVerificationRequired: true,
    empiricalVerificationRequired: true,
    researchVerificationRequired: true,
    externalSubmissionEnabled: false,
  });
  const nodes = buildCampaignModeNodes({
    campaignId: `autonomous-research:${paperId}`,
    mode: 'full-campaign',
    rounds: revisionRounds,
    reviewers: refereeCount,
    executionProfiles: Object.freeze([
      empiricalExecutionProfileSelection.executionProfile,
    ]),
    executionIntent,
    empiricalRequested: true,
    applyManuscript: true,
    formalRequested: true,
    researchVerificationRequired: true,
  });
  const payload = {
    version: 2,
    kind: 'AutonomousResearchCampaignTopologyTemplate',
    campaignId: `autonomous-research:${paperId}`,
    paperId,
    revisionRounds,
    refereeCount,
    empiricalExecutionProfileSelectionHash:
      empiricalExecutionProfileSelection.autonomousEmpiricalExecutionProfileSelectionHash,
    empiricalExecutionProfile: empiricalExecutionProfileSelection.executionProfile,
    executionIntent,
    nodes,
    externalSubmissionEnabled: false,
  };
  return Object.freeze({
    ...payload,
    autonomousResearchCampaignTopologyTemplateHash:
      hashRecord('AutonomousResearchCampaignTopologyTemplate', payload),
  });
}
