import crypto from 'node:crypto';
import {
  buildEvidenceBoundManuscriptIrDraft,
  finalizeEvidenceBoundManuscriptIr,
} from '../../../paper-domain/research/evidence-bound-manuscript-ir.mjs';
import {
  buildPriorArtEvidenceReceipt,
  buildPriorArtEvidenceReceiptV2,
} from '../../../paper-domain/research/prior-art-evidence-contract.mjs';
import {
  buildAgentWorkspacePostimageBinding,
} from '../../../paper-domain/evidence/agent-execution-receipt-contract.mjs';
import {
  buildAutonomousResearchAgentProductionAuthorityBinding,
} from '../../../paper-domain/automation/autonomous-research-agent-production-authority-binding.mjs';
import {
  buildAutonomousResearchRuntimePrincipalBinding,
} from '../../../paper-domain/automation/autonomous-research-runtime-principal-binding-contract.mjs';
import {
  buildCryptographicSignedReviewerReceipt,
} from '../../../paper-domain/research/signed-reviewer-receipt-contract.mjs';
import {
  buildReviewerExecutionAuthorityContext,
  reviewerSemanticReviewHash,
  reviewerSemanticReceiptSigningSubject,
} from '../../../paper-domain/research/reviewer-semantic-evidence-contract.mjs';
import {
  evaluateRefereeConvergence,
} from '../../../paper-domain/automation/referee-convergence.mjs';
import {
  buildAutonomousResearchExternalCapabilityTrustInspection,
} from '../../../paper-domain/automation/autonomous-research-external-capability-trust-contract.mjs';
import {
  buildDynamicFormalClaimSeed,
} from '../../../paper-domain/research/dynamic-formal-claim-seed-contract.mjs';
import {
  buildExternalPrincipalIdentityAttestationSubject,
  evaluateExternalPrincipalIdentitySeparation,
} from '../../../paper-domain/evidence/external-principal-identity-attestation-contract.mjs';
import {
  buildPriorArtServiceConfiguration,
  buildPriorArtIndependentReviewAuthoritySubjectV2,
  buildPriorArtRetrievalAuthoritySubjectV2,
} from '../../../paper-adapters/automation/http-prior-art-retrieval-adapter.mjs';
import {
  buildPinnedExternalEvidenceEnvelope,
  pinnedExternalEvidenceSigningPayload,
} from '../../../paper-adapters/authority/pinned-external-evidence-verifier.mjs';
import {
  buildPriorArtAuthorityTrustConfiguration,
} from '../../../paper-domain/research/prior-art-authority-verification-contract.mjs';
import {
  buildAutonomousSubmissionMetadataProfile,
  buildAutonomousSubmissionMetadataReceipt,
} from '../../../paper-domain/automation/autonomous-submission-metadata-contract.mjs';
import {
  buildAutonomousVenueProfile,
  buildAutonomousVenueProfileRegistry,
  selectAutonomousVenueProfile,
} from '../../../paper-domain/automation/autonomous-venue-profile-contract.mjs';
import {
  buildAutonomousVenueTemplateAssetBundle,
  buildAutonomousVenueTemplateAssetRecord,
} from '../../../paper-domain/automation/autonomous-venue-template-asset-contract.mjs';
import {
  buildAutonomousConfigurationAuthorityProof,
} from '../../../paper-domain/automation/autonomous-configuration-authority-contract.mjs';
import {
  priorArtQueryPlanHash,
} from '../../../paper-domain/automation/research-agenda-ir.mjs';
import { hashBytes, hashRecord } from '../../../workflow-kernel/record-hash.mjs';

export const FIXED_TIME = '2026-07-19T00:00:00.000Z';
export const PRODUCTION_VENUE_TEMPLATE_PATH =
  'venue-assets/machine-research-journal-template.tex';
export const PRODUCTION_VENUE_TEMPLATE_SOURCE = [
  '\\NeedsTeXFormat{LaTeX2e}',
  '\\ProvidesFile{machine-research-journal-template.tex}[2026/07/23 fixture]',
  '% Hash-bound anonymous research-article template fixture.',
  '',
].join('\n');
const venueAuthorityPair = crypto.generateKeyPairSync('ed25519');
const metadataAuthorityPair = crypto.generateKeyPairSync('ed25519');
const priorArtRetrievalPair = crypto.generateKeyPairSync('ed25519');
const priorArtReviewPair = crypto.generateKeyPairSync('ed25519');
const priorArtIdentityPair = crypto.generateKeyPairSync('ed25519');

export function digest(label) {
  return hashRecord('AutonomousResearchGeneralizationFixture', { label });
}
export function productionAgentAuthorityBindingFixture({
  externalCapabilityTrustInspection = productionExternalCapabilityTrustInspectionFixture(),
  authorPrincipalId = 'research-author',
  authorProvider = 'configured-agent-provider',
  authorModel = 'pinned-research-model',
  providerConfigurationHash = digest('agent-provider-configuration'),
  authorCapabilityReceiptHash = digest(`${authorPrincipalId}:capability-receipt`),
  authorCredentialRootIdentityHash = digest(`${authorPrincipalId}:credential-root`),
  authorCredentialConfigIdentityHash = digest(`${authorPrincipalId}:credential-config`),
} = {}) {
  const reviewerTrust = externalCapabilityTrustInspection.components.reviewerPool;
  const runtimePrincipalBinding = buildAutonomousResearchRuntimePrincipalBinding({
    authorPrincipalId,
    authorIdentityConfigurationHash: digest(`${authorPrincipalId}:identity-configuration`),
    authorIdentitySubjectHash: digest(`${authorPrincipalId}:identity-subject`),
    authorCapabilityReceiptHash,
    authorCredentialRootIdentityHash,
    researchPrincipalPoolHash: digest('research-principal-pool'),
    reviewerTrustSetHash: reviewerTrust.trustSetHash,
    reviewerSignatureVerificationPolicyHash:
      reviewerTrust.signatureVerificationPolicyHash,
  });
  return buildAutonomousResearchAgentProductionAuthorityBinding({
    runtimePrincipalBinding,
    autonomousResearchProviderConfigurationHash: providerConfigurationHash,
    authorPrincipalId,
    authorProvider,
    authorModel,
    authorCapabilityReceiptHash,
    authorCredentialRootIdentityHash,
    authorCredentialConfigIdentityHash,
  });
}

