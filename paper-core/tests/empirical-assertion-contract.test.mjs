import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  bindEmpiricalAssertionUniverse,
  buildEmpiricalAssertionAuthority,
  buildEmpiricalPresentationAuthority,
  empiricalPresentationArtifactContents,
  empiricalPresentationMarkerDeclaration,
} from '../../paper-domain/research/empirical-assertion-contract.mjs';
import { readEmpiricalAssertionUniverse } from '../../paper-adapters/research-verify/empirical-assertion-universe-reader.mjs';
import { readEmpiricalClaimUniverse } from '../../paper-adapters/research-verify/empirical-claim-universe-reader.mjs';
import {
  buildEmpiricalAssertionAuthorityFromRegistry,
  empiricalAssertionAuthorityEntriesMatch,
} from '../../paper-adapters/automation/empirical-assertion-authority.mjs';
import { runManuscriptQualityChecks } from '../../paper-adapters/automation/manuscript-quality-checks.mjs';
import { renderTrustedAutonomousManuscript } from '../../paper-adapters/automation/trusted-autonomous-manuscript-renderer.mjs';
import { empiricalAssertionResearchReportValid } from '../../paper-adapters/build-package/research-evidence-empirical-assertion-binding.mjs';
import { expectedCampaignExperimentArtifactRole } from '../../paper-domain/research/campaign-experiment-claim-lineage.mjs';
import {
  buildDeterministicAutonomousHypothesisDraft,
  createAutonomousHypothesisGenerationReceipt,
  createMachineProposedScientificClaimSet,
  selectDeterministicAutonomousResearchAgenda,
} from '../../paper-domain/automation/autonomous-research-proposal-contract.mjs';
import {
  autonomousFormalSupportMarkerDeclaration,
  autonomousFormalSupportSurfaceBody,
  buildAutonomousFormalSupportSurfaceAuthority,
} from '../../paper-domain/automation/autonomous-formal-support-registry.mjs';
import {
  buildAutonomousResearchSeedContractBundle,
  evaluateAutonomousResearchPolicy,
} from '../../paper-domain/automation/autonomous-research-policy-contract.mjs';
import { renderAutonomousEmpiricalClaimStatement } from '../../paper-domain/automation/autonomous-empirical-claim-lineage-contract.mjs';
import { hashBytes, hashRecord } from '../../workflow-kernel/record-hash.mjs';

const hash = (character) => `sha256:${character.repeat(64)}`;

