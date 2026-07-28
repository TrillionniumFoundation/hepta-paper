import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import {
  assertPinnedExternalEvidenceEnvelope,
} from '../../paper-adapters/authority/pinned-external-evidence-verifier.mjs';
import {
  buildReviewerReceiptSignerServiceConfiguration,
  createHttpReviewerReceiptSignerAdapter,
} from '../../paper-adapters/automation/http-reviewer-receipt-signer-adapter.mjs';
import {
  createReviewerPrincipalExecutorPool,
} from '../../paper-adapters/automation/reviewer-principal-executor-pool.mjs';
import {
  buildRecoverableReviewerExecutorServiceConfiguration,
} from '../../paper-adapters/automation/http-recoverable-reviewer-executor-adapter.mjs';
import {
  createCampaignAgentPrimitivesAdapter,
} from '../../paper-adapters/automation/campaign-agent-primitives-adapter.mjs';
import {
  buildCampaignFormalReviewEnvelope,
} from '../../paper-adapters/automation/campaign-formal-review-envelope.mjs';
import {
  buildReviewerPrincipalPoolConfiguration,
} from '../../paper-adapters/automation/reviewer-principal-pool-configuration-reader.mjs';
import {
  composeReviewerPrincipalExecutorPool,
  preflightReviewerPrincipalPool,
} from '../../paper-composition/automation/reviewer-principal-pool-composition.mjs';
import {
  inspectConfiguredAutonomousResearchCapabilityScope,
} from '../../paper-composition/automation/autonomous-research-external-capability-composition.mjs';
import {
  buildCampaignConvergenceDecision,
} from '../../paper-application/automation/campaign-convergence-evaluator.mjs';
import {
  buildAutonomousResearchAuthorIdentityConfiguration,
} from '../../paper-adapters/automation/autonomous-research-author-identity-configuration.mjs';
import {
  buildSignedReviewerReceipt,
  reviewerReceiptSigningSubject,
  verifySignedReviewerReceipt,
} from '../../paper-domain/research/signed-reviewer-receipt-contract.mjs';
import {
  buildReviewerExecutionAuthorityContext,
  reviewerSemanticReviewHash,
  reviewerSemanticReceiptSigningSubject,
} from '../../paper-domain/research/reviewer-semantic-evidence-contract.mjs';
import {
  buildAutonomousResearchRuntimePrincipalBinding,
} from '../../paper-domain/automation/autonomous-research-runtime-principal-binding-contract.mjs';
import {
  verifyAgentExecutionReceipt,
} from '../../paper-domain/evidence/agent-execution-receipt-contract.mjs';
import {
  buildAutonomousResearchReleaseReviewerEvidence,
  inspectAutonomousResearchReleaseReviewerEvidence,
} from '../../paper-domain/automation/autonomous-research-release-reviewer-evidence-contract.mjs';
import {
  assertCampaignReleaseReviewerEvidenceForPackaging,
} from '../../paper-adapters/automation/campaign-release-packager.mjs';
import { buildExecutorCapabilities } from '../../paper-ports/executor-capabilities.mjs';
import { hashRecord } from '../../workflow-kernel/record-hash.mjs';
import {
  REVIEWER_CRYPTOGRAPHIC_TRUST_V2_TEST_NOW as NOW,
  reviewerCryptographicTrustV2Hash as H,
  reviewerExecutor as executor,
  reviewerPreflight,
  signedEnvelope,
  strongPoolFixture,
  trustKey,
  trustStore,
  writeReviewerCryptographicTrustV2Json as writeJson,
} from './support/reviewer-cryptographic-trust-v2-fixture.mjs';

