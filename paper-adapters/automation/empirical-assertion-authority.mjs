import fs from 'node:fs';
import path from 'node:path';
import {
  buildEmpiricalAssertionAuthority,
  verifyEmpiricalAssertionAuthority,
} from '../../paper-domain/research/empirical-assertion-contract.mjs';
import { expectedCampaignExperimentArtifactRole } from '../../paper-domain/research/campaign-experiment-claim-lineage.mjs';
import {
  verifyExperimentReplayReceipt,
  verifyExperimentRunReceipt,
} from '../../paper-domain/automation/experiment-run-contract.mjs';
import { isPathWithin } from '../../workflow-kernel/runtime/path-utils.mjs';
import { readScopedFileSync } from '../../workflow-kernel/runtime/scoped-file-identity.mjs';
import { hashRecord } from '../../workflow-kernel/record-hash.mjs';
import { writeDurableJsonSync } from '../runtime/durable-json-repository.mjs';

export const EMPIRICAL_ASSERTION_AUTHORITY_PATH = 'automation-results/EMPIRICAL_ASSERTION_AUTHORITY.json';

function resultArtifact(outputs, name) {
  const artifact = (outputs || []).find((candidate) => candidate?.name === name);
  if (!artifact?.hash || artifact.path !== 'results.json' || !artifact.role) {
    throw new Error(`empirical_assertion_registry_result_artifact_missing:${name}`);
  }
  return artifact;
}

function canonicalExperiment({
  experimentId,
  originalNodeId,
  originalAttemptId,
  replayNodeId,
  replayAttemptId,
  originalRunReceipt,
  experimentReplayReceipt,
  outputArtifacts,
  claimBindings,
} = {}) {
  const replayRunReceipt = experimentReplayReceipt?.replayRunReceipt || null;
  if (!verifyExperimentRunReceipt(originalRunReceipt)
    || !verifyExperimentRunReceipt(replayRunReceipt)
    || !verifyExperimentReplayReceipt(experimentReplayReceipt)
    || experimentReplayReceipt.originalExperimentRunReceiptHash !== originalRunReceipt.experimentRunReceiptHash) {
    throw new Error(`empirical_assertion_experiment_receipts_invalid:${experimentId || 'missing'}`);
  }
  const originalArtifact = resultArtifact(outputArtifacts, 'results-json-original');
  const replayArtifact = resultArtifact(outputArtifacts, 'results-json-independent-replay');
  return Object.freeze({
    experimentId,
    originalNodeId,
    originalAttemptId,
    replayNodeId,
    replayAttemptId,
    analysisProtocolHash: originalRunReceipt.analysisProtocolHash,
    empiricalClaimUniverseHash: originalRunReceipt.analysisProtocol?.empiricalClaimUniverseHash,
    claimBindings: Object.freeze(claimBindings),
    originalRunReceiptHash: originalRunReceipt.experimentRunReceiptHash,
    replayRunReceiptHash: replayRunReceipt.experimentRunReceiptHash,
    experimentReplayReceiptHash: experimentReplayReceipt.experimentReplayReceiptHash,
    originalAnalysisEvaluationHash:
      originalRunReceipt.analysisProtocolEvaluation?.academicAnalysisProtocolEvaluationHash,
    replayAnalysisEvaluationHash:
      replayRunReceipt.analysisProtocolEvaluation?.academicAnalysisProtocolEvaluationHash,
    originalResultArtifactHash: originalArtifact.hash,
    replayResultArtifactHash: replayArtifact.hash,
    originalResultArtifactRole: originalArtifact.role,
    replayResultArtifactRole: replayArtifact.role,
    originalEvaluation: originalRunReceipt.analysisProtocolEvaluation,
    replayEvaluation: replayRunReceipt.analysisProtocolEvaluation,
  });
}

