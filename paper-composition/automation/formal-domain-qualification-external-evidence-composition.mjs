import {
  createHttpExternalResearchReplayAdapter,
  readExternalResearchReplayServiceConfiguration,
} from '../../paper-adapters/automation/http-external-research-replay-adapter.mjs';
import {
  materializeFormalDomainQualificationReviewWorkspace,
} from '../../paper-adapters/automation/formal-domain-qualification-review-workspace-repository.mjs';
import {
  preflightCodexResearchAuthor,
} from '../../paper-adapters/automation/codex-research-author-preflight.mjs';
import {
  buildExternalResearchReplayRequest,
  verifyExternalResearchReplayReceipt,
} from '../../paper-domain/research/external-research-replay-contract.mjs';
import {
  buildFormalDomainQualificationExternalEvidence,
} from '../../paper-domain/research/formal-domain-qualification-external-evidence.mjs';
import {
  REQUIRED_GENERIC_FORMAL_DOMAIN_PROFILE_IDS,
} from '../../paper-domain/research/formal-domain-profile-registry.mjs';
import { assertExternalResearchReplayPort }
  from '../../paper-ports/external-research-replay-port.mjs';
import {
  inspectConfiguredAutonomousResearchAuthorIdentity,
} from './autonomous-research-runtime-principal-preflight.mjs';
import {
  resolveAutonomousResearchProviderConfiguration,
} from './autonomous-research-provider-configuration.mjs';
import {
  composeReviewerPrincipalExecutorPool,
} from './reviewer-principal-pool-composition.mjs';

function reviewerVerificationAuthority(executorPool) {
  return Object.freeze({
    version: executorPool?.version,
    kind: 'ReviewerReceiptVerificationAuthority',
    researchPrincipalPoolHash: executorPool?.pool?.researchPrincipalPoolHash || null,
    cryptographicAuthorityReady: executorPool?.cryptographicAuthorityReady === true,
    identityIndependenceReady: executorPool?.identityIndependenceReady === true,
    reviewerTrustSetHash: executorPool?.trustSetHash || null,
    reviewerSignatureVerificationPolicyHash:
      executorPool?.signatureVerificationPolicyHash || null,
    verifySignedReviewerReceipt: (input) => (
      executorPool?.verifySignedReviewerReceipt?.(input) === true
    ),
  });
}

function reviewInstructions({ coverageReceipt, externalReplayReceipt }) {
  const rows = coverageReceipt.profileEvidence.map((item) => ({
    profileId: item.profileId,
    formalProofSearchOperationReceiptHash: item.formalProofSearchOperationReceiptHash,
    replayExecutionReceiptHash: item.replayExecutionReceiptHash,
  }));
  return [
    'Independently review the five formal-domain qualification evidence packages in formal-domain-coverage.json.',
    'Check every exact Lean type, allowed import, selected proof-search strategy, kernel result, axiom boundary, and fresh-process replay binding.',
    'Do not treat a hash, local verifier result, or campaign formal review as semantic approval. Reject any missing or mismatched profile.',
    'Return exactly one JSON object with these keys and no others:',
    'version, kind, status, summary, blockers, formalDomainCoverageReceiptHash, externalReplayReceiptHash, reviewedProfileIds, reviewedProfileEvidenceHashes.',
    'Set version=1, kind=FormalDomainQualificationIndependentReview, status=approved, and blockers=[] only if every item is independently acceptable.',
    `formalDomainCoverageReceiptHash=${coverageReceipt.formalDomainCoverageReceiptHash}.`,
    `externalReplayReceiptHash=${externalReplayReceipt.externalResearchReplayReceiptHash}.`,
    `reviewedProfileIds=${JSON.stringify(REQUIRED_GENERIC_FORMAL_DOMAIN_PROFILE_IDS)}.`,
    `reviewedProfileEvidenceHashes=${JSON.stringify(rows.map((item) => item.formalProofSearchOperationReceiptHash))}.`,
  ].join(' ');
}

function configuredReviewerPool({
  runtimeRoot,
  environment,
  spawnSyncImpl,
  fetchImpl,
  clock,
  assertExternalSideEffectReady,
} = {}) {
  const providerConfiguration = resolveAutonomousResearchProviderConfiguration({ environment });
  const authorConfiguration = providerConfiguration.researchAuthor;
  const author = preflightCodexResearchAuthor({
    ...authorConfiguration,
    environment,
    ...(spawnSyncImpl ? { spawnSyncImpl } : {}),
  });
  const authorIdentityAttestation = inspectConfiguredAutonomousResearchAuthorIdentity({
    environment,
    author,
    clock,
  });
  if (authorIdentityAttestation?.ready !== true) {
    throw new Error('formal_domain_qualification_author_identity_required');
  }
  const configPath = String(environment.HEPTA_REVIEWER_PRINCIPAL_POOL_CONFIG || '').trim();
  if (!configPath) throw new Error('formal_domain_qualification_reviewer_pool_required');
  const composed = composeReviewerPrincipalExecutorPool({
    configPath,
    authorProvider: authorConfiguration.provider,
    authorCodexHome: author.codexHome || authorConfiguration.codexHome,
    runtimeRoot,
    workspaceRegistry: null,
    environment,
    ...(spawnSyncImpl ? { spawnSyncImpl } : {}),
    ...(fetchImpl ? { fetchImpl } : {}),
    clock,
    authorIdentityAttestation,
    assertExternalSideEffectReady,
  });
  if (composed.cryptographicAuthorityReady !== true
    || composed.identityIndependenceReady !== true
    || composed.pool?.reviewerTrustDomainCount < 3) {
    throw new Error('formal_domain_qualification_independent_reviewer_pool_not_ready');
  }
  return composed.executorPool;
}