test('reviewer v2 binds every receipt to pinned Ed25519 and signed identity separation', async (t) => {
  const fixture = strongPoolFixture(t);
  const { inspection } = fixture;
  assert.equal(inspection.cryptographicAuthorityReady, true);
  assert.equal(inspection.identityIndependenceReady, true);
  assert.match(inspection.trustSetHash, /^sha256:[0-9a-f]{64}$/);
  assert.match(inspection.signatureVerificationPolicyHash, /^sha256:[0-9a-f]{64}$/);
  assert.equal(inspection.trustInspection.blockers.length, 0);
  const authorless = preflightReviewerPrincipalPool({
    configPath: fixture.configPath,
    authorProvider: 'openai',
    authorCodexHome: path.join(fixture.root, 'author-home'),
    environment: fixture.environment,
    preflightReviewer: reviewerPreflight,
    fetchImpl: fixture.fetchImpl,
    clock: { now: () => NOW },
  });
  assert.equal(authorless.cryptographicAuthorityReady, true);
  assert.equal(authorless.identityIndependenceReady, false);
  assert.ok(authorless.trustInspection.blockers.includes(
    'reviewer_principal_author_identity_attestation_not_ready',
  ));

  const entry = inspection.entries[0];
  const principalInspection = inspection.trustInspection.principalInspections.find(
    (candidate) => candidate.principalId === entry.descriptor.principalId,
  );
  const subjectHash = reviewerReceiptSigningSubject({
    unsignedAgentExecutionReceiptHash: H('unsigned-reviewer-receipt'),
    principalDescriptorHash: entry.descriptor.principalDescriptorHash,
    researchPrincipalPoolHash: inspection.pool.researchPrincipalPoolHash,
  });
  const receipt = await entry.signer.sign({
    subjectHash,
    principal: {
      ...entry.descriptor,
      researchPrincipalPoolHash: inspection.pool.researchPrincipalPoolHash,
      identitySeparationReceipt: principalInspection.identitySeparationReceipt,
      identityReferenceSubjects: principalInspection.identityReferenceSubjects,
    },
  });
  assert.equal(receipt.version, 2);
  assert.equal(receipt.cryptographicAuthorityReady, true);
  assert.equal(receipt.identityIndependenceReady, true);
  assert.equal(Object.hasOwn(receipt, 'signatureHash'), false);
  assert.match(receipt.signatureVerificationReceiptHash, /^sha256:[0-9a-f]{64}$/);
  assert.equal(verifySignedReviewerReceipt(receipt, {
    subjectHash,
    principalId: entry.descriptor.principalId,
  }), true);
  let currentVerifierCalls = 0;
  assert.equal(verifySignedReviewerReceipt(receipt, {
    subjectHash,
    principalId: entry.descriptor.principalId,
  }, {
    cryptographicVerifier() {
      currentVerifierCalls += 1;
      return false;
    },
  }), false);
  assert.equal(currentVerifierCalls, 1);

  const expected = {
    subjectHash,
    principalId: entry.descriptor.principalId,
    principalDescriptorHash: entry.descriptor.principalDescriptorHash,
    researchPrincipalPoolHash: inspection.pool.researchPrincipalPoolHash,
    signerIdentityHash: entry.descriptor.signerIdentityHash,
  };
  const referenceSigners = inspection.entries
    .filter((candidate) => candidate !== entry)
    .map((candidate) => candidate.signer);
  const identityReferenceAuthorities = [
    inspection.trustInspection.authorIdentityAttestation,
  ];
  const reloaded = structuredClone(receipt);
  assert.equal(verifySignedReviewerReceipt(reloaded, expected), false);
  assert.equal(entry.signer.verifySignedReceipt({
    receipt: reloaded,
    expected,
    identityReferenceSigners: referenceSigners,
    identityReferenceAuthorities,
    now: NOW,
  }), true);
  assert.equal(verifySignedReviewerReceipt(reloaded, expected), true);

  const forged = structuredClone(receipt);
  forged.signatureVerificationReceipt.verifiedKeyIds = ['forged-key'];
  {
    const {
      pinnedExternalEvidenceVerificationReceiptHash: _oldVerificationHash,
      ...verificationPayload
    } = forged.signatureVerificationReceipt;
    forged.signatureVerificationReceipt.pinnedExternalEvidenceVerificationReceiptHash =
      hashRecord('PinnedExternalEvidenceVerificationReceipt', verificationPayload);
    forged.signatureVerificationReceiptHash =
      forged.signatureVerificationReceipt.pinnedExternalEvidenceVerificationReceiptHash;
    const { signedReviewerReceiptHash: _oldReceiptHash, ...receiptPayload } = forged;
    forged.signedReviewerReceiptHash = hashRecord('SignedReviewerReceiptV2', receiptPayload);
  }
  assert.equal(verifySignedReviewerReceipt(forged, expected), false);
  assert.equal(entry.signer.verifySignedReceipt({
    receipt: forged,
    expected,
    identityReferenceSigners: referenceSigners,
    identityReferenceAuthorities,
    now: NOW,
  }), false);

  const expiredReload = structuredClone(receipt);
  assert.equal(entry.signer.verifySignedReceipt({
    receipt: expiredReload,
    expected,
    identityReferenceSigners: referenceSigners,
    identityReferenceAuthorities,
    now: new Date('2026-07-19T02:02:00.000Z'),
  }), false);

  const swappedKey = crypto.generateKeyPairSync('ed25519');
  const swappedConfiguration = buildReviewerReceiptSignerServiceConfiguration({
    version: 2,
    serviceId: entry.signer.serviceId,
    endpoint: 'https://reviewer-swapped.example.test/v2/sign',
    serviceIdentityHash: H('swapped-reviewer-service'),
    tokenEnvironmentVariable: 'SWAPPED_REVIEWER_TOKEN',
    receiptTrustStore: trustStore([trustKey(swappedKey, {
      keyId: 'swapped-reviewer-key',
      role: 'reviewer_receipt_attestor',
      subjectId: 'swapped-reviewer-authority',
    })]),
    receiptSignerKeyIds: ['swapped-reviewer-key'],
  });
  const swappedAdapter = createHttpReviewerReceiptSignerAdapter({
    configuration: swappedConfiguration,
    environment: { SWAPPED_REVIEWER_TOKEN: 'token' },
    fetchImpl: async () => { throw new Error('network_not_expected'); },
    clock: { now: () => NOW },
  });
  assert.equal(swappedAdapter.verifySignedReceipt({
    receipt: structuredClone(receipt),
    expected,
    now: NOW,
  }), false);

  const tampered = structuredClone(receipt);
  tampered.authorityEnvelope.signatures[0].value = Buffer.alloc(64, 7).toString('base64');
  assert.equal(verifySignedReviewerReceipt(tampered), false);

  let semanticAgentCallCount = 0;
  const executors = new Map(inspection.pool.principals.map((principal) => (
    [principal.principalId, Object.freeze({
      executorId: `executor-${principal.principalId}`,
      capabilities: () => buildExecutorCapabilities({
        executorId: `executor-${principal.principalId}`,
        sandboxModes: ['read-only'],
        networkPolicy: 'none',
        receiptKinds: ['AgentExecutionReceipt'],
      }),
      async execute(request) {
        semanticAgentCallCount += 1;
        const structuredOutput = Object.freeze({
          verdict: 'accept',
          score: 0.91,
          criticalFindingCount: 0,
          findings: Object.freeze([]),
          summary: 'The signed semantic review accepts the manuscript.',
        });
        const payload = {
          version: 1,
          kind: 'AgentExecutionReceipt',
          status: 'agent_execution_completed',
          executorId: `executor-${principal.principalId}`,
          role: request.role,
          providerMode: 'openai',
          resolvedModel: 'reviewer-semantic-model',
          promptHash: H(`semantic-prompt:${principal.principalId}`),
          sessionId: `semantic-session:${principal.principalId}`,
          childSessionId: `semantic-session:${principal.principalId}`,
          changedPaths: [],
          structuredOutput,
          finalOutput: JSON.stringify(structuredOutput),
          externalActionPerformed: true,
        };
        return Object.freeze({
          ...payload,
          agentExecutionReceiptHash: hashRecord('AgentExecutionReceipt', payload),
        });
      },
    })]
  )));
  assert.throws(() => createReviewerPrincipalExecutorPool({
    pool: inspection.pool,
    executors,
    signers: new Map(),
    trustInspection: inspection.trustInspection,
  }), /reviewer_principal_cryptographic_signer_required/);
  const executorPool = createReviewerPrincipalExecutorPool({
    pool: inspection.pool,
    executors,
    signers: new Map(inspection.entries.map((candidate) => (
      [candidate.descriptor.principalId, candidate.signer]
    ))),
    trustInspection: inspection.trustInspection,
  });
  assert.equal(executorPool.cryptographicAuthorityReady, true);
  assert.equal(executorPool.identityIndependenceReady, true);
  await assert.rejects(() => executorPool.execute({
    role: 'independent-review',
    context: { nodeId: 'semantic-review-node' },
  }), /reviewer_principal_semantic_authority_context_required/);
  assert.equal(semanticAgentCallCount, 0);
  const semanticAuthorityContext = buildReviewerExecutionAuthorityContext({
    campaignId: 'semantic-review-campaign',
    campaignPlanHash: H('semantic-review-plan'),
    paperId: 'semantic-review-paper',
    nodeId: 'semantic-review-node',
    roundIndex: 1,
    reviewAttemptId: 'semantic-review-attempt',
    manuscriptHash: H('semantic-review-manuscript'),
  });
  const semanticReceipt = await executorPool.execute({
    role: 'independent-review',
    context: {
      campaignId: semanticAuthorityContext.campaignId,
      campaignPlanHash: semanticAuthorityContext.campaignPlanHash,
      paperId: semanticAuthorityContext.paperId,
      nodeId: semanticAuthorityContext.nodeId,
      roundIndex: semanticAuthorityContext.roundIndex,
      attemptId: semanticAuthorityContext.reviewAttemptId,
      manuscriptHash: semanticAuthorityContext.manuscriptHash,
      reviewerExecutionAuthorityContext: semanticAuthorityContext,
    },
  });
  assert.equal(semanticAgentCallCount, 1);
  assert.equal(verifyAgentExecutionReceipt(semanticReceipt), true);
  assert.deepEqual(
    semanticReceipt.unsignedAgentExecutionReceipt.reviewerExecutionAuthorityContext,
    semanticAuthorityContext,
  );
  assert.equal(
    semanticReceipt.signedReviewerReceipt.subjectHash,
    reviewerSemanticReceiptSigningSubject({
      unsignedAgentExecutionReceipt: semanticReceipt.unsignedAgentExecutionReceipt,
      principalDescriptorHash: semanticReceipt.reviewPrincipalDescriptorHash,
      researchPrincipalPoolHash: semanticReceipt.researchPrincipalPoolHash,
    }),
  );
  assert.equal(executorPool.verifySignedReviewerReceipt({
    receipt: structuredClone(semanticReceipt.signedReviewerReceipt),
    expected: {
      subjectHash: semanticReceipt.signedReviewerReceipt.subjectHash,
      principalId: semanticReceipt.reviewPrincipalId,
      principalDescriptorHash: semanticReceipt.reviewPrincipalDescriptorHash,
      researchPrincipalPoolHash: semanticReceipt.researchPrincipalPoolHash,
      signerIdentityHash: semanticReceipt.reviewerSignerIdentityHash,
    },
  }), true);
  await assert.rejects(() => executorPool.execute({
    role: 'independent-review',
    context: {
      campaignId: semanticAuthorityContext.campaignId,
      campaignPlanHash: semanticAuthorityContext.campaignPlanHash,
      paperId: semanticAuthorityContext.paperId,
      nodeId: semanticAuthorityContext.nodeId,
      roundIndex: semanticAuthorityContext.roundIndex,
      attemptId: 'mismatched-review-attempt',
      manuscriptHash: semanticAuthorityContext.manuscriptHash,
      reviewerExecutionAuthorityContext: semanticAuthorityContext,
    },
  }), /reviewer_principal_semantic_authority_context_required/);
  assert.equal(semanticAgentCallCount, 1);

  const restartSignedReceipt = structuredClone(receipt);
  const persistedReviewReceipt = {
    providerMode: 'openai',
    executorId: 'persisted-reviewer-executor',
    agentId: entry.descriptor.principalId,
    agentExecutionReceiptHash: H('persisted-review-agent-receipt'),
    codexFormalReviewerCapabilityReceiptHash: H('persisted-reviewer-capability'),
    codexCredentialRootIdentityHash: entry.descriptor.credentialRootIdentityHash,
    codexCredentialConfigIdentityHash: entry.descriptor.credentialConfigIdentityHash,
    codexBinaryIdentityHash: H('persisted-reviewer-binary'),
    codexCredentialIndependenceVerified: false,
    codexProviderCredentialSharingPermitted: true,
    codexFreshEphemeralSessionRequired: true,
    codexAuthorContextInheritanceForbidden: true,
    codexFrozenArtifactReviewRequired: true,
    sessionIsolation: 'fresh_ephemeral_no_resume',
    contextInheritance: 'forbidden',
    codexReviewerAssuranceScope:
      'ephemeral_session_frozen_artifact_and_role_separation',
    codexProviderAccountIndependenceVerified: false,
    codexAuthenticationStatus: 'codex_authentication_verified',
    reviewPrincipalId: entry.descriptor.principalId,
    reviewPrincipalDescriptorHash: entry.descriptor.principalDescriptorHash,
    reviewerProviderAccountIdentityHash: entry.descriptor.providerAccountIdentityHash,
    reviewerCredentialRootIdentityHash: entry.descriptor.credentialRootIdentityHash,
    reviewerTrustDomainIdentityHash: entry.descriptor.trustDomainIdentityHash,
    reviewerSignerIdentityHash: entry.descriptor.signerIdentityHash,
    researchPrincipalPoolHash: inspection.pool.researchPrincipalPoolHash,
    unsignedAgentExecutionReceiptHash: H('unsigned-reviewer-receipt'),
    signedReviewerReceiptHash: restartSignedReceipt.signedReviewerReceiptHash,
    signedReviewerReceipt: restartSignedReceipt,
    signatureVerificationReceiptHash:
      restartSignedReceipt.signatureVerificationReceiptHash,
    structuredOutput: null,
    finalOutput: '',
  };
  const persistedAuthorReceipt = {
    providerMode: 'openclaw:detached-child-session',
    executorId: 'persisted-author-executor',
    agentId: 'persisted-author',
    agentCapabilityProfileHash: H('persisted-author-capability'),
    openClawAgentConfigurationHash: H('persisted-author-configuration'),
    openClawGatewayConfigurationHash: H('persisted-author-gateway'),
    agentExecutionReceiptHash: H('persisted-author-agent-receipt'),
  };
  fs.writeFileSync(path.join(fixture.root, 'main.tex'), 'Persisted review fixture.\n');
  const envelopeInput = {
    campaign: {
      paperId: 'persisted-review-paper',
      campaignId: 'persisted-review-campaign',
      spec: { autonomousResearchPreparation: {
        researchPrincipalPoolHash: inspection.pool.researchPrincipalPoolHash,
      } },
    },
    node: { nodeId: 'persisted-formal-review', attemptId: 'persisted-attempt' },
    authorNode: { nodeId: 'persisted-formal-author', result: persistedAuthorReceipt },
    receipt: persistedReviewReceipt,
    workspace: fixture.root,
    manuscript: 'main.tex',
  };
  const withoutRestoredVerifier = buildCampaignFormalReviewEnvelope(envelopeInput);
  assert.ok(withoutRestoredVerifier.blockers.includes(
    'formal_review_signed_principal_pool_binding_invalid',
  ));
  const restartedAuthorIdentityAttestation = Object.freeze({
    subject: fixture.authorIdentitySource.subject,
    verificationReceipt: assertPinnedExternalEvidenceEnvelope({
      envelope: fixture.authorIdentitySource.authorityEnvelope,
      subjectKind: 'ExternalPrincipalIdentityAttestationSubject',
      subjectHash: fixture.authorIdentitySource.subject
        .externalPrincipalIdentityAttestationSubjectHash,
      trustStore: fixture.authorIdentitySource.trustStore,
      requiredRole: 'external_principal_identity_attestor',
      expectedKeyIds: ['author-identity-key'],
      now: NOW,
      maximumLifetimeMs: 5 * 60 * 1000,
    }),
  });
  const restartedInspection = preflightReviewerPrincipalPool({
    configPath: fixture.configPath,
    authorProvider: 'openai',
    authorCodexHome: path.join(fixture.root, 'author-home'),
    environment: fixture.environment,
    preflightReviewer: reviewerPreflight,
    fetchImpl: fixture.fetchImpl,
    clock: { now: () => NOW },
    authorIdentityAttestation: restartedAuthorIdentityAttestation,
  });
  const restartedExecutors = new Map(restartedInspection.pool.principals.map((principal) => (
    [principal.principalId, executor(principal.principalId)]
  )));
  const restartedExecutorPool = createReviewerPrincipalExecutorPool({
    pool: restartedInspection.pool,
    executors: restartedExecutors,
    signers: new Map(restartedInspection.entries.map((candidate) => (
      [candidate.descriptor.principalId, candidate.signer]
    ))),
    trustInspection: restartedInspection.trustInspection,
  });
  const restoredPrimitives = createCampaignAgentPrimitivesAdapter({
    agentExecutor: executor('persisted-author'),
    reviewerPrincipalExecutorPool: restartedExecutorPool,
  });
  const afterRestart = restoredPrimitives.buildFormalReviewEnvelope(envelopeInput);
  assert.equal(afterRestart.blockers.includes(
    'formal_review_signed_principal_pool_binding_invalid',
  ), false);
  assert.notEqual(afterRestart.reviewerPrincipalId, null);
});

