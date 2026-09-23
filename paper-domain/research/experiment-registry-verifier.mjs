import { hashRecord } from '../../workflow-kernel/record-hash.mjs';
import { EXPERIMENT_REPLAY_ASSURANCE_SCOPE } from '../automation/experiment-environment-bom-binding.mjs';
import { verifyEmpiricalClaimUniverse } from './empirical-claim-contract.mjs';

const HASH = /^sha256:[a-f0-9]{64}$/i;
const RECOMPUTATION_INDEPENDENCE_LEVEL = 'repository-separate-implementation-same-process-v1';
const RECOMPUTATION_ASSURANCE_PROFILE =
  'system-harness-store-cas-separate-recomputation-plus-trusted-ledger-v6';

function recordHashValid(record, kind, hashField) {
  if (!record || typeof record !== 'object' || !HASH.test(String(record[hashField] || ''))) return false;
  const { [hashField]: _claimedHash, ...payload } = record;
  return hashRecord(kind, payload) === record[hashField];
}

function arrayEqual(left, right) {
  return JSON.stringify(Array.isArray(left) ? left : []) === JSON.stringify(right);
}

function rawCampaignEvidenceValid(binding) {
  const outputs = Array.isArray(binding?.outputArtifacts) ? binding.outputArtifacts : [];
  const original = outputs.find((item) => item?.name === 'raw-events-original');
  const replay = outputs.find((item) => item?.name === 'raw-events-independent-replay');
  return Boolean(
    HASH.test(String(original?.hash || '')) && HASH.test(String(original?.artifactWriteReceiptHash || ''))
    && original?.ledgerReceiptId && Number.isSafeInteger(original?.bytes) && original.bytes >= 0
    && String(original?.role || '').endsWith(':original')
    && HASH.test(String(replay?.hash || '')) && HASH.test(String(replay?.artifactWriteReceiptHash || ''))
    && replay?.ledgerReceiptId && Number.isSafeInteger(replay?.bytes) && replay.bytes >= 0
    && String(replay?.role || '').endsWith(':independent-replay')
    && original.artifactWriteReceiptHash !== replay.artifactWriteReceiptHash
    && original.ledgerReceiptId !== replay.ledgerReceiptId
    && original.role !== replay.role,
  );
}

function canonicalEmpiricalBindings(experiment) {
  const bindings = Array.isArray(experiment?.empiricalClaimBindings) ? experiment.empiricalClaimBindings : [];
  const claimIds = bindings.map((binding) => binding?.claimId).filter(Boolean);
  const hypothesisIds = bindings.map((binding) => binding?.hypothesisId).filter(Boolean);
  if (!bindings.length || claimIds.length !== bindings.length || hypothesisIds.length !== bindings.length
    || new Set(claimIds).size !== claimIds.length || new Set(hypothesisIds).size !== hypothesisIds.length
    || bindings.some((binding) => !HASH.test(String(binding?.manuscriptClaimHash || ''))
      || (binding?.proposalClaimRecordHash !== null && !HASH.test(String(binding?.proposalClaimRecordHash || ''))))) return null;
  return bindings;
}

