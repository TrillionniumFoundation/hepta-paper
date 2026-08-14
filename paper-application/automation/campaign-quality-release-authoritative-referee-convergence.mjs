import { hashRecord } from '../../workflow-kernel/record-hash.mjs';

export function authoritativeRefereeConvergence({ campaign, context, manuscriptHash }) {
  const finalDependencies = new Set(context.finalCompileNode?.dependencies || []);
  const candidates = (context.campaignNodes || []).filter((candidate) => {
    const decision = candidate?.result || null;
    const { refereeConvergenceDecisionHash: claimedHash, ...payload } = decision || {};
    return candidate?.kind === 'convergence'
      && candidate?.status === 'completed'
      && finalDependencies.has(candidate.nodeId)
      && decision?.kind === 'RefereeConvergenceDecision'
      && decision?.paperId === campaign.paperId
      && decision?.status === 'referee_convergence_reached'
      && decision?.accepted === true
      && decision?.expectedManuscriptHash === manuscriptHash
      && hashRecord('RefereeConvergenceDecision', payload) === claimedHash
      && hashRecord('PaperCampaignNodeResult', decision) === candidate?.resultSha256;
  });
  return candidates.length === 1 ? candidates[0].result : null;
}
