import {
  createHttpExternalResearchReplayAdapter,
  readExternalResearchReplayServiceConfiguration,
} from '../../paper-adapters/automation/http-external-research-replay-adapter.mjs';
import {
  materializeFormalDomainQualificationReviewWorkspace,
} from '../../paper-adapters/automation/formal-domain-qualification-review-workspace-repository.mjs';
import {
  formalDomainQualificationRecoveryIdempotencyKey,
  formalDomainQualificationRecoveryLineageId,
  openFormalDomainQualificationRecoveryGenerationLedger,
  openFormalDomainQualificationRecoveryJournal,
} from '../../paper-adapters/automation/formal-domain-qualification-recovery-journal.mjs';
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
import {
  buildImmutableReviewerWorkspaceSnapshot,
} from '../../paper-adapters/automation/http-recoverable-reviewer-executor-adapter.mjs';

const SHA256 = /^sha256:[0-9a-f]{64}$/;
const RECOVERY_PORT_KINDS = Object.freeze({
  reviewer: 'FormalDomainQualificationReviewerRecoveryPort',
  signer: 'FormalDomainQualificationSignerRecoveryPort',
});

function assertRecoveryPort(port, stage) {
  if (!port || port.kind !== RECOVERY_PORT_KINDS[stage]
    || port.crashRecoveryReady !== true
    || !SHA256.test(String(port.configurationIdentityHash || ''))
    || port.recoveryOutcomeCryptographicAuthorityReady !== true
    || !SHA256.test(String(
      port.recoveryOutcomeVerificationPolicyHash || '',
    ))
    || typeof port.lookup !== 'function'
    || typeof port.resume !== 'function'
    || typeof port.execute !== 'function'
    || typeof port.verifyReceipt !== 'function') {
    throw new Error(
      `formal_domain_qualification_${stage}_lookup_resume_required`,
    );
  }
  return port;
}

function assertReplayRecoveryPort(port) {
  if (port?.crashRecoveryReady !== true
    || !SHA256.test(String(
      port.recoveryConfigurationIdentityHash || port.configurationHash || '',
    ))
    || port.recoveryOutcomeCryptographicAuthorityReady !== true
    || !SHA256.test(String(
      port.recoveryOutcomeVerificationPolicyHash || '',
    ))
    || typeof port.lookup !== 'function'
    || typeof port.resume !== 'function'
    || typeof port.replay !== 'function'
    || typeof port.verifyReceipt !== 'function') {
    throw new Error(
      'formal_domain_qualification_external_replay_lookup_resume_required',
    );
  }
  return port;
}

function normalizeRecoveryResolution(resolution, verifyReceipt) {
  if (!resolution || !['completed', 'in_progress', 'not_found']
    .includes(resolution.status)) {
    throw new Error('formal_domain_qualification_recovery_resolution_invalid');
  }
  if (resolution.status !== 'completed') {
    if (resolution.receipt !== null && resolution.receipt !== undefined) {
      throw new Error('formal_domain_qualification_recovery_resolution_invalid');
    }
    return Object.freeze({ status: resolution.status, receipt: null });
  }
  if (!verifyReceipt(resolution.receipt)) {
    throw new Error('formal_domain_qualification_recovery_receipt_invalid');
  }
  return Object.freeze({
    status: 'completed',
    receipt: Object.freeze(resolution.receipt),
  });
}

async function authorizeRecoveryStage(gate, {
  stage,
  campaignId,
  operationId,
  idempotencyKey,
} = {}) {
  if (!gate) return;
  await gate({
    action: `formal_domain_qualification_${stage}`,
    campaignId,
    operationId,
    idempotencyKey,
  });
  gate.assertCurrent?.({
    action: `formal_domain_qualification_${stage}`,
    campaignId,
    operationId,
    idempotencyKey,
  });
  await gate.markStarted?.({
    action: `formal_domain_qualification_${stage}`,
    operationId,
    idempotencyKey,
  });
}

function assertRecoveryLookupCurrent(gate, {
  stage,
  campaignId,
  operationId,
  idempotencyKey,
} = {}) {
  gate?.assertCurrent?.({
    action: `formal_domain_qualification_${stage}_lookup`,
    campaignId,
    operationId,
    idempotencyKey,
  });
}

function assertRecoveryExecutionActive(executionSignal) {
  if (executionSignal?.aborted === true) {
    if (executionSignal.reason instanceof Error) {
      throw executionSignal.reason;
    }
    throw new Error('formal_domain_qualification_execution_aborted');
  }
}