export function verifyExperimentEvidenceBindingSummary(experiment = {}) {
  const binding = experiment?.evidenceBinding;
  if (!binding || binding.status !== 'experiment_evidence_binding_verified') return false;
  if (binding.kind === 'CampaignExperimentEvidenceBinding') {
    return recordHashValid(binding, 'CampaignExperimentEvidenceBinding', 'experimentEvidenceBindingHash')
      && binding.version === 8
      && binding.experimentId === experiment.experimentId
      && binding.trustedLedgerReceiptsVerified === true
      && binding.rawArtifactSourcesVerified === true
      && binding.rawArtifactLedgerReceiptsVerified === true
      && binding.independentRawEventRecomputationVerified === true
      && binding.primitiveRecomputationVerified === true
      && binding.independentRecomputationImplementationVerified === true
      && binding.recomputationIndependenceLevel === RECOMPUTATION_INDEPENDENCE_LEVEL
      && HASH.test(String(binding.rawEventRecomputationIndependenceContractHash || ''))
      && binding.recomputationProcessIndependent === false
      && HASH.test(String(binding.originalRawEventRecomputationVerificationHash || ''))
      && HASH.test(String(binding.replayRawEventRecomputationVerificationHash || ''))
      && binding.originalRawEventRecomputationVerificationHash !== binding.replayRawEventRecomputationVerificationHash
      && HASH.test(String(binding.originalRawPrimitiveRecomputationManifestHash || ''))
      && HASH.test(String(binding.replayRawPrimitiveRecomputationManifestHash || ''))
      && HASH.test(String(binding.promotionTcbImplementationHash || ''))
      && binding.assuranceProfile === RECOMPUTATION_ASSURANCE_PROFILE
      && Array.isArray(binding.blockers) && binding.blockers.length === 0
      && binding.executionAssuranceProfile === experiment.assuranceProfile
      && binding.assuranceScope === experiment.assuranceScope
      && binding.evidenceClass === experiment.evidenceClass
      && binding.promotionScope === experiment.promotionScope
      && binding.academicPromotionEligible === (experiment.academicPromotionEligible === true)
      && (binding.academicPromotionEligible !== true || (
        HASH.test(String(binding.analysisProtocolHash || ''))
        && binding.analysisProtocolHash === experiment.analysisProtocolHash
        && HASH.test(String(binding.originalAnalysisEvaluationHash || ''))
        && HASH.test(String(binding.replayAnalysisEvaluationHash || ''))
        && HASH.test(String(binding.analysisProtocolReplayBindingHash || ''))
        && HASH.test(String(binding.originalEnvironmentBomHash || ''))
        && HASH.test(String(binding.replayEnvironmentBomHash || ''))
        && binding.replayAssuranceScope === EXPERIMENT_REPLAY_ASSURANCE_SCOPE
        && HASH.test(String(binding.originalOperatorDatasetAuthorityVerificationHash || ''))
        && binding.originalOperatorDatasetAuthorityVerificationHash
          === binding.replayOperatorDatasetAuthorityVerificationHash
        && HASH.test(String(binding.empiricalClaimUniverseHash || ''))
        && HASH.test(String(binding.manuscriptCorpusHash || ''))
        && canonicalEmpiricalBindings(binding)
        && arrayEqual(binding.claimIds, experiment.claimIds)
        && hashRecord('EmpiricalClaimBindingsExpected', binding.empiricalClaimBindings)
          === hashRecord('EmpiricalClaimBindingsExpected', experiment.empiricalClaimBindings)
        && binding.empiricalClaimUniverseHash === experiment.empiricalClaimUniverseHash
        && binding.manuscriptCorpusHash === experiment.manuscriptCorpusHash
      ))
      && rawCampaignEvidenceValid(binding);
  }
  if (binding.kind === 'ExperimentEvidenceBinding') {
    return recordHashValid(binding, 'ExperimentEvidenceBinding', 'experimentEvidenceBindingHash')
      && binding.experimentId === experiment.experimentId
      && binding.runId === experiment.runId
      && binding.trustedLedgerReceiptsVerified === true
      && binding.artifactSourcesVerified === true
      && Array.isArray(binding.blockers) && binding.blockers.length === 0;
  }
  return false;
}

function acceptancePolicyValid(experiment) {
  const report = experiment?.acceptancePolicy;
  return recordHashValid(report, 'ExperimentAcceptancePolicyReport', 'experimentAcceptancePolicyHash')
    && report.experimentId === experiment.experimentId
    && report.experimentEvidenceBindingHash === experiment.evidenceBinding?.experimentEvidenceBindingHash
    && Array.isArray(report.blockers) && report.blockers.length === 0;
}

function authorityVerified(experiment, authorityVerifier, expectedPaperId, expectedCampaignId) {
  if (experiment?.academicPromotionEligible !== true) return true;
  if (typeof authorityVerifier !== 'function') return false;
  try {
    const verification = authorityVerifier(experiment, {
      expectedPaperId,
      campaignId: expectedCampaignId,
    });
    return verification?.verified === true
      && verification?.status === 'experiment_registry_authority_verified'
      && verification?.experimentId === experiment?.experimentId
      && verification?.experimentEvidenceBindingHash === experiment?.evidenceBinding?.experimentEvidenceBindingHash;
  } catch {
    return false;
  }
}