function configuredExternalReplay({ environment, clock, authorIdentitySubjectHash }) {
  const configPath = String(environment.HEPTA_EXTERNAL_REPLAY_CONFIG || '').trim();
  if (!configPath) throw new Error('formal_domain_qualification_external_replay_required');
  return createHttpExternalResearchReplayAdapter({
    configuration: readExternalResearchReplayServiceConfiguration({ configPath }),
    environment,
    requiredLocalOriginIdentitySubjectHashes: [authorIdentitySubjectHash],
    clock,
  });
}

export async function produceConfiguredFormalDomainQualificationExternalEvidence({
  coverageReceipt,
  root,
  runtimeRoot,
  environment = process.env,
  spawnSyncImpl = undefined,
  fetchImpl = undefined,
  clock = { now: () => new Date() },
  externalResearchReplay = null,
  reviewerExecutorPool = null,
  assertExternalSideEffectReady = null,
} = {}) {
  if (!coverageReceipt?.formalDomainCoverageReceiptHash || !root || !runtimeRoot) {
    throw new Error('formal_domain_qualification_external_evidence_inputs_required');
  }
  let effectiveReviewerPool = reviewerExecutorPool;
  let authorIdentitySubjectHash = null;
  if (!effectiveReviewerPool || !externalResearchReplay) {
    const providerConfiguration = resolveAutonomousResearchProviderConfiguration({ environment });
    const author = preflightCodexResearchAuthor({
      ...providerConfiguration.researchAuthor,
      environment,
      ...(spawnSyncImpl ? { spawnSyncImpl } : {}),
    });
    const authorIdentity = inspectConfiguredAutonomousResearchAuthorIdentity({
      environment, author, clock,
    });
    authorIdentitySubjectHash = authorIdentity?.subject
      ?.externalPrincipalIdentityAttestationSubjectHash || null;
    if (authorIdentity?.ready !== true || !authorIdentitySubjectHash) {
      throw new Error('formal_domain_qualification_author_identity_required');
    }
  }
  effectiveReviewerPool ||= configuredReviewerPool({
    runtimeRoot,
    environment,
    spawnSyncImpl,
    fetchImpl,
    clock,
    assertExternalSideEffectReady,
  });
  const effectiveExternalReplay = assertExternalResearchReplayPort(
    externalResearchReplay || configuredExternalReplay({
      environment, clock, authorIdentitySubjectHash,
    }),
  );
  if (effectiveExternalReplay.cryptographicAuthorityReady !== true
    || effectiveExternalReplay.identityIndependenceReady !== true
    || effectiveReviewerPool?.cryptographicAuthorityReady !== true
    || effectiveReviewerPool?.identityIndependenceReady !== true) {
    throw new Error('formal_domain_qualification_external_authorities_not_ready');
  }
  const externalReplayRequest = buildExternalResearchReplayRequest({
    paperId: 'formal-domain-production-qualification',
    campaignId: 'formal-domain-production-qualification',
    sourceSnapshotHash: coverageReceipt.formalDomainCoverageReceiptHash,
    experimentPairs: [],
    formalReplayReceiptHashes: coverageReceipt.profileEvidence
      .map((item) => item.replayExecutionReceiptHash),
  });
  if (assertExternalSideEffectReady) {
    await assertExternalSideEffectReady({
      action: 'formal_domain_qualification_external_replay',
      campaignId: externalReplayRequest.campaignId,
    });
    assertExternalSideEffectReady.assertCurrent?.({
      action: 'formal_domain_qualification_external_replay',
      campaignId: externalReplayRequest.campaignId,
    });
  }
  await assertExternalSideEffectReady?.markStarted?.({
    action: 'formal_domain_qualification_external_replay',
  });
  const externalReplayReceipt = await effectiveExternalReplay.replay({
    request: externalReplayRequest,
  });
  if (!effectiveExternalReplay.verifyReceipt?.({
    request: externalReplayRequest,
    receipt: externalReplayReceipt,
  }) || !verifyExternalResearchReplayReceipt(externalReplayReceipt, {
    request: externalReplayRequest,
    cryptographicVerifier: effectiveExternalReplay.receiptVerifier,
  })) {
    throw new Error('formal_domain_qualification_external_replay_invalid');
  }
  const reviewWorkspace = materializeFormalDomainQualificationReviewWorkspace({
    runtimeRoot,
    coverageReceipt,
  });
  try {
    const formalDomainIndependentReviewAgentReceipt = await effectiveReviewerPool.execute({
      role: 'formal-review',
      workspacePath: reviewWorkspace.workspacePath,
      instructions: reviewInstructions({ coverageReceipt, externalReplayReceipt }),
      context: Object.freeze({
        paperId: externalReplayRequest.paperId,
        campaignId: externalReplayRequest.campaignId,
        nodeId: 'formal-domain-independent-review',
        formalDomainCoverageReceiptHash: coverageReceipt.formalDomainCoverageReceiptHash,
        externalReplayReceiptHash:
          externalReplayReceipt.externalResearchReplayReceiptHash,
      }),
      sandbox: 'read-only',
      outputTokenBudget: 4096,
      timeoutMs: 20 * 60 * 1000,
      assertExternalSideEffectReady,
    });
    return buildFormalDomainQualificationExternalEvidence({
      coverageReceipt,
      externalReplayRequest,
      externalReplayReceipt,
      formalDomainIndependentReviewAgentReceipt,
      externalResearchReplayReceiptVerifier: effectiveExternalReplay.receiptVerifier,
      reviewerReceiptVerificationAuthority:
        reviewerVerificationAuthority(effectiveReviewerPool),
    });
  } finally {
    reviewWorkspace.dispose();
  }
}
