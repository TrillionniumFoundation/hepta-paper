import { hashRecord } from '../../workflow-kernel/record-hash.mjs';
import { analysisProtocolHasEmpiricalClaimAuthority } from '../automation/analysis-protocol-contract.mjs';
import { campaignExperimentArtifactRole } from './campaign-experiment-artifact-identity.mjs';

export function empiricalProtocolBindings(runReceipt) {
  const protocol = runReceipt?.analysisProtocol;
  if (!analysisProtocolHasEmpiricalClaimAuthority(protocol)) return Object.freeze([]);
  return Object.freeze(protocol.hypotheses.map((hypothesis) => Object.freeze({
    hypothesisId: hypothesis.hypothesisId,
    claimId: hypothesis.claimId,
    manuscriptClaimHash: hypothesis.manuscriptClaimHash,
    proposalClaimRecordHash: hypothesis.proposalClaimRecordHash,
  })));
}

export function empiricalClaimLineageMatches(
  subject,
  runReceipt,
  bindings = empiricalProtocolBindings(runReceipt),
) {
  const expectedClaimIds = bindings.map((binding) => binding.claimId);
  return subject?.analysisProtocolHash === runReceipt?.analysisProtocolHash
    && subject?.empiricalClaimUniverseHash === runReceipt?.analysisProtocol?.empiricalClaimUniverseHash
    && subject?.manuscriptCorpusHash === runReceipt?.analysisProtocol?.manuscriptCorpusHash
    && hashRecord('EmpiricalClaimIdsExpected', subject?.claimIds || [])
      === hashRecord('EmpiricalClaimIdsExpected', expectedClaimIds)
    && hashRecord('EmpiricalClaimBindingsExpected', subject?.empiricalClaimBindings || [])
      === hashRecord('EmpiricalClaimBindingsExpected', bindings);
}

export function expectedCampaignExperimentArtifactRole(input) {
  try { return campaignExperimentArtifactRole(input); } catch { return null; }
}