test('production v2 composition uses signed recoverable executors and fails closed on credential aliasing', (t) => {
  const fixture = strongPoolFixture(t, { recoverySigner: true });
  const composed = composeReviewerPrincipalExecutorPool({
    configPath: fixture.configPath,
    authorProvider: 'openai',
    authorCodexHome: path.join(fixture.root, 'author-home'),
    runtimeRoot: fixture.root,
    environment: fixture.environment,
    preflightReviewer: reviewerPreflight,
    fetchImpl: fixture.fetchImpl,
    clock: { now: () => NOW },
    authorIdentityAttestation: fixture.authorIdentityAttestation,
  });
  assert.equal(composed.configuration.version, 2);
  assert.equal(composed.executorPool.crashRecoveryReady, true);
  assert.deepEqual(composed.executorPool.crashRecoveryBlockers, []);
  assert.equal(
    composed.executorPool.reviewerRecoveryPort
      ?.recoveryOutcomeCryptographicAuthorityReady,
    true,
  );
  assert.equal(
    composed.executorPool.signerRecoveryPort
      ?.recoveryOutcomeCryptographicAuthorityReady,
    true,
  );

  const aliasedPrincipals = fixture.configuration.principals.map(
    (principal, index) => ({
      ...principal,
      recoverableExecutorConfiguration: index === 0
        ? principal.recoverableExecutorConfiguration
        : buildRecoverableReviewerExecutorServiceConfiguration({
          ...principal.recoverableExecutorConfiguration,
          tokenEnvironmentVariable: fixture.configuration.principals[0]
            .recoverableExecutorConfiguration.tokenEnvironmentVariable,
        }),
    }),
  );
  assert.throws(() => buildReviewerPrincipalPoolConfiguration({
    version: 2,
    poolId: 'aliased-reviewer-credentials',
    minimumReviewerTrustDomains: 2,
    principals: aliasedPrincipals,
  }), /reviewer_principal_pool_service_credential_reference_independence_invalid/);
});

