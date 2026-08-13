import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildAutonomousResearchAgendaProductionReceipt,
  buildAutonomousResearchAgendaProductionRequest,
} from '../../paper-domain/automation/autonomous-research-agenda-production-contract.mjs';
import {
  buildAutonomousResearchCapabilityScopeManifest,
} from '../../paper-domain/automation/autonomous-research-capability-scope-manifest.mjs';
import {
  buildAutonomousResearchExternalCapabilityTrustInspection,
} from '../../paper-domain/automation/autonomous-research-external-capability-trust-contract.mjs';
import {
  createAutonomousSubmissionRequestVerifier,
  verifyAutonomousSubmissionRequest,
} from '../../paper-domain/automation/autonomous-submission-contract.mjs';
import {
  BOUNDED_CAPABILITY_QUALIFICATION_SCOPE,
  PRODUCTION_AGENT_AUTHORED_QUALIFICATION_SCOPE,
  verifyAutonomousResearchReleaseBinding as verifyProductionAutonomousResearchReleaseBinding,
} from '../../paper-domain/automation/autonomous-research-release-binding-contract.mjs';
import {
  inspectAutonomousManuscriptReleaseProof,
} from '../../paper-domain/automation/autonomous-manuscript-release-proof-contract.mjs';
import {
  buildAgentWorkspacePostimageBinding,
} from '../../paper-domain/evidence/agent-execution-receipt-contract.mjs';
import {
  buildEvidenceBoundManuscriptIrDraft,
} from '../../paper-domain/research/evidence-bound-manuscript-ir.mjs';
import {
  inspectAutonomousManuscriptSubstantiveAgentProse,
} from '../../paper-domain/automation/trusted-autonomous-manuscript-render-contract.mjs';
import {
  buildIsolatedAgentMergeReceipt,
  buildIsolatedAgentWorkspaceContentPolicy,
} from '../../paper-domain/evidence/isolated-agent-merge-receipt-contract.mjs';
import {
  buildAutonomousSubmissionPortalConfiguration,
  createHttpAutonomousSubmissionPortalAdapter,
} from '../../paper-adapters/automation/http-autonomous-submission-portal-adapter.mjs';
import {
  createAutonomousSubmissionDispatchAuthority,
} from '../../paper-composition/automation/autonomous-submission-dispatch-authority-composition.mjs';
import { hashBytes, hashRecord } from '../../workflow-kernel/record-hash.mjs';
import {
  genericManuscriptReleaseFixture,
  productionAgentAuthorityBindingFixture,
  productionReviewerEvidenceFixture,
  productionPriorArtAuthorityFixture,
  productionContentLineageFixture,
  productionSubmissionAuthoritiesFixture,
} from './support/autonomous-research-generalization-fixture.mjs';
import {
  importAutonomousResearchReleaseBindingForTest,
} from './support/production-experiment-closure-test-seam.mjs';

const {
  createAutonomousResearchReleaseBinding,
  verifyAutonomousResearchReleaseBinding,
} = await importAutonomousResearchReleaseBindingForTest();

const HASH = (value) => hashBytes(Buffer.from(String(value), 'utf8'));
const PAPER_ID = 'paper-release-proof';
const CAMPAIGN_ID = 'campaign-release-proof';
const FAMILY = 'ml_algorithm_benchmark';
let cachedCanonicalProductionRelease = null;

function agentReceipt(executorId, changedPaths, productionAuthorityBinding = null) {
  const payload = {
    status: 'agent_execution_completed',
    executorId,
    agentId: 'research-author',
    providerMode: 'configured-agent-provider',
    resolvedModel: 'pinned-research-model',
    promptHash: HASH('prompt'),
    changedPaths: Object.freeze([...changedPaths].sort()),
    ...(productionAuthorityBinding ? {
      codexResearchAuthorCapabilityReceiptHash:
        productionAuthorityBinding.authorCapabilityReceiptHash,
      codexCredentialRootIdentityHash:
        productionAuthorityBinding.authorCredentialRootIdentityHash,
      codexCredentialConfigIdentityHash:
        productionAuthorityBinding.authorCredentialConfigIdentityHash,
    } : {}),
  };
  return Object.freeze({
    ...payload,
    agentExecutionReceiptHash: hashRecord('AgentExecutionReceipt', payload),
  });
}

