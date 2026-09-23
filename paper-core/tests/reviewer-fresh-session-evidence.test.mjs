import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createReviewerPrincipalExecutorPool,
  createReviewerReceiptVerificationAuthority,
} from '../../paper-adapters/automation/reviewer-principal-executor-pool.mjs';
import {
  buildAutonomousResearchReviewerSessionPrincipalPool,
  inspectAutonomousResearchRuntimePrincipals,
} from '../../paper-composition/automation/autonomous-research-runtime-principal-preflight.mjs';
import {
  buildAutonomousResearchRuntimePrincipalBinding,
} from '../../paper-domain/automation/autonomous-research-runtime-principal-binding-contract.mjs';
import {
  buildAutonomousResearchReleaseReviewerEvidence,
  inspectAutonomousResearchReleaseReviewerEvidence,
} from '../../paper-domain/automation/autonomous-research-release-reviewer-evidence-contract.mjs';
import {
  evaluateRefereeConvergence,
} from '../../paper-domain/automation/referee-convergence.mjs';
import {
  buildReviewerExecutionAuthorityContext,
  reviewerSemanticReviewHash,
  verifyFreshIsolatedReviewerSessionReceipt,
} from '../../paper-domain/research/reviewer-semantic-evidence-contract.mjs';
import {
  verifyAgentExecutionReceipt,
} from '../../paper-domain/evidence/agent-execution-receipt-contract.mjs';
import {
  buildExecutorCapabilities,
} from '../../paper-ports/executor-capabilities.mjs';
import { hashRecord } from '../../workflow-kernel/record-hash.mjs';

const H = (label) => hashRecord('ReviewerFreshSessionEvidenceTest', { label });

function rehashReviewerTrustInspection(trustInspection, overrides = {}) {
  const {
    reviewerPrincipalPoolTrustInspectionHash: _inspectionHash,
    ...originalPayload
  } = structuredClone(trustInspection);
  const payload = { ...originalPayload, ...overrides };
  return Object.freeze({
    ...payload,
    reviewerPrincipalPoolTrustInspectionHash: hashRecord(
      'ReviewerPrincipalPoolTrustInspection',
      payload,
    ),
  });
}

function principals() {
  const credentialRootIdentityHash = H('shared-credential-root');
  const credentialConfigIdentityHash = H('shared-credential-config');
  const authorCapabilityPayload = {
    version: 1,
    kind: 'CodexResearchAuthorCapabilityReceipt',
    status: 'codex_research_author_capability_ready',
    provider: 'openai',
    model: 'inherited-model',
    credentialRootIdentityHash,
    credentialConfigIdentityHash,
    freshEphemeralSessionRequired: true,
    priorAgentContextInheritanceForbidden: true,
  };
  const author = Object.freeze({
    effectivePrincipalId: 'codex-research-author:fresh-session-fixture',
    capabilityReceipt: Object.freeze({
      ...authorCapabilityPayload,
      codexResearchAuthorCapabilityReceiptHash: hashRecord(
        'CodexResearchAuthorCapabilityReceipt',
        authorCapabilityPayload,
      ),
    }),
  });
  const capabilityPayload = {
    version: 1,
    kind: 'CodexFormalReviewerCapabilityReceipt',
    status: 'codex_formal_reviewer_capability_ready',
    provider: 'openai',
    model: 'inherited-model',
    modelSelectionSource: 'codex_home_config',
    codexVersion: '0.144.1',
    codexBinaryIdentityHash: H('codex-binary'),
    credentialRootIdentityHash,
    credentialConfigIdentityHash,
    authorProvider: 'codex',
    authorCredentialRootIdentityHash: credentialRootIdentityHash,
    credentialIndependenceVerified: false,
    providerCredentialSharingPermitted: true,
    freshEphemeralSessionRequired: true,
    authorContextInheritanceForbidden: true,
    frozenArtifactReviewRequired: true,
    reviewerMustDifferFromAuthorPrincipal: true,
    assuranceScope: 'ephemeral_session_frozen_artifact_and_role_separation',
    providerAccountIndependenceVerified: false,
    authenticationStatus: 'codex_authentication_verified',
    modelOptionVerified: true,
    selectedModelExecutionCanaryVerified: false,
    readOnlyReviewRequired: true,
    dynamicAttemptWorkspaceRequired: true,
  };
  const capabilityReceipt = Object.freeze({
    ...capabilityPayload,
    codexFormalReviewerCapabilityReceiptHash: hashRecord(
      'CodexFormalReviewerCapabilityReceipt',
      capabilityPayload,
    ),
  });
  const reviewer = Object.freeze({
    codexBinary: '/usr/local/bin/codex',
    codexHome: '/var/lib/hepta-paper/codex-home',
    effectivePrincipalId: 'codex-formal-reviewer:fresh-session-fixture',
    capabilityReceipt,
  });
  return Object.freeze({ author, reviewer });
}

