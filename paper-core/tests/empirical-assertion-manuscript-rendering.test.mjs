import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  bindEmpiricalAssertionUniverse,
  buildEmpiricalAssertionAuthority,
} from '../../paper-domain/research/empirical-assertion-contract.mjs';
import {
  readEmpiricalAssertionUniverse,
} from '../../paper-adapters/research-verify/empirical-assertion-universe-reader.mjs';
import {
  readEmpiricalClaimUniverse,
} from '../../paper-adapters/research-verify/empirical-claim-universe-reader.mjs';
import {
  analysisProtocolTemplateHashFromAuthorityArtifacts,
  empiricalClaimsFromAuthority,
  renderTrustedAutonomousManuscript,
} from '../../paper-adapters/automation/trusted-autonomous-manuscript-renderer.mjs';
import {
  revalidateTrustedAutonomousManuscriptWorkspace,
} from '../../paper-adapters/automation/trusted-autonomous-manuscript-revalidation.mjs';
import {
  buildEmpiricalAssertionAuthorityFromCampaignNodes,
  materializeEmpiricalAssertionAuthority,
} from '../../paper-adapters/automation/empirical-assertion-authority.mjs';
import {
  buildDefaultAutonomousManuscriptIrDraft,
  inspectAutonomousManuscriptSubstantiveAgentProse,
} from '../../paper-adapters/automation/autonomous-manuscript-ir-materialization.mjs';
import {
  verifyTrustedAutonomousManuscriptRenderReceipt,
} from '../../paper-domain/automation/trusted-autonomous-manuscript-render-contract.mjs';
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
import {
  createAutonomousEmpiricalClaimLineage,
  renderAutonomousEmpiricalClaimStatement,
} from '../../paper-domain/automation/autonomous-empirical-claim-lineage-contract.mjs';
import {
  buildEvidenceBoundManuscriptIrDraft,
} from '../../paper-domain/research/evidence-bound-manuscript-ir.mjs';
import {
  buildAgentWorkspacePostimageBinding,
} from '../../paper-domain/evidence/agent-execution-receipt-contract.mjs';
import {
  buildFormalReadableProofExplanationBundle,
} from '../../paper-domain/research/formal-readable-proof-contract.mjs';
import {
  extractLeanReadableProofAudits,
  leanReadableProofAuditSetHash,
} from '../../paper-adapters/research-verify/lean-readable-proof-audit.mjs';
import { buildPriorArtEvidenceReceipt } from '../../paper-domain/research/prior-art-evidence-contract.mjs';
import { hashBytes, hashRecord } from '../../workflow-kernel/record-hash.mjs';
import {
  authority,
  block,
  experiment,
  hash,
  workspace,
} from './support/empirical-assertion-contract-fixture.mjs';
import {
  genericManuscriptReleaseFixture,
} from './support/autonomous-research-generalization-release-fixture.mjs';
import {
  productionExperimentClosureFixture,
} from './support/production-experiment-closure-fixture.mjs';

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
test('trusted manuscript claim rendering preserves the order bound by multi-claim lineage', () => {
  const empiricalClaim = Object.freeze({
    id: 'paper-lineage-order:autonomous_claim:1',
    text: 'The preregistered intervention improves score within the bounded evaluation.',
    scientificClaimKey: 'bounded-score-improvement',
    assumptions: Object.freeze(['The benchmark and seeds are fixed.']),
    quantifiers: Object.freeze(['For every registered confirmatory hypothesis.']),
    negativeBoundaries: Object.freeze(['No open-world superiority is claimed.']),
    empiricalObligations: Object.freeze(['Execute and independently replay the protocol.']),
  });
  const proposalClaimRecordHash = hashRecord('AutonomousResearchClaimRecord', empiricalClaim);
  const manuscriptClaimText = renderAutonomousEmpiricalClaimStatement(empiricalClaim.text);
  const declarations = [{
    claimId: 'claim-source-baseline',
    metric: 'score',
    comparator: 'baseline',
    alternative: 'greater',
    minimumEffect: 0.1,
    acceptanceRequired: true,
    proposalClaimRecordHash,
  }, {
    claimId: 'claim-source-ablation',
    metric: 'score',
    comparator: 'ablation',
    alternative: 'greater',
    minimumEffect: 0.1,
    acceptanceRequired: true,
    proposalClaimRecordHash,
  }];
  const source = declarations.flatMap((declaration) => [
    `% HEPTA_EMPIRICAL_CLAIM_BEGIN ${JSON.stringify(declaration)}`,
    manuscriptClaimText,
    `% HEPTA_EMPIRICAL_CLAIM_END ${declaration.claimId}`,
  ]).join('\n');
  const sourceRoot = workspace(source);
  const sourceUniverse = readEmpiricalClaimUniverse({
    sourceRoot,
    manuscriptPath: 'main.tex',
  });
  assert.equal(sourceUniverse.status, 'empirical_claim_universe_verified');
  const authority = Object.freeze({
    paperId: 'paper-lineage-order',
    entries: Object.freeze([...sourceUniverse.claims].reverse().map((claim) => Object.freeze({
      claimId: claim.claimId,
      manuscriptClaimHash: claim.manuscriptClaimHash,
      empiricalClaimUniverseHash: sourceUniverse.empiricalClaimUniverseHash,
      analysisProtocolHash: hash('3'),
      proposalClaimRecordHash,
      predicate: Object.freeze({
        metric: claim.metric,
        comparator: claim.comparator,
        alternative: claim.alternative,
        minimumEffect: claim.minimumEffect,
        acceptanceRequired: claim.acceptanceRequired,
      }),
    }))),
  });
  assert.deepEqual(
    authority.entries.map((entry) => entry.claimId),
    sourceUniverse.claims.map((claim) => claim.claimId).reverse(),
  );
  const resultArtifactBytes = Buffer.from(JSON.stringify({
    operatorDatasetHarnessAuthority: {
      analysisProtocolHash: hash('3'),
      authority: {
        analysisProtocolHash: hash('3'),
      },
    },
    datasetEvaluationDependencyReceipt: {
      analysisProtocolHash: hash('3'),
    },
  }), 'utf8');
  fs.writeFileSync(path.join(sourceRoot, 'results.json'), resultArtifactBytes);
  const authorityWithArtifacts = {
    ...authority,
    entries: Object.freeze(authority.entries.map((entry) => Object.freeze({
      ...entry,
      original: Object.freeze({
        artifactPath: 'results.json',
        artifactHash: hashBytes(resultArtifactBytes),
      }),
    }))),
  };
  assert.equal(
    analysisProtocolTemplateHashFromAuthorityArtifacts(sourceRoot, authorityWithArtifacts),
    hash('3'),
  );
  assert.throws(() => analysisProtocolTemplateHashFromAuthorityArtifacts(
    sourceRoot,
    { entries: [{ original: {} }] },
  ), /trusted_autonomous_manuscript_analysis_protocol_template_authority_invalid/);
  const malformedArtifactBytes = Buffer.from('{');
  fs.writeFileSync(path.join(sourceRoot, 'results.json'), malformedArtifactBytes);
  assert.throws(() => analysisProtocolTemplateHashFromAuthorityArtifacts(sourceRoot, {
    ...authorityWithArtifacts,
    entries: authorityWithArtifacts.entries.map((entry) => ({
      ...entry,
      original: { ...entry.original, artifactHash: hashBytes(malformedArtifactBytes) },
    })),
  }), /trusted_autonomous_manuscript_analysis_protocol_template_authority_invalid/);
  const emptyArtifactBytes = Buffer.from('{}');
  fs.writeFileSync(path.join(sourceRoot, 'results.json'), emptyArtifactBytes);
  assert.throws(() => analysisProtocolTemplateHashFromAuthorityArtifacts(sourceRoot, {
    ...authorityWithArtifacts,
    entries: authorityWithArtifacts.entries.map((entry) => ({
      ...entry,
      original: { ...entry.original, artifactHash: hashBytes(emptyArtifactBytes) },
    })),
  }), /trusted_autonomous_manuscript_analysis_protocol_template_authority_invalid/);
  assert.throws(
    () => analysisProtocolTemplateHashFromAuthorityArtifacts(
      sourceRoot,
      authorityWithArtifacts,
    ),
    /trusted_autonomous_manuscript_analysis_protocol_template_authority_invalid/,
  );
  fs.writeFileSync(path.join(sourceRoot, 'results.json'), resultArtifactBytes);
  const proposal = Object.freeze({
    paperId: authority.paperId,
    machineProposedScientificClaimSetHash: hash('1'),
  });
  const seedBundle = Object.freeze({
    autonomousResearchSeedContractBundleHash: hash('2'),
  });
  const proposalClaimScope = Object.freeze({
    statement: empiricalClaim.text,
    assumptions: empiricalClaim.assumptions,
    quantifiers: empiricalClaim.quantifiers,
    negativeBoundaries: empiricalClaim.negativeBoundaries,
    evidenceObligations: empiricalClaim.empiricalObligations,
  });
  const protocolHypotheses = Object.freeze(sourceUniverse.claims.map((claim) => Object.freeze({
    claimId: claim.claimId,
    manuscriptClaimHash: claim.manuscriptClaimHash,
    proposalClaimRecordHash: claim.proposalClaimRecordHash,
    metric: claim.metric,
    comparator: claim.comparator,
    alternative: claim.alternative,
    minimumEffect: claim.minimumEffect,
    acceptanceRequired: claim.acceptanceRequired,
  })));
  const lineagePayload = {
    version: 1,
    kind: 'AutonomousEmpiricalClaimLineage',
    status: 'autonomous_empirical_claim_lineage_bound',
    paperId: authority.paperId,
    proposalHash: proposal.machineProposedScientificClaimSetHash,
    seedBundleHash: seedBundle.autonomousResearchSeedContractBundleHash,
    proposalClaimId: empiricalClaim.id,
    scientificClaimKey: empiricalClaim.scientificClaimKey,
    proposalClaimRecordHash,
    proposalClaimScope,
    proposalClaimScopeHash:
      hashRecord('AutonomousEmpiricalProposalClaimScope', proposalClaimScope),
    statementRenderingPolicy: 'deterministic-latex-source-escaping-v1',
    manuscriptClaimText,
    analysisProtocolTemplateHash: hash('3'),
    empiricalClaimUniverseHash: sourceUniverse.empiricalClaimUniverseHash,
    manuscriptCorpusHash: sourceUniverse.manuscriptCorpusHash,
    protocolHypotheses,
  };
  const lineage = Object.freeze({
    ...lineagePayload,
    autonomousEmpiricalClaimLineageHash:
      hashRecord('AutonomousEmpiricalClaimLineage', lineagePayload),
  });
  const context = {
    empiricalClaimLineage: lineage,
    proposal,
    seedBundle,
    manuscriptPath: 'main.tex',
    analysisProtocolTemplateHash: hash('3'),
  };
  for (const field of [
    'manuscriptClaimHash', 'empiricalClaimUniverseHash', 'analysisProtocolHash',
  ]) {
    assert.throws(() => empiricalClaimsFromAuthority({
      ...authority,
      entries: authority.entries.map((entry) => ({ ...entry, [field]: null })),
    }, empiricalClaim, context), /trusted_autonomous_manuscript_proposal_claim_binding_invalid/);
  }
  assert.throws(() => empiricalClaimsFromAuthority(
    { ...authority, entries: [] }, empiricalClaim, context,
  ), /trusted_autonomous_manuscript_claims_missing/);
  const ordered = empiricalClaimsFromAuthority(authority, empiricalClaim, context);
  assert.deepEqual(
    ordered.map((claim) => claim.declaration.claimId),
    sourceUniverse.claims.map((claim) => claim.claimId),
  );
  const renderedRoot = workspace(ordered.flatMap(({ declaration, text }) => [
    `% HEPTA_EMPIRICAL_CLAIM_BEGIN ${JSON.stringify(declaration)}`,
    text,
    `% HEPTA_EMPIRICAL_CLAIM_END ${declaration.claimId}`,
  ]).join('\n'));
  const renderedUniverse = readEmpiricalClaimUniverse({
    sourceRoot: renderedRoot,
    manuscriptPath: 'main.tex',
  });
  assert.equal(renderedUniverse.status, 'empirical_claim_universe_verified');
  assert.equal(renderedUniverse.manuscriptCorpusHash, lineage.manuscriptCorpusHash);
  assert.equal(renderedUniverse.empiricalClaimUniverseHash, lineage.empiricalClaimUniverseHash);
  assert.deepEqual(
    renderedUniverse.claims.map((claim) => claim.manuscriptClaimHash),
    protocolHypotheses.map((claim) => claim.manuscriptClaimHash),
  );
  assert.throws(
    () => empiricalClaimsFromAuthority(authority, empiricalClaim),
    /trusted_autonomous_manuscript_empirical_claim_lineage_required/,
  );
  const extraKeyPayload = { ...lineagePayload, unexpected: true };
  assert.throws(
    () => empiricalClaimsFromAuthority(authority, empiricalClaim, {
      ...context,
      empiricalClaimLineage: {
        ...extraKeyPayload,
        autonomousEmpiricalClaimLineageHash:
          hashRecord('AutonomousEmpiricalClaimLineage', extraKeyPayload),
      },
    }),
    /trusted_autonomous_manuscript_empirical_claim_lineage_invalid/,
  );
  const changedAnalysisProtocolPayload = {
    ...lineagePayload,
    analysisProtocolTemplateHash: hash('4'),
  };
  assert.throws(
    () => empiricalClaimsFromAuthority(authority, empiricalClaim, {
      ...context,
      empiricalClaimLineage: {
        ...changedAnalysisProtocolPayload,
        autonomousEmpiricalClaimLineageHash:
          hashRecord('AutonomousEmpiricalClaimLineage', changedAnalysisProtocolPayload),
      },
    }),
    /trusted_autonomous_manuscript_empirical_claim_lineage_invalid/,
  );
  assert.throws(
    () => empiricalClaimsFromAuthority({
      ...authority,
      entries: Object.freeze([...authority.entries, authority.entries[0]]),
    }, empiricalClaim, context),
    /trusted_autonomous_manuscript_claim_id_duplicate/,
  );
  const reorderedPayload = {
    ...lineagePayload,
    protocolHypotheses: Object.freeze([...protocolHypotheses].reverse()),
  };
  assert.throws(
    () => empiricalClaimsFromAuthority(authority, empiricalClaim, {
      ...context,
      empiricalClaimLineage: {
        ...reorderedPayload,
        autonomousEmpiricalClaimLineageHash:
          hashRecord('AutonomousEmpiricalClaimLineage', reorderedPayload),
      },
    }),
    /trusted_autonomous_manuscript_empirical_claim_lineage_identity_invalid/,
  );
  const reboundRoot = workspace([...declarations].reverse().flatMap((declaration) => [
    `% HEPTA_EMPIRICAL_CLAIM_BEGIN ${JSON.stringify(declaration)}`,
    manuscriptClaimText,
    `% HEPTA_EMPIRICAL_CLAIM_END ${declaration.claimId}`,
  ]).join('\n'));
  const reboundUniverse = readEmpiricalClaimUniverse({
    sourceRoot: reboundRoot,
    manuscriptPath: 'main.tex',
  });
  const reboundPayload = {
    ...lineagePayload,
    empiricalClaimUniverseHash: reboundUniverse.empiricalClaimUniverseHash,
    manuscriptCorpusHash: reboundUniverse.manuscriptCorpusHash,
    protocolHypotheses: Object.freeze(reboundUniverse.claims.map((claim) => Object.freeze({
      claimId: claim.claimId,
      manuscriptClaimHash: claim.manuscriptClaimHash,
      proposalClaimRecordHash: claim.proposalClaimRecordHash,
      metric: claim.metric,
      comparator: claim.comparator,
      alternative: claim.alternative,
      minimumEffect: claim.minimumEffect,
      acceptanceRequired: claim.acceptanceRequired,
    }))),
  };
  assert.throws(
    () => empiricalClaimsFromAuthority(authority, empiricalClaim, {
      ...context,
      empiricalClaimLineage: {
        ...reboundPayload,
        autonomousEmpiricalClaimLineageHash:
          hashRecord('AutonomousEmpiricalClaimLineage', reboundPayload),
      },
    }),
    /trusted_autonomous_manuscript_empirical_claim_lineage_binding_invalid/,
  );
  assert.throws(
    () => empiricalClaimsFromAuthority(authority, empiricalClaim, {
      ...context,
      manuscriptPath: 'appendix.tex',
    }),
    /trusted_autonomous_manuscript_empirical_claim_lineage_identity_invalid/,
  );
});