function manuscriptDraft({ systemSeed = false } = {}) {
  const evidenceHash = HASH('release-proof-evidence');
  return buildEvidenceBoundManuscriptIrDraft({
    paperId: PAPER_ID,
    title: systemSeed
      ? 'System-seeded bounded research report'
      : 'Agent-authored bounded result',
    sections: [{
      sectionId: 'abstract',
      heading: 'Abstract',
      blocks: [{
        type: 'prose',
        blockId: 'abstract-scope',
        claimClass: 'scope',
        text: systemSeed
          ? 'The system seed summarizes a configured protocol without autonomous scientific interpretation.'
          : 'The agent synthesizes the bounded evidence into a distinct and auditable scientific interpretation.',
        evidenceRefs: [evidenceHash],
      }],
    }, {
      sectionId: 'methods',
      heading: 'Methods',
      blocks: [
        { type: 'slot', blockId: 'empirical-claims-slot', slot: 'empirical_claims' },
        { type: 'slot', blockId: 'formal-support-slot', slot: 'formal_support' },
      ],
    }, {
      sectionId: 'results',
      heading: 'Results',
      blocks: [{ type: 'slot', blockId: 'empirical-results-slot', slot: 'empirical_results' }],
    }, {
      sectionId: 'limitations',
      heading: 'Limitations',
      blocks: [{
        type: 'prose',
        blockId: 'open-world-limitation',
        claimClass: 'limitation',
        text: systemSeed
          ? 'The system seed makes no claim beyond the finite configured evidence authorities.'
          : 'The resulting argument remains limited by finite retrieval and cannot establish universal truth.',
        evidenceRefs: [evidenceHash],
      }],
    }],
  });
}

