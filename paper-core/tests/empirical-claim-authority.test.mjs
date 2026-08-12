import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { readEmpiricalClaimUniverse, canonicalEmpiricalClaimsFromUniverse } from '../../paper-adapters/research-verify/empirical-claim-universe-reader.mjs';
import { readResearchEvidenceSources } from '../../paper-adapters/research-verify/research-evidence-reader.mjs';
import { buildCampaignAgentInstructions } from '../../paper-application/automation/campaign-agent-policy.mjs';
import {
  analysisProtocolMatchesEmpiricalClaimUniverse,
  empiricalClaimDeclarationsFromAnalysisProtocol,
  verifyAnalysisProtocol,
} from '../../paper-domain/automation/analysis-protocol-contract.mjs';
import {
  buildAnalysisProtocolReplayBinding,
  buildRepositoryAnalysisObservationAuthority,
  evaluateAnalysisProtocol,
  verifyAnalysisProtocolReplayBinding,
} from '../../paper-domain/automation/analysis-protocol-evaluator.mjs';
import { buildCampaignBenchmarkSelector } from '../../paper-domain/automation/campaign-benchmark-selector.mjs';
import { EXPERIMENT_REPLAY_ASSURANCE_SCOPE } from '../../paper-domain/automation/experiment-environment-bom-binding.mjs';
import { buildCampaignModeNodes } from '../../paper-domain/automation/campaign-mode-graph.mjs';
import { assertAcademicEmpiricalExecutionProfileBijection } from '../../paper-domain/automation/campaign-plan.mjs';
import { buildClaimRegistry } from '../../paper-domain/research/claim-registry.mjs';
import { verifyEmpiricalClaimUniverse } from '../../paper-domain/research/empirical-claim-contract.mjs';
import { deriveExperimentRegistrySummary, verifyExperimentRegistry } from '../../paper-domain/research/experiment-registry-verifier.mjs';
import { evaluateManuscriptPromotion } from '../../paper-domain/quality/manuscript-promotion-gate.mjs';
import { hashRecord } from '../../workflow-kernel/record-hash.mjs';
import {
  buildTypedNumericOracleCertificate,
  buildTypedNumericOracleCertificateSet,
} from '../../paper-domain/research/typed-numeric-oracle-certificate.mjs';
import {
  autonomousEmpiricalFamilyPluginProfileFor,
} from '../../paper-domain/automation/autonomous-empirical-family-plugin-registry.mjs';

const FAMILIES = [
  'rl_stochastic_control_benchmark',
  'ml_algorithm_benchmark',
  'econometrics_panel_benchmark',
  'finance_asset_pricing_benchmark',
  'operations_optimization_benchmark',
];

function canonicalObservationAuthority({ observations, protocol, attemptId, run }) {
  const profile = autonomousEmpiricalFamilyPluginProfileFor(protocol.benchmarkFamily);
  const rawEventManifestHash = hashRecord('RawManifestFixture', {});
  const rawEventArtifactHash = hashRecord('RawArtifactFixture', {});
  const rawEventRecomputationManifestHash = hashRecord(
    'RawRecomputationManifestFixture', { attempt: run },
  );
  const sourceLineageHash = hashRecord('SourceLineageFixture', {});
  const producer = hashRecord('EmpiricalClaimTestProducer', { run });
  const verifier = hashRecord('EmpiricalClaimTestVerifier', { run });
  const assurance = hashRecord('EmpiricalClaimTestAssurance', { run });
  const certificates = profile.typedOracleKinds.map((oracleType) => (
    buildTypedNumericOracleCertificate({
      certificateId: `${oracleType}:${run}`,
      oracleType,
      subjectHash: oracleType === 'property-oracle-v1'
        ? rawEventManifestHash : rawEventRecomputationManifestHash,
      quantity: oracleType === 'property-oracle-v1'
        ? 'property_oracle_verified' : 'maximum_absolute_residual',
      observedValue: oracleType === 'property-oracle-v1' ? 1 : 0,
      relation: oracleType === 'property-oracle-v1' ? 'interval' : 'less-than-or-equal',
      lowerBound: oracleType === 'property-oracle-v1' ? 1 : null,
      upperBound: oracleType === 'property-oracle-v1' ? 1 : 0,
      unit: oracleType === 'property-oracle-v1'
        ? 'boolean-indicator' : 'absolute-metric-unit',
      verifierId: `empirical-claim-test-${oracleType}`,
      producerImplementationHash: producer,
      verifierImplementationHash: oracleType === 'property-oracle-v1' ? producer : verifier,
      verificationReceiptHash: assurance,
      evidenceHashes: [assurance],
      assuranceScope: oracleType === 'property-oracle-v1'
        ? 'producer-bound-self-check-v1'
        : 'os-sandboxed-process-independent-implementation-v1',
    })
  ));
  const typedNumericOracleCertificateSet = buildTypedNumericOracleCertificateSet({
    analysisProtocolHash: protocol.analysisProtocolHash,
    experimentAttemptId: attemptId,
    sourceLineageHash,
    requiredOracleTypes: profile.typedOracleKinds,
    certificates,
  });
  return buildRepositoryAnalysisObservationAuthority({
    observations,
    rawEventManifestHash,
    rawEventArtifactHash,
    rawEventRecomputationManifestHash,
    independentResidualRecomputationVerified: true,
    independentRecomputationAssuranceHash: assurance,
    independentVerifierImplementationHash: verifier,
    typedNumericOracleCertificateSet,
    experimentAttemptId: attemptId,
    sourceLineageHash,
    analysisProtocol: protocol,
  });
}