test('workspace revalidation rejects structurally traversable authority tampering', () => {
  const paperId = 'paper-revalidation-tamper';
  const campaignId = 'campaign-revalidation-tamper';
  const formalVerificationHash = hash('f');
  const proposalClaimRecordHash = hashRecord('FixtureProposalClaim', { paperId });
  const declaration = {
    claimId: 'claim-revalidation-tamper',
    metric: 'score',
    comparator: 'baseline',
    alternative: 'greater',
    minimumEffect: 0.1,
    acceptanceRequired: true,
    proposalClaimRecordHash,
  };
  const root = workspace([
    `% HEPTA_EMPIRICAL_CLAIM_BEGIN ${JSON.stringify(declaration)}`,
    'The bounded score exceeds the registered baseline.',
    `% HEPTA_EMPIRICAL_CLAIM_END ${declaration.claimId}`,
  ].join('\n'));
  fs.mkdirSync(path.join(root, 'automation-results'));
  fs.writeFileSync(
    path.join(root, 'automation-results', 'EMPIRICAL_ASSERTION_AUTHORITY.json'),
    JSON.stringify({ paperId, campaignId, entries: [] }),
  );
  fs.writeFileSync(path.join(root, 'AUTONOMOUS_MANUSCRIPT_IR.json'), JSON.stringify({
    authorityBindings: [
      { kind: 'formal_verification', hash: formalVerificationHash },
      { kind: 'proposal', hash: hash('a') },
    ],
  }));
  const evidenceDocument = {
    evidenceKind: 'tampered-authority',
    evidenceHash: hash('b'),
  };
  fs.writeFileSync(path.join(root, 'AUTONOMOUS_MANUSCRIPT_ENTAILMENT.json'), JSON.stringify({
    sourceEvidenceDocuments: [evidenceDocument, evidenceDocument],
  }));
  fs.writeFileSync(path.join(root, 'AUTONOMOUS_MANUSCRIPT_IR_DRAFT.json'), '{}');
  fs.writeFileSync(path.join(root, 'AUTONOMOUS_PRIOR_ART_EVIDENCE.json'), '{}');

  const resultBoundNode = (nodeId, result) => ({
    campaignId,
    nodeId,
    status: 'completed',
    result,
    resultSha256: hashRecord('PaperCampaignNodeResult', result),
  });
  const campaignNodes = [
    resultBoundNode('empirical-original', {
      experimentRunReceipt: { experimentRunReceiptHash: hash('c') },
    }),
    resultBoundNode('empirical-replay', {
      experimentRunReceipt: { experimentRunReceiptHash: hash('d') },
      experimentReplayReceipt: { originalExperimentRunReceiptHash: hash('c') },
    }),
    resultBoundNode('formal-verification', {
      campaignFormalVerificationReceiptHash: formalVerificationHash,
    }),
  ];
  const receipt = revalidateTrustedAutonomousManuscriptWorkspace({
    workspacePath: root,
    manuscriptPath: 'main.tex',
    paperId,
    campaignId,
    campaignNodes,
    trustedAutonomousManuscriptRenderReceipt: {
      manuscriptIrPath: 'AUTONOMOUS_MANUSCRIPT_IR.json',
      evidenceEntailmentContractPath: 'AUTONOMOUS_MANUSCRIPT_ENTAILMENT.json',
      agentAuthoredSourceDraft: {},
      requireAgentAuthoredProse: true,
      systemSeedManuscriptIrDraft: {},
      presentationArtifacts: [{
        path: 'figures/tampered.json',
        hash: hash('e'),
        bytes: 1,
      }],
    },
  });

  assert.equal(receipt.passed, false);
  assert.ok(receipt.blockers.includes(
    'trusted_autonomous_manuscript_revalidation_campaign_authority_invalid',
  ));
  assert.ok(receipt.blockers.includes(
    'trusted_autonomous_manuscript_revalidation_materialized_authority_mismatch',
  ));
  assert.ok(receipt.blockers.includes(
    'trusted_autonomous_manuscript_revalidation_workspace_authority_invalid',
  ));
  assert.ok(receipt.blockers.includes(
    'trusted_autonomous_manuscript_revalidation_source_evidence_document_invalid',
  ));
  assert.ok(receipt.blockers.includes(
    'trusted_autonomous_manuscript_revalidation_presentation_artifact_mismatch',
  ));
  assert.match(
    receipt.trustedAutonomousManuscriptWorkspaceRevalidationReceiptHash,
    /^sha256:[0-9a-f]{64}$/,
  );
  const inaccessible = revalidateTrustedAutonomousManuscriptWorkspace({
    workspacePath: path.join(root, 'nonexistent-workspace'),
    campaignNodes: null,
  });
  assert.equal(inaccessible.passed, false);
  assert.ok(inaccessible.blockers.includes(
    'trusted_autonomous_manuscript_revalidation_workspace_invalid',
  ));
  assert.ok(inaccessible.blockers.includes(
    'trusted_autonomous_manuscript_revalidation_campaign_node_invalid',
  ));
});