function registryExperiment(experiment) {
  const binding = experiment?.evidenceBinding;
  const evidence = binding?.authorityEvidence;
  const runReceipt = evidence?.experimentRunReceipt;
  const replayReceipt = evidence?.experimentReplayReceipt;
  return canonicalExperiment({
    experimentId: experiment?.experimentId,
    originalNodeId: evidence?.originalCampaignNodeId,
    originalAttemptId: evidence?.originalCampaignNodeAttemptId,
    replayNodeId: evidence?.replayCampaignNodeId,
    replayAttemptId: evidence?.replayCampaignNodeAttemptId,
    originalRunReceipt: runReceipt,
    experimentReplayReceipt: replayReceipt,
    outputArtifacts: binding?.outputArtifacts,
    claimBindings: experiment?.empiricalClaimBindings || binding?.empiricalClaimBindings || [],
  });
}

function evaluationRecordValid(evaluation, expectedHash) {
  if (evaluation?.version !== 1 || evaluation?.kind !== 'AcademicAnalysisProtocolEvaluation'
    || evaluation?.status !== 'academic_analysis_protocol_verified'
    || !Array.isArray(evaluation?.hypotheses) || !evaluation.hypotheses.length
    || !Array.isArray(evaluation?.blockers) || evaluation.blockers.length) return false;
  const { academicAnalysisProtocolEvaluationHash, ...payload } = evaluation;
  return academicAnalysisProtocolEvaluationHash === expectedHash
    && hashRecord('AcademicAnalysisProtocolEvaluation', payload) === expectedHash;
}

function derivationExperiment(experiment, projection, paperId, campaignId) {
  const binding = experiment?.evidenceBinding;
  const outputs = binding?.outputArtifacts || [];
  const originalArtifact = resultArtifact(outputs, 'results-json-original');
  const replayArtifact = resultArtifact(outputs, 'results-json-independent-replay');
  const expectedOriginalRole = expectedCampaignExperimentArtifactRole({
    paperId,
    campaignId,
    nodeId: projection?.originalNodeId,
    attemptId: projection?.originalAttemptId,
    executionRole: 'original',
    artifactName: 'results.json',
  });
  const expectedReplayRole = expectedCampaignExperimentArtifactRole({
    paperId,
    campaignId,
    nodeId: projection?.replayNodeId,
    attemptId: projection?.replayAttemptId,
    executionRole: 'independent-replay',
    artifactName: 'results.json',
  });
  const { empiricalAssertionRegistryDerivationExperimentHash: claimedHash, ...projectionPayload } = projection || {};
  if (projection?.version !== 1 || projection?.kind !== 'EmpiricalAssertionRegistryDerivationExperiment'
    || projection?.experimentId !== experiment?.experimentId
    || hashRecord('EmpiricalAssertionRegistryDerivationExperiment', projectionPayload) !== claimedHash
    || !evaluationRecordValid(projection?.originalEvaluation, binding?.originalAnalysisEvaluationHash)
    || !evaluationRecordValid(projection?.replayEvaluation, binding?.replayAnalysisEvaluationHash)
    || projection.originalEvaluation.analysisProtocolHash !== binding?.analysisProtocolHash
    || projection.replayEvaluation.analysisProtocolHash !== binding?.analysisProtocolHash
    || projection.originalEvaluation.analysisProtocol?.empiricalClaimUniverseHash
      !== binding?.empiricalClaimUniverseHash
    || projection.replayEvaluation.analysisProtocol?.empiricalClaimUniverseHash
      !== binding?.empiricalClaimUniverseHash
    || originalArtifact.role !== expectedOriginalRole || replayArtifact.role !== expectedReplayRole
    || JSON.stringify(projection?.claimBindings || [])
      !== JSON.stringify(experiment?.empiricalClaimBindings || binding?.empiricalClaimBindings || [])) {
    throw new Error(`empirical_assertion_registry_derivation_invalid:${experiment?.experimentId || 'missing'}`);
  }
  return Object.freeze({
    experimentId: experiment.experimentId,
    originalNodeId: projection.originalNodeId,
    originalAttemptId: projection.originalAttemptId,
    replayNodeId: projection.replayNodeId,
    replayAttemptId: projection.replayAttemptId,
    analysisProtocolHash: binding.analysisProtocolHash,
    empiricalClaimUniverseHash: binding.empiricalClaimUniverseHash,
    claimBindings: Object.freeze(projection.claimBindings),
    originalRunReceiptHash: binding.experimentRunReceiptHash,
    replayRunReceiptHash: projection.replayRunReceiptHash,
    experimentReplayReceiptHash: binding.experimentReplayReceiptHash,
    originalAnalysisEvaluationHash: binding.originalAnalysisEvaluationHash,
    replayAnalysisEvaluationHash: binding.replayAnalysisEvaluationHash,
    originalResultArtifactHash: originalArtifact.hash,
    replayResultArtifactHash: replayArtifact.hash,
    originalResultArtifactRole: originalArtifact.role,
    replayResultArtifactRole: replayArtifact.role,
    originalEvaluation: projection.originalEvaluation,
    replayEvaluation: projection.replayEvaluation,
  });
}