function reviewerExecutor(principal, capability, { executedRoles = null } = {}) {
  let ordinal = 0;
  const executorId = `fresh-session-reviewer:${principal.principalId}`;
  return Object.freeze({
    version: 1,
    kind: 'FreshSessionReviewerFixtureExecutor',
    executorId,
    capabilities: () => buildExecutorCapabilities({
      executorId,
      sandboxModes: ['read-only'],
      networkPolicy: 'none',
      receiptKinds: ['AgentExecutionReceipt'],
    }),
    async execute({ role }) {
      executedRoles?.push(role);
      ordinal += 1;
      const sessionId = `codex-exec:fixture-${ordinal}`;
      const payload = {
        providerMode: 'openai',
        executorId,
        agentId: principal.principalId,
        model: capability.model,
        resolvedModel: capability.model,
        modelSelectionSource: capability.modelSelectionSource,
        promptHash: H(`prompt-${ordinal}`),
        sessionId,
        childSessionId: sessionId,
        sessionIsolation: 'fresh_ephemeral_no_resume',
        contextInheritance: 'forbidden',
        role,
        status: 'agent_execution_completed',
        changedPaths: Object.freeze([]),
        blockers: Object.freeze([]),
        usage: Object.freeze({
          input: 10,
          output: 5,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 15,
        }),
        structuredOutput: Object.freeze({
          verdict: 'accept',
          score: 0.9,
          criticalFindingCount: 0,
          findings: Object.freeze([]),
          summary: `fresh reviewer session ${ordinal}`,
        }),
        externalActionPerformed: false,
        codexFormalReviewerCapabilityReceiptHash:
          capability.codexFormalReviewerCapabilityReceiptHash,
        codexCredentialRootIdentityHash: capability.credentialRootIdentityHash,
        codexCredentialConfigIdentityHash: capability.credentialConfigIdentityHash,
        codexAuthorCredentialRootIdentityHash:
          capability.authorCredentialRootIdentityHash,
        codexCredentialIndependenceVerified: false,
        codexProviderCredentialSharingPermitted: true,
        codexFreshEphemeralSessionRequired: true,
        codexAuthorContextInheritanceForbidden: true,
        codexFrozenArtifactReviewRequired: true,
        codexReviewerAssuranceScope:
          'ephemeral_session_frozen_artifact_and_role_separation',
        codexProviderAccountIndependenceVerified: false,
        codexBinaryIdentityHash: capability.codexBinaryIdentityHash,
        codexVersion: capability.codexVersion,
        codexAuthenticationStatus: capability.authenticationStatus,
      };
      return Object.freeze({
        ...payload,
        agentExecutionReceiptHash: hashRecord('AgentExecutionReceipt', payload),
      });
    },
  });
}