function fixture({
  launchMode = 'production-run',
  includeProof = true,
  draftMode = 'substantive',
} = {}) {
  if (launchMode === 'production-run') {
    const canonical = includeProof
      ? (cachedCanonicalProductionRelease ||= genericManuscriptReleaseFixture({
        paperId: PAPER_ID,
        campaignId: CAMPAIGN_ID,
        campaignPlanHash: HASH('plan'),
        launchMode,
        externalSubmission: true,
        includeProof,
      }))
      : genericManuscriptReleaseFixture({
        paperId: PAPER_ID,
        campaignId: CAMPAIGN_ID,
        campaignPlanHash: HASH('plan'),
        launchMode,
        externalSubmission: true,
        includeProof,
      });
    if (draftMode === 'substantive') {
      return {
        binding: canonical.releaseBinding,
        preparation: canonical.preparation,
      };
    }
    const invalidDraft = draftMode === 'empty'
      ? {
        version: 1,
        kind: 'EvidenceBoundManuscriptIRDraft',
        paperId: PAPER_ID,
        title: 'Agent-authored bounded result',
        sections: [],
      }
      : manuscriptDraft({ systemSeed: true });
    const binding = createAutonomousResearchReleaseBinding({
      campaignId: CAMPAIGN_ID,
      paperId: PAPER_ID,
      campaignPlanHash: HASH('plan'),
      preparation: canonical.preparation,
      manuscriptPath: canonical.releaseBinding.manuscriptPath,
      renderedManuscriptHash: canonical.releaseBinding.renderedManuscriptHash,
      evidenceBoundManuscriptIrHash:
        canonical.releaseBinding.evidenceBoundManuscriptIrHash,
      manuscriptIrFileHash: canonical.releaseBinding.manuscriptIrFileHash,
      agentAuthoredSourceDraft: invalidDraft,
      agentAuthoredSourceDraftFileHash:
        HASH(`file:${JSON.stringify(invalidDraft)}`),
      trustedAutonomousManuscriptResult:
        canonical.trustedAutonomousManuscriptResult,
      refereeConvergenceDecision: canonical.refereeConvergenceDecision,
      reviewerEvidenceAuthority: canonical.reviewerEvidenceAuthority,
      researchReport: canonical.researchReport,
      experimentIrExecutionAuthorityReceipt:
        canonical.experimentIrExecutionAuthorityReceipt,
      experimentReplayReceipt: canonical.experimentReplayReceipt,
    });
    return { binding, preparation: canonical.preparation };
  }
  const objective = 'Produce a bounded machine-authored research argument.';
  const submission = productionSubmissionAuthoritiesFixture({
    paperId: PAPER_ID,
    protocolFamily: FAMILY,
  });
  const systemSeedDraft = manuscriptDraft({ systemSeed: true });
  const sourceDraft = draftMode === 'empty' ? {
    version: 1,
    kind: 'EvidenceBoundManuscriptIRDraft',
    paperId: PAPER_ID,
    title: 'Agent-authored bounded result',
    sections: [],
  } : draftMode === 'default' ? systemSeedDraft : manuscriptDraft();
  const substantiveInspection = inspectAutonomousManuscriptSubstantiveAgentProse({
    draft: sourceDraft,
    systemSeedDraft,
  });
  const sourceDraftHash = HASH(JSON.stringify(sourceDraft));
  const sourceDraftFileHash = HASH(`file:${JSON.stringify(sourceDraft)}`);
  const manuscriptHash = HASH('main.tex');
  const manuscriptIrHash = HASH('ir-object');
  const manuscriptIrFileHash = HASH('ir-file');
  const delegate = agentReceipt('fixture-research-author', [
    'AUTONOMOUS_MANUSCRIPT_IR_DRAFT.json',
  ]);
  const postimage = buildAgentWorkspacePostimageBinding({
    changedPaths: delegate.changedPaths,
    files: [{
      path: 'AUTONOMOUS_MANUSCRIPT_IR_DRAFT.json',
      hash: sourceDraftFileHash,
    }],
  });
  const before = [{ path: 'AUTONOMOUS_MANUSCRIPT_IR_DRAFT.json', hash: HASH('before') }];
  const after = [{
    path: 'AUTONOMOUS_MANUSCRIPT_IR_DRAFT.json',
    hash: sourceDraftFileHash,
  }];
  const merge = buildIsolatedAgentMergeReceipt({
    delegateExecutorId: delegate.executorId,
    delegateAgentExecutionReceipt: delegate,
    changedPaths: delegate.changedPaths,
    agentWorkspacePostimageBinding: postimage,
    sourcePreimage: before,
    isolatedPreimage: before,
    isolatedPostimage: after,
    sourcePostimage: after,
    workspaceContentPolicy: buildIsolatedAgentWorkspaceContentPolicy(),
  });
  const mergedAgentReceipt = Object.freeze({
    ...delegate,
    agentWorkspacePostimageBinding: postimage,
    isolatedAgentMergeReceiptHash: merge.isolatedAgentMergeReceiptHash,
    isolatedAgentMergeReceipt: merge,
  });
  const renderPayload = {
    version: 6,
    kind: 'TrustedAutonomousManuscriptRenderReceipt',
    status: 'trusted_autonomous_manuscript_rendered',
    paperId: PAPER_ID,
    campaignId: CAMPAIGN_ID,
    manuscriptPath: 'main.tex',
    manuscriptHash,
    evidenceBoundManuscriptIrHash: manuscriptIrHash,
    manuscriptIrFileHash,
    manuscriptIrPath: 'AUTONOMOUS_MANUSCRIPT_IR.json',
    sectionModel: 'evidence-bound-manuscript-ir-v1',
    manuscriptProductionMode: 'agent-authored-evidence-bound-ir-v1',
    requireAgentAuthoredProse: true,
    agentAuthoredRenderedProseAccepted: true,
    substantiveAgentProseVerified: true,
    substantivelyRewrittenSectionCount: draftMode === 'substantive'
      ? substantiveInspection.substantivelyRewrittenSectionCount : 2,
    substantivelyRewrittenBlockCount: draftMode === 'substantive'
      ? substantiveInspection.substantivelyRewrittenBlockCount : 2,
    agentAuthoredRenderedProseReceiptHash: delegate.agentExecutionReceiptHash,
    substantiveAgentProseInspectionHash:
      substantiveInspection.autonomousManuscriptSubstantiveAgentProseInspectionHash,
    substantiveAgentProseInspection: substantiveInspection,
    systemSeedManuscriptIrDraft: systemSeedDraft,
    systemSeedManuscriptIrDraftHash: substantiveInspection.systemSeedDraftHash,
    agentAuthoredSourceDraft: sourceDraft,
    agentAuthoredSourceDraftHash: sourceDraftHash,
    agentAuthoredSourceDraftFileHash: sourceDraftFileHash,
    agentWorkspacePostimageBindingHash: postimage.agentWorkspacePostimageBindingHash,
    venueProfileSelectionHash:
      submission.venueProfileSelection.autonomousVenueProfileSelectionReceiptHash,
    submissionMetadataReceiptHash:
      submission.submissionMetadataReceipt.autonomousSubmissionMetadataReceiptHash,
    unboundScientificProseAccepted: false,
    externalActionPerformed: false,
  };
  const renderReceipt = Object.freeze({
    ...renderPayload,
    trustedAutonomousManuscriptRenderReceiptHash:
      hashRecord('TrustedAutonomousManuscriptRenderReceipt', renderPayload),
  });
  const resultPayload = {
    version: 1,
    kind: 'CampaignTrustedAutonomousManuscriptResult',
    status: 'campaign_trusted_autonomous_manuscript_completed',
    agentExecutionReceiptHash: delegate.agentExecutionReceiptHash,
    agentExecutionReceipt: mergedAgentReceipt,
    changedPaths: delegate.changedPaths,
    trustedAutonomousManuscriptRenderReceiptHash:
      renderReceipt.trustedAutonomousManuscriptRenderReceiptHash,
    trustedAutonomousManuscriptRenderReceipt: renderReceipt,
  };
  const result = Object.freeze({
    ...resultPayload,
    campaignTrustedAutonomousManuscriptResultHash:
      hashRecord('CampaignTrustedAutonomousManuscriptResult', resultPayload),
  });
  const proof = includeProof ? Object.freeze({
    nodeId: `${CAMPAIGN_ID}:revise`,
    attemptId: 'attempt:revise:1',
    leaseGeneration: 1,
    resultHash: hashRecord('PaperCampaignNodeResult', result),
    result,
  }) : null;
  const {
    priorArtReceipt,
    authorityBundle: priorArtAuthorityVerificationBundle,
    trustConfiguration: priorArtAuthorityTrustConfiguration,
    externalCapabilityTrustInspection,
  } = productionPriorArtAuthorityFixture({ paperId: PAPER_ID });
  const productionAuthorityBinding = productionAgentAuthorityBindingFixture({
    externalCapabilityTrustInspection,
  });
  const agendaRequest = buildAutonomousResearchAgendaProductionRequest({
    paperId: PAPER_ID,
    allowedProtocolFamilies: [FAMILY],
    productionAuthorityBinding,
    producerContractHash: HASH('agenda-producer-contract'),
  });
  const agendaReceipt = buildAutonomousResearchAgendaProductionReceipt({
    request: agendaRequest,
    selectedObjective: objective,
    selectedProtocolFamily: FAMILY,
    agentExecutionReceipt: agentReceipt(
      'fixture-agenda-author',
      [],
      productionAuthorityBinding,
    ),
    producerId: productionAuthorityBinding.authorPrincipalId,
    generatedAt: '2026-07-19T00:00:00.000Z',
  });
  const capabilityScopeManifest = buildAutonomousResearchCapabilityScopeManifest({
    agendaMode: 'machine-generated',
    manuscriptMode: 'agent-authored-evidence-bound-ir-v1',
    formalClaimClasses: ['dynamic-lean-type-v1'],
    empiricalFamilies: [FAMILY],
    priorArtMode: 'structured-ranked-deduplicated-v2',
    reviewerPrincipalCount: 2,
    reviewerTrustDomainCount: 2,
    replayMode: 'external-trust-domain-v1',
    venueMode: 'submission-enabled-v1',
  });
  const productionContentLineage = productionContentLineageFixture({
    paperId: PAPER_ID,
    protocolFamily: FAMILY,
    capabilityScopeManifest,
    productionAuthorityBinding,
  });
  const preparation = {
    launchMode,
    observedAt: '2026-07-19T00:00:00.000Z',
    proposal: {
      version: 2,
      paperId: PAPER_ID,
      objective,
      protocolFamily: FAMILY,
      formalSupportMode: 'dynamic-lean-type-v1',
      formalSupportRegistryHash: null,
      formalSupportTemplateId: null,
      formalSupportTemplateHash: null,
      dynamicFormalClaimSeed: productionContentLineage.dynamicFormalClaimSeed,
      researchContentProducerReceipt:
        productionContentLineage.researchContentProducerReceipt,
      machineProposedScientificClaimSetHash: HASH('proposal'),
    },
    policyAuthorization: { autonomousResearchPolicyAuthorizationHash: HASH('policy') },
    seedBinding: { autonomousResearchSeedBindingHash: HASH('seed') },
    capabilityScopeManifest,
    researchAgendaProducerReceipt: agendaReceipt,
    dynamicFormalClaimSeed: productionContentLineage.dynamicFormalClaimSeed,
    researchContentProducerReceipt:
      productionContentLineage.researchContentProducerReceipt,
    venueProfileSelection: submission.venueProfileSelection,
    submissionMetadataReceipt: submission.submissionMetadataReceipt,
    externalCapabilityTrustInspection,
    externalCapabilityTrustInspectionHash:
      externalCapabilityTrustInspection
        .autonomousResearchExternalCapabilityTrustInspectionHash,
    priorArtReceipt,
    priorArtAuthorityVerificationBundle,
    priorArtAuthorityVerificationBundleHash:
      priorArtAuthorityVerificationBundle
        .priorArtRetrievalAuthorityVerificationBundleHash,
    priorArtAuthorityTrustConfiguration,
    priorArtAuthorityTrustConfigurationHash:
      priorArtAuthorityTrustConfiguration.priorArtAuthorityTrustConfigurationHash,
    autonomousResearchProviderConfigurationHash:
      productionAuthorityBinding.autonomousResearchProviderConfigurationHash,
    researchPrincipalPoolHash:
      productionAuthorityBinding.runtimePrincipalBinding.researchPrincipalPoolHash,
    runtimePrincipalBinding: productionAuthorityBinding.runtimePrincipalBinding,
    runtimePrincipalBindingHash: productionAuthorityBinding.runtimePrincipalBindingHash,
    productionAuthorityBinding,
    productionAuthorityBindingHash:
      productionAuthorityBinding.autonomousResearchAgentProductionAuthorityBindingHash,
  };
  const binding = createAutonomousResearchReleaseBinding({
    campaignId: CAMPAIGN_ID,
    paperId: PAPER_ID,
    campaignPlanHash: HASH('plan'),
    preparation,
    manuscriptPath: 'main.tex',
    renderedManuscriptHash: manuscriptHash,
    evidenceBoundManuscriptIrHash: manuscriptIrHash,
    manuscriptIrFileHash,
    agentAuthoredSourceDraft: sourceDraft,
    agentAuthoredSourceDraftFileHash: sourceDraftFileHash,
    trustedAutonomousManuscriptResult: proof,
    ...productionReviewerEvidenceFixture({
      campaignId: CAMPAIGN_ID,
      campaignPlanHash: HASH('plan'),
      paperId: PAPER_ID,
      manuscriptHash,
      runtimePrincipalBinding: productionAuthorityBinding.runtimePrincipalBinding,
    }),
  });
  return { binding, preparation };
}