test('static readiness binds the pinned author identity into the v2 reviewer pool', (t) => {
  const fixture = strongPoolFixture(t);
  const authorConfiguration = buildAutonomousResearchAuthorIdentityConfiguration({
    ...fixture.authorIdentitySource,
    signerKeyIds: ['author-identity-key'],
    maximumLifetimeMs: 5 * 60 * 1000,
  });
  const authorConfigPath = path.join(fixture.root, 'author-identity.json');
  writeJson(authorConfigPath, authorConfiguration);
  const researchAuthorPreflight = Object.freeze({
    effectivePrincipalId: fixture.authorIdentitySource.subject.principalId,
    codexHome: path.join(fixture.root, 'author-home'),
    capabilityReceipt: Object.freeze({
      provider: fixture.authorIdentitySource.subject.provider,
      credentialRootIdentityHash:
        fixture.authorIdentitySource.subject.credentialRootIdentityHash,
    }),
  });
  const inspection = inspectConfiguredAutonomousResearchCapabilityScope({
    environment: {
      ...fixture.environment,
      HEPTA_AUTONOMOUS_RESEARCH_CONTENT_MODE: 'agent-evidence-bound',
      HEPTA_RESEARCH_AUTHOR_IDENTITY_CONFIG: authorConfigPath,
      HEPTA_RESEARCH_AUTHOR_IDENTITY_CONFIG_HASH:
        authorConfiguration.configurationHash,
      HEPTA_REVIEWER_PRINCIPAL_POOL_CONFIG: fixture.configPath,
    },
    providerInspections: { researchAuthorPreflight },
    providerSpawnSync: () => ({ status: 1, stdout: '', stderr: '' }),
    reviewerPreflight,
    clock: { now: () => NOW },
  });
  assert.equal(inspection.authorIdentityAttestationReady, true);
  assert.equal(inspection.authorIdentitySubjectHash,
    fixture.authorIdentitySource.subject
      .externalPrincipalIdentityAttestationSubjectHash);
  assert.equal(inspection.externalCapabilityTrustInspection
    .components.reviewerPool.ready, true);
  assert.equal(inspection.externalCapabilityTrustInspection
    .components.reviewerPool.identityIndependenceReady, true);
  assert.equal(inspection.blockers.some((blocker) => (
    blocker.startsWith('reviewer-principal-pool:')
  )), false);
});