function workspace(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hepta-empirical-claim-authority-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

function templateProtocol(selector) {
  return Object.freeze({
    ...selector.experimentDesign.analysisProtocol,
    analysisProtocolHash: selector.experimentDesign.analysisProtocolHash,
  });
}

function markerPair(declaration, text) {
  return `% HEPTA_EMPIRICAL_CLAIM_BEGIN ${JSON.stringify(declaration)}\n${text}\n% HEPTA_EMPIRICAL_CLAIM_END ${declaration.claimId}\n`;
}

function manuscriptFor(selector, texts = []) {
  return empiricalClaimDeclarationsFromAnalysisProtocol(templateProtocol(selector))
    .map((declaration, index) => markerPair(declaration, texts[index] || `Confirmatory hypothesis ${index + 1}.`))
    .join('\n');
}

function boundFixture(t, family = 'ml_algorithm_benchmark') {
  const root = workspace(t);
  const template = buildCampaignBenchmarkSelector({ benchmarkId: family });
  fs.writeFileSync(path.join(root, 'main.tex'), manuscriptFor(template));
  const universe = readEmpiricalClaimUniverse({ sourceRoot: root, manuscriptPath: 'main.tex' });
  const selector = buildCampaignBenchmarkSelector({ benchmarkId: family, empiricalClaimUniverse: universe });
  const protocol = templateProtocol(selector);
  return { root, template, universe, selector, protocol };
}

test('recursive TeX claim corpus keeps stable authority under unrelated edits and changes on claim edits or reorder', (t) => {
  const root = workspace(t);
  const selector = buildCampaignBenchmarkSelector({ benchmarkId: 'ml_algorithm_benchmark' });
  const declarations = empiricalClaimDeclarationsFromAnalysisProtocol(templateProtocol(selector));
  fs.writeFileSync(path.join(root, 'main.tex'), 'Unrelated introduction.\n\\input{claims}\nUnrelated conclusion.\n');
  fs.writeFileSync(path.join(root, 'claims.tex'), declarations.map((item, index) => markerPair(item, `Claim body ${index + 1}.`)).join('\n'));
  const original = readEmpiricalClaimUniverse({ sourceRoot: root, manuscriptPath: 'main.tex' });
  assert.equal(verifyEmpiricalClaimUniverse(original), true);
  assert.equal(original.claims.length, 2);

  fs.writeFileSync(path.join(root, 'main.tex'), 'A completely different unrelated introduction.\n\\input{claims}\nUnrelated conclusion.\n');
  const unrelated = readEmpiricalClaimUniverse({ sourceRoot: root, manuscriptPath: 'main.tex' });
  assert.equal(unrelated.manuscriptCorpusHash, original.manuscriptCorpusHash);
  assert.equal(unrelated.empiricalClaimUniverseHash, original.empiricalClaimUniverseHash);
  assert.deepEqual(unrelated.claims.map((claim) => claim.manuscriptClaimHash), original.claims.map((claim) => claim.manuscriptClaimHash));
  assert.notEqual(unrelated.sourceCorpusHash, original.sourceCorpusHash);
  assert.notEqual(unrelated.empiricalClaimUniverseReceiptHash, original.empiricalClaimUniverseReceiptHash);

  fs.writeFileSync(path.join(root, 'claims.tex'), [
    markerPair(declarations[0], 'Scientifically changed claim body.'),
    markerPair(declarations[1], 'Claim body 2.'),
  ].join('\n'));
  const changed = readEmpiricalClaimUniverse({ sourceRoot: root, manuscriptPath: 'main.tex' });
  assert.notEqual(changed.manuscriptCorpusHash, original.manuscriptCorpusHash);
  assert.notEqual(changed.claims[0].manuscriptClaimHash, original.claims[0].manuscriptClaimHash);

  fs.writeFileSync(path.join(root, 'claims.tex'), [
    markerPair(declarations[1], 'Claim body 2.'),
    markerPair(declarations[0], 'Claim body 1.'),
  ].join('\n'));
  const reordered = readEmpiricalClaimUniverse({ sourceRoot: root, manuscriptPath: 'main.tex' });
  assert.notEqual(reordered.manuscriptCorpusHash, original.manuscriptCorpusHash);
  assert.deepEqual(reordered.claims.map((claim) => claim.claimId), [declarations[1].claimId, declarations[0].claimId]);
});

test('reader fails closed on duplicate, malformed, and dynamic TeX empirical authority', (t) => {
  const root = workspace(t);
  const selector = buildCampaignBenchmarkSelector({ benchmarkId: 'ml_algorithm_benchmark' });
  const [declaration] = empiricalClaimDeclarationsFromAnalysisProtocol(templateProtocol(selector));
  fs.writeFileSync(path.join(root, 'main.tex'), `${markerPair(declaration, 'One.')}\n${markerPair(declaration, 'Two.')}`);
  const duplicate = readEmpiricalClaimUniverse({ sourceRoot: root, manuscriptPath: 'main.tex' });
  assert.equal(duplicate.status, 'empirical_claim_universe_blocked');
  assert.match(duplicate.blockers.join('\n'), /claim_id_duplicate/);

  fs.writeFileSync(path.join(root, 'main.tex'), `% HEPTA_EMPIRICAL_CLAIM_BEGIN not-json\nBody.\n% HEPTA_EMPIRICAL_CLAIM_END ${declaration.claimId}\n`);
  const malformed = readEmpiricalClaimUniverse({ sourceRoot: root, manuscriptPath: 'main.tex' });
  assert.equal(malformed.status, 'empirical_claim_universe_blocked');
  assert.match(malformed.blockers.join('\n'), /marker_malformed|declaration_invalid/);

  fs.writeFileSync(path.join(root, 'main.tex'), `${markerPair(declaration, 'One.')}\n\\csname begin\\endcsname{theorem}Hidden\\csname end\\endcsname{theorem}\n`);
  const dynamic = readEmpiricalClaimUniverse({ sourceRoot: root, manuscriptPath: 'main.tex' });
  assert.equal(dynamic.status, 'empirical_claim_universe_blocked');
  assert.match(dynamic.blockers.join('\n'), /dynamic_tex_unsupported/);
});

test('all five protocol families emit exact writer markers and bind system-owned v2 protocols', (t) => {
  for (const family of FAMILIES) {
    const root = workspace(t);
    const template = buildCampaignBenchmarkSelector({ benchmarkId: family });
    const protocolV1 = templateProtocol(template);
    const declarations = empiricalClaimDeclarationsFromAnalysisProtocol(protocolV1);
    const instructions = buildCampaignAgentInstructions({
      kind: 'writer', manuscript: 'main.tex', benchmarkSelector: template,
    });
    assert.doesNotMatch(instructions, /baseline-or-ablation|greater-or-less|"stable-id"|"declared_metric"/);
    for (const declaration of declarations) {
      assert.match(instructions, new RegExp(`HEPTA_EMPIRICAL_CLAIM_BEGIN ${JSON.stringify(declaration).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));
      assert.match(instructions, new RegExp(`HEPTA_EMPIRICAL_CLAIM_END ${declaration.claimId}`));
    }
    fs.writeFileSync(path.join(root, 'main.tex'), manuscriptFor(template));
    const universe = readEmpiricalClaimUniverse({ sourceRoot: root, manuscriptPath: 'main.tex' });
    const bound = buildCampaignBenchmarkSelector({ benchmarkId: family, empiricalClaimUniverse: universe });
    const protocolV2 = templateProtocol(bound);
    assert.equal(protocolV2.version, 2);
    assert.equal(verifyAnalysisProtocol(protocolV2, {
      benchmarkId: bound.benchmarkId,
      benchmarkFamily: bound.benchmarkFamily,
      requiredMetrics: bound.experimentDesign.requiredMetrics,
      metricSpecs: bound.experimentDesign.metricSpecs,
    }), true);
    assert.equal(analysisProtocolMatchesEmpiricalClaimUniverse(protocolV2, universe), true);
    assert.equal(bound.benchmarkSelectorTemplateHash, template.campaignBenchmarkSelectorHash);
    assert.equal(bound.experimentDesign.analysisProtocolTemplateHash, protocolV1.analysisProtocolHash);
    const v2Instructions = buildCampaignAgentInstructions({
      kind: 'writer', manuscript: 'main.tex', benchmarkSelector: bound,
    });
    assert.match(v2Instructions, /operator-bound v2 protocol does not authorize writing or rewriting empirical claims/i);
    assert.match(v2Instructions, new RegExp(protocolV2.hypotheses[0].manuscriptClaimHash));
    fs.writeFileSync(path.join(root, 'main.tex'), manuscriptFor(template, ['Changed prebound body.', 'Confirmatory hypothesis 2.']));
    const alteredUniverse = readEmpiricalClaimUniverse({ sourceRoot: root, manuscriptPath: 'main.tex' });
    assert.equal(analysisProtocolMatchesEmpiricalClaimUniverse(protocolV2, alteredUniverse), false);
  }
});

test('full campaign writer precedes empirical code and academic plans reject multiple execution profiles', () => {
  const nodes = buildCampaignModeNodes({
    campaignId: 'campaign', mode: 'full-campaign', rounds: 1, reviewers: 2,
    executionProfiles: [{ label: 'python', language: 'python', requiresGpu: false }],
    executionIntent: {}, empiricalRequested: true, applyManuscript: true,
    researchVerificationRequired: true,
  });
  const writer = nodes.find((node) => node.kind === 'writer');
  const coder = nodes.find((node) => node.kind === 'coder');
  const empirical = nodes.find((node) => node.kind === 'empirical');
  assert.deepEqual(coder.dependencies, [writer.nodeId]);
  assert.deepEqual(empirical.dependencies, [coder.nodeId]);
  assert.doesNotThrow(() => assertAcademicEmpiricalExecutionProfileBijection({
    academicEmpiricalSelector: true, executionProfiles: [{ label: 'python' }],
  }));
  assert.throws(() => assertAcademicEmpiricalExecutionProfileBijection({
    academicEmpiricalSelector: true, executionProfiles: [{ label: 'python' }, { label: 'r' }],
  }), /campaign_academic_empirical_requires_exactly_one_execution_profile/);
});

function observationsFor(selector) {
  const metrics = selector.experimentDesign.requiredMetrics;
  const specs = selector.experimentDesign.metricSpecs;
  return Array.from({ length: 32 }, (_, index) => index + 1).flatMap((repetition) => (
    ['treatment', 'baseline', 'ablation'].map((arm) => ({
      seed: 17,
      repetition,
      arm,
      metrics: Object.fromEntries(metrics.map((metric) => {
        const maximize = specs[metric].direction === 'maximize';
        const value = arm === 'treatment' ? (maximize ? 0.8 : 0.1) : (maximize ? 0.4 : 0.2);
        return [metric, value + repetition * 1e-6];
      })),
    }))
  ));
}

test('claim-bound v2 protocol survives original and independent replay evaluation', (t) => {
  const { selector, protocol } = boundFixture(t);
  const observations = observationsFor(selector);
  const authority = canonicalObservationAuthority({
    observations, protocol, attemptId: 'attempt-original', run: 'original',
  });
  const inputs = {
    analysisProtocol: protocol,
    observations,
    observationAuthority: authority,
    benchmarkId: selector.benchmarkId,
    benchmarkFamily: selector.benchmarkFamily,
    requiredMetrics: selector.experimentDesign.requiredMetrics,
    metricSpecs: selector.experimentDesign.metricSpecs,
  };
  const original = evaluateAnalysisProtocol(inputs);
  const replayAuthority = canonicalObservationAuthority({
    observations,
    protocol,
    attemptId: 'attempt-independent-replay',
    run: 'independent-replay',
  });
  const replay = evaluateAnalysisProtocol({ ...inputs, observationAuthority: replayAuthority });
  assert.equal(original.status, 'academic_analysis_protocol_verified');
  assert.equal(original.analysisObservationAuthorityHash, authority.analysisObservationAuthorityHash);
  assert.equal(replay.analysisObservationAuthorityHash, replayAuthority.analysisObservationAuthorityHash);
  assert.notEqual(original.analysisObservationAuthorityHash, replay.analysisObservationAuthorityHash);
  assert.equal(replay.analysisProtocolHash, protocol.analysisProtocolHash);
  const binding = buildAnalysisProtocolReplayBinding({ originalEvaluation: original, replayEvaluation: replay });
  assert.equal(verifyAnalysisProtocolReplayBinding(binding), true);
  assert.equal(binding.analysisProtocolHash, protocol.analysisProtocolHash);
});

function hash(label) {
  return hashRecord('EmpiricalClaimAuthorityTestHash', { label });
}

function academicExperiment(protocol, experimentId = 'experiment-1') {
  const empiricalClaimBindings = protocol.hypotheses.map((hypothesis) => ({
    hypothesisId: hypothesis.hypothesisId,
    claimId: hypothesis.claimId,
    manuscriptClaimHash: hypothesis.manuscriptClaimHash,
    proposalClaimRecordHash: hypothesis.proposalClaimRecordHash,
  }));
  const claimIds = empiricalClaimBindings.map((binding) => binding.claimId);
  const assuranceProfile = 'operator-authorized-hidden-evaluation-v1';
  const assuranceScope = 'operator-authorized-hidden-evaluation-v1';
  const evidenceClass = 'academic-experiment-evidence';
  const promotionScope = 'academic-research-promotion';
  const recomputationIndependenceLevel = 'repository-separate-implementation-same-process-v1';
  const independenceContractPayload = {
    version: 1,
    kind: 'RawEventRecomputationIndependenceContract',
    level: recomputationIndependenceLevel,
    dataSourceIndependent: true,
    fixtureOracleBuilderIndependent: true,
    responseEventEvaluatorIndependent: true,
    eventMetricAggregatorIndependent: true,
    producerEvaluatorImportsAllowed: false,
    processIndependent: false,
    sharedTrustBase: [
      'sha256-record-identity',
      'scoped-cas-artifact-reader',
      'signed-private-fixture-source-resolver',
    ],
  };
  const recomputationIndependenceContractHash = hashRecord(
    'RawEventRecomputationIndependenceContract',
    independenceContractPayload,
  );
  const bindingPayload = {
    version: 8,
    kind: 'CampaignExperimentEvidenceBinding',
    status: 'experiment_evidence_binding_verified',
    experimentId,
    trustedLedgerReceiptsVerified: true,
    rawArtifactSourcesVerified: true,
    rawArtifactLedgerReceiptsVerified: true,
    independentRawEventRecomputationVerified: true,
    primitiveRecomputationVerified: true,
    independentRecomputationImplementationVerified: true,
    recomputationIndependenceLevel,
    rawEventRecomputationIndependenceContractHash: recomputationIndependenceContractHash,
    recomputationProcessIndependent: false,
    originalRawEventRecomputationVerificationHash: hash(`${experimentId}:raw-recomputation-original`),
    replayRawEventRecomputationVerificationHash: hash(`${experimentId}:raw-recomputation-replay`),
    originalRawPrimitiveRecomputationManifestHash: hash(`${experimentId}:primitive-original`),
    replayRawPrimitiveRecomputationManifestHash: hash(`${experimentId}:primitive-replay`),
    originalOperatorDatasetAuthorityVerificationHash: hash(`${experimentId}:dataset-authority`),
    replayOperatorDatasetAuthorityVerificationHash: hash(`${experimentId}:dataset-authority`),
    promotionTcbImplementationHash: hash(`${experimentId}:promotion-tcb`),
    executionAssuranceProfile: assuranceProfile,
    assuranceScope,
    evidenceClass,
    promotionScope,
    academicPromotionEligible: true,
    assuranceProfile: 'system-harness-store-cas-separate-recomputation-plus-trusted-ledger-v6',
    analysisProtocolHash: protocol.analysisProtocolHash,
    originalAnalysisEvaluationHash: hash(`${experimentId}:original-evaluation`),
    replayAnalysisEvaluationHash: hash(`${experimentId}:replay-evaluation`),
    analysisProtocolReplayBindingHash: hash(`${experimentId}:replay-binding`),
    originalEnvironmentBomHash: hash(`${experimentId}:original-bom`),
    replayEnvironmentBomHash: hash(`${experimentId}:replay-bom`),
    replayAssuranceScope: EXPERIMENT_REPLAY_ASSURANCE_SCOPE,
    empiricalClaimUniverseHash: protocol.empiricalClaimUniverseHash,
    manuscriptCorpusHash: protocol.manuscriptCorpusHash,
    claimIds,
    empiricalClaimBindings,
    outputArtifacts: [
      { name: 'raw-events-original', hash: hash(`${experimentId}:raw-original`), artifactWriteReceiptHash: hash(`${experimentId}:write-original`), ledgerReceiptId: `${experimentId}:ledger-original`, bytes: 10, role: `${experimentId}:original` },
      { name: 'raw-events-independent-replay', hash: hash(`${experimentId}:raw-replay`), artifactWriteReceiptHash: hash(`${experimentId}:write-replay`), ledgerReceiptId: `${experimentId}:ledger-replay`, bytes: 10, role: `${experimentId}:independent-replay` },
    ],
    blockers: [],
  };
  const evidenceBinding = {
    ...bindingPayload,
    experimentEvidenceBindingHash: hashRecord('CampaignExperimentEvidenceBinding', bindingPayload),
  };
  const acceptancePayload = {
    version: 1,
    kind: 'ExperimentAcceptancePolicyReport',
    experimentId,
    experimentEvidenceBindingHash: evidenceBinding.experimentEvidenceBindingHash,
    blockers: [],
  };
  return {
    experimentId,
    status: 'experiment_reproducible',
    missing: [],
    assuranceProfile,
    assuranceScope,
    evidenceClass,
    promotionScope,
    academicPromotionEligible: true,
    analysisProtocolHash: protocol.analysisProtocolHash,
    empiricalClaimUniverseHash: protocol.empiricalClaimUniverseHash,
    manuscriptCorpusHash: protocol.manuscriptCorpusHash,
    claimIds,
    empiricalClaimBindings,
    evidenceBinding,
    acceptancePolicy: {
      ...acceptancePayload,
      experimentAcceptancePolicyHash: hashRecord('ExperimentAcceptancePolicyReport', acceptancePayload),
    },
  };
}

function authorityVerifier(experiment) {
  return {
    verified: true,
    status: 'experiment_registry_authority_verified',
    experimentId: experiment.experimentId,
    experimentEvidenceBindingHash: experiment.evidenceBinding.experimentEvidenceBindingHash,
  };
}

function registryFor(universe, experiments, paperId = 'paper-1') {
  const summary = deriveExperimentRegistrySummary(experiments, {
    empiricalClaimUniverse: universe,
    expectedPaperId: paperId,
    expectedCampaignId: 'campaign-1',
    authorityVerifier,
  });
  const payload = {
    version: 4,
    kind: 'ExperimentRegistry',
    paperId,
    experiments,
    ...summary,
    empiricalClaimUniverse: universe,
  };
  return { ...payload, experimentRegistryHash: hashRecord('ExperimentRegistry', payload) };
}

test('registry and promotion require exact manuscript claim to experiment coverage with no duplicates', (t) => {
  const { universe, protocol } = boundFixture(t);
  const experiment = academicExperiment(protocol);
  const registry = registryFor(universe, [experiment]);
  const verified = verifyExperimentRegistry(registry, {
    expectedPaperId: 'paper-1', expectedCampaignId: 'campaign-1', authorityVerifier,
    empiricalClaimUniverse: universe,
  });
  assert.equal(verified.valid, true);
  assert.deepEqual(registry.academicPromotionClaimIds, universe.claims.map((claim) => claim.claimId).sort());

  const duplicated = registryFor(universe, [experiment, academicExperiment(protocol, 'experiment-2')]);
  assert.equal(duplicated.status, 'experiment_registry_blocked');
  assert.match(duplicated.empiricalClaimBijectionBlockers.join('\n'), /not_bijective/);

  const canonicalClaims = canonicalEmpiricalClaimsFromUniverse(universe);
  const claimRegistry = buildClaimRegistry({ paperTask: { paperId: 'paper-1' }, claims: canonicalClaims });
  const positive = evaluateManuscriptPromotion({
    paperTask: { paperId: 'paper-1' }, profiles: ['empirical_or_experiment'],
    requirePaperQuality: false, researchReport: { capabilities: { claimRegistry, experimentRegistry: registry } },
    experimentRegistryAuthorityVerifier: authorityVerifier, expectedCampaignId: 'campaign-1',
  });
  assert.doesNotMatch(positive.blockers.join('\n'), /empirical_claim_experiment_bijection_invalid/);

  const forgedClaimRegistry = {
    ...claimRegistry,
    claims: [...claimRegistry.claims, { ...claimRegistry.claims[0], claimId: 'agent-forged-claim' }],
  };
  const blocked = evaluateManuscriptPromotion({
    paperTask: { paperId: 'paper-1' }, profiles: ['empirical_or_experiment'],
    requirePaperQuality: false, researchReport: { capabilities: { claimRegistry: forgedClaimRegistry, experimentRegistry: registry } },
    experimentRegistryAuthorityVerifier: authorityVerifier, expectedCampaignId: 'campaign-1',
  });
  assert.match(blocked.blockers.join('\n'), /empirical_claim_experiment_bijection_invalid/);
});

test('academic registry fails closed when recomputation implementation independence is absent or downgraded', (t) => {
  const { universe, protocol } = boundFixture(t);
  const original = academicExperiment(protocol);
  for (const mutate of [
    (binding) => { binding.independentRecomputationImplementationVerified = false; },
    (binding) => { binding.recomputationIndependenceLevel = 'shared-producer-evaluator-v1'; },
    (binding) => { binding.rawEventRecomputationIndependenceContractHash = null; },
    (binding) => { binding.recomputationProcessIndependent = true; },
  ]) {
    const experiment = structuredClone(original);
    const binding = experiment.evidenceBinding;
    delete binding.experimentEvidenceBindingHash;
    mutate(binding);
    binding.experimentEvidenceBindingHash = hashRecord('CampaignExperimentEvidenceBinding', binding);
    const acceptance = experiment.acceptancePolicy;
    delete acceptance.experimentAcceptancePolicyHash;
    acceptance.experimentEvidenceBindingHash = binding.experimentEvidenceBindingHash;
    acceptance.experimentAcceptancePolicyHash = hashRecord('ExperimentAcceptancePolicyReport', acceptance);
    const registry = registryFor(universe, [experiment]);
    assert.equal(registry.status, 'experiment_registry_blocked');
    assert.equal(registry.academicExperimentCount, 0);
    assert.deepEqual(registry.academicPromotionEligibleExperimentIds, []);
  }
});

test('agent-authored JSON claims cannot enter the canonical empirical claim registry', async (t) => {
  const root = workspace(t);
  const sourceRoot = path.join(root, 'source');
  const logRoot = path.join(root, 'logs');
  const empiricalRoot = path.join(root, 'empirical');
  fs.mkdirSync(sourceRoot, { recursive: true });
  fs.mkdirSync(logRoot, { recursive: true });
  fs.mkdirSync(empiricalRoot, { recursive: true });
  const selector = buildCampaignBenchmarkSelector({ benchmarkId: 'ml_algorithm_benchmark' });
  fs.writeFileSync(path.join(sourceRoot, 'main.tex'), manuscriptFor(selector));
  fs.writeFileSync(path.join(sourceRoot, 'agent-claims.json'), JSON.stringify({
    claims: [{ id: 'agent-forged-claim', kind: 'empirical_claim', text: 'Unsupported agent authority.' }],
  }));
  const read = await readResearchEvidenceSources({
    root,
    sourceRoot,
    logRoot,
    empiricalRoot,
    paperTask: {
      paperId: 'paper-1', sourceWorkspace: 'source', mainTex: 'source/main.tex',
      paperQualityProfiles: ['empirical_or_experiment'],
    },
  });
  assert.equal(read.structured.canonicalEmpiricalClaimRegistry.status, 'canonical_empirical_claim_registry_verified');
  assert.equal(read.structured.claims.some((claim) => claim.id === 'agent-forged-claim'), false);
  assert.deepEqual(
    read.structured.claims.map((claim) => claim.id),
    read.structured.canonicalEmpiricalClaimRegistry.claims.map((claim) => claim.id),
  );
});