function derivationEvidenceExperiments({ registry, derivationEvidence, paperId, campaignId }) {
  const { empiricalAssertionRegistryDerivationEvidenceHash: claimedHash, ...payload } = derivationEvidence || {};
  if (derivationEvidence?.version !== 1 || derivationEvidence?.kind !== 'EmpiricalAssertionRegistryDerivationEvidence'
    || derivationEvidence?.paperId !== paperId || derivationEvidence?.campaignId !== campaignId
    || derivationEvidence?.experimentRegistryHash !== registry?.experimentRegistryHash
    || !Array.isArray(derivationEvidence?.experiments)
    || hashRecord('EmpiricalAssertionRegistryDerivationEvidence', payload) !== claimedHash) {
    throw new Error('empirical_assertion_registry_derivation_evidence_invalid');
  }
  const projections = new Map(derivationEvidence.experiments
    .map((projection) => [projection?.experimentId, projection]));
  const academic = (registry.experiments || []).filter((experiment) =>
    experiment?.academicPromotionEligible === true && experiment?.status === 'experiment_reproducible');
  if (projections.size !== academic.length) throw new Error('empirical_assertion_registry_derivation_bijection_invalid');
  return academic.map((experiment) => derivationExperiment(
    experiment,
    projections.get(experiment.experimentId),
    paperId,
    campaignId,
  ));
}

export function buildEmpiricalAssertionRegistryDerivationEvidence({ registry, paperId, campaignId } = {}) {
  const experiments = (registry?.experiments || [])
    .filter((experiment) => experiment?.academicPromotionEligible === true
      && experiment?.status === 'experiment_reproducible')
    .map((experiment) => {
      const binding = experiment.evidenceBinding;
      const evidence = binding.authorityEvidence;
      const replayRunReceipt = evidence?.experimentReplayReceipt?.replayRunReceipt;
      const projectionPayload = {
        version: 1,
        kind: 'EmpiricalAssertionRegistryDerivationExperiment',
        experimentId: experiment.experimentId,
        originalNodeId: evidence?.originalCampaignNodeId,
        originalAttemptId: evidence?.originalCampaignNodeAttemptId,
        replayNodeId: evidence?.replayCampaignNodeId,
        replayAttemptId: evidence?.replayCampaignNodeAttemptId,
        replayRunReceiptHash: replayRunReceipt?.experimentRunReceiptHash || null,
        claimBindings: Object.freeze(experiment.empiricalClaimBindings || binding.empiricalClaimBindings || []),
        originalEvaluation: evidence?.experimentRunReceipt?.analysisProtocolEvaluation || null,
        replayEvaluation: replayRunReceipt?.analysisProtocolEvaluation || null,
      };
      return Object.freeze({
        ...projectionPayload,
        empiricalAssertionRegistryDerivationExperimentHash:
          hashRecord('EmpiricalAssertionRegistryDerivationExperiment', projectionPayload),
      });
    });
  const payload = {
    version: 1,
    kind: 'EmpiricalAssertionRegistryDerivationEvidence',
    paperId,
    campaignId,
    experimentRegistryHash: registry?.experimentRegistryHash || null,
    experiments: Object.freeze(experiments),
  };
  return Object.freeze({
    ...payload,
    empiricalAssertionRegistryDerivationEvidenceHash:
      hashRecord('EmpiricalAssertionRegistryDerivationEvidence', payload),
  });
}

