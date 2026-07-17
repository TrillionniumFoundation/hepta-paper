import { bindEmpiricalAssertionUniverse } from '../../paper-domain/research/empirical-assertion-contract.mjs';
import { buildEmpiricalAssertionAuthorityFromRegistry } from '../automation/empirical-assertion-authority.mjs';

export function buildEmpiricalAssertionReportCapability({
  required = false,
  registry,
  registryVerified = false,
  universe = null,
  paperId,
  campaignId,
} = {}) {
  if (!required) return Object.freeze({
    empiricalAssertionAuthority: null,
    empiricalAssertionUniverse: null,
    empiricalAssertionUniverseBinding: null,
    blockers: Object.freeze([]),
  });
  const blockers = [];
  let empiricalAssertionAuthority = null;
  let empiricalAssertionUniverseBinding = null;
  try {
    empiricalAssertionAuthority = buildEmpiricalAssertionAuthorityFromRegistry({
      registry,
      paperId,
      campaignId,
      registryVerified,
    });
    empiricalAssertionUniverseBinding = bindEmpiricalAssertionUniverse({
      authority: empiricalAssertionAuthority,
      universe,
      expectedPaperId: paperId,
      expectedCampaignId: campaignId,
      expectedExperimentRegistryHash: registry?.experimentRegistryHash,
    });
    blockers.push(...empiricalAssertionUniverseBinding.blockers);
  } catch (error) {
    blockers.push(`empirical_assertion_authority_build_failed:${error?.message || 'unknown'}`);
  }
  return Object.freeze({
    empiricalAssertionAuthority,
    empiricalAssertionUniverse: universe,
    empiricalAssertionUniverseBinding,
    blockers: Object.freeze([...new Set(blockers)]),
  });
}