function evaluation(
  hypothesisId,
  claimId,
  accepted,
  estimate,
  scientificVerdict = accepted ? 'positive' : 'negative',
  scientificUncertaintyReasons = [],
) {
  return Object.freeze({
    status: 'academic_analysis_protocol_verified',
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

function experiment({
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

function authority() {
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

function body(entry) {
  return entry.canonicalManuscriptBody;
}

function block(entry, text = body(entry)) {
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

function presentationBlock(entry, text = entry.canonicalManuscriptBody) {
  return [
    `% HEPTA_EMPIRICAL_PRESENTATION_BEGIN ${JSON.stringify(empiricalPresentationMarkerDeclaration(entry))}`,
    text,
    `% HEPTA_EMPIRICAL_PRESENTATION_END ${entry.surfaceId}`,
  ].join('\n');
}

function writePresentationArtifacts(root, trustedAuthority) {
  for (const artifact of empiricalPresentationArtifactContents(trustedAuthority)) {
    const candidate = path.join(root, artifact.path);
    fs.mkdirSync(path.dirname(candidate), { recursive: true });
    fs.writeFileSync(candidate, artifact.content);
  }
}

function workspace(source) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hepta-empirical-assertion-'));
  fs.writeFileSync(path.join(root, 'main.tex'), source);
  return root;
}

function readAndBind(root, trustedAuthority = authority()) {
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

function projectedRegistryFixture() {
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
      analysisProtocol: { empiricalClaimUniverseHash },
      blockers: [],
    };
    delete originalPayload.academicAnalysisProtocolEvaluationHash;
    const originalEvaluation = {
      ...originalPayload,
      academicAnalysisProtocolEvaluationHash: hashRecord('AcademicAnalysisProtocolEvaluation', originalPayload),
    };
    const replayPayload = structuredClone(originalPayload);
    const replayEvaluation = {
      ...replayPayload,
      academicAnalysisProtocolEvaluationHash: hashRecord('AcademicAnalysisProtocolEvaluation', replayPayload),
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

test('typed empirical assertion happy path binds both positive and negative replay results', () => {
  const trusted = authority();
  const root = workspace(`\\section{Results}\n${trusted.entries.map((entry) => block(entry)).join('\n')}`);
  const { universe, binding } = readAndBind(root, trusted);
  assert.equal(universe.status, 'empirical_assertion_universe_verified', universe.blockers.join('\n'));
  assert.equal(binding.status, 'empirical_assertion_universe_binding_verified');
  assert.equal(binding.bindings.length, 2);
  assert.deepEqual(binding.bindings.map((item) => item.scientificVerdict).sort(), ['negative', 'positive']);
  assert.deepEqual(binding.bindings.map((item) => item.verdict).sort(), ['negative', 'positive']);
  for (const entry of trusted.entries) {
    assert.equal(entry.replay.artifactPath, `automation-results/${entry.replay.artifactPath.split('/')[1]}/results.json`);
  }
});

test('inconclusive scientific verdict and uncertainty reasons remain distinct from a negative result', () => {
  const uncertaintyReasons = ['analysis_independent_unit_count_insufficient'];
  const trusted = buildEmpiricalAssertionAuthority({
    paperId: 'paper-inconclusive',
    campaignId: 'campaign-inconclusive',
    experimentRegistryHash: hash('d'),
    experiments: [experiment({
      suffix: 'inconclusive',
      claimId: 'claim-inconclusive',
      hypothesisId: 'hyp-inconclusive',
      accepted: false,
      estimate: 0.05,
      scientificVerdict: 'inconclusive',
      scientificUncertaintyReasons: uncertaintyReasons,
    })],
  });
  const [entry] = trusted.entries;
  assert.equal(entry.scientificVerdict, 'inconclusive');
  assert.equal(entry.verdict, 'inconclusive');
  assert.deepEqual(entry.original.result.scientificUncertaintyReasons, uncertaintyReasons);
  assert.deepEqual(entry.replay.result.scientificUncertaintyReasons, uncertaintyReasons);
  assert.match(entry.canonicalManuscriptBody, /scientificVerdict inconclusive/);
  assert.match(entry.canonicalManuscriptBody, /registry-bound scientific verdict is inconclusive/);
  assert.ok(entry.canonicalManuscriptBody.includes(Buffer.from(uncertaintyReasons[0]).toString('hex')));
  const negative = authority().entries.find((candidate) => candidate.scientificVerdict === 'negative');
  assert.notEqual(entry.canonicalManuscriptBodyHash, negative.canonicalManuscriptBodyHash);

  const root = workspace(`\\section{Results}\n${block(entry)}`);
  const { universe, binding } = readAndBind(root, trusted);
  assert.equal(universe.status, 'empirical_assertion_universe_verified', universe.blockers.join('\n'));
  assert.equal(binding.status, 'empirical_assertion_universe_binding_verified');
  assert.equal(binding.bindings[0].scientificVerdict, 'inconclusive');
  assert.equal(binding.bindings[0].verdict, 'inconclusive');
});

test('typed tables, figures, and captions bind deterministic bytes to every claim and experiment lineage', () => {
  const trusted = authority();
  const presentationAuthority = buildEmpiricalPresentationAuthority(trusted);
  const root = workspace([
    '\\section{Results}',
    ...trusted.entries.map((entry) => block(entry)),
    ...presentationAuthority.entries.map((entry) => presentationBlock(entry)),
  ].join('\n'));
  writePresentationArtifacts(root, trusted);
  const { universe, binding } = readAndBind(root, trusted);
  assert.equal(universe.status, 'empirical_assertion_universe_verified', universe.blockers.join('\n'));
  assert.equal(binding.status, 'empirical_assertion_universe_binding_verified', binding.blockers.join('\n'));
  assert.equal(binding.empiricalPresentationAuthorityHash,
    presentationAuthority.empiricalPresentationAuthorityHash);
  assert.equal(binding.presentationBindings.length, 2);
  assert.deepEqual(
    binding.presentationBindings.map((item) => item.surfaceKind).sort(),
    ['confirmatory_result_figure', 'confirmatory_result_table'],
  );
  for (const item of binding.presentationBindings) {
    assert.deepEqual(item.claimIds, trusted.entries.map((entry) => entry.claimId));
    assert.deepEqual(item.experimentIds, trusted.entries.map((entry) => entry.experimentId));
    assert.deepEqual(item.authorityEntryHashes,
      trusted.entries.map((entry) => entry.empiricalAssertionAuthorityEntryHash));
  }
  const [artifact] = presentationAuthority.artifacts;
  assert.equal(universe.presentationArtifacts[0].path, artifact.path);
  assert.equal(universe.presentationArtifacts[0].hash, artifact.hash);
  assert.equal(hashBytes(fs.readFileSync(path.join(root, artifact.path))), artifact.hash);
  const source = fs.readFileSync(path.join(root, 'main.tex'), 'utf8');
  assert.match(source, /\\begin\{table\}/);
  assert.match(source, /\\begin\{figure\}/);
  assert.match(source, /\\caption\{Registry-bound/);
});

test('typed presentation rejects self-minted markers, caption edits, omitted surfaces, and artifact substitution', () => {
  const trusted = authority();
  const presentationAuthority = buildEmpiricalPresentationAuthority(trusted);
  const assertionSource = trusted.entries.map((entry) => block(entry)).join('\n');
  const canonicalSource = presentationAuthority.entries.map((entry) => presentationBlock(entry)).join('\n');

  const captionRoot = workspace(`\\section{Results}\n${assertionSource}\n${canonicalSource.replace('Registry-bound confirmatory results', 'Agent-authored favorable results')}`);
  writePresentationArtifacts(captionRoot, trusted);
  const captionBinding = readAndBind(captionRoot, trusted).binding;
  assert.equal(captionBinding.status, 'empirical_assertion_universe_binding_blocked');
  assert.ok(captionBinding.blockers.some((item) => item.startsWith('empirical_presentation_canonical_body_mismatch:')));

  const omittedRoot = workspace(`\\section{Results}\n${assertionSource}\n${presentationBlock(presentationAuthority.entries[0])}`);
  const omittedBinding = readAndBind(omittedRoot, trusted).binding;
  assert.equal(omittedBinding.status, 'empirical_assertion_universe_binding_blocked');
  assert.ok(omittedBinding.blockers.some((item) => item.startsWith('empirical_presentation_authority_entry_unreported:')));

  const forgedDeclaration = {
    version: 1,
    surfaceId: 'agent-forged-table',
    surfaceKind: 'confirmatory_result_table',
    surfaceAuthorityEntryHash: hash('f'),
    artifactPath: null,
    artifactHash: null,
  };
  const forgedRoot = workspace([
    '\\section{Results}',
    assertionSource,
    `% HEPTA_EMPIRICAL_PRESENTATION_BEGIN ${JSON.stringify(forgedDeclaration)}`,
    '\\begin{table}\\caption{Our method wins.}\\end{table}',
    `% HEPTA_EMPIRICAL_PRESENTATION_END ${forgedDeclaration.surfaceId}`,
  ].join('\n'));
  const forged = readAndBind(forgedRoot, trusted);
  assert.equal(forged.universe.status, 'empirical_assertion_universe_verified', forged.universe.blockers.join('\n'));
  assert.equal(forged.binding.status, 'empirical_assertion_universe_binding_blocked');
  assert.ok(forged.binding.blockers.some((item) => item.startsWith('empirical_presentation_authority_reference_invalid:')));

  const artifactRoot = workspace(`\\section{Results}\n${assertionSource}\n${canonicalSource}`);
  writePresentationArtifacts(artifactRoot, trusted);
  const [artifact] = presentationAuthority.artifacts;
  fs.appendFileSync(path.join(artifactRoot, artifact.path), '\nforged');
  const substituted = readAndBind(artifactRoot, trusted);
  assert.equal(substituted.universe.status, 'empirical_assertion_universe_blocked');
  assert.ok(substituted.universe.blockers.some((item) => item.startsWith('empirical_presentation_artifact_hash_mismatch:')));
  assert.equal(substituted.binding.status, 'empirical_assertion_universe_binding_blocked');
});

test('autonomous manuscript accepts only registry-bound claims, canonical assertions, formal surfaces, and fixed neutral prose', () => {
  const trusted = authority();
  const paperId = 'formal-surface-fixture';
  const protocolFamily = 'ml_algorithm_benchmark';
  const objective = 'Evaluate a bounded algorithm under a fixed benchmark';
  const agenda = selectDeterministicAutonomousResearchAgenda({ paperId, objective, protocolFamily });
  const draft = buildDeterministicAutonomousHypothesisDraft({ objective, protocolFamily });
  const generationReceipt = createAutonomousHypothesisGenerationReceipt({ draft });
  const proposal = createMachineProposedScientificClaimSet({
    paperId, objective, protocolFamily, draft, generationReceipt, agendaSelectionReceipt: agenda,
  });
  const policy = evaluateAutonomousResearchPolicy({
    proposal,
    externalDatasetAuthorityVerified: true,
  });
  const seed = buildAutonomousResearchSeedContractBundle({ proposal, policyAuthorization: policy });
  const formalAuthority = buildAutonomousFormalSupportSurfaceAuthority({ proposal, seedBundle: seed });
  const formalDeclaration = autonomousFormalSupportMarkerDeclaration(formalAuthority);
  const declaration = {
    claimId: 'claim-preregistered',
    metric: 'score',
    comparator: 'baseline',
    alternative: 'greater',
    minimumEffect: 0.1,
    acceptanceRequired: true,
    proposalClaimRecordHash: null,
  };
  const claimBlock = [
    `% HEPTA_EMPIRICAL_CLAIM_BEGIN ${JSON.stringify(declaration)}`,
    'The preregistered score exceeds the baseline by at least 0.1.',
    `% HEPTA_EMPIRICAL_CLAIM_END ${declaration.claimId}`,
  ].join('\n');
  const skeleton = [
    '\\documentclass[11pt]{article}',
    '\\usepackage{amsmath,amssymb,amsthm}',
    '\\newtheorem{theorem}{Theorem}',
    '\\title{Autonomous bounded research report}',
    '\\author{}',
    '\\date{}',
    '\\begin{document}',
    '\\maketitle',
    '\\section{Preregistered hypothesis}',
    claimBlock,
    '\\section{Formal source}',
    `% HEPTA_FORMAL_SUPPORT_BEGIN ${JSON.stringify(formalDeclaration)}`,
    autonomousFormalSupportSurfaceBody(formalAuthority),
    `% HEPTA_FORMAL_SUPPORT_END ${formalDeclaration.surfaceId}`,
    '\\section{Limitations}',
    'This report is limited to the registered typed assertions and kernel-verified formal theorem.',
    '\\end{document}',
  ].join('\n');
  const root = workspace(skeleton);
  const trustedClaims = readEmpiricalClaimUniverse({ sourceRoot: root, manuscriptPath: 'main.tex' });
  assert.equal(trustedClaims.status, 'empirical_claim_universe_verified');
  fs.writeFileSync(path.join(root, 'main.tex'), skeleton.replace(
    '\\section{Limitations}',
    `\\section{Results}\n${trusted.entries.map((entry) => block(entry)).join('\n')}\n\\section{Limitations}`,
  ));
  const universe = readEmpiricalAssertionUniverse({
    sourceRoot: root,
    manuscriptPath: 'main.tex',
    trustedEmpiricalClaimUniverse: trustedClaims,
    trustedFormalSupportAuthority: formalAuthority,
  });
  const binding = bindEmpiricalAssertionUniverse({
    authority: trusted,
    universe,
    expectedPaperId: trusted.paperId,
    expectedCampaignId: trusted.campaignId,
    expectedExperimentRegistryHash: trusted.experimentRegistryHash,
  });
  assert.equal(universe.status, 'empirical_assertion_universe_verified', universe.blockers.join('\n'));
  assert.equal(universe.trustedEmpiricalClaimUniverseHash, trustedClaims.empiricalClaimUniverseHash);
  assert.equal(binding.status, 'empirical_assertion_universe_binding_verified');

  fs.writeFileSync(path.join(root, 'main.tex'), fs.readFileSync(path.join(root, 'main.tex'), 'utf8')
    .replace('The preregistered score exceeds', 'A substituted unsupported claim exceeds'));
  const changed = readEmpiricalAssertionUniverse({
    sourceRoot: root,
    manuscriptPath: 'main.tex',
    trustedEmpiricalClaimUniverse: trustedClaims,
    trustedFormalSupportAuthority: formalAuthority,
  });
  assert.equal(changed.status, 'empirical_assertion_universe_blocked');
  assert.ok(changed.blockers.includes('empirical_assertion_trusted_claim_universe_mismatch'));
});

test('system renderer discards agent prose and rebuilds the autonomous manuscript only from bound authorities', () => {
  const paperId = 'paper-system-rendered';
  const campaignId = 'campaign-system-rendered';
  const protocolFamily = 'econometrics_panel_benchmark';
  const objective = 'Evaluate a deterministic bounded estimator';
  const agenda = selectDeterministicAutonomousResearchAgenda({
    paperId, objective, protocolFamily, selectedAt: '2026-07-15T00:00:00.000Z',
  });
  const draft = buildDeterministicAutonomousHypothesisDraft({ objective, protocolFamily });
  const generationReceipt = createAutonomousHypothesisGenerationReceipt({
    draft, generatedAt: '2026-07-15T00:00:01.000Z',
  });
  const proposal = createMachineProposedScientificClaimSet({
    paperId,
    objective,
    protocolFamily,
    draft,
    generationReceipt,
    agendaSelectionReceipt: agenda,
    createdAt: '2026-07-15T00:00:02.000Z',
  });
  const policy = evaluateAutonomousResearchPolicy({
    proposal,
    externalDatasetAuthorityVerified: true,
    evaluatedAt: '2026-07-15T00:00:03.000Z',
  });
  const seed = buildAutonomousResearchSeedContractBundle({
    proposal,
    policyAuthorization: policy,
    createdAt: '2026-07-15T00:00:04.000Z',
  });
  const empiricalSeed = seed.claims.find((claim) => claim.verificationMode === 'empirical_protocol');
  const proposalClaimRecordHash = hashRecord('AutonomousResearchClaimRecord', empiricalSeed);
  const declaration = {
    claimId: 'claim-system-rendered',
    metric: 'score',
    comparator: 'baseline',
    alternative: 'greater',
    minimumEffect: 0.1,
    acceptanceRequired: true,
    proposalClaimRecordHash,
  };
  const root = workspace([
    `% HEPTA_EMPIRICAL_CLAIM_BEGIN ${JSON.stringify(declaration)}`,
    renderAutonomousEmpiricalClaimStatement(empiricalSeed.text),
    `% HEPTA_EMPIRICAL_CLAIM_END ${declaration.claimId}`,
  ].join('\n'));
  const claimUniverse = readEmpiricalClaimUniverse({ sourceRoot: root, manuscriptPath: 'main.tex' });
  const empiricalExperiment = structuredClone(experiment({
    suffix: 'system-rendered',
    claimId: declaration.claimId,
    hypothesisId: 'hypothesis-system-rendered',
    accepted: true,
    estimate: 0.5,
  }));
  empiricalExperiment.claimBindings[0] = {
    claimId: declaration.claimId,
    hypothesisId: 'hypothesis-system-rendered',
    manuscriptClaimHash: claimUniverse.claims[0].manuscriptClaimHash,
    proposalClaimRecordHash,
  };
  const trusted = buildEmpiricalAssertionAuthority({
    paperId,
    campaignId,
    experimentRegistryHash: hash('d'),
    experiments: [empiricalExperiment],
  });
  fs.writeFileSync(path.join(root, 'AUTONOMOUS_RESEARCH_PROPOSAL.json'), JSON.stringify(proposal));
  fs.writeFileSync(path.join(root, 'AUTONOMOUS_RESEARCH_POLICY_AUTHORIZATION.json'), JSON.stringify(policy));
  fs.writeFileSync(path.join(root, 'AUTONOMOUS_RESEARCH_SEED_CONTRACTS.json'), JSON.stringify(seed));
  fs.writeFileSync(path.join(root, 'main.tex'), [
    '\\usepackage{attacker}',
    '\\begin{equation}',
    '\\text{Our method always defeats every baseline.}',
    '\\end{equation}',
  ].join('\n'));
  const receipt = renderTrustedAutonomousManuscript({
    workspace: root,
    manuscriptPath: 'main.tex',
    paperId,
    campaignId,
    authority: trusted,
  });
  assert.equal(receipt.status, 'trusted_autonomous_manuscript_rendered');
  assert.equal(receipt.version, 2);
  assert.equal(receipt.sectionModel, 'trusted-evidence-bound-autonomous-manuscript-v2');
  assert.equal(receipt.unboundScientificProseAccepted, false);
  const rendered = fs.readFileSync(path.join(root, 'main.tex'), 'utf8');
  assert.equal(rendered.includes('attacker'), false);
  assert.equal(rendered.includes('always defeats'), false);
  assert.match(rendered, /HEPTA_EMPIRICAL_ASSERTION_BEGIN/);
  assert.match(rendered, /HEPTA_EMPIRICAL_PRESENTATION_BEGIN/);
  assert.match(rendered, /\\begin\{table\}/);
  assert.match(rendered, /\\begin\{figure\}/);
  assert.match(rendered, /\\caption\{Registry-bound/);
  assert.match(rendered, /human-readable projection of the named obligation/);
  assert.ok(rendered.includes('panel\\_retention\\_accounting'));
  assert.match(rendered, /base-retained-zero/);
  assert.match(rendered, /fresh kernel replay/);
  for (const section of [
    'Research scope', 'Related-work boundary', 'Methods', 'Preregistered claims',
    'Formal assurance', 'Results', 'Discussion', 'Reproducibility and audit trail',
    'Limitations', 'Conclusion',
  ]) assert.ok(rendered.includes(`\\section{${section}}`), section);
  assert.ok(rendered.includes('infer novelty'));
  assert.ok(rendered.includes('No unregistered causal, universal, convergence, or superiority'));
  assert.equal(receipt.presentationArtifacts.length, 1);
  const [presentationArtifact] = receipt.presentationArtifacts;
  assert.equal(hashBytes(fs.readFileSync(path.join(root, presentationArtifact.path))),
    presentationArtifact.hash);

  const external = fs.mkdtempSync(path.join(os.tmpdir(), 'hepta-empirical-presentation-external-'));
  fs.rmSync(path.join(root, 'figures'), { recursive: true, force: true });
  fs.symlinkSync(external, path.join(root, 'figures'), 'dir');
  assert.throws(() => renderTrustedAutonomousManuscript({
    workspace: root,
    manuscriptPath: 'main.tex',
    paperId,
    campaignId,
    authority: trusted,
  }), /trusted_autonomous_manuscript_presentation_artifact_path_invalid/);
  assert.deepEqual(fs.readdirSync(external), []);
});

test('scientific claims cannot be smuggled through title metadata', () => {
  const trusted = authority();
  const root = workspace([
    '\\title{Our method is universally superior}',
    '\\section{Results}',
    ...trusted.entries.map((entry) => block(entry)),
  ].join('\n'));
  const { universe, binding } = readAndBind(root, trusted);
  assert.equal(universe.status, 'empirical_assertion_universe_blocked');
  assert.ok(universe.blockers.some((item) => item.startsWith('empirical_assertion_untyped_result_prose:')));
  assert.equal(binding.status, 'empirical_assertion_universe_binding_blocked');
});

for (const sentence of [
  'Our approach performs better than all controls in practice.',
  'The proposed method consistently wins against the reference system.',
  'These findings establish the practical superiority of our approach.',
]) {
  test(`untyped Results prose fails closed without keyword classification: ${sentence}`, () => {
    const root = workspace(`\\section{Results}\n${sentence}`);
    const universe = readEmpiricalAssertionUniverse({ sourceRoot: root, manuscriptPath: 'main.tex' });
    assert.equal(universe.status, 'empirical_assertion_universe_blocked');
    assert.ok(universe.blockers.some((item) => item.startsWith('empirical_assertion_untyped_result_prose:')));
  });
}

test('self-minted or changed claim, path, value, and verdict authorities never match registry-derived authority', () => {
  const trusted = authority();
  for (const mutate of [
    (entry) => { entry.claimId = 'claim-substituted'; },
    (entry) => { entry.original.artifactPath = 'automation-results/attacker/results.json'; },
    (entry) => { entry.original.result.estimate = 99; },
    (entry) => { entry.verdict = entry.verdict === 'positive' ? 'negative' : 'positive'; },
  ]) {
    const forged = structuredClone(trusted);
    const entryPayload = { ...forged.entries[0] };
    delete entryPayload.empiricalAssertionAuthorityEntryHash;
    mutate(entryPayload);
    forged.entries[0] = {
      ...entryPayload,
      empiricalAssertionAuthorityEntryHash: hashRecord('EmpiricalAssertionAuthorityEntry', entryPayload),
    };
    const authorityPayload = { ...forged };
    delete authorityPayload.empiricalAssertionAuthorityHash;
    forged.empiricalAssertionAuthorityHash = hashRecord('EmpiricalAssertionAuthority', authorityPayload);
    assert.equal(empiricalAssertionAuthorityEntriesMatch(forged, trusted), false);
  }
});

test('capsule validation rebuilds from the registry projection and rejects a fully rehashed entry', () => {
  const fixture = projectedRegistryFixture();
  const root = workspace(`\\section{Results}\n${fixture.trustedAuthority.entries.map((entry) => block(entry)).join('\n')}`);
  const universe = readEmpiricalAssertionUniverse({ sourceRoot: root, manuscriptPath: 'main.tex' });
  const binding = bindEmpiricalAssertionUniverse({
    authority: fixture.trustedAuthority,
    universe,
    expectedPaperId: fixture.paperId,
    expectedCampaignId: fixture.campaignId,
    expectedExperimentRegistryHash: fixture.registry.experimentRegistryHash,
  });
  const report = {
    paperId: fixture.paperId,
    empiricalAssertionAuthorityHash: fixture.trustedAuthority.empiricalAssertionAuthorityHash,
    empiricalAssertionUniverseHash: universe.empiricalAssertionUniverseHash,
    empiricalAssertionUniverseBindingHash: binding.empiricalAssertionUniverseBindingHash,
    empiricalAssertionManuscriptCorpusHash: universe.manuscriptCorpusHash,
    capabilities: {
      experimentRegistry: fixture.registry,
      empiricalAssertionAuthority: fixture.trustedAuthority,
      empiricalAssertionUniverse: universe,
      empiricalAssertionUniverseBinding: binding,
    },
  };
  assert.equal(empiricalAssertionResearchReportValid(report, {
    campaignId: fixture.campaignId,
    registry: fixture.registry,
    derivationEvidence: fixture.derivationEvidence,
  }), true);

  const forgedReport = structuredClone(report);
  const entryPayload = { ...forgedReport.capabilities.empiricalAssertionAuthority.entries[0] };
  delete entryPayload.empiricalAssertionAuthorityEntryHash;
  entryPayload.original.result.estimate = 99;
  const forgedEntry = {
    ...entryPayload,
    empiricalAssertionAuthorityEntryHash: hashRecord('EmpiricalAssertionAuthorityEntry', entryPayload),
  };
  forgedReport.capabilities.empiricalAssertionAuthority.entries[0] = forgedEntry;
  const authorityPayload = { ...forgedReport.capabilities.empiricalAssertionAuthority };
  delete authorityPayload.empiricalAssertionAuthorityHash;
  forgedReport.capabilities.empiricalAssertionAuthority.empiricalAssertionAuthorityHash =
    hashRecord('EmpiricalAssertionAuthority', authorityPayload);
  forgedReport.empiricalAssertionAuthorityHash =
    forgedReport.capabilities.empiricalAssertionAuthority.empiricalAssertionAuthorityHash;
  assert.equal(empiricalAssertionResearchReportValid(forgedReport, {
    campaignId: fixture.campaignId,
    registry: fixture.registry,
    derivationEvidence: fixture.derivationEvidence,
  }), false);
});

test('swapping an assertion id or authority entry hash cannot bind to another claim', () => {
  const trusted = authority();
  const [left, right] = trusted.entries;
  const declaration = {
    version: 1,
    assertionId: left.assertionId,
    authorityEntryHash: right.empiricalAssertionAuthorityEntryHash,
  };
  const root = workspace(`\\section{Results}\n% HEPTA_EMPIRICAL_ASSERTION_BEGIN ${JSON.stringify(declaration)}\n${body(left)}\n% HEPTA_EMPIRICAL_ASSERTION_END ${left.assertionId}\n${block(right)}`);
  const { binding } = readAndBind(root, trusted);
  assert.equal(binding.status, 'empirical_assertion_universe_binding_blocked');
  assert.ok(binding.blockers.some((item) => item.startsWith('empirical_assertion_authority_reference_invalid:')));
});

test('body verdict, numeric value, hypothesis, metric, comparator, and original/replay tampering fails deterministically', () => {
  const trusted = authority();
  const target = trusted.entries.find((entry) => entry.verdict === 'positive');
  const other = trusted.entries.find((entry) => entry !== target);
  const bodies = [
    body(target).replace('scientificVerdict positive', 'scientificVerdict negative'),
    body(target).replace('estimate 0.5', 'estimate 99'),
    body(target).replace(Buffer.from(target.hypothesisId).toString('hex'), Buffer.from('hyp-substituted').toString('hex')),
    body(target).replace(Buffer.from(target.predicate.metric).toString('hex'), Buffer.from('wrong-metric').toString('hex')),
    body(target).replace(target.predicate.comparator, 'ablation'),
    body(target).replace('Isolated deterministic rerun', 'Second execution'),
  ];
  for (const text of bodies) {
    const root = workspace(`\\section{Results}\n${block(target, text)}\n${block(other)}`);
    const { binding } = readAndBind(root, trusted);
    assert.equal(binding.status, 'empirical_assertion_universe_binding_blocked');
  }
});

test('section aliases cannot disable strict typed empirical prose enforcement', () => {
  const trusted = authority();
  for (const title of ['Empirical Results', 'Main Results']) {
    const source = `\\section{${title}}\n${trusted.entries.map((entry) => block(entry)).join('\n')}\nThis establishes universal superiority in every setting.`;
    const root = workspace(source);
    const { universe, binding } = readAndBind(root, trusted);
    assert.equal(universe.status, 'empirical_assertion_universe_blocked');
    assert.ok(universe.blockers.some((item) => item.startsWith('empirical_assertion_untyped_result_prose:')));
    assert.equal(binding.status, 'empirical_assertion_universe_binding_blocked');
  }
});

test('canonical body rejects appended prose and TeX conditional rendering attacks', () => {
  const trusted = authority();
  const [target, other] = trusted.entries;
  for (const text of [
    `${body(target)} This establishes universal superiority in every setting.`,
    `\\iffalse\n${body(target)}\n\\fi\nThis establishes universal superiority in every setting.`,
  ]) {
    const root = workspace(`\\section{Results}\n${block(target, text)}\n${block(other)}`);
    const { binding } = readAndBind(root, trusted);
    assert.equal(binding.status, 'empirical_assertion_universe_binding_blocked');
    assert.ok(binding.blockers.includes(`empirical_assertion_canonical_body_mismatch:${target.assertionId}`));
  }
});

test('body-byte mutation changes the bound corpus and cannot reuse a prior research-report universe', () => {
  const trusted = authority();
  const originalRoot = workspace(`\\section{Results}\n${trusted.entries.map((entry) => block(entry)).join('\n')}`);
  const changedRoot = workspace(`\\section{Results}\n${trusted.entries.map((entry, index) => block(entry, `${body(entry)}${index ? '' : ' Extra bounded wording.'}`)).join('\n')}`);
  const original = readEmpiricalAssertionUniverse({ sourceRoot: originalRoot, manuscriptPath: 'main.tex' });
  const changed = readEmpiricalAssertionUniverse({ sourceRoot: changedRoot, manuscriptPath: 'main.tex' });
  assert.notEqual(changed.manuscriptCorpusHash, original.manuscriptCorpusHash);
  assert.notEqual(changed.empiricalAssertionUniverseHash, original.empiricalAssertionUniverseHash);
});

test('legacy HEPTA_RESULT is rejected by typed parsing and trusted promotion checks', () => {
  const root = workspace('\\section{Results}\n% HEPTA_RESULT CLAIM claim-positive automation-results/x/results.json#score=0.5\nLegacy prose.');
  const universe = readEmpiricalAssertionUniverse({ sourceRoot: root, manuscriptPath: 'main.tex' });
  assert.ok(universe.blockers.some((item) => item.startsWith('legacy_empirical_result_marker_forbidden:')));
  const receipt = runManuscriptQualityChecks({
    workspacePath: root,
    manuscriptPath: 'main.tex',
    mode: 'artifacts',
    requiresTrustedEmpiricalAuthority: true,
  });
  assert.equal(receipt.passed, false);
  assert.ok(receipt.blockers.includes('legacy_empirical_result_marker_forbidden'));
});

test('result titles, captions, tables, and figures remain fail-closed surfaces', () => {
  for (const surface of [
    '\\subsection{A favorable result}',
    '\\caption{A result}',
    '\\begin{table}',
    '\\begin{figure}',
  ]) {
    const root = workspace(`\\section{Results}\n${surface}`);
    const universe = readEmpiricalAssertionUniverse({ sourceRoot: root, manuscriptPath: 'main.tex' });
    assert.ok(universe.blockers.some((item) => item.startsWith('empirical_assertion_unsupported_result_surface:')));
  }
});

test('equation, bibliography, theorem, proof, package, and local render-support injection fail closed', () => {
  const trusted = authority();
  const canonical = trusted.entries.map((entry) => block(entry)).join('\n');
  for (const injected of [
    '\\begin{equation}\n\\text{Our method always defeats every baseline.}\n\\end{equation}',
    '\\begin{thebibliography}{1}\nOur method always defeats every baseline.\n\\end{thebibliography}',
    '\\begin{theorem}\nOur method always defeats every baseline.\n\\end{theorem}',
    '\\begin{proof}\nOur method always defeats every baseline.\n\\end{proof}',
    '\\usepackage{attacker}',
  ]) {
    const root = workspace(`\\section{Results}\n${canonical}\n${injected}`);
    const { universe, binding } = readAndBind(root, trusted);
    assert.equal(universe.status, 'empirical_assertion_universe_blocked', injected);
    assert.equal(binding.status, 'empirical_assertion_universe_binding_blocked', injected);
  }
  const root = workspace(`\\section{Results}\n${canonical}`);
  fs.writeFileSync(path.join(root, 'amsmath.sty'), '\\ProvidesPackage{amsmath} Our method always wins.');
  const { universe, binding } = readAndBind(root, trusted);
  assert.equal(universe.status, 'empirical_assertion_universe_blocked');
  assert.ok(universe.blockers.some((item) => item.startsWith('empirical_assertion_render_support_file_forbidden:')));
  assert.equal(binding.status, 'empirical_assertion_universe_binding_blocked');
});