function reviewFromReceipt(receipt, reviewerId) {
  const unsigned = receipt.unsignedAgentExecutionReceipt;
  const context = unsigned.reviewerExecutionAuthorityContext;
  return Object.freeze({
    reviewerId,
    role: 'independent-review',
    verdict: unsigned.structuredOutput.verdict,
    score: unsigned.structuredOutput.score,
    criticalFindingCount: unsigned.structuredOutput.criticalFindingCount,
    findings: unsigned.structuredOutput.findings,
    summary: unsigned.structuredOutput.summary,
    reviewHash: reviewerSemanticReviewHash({
      unsignedAgentExecutionReceipt: unsigned,
    }),
    reviewPrincipalId: unsigned.reviewPrincipalId,
    reviewPrincipalDescriptorHash: unsigned.reviewPrincipalDescriptorHash,
    reviewerProviderAccountIdentityHash:
      unsigned.reviewerProviderAccountIdentityHash,
    reviewerCredentialRootIdentityHash:
      unsigned.reviewerCredentialRootIdentityHash,
    reviewerTrustDomainIdentityHash:
      unsigned.reviewerTrustDomainIdentityHash,
    reviewerSignerIdentityHash: unsigned.reviewerSignerIdentityHash,
    signedReviewerReceiptHash: null,
    signedReviewerReceipt: null,
    unsignedAgentExecutionReceiptHash: unsigned.agentExecutionReceiptHash,
    unsignedAgentExecutionReceipt: unsigned,
    signatureVerificationReceiptHash: null,
    researchPrincipalPoolHash: unsigned.researchPrincipalPoolHash,
    reviewEvidenceMode: 'fresh-isolated-session',
    reviewAttemptId: context.reviewAttemptId,
    manuscriptHash: context.manuscriptHash,
    childSessionId: unsigned.childSessionId,
    promptHash: unsigned.promptHash,
    resolvedModel: unsigned.resolvedModel,
    campaignId: context.campaignId,
    campaignPlanHash: context.campaignPlanHash,
    paperId: context.paperId,
    nodeId: context.nodeId,
    roundIndex: context.roundIndex,
    selectedExecutorId: unsigned.executorId,
  });
}

test('shared provider credentials produce a ready fresh-session reviewer pool', () => {
  const selected = principals();
  const inspection = buildAutonomousResearchReviewerSessionPrincipalPool(selected);
  assert.equal(inspection.authorityMode, 'fresh-isolated-session');
  assert.equal(inspection.sessionIsolationReady, true);
  assert.equal(inspection.cryptographicAuthorityReady, false);
  assert.equal(inspection.identityIndependenceReady, true);
  assert.equal(inspection.pool.reviewerPrincipalCount, 1);
  assert.equal(inspection.pool.reviewerCredentialRootCount, 1);
  assert.equal(
    inspection.entries[0].descriptor.credentialRootIdentityHash,
    selected.reviewer.capabilityReceipt.credentialRootIdentityHash,
  );
});

test('runtime principal preflight creates the session pool without external configuration', () => {
  const selected = principals();
  const inspection = inspectAutonomousResearchRuntimePrincipals({
    authorConfiguration: { provider: 'codex' },
    reviewerConfiguration: {},
    refereeCount: 3,
    environment: {},
    preflightAuthor: () => selected.author,
    preflightReviewer: () => selected.reviewer,
    preflightEmpiricalRuntime: () => Object.freeze({ ready: true }),
  });
  assert.deepEqual(inspection.blockers, []);
  assert.equal(inspection.reviewer, selected.reviewer);
  assert.equal(
    inspection.reviewerPrincipalPoolInspection.authorityMode,
    'fresh-isolated-session',
  );
  assert.equal(
    inspection.reviewerPrincipalPoolInspection.pool.reviewerPrincipalCount,
    1,
  );
});