test('production release qualification is inseparable from agent, merge, postimage, and IR proof', () => {
  const { binding } = fixture();
  assert.equal(binding.qualificationScope, PRODUCTION_AGENT_AUTHORED_QUALIFICATION_SCOPE);
  assert.equal(binding.fullResearchQualificationEligible, true);
  assert.equal(binding.genericContentCanaryVerified, true);
  assert.equal(verifyAutonomousResearchReleaseBinding(binding).valid, true);
  const productionVerification = verifyProductionAutonomousResearchReleaseBinding(binding);
  assert.equal(productionVerification.valid, false);
  assert.ok(productionVerification.blockers.includes(
    'autonomous_research_release_binding_recursive_closure_source_invalid',
  ));
  assert.equal(verifyAutonomousResearchReleaseBinding(binding, {
    campaignId: binding.campaignId,
    paperId: binding.paperId,
    campaignPlanHash: binding.campaignPlanHash,
    qualificationScope: binding.qualificationScope,
    authorityObservedAt: '2026-07-19T00:00:00.000Z',
  }).valid, true);

  const { autonomousResearchReleaseBindingHash: _hash, ...payload } = binding;
  const tamperedPayload = { ...payload, renderedManuscriptHash: HASH('attacker-main') };
  const tampered = {
    ...tamperedPayload,
    autonomousResearchReleaseBindingHash:
      hashRecord('AutonomousResearchReleaseBinding', tamperedPayload),
  };
  assert.equal(verifyAutonomousResearchReleaseBinding(tampered).valid, false);
  const untrustedReplay = buildAutonomousResearchExternalCapabilityTrustInspection({
    priorArt: binding.externalCapabilityTrustInspection.components.priorArt,
    reviewerPool: binding.externalCapabilityTrustInspection.components.reviewerPool,
    externalReplay: {
      ...binding.externalCapabilityTrustInspection.components.externalReplay,
      identityIndependenceReady: false,
    },
    submissionPortal: binding.externalCapabilityTrustInspection.components.submissionPortal,
  });
  const trustDowngradePayload = {
    ...payload,
    externalCapabilityTrustInspection: untrustedReplay,
    externalCapabilityTrustInspectionHash:
      untrustedReplay.autonomousResearchExternalCapabilityTrustInspectionHash,
  };
  const trustDowngrade = Object.freeze({
    ...trustDowngradePayload,
    autonomousResearchReleaseBindingHash:
      hashRecord('AutonomousResearchReleaseBinding', trustDowngradePayload),
  });
  assert.equal(verifyAutonomousResearchReleaseBinding(trustDowngrade).valid, false);
  assert.equal(verifyAutonomousResearchReleaseBinding({
    version: 1,
    kind: 'AutonomousResearchReleaseBinding',
    autonomousResearchReleaseBindingHash: HASH('legacy'),
  }).valid, false);

  const rehashed = (source, overrides) => {
    const { autonomousResearchReleaseBindingHash: _claimed, ...sourcePayload } = source;
    const changedPayload = { ...sourcePayload, ...overrides };
    return Object.freeze({
      ...changedPayload,
      autonomousResearchReleaseBindingHash:
        hashRecord('AutonomousResearchReleaseBinding', changedPayload),
    });
  };
  for (const [label, candidate] of [
    ['capability-manifest', rehashed(binding, {
      capabilityScopeManifest: null,
      capabilityScopeManifestHash: null,
    })],
    ['malformed-capability-manifest', rehashed(binding, {
      capabilityScopeManifest: Object.freeze({ kind: 'MalformedCapabilityManifest' }),
      capabilityScopeManifestHash: HASH('malformed-capability-manifest'),
    })],
    ['agenda-receipt', rehashed(binding, {
      researchAgendaProductionReceipt: null,
      researchAgendaProductionReceiptHash: null,
    })],
    ['malformed-agenda-receipt', rehashed(binding, {
      researchAgendaProductionReceipt: Object.freeze({ kind: 'MalformedAgendaReceipt' }),
      researchAgendaProductionReceiptHash: HASH('malformed-agenda-receipt'),
    })],
    ['external-trust', rehashed(binding, {
      externalCapabilityTrustInspection: null,
      externalCapabilityTrustInspectionHash: null,
    })],
    ['prior-art', rehashed(binding, {
      priorArtEvidenceReceipt: null,
      priorArtEvidenceReceiptHash: null,
      priorArtAuthorityVerificationBundle: null,
      priorArtAuthorityVerificationBundleHash: null,
      priorArtAuthorityTrustConfiguration: null,
      priorArtAuthorityTrustConfigurationHash: null,
    })],
    ['render-receipt', rehashed(binding, {
      trustedAutonomousManuscriptRenderReceipt: null,
      trustedAutonomousManuscriptRenderReceiptHash: null,
    })],
    ['render-node', rehashed(binding, {
      manuscriptRenderNodeResult: null,
      manuscriptRenderNodeResultHash: null,
    })],
    ['source-file', rehashed(binding, {
      agentAuthoredSourceDraftFileHash: null,
    })],
    ['source-draft', rehashed(binding, {
      agentAuthoredSourceDraft: null,
    })],
    ['global-authority', rehashed(binding, {
      globalGoldenQualificationAuthority: null,
      globalGoldenQualificationAuthorityHash: HASH('forged-global-authority'),
    })],
  ]) assert.equal(verifyAutonomousResearchReleaseBinding(candidate, {
    authorityObservedAt: '2026-07-19T00:00:00.000Z',
  }).valid, false, label);
});