function reproducibleExperiment(experiment, { authorityVerifier = null, expectedPaperId = null, expectedCampaignId = null } = {}) {
  return Boolean(experiment?.experimentId
    && experiment.status === 'experiment_reproducible'
    && Array.isArray(experiment.missing) && experiment.missing.length === 0
    && verifyExperimentEvidenceBindingSummary(experiment)
    && acceptancePolicyValid(experiment)
    && authorityVerified(experiment, authorityVerifier, expectedPaperId, expectedCampaignId));
}

function academicExperiment(experiment, options) {
  return reproducibleExperiment(experiment, options)
    && experiment.academicPromotionEligible === true
    && experiment.assuranceScope === 'operator-authorized-hidden-evaluation-v1'
    && experiment.evidenceClass === 'academic-experiment-evidence'
    && experiment.promotionScope === 'academic-research-promotion';
}

function conformanceExperiment(experiment, options) {
  return reproducibleExperiment(experiment, options)
    && experiment.academicPromotionEligible !== true
    && experiment.evidenceClass === 'software-conformance-evidence'
    && experiment.promotionScope === 'software-conformance-only';
}

export function deriveExperimentRegistrySummary(experiments = [], options = {}) {
  const records = Array.isArray(experiments) ? experiments : [];
  const incomplete = new Set(records.filter((item) => !reproducibleExperiment(item, options)).map((item) => item?.experimentId || null));
  const academicCandidates = records.filter((item) => academicExperiment(item, options));
  const empiricalClaimUniverse = options.empiricalClaimUniverse || null;
  const empiricalClaimBijectionBlockers = [];
  const universeVerified = verifyEmpiricalClaimUniverse(empiricalClaimUniverse);
  const universeById = new Map((universeVerified ? empiricalClaimUniverse.claims : []).map((claim) => [claim.claimId, claim]));
  const occurrences = new Map();
  for (const experiment of academicCandidates) {
    const bindings = canonicalEmpiricalBindings(experiment);
    if (!universeVerified) {
      empiricalClaimBijectionBlockers.push('empirical_claim_universe_required_for_academic_promotion');
      incomplete.add(experiment.experimentId);
      continue;
    }
    if (!bindings || experiment.empiricalClaimUniverseHash !== empiricalClaimUniverse.empiricalClaimUniverseHash
      || experiment.manuscriptCorpusHash !== empiricalClaimUniverse.manuscriptCorpusHash) {
      empiricalClaimBijectionBlockers.push(`experiment_empirical_claim_authority_mismatch:${experiment.experimentId}`);
      incomplete.add(experiment.experimentId);
      continue;
    }
    for (const binding of bindings) {
      const claim = universeById.get(binding.claimId);
      if (!claim || claim.manuscriptClaimHash !== binding.manuscriptClaimHash
        || claim.proposalClaimRecordHash !== binding.proposalClaimRecordHash) {
        empiricalClaimBijectionBlockers.push(`experiment_empirical_claim_binding_mismatch:${experiment.experimentId}:${binding.claimId}`);
        incomplete.add(experiment.experimentId);
      }
      const current = occurrences.get(binding.claimId) || [];
      current.push(experiment.experimentId);
      occurrences.set(binding.claimId, current);
    }
  }
  if (universeVerified) {
    for (const claim of empiricalClaimUniverse.claims) {
      const ids = occurrences.get(claim.claimId) || [];
      if (ids.length !== 1) {
        empiricalClaimBijectionBlockers.push(ids.length
          ? `empirical_claim_experiment_not_bijective:${claim.claimId}:${ids.join(',')}`
          : `empirical_claim_experiment_missing:${claim.claimId}`);
        for (const id of ids) incomplete.add(id);
        if (!ids.length) for (const experiment of academicCandidates) incomplete.add(experiment.experimentId);
      }
    }
    for (const [claimId, ids] of occurrences) if (!universeById.has(claimId)) {
      empiricalClaimBijectionBlockers.push(`experiment_claim_not_in_manuscript_universe:${claimId}`);
      for (const id of ids) incomplete.add(id);
    }
  }
  const incompleteExperimentIds = [...incomplete].sort();
  const academicPromotionEligibleExperimentIds = academicCandidates
    .filter((item) => !incomplete.has(item.experimentId)).map((item) => item.experimentId);
  const conformanceExperimentIds = records.filter((item) => conformanceExperiment(item, options)).map((item) => item.experimentId);
  const academicPromotionClaimIds = universeVerified && !empiricalClaimBijectionBlockers.length
    ? [...universeById.keys()].sort() : [];
  return Object.freeze({
    status: incompleteExperimentIds.length || empiricalClaimBijectionBlockers.length
      ? 'experiment_registry_blocked' : 'experiment_registry_ready',
    incompleteExperimentIds,
    academicExperimentCount: academicPromotionEligibleExperimentIds.length,
    conformanceExperimentCount: conformanceExperimentIds.length,
    academicPromotionEligibleExperimentIds,
    conformanceExperimentIds,
    academicPromotionClaimIds,
    empiricalClaimUniverseHash: universeVerified ? empiricalClaimUniverse.empiricalClaimUniverseHash : null,
    manuscriptCorpusHash: universeVerified ? empiricalClaimUniverse.manuscriptCorpusHash : null,
    empiricalClaimBijectionBlockers: [...new Set(empiricalClaimBijectionBlockers)],
  });
}

