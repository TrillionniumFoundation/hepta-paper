import { assertCampaignReleasePackagerPort } from '../../paper-ports/campaign-release-packager-port.mjs';
import { assertCampaignResearchVerifierPort } from '../../paper-ports/campaign-research-verifier-port.mjs';

function nonRetryable(message) {
  const error = new Error(message);
  error.retryable = false;
  return error;
}

export function createCampaignReleasePrimitivesAdapter({ releasePackager = null, researchVerifier = null, runtimeRoot } = {}) {
  const packager = releasePackager ? assertCampaignReleasePackagerPort(releasePackager) : null;
  const verifier = researchVerifier ? assertCampaignResearchVerifierPort(researchVerifier) : null;
  return Object.freeze({
    version: 1,
    kind: 'CampaignReleasePrimitivesAdapter',
    verifyFormal(input) {
      if (!verifier) throw nonRetryable('campaign_research_verifier_required');
      return verifier.verify({ ...input, verificationScope: 'formal-only' });
    },
    verifyResearch(input) {
      if (!verifier) throw nonRetryable('campaign_research_verifier_required');
      return verifier.verify({ ...input, verificationScope: 'aggregate-research' });
    },
    packageRelease(input) {
      if (!packager) throw nonRetryable('campaign_release_packager_required');
      return packager.packageRelease({ runtimeRoot, ...input });
    },
  });
}
