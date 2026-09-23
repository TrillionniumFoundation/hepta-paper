import {
  createHttpExternalResearchReplayAdapter,
  readExternalResearchReplayServiceConfiguration,
} from '../../paper-adapters/automation/http-external-research-replay-adapter.mjs';
import {
  materializeFormalDomainQualificationReviewWorkspace,
} from '../../paper-adapters/automation/formal-domain-qualification-review-workspace-repository.mjs';
import {
  formalDomainQualificationRecoveryLineageId,
  openFormalDomainQualificationRecoveryGenerationLedger,
  openFormalDomainQualificationRecoveryJournal,
} from '../../paper-adapters/automation/formal-domain-qualification-recovery-journal.mjs';
import {
  assertRecoveryExecutionActive,
  assertRecoveryGenerationSelectionCurrent,
  assertRecoveryPort,
  assertReplayRecoveryPort,
  resolveCrashSafeStage,
  resolveRepeatableLocalStage,
} from './formal-domain-qualification-recovery-composition.mjs';
import {
  preflightCodexResearchAuthor,
} from '../../paper-adapters/automation/codex-research-author-preflight.mjs';
import {
  preflightCodexFormalReviewer,
} from '../../paper-adapters/automation/codex-formal-reviewer-preflight.mjs';
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
  autonomousResearchAuthorIdentitySubjectHash,
  buildAutonomousResearchReviewerSessionPrincipalPool,
  inspectAutonomousResearchAuthorRuntimeIdentity,
} from './autonomous-research-runtime-principal-preflight.mjs';
import {
  resolveAutonomousResearchProviderConfiguration,
} from './autonomous-research-provider-configuration.mjs';
import {
  composeReviewerPrincipalExecutorPool,
  composeReviewerSessionExecutorPool,
} from './reviewer-principal-pool-composition.mjs';
import {
  buildImmutableReviewerWorkspaceSnapshot,
} from '../../paper-adapters/automation/http-recoverable-reviewer-executor-adapter.mjs';

