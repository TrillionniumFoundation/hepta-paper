import {
  gpuScientificPromotionAuthorityVerifierForReleaseQuery,
} from '../../paper-adapters/persistence/sqlite-campaign-release-query-repository.mjs';
import {
  bootstrapSubmissionHandoffContext,
} from '../bootstrap/submission-handoff-context-bootstrap.mjs';

export function openAutomationFullResearchReleaseQueryContext({
  root,
  runtimeRoot,
  environment,
} = {}) {
  const context = bootstrapSubmissionHandoffContext({
    root,
    runtimeRoot,
    environment,
  });
  const campaignReleaseQuery = context.services.campaignReleaseQuery;
  return Object.freeze({
    resolveCampaignReleaseAuthority: ({ campaignId }) =>
      campaignReleaseQuery.getCurrentRelease({ campaignId }),
    gpuScientificPromotionAuthorityVerifier:
      gpuScientificPromotionAuthorityVerifierForReleaseQuery(campaignReleaseQuery),
    close: () => context.services.persistenceSession.close(),
  });
}