test('persisted v2 referee receipts are reverified before convergence', async (t) => {
  const fixture = strongPoolFixture(t);
  const { inspection } = fixture;
  const manuscriptHash = H('persisted-convergence-manuscript');
  const campaignId = 'persisted-v2-campaign';
  const campaignPlanHash = H('persisted-v2-plan');
  const paperId = 'persisted-v2-convergence';
  const reviews = [];
  for (const [index, entry] of inspection.entries.entries()) {
    const principalInspection = inspection.trustInspection.principalInspections.find(
      (candidate) => candidate.principalId === entry.descriptor.principalId,
    );
    const reviewAttemptId = `attempt:persisted-reviewer-${index + 1}:1`;
    const nodeId = `revision-referee-${index + 1}`;
    const reviewerExecutionAuthorityContext = buildReviewerExecutionAuthorityContext({
      campaignId,
      campaignPlanHash,
      paperId,
      nodeId,
      roundIndex: 1,
      reviewAttemptId,
      manuscriptHash,
    });
    const unsignedPayload = {
      version: 1,
      kind: 'AgentExecutionReceipt',
      status: 'agent_execution_completed',
      executorId: `persisted-executor:${entry.descriptor.principalId}`,
      role: 'independent-review',
      providerMode: 'openai',
      resolvedModel: 'persisted-reviewer-model',
      promptHash: H(`persisted-prompt:${entry.descriptor.principalId}`),
      sessionId: `persisted-session:${entry.descriptor.principalId}`,
      childSessionId: `persisted-session:${entry.descriptor.principalId}`,
      changedPaths: [],
      structuredOutput: {
        verdict: 'accept', score: 0.9, criticalFindingCount: 0,
        findings: [], summary: 'Persisted signed reviewer accepted.',
      },
      finalOutput: '',
      externalActionPerformed: true,
      reviewPrincipalId: entry.descriptor.principalId,
      reviewPrincipalDescriptorHash: entry.descriptor.principalDescriptorHash,
      reviewerProviderAccountIdentityHash: entry.descriptor.providerAccountIdentityHash,
      reviewerCredentialRootIdentityHash: entry.descriptor.credentialRootIdentityHash,
      reviewerTrustDomainIdentityHash: entry.descriptor.trustDomainIdentityHash,
      reviewerSignerIdentityHash: entry.descriptor.signerIdentityHash,
      researchPrincipalPoolHash: inspection.pool.researchPrincipalPoolHash,
      reviewerCryptographicAuthorityReady: true,
      reviewerIdentityIndependenceReady: true,
      reviewerTrustSetHash: inspection.trustSetHash,
      reviewerSignatureVerificationPolicyHash: inspection.signatureVerificationPolicyHash,
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
      principalDescriptorHash: entry.descriptor.principalDescriptorHash,
      researchPrincipalPoolHash: inspection.pool.researchPrincipalPoolHash,
    });
    const signedReviewerReceipt = await entry.signer.sign({
      subjectHash,
      principal: {
        ...entry.descriptor,
        researchPrincipalPoolHash: inspection.pool.researchPrincipalPoolHash,
        identitySeparationReceipt: principalInspection.identitySeparationReceipt,
        identityReferenceSubjects: principalInspection.identityReferenceSubjects,
      },
    });
    reviews.push(Object.freeze({
      reviewerId: entry.descriptor.principalId,
      role: 'independent-review',
      verdict: 'accept',
      score: 0.9,
      criticalFindingCount: 0,
      findings: [],
      summary: 'Persisted signed reviewer accepted.',
      reviewHash: reviewerSemanticReviewHash({ unsignedAgentExecutionReceipt }),
      manuscriptHash,
      childSessionId: `persisted-session:${entry.descriptor.principalId}`,
      reviewPrincipalId: entry.descriptor.principalId,
      reviewPrincipalDescriptorHash: entry.descriptor.principalDescriptorHash,
      reviewerProviderAccountIdentityHash:
        entry.descriptor.providerAccountIdentityHash,
      reviewerCredentialRootIdentityHash:
        entry.descriptor.credentialRootIdentityHash,
      reviewerTrustDomainIdentityHash:
        entry.descriptor.trustDomainIdentityHash,
      reviewerSignerIdentityHash: entry.descriptor.signerIdentityHash,
      signedReviewerReceiptHash: signedReviewerReceipt.signedReviewerReceiptHash,
      signedReviewerReceipt: structuredClone(signedReviewerReceipt),
      unsignedAgentExecutionReceiptHash,
      unsignedAgentExecutionReceipt,
      signatureVerificationReceiptHash:
        signedReviewerReceipt.signatureVerificationReceiptHash,
      researchPrincipalPoolHash: inspection.pool.researchPrincipalPoolHash,
      reviewAttemptId,
      campaignId,
      campaignPlanHash,
      paperId,
      nodeId,
      roundIndex: 1,
      promptHash: unsignedPayload.promptHash,
      resolvedModel: unsignedPayload.resolvedModel,
      selectedExecutorId: unsignedPayload.executorId,
    }));
  }
  const input = {
    campaign: {
      campaignId,
      paperId,
      spec: {
        campaignPlanHash,
        refereeCount: 2,
        autonomousResearchPreparation: {
          capabilityScopeManifest: { reviewerTrustDomainCount: 2 },
        },
      },
    },
    node: { roundIndex: 1 },
    nodes: reviews.map((result, index) => ({
      nodeId: result.nodeId,
      kind: `revision-referee-${index + 1}`,
      roundIndex: 1,
      attemptId: result.reviewAttemptId,
      result,
    })),
    executionResult: { qualityGates: [], revisionMaterialization: null },
  };
  const withoutVerifier = buildCampaignConvergenceDecision(input);
  assert.equal(withoutVerifier.signedReviewerReceiptsVerified, false);
  assert.equal(withoutVerifier.accepted, false);
  let verificationCount = 0;
  const persistedVerifier = ({ receipt, expected }) => {
    verificationCount += 1;
    const entry = inspection.entries.find((candidate) => (
      candidate.descriptor.principalId === expected.principalId
    ));
    return entry?.signer.verifySignedReceipt({
      receipt,
      expected,
      identityReferenceSigners: inspection.entries
        .filter((candidate) => candidate !== entry)
        .map((candidate) => candidate.signer),
      identityReferenceAuthorities: [
        inspection.trustInspection.authorIdentityAttestation,
      ],
      now: NOW,
    }) === true;
  };
  const withVerifier = buildCampaignConvergenceDecision({
    ...input,
    signedReviewerReceiptVerifier: persistedVerifier,
  });
  assert.equal(verificationCount, 2);
  assert.equal(withVerifier.signedReviewerReceiptsVerified, true);
  assert.equal(withVerifier.accepted, true);
  for (const [field, replacement] of [
    ['nodeId', 'replacement-current-review-node'],
    ['attemptId', 'replacement-current-review-attempt'],
  ]) {
    const replayedInput = structuredClone(input);
    replayedInput.nodes[0][field] = replacement;
    const replayedDecision = buildCampaignConvergenceDecision({
      ...replayedInput,
      signedReviewerReceiptVerifier: persistedVerifier,
    });
    assert.equal(replayedDecision.reviewSemanticEvidenceBound, false, field);
    assert.equal(replayedDecision.signedReviewerReceiptsVerified, false, field);
    assert.equal(replayedDecision.accepted, false, field);
  }

  const runtimePrincipalBinding = buildAutonomousResearchRuntimePrincipalBinding({
    authorPrincipalId: fixture.authorIdentitySource.subject.principalId,
    authorIdentityConfigurationHash: H('author-identity-configuration'),
    authorIdentitySubjectHash: fixture.authorIdentitySource.subject
      .externalPrincipalIdentityAttestationSubjectHash,
    authorCapabilityReceiptHash: H('author-capability'),
    authorCredentialRootIdentityHash:
      fixture.authorIdentitySource.subject.credentialRootIdentityHash,
    researchPrincipalPoolHash: inspection.pool.researchPrincipalPoolHash,
    reviewerTrustSetHash: inspection.trustSetHash,
    reviewerSignatureVerificationPolicyHash:
      inspection.signatureVerificationPolicyHash,
  });
  const reviewerEvidenceAuthority = Object.freeze({
    researchPrincipalPoolHash: inspection.pool.researchPrincipalPoolHash,
    reviewerTrustSetHash: inspection.trustSetHash,
    reviewerSignatureVerificationPolicyHash:
      inspection.signatureVerificationPolicyHash,
    verifySignedReviewerReceipt: persistedVerifier,
  });
  let rejectingCurrentVerifierCalls = 0;
  const rejectingCurrentAuthority = Object.freeze({
    ...reviewerEvidenceAuthority,
    verifySignedReviewerReceipt() {
      rejectingCurrentVerifierCalls += 1;
      return false;
    },
  });
  assert.throws(() => buildAutonomousResearchReleaseReviewerEvidence({
    campaignId,
    paperId: input.campaign.paperId,
    campaignPlanHash,
    expectedManuscriptHash: manuscriptHash,
    refereeConvergenceDecision: withVerifier,
    runtimePrincipalBinding,
    reviewerEvidenceAuthority: rejectingCurrentAuthority,
  }), /autonomous_research_release_reviewer_evidence_invalid/);
  assert.ok(rejectingCurrentVerifierCalls > 0);
  const evidence = buildAutonomousResearchReleaseReviewerEvidence({
    campaignId,
    paperId: input.campaign.paperId,
    campaignPlanHash,
    expectedManuscriptHash: manuscriptHash,
    refereeConvergenceDecision: structuredClone(withVerifier),
    runtimePrincipalBinding,
    reviewerEvidenceAuthority,
  });
  const persistedEvidence = structuredClone(evidence);
  assert.equal(inspectAutonomousResearchReleaseReviewerEvidence(
    persistedEvidence,
    {
      runtimePrincipalBinding,
      reviewerEvidenceAuthority,
      expected: {
        campaignId,
        paperId: input.campaign.paperId,
        campaignPlanHash,
        expectedManuscriptHash: manuscriptHash,
      },
    },
  ).valid, true);
  const rehashReleaseEvidence = (candidate) => {
    const decision = candidate.refereeConvergenceDecision;
    const {
      refereeConvergenceDecisionHash: _oldDecisionHash,
      ...decisionPayload
    } = decision;
    decision.refereeConvergenceDecisionHash = hashRecord(
      'RefereeConvergenceDecision',
      decisionPayload,
    );
    candidate.refereeConvergenceDecisionHash =
      decision.refereeConvergenceDecisionHash;
    const {
      autonomousResearchReleaseReviewerEvidenceHash: _oldEvidenceHash,
      ...evidencePayload
    } = candidate;
    candidate.autonomousResearchReleaseReviewerEvidenceHash = hashRecord(
      'AutonomousResearchReleaseReviewerEvidence',
      evidencePayload,
    );
    return candidate;
  };
  const oppositeOuterSemantics = rehashReleaseEvidence(
    structuredClone(persistedEvidence),
  );
  Object.assign(oppositeOuterSemantics.refereeConvergenceDecision.reviews[0], {
    verdict: 'revise',
    score: 0.1,
    criticalFindingCount: 3,
    reviewHash: H('attacker-rehashed-opposite-review'),
  });
  rehashReleaseEvidence(oppositeOuterSemantics);
  const oppositeInspection = inspectAutonomousResearchReleaseReviewerEvidence(
    oppositeOuterSemantics,
    {
      runtimePrincipalBinding,
      reviewerEvidenceAuthority,
      expected: {
        campaignId,
        paperId,
        campaignPlanHash,
        expectedManuscriptHash: manuscriptHash,
      },
    },
  );
  assert.equal(oppositeInspection.valid, false);
  assert.ok(oppositeInspection.blockers.includes(
    'release_reviewer_evidence_receipt_cryptographic_verification_failed',
  ));
  const rehashedUnsignedSemantics = structuredClone(persistedEvidence);
  const rehashedUnsignedReview = rehashedUnsignedSemantics
    .refereeConvergenceDecision.reviews[0];
  const rehashedUnsignedReceipt = rehashedUnsignedReview
    .unsignedAgentExecutionReceipt;
  rehashedUnsignedReceipt.structuredOutput = {
    verdict: 'revise',
    score: 0.1,
    criticalFindingCount: 3,
    findings: ['Attacker-rewritten finding.'],
    summary: 'Attacker-rewritten semantic review.',
  };
  rehashedUnsignedReceipt.finalOutput = JSON.stringify(
    rehashedUnsignedReceipt.structuredOutput,
  );
  {
    const {
      agentExecutionReceiptHash: _oldUnsignedHash,
      ...unsignedPayload
    } = rehashedUnsignedReceipt;
    rehashedUnsignedReceipt.agentExecutionReceiptHash = hashRecord(
      'AgentExecutionReceipt',
      unsignedPayload,
    );
  }
  Object.assign(rehashedUnsignedReview, {
    ...rehashedUnsignedReceipt.structuredOutput,
    reviewHash: reviewerSemanticReviewHash({
      unsignedAgentExecutionReceipt: rehashedUnsignedReceipt,
    }),
    unsignedAgentExecutionReceiptHash:
      rehashedUnsignedReceipt.agentExecutionReceiptHash,
  });
  rehashedUnsignedSemantics.unsignedAgentExecutionReceipts[0] =
    rehashedUnsignedReceipt;
  rehashedUnsignedSemantics.unsignedAgentExecutionReceiptHashes[0] =
    rehashedUnsignedReceipt.agentExecutionReceiptHash;
  rehashReleaseEvidence(rehashedUnsignedSemantics);
  const rehashedUnsignedInspection = inspectAutonomousResearchReleaseReviewerEvidence(
    rehashedUnsignedSemantics,
    { runtimePrincipalBinding, reviewerEvidenceAuthority },
  );
  assert.equal(rehashedUnsignedInspection.valid, false);
  assert.ok(rehashedUnsignedInspection.blockers.includes(
    'release_reviewer_evidence_receipt_cryptographic_verification_failed',
  ));

  for (const [field, transplanted] of [
    ['campaignId', 'transplanted-review-campaign'],
    ['campaignPlanHash', H('transplanted-review-campaign-plan')],
  ]) {
    const transplantedEvidence = structuredClone(persistedEvidence);
    transplantedEvidence[field] = transplanted;
    transplantedEvidence.refereeConvergenceDecision[field] = transplanted;
    rehashReleaseEvidence(transplantedEvidence);
    const transplantedInspection = inspectAutonomousResearchReleaseReviewerEvidence(
      transplantedEvidence,
      {
        runtimePrincipalBinding,
        reviewerEvidenceAuthority,
        expected: {
          campaignId: transplantedEvidence.campaignId,
          paperId,
          campaignPlanHash: transplantedEvidence.campaignPlanHash,
          expectedManuscriptHash: manuscriptHash,
        },
      },
    );
    assert.equal(transplantedInspection.valid, false, field);
    assert.ok(transplantedInspection.blockers.includes(
      'release_reviewer_evidence_receipt_cryptographic_verification_failed',
    ), field);
  }
  const replacedAttemptEvidence = structuredClone(persistedEvidence);
  replacedAttemptEvidence.refereeConvergenceDecision
    .expectedReviewerContexts[0].reviewAttemptId =
      'replacement-release-review-attempt';
  replacedAttemptEvidence.refereeConvergenceDecision
    .expectedReviewerContextsHash = hashRecord(
      'ExpectedReviewerExecutionContexts',
      replacedAttemptEvidence.refereeConvergenceDecision.expectedReviewerContexts,
    );
  rehashReleaseEvidence(replacedAttemptEvidence);
  const replacedAttemptInspection = inspectAutonomousResearchReleaseReviewerEvidence(
    replacedAttemptEvidence,
    {
      runtimePrincipalBinding,
      reviewerEvidenceAuthority,
      expected: {
        campaignId,
        paperId,
        campaignPlanHash,
        expectedManuscriptHash: manuscriptHash,
      },
    },
  );
  assert.equal(replacedAttemptInspection.valid, false);
  assert.ok(replacedAttemptInspection.blockers.includes(
    'release_reviewer_evidence_receipt_cryptographic_verification_failed',
  ));
  const restartCampaign = Object.freeze({
    campaignId,
    paperId: input.campaign.paperId,
    spec: Object.freeze({
      campaignPlanHash,
      autonomousResearchPreparation: Object.freeze({
        launchMode: 'production-run',
        runtimePrincipalBinding,
      }),
    }),
  });
  assert.doesNotThrow(() => assertCampaignReleaseReviewerEvidenceForPackaging({
    campaign: restartCampaign,
    releaseBinding: { releaseReviewerEvidence: persistedEvidence },
    reviewerEvidenceAuthority,
    expectedManuscriptHash: manuscriptHash,
    errorCode: 'campaign_release_immutable_reviewer_evidence_invalid',
  }));
  assert.throws(() => assertCampaignReleaseReviewerEvidenceForPackaging({
    campaign: restartCampaign,
    releaseBinding: { releaseReviewerEvidence: persistedEvidence },
    reviewerEvidenceAuthority: null,
    expectedManuscriptHash: manuscriptHash,
    errorCode: 'campaign_release_immutable_reviewer_evidence_invalid',
  }), /campaign_release_immutable_reviewer_evidence_invalid/);

  const rotatedAuthority = {
    ...reviewerEvidenceAuthority,
    reviewerTrustSetHash: H('rotated-reviewer-trust-set'),
  };
  assert.equal(inspectAutonomousResearchReleaseReviewerEvidence(
    persistedEvidence,
    { runtimePrincipalBinding, reviewerEvidenceAuthority: rotatedAuthority },
  ).valid, false);

  const tamperedEvidence = structuredClone(persistedEvidence);
  const tamperedReceipt = tamperedEvidence.refereeConvergenceDecision
    .reviews[0].signedReviewerReceipt;
  tamperedReceipt.authorityEnvelope.signatures[0].value =
    Buffer.alloc(64, 9).toString('base64');
  tamperedReceipt.authorityEnvelopeHash = hashRecord(
    'PinnedExternalEvidenceEnvelope',
    tamperedReceipt.authorityEnvelope,
  );
  tamperedReceipt.signatureVerificationReceipt.envelopeHash =
    tamperedReceipt.authorityEnvelopeHash;
  {
    const {
      pinnedExternalEvidenceVerificationReceiptHash: _oldVerificationHash,
      ...verificationPayload
    } = tamperedReceipt.signatureVerificationReceipt;
    tamperedReceipt.signatureVerificationReceipt
      .pinnedExternalEvidenceVerificationReceiptHash = hashRecord(
        'PinnedExternalEvidenceVerificationReceipt',
        verificationPayload,
      );
    tamperedReceipt.signatureVerificationReceiptHash = tamperedReceipt
      .signatureVerificationReceipt.pinnedExternalEvidenceVerificationReceiptHash;
    const { signedReviewerReceiptHash: _oldReceiptHash, ...receiptPayload } = tamperedReceipt;
    tamperedReceipt.signedReviewerReceiptHash = hashRecord(
      'SignedReviewerReceiptV2',
      receiptPayload,
    );
  }
  const tamperedReview = tamperedEvidence.refereeConvergenceDecision.reviews[0];
  tamperedReview.signedReviewerReceiptHash = tamperedReceipt.signedReviewerReceiptHash;
  tamperedReview.signatureVerificationReceiptHash =
    tamperedReceipt.signatureVerificationReceiptHash;
  {
    const decision = tamperedEvidence.refereeConvergenceDecision;
    const { refereeConvergenceDecisionHash: _oldDecisionHash, ...decisionPayload } = decision;
    decision.refereeConvergenceDecisionHash = hashRecord(
      'RefereeConvergenceDecision',
      decisionPayload,
    );
    tamperedEvidence.refereeConvergenceDecisionHash =
      decision.refereeConvergenceDecisionHash;
    tamperedEvidence.signedReviewerReceipts[0] = tamperedReceipt;
    tamperedEvidence.signedReviewerReceiptHashes[0] =
      tamperedReceipt.signedReviewerReceiptHash;
    const {
      autonomousResearchReleaseReviewerEvidenceHash: _oldEvidenceHash,
      ...evidencePayload
    } = tamperedEvidence;
    tamperedEvidence.autonomousResearchReleaseReviewerEvidenceHash = hashRecord(
      'AutonomousResearchReleaseReviewerEvidence',
      evidencePayload,
    );
  }
  const tamperedInspection = inspectAutonomousResearchReleaseReviewerEvidence(
    tamperedEvidence,
    { runtimePrincipalBinding, reviewerEvidenceAuthority },
  );
  assert.equal(tamperedInspection.valid, false);
  assert.ok(tamperedInspection.blockers.includes(
    'release_reviewer_evidence_receipt_cryptographic_verification_failed',
  ));
  assert.throws(() => buildAutonomousResearchReleaseReviewerEvidence({
    campaignId: 'missing-convergence',
    paperId: input.campaign.paperId,
    campaignPlanHash: H('missing-convergence-plan'),
    expectedManuscriptHash: manuscriptHash,
    refereeConvergenceDecision: null,
    runtimePrincipalBinding,
    reviewerEvidenceAuthority,
  }), /autonomous_research_release_reviewer_evidence_invalid/);
});