test('workspace revalidation verifies a fully authority-bound rendered manuscript', () => {
  const paperId = 'paper-revalidation-verified';
  const campaignId = 'campaign-revalidation-verified';
  const campaignPlanHash = hashRecord('FixtureCampaignPlan', { campaignId });
  const release = genericManuscriptReleaseFixture({
    paperId,
    campaignId,
    campaignPlanHash,
    launchMode: 'production-run',
    externalSubmission: true,
    includeProof: true,
    includeResearchReport: true,
  });
  const proposal = release.preparation.proposal;
  const policyAuthorization = evaluateAutonomousResearchPolicy({
    proposal,
    externalDatasetAuthorityVerified: true,
    evaluatedAt: proposal.createdAt,
  });
  const seedBundle = buildAutonomousResearchSeedContractBundle({
    proposal,
    policyAuthorization,
    createdAt: proposal.createdAt,
  });
  const empiricalClaim = seedBundle.claims.find((claim) => (
    claim.verificationMode === 'empirical_protocol'
  ));
  const manuscriptClaimText = renderAutonomousEmpiricalClaimStatement(empiricalClaim.text);
  const replayNodeId = `${campaignId}:empirical-manuscript-reproduce`;
  const experimentClosure = productionExperimentClosureFixture({
    campaignId,
    paperId,
    campaignPlanHash,
    researchAgendaIr: release.researchAgendaIr,
    researchAgendaProducerReceipt: release.preparation.researchAgendaProducerReceipt,
    proposal,
    researchAgendaClaimBindingReceipt: release.agendaClaimBindingReceipt,
    nodeId: replayNodeId,
    empiricalManuscriptClaimText: manuscriptClaimText,
  });
  const originalNodeId = `${campaignId}:empirical`;
  const originalAttemptId = experimentClosure.originalRunReceipt.experimentAttemptId;
  const replayAttemptId = experimentClosure.replayRunReceipt.experimentAttemptId;
  const resultNode = ({ nodeId, attemptId, dependencies = [], result }) => ({
    campaignId,
    nodeId,
    attemptId,
    roundIndex: 1,
    dependencies,
    status: 'completed',
    result,
    resultSha256: hashRecord('PaperCampaignNodeResult', result),
  });
  const originalResult = {
    experimentRunReceipt: experimentClosure.originalRunReceipt,
  };
  const replayResult = {
    experimentRunReceipt: experimentClosure.replayRunReceipt,
    experimentReplayReceipt: experimentClosure.experimentReplayReceipt,
  };
  const empiricalNodes = [
    resultNode({
      nodeId: originalNodeId,
      attemptId: originalAttemptId,
      result: originalResult,
    }),
    resultNode({
      nodeId: replayNodeId,
      attemptId: replayAttemptId,
      dependencies: [originalNodeId],
      result: replayResult,
    }),
  ];
  const trustedAuthority = buildEmpiricalAssertionAuthorityFromCampaignNodes({
    paperId,
    campaignId,
    nodes: empiricalNodes,
  });
  const root = workspace('authority-bound manuscript source');
  const claimSource = experimentClosure.originalRunReceipt.analysisProtocol.hypotheses
    .flatMap((hypothesis) => {
      const declaration = {
        claimId: hypothesis.claimId,
        metric: hypothesis.metric,
        comparator: hypothesis.comparator,
        alternative: hypothesis.alternative,
        minimumEffect: hypothesis.minimumEffect,
        acceptanceRequired: hypothesis.acceptanceRequired,
        proposalClaimRecordHash: hypothesis.proposalClaimRecordHash,
      };
      return [
        `% HEPTA_EMPIRICAL_CLAIM_BEGIN ${JSON.stringify(declaration)}`,
        manuscriptClaimText,
        `% HEPTA_EMPIRICAL_CLAIM_END ${declaration.claimId}`,
      ];
    }).join('\n');
  fs.writeFileSync(path.join(root, 'main.tex'), claimSource);
  const claimUniverse = readEmpiricalClaimUniverse({
    sourceRoot: root,
    manuscriptPath: 'main.tex',
  });
  assert.equal(claimUniverse.status, 'empirical_claim_universe_verified');
  const empiricalClaimLineage = createAutonomousEmpiricalClaimLineage({
    proposal,
    seedBundle,
    analysisProtocolTemplate: {
      ...experimentClosure.originalRunReceipt.harnessExecutionReceipt
        .operatorDatasetHarnessAuthority.analysisProtocol,
      analysisProtocolHash: experimentClosure.originalRunReceipt.harnessExecutionReceipt
        .operatorDatasetHarnessAuthority.analysisProtocolHash,
    },
    empiricalClaimUniverse: claimUniverse,
  });
  const dynamicFormalSeed = seedBundle.dynamicFormalClaimSeed;
  const formalClaimId = `${paperId}:formal-claim`;
  const theoremName = dynamicFormalSeed.leanDeclarationName;
  const formalSourceFile = 'Main.lean';
  const formalSourceFileHash = hashRecord('FixtureFormalSourceFile', { paperId });
  const formalExecutionReceiptHash = hashRecord('FixtureFormalExecutionReceipt', { paperId });
  const formalSourceStatementHash = hashRecord('FixtureFormalSourceStatement', { paperId });
  const formalClaimContract = {
    status: 'formal_claim_contract_verified',
    formalClaimContractHash: hashRecord('FixtureFormalClaimContract', { paperId }),
    dynamicFormalClaimAuthority: {
      dynamicFormalClaimSeedHash: dynamicFormalSeed.dynamicFormalClaimSeedHash,
      leanTypeSource: dynamicFormalSeed.leanTypeSource,
    },
  };
  const formalClaimBinding = {
    claimId: formalClaimId,
    theoremName,
    expectedTypeHash: dynamicFormalSeed.leanNormalizedTypeHash,
    sourceFile: formalSourceFile,
    formalClaimContract,
  };
  const formalDeclaration = {
    name: theoremName,
    typeHash: dynamicFormalSeed.leanNormalizedTypeHash,
    normalizedType: dynamicFormalSeed.leanTypeSource,
    sourceStatementHash: formalSourceStatementHash,
    buildVerified: true,
    axioms: [],
    axiomAuditPresent: true,
  };
  const formalProjectFiles = [{
    path: formalSourceFile,
    projectPath: formalSourceFile,
    hash: formalSourceFileHash,
  }];
  const formalProofStdout = [
    `HEPTA_READABLE_PROOF_BEGIN:${theoremName}`,
    `theorem ${theoremName} : ${dynamicFormalSeed.leanTypeSource} := by`,
    '  exact id',
    `HEPTA_READABLE_PROOF_END:${theoremName}`,
  ].join('\n');
  const readableProofAudits = extractLeanReadableProofAudits({
    stdout: formalProofStdout,
    claimBindings: [formalClaimBinding],
    declarations: [formalDeclaration],
    projectFiles: formalProjectFiles,
    executionReceiptHash: formalExecutionReceiptHash,
  });
  const formalCertificatePayload = {
    version: 1,
    kind: 'FormalCertificateBundle',
    status: 'formal_claim_verified',
    projectFiles: formalProjectFiles,
    claimBindings: [formalClaimBinding],
    claimBindingReport: {
      bindings: [{
        claimId: formalClaimId,
        theoremName,
        declarationTypeHash: formalDeclaration.typeHash,
        sourceStatementHash: formalSourceStatementHash,
        axioms: [],
        valid: true,
      }],
    },
    executionReceiptHash: formalExecutionReceiptHash,
    leanReadableProofPrintAudits: readableProofAudits,
    leanReadableProofPrintAuditSetHash: leanReadableProofAuditSetHash(readableProofAudits),
    productionReadableProofReady: true,
  };
  const formalCertificateBundle = {
    ...formalCertificatePayload,
    certificateBundleHash: hashRecord('FormalCertificateBundle', formalCertificatePayload),
  };
  const formalReplayPayload = {
    version: 1,
    kind: 'FormalCertificateReplayReceipt',
    status: 'formal_claim_replay_verified',
    blockers: [],
    originalCertificateBundleHash: formalCertificateBundle.certificateBundleHash,
    rerunCertificateBundleHash: hashRecord('FixtureFormalReplayBundle', { paperId }),
    externalActionPerformed: false,
  };
  const formalReplayReceipt = {
    ...formalReplayPayload,
    formalCertificateReplayReceiptHash:
      hashRecord('FormalCertificateReplayReceipt', formalReplayPayload),
  };
  const readableProofExplanationBundle = buildFormalReadableProofExplanationBundle({
    certificateBundle: formalCertificateBundle,
    replayReceipt: formalReplayReceipt,
  });
  assert.equal(
    readableProofExplanationBundle.status,
    'formal_readable_proof_explanation_bundle_verified',
  );
  const formalWorkerResult = {
    ...formalCertificateBundle,
    replayReceipt: formalReplayReceipt,
    formalCertificateReplayReceiptHash:
      formalReplayReceipt.formalCertificateReplayReceiptHash,
    readableProofExplanationBundle,
  };
  const formalVerificationPayload = {
    version: 1,
    kind: 'CampaignFormalVerificationReceipt',
    status: 'campaign_formal_verification_completed',
    paperId,
    campaignId,
    nativeResearchWorkerExecution: {
      workerReceipts: [{ workerType: 'formal_verifier_lake', result: formalWorkerResult }],
    },
    blockers: [],
    externalActionPerformed: false,
  };
  const formalVerificationReceipt = {
    ...formalVerificationPayload,
    campaignFormalVerificationReceiptHash: hashRecord(
      'CampaignFormalVerificationReceipt',
      formalVerificationPayload,
    ),
  };
  const formalNode = {
    campaignId,
    nodeId: `${campaignId}:formal-verify`,
    status: 'completed',
    result: formalVerificationReceipt,
    resultSha256: hashRecord('PaperCampaignNodeResult', formalVerificationReceipt),
  };
  for (const [relative, value] of [
    ['AUTONOMOUS_RESEARCH_PROPOSAL.json', proposal],
    ['AUTONOMOUS_RESEARCH_POLICY_AUTHORIZATION.json', policyAuthorization],
    ['AUTONOMOUS_RESEARCH_SEED_CONTRACTS.json', seedBundle],
    ['AUTONOMOUS_PRIOR_ART_EVIDENCE.json', release.priorArtReceipt],
    ['AUTONOMOUS_EMPIRICAL_CLAIM_LINEAGE.json', empiricalClaimLineage],
    ['AUTONOMOUS_RESEARCH_AGENDA_IR.json', release.researchAgendaIr],
    ['AUTONOMOUS_VENUE_PROFILE_SELECTION.json', release.venueProfileSelection],
    ['AUTONOMOUS_VENUE_REQUIREMENT_IR.json', release.venueRequirementIr],
    ['AUTONOMOUS_SUBMISSION_METADATA.json', release.submissionMetadataReceipt],
  ]) fs.writeFileSync(path.join(root, relative), JSON.stringify(value));
  const templateAsset = release.venueProfileSelection.venueTemplateAsset;
  fs.mkdirSync(path.dirname(path.join(root, templateAsset.relativePath)), { recursive: true });
  fs.writeFileSync(
    path.join(root, templateAsset.relativePath),
    Buffer.from(templateAsset.bytesBase64, 'base64'),
  );
  const originalResultArtifact = Buffer.from(
    `${JSON.stringify(
      experimentClosure.originalRunReceipt.harnessExecutionReceipt.resultDocument,
      null,
      2,
    )}\n`,
  );
  assert.equal(
    hashBytes(originalResultArtifact),
    trustedAuthority.entries[0].original.artifactHash,
  );
  const originalResultArtifactPath = path.join(
    root,
    trustedAuthority.entries[0].original.artifactPath,
  );
  fs.mkdirSync(path.dirname(originalResultArtifactPath), { recursive: true });
  fs.writeFileSync(originalResultArtifactPath, originalResultArtifact);
  materializeEmpiricalAssertionAuthority({
    workspace: root,
    paperId,
    campaignId,
    nodes: empiricalNodes,
  });

  const renderInput = {
    workspace: root,
    manuscriptPath: 'main.tex',
    paperId,
    campaignId,
    authority: trustedAuthority,
    formalVerificationReceipt,
  };
  assert.throws(
    () => renderTrustedAutonomousManuscript(renderInput),
    /trusted_autonomous_manuscript_render_verification_failed/,
  );
  for (const relative of [
    'AUTONOMOUS_RESEARCH_AGENDA_IR.json',
    'AUTONOMOUS_VENUE_PROFILE_SELECTION.json',
    'AUTONOMOUS_VENUE_REQUIREMENT_IR.json',
    'AUTONOMOUS_SUBMISSION_METADATA.json',
    templateAsset.relativePath,
  ]) fs.rmSync(path.join(root, relative), { force: true });
  const renderReceipt = renderTrustedAutonomousManuscript(renderInput);
  const revalidation = revalidateTrustedAutonomousManuscriptWorkspace({
    workspacePath: root,
    manuscriptPath: 'main.tex',
    paperId,
    campaignId,
    campaignNodes: [...empiricalNodes, formalNode],
    trustedAutonomousManuscriptRenderReceipt: renderReceipt,
  });

  assert.equal(revalidation.passed, true, revalidation.blockers.join('\n'));
  assert.equal(
    revalidation.status,
    'trusted_autonomous_manuscript_workspace_revalidation_verified',
  );
  assert.equal(revalidation.blockers.length, 0);
  assert.equal(
    revalidation.empiricalAssertionAuthorityHash,
    trustedAuthority.empiricalAssertionAuthorityHash,
  );
});