test('fresh reviewer sessions converge and bind release evidence without a reviewer signer', async () => {
  const selected = principals();
  const inspection = buildAutonomousResearchReviewerSessionPrincipalPool(selected);
  const principal = inspection.pool.principals[0];
  const executedRoles = [];
  const executorPool = createReviewerPrincipalExecutorPool({
    pool: inspection.pool,
    executors: new Map([[
      principal.principalId,
      reviewerExecutor(principal, selected.reviewer.capabilityReceipt, { executedRoles }),
    ]]),
    signers: null,
    trustInspection: inspection.trustInspection,
  });
  const authority = createReviewerReceiptVerificationAuthority({
    pool: inspection.pool,
    signers: null,
    trustInspection: inspection.trustInspection,
  });
  assert.equal(executorPool.authorityMode, 'fresh-isolated-session');
  assert.equal(executorPool.cryptographicAuthorityReady, false);
  assert.equal(executorPool.identityIndependenceReady, true);

  const campaignId = 'fresh-session-campaign';
  const campaignPlanHash = H('campaign-plan');
  const paperId = 'fresh-session-paper';
  const manuscriptHash = H('manuscript');
  const contexts = [1, 2, 3].map((ordinal) => buildReviewerExecutionAuthorityContext({
    campaignId,
    campaignPlanHash,
    paperId,
    nodeId: `revision-referee-${ordinal}`,
    roundIndex: 1,
    reviewAttemptId: `review-attempt-${ordinal}`,
    manuscriptHash,
  }));
  const receipts = [];
  for (const [index, context] of contexts.entries()) {
    receipts.push(await executorPool.execute({
      role: `referee-${index + 1}`,
      context: {
        campaignId,
        campaignPlanHash,
        paperId,
        nodeId: context.nodeId,
        roundIndex: context.roundIndex,
        attemptId: context.reviewAttemptId,
        manuscriptHash,
        reviewerExecutionAuthorityContext: context,
      },
    }));
  }
  assert.deepEqual(executedRoles, [
    'independent-review', 'independent-review', 'independent-review',
  ]);
  assert.ok(receipts.every((receipt) => (
    receipt.unsignedAgentExecutionReceipt.role === 'independent-review'
      && reviewerSemanticReviewHash({
        unsignedAgentExecutionReceipt: receipt.unsignedAgentExecutionReceipt,
      }).startsWith('sha256:')
  )));
  assert.ok(receipts.every((receipt) => (
    receipt.usage?.totalTokens === 15
      && receipt.sourceAgentExecutionUsageBindingHash?.startsWith('sha256:')
  )));
  const {
    agentExecutionReceiptHash: ignoredReceiptHash,
    ...wrongRolePayload
  } = receipts[0].unsignedAgentExecutionReceipt;
  const wrongRoleReceiptPayload = {
    ...wrongRolePayload,
    role: 'referee-1',
  };
  const wrongRoleReceipt = Object.freeze({
    ...wrongRoleReceiptPayload,
    agentExecutionReceiptHash: hashRecord(
      'AgentExecutionReceipt',
      wrongRoleReceiptPayload,
    ),
  });
  assert.throws(
    () => reviewerSemanticReviewHash({
      unsignedAgentExecutionReceipt: wrongRoleReceipt,
    }),
    (error) => error.message === 'reviewer_semantic_review_invalid'
      && error.retryable === false,
  );
  assert.equal(new Set(receipts.map((receipt) => receipt.childSessionId)).size, 3);
  assert.ok(receipts.every((receipt) => receipt.signedReviewerReceipt === undefined));
  assert.equal(verifyAgentExecutionReceipt(
    receipts[0].unsignedAgentExecutionReceipt,
  ), true);
  assert.equal(verifyFreshIsolatedReviewerSessionReceipt(
    receipts[0].unsignedAgentExecutionReceipt,
  ), true);
  assert.equal(verifyFreshIsolatedReviewerSessionReceipt(
    receipts[0].unsignedAgentExecutionReceipt,
    {
      campaignId,
      campaignPlanHash,
      paperId,
      nodeId: contexts[0].nodeId,
      roundIndex: 1,
      reviewAttemptId: contexts[0].reviewAttemptId,
      manuscriptHash,
      reviewPrincipalId: principal.principalId,
      reviewPrincipalDescriptorHash: principal.principalDescriptorHash,
      researchPrincipalPoolHash: inspection.pool.researchPrincipalPoolHash,
    },
  ), true);
  assert.equal(authority.verifySessionReviewerReceipt({
    receipt: receipts[0].unsignedAgentExecutionReceipt,
    expected: {
      campaignId,
      campaignPlanHash,
      paperId,
      nodeId: contexts[0].nodeId,
      roundIndex: 1,
      reviewAttemptId: contexts[0].reviewAttemptId,
      manuscriptHash,
    },
  }), true);
  const formalReviewReceipt = await executorPool.execute({
    role: 'formal-review',
    context: {
      campaignId,
      paperId,
      nodeId: 'formal-review-node',
      attemptId: 'formal-review-attempt',
    },
  });
  assert.equal(authority.verifySessionReviewerReceipt({
    receipt: formalReviewReceipt,
    expected: {
      reviewPrincipalId: principal.principalId,
      reviewPrincipalDescriptorHash: principal.principalDescriptorHash,
      researchPrincipalPoolHash: inspection.pool.researchPrincipalPoolHash,
    },
  }), true);
  const reviews = receipts.map((receipt, index) => (
    reviewFromReceipt(receipt, `revision-referee-${index + 1}`)
  ));
  const decision = evaluateRefereeConvergence({
    campaignId,
    campaignPlanHash,
    paperId,
    roundIndex: 1,
    reviews,
    expectedManuscriptHash: manuscriptHash,
    expectedReviewerContexts: contexts.map((context) => Object.freeze({
      nodeId: context.nodeId,
      reviewAttemptId: context.reviewAttemptId,
    })),
    minimumReviewers: 3,
    minimumIndependentTrustDomains: 1,
    requireSessionBoundReviewerReceipts: true,
    sessionReviewerReceiptVerifier: authority.verifySessionReviewerReceipt,
  });
  assert.equal(decision.version, 3);
  assert.equal(decision.accepted, true, JSON.stringify(decision));
  assert.equal(decision.reviewSemanticEvidenceBound, true);
  assert.equal(decision.sessionBoundReviewerReceiptsVerified, true);

  const runtimePrincipalBinding = buildAutonomousResearchRuntimePrincipalBinding({
    authorPrincipalId: selected.author.effectivePrincipalId,
    authorIdentityConfigurationHash: H('author-identity-configuration'),
    authorIdentitySubjectHash: H('author-identity-subject'),
    authorCapabilityReceiptHash: H('author-capability'),
    authorCredentialRootIdentityHash:
      selected.reviewer.capabilityReceipt.credentialRootIdentityHash,
    researchPrincipalPoolHash: inspection.pool.researchPrincipalPoolHash,
    reviewerTrustSetHash: inspection.trustSetHash,
    reviewerSignatureVerificationPolicyHash:
      inspection.signatureVerificationPolicyHash,
  });
  const reviewerEvidenceAuthority = Object.freeze({
    ...authority,
    verifySessionReviewerReceipt: authority.verifySessionReviewerReceipt,
  });
  const evidence = buildAutonomousResearchReleaseReviewerEvidence({
    campaignId,
    paperId,
    campaignPlanHash,
    expectedManuscriptHash: manuscriptHash,
    refereeConvergenceDecision: decision,
    runtimePrincipalBinding,
    reviewerEvidenceAuthority,
  });
  assert.equal(evidence.version, 3);
  assert.equal(evidence.reviewEvidenceMode, 'fresh-isolated-session');
  assert.ok(evidence.signedReviewerReceipts.every((receipt) => receipt === null));
  assert.equal(inspectAutonomousResearchReleaseReviewerEvidence(evidence, {
    runtimePrincipalBinding,
    reviewerEvidenceAuthority,
    expected: { campaignId, paperId, campaignPlanHash, expectedManuscriptHash: manuscriptHash },
  }).valid, true);
});

