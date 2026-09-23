import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  bindEmpiricalAssertionUniverse,
  buildEmpiricalAssertionAuthority,
  empiricalPresentationArtifactContents,
  empiricalPresentationMarkerDeclaration,
} from '../../../paper-domain/research/empirical-assertion-contract.mjs';
import {
  readEmpiricalAssertionUniverse,
} from '../../../paper-adapters/research-verify/empirical-assertion-universe-reader.mjs';
import {
  buildEmpiricalAssertionAuthorityFromRegistry,
} from '../../../paper-adapters/automation/empirical-assertion-authority.mjs';
import {
  expectedCampaignExperimentArtifactRole,
} from '../../../paper-domain/research/campaign-experiment-claim-lineage.mjs';
import { hashRecord } from '../../../workflow-kernel/record-hash.mjs';

export const hash = (character) => `sha256:${character.repeat(64)}`;

export function evaluation(
  hypothesisId,
  claimId,
  accepted,
  estimate,
  scientificVerdict = accepted ? 'positive' : 'negative',
  scientificUncertaintyReasons = [],
) {
  return Object.freeze({
    status: 'academic_analysis_protocol_verified',
    analysisProtocol: Object.freeze({
      pairedUnit: 'seed',
      metricSpecs: Object.freeze({
        score: Object.freeze({ unit: 'score-points' }),
      }),
    }),
    scientificVerdict,
    academicAnalysisProtocolEvaluationHash: hash(accepted ? 'a' : 'b'),
    hypotheses: Object.freeze([Object.freeze({
      hypothesisId,
      claimId,
      metric: 'score',
      comparator: 'baseline',
      alternative: 'greater',
      minimumEffect: 0.1,
      acceptanceRequired: true,
      count: 10,
      estimate,
      standardDeviation: 0.2,
      standardError: 0.02,
      standardizedEffect: 2.5,
      bootstrap: Object.freeze({ lower: estimate - 0.1, upper: estimate + 0.1 }),
      pValue: accepted ? 0.01 : 0.2,
      skewness: 0,
      winsorizedMean: estimate,
      minimumLeaveOneOutMean: estimate - 0.01,
      assumptionAccepted: true,
      sensitivityAccepted: true,
      uncertaintyAccepted: true,
      holmRank: 1,
      holmThreshold: 0.05,
      adjustedPValue: accepted ? 0.01 : 0.2,
      multiplicityAccepted: accepted,
      accepted,
      scientificVerdict,
      scientificUncertaintyReasons: Object.freeze([...scientificUncertaintyReasons]),
    })]),
  });
}

export function experiment({
  suffix,
  claimId,
  hypothesisId,
  accepted,
  estimate,
  scientificVerdict = accepted ? 'positive' : 'negative',
  scientificUncertaintyReasons = [],
}) {
  const originalEvaluation = evaluation(
    hypothesisId, claimId, accepted, estimate, scientificVerdict, scientificUncertaintyReasons,
  );
  const replayEvaluation = evaluation(
    hypothesisId, claimId, accepted, estimate, scientificVerdict, scientificUncertaintyReasons,
  );
  return Object.freeze({
    experimentId: `experiment-${suffix}`,
    originalNodeId: `original-${suffix}`,
    originalAttemptId: `attempt-original-${suffix}`,
    replayNodeId: `replay-${suffix}`,
    replayAttemptId: `attempt-replay-${suffix}`,
    analysisProtocolHash: hash('1'),
    empiricalClaimUniverseHash: hash('2'),
    claimBindings: Object.freeze([Object.freeze({
      claimId,
      hypothesisId,
      manuscriptClaimHash: hash(suffix === 'positive' ? '3' : '4'),
      proposalClaimRecordHash: null,
    })]),
    originalRunReceiptHash: hash('5'),
    replayRunReceiptHash: hash('6'),
    experimentReplayReceiptHash: hash('7'),
    originalAnalysisEvaluationHash: hash('8'),
    replayAnalysisEvaluationHash: hash('9'),
    originalResultArtifactHash: hash('a'),
    replayResultArtifactHash: hash('b'),
    originalResultArtifactRole: `result-role:${suffix}:original`,
    replayResultArtifactRole: `result-role:${suffix}:independent-replay`,
    originalEvaluation,
    replayEvaluation,
  });
}

