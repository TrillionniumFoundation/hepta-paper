import {
  loadOperatorDatasetAuthorityTrustStoreSync,
} from '../../paper-adapters/automation/operator-dataset-harness-reader.mjs';
import {
  createGpuScientificCampaignForbiddenIdentityProvider,
  createGpuScientificCampaignPromotionAuthorityVerifier,
} from '../../paper-adapters/automation/gpu-scientific-campaign-promotion-authority-verifier.mjs';

export function createPinnedAutonomousSubmissionGpuScientificAuthorityVerifier({
  runtimeRoot,
  environment,
  clock,
} = {}) {
  return createGpuScientificCampaignPromotionAuthorityVerifier({
    trustStoreProvider: () =>
      loadOperatorDatasetAuthorityTrustStoreSync({ runtimeRoot }),
    clock,
    forbiddenIdentityProvider:
      createGpuScientificCampaignForbiddenIdentityProvider({
        environment,
        clock,
      }),
  });
}