test('reviewer pool preserves a completed receipt when usage postprocessing fails', async () => {
  const selected = principals();
  const inspection = buildAutonomousResearchReviewerSessionPrincipalPool(selected);
  const principal = inspection.pool.principals[0];
  const base = reviewerExecutor(principal, selected.reviewer.capabilityReceipt);
  const malformedUsageExecutor = Object.freeze({
    ...base,
    async execute(input) {
      const valid = await base.execute(input);
      const { agentExecutionReceiptHash: _hash, ...validPayload } = valid;
      const payload = {
        ...validPayload,
        usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, totalTokens: 14 },
      };
      return Object.freeze({
        ...payload,
        agentExecutionReceiptHash: hashRecord('AgentExecutionReceipt', payload),
      });
    },
  });
  const executorPool = createReviewerPrincipalExecutorPool({
    pool: inspection.pool,
    executors: new Map([[principal.principalId, malformedUsageExecutor]]),
    signers: null,
    trustInspection: inspection.trustInspection,
  });
  const context = buildReviewerExecutionAuthorityContext({
    campaignId: 'usage-postprocess-campaign',
    campaignPlanHash: H('usage-postprocess-plan'),
    paperId: 'usage-postprocess-paper',
    nodeId: 'referee-1',
    roundIndex: 1,
    reviewAttemptId: 'usage-postprocess-attempt',
    manuscriptHash: H('usage-postprocess-manuscript'),
  });
  await assert.rejects(
    () => executorPool.execute({
      role: 'referee-1',
      context: {
        campaignId: context.campaignId,
        campaignPlanHash: context.campaignPlanHash,
        paperId: context.paperId,
        nodeId: context.nodeId,
        roundIndex: context.roundIndex,
        attemptId: context.reviewAttemptId,
        manuscriptHash: context.manuscriptHash,
        reviewerExecutionAuthorityContext: context,
      },
    }),
    (error) => error.message === 'reviewer_principal_agent_usage_binding_invalid'
      && error.receipt?.status === 'agent_execution_completed'
      && error.receipt?.usage?.totalTokens === 14,
  );
});