export function authority() {
  return buildEmpiricalAssertionAuthority({
    paperId: 'paper-typed',
    campaignId: 'campaign-typed',
    experimentRegistryHash: hash('c'),
    experiments: [
      experiment({
        suffix: 'positive', claimId: 'claim-positive', hypothesisId: 'hyp-positive',
        accepted: true, estimate: 0.5,
      }),
      experiment({
        suffix: 'negative', claimId: 'claim-negative', hypothesisId: 'hyp-negative',
        accepted: false, estimate: 0.05,
      }),
    ],
  });
}

export function body(entry) {
  return entry.canonicalManuscriptBody;
}

export function block(entry, text = body(entry)) {
  return [
    `% HEPTA_EMPIRICAL_ASSERTION_BEGIN ${JSON.stringify({
      version: 1,
      assertionId: entry.assertionId,
      authorityEntryHash: entry.empiricalAssertionAuthorityEntryHash,
    })}`,
    text,
    `% HEPTA_EMPIRICAL_ASSERTION_END ${entry.assertionId}`,
  ].join('\n');
}

export function presentationBlock(entry, text = entry.canonicalManuscriptBody) {
  return [
    `% HEPTA_EMPIRICAL_PRESENTATION_BEGIN ${JSON.stringify(empiricalPresentationMarkerDeclaration(entry))}`,
    text,
    `% HEPTA_EMPIRICAL_PRESENTATION_END ${entry.surfaceId}`,
  ].join('\n');
}

export function writePresentationArtifacts(root, trustedAuthority) {
  for (const artifact of empiricalPresentationArtifactContents(trustedAuthority)) {
    const candidate = path.join(root, artifact.path);
    fs.mkdirSync(path.dirname(candidate), { recursive: true });
    fs.writeFileSync(candidate, artifact.content);
  }
}

export function workspace(source) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hepta-empirical-assertion-'));
  fs.writeFileSync(path.join(root, 'main.tex'), source);
  return root;
}

export function readAndBind(root, trustedAuthority = authority()) {
  const universe = readEmpiricalAssertionUniverse({ sourceRoot: root, manuscriptPath: 'main.tex' });
  const binding = bindEmpiricalAssertionUniverse({
    authority: trustedAuthority,
    universe,
    expectedPaperId: trustedAuthority.paperId,
    expectedCampaignId: trustedAuthority.campaignId,
    expectedExperimentRegistryHash: trustedAuthority.experimentRegistryHash,
  });
  return { universe, binding };
}