export function buildEmpiricalAssertionAuthorityFromRegistry({
  registry,
  paperId,
  campaignId,
  registryVerified = false,
  derivationEvidence = null,
} = {}) {
  if (registryVerified !== true || registry?.status !== 'experiment_registry_ready'
    || registry?.paperId !== paperId || !registry?.experimentRegistryHash) {
    throw new Error('empirical_assertion_verified_experiment_registry_required');
  }
  const experiments = derivationEvidence
    ? derivationEvidenceExperiments({ registry, derivationEvidence, paperId, campaignId })
    : (registry.experiments || [])
      .filter((experiment) => experiment?.academicPromotionEligible === true
        && experiment?.status === 'experiment_reproducible')
      .map(registryExperiment);
  return buildEmpiricalAssertionAuthority({
    paperId,
    campaignId,
    experimentRegistryHash: registry.experimentRegistryHash,
    experiments,
  });
}

function directOriginalNode(nodes, replayNode) {
  const dependencies = new Set(replayNode?.dependencies || []);
  const candidates = nodes.filter((node) => dependencies.has(node.nodeId)
    && node.status === 'completed' && node.result?.experimentRunReceipt
    && !node.result?.experimentReplayReceipt);
  return candidates.find((node) => replayNode.result.experimentReplayReceipt
    ?.originalExperimentRunReceiptHash === node.result.experimentRunReceipt.experimentRunReceiptHash) || null;
}

function nodeExperiment({ paperId, campaignId, nodes, replayNode }) {
  const originalNode = directOriginalNode(nodes, replayNode);
  if (!originalNode) throw new Error(`empirical_assertion_original_node_missing:${replayNode.nodeId}`);
  const originalRunReceipt = originalNode.result.experimentRunReceipt;
  const replayReceipt = replayNode.result.experimentReplayReceipt;
  const replayRunReceipt = replayReceipt?.replayRunReceipt;
  const outputArtifacts = [
    {
      name: 'results-json-original',
      path: 'results.json',
      hash: originalRunReceipt?.resultJsonHash,
      role: expectedCampaignExperimentArtifactRole({
        paperId, campaignId, nodeId: originalNode.nodeId, attemptId: originalNode.attemptId,
        executionRole: 'original', artifactName: 'results.json',
      }),
    },
    {
      name: 'results-json-independent-replay',
      path: 'results.json',
      hash: replayRunReceipt?.resultJsonHash,
      role: expectedCampaignExperimentArtifactRole({
        paperId, campaignId, nodeId: replayNode.nodeId, attemptId: replayNode.attemptId,
        executionRole: 'independent-replay', artifactName: 'results.json',
      }),
    },
  ];
  return canonicalExperiment({
    experimentId: `${originalRunReceipt?.benchmarkId}:${replayNode.nodeId}`,
    originalNodeId: originalNode.nodeId,
    originalAttemptId: originalNode.attemptId,
    replayNodeId: replayNode.nodeId,
    replayAttemptId: replayNode.attemptId,
    originalRunReceipt,
    experimentReplayReceipt: replayReceipt,
    outputArtifacts,
    claimBindings: (originalRunReceipt?.analysisProtocol?.hypotheses || []).map((hypothesis) => ({
      hypothesisId: hypothesis.hypothesisId,
      claimId: hypothesis.claimId,
      manuscriptClaimHash: hypothesis.manuscriptClaimHash,
      proposalClaimRecordHash: hypothesis.proposalClaimRecordHash,
    })),
  });
}