function reviewerVerificationAuthority(executorPool) {
  return Object.freeze({
    version: executorPool?.version,
    kind: 'ReviewerReceiptVerificationAuthority',
    researchPrincipalPoolHash: executorPool?.pool?.researchPrincipalPoolHash || null,
    authorityMode: executorPool?.authorityMode || null,
    sessionIsolationReady: executorPool?.sessionIsolationReady === true,
    cryptographicAuthorityReady: executorPool?.cryptographicAuthorityReady === true,
    identityIndependenceReady: executorPool?.identityIndependenceReady === true,
    reviewerTrustSetHash: executorPool?.trustSetHash || null,
    reviewerSignatureVerificationPolicyHash:
      executorPool?.signatureVerificationPolicyHash || null,
    verifySignedReviewerReceipt: (input) => (
      executorPool?.verifySignedReviewerReceipt?.(input) === true
    ),
    verifySessionReviewerReceipt: (input) => (
      executorPool?.verifySessionReviewerReceipt?.(input) === true
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

function externalEvidenceValidUntil(evidence) {
  const expiries = [];
  const visited = new WeakSet();
  function visit(value) {
    if (!value || typeof value !== 'object' || visited.has(value)) return;
    visited.add(value);
    for (const [field, item] of Object.entries(value)) {
      if (field === 'expiresAt' && typeof item === 'string') {
        const milliseconds = Date.parse(item);
        if (Number.isFinite(milliseconds)
          && new Date(milliseconds).toISOString() === item) {
          expiries.push(milliseconds);
        }
      } else if (item && typeof item === 'object') {
        visit(item);
      }
    }
  }
  visit(evidence);
  return expiries.length
    ? new Date(Math.min(...expiries)).toISOString() : null;
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
  const authorIdentityAttestation = inspectAutonomousResearchAuthorRuntimeIdentity({
    environment,
    author,
    clock,
  });
  if (authorIdentityAttestation?.ready !== true) {
    throw new Error('formal_domain_qualification_author_identity_required');
  }
  const configPath = String(environment.HEPTA_REVIEWER_PRINCIPAL_POOL_CONFIG || '').trim();
  if (configPath) {
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
  const reviewer = preflightCodexFormalReviewer({
    ...providerConfiguration.formalReviewer,
    authorProvider: authorConfiguration.provider,
    authorCodexHome: author.codexHome || authorConfiguration.codexHome,
    environment,
    ...(spawnSyncImpl ? { spawnSyncImpl } : {}),
  });
  const inspection = buildAutonomousResearchReviewerSessionPrincipalPool({
    author,
    reviewer,
  });
  return composeReviewerSessionExecutorPool({
    inspection,
    runtimeRoot,
    workspaceRegistry: null,
    assertExternalSideEffectReady,
  }).executorPool;
}

function configuredExternalReplay({ environment, clock, authorIdentitySubjectHash }) {
  const configPath = String(environment.HEPTA_EXTERNAL_REPLAY_CONFIG || '').trim();
  const expectedConfigurationHash = String(
    environment.HEPTA_EXTERNAL_REPLAY_CONFIG_HASH || '',
  ).trim().toLowerCase() || null;
  if (!configPath) throw new Error('formal_domain_qualification_external_replay_required');
  return createHttpExternalResearchReplayAdapter({
    configuration: readExternalResearchReplayServiceConfiguration({
      configPath,
      expectedConfigurationHash,
    }),
    expectedConfigurationHash,
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
  faultInjector = null,
  executionSignal = null,
  supersededExternalEvidenceHash = null,
} = {}) {
  if (!coverageReceipt?.formalDomainCoverageReceiptHash || !root || !runtimeRoot) {
    throw new Error('formal_domain_qualification_external_evidence_inputs_required');
  }
  assertRecoveryExecutionActive(executionSignal);
  let effectiveReviewerPool = reviewerExecutorPool;
  let authorIdentitySubjectHash = null;
  if (!effectiveReviewerPool || !externalResearchReplay) {
    const providerConfiguration = resolveAutonomousResearchProviderConfiguration({ environment });
    const author = preflightCodexResearchAuthor({
      ...providerConfiguration.researchAuthor,
      environment,
      ...(spawnSyncImpl ? { spawnSyncImpl } : {}),
    });
    const authorIdentity = inspectAutonomousResearchAuthorRuntimeIdentity({
      environment, author, clock,
    });
    authorIdentitySubjectHash = autonomousResearchAuthorIdentitySubjectHash(authorIdentity);
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
  const sessionReviewerReady = effectiveReviewerPool?.version === 3
    && effectiveReviewerPool?.authorityMode === 'fresh-isolated-session'
    && effectiveReviewerPool?.sessionIsolationReady === true
    && effectiveReviewerPool?.cryptographicAuthorityReady === false
    && effectiveReviewerPool?.identityIndependenceReady === true
    && typeof effectiveReviewerPool?.verifySessionReviewerReceipt === 'function';
  const cryptographicReviewerReady =
    effectiveReviewerPool?.cryptographicAuthorityReady === true
    && effectiveReviewerPool?.identityIndependenceReady === true;
  if (effectiveExternalReplay.fullProductionReady !== true
    || effectiveExternalReplay.cryptographicAuthorityReady !== true
    || effectiveExternalReplay.identityIndependenceReady !== true
    || (!sessionReviewerReady && !cryptographicReviewerReady)) {
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
  const replayRecoveryPort = assertReplayRecoveryPort(effectiveExternalReplay);
  const reviewerRecoveryPort = sessionReviewerReady ? null : assertRecoveryPort(
    effectiveReviewerPool?.reviewerRecoveryPort,
    'reviewer',
  );
  const signerRecoveryPort = sessionReviewerReady ? null : assertRecoveryPort(
    effectiveReviewerPool?.signerRecoveryPort,
    'signer',
  );
  const lineageId = formalDomainQualificationRecoveryLineageId({
    coverageReceiptHash: coverageReceipt.formalDomainCoverageReceiptHash,
    externalReplayConfigurationIdentityHash:
      replayRecoveryPort.recoveryConfigurationIdentityHash
        || replayRecoveryPort.configurationHash,
    reviewerConfigurationIdentityHash:
      sessionReviewerReady
        ? effectiveReviewerPool.trustSetHash
        : reviewerRecoveryPort.configurationIdentityHash,
    signerConfigurationIdentityHash:
      sessionReviewerReady
        ? effectiveReviewerPool.signatureVerificationPolicyHash
        : signerRecoveryPort.configurationIdentityHash,
  });
  assertRecoveryExecutionActive(executionSignal);
  assertRecoveryGenerationSelectionCurrent(assertExternalSideEffectReady, {
    campaignId: externalReplayRequest.campaignId,
    lineageId,
  });
  const generationLedger =
    openFormalDomainQualificationRecoveryGenerationLedger({
      runtimeRoot,
      lineageId,
      clock,
    });
  let journal = null;
  try {
    assertRecoveryExecutionActive(executionSignal);
    assertRecoveryGenerationSelectionCurrent(assertExternalSideEffectReady, {
      campaignId: externalReplayRequest.campaignId,
      lineageId,
    });
    const generation = generationLedger.select({
      supersededExternalEvidenceHash,
    });
    const operationId = generation.operationId;
    journal = openFormalDomainQualificationRecoveryJournal({
      runtimeRoot,
      operationId,
      clock,
    });
    const verifyReplayReceipt = (receipt) => (
      replayRecoveryPort.verifyReceipt({
        request: externalReplayRequest,
        receipt,
      }) === true
      && verifyExternalResearchReplayReceipt(receipt, {
        request: externalReplayRequest,
        cryptographicVerifier: replayRecoveryPort.receiptVerifier,
      })
    );
    const externalReplayReceipt = await resolveCrashSafeStage({
      journal,
      operationId,
      stage: 'external-replay',
      request: externalReplayRequest,
      port: replayRecoveryPort,
      execute: (input) => replayRecoveryPort.replay(input),
      verifyReceipt: verifyReplayReceipt,
      campaignId: externalReplayRequest.campaignId,
      assertExternalSideEffectReady,
      faultInjector,
      executionSignal,
    });
    const reviewWorkspace = materializeFormalDomainQualificationReviewWorkspace({
      runtimeRoot,
      coverageReceipt,
    });
    try {
      const reviewWorkspaceSnapshot = buildImmutableReviewerWorkspaceSnapshot({
        workspacePath: reviewWorkspace.workspacePath,
      });
      const reviewRequest = Object.freeze({
        role: 'formal-review',
        instructions: reviewInstructions({ coverageReceipt, externalReplayReceipt }),
        context: Object.freeze({
          paperId: externalReplayRequest.paperId,
          campaignId: externalReplayRequest.campaignId,
          nodeId: 'formal-domain-independent-review',
          formalDomainCoverageReceiptHash:
            coverageReceipt.formalDomainCoverageReceiptHash,
          externalReplayReceiptHash:
            externalReplayReceipt.externalResearchReplayReceiptHash,
          immutableWorkspaceSnapshotHash:
            reviewWorkspaceSnapshot.immutableReviewerWorkspaceSnapshotHash,
        }),
        sandbox: 'read-only',
        outputTokenBudget: 4096,
        timeoutMs: 20 * 60 * 1000,
      });
      const reviewExecutionRequest = Object.freeze({
        ...reviewRequest,
        workspacePath: reviewWorkspace.workspacePath,
      });
      const unsignedReviewerReceipt = sessionReviewerReady
        ? await resolveRepeatableLocalStage({
          journal,
          operationId,
          stage: 'reviewer',
          request: reviewRequest,
          execute: ({ signal }) => effectiveReviewerPool.execute({
            ...reviewExecutionRequest,
            signal,
          }),
          verifyReceipt: (receipt) => (
            effectiveReviewerPool.verifySessionReviewerReceipt({
              receipt,
              expected: { role: 'formal-review' },
            }) === true
          ),
          campaignId: externalReplayRequest.campaignId,
          assertExternalSideEffectReady,
          faultInjector,
          executionSignal,
        })
        : await resolveCrashSafeStage({
          journal,
          operationId,
          stage: 'reviewer',
          request: reviewRequest,
          port: reviewerRecoveryPort,
          execute: (input) => reviewerRecoveryPort.execute({
            ...input,
            executionRequest: reviewExecutionRequest,
          }),
          resume: (input) => reviewerRecoveryPort.resume({
            ...input,
            executionRequest: reviewExecutionRequest,
          }),
          verifyReceipt: (receipt) => reviewerRecoveryPort.verifyReceipt({
            request: reviewRequest,
            receipt,
          }) === true,
          campaignId: externalReplayRequest.campaignId,
          assertExternalSideEffectReady,
          faultInjector,
          executionSignal,
        });
      const signerRequest = Object.freeze({
        reviewRequest,
        unsignedReviewerReceipt,
      });
      const formalDomainIndependentReviewAgentReceipt = sessionReviewerReady
        ? unsignedReviewerReceipt
        : await resolveCrashSafeStage({
          journal,
          operationId,
          stage: 'signer',
          request: signerRequest,
          port: signerRecoveryPort,
          execute: (input) => signerRecoveryPort.execute(input),
          verifyReceipt: (receipt) => signerRecoveryPort.verifyReceipt({
            request: signerRequest,
            receipt,
          }) === true,
          campaignId: externalReplayRequest.campaignId,
          assertExternalSideEffectReady,
          faultInjector,
          executionSignal,
        });
      const evidence = buildFormalDomainQualificationExternalEvidence({
        coverageReceipt,
        externalReplayRequest,
        externalReplayReceipt,
        formalDomainIndependentReviewAgentReceipt,
        externalResearchReplayReceiptVerifier:
          replayRecoveryPort.receiptVerifier,
        reviewerReceiptVerificationAuthority:
          reviewerVerificationAuthority(effectiveReviewerPool),
      });
      const completedEvidence = journal.latest(
        'evidence',
        'evidence_completed',
      );
      if (completedEvidence
        && (completedEvidence.idempotencyKey !== operationId
          || completedEvidence.result
            ?.formalDomainQualificationExternalEvidenceHash
              !== evidence.formalDomainQualificationExternalEvidenceHash)) {
        throw new Error(
          'formal_domain_qualification_recovery_evidence_journal_invalid',
        );
      }
      if (!completedEvidence) {
        journal.append({
          stage: 'evidence',
          event: 'evidence_completed',
          idempotencyKey: operationId,
          result: Object.freeze({
            formalDomainQualificationExternalEvidenceHash:
              evidence.formalDomainQualificationExternalEvidenceHash,
          }),
        });
      }
      generationLedger.complete({
        operationId,
        evidenceHash:
          evidence.formalDomainQualificationExternalEvidenceHash,
        evidenceValidUntil: externalEvidenceValidUntil(evidence),
      });
      return evidence;
    } finally {
      reviewWorkspace.dispose();
    }
  } finally {
    journal?.close();
    generationLedger.close();
  }
}