export function verifyExperimentRegistry(registry, {
  expectedPaperId = null,
  expectedCampaignId = null,
  authorityVerifier = null,
  empiricalClaimUniverse = null,
} = {}) {
  const blockers = [];
  if (registry?.version !== 4 || registry?.kind !== 'ExperimentRegistry' || !Array.isArray(registry?.experiments)) {
    blockers.push('experiment_registry_shape_invalid');
  }
  if (!recordHashValid(registry, 'ExperimentRegistry', 'experimentRegistryHash')) {
    blockers.push('experiment_registry_hash_invalid');
  }
  if (expectedPaperId && registry?.paperId !== expectedPaperId) blockers.push('experiment_registry_paper_mismatch');
  const experiments = Array.isArray(registry?.experiments) ? registry.experiments : [];
  const experimentIds = experiments.map((item) => item?.experimentId).filter(Boolean);
  if (experimentIds.length !== experiments.length || new Set(experimentIds).size !== experimentIds.length) {
    blockers.push('experiment_registry_experiment_ids_invalid');
  }
  const expected = deriveExperimentRegistrySummary(experiments, {
    expectedPaperId,
    expectedCampaignId,
    authorityVerifier,
    empiricalClaimUniverse: empiricalClaimUniverse || registry?.empiricalClaimUniverse || null,
  });
  if (experiments.some((item) => item?.academicPromotionEligible === true
    && !authorityVerified(item, authorityVerifier, expectedPaperId, expectedCampaignId))) {
    blockers.push('experiment_registry_academic_authority_required');
  }
  if (registry?.status !== expected.status) blockers.push('experiment_registry_status_mismatch');
  if (!arrayEqual(registry?.incompleteExperimentIds, expected.incompleteExperimentIds)) blockers.push('experiment_registry_incomplete_ids_mismatch');
  if (!arrayEqual(registry?.academicPromotionEligibleExperimentIds, expected.academicPromotionEligibleExperimentIds)) {
    blockers.push('experiment_registry_academic_ids_mismatch');
  }
  if (!arrayEqual(registry?.conformanceExperimentIds, expected.conformanceExperimentIds)) blockers.push('experiment_registry_conformance_ids_mismatch');
  if (!arrayEqual(registry?.academicPromotionClaimIds, expected.academicPromotionClaimIds)) blockers.push('experiment_registry_academic_claim_ids_mismatch');
  if (registry?.empiricalClaimUniverseHash !== expected.empiricalClaimUniverseHash
    || registry?.manuscriptCorpusHash !== expected.manuscriptCorpusHash) blockers.push('experiment_registry_empirical_claim_universe_mismatch');
  if (!arrayEqual(registry?.empiricalClaimBijectionBlockers, expected.empiricalClaimBijectionBlockers)) {
    blockers.push('experiment_registry_empirical_claim_bijection_blockers_mismatch');
  }
  if (registry?.academicExperimentCount !== expected.academicExperimentCount) blockers.push('experiment_registry_academic_count_mismatch');
  if (registry?.conformanceExperimentCount !== expected.conformanceExperimentCount) blockers.push('experiment_registry_conformance_count_mismatch');
  return Object.freeze({
    valid: blockers.length === 0,
    status: blockers.length ? 'experiment_registry_verification_blocked' : 'experiment_registry_verified',
    blockers: [...new Set(blockers)],
    expected,
  });
}