test('reviewer v2 rejects wrong key, role, expiry, and signing-subject tampering', async (t) => {
  const fixture = strongPoolFixture(t);
  const base = fixture.fixtures[0];
  const entry = fixture.inspection.entries.find((candidate) => (
    candidate.descriptor.principalId === base.principalId
  ));
  const principalInspection = fixture.inspection.trustInspection.principalInspections.find(
    (candidate) => candidate.principalId === base.principalId,
  );
  const subjectHash = reviewerReceiptSigningSubject({
    unsignedAgentExecutionReceiptHash: H('negative-unsigned-reviewer-receipt'),
    principalDescriptorHash: entry.descriptor.principalDescriptorHash,
    researchPrincipalPoolHash: fixture.inspection.pool.researchPrincipalPoolHash,
  });
  const principal = {
    ...entry.descriptor,
    researchPrincipalPoolHash: fixture.inspection.pool.researchPrincipalPoolHash,
    identitySeparationReceipt: principalInspection.identitySeparationReceipt,
    identityReferenceSubjects: principalInspection.identityReferenceSubjects,
  };
  const attacker = crypto.generateKeyPairSync('ed25519');
  const cases = [
    {
      label: 'wrong-key',
      pair: attacker,
      role: 'reviewer_receipt_attestor',
      subjectHash,
    },
    {
      label: 'wrong-role',
      pair: base.receiptKey,
      role: 'untrusted_reviewer_role',
      subjectHash,
    },
    {
      label: 'expired',
      pair: base.receiptKey,
      role: 'reviewer_receipt_attestor',
      subjectHash,
      signedAt: '2026-07-19T01:00:00.000Z',
      expiresAt: '2026-07-19T01:01:00.000Z',
    },
    {
      label: 'tampered-subject',
      pair: base.receiptKey,
      role: 'reviewer_receipt_attestor',
      subjectHash: H('different-reviewer-subject'),
    },
  ];
  for (const candidate of cases) {
    const adapter = createHttpReviewerReceiptSignerAdapter({
      configuration: base.signerConfiguration,
      environment: fixture.environment,
      clock: { now: () => NOW },
      fetchImpl: async (_url, init) => {
        const request = JSON.parse(init.body);
        return {
          ok: true,
          async json() {
            return {
              requestHash: request.requestHash,
              serviceId: base.serviceId,
              serviceIdentityHash: base.signerConfiguration.serviceIdentityHash,
              externalActionPerformed: true,
              authorityEnvelope: signedEnvelope(candidate.pair, {
                subjectKind: 'ReviewerReceiptSigningSubjectV1',
                subjectHash: candidate.subjectHash,
                keyId: base.receiptKeyId,
                role: candidate.role,
                ...(candidate.signedAt ? { signedAt: candidate.signedAt } : {}),
                ...(candidate.expiresAt ? { expiresAt: candidate.expiresAt } : {}),
              }),
            };
          },
        };
      },
    });
    await assert.rejects(
      adapter.sign({ subjectHash, principal }),
      /pinned_external_evidence_verification_capability_invalid/,
      candidate.label,
    );
  }
});