test('manuscript release proof keeps workspace integration transport outside its domain hash', () => {
  const release = genericManuscriptReleaseFixture({
    paperId: PAPER_ID,
    campaignId: CAMPAIGN_ID,
    campaignPlanHash: HASH('plan'),
    launchMode: 'production-run',
    externalSubmission: true,
    includeProof: true,
  });
  const proof = release.trustedAutonomousManuscriptResult;
  const result = Object.freeze({
    ...proof.result,
    workspaceAttemptIntegration: Object.freeze({
      workspaceAttemptIntegrationDescriptorHash: HASH('workspace-attempt-integration'),
    }),
  });
  const integratedProof = Object.freeze({
    ...proof,
    result,
    resultHash: hashRecord('PaperCampaignNodeResult', result),
  });
  const binding = release.releaseBinding;
  const expected = Object.freeze({
    paperId: binding.paperId,
    campaignId: binding.campaignId,
    manuscriptPath: binding.manuscriptPath,
    renderedManuscriptHash: binding.renderedManuscriptHash,
    evidenceBoundManuscriptIrHash: binding.evidenceBoundManuscriptIrHash,
    manuscriptIrFileHash: binding.manuscriptIrFileHash,
    agentAuthoredSourceDraftHash: binding.agentAuthoredSourceDraftHash,
    agentAuthoredSourceDraftFileHash: binding.agentAuthoredSourceDraftFileHash,
    venueProfileSelectionHash: binding.venueProfileSelectionHash,
    venueRequirementIrHash: binding.venueRequirementIrHash,
    venueTemplateAssetHash:
      binding.venueProfileSelection?.venueTemplateAsset?.templateAssetHash || null,
    venueTemplateAssetPath:
      binding.venueProfileSelection?.venueTemplateAsset?.relativePath || null,
    submissionMetadataReceiptHash: binding.submissionMetadataReceiptHash,
    requireExternalSubmission: true,
  });
  const inspection = inspectAutonomousManuscriptReleaseProof(
    integratedProof,
    expected,
    { requireAgentAuthored: true },
  );
  assert.equal(inspection.valid, true);
  const integratedBinding = createAutonomousResearchReleaseBinding({
    campaignId: binding.campaignId,
    paperId: binding.paperId,
    campaignPlanHash: binding.campaignPlanHash,
    preparation: release.preparation,
    manuscriptPath: binding.manuscriptPath,
    renderedManuscriptHash: binding.renderedManuscriptHash,
    evidenceBoundManuscriptIrHash: binding.evidenceBoundManuscriptIrHash,
    manuscriptIrFileHash: binding.manuscriptIrFileHash,
    agentAuthoredSourceDraft: release.sourceDraft,
    agentAuthoredSourceDraftFileHash: binding.agentAuthoredSourceDraftFileHash,
    trustedAutonomousManuscriptResult: integratedProof,
    refereeConvergenceDecision: release.refereeConvergenceDecision,
    reviewerEvidenceAuthority: release.reviewerEvidenceAuthority,
    researchReport: release.researchReport,
    experimentIrExecutionAuthorityReceipt:
      release.experimentIrExecutionAuthorityReceipt,
    experimentReplayReceipt: release.experimentReplayReceipt,
  });
  assert.equal(integratedBinding.fullResearchQualificationEligible, true);
  assert.equal(verifyAutonomousResearchReleaseBinding(integratedBinding).valid, true);

  const tamperedProof = Object.freeze({
    ...integratedProof,
    result: Object.freeze({
      ...result,
      workspaceAttemptIntegration: Object.freeze({
        workspaceAttemptIntegrationDescriptorHash: HASH('tampered-integration'),
      }),
    }),
  });
  assert.equal(inspectAutonomousManuscriptReleaseProof(
    tamperedProof,
    expected,
    { requireAgentAuthored: true },
  ).valid, false);
  assert.equal(verifyAutonomousResearchReleaseBinding(Object.freeze({
    ...integratedBinding,
    manuscriptRenderNodeResult: tamperedProof.result,
    manuscriptRenderNodeResultHash: hashRecord(
      'PaperCampaignNodeResult',
      tamperedProof.result,
    ),
  })).valid, false);

  const unknownTransportResult = Object.freeze({
    ...result,
    workspaceAttemptIntegrationExtra: Object.freeze({ forged: true }),
  });
  assert.equal(inspectAutonomousManuscriptReleaseProof(Object.freeze({
    ...integratedProof,
    result: unknownTransportResult,
    resultHash: hashRecord('PaperCampaignNodeResult', unknownTransportResult),
  }), expected, { requireAgentAuthored: true }).valid, false);
});