export function productionSignedReviewerReviewFixture({
  campaignId,
  campaignPlanHash,
  paperId,
  manuscriptHash,
  runtimePrincipalBinding,
  reviewerOrdinal = 1,
  nodeId = `release-reviewer-${reviewerOrdinal}`,
  reviewAttemptId = `attempt:release-reviewer-${reviewerOrdinal}:1`,
  roundIndex = 1,
} = {}) {
  const index = Number(reviewerOrdinal);
  const principalId = `release-reviewer-${index}`;
    const principalDescriptorHash = digest(`${principalId}:descriptor`);
    const reviewerExecutionAuthorityContext = buildReviewerExecutionAuthorityContext({
      campaignId,
      campaignPlanHash,
      paperId,
      nodeId,
      roundIndex,
      reviewAttemptId,
      manuscriptHash,
    });
    const unsignedPayload = {
      version: 1,
      kind: 'AgentExecutionReceipt',
      status: 'agent_execution_completed',
      executorId: `fixture-executor:${principalId}`,
      role: 'independent-review',
      providerMode: 'openai',
      resolvedModel: 'fixture-reviewer-model',
      promptHash: digest(`${principalId}:prompt`),
      sessionId: `${principalId}:session`,
      childSessionId: `${principalId}:session`,
      changedPaths: [],
      structuredOutput: {
        verdict: 'accept', score: 0.9, criticalFindingCount: 0,
        findings: [], summary: 'Signed bounded review accepted.',
      },
      finalOutput: '',
      externalActionPerformed: true,
      reviewPrincipalId: principalId,
      reviewPrincipalDescriptorHash: principalDescriptorHash,
      reviewerProviderAccountIdentityHash: digest(`${principalId}:account`),
      reviewerCredentialRootIdentityHash: digest(`${principalId}:credential-root`),
      reviewerTrustDomainIdentityHash: digest(`${principalId}:trust-domain`),
      reviewerSignerIdentityHash: digest(`${principalId}:signer`),
      researchPrincipalPoolHash: runtimePrincipalBinding.researchPrincipalPoolHash,
      reviewerCryptographicAuthorityReady: true,
      reviewerIdentityIndependenceReady: true,
      reviewerTrustSetHash: runtimePrincipalBinding.reviewerTrustSetHash,
      reviewerSignatureVerificationPolicyHash:
        runtimePrincipalBinding.reviewerSignatureVerificationPolicyHash,
      reviewerExecutionAuthorityContext,
    };
    const unsignedAgentExecutionReceipt = Object.freeze({
      ...unsignedPayload,
      agentExecutionReceiptHash: hashRecord('AgentExecutionReceipt', unsignedPayload),
    });
    const unsignedAgentExecutionReceiptHash =
      unsignedAgentExecutionReceipt.agentExecutionReceiptHash;
    const subjectHash = reviewerSemanticReceiptSigningSubject({
      unsignedAgentExecutionReceipt,
      principalDescriptorHash,
      researchPrincipalPoolHash: runtimePrincipalBinding.researchPrincipalPoolHash,
    });
    const authorityEnvelope = Object.freeze({
      version: 1,
      kind: 'PinnedExternalEvidenceEnvelope',
      subjectKind: 'ReviewerReceiptSigningSubjectV1',
      subjectHash,
      fixtureSigner: principalId,
    });
    const verificationPayload = {
      version: 1,
      kind: 'PinnedExternalEvidenceVerificationReceipt',
      status: 'pinned_external_evidence_verified',
      cryptographicAuthorityReady: true,
      subjectKind: 'ReviewerReceiptSigningSubjectV1',
      subjectHash,
      requiredRole: 'reviewer_receipt_attestor',
      envelopeHash: hashRecord('PinnedExternalEvidenceEnvelope', authorityEnvelope),
      signedAt: FIXED_TIME,
      expiresAt: '2026-07-20T00:00:00.000Z',
    };
    const signatureVerificationReceipt = Object.freeze({
      ...verificationPayload,
      pinnedExternalEvidenceVerificationReceiptHash: hashRecord(
        'PinnedExternalEvidenceVerificationReceipt',
        verificationPayload,
      ),
    });
    const signerIdentityHash = unsignedPayload.reviewerSignerIdentityHash;
    const signedReviewerReceipt = buildCryptographicSignedReviewerReceipt({
      subjectHash,
      principalId,
      principalDescriptorHash,
      researchPrincipalPoolHash: runtimePrincipalBinding.researchPrincipalPoolHash,
      signerIdentityHash,
      authorityEnvelope,
      signatureVerificationReceipt,
    }, { assertVerificationReceipt() {} });
    return Object.freeze({
      reviewerId: principalId,
      role: 'independent-review',
      verdict: 'accept',
      score: 0.9,
      criticalFindingCount: 0,
      findings: [],
      summary: 'Signed bounded review accepted.',
      reviewHash: reviewerSemanticReviewHash({ unsignedAgentExecutionReceipt }),
      manuscriptHash,
      childSessionId: `${principalId}:session`,
      reviewPrincipalId: principalId,
      reviewPrincipalDescriptorHash: principalDescriptorHash,
      reviewerProviderAccountIdentityHash: digest(`${principalId}:account`),
      reviewerCredentialRootIdentityHash: digest(`${principalId}:credential-root`),
      reviewerTrustDomainIdentityHash: digest(`${principalId}:trust-domain`),
      reviewerSignerIdentityHash: signerIdentityHash,
      signedReviewerReceiptHash: signedReviewerReceipt.signedReviewerReceiptHash,
      signedReviewerReceipt: structuredClone(signedReviewerReceipt),
      unsignedAgentExecutionReceiptHash,
      unsignedAgentExecutionReceipt,
      signatureVerificationReceiptHash:
        signedReviewerReceipt.signatureVerificationReceiptHash,
      researchPrincipalPoolHash: runtimePrincipalBinding.researchPrincipalPoolHash,
      reviewAttemptId,
      campaignId,
      campaignPlanHash,
      paperId,
      nodeId,
      roundIndex,
      promptHash: unsignedPayload.promptHash,
      resolvedModel: unsignedPayload.resolvedModel,
      selectedExecutorId: unsignedPayload.executorId,
    });
}