test('reviewer trust inspection and side-effect gates fail closed across pool modes', async () => {
  assert.throws(
    () => createReviewerReceiptVerificationAuthority({ pool: null }),
    /reviewer_principal_executor_pool_invalid/,
  );

  const selected = principals();
  const inspection = buildAutonomousResearchReviewerSessionPrincipalPool(selected);
  const principal = inspection.pool.principals[0];
  const sessionTrustNotReady = rehashReviewerTrustInspection(
    inspection.trustInspection,
    { sessionIsolationReady: false },
  );
  assert.throws(() => createReviewerReceiptVerificationAuthority({
    pool: inspection.pool,
    trustInspection: sessionTrustNotReady,
  }), /reviewer_principal_pool_session_trust_not_ready/);
  const strongTrustNotReady = rehashReviewerTrustInspection(
    inspection.trustInspection,
    {
      authorityMode: 'external-cryptographic-authority',
      strongReviewerPool: true,
      cryptographicAuthorityReady: false,
      identityIndependenceReady: true,
    },
  );
  assert.throws(() => createReviewerReceiptVerificationAuthority({
    pool: inspection.pool,
    trustInspection: strongTrustNotReady,
  }), /reviewer_principal_pool_strong_trust_not_ready/);

  const boundedAuthority = createReviewerReceiptVerificationAuthority({
    pool: inspection.pool,
    trustInspection: null,
  });
  assert.equal(boundedAuthority.version, 1);
  assert.equal(boundedAuthority.authorityMode, 'external-cryptographic-authority');
  assert.equal(boundedAuthority.identityIndependenceReady, false);
  assert.equal(boundedAuthority.reviewerTrustSetHash, null);
  assert.equal(boundedAuthority.reviewerSignatureVerificationPolicyHash, null);
  assert.equal(boundedAuthority.verifySignedReviewerReceipt(), false);
  assert.equal(boundedAuthority.verifySessionReviewerReceipt(), false);

  assert.throws(() => createReviewerPrincipalExecutorPool({
    pool: inspection.pool,
    executors: new Map(),
    trustInspection: inspection.trustInspection,
    assertExternalSideEffectReady: {},
  }), /reviewer_principal_external_side_effect_gate_invalid/);
  const executorPool = createReviewerPrincipalExecutorPool({
    pool: inspection.pool,
    executors: new Map([[
      principal.principalId,
      reviewerExecutor(principal, selected.reviewer.capabilityReceipt),
    ]]),
    trustInspection: inspection.trustInspection,
  });
  await assert.rejects(() => executorPool.execute({
    assertExternalSideEffectReady: {},
  }), /reviewer_principal_external_side_effect_gate_invalid/);

  const fallbackReceipt = await executorPool.execute();
  assert.equal(fallbackReceipt.role, 'independent-review');
  assert.equal(fallbackReceipt.reviewEvidenceMode, 'fresh-isolated-session');

  const authorityContext = buildReviewerExecutionAuthorityContext({
    campaignId: 'negative-session-campaign',
    campaignPlanHash: H('negative-session-plan'),
    paperId: 'negative-session-paper',
    nodeId: 'negative-session-node',
    roundIndex: 2,
    reviewAttemptId: 'negative-session-attempt',
    manuscriptHash: H('negative-session-manuscript'),
  });
  const semanticReceipt = await executorPool.execute({
    role: 'independent-review',
    context: {
      campaignId: authorityContext.campaignId,
      campaignPlanHash: authorityContext.campaignPlanHash,
      paperId: authorityContext.paperId,
      nodeId: authorityContext.nodeId,
      roundIndex: authorityContext.roundIndex,
      attemptId: authorityContext.reviewAttemptId,
      manuscriptHash: authorityContext.manuscriptHash,
      reviewerExecutionAuthorityContext: authorityContext,
    },
  });
  const sessionAuthority = createReviewerReceiptVerificationAuthority({
    pool: inspection.pool,
    trustInspection: inspection.trustInspection,
  });
  assert.equal(sessionAuthority.verifySessionReviewerReceipt({
    receipt: semanticReceipt.unsignedAgentExecutionReceipt,
    expected: { principalId: 'missing-reviewer' },
  }), false);
  for (const [field, value] of [
    ['reviewPrincipalDescriptorHash', H('wrong-descriptor')],
    ['researchPrincipalPoolHash', H('wrong-pool')],
    ['reviewerTrustSetHash', H('wrong-trust-set')],
    ['reviewerSignatureVerificationPolicyHash', H('wrong-signature-policy')],
  ]) {
    assert.equal(sessionAuthority.verifySessionReviewerReceipt({
      receipt: { ...semanticReceipt.unsignedAgentExecutionReceipt, [field]: value },
    }), false);
  }
});