test('production release cannot downgrade to a rehashed bounded qualification scope', () => {
  const bounded = fixture({ launchMode: 'golden-bootstrap' }).binding;
  assert.equal(bounded.qualificationScope, BOUNDED_CAPABILITY_QUALIFICATION_SCOPE);
  const { autonomousResearchReleaseBindingHash: _hash, ...payload } = bounded;
  const forgedPayload = { ...payload, launchMode: 'production-run' };
  const forged = Object.freeze({
    ...forgedPayload,
    autonomousResearchReleaseBindingHash:
      hashRecord('AutonomousResearchReleaseBinding', forgedPayload),
  });
  const verification = verifyAutonomousResearchReleaseBinding(forged);
  assert.equal(verification.valid, false);
  assert.ok(verification.blockers.includes(
    'autonomous_research_release_binding_qualification_scope_invalid',
  ));
});

test('production release rejects a fixed formal proposal even under a generic manifest', () => {
  const { preparation } = fixture({ launchMode: 'golden-bootstrap' });
  const fixedFormalPreparation = structuredClone(preparation);
  fixedFormalPreparation.launchMode = 'production-run';
  fixedFormalPreparation.proposal.version = 1;
  delete fixedFormalPreparation.proposal.formalSupportMode;
  delete fixedFormalPreparation.proposal.dynamicFormalClaimSeed;
  delete fixedFormalPreparation.proposal.researchContentProducerReceipt;
  fixedFormalPreparation.proposal.formalSupportRegistryHash = HASH('template-registry');
  fixedFormalPreparation.proposal.formalSupportTemplateId = 'registered-template';
  fixedFormalPreparation.proposal.formalSupportTemplateHash = HASH('template');
  delete fixedFormalPreparation.dynamicFormalClaimSeed;
  delete fixedFormalPreparation.researchContentProducerReceipt;
  assert.throws(() => createAutonomousResearchReleaseBinding({
    campaignId: CAMPAIGN_ID,
    paperId: PAPER_ID,
    campaignPlanHash: HASH('fixed-formal-plan'),
    preparation: fixedFormalPreparation,
  }), /autonomous_research_production_profile_blocked:.*dynamic_content_lineage_required/);
});

