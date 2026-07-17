import {
  bindEmpiricalAssertionUniverse,
  verifyEmpiricalAssertionAuthority,
} from '../../paper-domain/research/empirical-assertion-contract.mjs';
import {
  buildEmpiricalAssertionAuthorityFromRegistry,
  buildEmpiricalAssertionRegistryDerivationEvidence,
  empiricalAssertionAuthorityEntriesMatch,
} from '../automation/empirical-assertion-authority.mjs';
import {
  portableResearchEvidenceDocument,
  portableResearchEvidenceValue,
} from './research-evidence-capsule-publication-policy.mjs';

export function portableExperimentRegistryWithAssertionDerivation({ registry, paperId, campaignId } = {}) {
  return Object.freeze({
    ...portableResearchEvidenceDocument(
      'PortableExperimentRegistry',
      'sourceExperimentRegistryHash',
      registry?.experimentRegistryHash,
      registry,
    ),
    empiricalAssertionRegistryDerivationEvidence: portableResearchEvidenceValue(
      buildEmpiricalAssertionRegistryDerivationEvidence({ registry, paperId, campaignId }),
    ),
  });
}

export function empiricalAssertionResearchReportValid(report, {
  campaignId = null,
  registry = report?.capabilities?.experimentRegistry,
  derivationEvidence = null,
} = {}) {
  if (Number(registry?.academicExperimentCount || 0) < 1) return true;
  const recordedAuthority = report?.capabilities?.empiricalAssertionAuthority;
  const universe = report?.capabilities?.empiricalAssertionUniverse;
  const binding = report?.capabilities?.empiricalAssertionUniverseBinding;
  let authority = null;
  try {
    authority = buildEmpiricalAssertionAuthorityFromRegistry({
      registry,
      paperId: report?.paperId,
      campaignId,
      registryVerified: true,
      derivationEvidence,
    });
  } catch { return false; }
  const authorityVerification = verifyEmpiricalAssertionAuthority(recordedAuthority, {
    paperId: report?.paperId,
    campaignId,
    experimentRegistryHash: registry?.experimentRegistryHash,
  });
  const rebound = bindEmpiricalAssertionUniverse({
    authority,
    universe,
    expectedPaperId: report?.paperId,
    expectedCampaignId: campaignId,
    expectedExperimentRegistryHash: registry?.experimentRegistryHash,
  });
  return authorityVerification.valid
    && empiricalAssertionAuthorityEntriesMatch(recordedAuthority, authority)
    && recordedAuthority?.empiricalAssertionAuthorityHash === authority.empiricalAssertionAuthorityHash
    && binding?.status === 'empirical_assertion_universe_binding_verified'
    && binding?.empiricalAssertionUniverseBindingHash === rebound.empiricalAssertionUniverseBindingHash
    && report?.empiricalAssertionAuthorityHash === authority.empiricalAssertionAuthorityHash
    && report?.empiricalAssertionUniverseHash === universe?.empiricalAssertionUniverseHash
    && report?.empiricalAssertionUniverseBindingHash === binding?.empiricalAssertionUniverseBindingHash
    && report?.empiricalAssertionManuscriptCorpusHash === universe?.manuscriptCorpusHash;
}