test('cryptographic reviewer signer without signed identity evidence remains independence-blocked', () => {
  const pair = crypto.generateKeyPairSync('ed25519');
  const configuration = buildReviewerReceiptSignerServiceConfiguration({
    version: 2,
    serviceId: 'reviewer-no-identity',
    endpoint: 'https://reviewer-no-identity.example.test/v2/sign',
    serviceIdentityHash: H('reviewer-no-identity-service'),
    tokenEnvironmentVariable: 'REVIEWER_NO_IDENTITY_TOKEN',
    receiptTrustStore: trustStore([trustKey(pair, {
      keyId: 'reviewer-no-identity-key',
      role: 'reviewer_receipt_attestor',
      subjectId: 'reviewer-no-identity-authority',
    })]),
    receiptSignerKeyIds: ['reviewer-no-identity-key'],
  });
  const adapter = createHttpReviewerReceiptSignerAdapter({
    configuration,
    environment: { REVIEWER_NO_IDENTITY_TOKEN: 'token' },
    fetchImpl: async () => { throw new Error('network_not_expected'); },
    clock: { now: () => NOW },
  });
  assert.equal(adapter.cryptographicAuthorityReady, true);
  assert.equal(adapter.identityIndependenceReady, false);
  assert.match(adapter.trustSetHash, /^sha256:[0-9a-f]{64}$/);
  assert.match(adapter.signatureVerificationPolicyHash, /^sha256:[0-9a-f]{64}$/);
});