test('self-reported substantive flags cannot qualify empty or system-default drafts', () => {
  assert.throws(
    () => fixture({ draftMode: 'empty' }),
    /autonomous_research_agent_authored_release_proof_required/,
  );
  assert.throws(
    () => fixture({ draftMode: 'default' }),
    /autonomous_research_agent_authored_release_proof_required/,
  );
});

test('golden qualification is infrastructure-only and minimal golden cannot mint its canary', () => {
  assert.equal(createAutonomousResearchReleaseBinding({ preparation: null }), null);
  const { binding: golden, preparation: goldenPreparation } = fixture({
    launchMode: 'golden-bootstrap',
  });
  assert.equal(golden.qualificationScope, BOUNDED_CAPABILITY_QUALIFICATION_SCOPE);
  assert.equal(golden.fullResearchQualificationEligible, false);
  assert.equal(golden.externalSubmissionEligible, false);
  assert.equal(golden.genericContentCanaryVerified, true);
  assert.equal(verifyAutonomousResearchReleaseBinding(golden).valid, true);

  const minimal = fixture({ launchMode: 'golden-bootstrap', includeProof: false }).binding;
  assert.equal(minimal.genericContentCanaryVerified, false);
  assert.equal(minimal.fullResearchQualificationEligible, false);
  assert.equal(minimal.externalSubmissionEligible, false);
  assert.equal(verifyAutonomousResearchReleaseBinding(minimal).valid, true);

  const venueFreePreparation = structuredClone(goldenPreparation);
  delete venueFreePreparation.venueProfileSelection;
  delete venueFreePreparation.submissionMetadataReceipt;
  const venueFree = createAutonomousResearchReleaseBinding({
    campaignId: CAMPAIGN_ID,
    paperId: PAPER_ID,
    campaignPlanHash: HASH('venue-free-golden-plan'),
    preparation: venueFreePreparation,
  });
  assert.equal(venueFree.venueProfileSelectionHash, null);
  assert.equal(venueFree.submissionMetadataReceiptHash, null);

  const rehashGolden = (overrides) => {
    const { autonomousResearchReleaseBindingHash: _hash, ...payload } = golden;
    const changed = { ...payload, ...overrides };
    return Object.freeze({
      ...changed,
      autonomousResearchReleaseBindingHash:
        hashRecord('AutonomousResearchReleaseBinding', changed),
    });
  };
  assert.equal(verifyAutonomousResearchReleaseBinding(rehashGolden({
    releaseReviewerEvidenceHash: HASH('unexpected-optional-reviewer-evidence'),
    releaseReviewerEvidence: Object.freeze({ kind: 'UnexpectedReviewerEvidence' }),
  })).valid, false);
  assert.equal(verifyAutonomousResearchReleaseBinding(rehashGolden({
    globalGoldenQualificationAuthority: Object.freeze({
      ...golden.globalGoldenQualificationAuthority,
      campaignId: 'wrong-golden-campaign',
    }),
  })).valid, false);

  const expectedMismatch = verifyAutonomousResearchReleaseBinding(golden, {
    campaignId: 'wrong-campaign',
    paperId: 'wrong-paper',
    campaignPlanHash: HASH('wrong-plan'),
    qualificationScope: PRODUCTION_AGENT_AUTHORED_QUALIFICATION_SCOPE,
    authorityObservedAt: '2026-07-19T00:00:00.000Z',
  });
  assert.equal(expectedMismatch.valid, false);
  for (const field of ['campaignId', 'paperId', 'campaignPlanHash', 'qualificationScope']) {
    assert.ok(expectedMismatch.blockers.includes(
      `autonomous_research_release_binding_${field}_mismatch`,
    ));
  }
  assert.equal(verifyAutonomousResearchReleaseBinding(null).valid, false);
});