export function productionReviewerEvidenceFixture({
  campaignId,
  campaignPlanHash,
  paperId,
  manuscriptHash,
  runtimePrincipalBinding,
} = {}) {
  const reviews = [1, 2].map((reviewerOrdinal) => (
    productionSignedReviewerReviewFixture({
      campaignId,
      campaignPlanHash,
      paperId,
      manuscriptHash,
      runtimePrincipalBinding,
      reviewerOrdinal,
    })
  ));
  const verifySignedReviewerReceipt = () => true;
  const decision = evaluateRefereeConvergence({
    campaignId,
    campaignPlanHash,
    paperId,
    roundIndex: 1,
    reviews,
    minimumReviewers: 2,
    minimumIndependentTrustDomains: 2,
    requireSignedReviewerReceipts: true,
    expectedManuscriptHash: manuscriptHash,
    expectedReviewerContexts: reviews.map((review) => Object.freeze({
      nodeId: review.nodeId,
      reviewAttemptId: review.reviewAttemptId,
    })),
    signedReviewerReceiptVerifier: verifySignedReviewerReceipt,
  });
  return Object.freeze({
    refereeConvergenceDecision: structuredClone(decision),
    reviewerEvidenceAuthority: Object.freeze({
      researchPrincipalPoolHash: runtimePrincipalBinding.researchPrincipalPoolHash,
      reviewerTrustSetHash: runtimePrincipalBinding.reviewerTrustSetHash,
      reviewerSignatureVerificationPolicyHash:
        runtimePrincipalBinding.reviewerSignatureVerificationPolicyHash,
      verifySignedReviewerReceipt,
    }),
  });
}

export function priorArtFixture({ paperId = 'paper-generalized-1' } = {}) {
  return buildPriorArtEvidenceReceipt({
    paperId,
    agendaSelectionReceiptHash: digest('agenda'),
    generatorPrincipalId: 'research-author-1',
    queries: [{
      queryId: 'query-1',
      query: 'evidence-bound autonomous research systems',
      providers: ['openalex-snapshot'],
      executedAt: FIXED_TIME,
      corpusSnapshotHash: digest('corpus'),
      resultSetHash: digest('results'),
      retrievalReceiptHash: digest('retrieval'),
    }],
    works: [{
      workId: 'work-1',
      title: 'Auditable machine research systems',
      authors: ['Ada Researcher'],
      year: 2025,
      identifiers: {
        doi: '10.0000/example.1',
        arxiv: null,
        openAlex: null,
        url: null,
      },
      queryIds: ['query-1'],
      sourceSnapshotHash: digest('work-source'),
      abstractHash: digest('abstract'),
    }],
    coverageLimitations: [
      'The configured corpus snapshot is finite and cannot establish open-world completeness.',
    ],
    independentReview: {
      principalId: 'prior-art-reviewer-1',
      providerAccountIdentityHash: digest('prior-account'),
      trustDomainIdentityHash: digest('prior-domain'),
      reviewReceiptHash: digest('prior-review'),
      signatureVerificationReceiptHash: digest('prior-signature-verification'),
      independentFromGenerator: true,
    },
    createdAt: FIXED_TIME,
    mode: 'verified',
  });
}

export function priorArtV2Fixture({
  paperId = 'paper-generalized-1',
  signatureVerificationReceiptHash = digest('prior-signature-verification'),
  agendaSelectionReceiptHash = digest('agenda'),
  researchAgendaIrHash = digest('research-agenda-ir'),
  priorArtQueryPlan = ['evidence-bound autonomous research systems'],
  createdAt = FIXED_TIME,
} = {}) {
  const crossrefResultSetHash = digest('prior-art-v2-crossref-results');
  const openAlexResultSetHash = digest('prior-art-v2-openalex-results');
  return buildPriorArtEvidenceReceiptV2({
    paperId,
    agendaSelectionReceiptHash,
    researchAgendaIrHash,
    priorArtQueryPlan,
    generatorPrincipalId: 'research-author-1',
    queries: [{
      queryId: 'query-1',
      query: priorArtQueryPlan[0],
      executedAt: FIXED_TIME,
      providerResults: [{
        providerId: 'crossref-snapshot',
        providerQueryId: 'crossref-query-1',
        corpusSnapshotHash: digest('prior-art-v2-crossref-corpus'),
        resultSetHash: crossrefResultSetHash,
        retrievalReceiptHash: digest('prior-art-v2-crossref-retrieval'),
        resultCount: 1,
      }, {
        providerId: 'openalex-snapshot',
        providerQueryId: 'openalex-query-1',
        corpusSnapshotHash: digest('prior-art-v2-openalex-corpus'),
        resultSetHash: openAlexResultSetHash,
        retrievalReceiptHash: digest('prior-art-v2-openalex-retrieval'),
        resultCount: 1,
      }],
    }],
    works: [{
      workId: 'work-1',
      title: 'Auditable machine research systems',
      authors: ['Ada Researcher'],
      year: 2025,
      identifiers: {
        doi: 'https://doi.org/10.0000/EXAMPLE.1',
        arxiv: 'arXiv:2501.01234v2',
        openAlex: 'https://openalex.org/w123456789',
        url: 'https://example.test/auditable-research#abstract',
      },
      providerSources: [{
        providerId: 'crossref-snapshot',
        providerWorkId: 'crossref-work-1',
        queryId: 'query-1',
        resultSetHash: crossrefResultSetHash,
        sourceSnapshotHash: digest('prior-art-v2-crossref-work'),
      }, {
        providerId: 'openalex-snapshot',
        providerWorkId: 'openalex-work-1',
        queryId: 'query-1',
        resultSetHash: openAlexResultSetHash,
        sourceSnapshotHash: digest('prior-art-v2-openalex-work'),
      }],
      abstractHash: digest('abstract'),
    }],
    deduplication: {
      algorithmId: 'scholarly-identity-union',
      algorithmVersion: '1.0.0',
      algorithmConfigurationHash: digest('prior-art-v2-deduplication-config'),
    },
    rankings: [{
      queryId: 'query-1',
      algorithmId: 'bounded-relevance-ranking',
      algorithmVersion: '1.0.0',
      algorithmConfigurationHash: digest('prior-art-v2-ranking-config'),
      sourceResultSetHashes: [crossrefResultSetHash, openAlexResultSetHash],
      entries: [{ workId: 'work-1', rank: 1, scoreMicros: 900_000 }],
    }],
    coverageLimitations: [
      'The configured corpus snapshots are finite and cannot establish open-world completeness.',
    ],
    independentReview: {
      principalId: 'prior-art-reviewer-1',
      providerAccountIdentityHash: digest('prior-account'),
      trustDomainIdentityHash: digest('prior-domain'),
      reviewReceiptHash: digest('prior-review'),
      signatureVerificationReceiptHash,
      independentFromGenerator: true,
    },
    createdAt,
    mode: 'verified',
  });
}