export function projectedRegistryFixture() {
  const paperId = 'paper-projected';
  const campaignId = 'campaign-projected';
  const experimentRegistryHash = hash('d');
  const analysisProtocolHash = hash('e');
  const empiricalClaimUniverseHash = hash('f');
  const registryExperiments = [];
  const projections = [];
  for (const [suffix, claimId, hypothesisId, accepted, estimate] of [
    ['positive', 'claim-positive', 'hyp-positive', true, 0.5],
    ['negative', 'claim-negative', 'hyp-negative', false, 0.05],
  ]) {
    const originalPayload = {
      ...evaluation(hypothesisId, claimId, accepted, estimate),
      version: 1,
      kind: 'AcademicAnalysisProtocolEvaluation',
      analysisProtocolHash,
      analysisProtocol: {
        empiricalClaimUniverseHash,
        pairedUnit: 'seed',
        metricSpecs: { score: { unit: 'score-points' } },
      },
      blockers: [],
    };
    delete originalPayload.academicAnalysisProtocolEvaluationHash;
    const originalEvaluation = {
      ...originalPayload,
      academicAnalysisProtocolEvaluationHash:
        hashRecord('AcademicAnalysisProtocolEvaluation', originalPayload),
    };
    const replayPayload = structuredClone(originalPayload);
    const replayEvaluation = {
      ...replayPayload,
      academicAnalysisProtocolEvaluationHash:
        hashRecord('AcademicAnalysisProtocolEvaluation', replayPayload),
    };
    const experimentId = `experiment-${suffix}`;
    const originalNodeId = `original-${suffix}`;
    const originalAttemptId = `attempt-original-${suffix}`;
    const replayNodeId = `replay-${suffix}`;
    const replayAttemptId = `attempt-replay-${suffix}`;
    const claimBindings = [{
      claimId,
      hypothesisId,
      manuscriptClaimHash: hash(suffix === 'positive' ? '3' : '4'),
      proposalClaimRecordHash: null,
    }];
    const binding = {
      experimentRunReceiptHash: hash('5'),
      experimentReplayReceiptHash: hash('7'),
      analysisProtocolHash,
      originalAnalysisEvaluationHash: originalEvaluation.academicAnalysisProtocolEvaluationHash,
      replayAnalysisEvaluationHash: replayEvaluation.academicAnalysisProtocolEvaluationHash,
      empiricalClaimUniverseHash,
      empiricalClaimBindings: claimBindings,
      outputArtifacts: [
        {
          name: 'results-json-original', path: 'results.json', hash: hash('a'),
          executionRole: 'original',
          role: expectedCampaignExperimentArtifactRole({
            paperId, campaignId, nodeId: originalNodeId, attemptId: originalAttemptId,
            executionRole: 'original', artifactName: 'results.json',
          }),
        },
        {
          name: 'results-json-independent-replay', path: 'results.json', hash: hash('b'),
          executionRole: 'independent-replay',
          role: expectedCampaignExperimentArtifactRole({
            paperId, campaignId, nodeId: replayNodeId, attemptId: replayAttemptId,
            executionRole: 'independent-replay', artifactName: 'results.json',
          }),
        },
      ],
    };
    registryExperiments.push({
      experimentId,
      status: 'experiment_reproducible',
      academicPromotionEligible: true,
      empiricalClaimBindings: claimBindings,
      evidenceBinding: binding,
    });
    const projectionPayload = {
      version: 1,
      kind: 'EmpiricalAssertionRegistryDerivationExperiment',
      experimentId,
      originalNodeId,
      originalAttemptId,
      replayNodeId,
      replayAttemptId,
      replayRunReceiptHash: hash('6'),
      claimBindings,
      originalEvaluation,
      replayEvaluation,
    };
    projections.push({
      ...projectionPayload,
      empiricalAssertionRegistryDerivationExperimentHash:
        hashRecord('EmpiricalAssertionRegistryDerivationExperiment', projectionPayload),
    });
  }
  const registry = {
    version: 4,
    kind: 'ExperimentRegistry',
    status: 'experiment_registry_ready',
    paperId,
    experimentRegistryHash,
    academicExperimentCount: registryExperiments.length,
    experiments: registryExperiments,
  };
  const derivationPayload = {
    version: 1,
    kind: 'EmpiricalAssertionRegistryDerivationEvidence',
    paperId,
    campaignId,
    experimentRegistryHash,
    experiments: projections,
  };
  const derivationEvidence = {
    ...derivationPayload,
    empiricalAssertionRegistryDerivationEvidenceHash:
      hashRecord('EmpiricalAssertionRegistryDerivationEvidence', derivationPayload),
  };
  const trustedAuthority = buildEmpiricalAssertionAuthorityFromRegistry({
    registry,
    paperId,
    campaignId,
    registryVerified: true,
    derivationEvidence,
  });
  return { paperId, campaignId, registry, derivationEvidence, trustedAuthority };
}