test('reviewer pool preserves execution and postprocessing evidence on invalid receipts', async () => {
  const selected = principals();
  const inspection = buildAutonomousResearchReviewerSessionPrincipalPool(selected);
  const principal = inspection.pool.principals[0];
  const baseExecutor = reviewerExecutor(principal, selected.reviewer.capabilityReceipt);
  const invalidReceiptExecutor = Object.freeze({
    ...baseExecutor,
    async execute() { return Object.freeze({ status: 'invalid-fixture-receipt' }); },
  });
  const invalidReceiptPool = createReviewerPrincipalExecutorPool({
    pool: inspection.pool,
    executors: new Map([[principal.principalId, invalidReceiptExecutor]]),
    trustInspection: inspection.trustInspection,
  });
  await assert.rejects(
    () => invalidReceiptPool.execute({ role: 'formal-review' }),
    (error) => error.message === 'reviewer_principal_agent_receipt_invalid'
      && error.agentExecutionReceipt?.status === 'invalid-fixture-receipt'
      && error.receipt?.status === 'invalid-fixture-receipt',
  );

  const postprocessingReceipt = Object.freeze({ kind: 'SignerPostprocessingReceipt' });
  const signer = Object.freeze({
    version: 1,
    kind: 'ReviewerReceiptSignerPort',
    configurationHash: H('throwing-signer-configuration'),
    serviceId: 'throwing-signer',
    cryptographicAuthorityReady: false,
    identityIndependenceReady: false,
    async sign() {
      const error = new Error('reviewer_signer_fixture_failed');
      error.receipt = postprocessingReceipt;
      throw error;
    },
  });
  const gateCalls = [];
  const sideEffectGate = async (request) => { gateCalls.push(['ready', request]); };
  sideEffectGate.assertCurrent = (request) => { gateCalls.push(['current', request]); };
  sideEffectGate.markStarted = async (request) => { gateCalls.push(['started', request]); };
  const signerFailurePool = createReviewerPrincipalExecutorPool({
    pool: inspection.pool,
    executors: new Map([[principal.principalId, baseExecutor]]),
    signers: new Map([[principal.principalId, signer]]),
    trustInspection: inspection.trustInspection,
    assertExternalSideEffectReady: sideEffectGate,
  });
  await assert.rejects(
    () => signerFailurePool.execute({ role: 'formal-review' }),
    (error) => error.message === 'reviewer_signer_fixture_failed'
      && error.postprocessingReceipt === postprocessingReceipt
      && error.agentExecutionReceipt?.status === 'agent_execution_completed'
      && error.receipt?.usage?.totalTokens === 15,
  );
  assert.deepEqual(gateCalls.map(([kind]) => kind), ['ready', 'current', 'started']);
  assert.ok(gateCalls.every(([, request]) => request.operationId.startsWith('sha256:')));
  assert.ok(gateCalls.every(([, request]) => request.idempotencyKey.startsWith('sha256:')));
});