export function manuscriptIrFixture({ priorArtReceipt, paperId = 'paper-generalized-1' } = {}) {
  const evidenceHash = priorArtReceipt.priorArtEvidenceReceiptHash;
  const authorityBindings = [{ kind: 'prior-art-evidence', hash: evidenceHash }];
  const draft = buildEvidenceBoundManuscriptIrDraft({
    paperId,
    title: 'Evidence-bound autonomous research',
    sections: [
      {
        sectionId: 'abstract',
        heading: 'Abstract',
        blocks: [{
          type: 'prose',
          blockId: 'abstract-scope',
          claimClass: 'scope',
          text: 'This manuscript reports only claims bound to machine-verifiable evidence.',
          evidenceRefs: [evidenceHash],
        }],
      },
      {
        sectionId: 'methods',
        heading: 'Methods',
        blocks: [
          { type: 'slot', blockId: 'empirical-claims-slot', slot: 'empirical_claims' },
          { type: 'slot', blockId: 'formal-support-slot', slot: 'formal_support' },
        ],
      },
      {
        sectionId: 'results',
        heading: 'Results',
        blocks: [{ type: 'slot', blockId: 'empirical-results-slot', slot: 'empirical_results' }],
      },
      {
        sectionId: 'limitations',
        heading: 'Limitations',
        blocks: [{
          type: 'prose',
          blockId: 'open-world-limitation',
          claimClass: 'limitation',
          text: 'Finite retrieval and verification do not guarantee novelty or scientific truth.',
          evidenceRefs: [evidenceHash],
        }],
      },
    ],
  });
  const agentReceiptPayload = {
    version: 1,
    kind: 'AgentExecutionReceipt',
    status: 'agent_execution_completed',
    agentId: 'research-author-1',
    resolvedModel: 'evidence-writer-v1',
    promptHash: digest('prompt'),
    changedPaths: ['AUTONOMOUS_MANUSCRIPT_IR_DRAFT.json'],
  };
  const agentWorkspacePostimageBinding = buildAgentWorkspacePostimageBinding({
    changedPaths: agentReceiptPayload.changedPaths,
    files: [{
      path: 'AUTONOMOUS_MANUSCRIPT_IR_DRAFT.json',
      hash: hashBytes(Buffer.from(JSON.stringify(draft), 'utf8')),
    }],
  });
  const agentExecutionReceipt = Object.freeze({
    ...agentReceiptPayload,
    agentExecutionReceiptHash: hashRecord('AgentExecutionReceipt', agentReceiptPayload),
    agentWorkspacePostimageBinding,
  });
  const manuscriptIr = finalizeEvidenceBoundManuscriptIr({
    draft,
    authorityBindings,
    priorArtReceipt,
    agentExecutionReceipt,
  });
  return { draft, authorityBindings, agentExecutionReceipt, manuscriptIr };
}