test('system renderer rebuilds the evidence-bound manuscript only from verified IR authorities', () => {
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
  const priorArtHash = (label) => hashRecord('PriorArtRendererFixture', { label });
  const priorArtReceipt = buildPriorArtEvidenceReceipt({
    paperId,
    agendaSelectionReceiptHash: proposal.agendaSelectionReceiptHash,
    generatorPrincipalId: proposal.generatorPrincipalId,
    queries: [{
      queryId: 'query-system-rendered',
      query: 'auditable autonomous research evidence systems',
      providers: ['openalex-snapshot'],
      executedAt: '2026-07-15T00:00:05.000Z',
      corpusSnapshotHash: priorArtHash('corpus'),
      resultSetHash: priorArtHash('results'),
      retrievalReceiptHash: priorArtHash('retrieval'),
    }],
    works: [{
      workId: 'work-system-rendered',
      title: 'Auditable machine research systems',
      authors: ['Ada Researcher'],
      year: 2025,
      identifiers: {
        doi: '10.0000/system.1',
        arxiv: null,
        openAlex: null,
        url: null,
      },
      queryIds: ['query-system-rendered'],
      sourceSnapshotHash: priorArtHash('source'),
      abstractHash: priorArtHash('abstract'),
    }],
    coverageLimitations: [
      'The finite configured literature snapshot cannot establish open-world completeness.',
    ],
    independentReview: {
      principalId: 'prior-art-reviewer-system-rendered',
      providerAccountIdentityHash: priorArtHash('reviewer-account'),
      trustDomainIdentityHash: priorArtHash('reviewer-domain'),
      reviewReceiptHash: priorArtHash('review'),
      signatureVerificationReceiptHash: priorArtHash('signature-verification'),
      independentFromGenerator: true,
    },
    createdAt: '2026-07-15T00:00:06.000Z',
    mode: 'verified',
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
  fs.writeFileSync(path.join(root, 'AUTONOMOUS_PRIOR_ART_EVIDENCE.json'), JSON.stringify(priorArtReceipt));
  fs.writeFileSync(path.join(root, 'main.tex'), [
    '\\usepackage{attacker}',
    '\\begin{equation}',
    '\\text{Our method always defeats every baseline.}',
    '\\end{equation}',
  ].join('\n'));
  assert.throws(() => renderTrustedAutonomousManuscript({
    workspace: root,
    manuscriptPath: 'main.tex',
    paperId,
    campaignId,
    authority: trusted,
    requireAgentAuthoredProse: true,
    manuscriptProductionMode: 'agent-authored-evidence-bound-ir-v1',
  }), /autonomous_manuscript_ir_substantive_agent_prose_required/);
  const receipt = renderTrustedAutonomousManuscript({
    workspace: root,
    manuscriptPath: 'main.tex',
    paperId,
    campaignId,
    authority: trusted,
  });
  assert.equal(receipt.status, 'trusted_autonomous_manuscript_rendered');
  assert.equal(receipt.version, 6);
  assert.equal(receipt.sectionModel, 'evidence-bound-manuscript-ir-v1');
  assert.equal(receipt.manuscriptProductionMode, 'minimal-report-evidence-bound-ir-v1');
  assert.equal(receipt.requireAgentAuthoredProse, false);
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
    'Abstract', 'Related Work', 'Methods and Preregistered Claims', 'Formal Assurance',
    'Results', 'Reproducibility and Evidence', 'Limitations',
  ]) assert.ok(rendered.includes(`\\section{${section}}`), section);
  assert.ok(rendered.includes('machine-readable prior-art snapshot'));
  assert.ok(rendered.includes('Auditable machine research systems'));
  assert.ok(rendered.includes('10.0000/system.1'));
  assert.ok(rendered.includes('finite configured literature snapshot'));
  assert.ok(rendered.includes('Successful execution does not prove exhaustive novelty'));
  assert.equal(receipt.presentationArtifacts.length, 1);
  const [presentationArtifact] = receipt.presentationArtifacts;
  assert.equal(hashBytes(fs.readFileSync(path.join(root, presentationArtifact.path))),
    presentationArtifact.hash);

  const agentDraft = buildEvidenceBoundManuscriptIrDraft({
    paperId,
    title: 'Agent-authored evidence synthesis',
    sections: [{
      sectionId: 'agent-summary',
      heading: 'Agent Evidence Synthesis',
      blocks: [{
        type: 'prose',
        blockId: 'agent-summary-prose',
        claimClass: 'scope',
        text: 'This model-authored paragraph is admitted only through its verified authority binding and workspace postimage receipt.',
        evidenceRefs: [proposal.machineProposedScientificClaimSetHash],
      }],
    }, {
      sectionId: 'methods',
      heading: 'Bound Methods',
      blocks: [{ type: 'slot', blockId: 'empirical-claims-slot', slot: 'empirical_claims' }],
    }, {
      sectionId: 'formal-proof-supplement',
      heading: 'Formal Proof Supplement',
      blocks: [{ type: 'slot', blockId: 'formal-support-slot', slot: 'formal_support' }],
    }, {
      sectionId: 'results',
      heading: 'Bound Results',
      blocks: [{ type: 'slot', blockId: 'empirical-results-slot', slot: 'empirical_results' }],
    }, {
      sectionId: 'limitations',
      heading: 'Bound Limitations',
      blocks: [{
        type: 'prose',
        blockId: 'agent-limitations',
        claimClass: 'limitation',
        text: 'The bounded evidence does not establish open-world novelty or universal truth.',
        evidenceRefs: [policy.autonomousResearchPolicyAuthorizationHash],
      }],
    }],
  });
  const systemSeedDraft = buildDefaultAutonomousManuscriptIrDraft({
    proposal,
    policyAuthorization: policy,
    seedBundle: seed,
    priorArtReceipt,
  });
  const agentReceiptForDraft = (
    candidate,
    label,
    sourceBytes = Buffer.from(JSON.stringify(candidate), 'utf8'),
  ) => {
    const payload = {
      version: 1,
      kind: 'AgentExecutionReceipt',
      status: 'agent_execution_completed',
      agentId: 'evidence-author',
      resolvedModel: 'evidence-writer-v1',
      promptHash: hashRecord('ManuscriptSubstantiveProsePrompt', { label }),
      changedPaths: ['AUTONOMOUS_MANUSCRIPT_IR_DRAFT.json'],
    };
    return Object.freeze({
      ...payload,
      agentExecutionReceiptHash: hashRecord('AgentExecutionReceipt', payload),
      agentWorkspacePostimageBinding: buildAgentWorkspacePostimageBinding({
        changedPaths: payload.changedPaths,
        files: [{
          path: 'AUTONOMOUS_MANUSCRIPT_IR_DRAFT.json',
          hash: hashBytes(sourceBytes),
        }],
      }),
    });
  };
  const assertSubstantiveProseBlocked = (candidate, label) => {
    const inspection = inspectAutonomousManuscriptSubstantiveAgentProse({
      draft: candidate,
      systemSeedDraft,
    });
    assert.equal(inspection.valid, false, label);
    assert.ok(inspection.blockers.some((blocker) => (
      blocker.startsWith('autonomous_manuscript_ir_system_seed_prose_retained:')
        || blocker === 'autonomous_manuscript_ir_multiple_substantive_agent_sections_required'
    )), `${label}:${inspection.blockers.join(',')}`);
    fs.writeFileSync(path.join(root, 'AUTONOMOUS_MANUSCRIPT_IR_DRAFT.json'),
      JSON.stringify(candidate));
    assert.throws(() => renderTrustedAutonomousManuscript({
      workspace: root,
      manuscriptPath: 'main.tex',
      paperId,
      campaignId,
      authority: trusted,
      agentExecutionReceipt: agentReceiptForDraft(candidate, label),
      requireAgentAuthoredProse: true,
      manuscriptProductionMode: 'agent-authored-evidence-bound-ir-v1',
    }), /autonomous_manuscript_ir_substantive_agent_prose_required/, label);
  };

  const headingOnlyDraft = structuredClone(systemSeedDraft);
  headingOnlyDraft.sections[0].heading = 'Agent Renamed Abstract';
  assertSubstantiveProseBlocked(headingOnlyDraft, 'heading-only metadata change');

  const whitespaceOnlyDraft = structuredClone(systemSeedDraft);
  whitespaceOnlyDraft.sections[0].blocks[0].text = `  ${
    whitespaceOnlyDraft.sections[0].blocks[0].text.replaceAll(' ', '   ')}  `;
  assertSubstantiveProseBlocked(whitespaceOnlyDraft, 'whitespace-only prose change');

  const oneTokenNoiseDraft = structuredClone(systemSeedDraft);
  for (const block of oneTokenNoiseDraft.sections.flatMap((section) => section.blocks)) {
    if (block.type === 'prose' || block.type === 'citation') block.text += ' Updated.';
  }
  assertSubstantiveProseBlocked(oneTokenNoiseDraft, 'one-token noise per default paragraph');

  const retainedDefaultParagraphDraft = structuredClone(agentDraft);
  retainedDefaultParagraphDraft.sections[0].blocks.push({
    ...structuredClone(systemSeedDraft.sections[0].blocks[0]),
    blockId: 'retained-system-seed-paragraph',
  });
  assertSubstantiveProseBlocked(
    retainedDefaultParagraphDraft,
    'default paragraph retained beside custom prose',
  );

  const substantiveInspection = inspectAutonomousManuscriptSubstantiveAgentProse({
    draft: agentDraft,
    systemSeedDraft,
  });
  assert.equal(substantiveInspection.valid, true);
  assert.equal(substantiveInspection.substantivelyRewrittenSectionCount, 2);
  assert.equal(substantiveInspection.claimBoundBlockCount, 2);
  fs.writeFileSync(path.join(root, 'AUTONOMOUS_MANUSCRIPT_IR_DRAFT.json'),
    JSON.stringify(agentDraft));
  const agentExecutionReceipt = agentReceiptForDraft(agentDraft, 'valid-multi-section-prose');
  const agentRenderedReceipt = renderTrustedAutonomousManuscript({
    workspace: root,
    manuscriptPath: 'main.tex',
    paperId,
    campaignId,
    authority: trusted,
    agentExecutionReceipt,
    requireAgentAuthoredProse: true,
    manuscriptProductionMode: 'agent-authored-evidence-bound-ir-v1',
  });
  const agentRendered = fs.readFileSync(path.join(root, 'main.tex'), 'utf8');
  assert.equal(agentRenderedReceipt.agentAuthoredRenderedProseAccepted, true);
  assert.equal(agentRenderedReceipt.requireAgentAuthoredProse, true);
  assert.equal(agentRenderedReceipt.agentAuthoredRenderedProseReceiptHash,
    agentExecutionReceipt.agentExecutionReceiptHash);
  assert.equal(agentRenderedReceipt.substantiveAgentProseVerified, true);
  assert.equal(agentRenderedReceipt.substantiveAgentProseInspectionHash,
    substantiveInspection.autonomousManuscriptSubstantiveAgentProseInspectionHash);
  assert.deepEqual(agentRenderedReceipt.substantiveAgentProseInspection,
    substantiveInspection);
  assert.deepEqual(agentRenderedReceipt.agentAuthoredSourceDraft, agentDraft);
  assert.deepEqual(agentRenderedReceipt.systemSeedManuscriptIrDraft, systemSeedDraft);
  assert.equal(agentRenderedReceipt.systemSeedManuscriptIrDraftHash,
    substantiveInspection.systemSeedDraftHash);
  assert.equal(agentRenderedReceipt.substantivelyRewrittenSectionCount, 2);
  assert.equal(agentRenderedReceipt.substantivelyRewrittenBlockCount, 2);
  assert.equal(verifyTrustedAutonomousManuscriptRenderReceipt(agentRenderedReceipt, {
    paperId,
    campaignId,
    manuscriptPath: 'main.tex',
    agentExecutionReceipt,
    requireAgentAuthored: true,
  }).valid, true);
  const {
    trustedAutonomousManuscriptRenderReceiptHash: _agentModeReceiptHash,
    ...minimalAgentDraftPayload
  } = agentRenderedReceipt;
  const minimalAgentDraftReceipt = Object.freeze({
    ...minimalAgentDraftPayload,
    manuscriptProductionMode: 'minimal-report-evidence-bound-ir-v1',
    requireAgentAuthoredProse: false,
    substantiveAgentProseVerified: false,
    substantiveAgentProseInspection: null,
    substantiveAgentProseInspectionHash: null,
    systemSeedManuscriptIrDraftHash: null,
    substantivelyRewrittenSectionCount: 0,
    substantivelyRewrittenBlockCount: 0,
  });
  const minimalAgentDraftBoundReceipt = Object.freeze({
    ...minimalAgentDraftReceipt,
    trustedAutonomousManuscriptRenderReceiptHash: hashRecord(
      'TrustedAutonomousManuscriptRenderReceipt',
      minimalAgentDraftReceipt,
    ),
  });
  assert.equal(verifyTrustedAutonomousManuscriptRenderReceipt(
    minimalAgentDraftBoundReceipt,
    {
      paperId,
      campaignId,
      manuscriptPath: 'main.tex',
      agentExecutionReceipt,
    },
  ).valid, true);
  assert.equal(verifyTrustedAutonomousManuscriptRenderReceipt(
    minimalAgentDraftBoundReceipt,
    {
      paperId,
      campaignId,
      manuscriptPath: 'main.tex',
      requireAgentAuthored: true,
      agentExecutionReceipt,
    },
  ).valid, false);
  const prettyAgentDraftBytes = Buffer.from(`${JSON.stringify(agentDraft, null, 2)}\n`, 'utf8');
  fs.writeFileSync(
    path.join(root, 'AUTONOMOUS_MANUSCRIPT_IR_DRAFT.json'),
    prettyAgentDraftBytes,
  );
  const prettyAgentReceipt = agentReceiptForDraft(
    agentDraft,
    'valid-pretty-json-prose',
    prettyAgentDraftBytes,
  );
  const prettyAgentRenderedReceipt = renderTrustedAutonomousManuscript({
    workspace: root,
    manuscriptPath: 'main.tex',
    paperId,
    campaignId,
    authority: trusted,
    agentExecutionReceipt: prettyAgentReceipt,
    requireAgentAuthoredProse: true,
    manuscriptProductionMode: 'agent-authored-evidence-bound-ir-v1',
  });
  assert.equal(
    prettyAgentRenderedReceipt.agentAuthoredSourceDraftFileHash,
    hashBytes(prettyAgentDraftBytes),
  );
  assert.equal(
    prettyAgentRenderedReceipt.agentAuthoredSourceDraftHash,
    hashBytes(Buffer.from(JSON.stringify(agentDraft), 'utf8')),
  );
  assert.notEqual(
    prettyAgentRenderedReceipt.agentAuthoredSourceDraftFileHash,
    prettyAgentRenderedReceipt.agentAuthoredSourceDraftHash,
  );
  assert.equal(verifyTrustedAutonomousManuscriptRenderReceipt(
    prettyAgentRenderedReceipt,
    {
      paperId,
      campaignId,
      manuscriptPath: 'main.tex',
      agentExecutionReceipt: prettyAgentReceipt,
      requireAgentAuthored: true,
    },
  ).valid, true);
  const reorderedAgentDraft = {
    sections: agentDraft.sections.map((section) => ({
      blocks: section.blocks.map((block) => {
        if (block.type === 'slot') {
          return { slot: block.slot, blockId: block.blockId, type: block.type };
        }
        if (block.type === 'citation') {
          return {
            workIds: block.workIds,
            evidenceRefs: block.evidenceRefs,
            text: block.text,
            blockId: block.blockId,
            type: block.type,
          };
        }
        return {
          evidenceRefs: block.evidenceRefs,
          text: block.text,
          claimClass: block.claimClass,
          blockId: block.blockId,
          type: block.type,
        };
      }),
      heading: section.heading,
      sectionId: section.sectionId,
    })),
    title: agentDraft.title,
    paperId: agentDraft.paperId,
    kind: agentDraft.kind,
    version: agentDraft.version,
  };
  const reorderedPrettyBytes = Buffer.from(
    `${JSON.stringify(reorderedAgentDraft, null, 2)}\n`,
    'utf8',
  );
  fs.writeFileSync(
    path.join(root, 'AUTONOMOUS_MANUSCRIPT_IR_DRAFT.json'),
    reorderedPrettyBytes,
  );
  const wrongRawBytesReceipt = agentReceiptForDraft(
    reorderedAgentDraft,
    'reordered-compact-bytes-receipt',
  );
  assert.throws(() => renderTrustedAutonomousManuscript({
    workspace: root,
    manuscriptPath: 'main.tex',
    paperId,
    campaignId,
    authority: trusted,
    agentExecutionReceipt: wrongRawBytesReceipt,
    requireAgentAuthoredProse: true,
    manuscriptProductionMode: 'agent-authored-evidence-bound-ir-v1',
  }), /autonomous_manuscript_ir_(?:agent_receipt_required|agent_authorship_required)/);
  const reorderedReceipt = agentReceiptForDraft(
    reorderedAgentDraft,
    'reordered-pretty-json-prose',
    reorderedPrettyBytes,
  );
  const reorderedRenderedReceipt = renderTrustedAutonomousManuscript({
    workspace: root,
    manuscriptPath: 'main.tex',
    paperId,
    campaignId,
    authority: trusted,
    agentExecutionReceipt: reorderedReceipt,
    requireAgentAuthoredProse: true,
    manuscriptProductionMode: 'agent-authored-evidence-bound-ir-v1',
  });
  assert.equal(
    reorderedRenderedReceipt.agentAuthoredSourceDraftHash,
    prettyAgentRenderedReceipt.agentAuthoredSourceDraftHash,
  );
  assert.equal(
    reorderedRenderedReceipt.agentAuthoredSourceDraftFileHash,
    hashBytes(reorderedPrettyBytes),
  );
  assert.equal(verifyTrustedAutonomousManuscriptRenderReceipt(
    reorderedRenderedReceipt,
    {
      paperId,
      campaignId,
      manuscriptPath: 'main.tex',
      agentExecutionReceipt: reorderedReceipt,
      requireAgentAuthored: true,
    },
  ).valid, true);
  const {
    trustedAutonomousManuscriptRenderReceiptHash: _receiptHash,
    ...tamperedCountPayload
  } = structuredClone(agentRenderedReceipt);
  tamperedCountPayload.substantivelyRewrittenBlockCount += 1;
  const tamperedCountReceipt = {
    ...tamperedCountPayload,
    trustedAutonomousManuscriptRenderReceiptHash:
      hashRecord('TrustedAutonomousManuscriptRenderReceipt', tamperedCountPayload),
  };
  assert.equal(verifyTrustedAutonomousManuscriptRenderReceipt(tamperedCountReceipt, {
    agentExecutionReceipt,
    requireAgentAuthored: true,
  }).valid, false);
  assert.match(agentRendered, /Agent Evidence Synthesis/);
  assert.match(agentRendered, /model-authored paragraph is admitted only through/);
  assert.match(agentRendered, /\\appendix\s+\\section\{Formal Proof Supplement\}/);

  const unreceiptedDraft = structuredClone(agentDraft);
  unreceiptedDraft.sections[0].blocks[0].text = 'Unreceipted replacement prose.';
  fs.writeFileSync(path.join(root, 'AUTONOMOUS_MANUSCRIPT_IR_DRAFT.json'),
    JSON.stringify(unreceiptedDraft));
  assert.throws(() => renderTrustedAutonomousManuscript({
    workspace: root,
    manuscriptPath: 'main.tex',
    paperId,
    campaignId,
    authority: trusted,
  }), /autonomous_manuscript_ir_agent_receipt_required/);
  fs.writeFileSync(path.join(root, 'AUTONOMOUS_MANUSCRIPT_IR_DRAFT.json'),
    JSON.stringify(agentDraft));

  const external = fs.mkdtempSync(path.join(os.tmpdir(), 'hepta-empirical-presentation-external-'));
  fs.rmSync(path.join(root, 'figures'), { recursive: true, force: true });
  fs.symlinkSync(external, path.join(root, 'figures'), 'dir');
  assert.throws(() => renderTrustedAutonomousManuscript({
    workspace: root,
    manuscriptPath: 'main.tex',
    paperId,
    campaignId,
    authority: trusted,
    agentExecutionReceipt,
  }), /trusted_autonomous_manuscript_presentation_artifact_path_invalid/);
  assert.deepEqual(fs.readdirSync(external), []);
});