export function buildEmpiricalAssertionAuthorityFromCampaignNodes({ paperId, campaignId, nodes = [] } = {}) {
  const completedReplayNodes = nodes.filter((node) => node?.status === 'completed'
    && node?.result?.experimentReplayReceipt && node?.result?.experimentRunReceipt);
  const latestByClaimSet = new Map();
  for (const replayNode of completedReplayNodes) {
    const claimSet = (replayNode.result.experimentRunReceipt.analysisProtocol?.hypotheses || [])
      .map((hypothesis) => hypothesis.claimId).sort().join('|');
    const current = latestByClaimSet.get(claimSet);
    if (!current || Number(replayNode.roundIndex || 0) > Number(current.roundIndex || 0)
      || (Number(replayNode.roundIndex || 0) === Number(current.roundIndex || 0)
        && String(replayNode.nodeId).localeCompare(String(current.nodeId)) > 0)) {
      latestByClaimSet.set(claimSet, replayNode);
    }
  }
  const experiments = [...latestByClaimSet.values()]
    .map((replayNode) => nodeExperiment({ paperId, campaignId, nodes, replayNode }));
  return buildEmpiricalAssertionAuthority({ paperId, campaignId, experiments });
}

function authorityCandidate(workspace) {
  const root = path.resolve(workspace || '');
  const candidate = path.resolve(root, EMPIRICAL_ASSERTION_AUTHORITY_PATH);
  if (!root || candidate === root || !isPathWithin(root, candidate)) {
    throw new Error('empirical_assertion_authority_path_invalid');
  }
  return { root, candidate };
}

export function materializeEmpiricalAssertionAuthority({ workspace, paperId, campaignId, nodes = [] } = {}) {
  const authority = buildEmpiricalAssertionAuthorityFromCampaignNodes({ paperId, campaignId, nodes });
  const { root, candidate } = authorityCandidate(workspace);
  const parent = path.dirname(candidate);
  fs.mkdirSync(parent, { recursive: true, mode: 0o700 });
  const rootReal = fs.realpathSync(root);
  const parentStat = fs.lstatSync(parent);
  const parentReal = fs.realpathSync(parent);
  if (!parentStat.isDirectory() || parentStat.isSymbolicLink() || !isPathWithin(rootReal, parentReal)) {
    throw new Error('empirical_assertion_authority_parent_invalid');
  }
  writeDurableJsonSync(candidate, authority);
  return authority;
}

export function readMaterializedEmpiricalAssertionAuthority({
  workspace,
  expectedPaperId,
  expectedCampaignId,
} = {}) {
  const { root, candidate } = authorityCandidate(workspace);
  const read = readScopedFileSync({ scopeRoot: root, candidate });
  if (read.status !== 'scoped_file_read_verified') {
    return Object.freeze({ authority: null, valid: false, blockers: Object.freeze(['empirical_assertion_materialized_authority_missing']) });
  }
  let authority = null;
  try { authority = JSON.parse(read.content.toString('utf8')); } catch { /* blocked below */ }
  const verification = verifyEmpiricalAssertionAuthority(authority, {
    paperId: expectedPaperId,
    campaignId: expectedCampaignId,
    experimentRegistryHash: null,
  });
  return Object.freeze({
    authority,
    valid: verification.valid,
    blockers: verification.blockers,
    scopedFileReadReceiptHash: read.scopedFileReadReceiptHash,
  });
}

export function empiricalAssertionAuthorityEntriesMatch(left, right) {
  const normalize = (authority) => [...(authority?.entries || [])]
    .sort((a, b) => String(a?.assertionId || '').localeCompare(String(b?.assertionId || '')));
  return JSON.stringify(normalize(left)) === JSON.stringify(normalize(right));
}