test('legacy signed reviewer receipt validation remains fail-closed at every public boundary', () => {
  assert.throws(() => reviewerReceiptSigningSubject({}),
    /reviewer_receipt_signing_subject_invalid/);
  const input = {
    subjectHash: H('legacy-subject'),
    principalId: 'legacy-reviewer',
    principalDescriptorHash: H('legacy-descriptor'),
    researchPrincipalPoolHash: H('legacy-pool'),
    signerIdentityHash: H('legacy-signer'),
    signatureHash: H('legacy-signature'),
    signatureVerificationReceiptHash: H('legacy-verification'),
    signedAt: '2026-07-19T02:00:00.000Z',
  };
  const receipt = buildSignedReviewerReceipt(input);
  assert.equal(verifySignedReviewerReceipt(receipt, {
    subjectHash: input.subjectHash,
    principalId: input.principalId,
    optional: null,
  }), true);
  assert.equal(verifySignedReviewerReceipt(receipt, { principalId: 'different-reviewer' }), false);
  assert.equal(verifySignedReviewerReceipt(null), false);
  assert.equal(verifySignedReviewerReceipt({
    ...receipt,
    signedReviewerReceiptHash: H('tampered-legacy'),
  }), false);
  assert.equal(verifySignedReviewerReceipt({
    ...receipt,
    signedAt: 'not-an-instant',
    signedReviewerReceiptHash: hashRecord('SignedReviewerReceipt', {
      ...receipt,
      signedReviewerReceiptHash: undefined,
      signedAt: 'not-an-instant',
    }),
  }), false);
  for (const [field, value] of [
    ['subjectHash', 'invalid'],
    ['principalId', 'bad principal'],
    ['signatureHash', 'invalid'],
    ['signedAt', '2026-07-19'],
  ]) {
    assert.throws(() => buildSignedReviewerReceipt({ ...input, [field]: value }),
      /signed_reviewer_receipt_invalid/, field);
  }
});