function assertRecoveryGenerationSelectionCurrent(gate, {
  campaignId,
  lineageId,
} = {}) {
  gate?.assertCurrent?.({
    action: 'formal_domain_qualification_generation_select',
    campaignId,
    lineageId,
  });
}

async function resolveCrashSafeStage({
  journal,
  operationId,
  stage,
  request,
  port,
  execute,
  resume = null,
  verifyReceipt,
  campaignId,
  assertExternalSideEffectReady,
  faultInjector,
  executionSignal,
}) {
  const idempotencyKey = formalDomainQualificationRecoveryIdempotencyKey({
    operationId,
    stage,
  });
  const completed = journal.latest(stage, 'stage_completed');
  if (completed) {
    if (completed.idempotencyKey !== idempotencyKey
      || !verifyReceipt(completed.result?.receipt)) {
      throw new Error('formal_domain_qualification_recovery_journal_receipt_invalid');
    }
    return completed.result.receipt;
  }
  const priorStart = journal.latest(stage, 'stage_started');
  if (priorStart && priorStart.idempotencyKey !== idempotencyKey) {
    throw new Error('formal_domain_qualification_recovery_journal_identity_invalid');
  }

  const recoveryInput = Object.freeze({
    operationId,
    idempotencyKey,
    request,
    signal: executionSignal || null,
  });
  assertRecoveryExecutionActive(executionSignal);
  assertRecoveryLookupCurrent(assertExternalSideEffectReady, {
    stage,
    campaignId,
    operationId,
    idempotencyKey,
  });
  const lookup = normalizeRecoveryResolution(
    await port.lookup(recoveryInput),
    verifyReceipt,
  );
  if (lookup.status === 'completed') {
    if (!priorStart) {
      journal.append({
        stage,
        event: 'stage_started',
        idempotencyKey,
      });
    }
    journal.append({
      stage,
      event: 'stage_completed',
      idempotencyKey,
      result: Object.freeze({ receipt: lookup.receipt, recovered: true }),
    });
    return lookup.receipt;
  }

  assertRecoveryExecutionActive(executionSignal);
  await authorizeRecoveryStage(assertExternalSideEffectReady, {
    stage,
    campaignId,
    operationId,
    idempotencyKey,
  });
  assertRecoveryExecutionActive(executionSignal);
  if (!priorStart) {
    journal.append({
      stage,
      event: 'stage_started',
      idempotencyKey,
    });
  }
  assertRecoveryExecutionActive(executionSignal);
  let receipt;
  if (priorStart || lookup.status === 'in_progress') {
    const resumed = normalizeRecoveryResolution(
      await (resume ? resume(recoveryInput) : port.resume(recoveryInput)),
      verifyReceipt,
    );
    if (resumed.status !== 'completed') {
      throw new Error(
        `formal_domain_qualification_${stage}_recovery_incomplete:${resumed.status}`,
      );
    }
    receipt = resumed.receipt;
  } else {
    receipt = await execute({ ...recoveryInput });
    if (!verifyReceipt(receipt)) {
      throw new Error('formal_domain_qualification_recovery_receipt_invalid');
    }
  }
  await faultInjector?.({
    point: 'after_remote_success_before_journal_append',
    stage,
    operationId,
    idempotencyKey,
    receipt,
  });
  journal.append({
    stage,
    event: 'stage_completed',
    idempotencyKey,
    result: Object.freeze({
      receipt,
      recovered: Boolean(priorStart) || lookup.status === 'in_progress',
    }),
  });
  return receipt;
}

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
  const replayRecoveryPort = assertReplayRecoveryPort(effectiveExternalReplay);
  const reviewerRecoveryPort = assertRecoveryPort(
    effectiveReviewerPool?.reviewerRecoveryPort,
    'reviewer',
  );
  const signerRecoveryPort = assertRecoveryPort(
    effectiveReviewerPool?.signerRecoveryPort,
    'signer',
  );
  const lineageId = formalDomainQualificationRecoveryLineageId({
    coverageReceiptHash: coverageReceipt.formalDomainCoverageReceiptHash,
    externalReplayConfigurationIdentityHash:
      replayRecoveryPort.recoveryConfigurationIdentityHash
        || replayRecoveryPort.configurationHash,
    reviewerConfigurationIdentityHash:
      reviewerRecoveryPort.configurationIdentityHash,
    signerConfigurationIdentityHash:
      signerRecoveryPort.configurationIdentityHash,
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
      const unsignedReviewerReceipt = await resolveCrashSafeStage({
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
      const formalDomainIndependentReviewAgentReceipt =
        await resolveCrashSafeStage({
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