export function completedAgentReceipt({
  executorId,
  agentId,
  changedPaths,
  productionAuthorityBinding = null,
}) {
  const payload = {
    status: 'agent_execution_completed',
    executorId,
    agentId,
    providerMode: 'configured-agent-provider',
    resolvedModel: 'pinned-research-model',
    promptHash: digest(`${agentId}:prompt`),
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

export function productionContentLineageFixture({
  paperId,
  protocolFamily,
  capabilityScopeManifest,
  generatedAt = FIXED_TIME,
  productionAuthorityBinding = productionAgentAuthorityBindingFixture(),
  dynamicFormalClaimSeed: suppliedDynamicFormalClaimSeed = null,
  outputHash = null,
} = {}) {
  const agentExecutionReceiptHash = digest(`${paperId}:content-agent-execution`);
  const dynamicFormalClaimSeed = suppliedDynamicFormalClaimSeed
    || buildDynamicFormalClaimSeed({
      claimKey: `${paperId}:formal-support:1`,
      statement: 'Every natural number equals itself.',
      assumptions: ['The quantified value has type Nat.'],
      quantifiers: ['For every natural number n.'],
      negativeBoundaries: ['No empirical performance claim follows from this theorem.'],
      proofObligations: ['Kernel replay must verify the exact normalized Lean type.'],
      leanDeclarationName: 'dynamicIdentity',
      leanTypeSource: '∀ n : Nat, n = n',
      allowedImports: ['Mathlib'],
      generatorReceiptHash: agentExecutionReceiptHash,
      capabilityScopeManifestHash:
        capabilityScopeManifest.autonomousResearchCapabilityScopeManifestHash,
    });
  const receiptPayload = {
    version: 5,
    kind: 'AutonomousResearchContentProductionReceipt',
    status: 'autonomous_research_content_production_verified',
    producerId: productionAuthorityBinding.authorPrincipalId,
    paperId,
    protocolFamily,
    requestHash: digest(`${paperId}:content-request`),
    idempotencyKey: digest(`${paperId}:content-idempotency`),
    budgetReservationHash: digest(`${paperId}:content-budget`),
    producerContractHash: digest(`${paperId}:content-producer-contract`),
    dynamicFormalClaimsEnabled: true,
    capabilityScopeManifestHash:
      capabilityScopeManifest.autonomousResearchCapabilityScopeManifestHash,
    productionAuthorityBinding,
    maximumOutputTokens: 4096,
    maximumWallTimeMs: 20 * 60 * 1000,
    outputHash: outputHash || digest(`${paperId}:content-output`),
    dynamicFormalClaimSeedHash: dynamicFormalClaimSeed.dynamicFormalClaimSeedHash,
    agentExecutionReceiptHash,
    principalId: productionAuthorityBinding.authorPrincipalId,
    provider: productionAuthorityBinding.authorProvider,
    model: productionAuthorityBinding.authorModel,
    promptHash: digest(`${paperId}:content-prompt`),
    withinBudget: true,
    humanApprovalPerformed: false,
    externalActionPerformed: false,
    generatedAt,
  };
  const researchContentProducerReceipt = Object.freeze({
    ...receiptPayload,
    autonomousResearchContentProductionReceiptHash: hashRecord(
      'AutonomousResearchContentProductionReceipt',
      receiptPayload,
    ),
  });
  return Object.freeze({ dynamicFormalClaimSeed, researchContentProducerReceipt });
}

function submissionAuthorities({
  paperId,
  protocolFamily,
  objective = 'Produce a bounded machine-authored research argument.',
  requireExternalSubmission = true,
}) {
  const venueProfile = buildAutonomousVenueProfile({
    venueId: 'machine-research-journal',
    displayName: 'Machine Research Journal',
    protocolFamilies: [protocolFamily],
    documentClass: 'article',
    bibliographyStyle: 'inline-evidence-v1',
    citationStyle: 'evidence-inline-v1',
    maximumPages: 10,
    requiredMetadata: [
      'title', 'abstract', 'authors', 'keywords', 'conflict_of_interest',
      'funding', 'data_availability', 'code_availability',
    ],
    submissionPortalProfileId: 'machine-research-article-v1',
    externalSubmissionEnabled: true,
    profileAuthorityReceiptHash: digest('venue-profile-authority'),
    scopeTerms: [protocolFamily.replace(/_/g, ' '), 'machine authored research'],
    minimumScopeMatchCount: 1,
    requirementSpecification: {
      anonymousReview: true,
      reviewMode: 'double_anonymous',
      wordLimit: 8_000,
      sectionLimits: [
        { section: 'methods', maximumWords: 2_500 },
        { section: 'results', maximumWords: 2_500 },
        { section: 'limitations', maximumWords: 1_000 },
      ],
      templateAssetHash: hashBytes(Buffer.from(
        PRODUCTION_VENUE_TEMPLATE_SOURCE,
        'utf8',
      )),
      supplementPolicy: 'A hash-bound evidence supplement is accepted.',
      artifactRequired: true,
      artifactPolicy: 'The immutable source and evidence capsule are required.',
      disclosureRequirements: [
        'Automated authorship and model use must be disclosed.',
        'Data, code, funding, and conflicts must be disclosed.',
      ],
    },
  });
  const venueRegistry = buildAutonomousVenueProfileRegistry({
    registryId: 'generic-release-proof-venues-v2',
    profiles: [venueProfile],
  });
  const venueTemplateBytes = Buffer.from(PRODUCTION_VENUE_TEMPLATE_SOURCE, 'utf8');
  const venueTemplateAsset = buildAutonomousVenueTemplateAssetRecord({
    venueId: venueProfile.venueId,
    relativePath: PRODUCTION_VENUE_TEMPLATE_PATH,
    bytesBase64: venueTemplateBytes.toString('base64'),
    sizeBytes: venueTemplateBytes.length,
    templateAssetHash: venueProfile.requirementSpecification.templateAssetHash,
  });
  const venueTemplateAssetBundle = buildAutonomousVenueTemplateAssetBundle({
    registry: venueRegistry,
    assets: [venueTemplateAsset],
  });
  const metadataProfile = buildAutonomousSubmissionMetadataProfile({
    profileId: 'generic-release-proof-author-v1',
    authors: [{
      authorId: 'machine-research-author',
      displayName: 'Machine Research Author',
      affiliations: ['Machine Research Laboratory'],
      orcid: null,
      correspondingAuthor: true,
    }],
    defaultKeywords: ['autonomous research', 'evidence binding'],
    conflictOfInterestStatement: 'The author declares no competing interests.',
    fundingStatement: 'No external funding was used.',
    dataAvailabilityStatement: 'The evidence capsule contains the bound data artifacts.',
    codeAvailabilityStatement: 'The source archive contains the bound implementation.',
    profileAuthorityReceiptHash: digest('metadata-profile-authority'),
  });
  const venueTrustStore = fixtureTrustStore(venueAuthorityPair, {
    keyId: 'fixture-venue-profile-key',
    subjectId: 'fixture-venue-profile-authority',
    role: 'venue_profile_authority',
  });
  const metadataTrustStore = fixtureTrustStore(metadataAuthorityPair, {
    keyId: 'fixture-metadata-profile-key',
    subjectId: 'fixture-metadata-profile-authority',
    role: 'submission_metadata_authority',
  });
  const venueAuthorityProof = buildAutonomousConfigurationAuthorityProof({
    subjectKind: 'AutonomousVenueTemplateAssetBundle',
    subjectHash: venueTemplateAssetBundle.autonomousVenueTemplateAssetBundleHash,
    requiredRole: 'venue_profile_authority',
    expectedKeyIds: ['fixture-venue-profile-key'],
    trustStore: venueTrustStore,
    authorityEnvelope: fixtureAuthorityEnvelope(
      'AutonomousVenueTemplateAssetBundle',
      venueTemplateAssetBundle.autonomousVenueTemplateAssetBundleHash,
      {
        pair: venueAuthorityPair,
        keyId: 'fixture-venue-profile-key',
        role: 'venue_profile_authority',
        lifetimeMs: 23 * 60 * 60 * 1_000,
      },
    ),
    maximumLifetimeMs: 24 * 60 * 60 * 1_000,
  }, { observedAt: FIXED_TIME });
  const metadataAuthorityProof = buildAutonomousConfigurationAuthorityProof({
    subjectKind: 'AutonomousSubmissionMetadataProfile',
    subjectHash: metadataProfile.profileHash,
    requiredRole: 'submission_metadata_authority',
    expectedKeyIds: ['fixture-metadata-profile-key'],
    trustStore: metadataTrustStore,
    authorityEnvelope: fixtureAuthorityEnvelope(
      'AutonomousSubmissionMetadataProfile',
      metadataProfile.profileHash,
      {
        pair: metadataAuthorityPair,
        keyId: 'fixture-metadata-profile-key',
        role: 'submission_metadata_authority',
        lifetimeMs: 23 * 60 * 60 * 1_000,
      },
    ),
    maximumLifetimeMs: 24 * 60 * 60 * 1_000,
  }, { observedAt: FIXED_TIME });
  const venueProfileSelection = selectAutonomousVenueProfile({
    registry: venueRegistry,
    paperId,
    protocolFamily,
    objective,
    submissionMetadataProfile: metadataProfile,
    registryAuthorityProof: venueAuthorityProof,
    submissionMetadataAuthorityProof: metadataAuthorityProof,
    venueTemplateAssetBundle,
    requireExternalSubmission,
    selectedAt: FIXED_TIME,
    authorityObservedAt: FIXED_TIME,
  });
  const submissionMetadataReceipt = buildAutonomousSubmissionMetadataReceipt({
    paperId,
    protocolFamily,
    profile: metadataProfile,
    profileAuthorityProof: metadataAuthorityProof,
    selectedAt: FIXED_TIME,
    authorityObservedAt: FIXED_TIME,
  });
  return { venueProfileSelection, submissionMetadataReceipt };
}

export function productionSubmissionAuthoritiesFixture(input) {
  return submissionAuthorities(input);
}

export function productionExternalCapabilityTrustInspectionFixture({
  priorArt = null,
} = {}) {
  const component = (label, extra = {}) => Object.freeze({
    cryptographicAuthorityReady: true,
    identityIndependenceReady: true,
    configurationPinned: true,
    crashRecoveryReady: true,
    fullProductionReady: true,
    trustSetHash: digest(`${label}:trust-set`),
    signatureVerificationPolicyHash: digest(`${label}:signature-policy`),
    ...extra,
  });
  return buildAutonomousResearchExternalCapabilityTrustInspection({
    priorArt: priorArt || component('prior-art', {
      evidenceProfile: 'structured-ranked-deduplicated-v2',
    }),
    reviewerPool: component('reviewer-pool'),
    externalReplay: component('external-replay'),
    submissionPortal: component('submission-portal'),
  });
}

function fixtureTrustStore(pair, { keyId, subjectId, role }) {
  return Object.freeze({
    version: 1,
    kind: 'AuthorityTrustStore',
    keys: [Object.freeze({
      keyId,
      subjectId,
      organization: 'Fixture Research Authority',
      algorithm: 'ed25519',
      publicKeyPem: pair.publicKey.export({ type: 'spki', format: 'pem' }),
      roles: [role],
      status: 'active',
      effectiveFrom: '2026-07-18T00:00:00.000Z',
      expiresAt: '2026-07-20T00:00:00.000Z',
      revokedAt: null,
    })],
  });
}

function fixtureAuthorityEnvelope(subjectKind, subjectHash, {
  pair,
  keyId,
  role,
  observedAt = FIXED_TIME,
  lifetimeMs = 3 * 60_000,
}) {
  const observedAtMs = Date.parse(observedAt);
  const placeholder = buildPinnedExternalEvidenceEnvelope({
    subjectKind,
    subjectHash,
    signedAt: new Date(observedAtMs - 60_000).toISOString(),
    expiresAt: new Date(observedAtMs + lifetimeMs).toISOString(),
    signatures: [{
      keyId,
      role,
      algorithm: 'ed25519',
      value: 'placeholder',
    }],
  });
  const value = crypto.sign(
    null,
    pinnedExternalEvidenceSigningPayload(placeholder),
    pair.privateKey,
  ).toString('base64');
  return buildPinnedExternalEvidenceEnvelope({
    ...placeholder,
    signatures: [{ keyId, role, algorithm: 'ed25519', value }],
  });
}

function fixtureVerificationReceipt({
  subjectKind,
  subjectHash,
  envelope,
  keyId,
  subjectId,
  role,
  trustStoreHash,
  publicKeySpkiHash,
  observedAt = FIXED_TIME,
} = {}) {
  const payload = {
    version: 1,
    kind: 'PinnedExternalEvidenceVerificationReceipt',
    status: 'pinned_external_evidence_verified',
    verificationPolicy: 'pinned-canonical-json-ed25519-v1',
    subjectKind,
    subjectHash,
    requiredRole: role,
    trustStoreHash,
    envelopeHash: hashRecord('PinnedExternalEvidenceEnvelope', envelope),
    verifiedKeyIds: Object.freeze([keyId]),
    verifiedSubjectIds: Object.freeze([subjectId]),
    verifiedPublicKeySpkiHashes: Object.freeze([publicKeySpkiHash]),
    signedAt: envelope.signedAt,
    expiresAt: envelope.expiresAt,
    verifiedAt: observedAt,
    cryptographicAuthorityReady: true,
    externalActionPerformed: false,
    blockers: Object.freeze([]),
  };
  return Object.freeze({
    ...payload,
    pinnedExternalEvidenceVerificationReceiptHash: hashRecord(
      'PinnedExternalEvidenceVerificationReceipt', payload,
    ),
  });
}

function fixtureIdentity(
  label,
  signerPublicKeySpkiHash,
  overrides = {},
  observedAt = FIXED_TIME,
) {
  const observedAtMs = Date.parse(observedAt);
  return buildExternalPrincipalIdentityAttestationSubject({
    serviceId: `fixture-${label}-service`,
    principalId: `fixture-${label}-principal`,
    provider: `fixture-${label}-provider`,
    providerAccountIdentityHash: digest(`${label}:account`),
    credentialRootIdentityHash: digest(`${label}:credential`),
    hostIdentityHash: digest(`${label}:host`),
    processIdentityHash: digest(`${label}:process`),
    trustDomainIdentityHash: digest(`${label}:domain`),
    signerPublicKeySpkiHash,
    challengeHash: digest(`${label}:challenge`),
    assuranceProfile: 'pinned-provider-account-and-platform-attestation-v1',
    attestedAt: new Date(observedAtMs - 60_000).toISOString(),
    expiresAt: new Date(observedAtMs + 3 * 60_000).toISOString(),
    ...overrides,
  });
}

export function productionPriorArtAuthorityFixture({
  paperId,
  agendaSelectionReceiptHash = digest('agenda'),
  researchAgendaIr = null,
  researchAgendaIrHash = researchAgendaIr?.researchAgendaIrHash
    || digest('research-agenda-ir'),
  priorArtQueryPlan = researchAgendaIr?.priorArtQueryPlan
    || ['evidence-bound autonomous research systems'],
  observedAt = FIXED_TIME,
} = {}) {
  const retrievalPair = priorArtRetrievalPair;
  const reviewPair = priorArtReviewPair;
  const identityPair = priorArtIdentityPair;
  const retrievalKey = {
    keyId: 'fixture-prior-art-retrieval-key',
    subjectId: 'fixture-prior-art-retrieval-authority',
    role: 'prior_art_retrieval_service',
  };
  const reviewKey = {
    keyId: 'fixture-prior-art-review-key',
    subjectId: 'fixture-prior-art-review-authority',
    role: 'prior_art_independent_reviewer',
  };
  const identityKey = {
    keyId: 'fixture-prior-art-identity-key',
    subjectId: 'fixture-prior-art-identity-authority',
    role: 'external_principal_identity_attestor',
  };
  const configuration = buildPriorArtServiceConfiguration({
    version: 2,
    serviceId: 'fixture-prior-art-service',
    endpoint: 'https://prior-art.example.test/retrieve',
    serviceIdentityHash: digest(`${paperId}:prior-art-service`),
    tokenEnvironmentVariable: 'PRIOR_ART_FIXTURE_TOKEN',
    retrievalTrustStore: fixtureTrustStore(retrievalPair, retrievalKey),
    retrievalSignerKeyIds: [retrievalKey.keyId],
    independentReviewTrustStore: fixtureTrustStore(reviewPair, reviewKey),
    independentReviewSignerKeyIds: [reviewKey.keyId],
    identityTrustStore: fixtureTrustStore(identityPair, identityKey),
    identitySignerKeyIds: [identityKey.keyId],
  });
  const trustConfiguration = buildPriorArtAuthorityTrustConfiguration(configuration);
  const externalCapabilityTrustInspection =
    productionExternalCapabilityTrustInspectionFixture({
      priorArt: {
        cryptographicAuthorityReady: true,
        identityIndependenceReady: true,
        configurationPinned: true,
        fullProductionReady: true,
        evidenceProfile: 'structured-ranked-deduplicated-v2',
        trustSetHash: trustConfiguration.trustSetHash,
        signatureVerificationPolicyHash:
          trustConfiguration.signatureVerificationPolicyHash,
      },
    });
  const preliminaryReceipt = priorArtV2Fixture({
    paperId,
    agendaSelectionReceiptHash,
    researchAgendaIrHash,
    priorArtQueryPlan,
    createdAt: observedAt,
  });
  const preliminaryReviewSubject = buildPriorArtIndependentReviewAuthoritySubjectV2({
    receipt: preliminaryReceipt,
  });
  const independentReviewEnvelope = fixtureAuthorityEnvelope(
    preliminaryReviewSubject.kind,
    preliminaryReviewSubject.priorArtIndependentReviewAuthoritySubjectHash,
    { pair: reviewPair, ...reviewKey, observedAt },
  );
  const priorArtReceipt = priorArtV2Fixture({
    paperId,
    agendaSelectionReceiptHash,
    researchAgendaIrHash,
    priorArtQueryPlan,
    createdAt: observedAt,
    signatureVerificationReceiptHash: hashRecord(
      'PinnedExternalEvidenceEnvelope', independentReviewEnvelope,
    ),
  });
  const independentReviewSubject = buildPriorArtIndependentReviewAuthoritySubjectV2({
    receipt: priorArtReceipt,
  });
  const retrievalSubject = buildPriorArtRetrievalAuthoritySubjectV2({
    requestHash: digest(`${paperId}:prior-art-request`),
    serviceId: 'fixture-prior-art-service',
    serviceIdentityHash: digest(`${paperId}:prior-art-service`),
    priorArtEvidenceReceiptHash: priorArtReceipt.priorArtEvidenceReceiptHash,
    researchAgendaIrHash,
    priorArtQueryPlan,
    priorArtQueryPlanHash: priorArtQueryPlanHash(priorArtQueryPlan),
  });
  const retrievalEnvelope = fixtureAuthorityEnvelope(
    retrievalSubject.kind,
    retrievalSubject.priorArtRetrievalAuthoritySubjectHash,
    { pair: retrievalPair, ...retrievalKey, observedAt },
  );
  const retrievalSpki = hashBytes(
    retrievalPair.publicKey.export({ type: 'spki', format: 'der' }),
  );
  const reviewSpki = hashBytes(
    reviewPair.publicKey.export({ type: 'spki', format: 'der' }),
  );
  const generatorIdentityAttestation = fixtureIdentity(
    'generator', digest('generator:spki'), { principalId: 'research-author-1' }, observedAt,
  );
  const retrievalIdentityAttestation = fixtureIdentity(
    'retrieval', retrievalSpki, { serviceId: configuration.serviceId }, observedAt,
  );
  const reviewerIdentityAttestation = fixtureIdentity('reviewer', reviewSpki, {
    principalId: priorArtReceipt.independentReview.principalId,
    providerAccountIdentityHash:
      priorArtReceipt.independentReview.providerAccountIdentityHash,
    trustDomainIdentityHash: priorArtReceipt.independentReview.trustDomainIdentityHash,
  }, observedAt);
  const identityRecord = (subject) => {
    const envelope = fixtureAuthorityEnvelope(
      subject.kind,
      subject.externalPrincipalIdentityAttestationSubjectHash,
      { pair: identityPair, ...identityKey, observedAt },
    );
    return Object.freeze({
      subject,
      envelope,
      verification: fixtureVerificationReceipt({
        subjectKind: subject.kind,
        subjectHash: subject.externalPrincipalIdentityAttestationSubjectHash,
        envelope,
        ...identityKey,
        trustStoreHash: configuration.identityTrustStoreHash,
        publicKeySpkiHash: hashBytes(
          identityPair.publicKey.export({ type: 'spki', format: 'der' }),
        ),
        observedAt,
      }),
    });
  };
  const generatorIdentity = identityRecord(generatorIdentityAttestation);
  const retrievalIdentity = identityRecord(retrievalIdentityAttestation);
  const reviewerIdentity = identityRecord(reviewerIdentityAttestation);
  const retrievalIdentitySeparation = evaluateExternalPrincipalIdentitySeparation({
    candidate: retrievalIdentityAttestation,
    references: [generatorIdentityAttestation],
    now: new Date(observedAt),
    requirePlatformAttestation: true,
  });
  const reviewerIdentitySeparation = evaluateExternalPrincipalIdentitySeparation({
    candidate: reviewerIdentityAttestation,
    references: [generatorIdentityAttestation, retrievalIdentityAttestation],
    now: new Date(observedAt),
    requirePlatformAttestation: true,
  });
  const payload = {
    version: 1,
    kind: 'PriorArtRetrievalAuthorityVerificationBundle',
    status: 'prior_art_retrieval_authority_verified',
    requestHash: retrievalSubject.requestHash,
    configurationHash: configuration.configurationHash,
    trustSetHash: trustConfiguration.trustSetHash,
    signatureVerificationPolicyHash: trustConfiguration.signatureVerificationPolicyHash,
    authorityTrustConfigurationHash:
      trustConfiguration.priorArtAuthorityTrustConfigurationHash,
    priorArtEvidenceReceiptHash: priorArtReceipt.priorArtEvidenceReceiptHash,
    retrievalSubject,
    retrievalEnvelope,
    retrievalVerification: fixtureVerificationReceipt({
      subjectKind: retrievalSubject.kind,
      subjectHash: retrievalSubject.priorArtRetrievalAuthoritySubjectHash,
      envelope: retrievalEnvelope,
      ...retrievalKey,
      trustStoreHash: configuration.retrievalTrustStoreHash,
      publicKeySpkiHash: retrievalSpki,
      observedAt,
    }),
    independentReviewSubject,
    independentReviewEnvelope,
    independentReviewVerification: fixtureVerificationReceipt({
      subjectKind: independentReviewSubject.kind,
      subjectHash: independentReviewSubject.priorArtIndependentReviewAuthoritySubjectHash,
      envelope: independentReviewEnvelope,
      ...reviewKey,
      trustStoreHash: configuration.independentReviewTrustStoreHash,
      publicKeySpkiHash: reviewSpki,
      observedAt,
    }),
    generatorIdentityAttestation: generatorIdentity.subject,
    generatorIdentityEnvelope: generatorIdentity.envelope,
    generatorIdentityVerification: generatorIdentity.verification,
    retrievalIdentityAttestation: retrievalIdentity.subject,
    retrievalIdentityEnvelope: retrievalIdentity.envelope,
    retrievalIdentityVerification: retrievalIdentity.verification,
    reviewerIdentityAttestation: reviewerIdentity.subject,
    reviewerIdentityEnvelope: reviewerIdentity.envelope,
    reviewerIdentityVerification: reviewerIdentity.verification,
    retrievalIdentitySeparation,
    reviewerIdentitySeparation,
    cryptographicAuthorityReady: true,
    identityIndependenceReady: true,
    externalActionPerformed: true,
  };
  const authorityBundle = Object.freeze({
    ...payload,
    priorArtRetrievalAuthorityVerificationBundleHash: hashRecord(
      'PriorArtRetrievalAuthorityVerificationBundle', payload,
    ),
  });
  return Object.freeze({
    priorArtReceipt,
    authorityBundle,
    trustConfiguration,
    externalCapabilityTrustInspection,
  });
}