test('recursive production releases cannot downgrade to legacy v5 submission dispatch', async () => {
  const portalConfiguration = buildAutonomousSubmissionPortalConfiguration({
    portalId: 'trusted-submission-portal',
    endpoint: 'https://submission.example.test/submit',
    serviceIdentityHash: HASH('portal-service'),
    portalAccountIdentityHash: HASH('portal-account'),
    portalTrustDomainIdentityHash: HASH('portal-trust-domain'),
    tokenEnvironmentVariable: 'SUBMISSION_PORTAL_TEST_TOKEN',
  });
  const { binding } = fixture();
  assert.equal(binding.version, 4);
  assert.equal(binding.externalSubmissionEligible, true);
  const legacyPayload = {
    version: 5,
    kind: 'AutonomousSubmissionRequest',
    campaignId: binding.campaignId,
    paperId: binding.paperId,
    requestedAt: '2026-07-19T00:02:00.000Z',
    portalConfigurationHash: portalConfiguration.configurationHash,
    autonomousResearchReleaseBinding: binding,
  };
  const legacy = Object.freeze({
    ...legacyPayload,
    requestHash: hashRecord('AutonomousSubmissionRequest', legacyPayload),
  });
  assert.equal(verifyAutonomousSubmissionRequest(legacy), false);
  assert.throws(() => createAutonomousSubmissionRequestVerifier({
    verifyPortalConfigurationAuthority: () => true,
    verifyCurrentCampaignReleaseAuthority: () => true,
    verifyQualificationAuthority: () => true,
    verifyVenueComplianceAuthority: () => true,
    requireResearchClosure: true,
  }), /autonomous_submission_request_trust_verifier_required/);
  const verifier = createAutonomousSubmissionRequestVerifier({
    verifyPortalConfigurationAuthority: () => true,
    verifyCurrentCampaignReleaseAuthority: () => true,
    verifyQualificationAuthority: () => true,
    verifyVenueComplianceAuthority: () => true,
    verifyQualificationSignature: () => true,
    verifyIndependentQualificationEvidence: () => true,
    requireResearchClosure: true,
  });
  assert.equal(verifier.verify(legacy), false);
  let networkCalls = 0;
  const submissionDispatchAuthority = createAutonomousSubmissionDispatchAuthority();
  const portal = createHttpAutonomousSubmissionPortalAdapter({
    configuration: portalConfiguration,
    environment: { SUBMISSION_PORTAL_TEST_TOKEN: 'fixture-token' },
    submissionRequestVerifier: verifier,
    dispatchCapability: submissionDispatchAuthority.portal,
    async fetchImpl() {
      networkCalls += 1;
      throw new Error('legacy_request_must_not_reach_network');
    },
  });
  await assert.rejects(
    () => portal.submit({ request: legacy }),
    /autonomous_submission_portal_request_invalid/,
  );
  assert.equal(networkCalls, 0);
});
