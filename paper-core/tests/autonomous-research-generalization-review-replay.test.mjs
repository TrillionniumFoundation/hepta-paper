import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import test from 'node:test';
import {
  buildExternalResearchReplayReceipt,
  buildExternalResearchReplayRequest,
  verifyExternalResearchReplayReceipt,
} from '../../paper-domain/research/external-research-replay-contract.mjs';
import {
  buildResearchPrincipalDescriptor,
  buildResearchPrincipalPool,
  selectResearchPrincipal,
  verifyResearchPrincipalPool,
} from '../../paper-domain/research/research-principal-pool-contract.mjs';
import {
  buildSignedReviewerReceipt,
  reviewerReceiptSigningSubject,
  verifySignedReviewerReceipt,
} from '../../paper-domain/research/signed-reviewer-receipt-contract.mjs';
import {
  buildAgentWorkspacePostimageBinding,
  verifyAgentExecutionReceipt,
} from '../../paper-domain/evidence/agent-execution-receipt-contract.mjs';
import { createReviewerPrincipalExecutorPool } from '../../paper-adapters/automation/reviewer-principal-executor-pool.mjs';
import { buildExecutorCapabilities } from '../../paper-ports/executor-capabilities.mjs';
import { assertExternalResearchReplayPort } from '../../paper-ports/external-research-replay-port.mjs';
import {
  buildExternalResearchReplayServiceConfiguration,
  createHttpExternalResearchReplayAdapter,
} from '../../paper-adapters/automation/http-external-research-replay-adapter.mjs';
import {
  buildPinnedExternalEvidenceEnvelope,
  pinnedExternalEvidenceSigningPayload,
} from '../../paper-adapters/authority/pinned-external-evidence-verifier.mjs';
import { runCampaignExternalResearchReplay } from '../../paper-adapters/automation/campaign-external-research-replay.mjs';
import {
  buildReviewerReceiptSignerServiceConfiguration,
  createHttpReviewerReceiptSignerAdapter,
} from '../../paper-adapters/automation/http-reviewer-receipt-signer-adapter.mjs';
import { hashRecord } from '../../workflow-kernel/record-hash.mjs';

const FIXED_TIME = '2026-07-19T00:00:00.000Z';

function digest(label) {
  return hashRecord('AutonomousResearchGeneralizationFixture', { label });
}

function signedReplayAuthorityEnvelope(pair, subjectHash) {
  const placeholder = buildPinnedExternalEvidenceEnvelope({
    subjectKind: 'ExternalResearchReplayReceiptV1',
    subjectHash,
    signedAt: '2026-07-18T23:59:00.000Z',
    expiresAt: '2026-07-19T00:01:00.000Z',
    signatures: [{
      keyId: 'external-replay-key-1',
      role: 'external_research_replay_attestor',
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
    signatures: [{
      keyId: 'external-replay-key-1',
      role: 'external_research_replay_attestor',
      algorithm: 'ed25519',
      value,
    }],
  });
}

test('reviewer identity and external replay require distinct signed machine trust domains', async () => {
  const principals = [1, 2, 3].map((ordinal) => buildResearchPrincipalDescriptor({
    principalId: `reviewer-${ordinal}`,
    roles: ['formal-review', 'independent-review'],
    provider: 'codex',
    modelIdentityHash: digest(`model-${ordinal}`),
    providerAccountIdentityHash: digest(`account-${ordinal}`),
    credentialRootIdentityHash: digest(`credential-root-${ordinal}`),
    credentialConfigIdentityHash: digest(`credential-config-${ordinal}`),
    trustDomainIdentityHash: digest(`trust-domain-${ordinal}`),
    capabilityReceiptHash: digest(`capability-${ordinal}`),
    signerIdentityHash: digest(`signer-${ordinal}`),
  }));
  const pool = buildResearchPrincipalPool({
    poolId: 'independent-reviewers-v1',
    principals,
    minimumReviewerTrustDomains: 3,
  });
  assert.equal(verifyResearchPrincipalPool(pool), true);
  assert.equal(pool.reviewerTrustDomainCount, 3);
  const executors = new Map(principals.map((principal) => [principal.principalId, {
    version: 1,
    kind: 'ReviewerFixtureExecutor',
    executorId: `executor-${principal.principalId}`,
    capabilities: () => buildExecutorCapabilities({
      executorId: `executor-${principal.principalId}`,
      sandboxModes: ['read-only'],
      networkPolicy: 'none',
      receiptKinds: ['AgentExecutionReceipt'],
    }),
    async execute() {
      const payload = {
        version: 1,
        kind: 'AgentExecutionReceipt',
        status: 'agent_execution_completed',
        agentId: principal.principalId,
        changedPaths: [],
        externalModelInvocationPerformed: true,
        usageComplete: true,
        usage: Object.freeze({
          input: 10,
          inputTokens: 10,
          input_tokens: 10,
          output: 5,
          outputTokens: 5,
          output_tokens: 5,
          cacheRead: 0,
          cacheReadTokens: 0,
          cache_read_tokens: 0,
          cacheWrite: 0,
          cacheWriteTokens: 0,
          cache_write_tokens: 0,
          totalTokens: 15,
          total_tokens: 15,
          total: 15,
          costUsd: 0.25,
          cost_usd: 0.25,
        }),
      };
      return Object.freeze({
        ...payload,
        agentExecutionReceiptHash: hashRecord('AgentExecutionReceipt', payload),
        agentWorkspacePostimageBinding: buildAgentWorkspacePostimageBinding({
          changedPaths: [], files: [],
        }),
        isolatedAgentMergeReceiptHash: digest(`merge-${principal.principalId}`),
      });
    },
  }]));
  const reviewerExecutorPool = createReviewerPrincipalExecutorPool({ pool, executors });
  const reviewerAgentReceipt = await reviewerExecutorPool.execute({
    role: 'independent-review',
    context: { nodeId: 'review-round-1' },
  });
  assert.equal(verifyAgentExecutionReceipt(reviewerAgentReceipt), true);
  assert.equal(reviewerAgentReceipt.reviewPrincipalDescriptorHash,
    principals.find((principal) => (
      principal.principalId === reviewerAgentReceipt.reviewPrincipalId
    )).principalDescriptorHash);
  assert.equal(Object.hasOwn(reviewerAgentReceipt, 'agentWorkspacePostimageBinding'), false);
  const selected = [1, 2, 3].map((ordinal) => selectResearchPrincipal({
    pool,
    role: 'independent-review',
    selectionKey: `referee-${ordinal}`,
  }));
  assert.equal(new Set(selected.map((principal) => principal.principalId)).size, 3);

  const reviewer = selected[0];
  const subjectHash = reviewerReceiptSigningSubject({
    unsignedAgentExecutionReceiptHash: digest('unsigned-review'),
    principalDescriptorHash: reviewer.principalDescriptorHash,
    researchPrincipalPoolHash: pool.researchPrincipalPoolHash,
  });
  const signedReceipt = buildSignedReviewerReceipt({
    subjectHash,
    principalId: reviewer.principalId,
    principalDescriptorHash: reviewer.principalDescriptorHash,
    researchPrincipalPoolHash: pool.researchPrincipalPoolHash,
    signerIdentityHash: reviewer.signerIdentityHash,
    signatureHash: digest('review-signature'),
    signatureVerificationReceiptHash: digest('review-signature-verification'),
    signedAt: FIXED_TIME,
  });
  assert.equal(verifySignedReviewerReceipt(signedReceipt, {
    principalId: reviewer.principalId,
    researchPrincipalPoolHash: pool.researchPrincipalPoolHash,
  }), true);
  const signerConfiguration = buildReviewerReceiptSignerServiceConfiguration({
    serviceId: 'reviewer-signer-service-1',
    endpoint: 'https://reviewer-signer.example.test/sign',
    serviceIdentityHash: digest('reviewer-signer-service'),
    signerIdentityHash: reviewer.signerIdentityHash,
    tokenEnvironmentVariable: 'REVIEWER_SIGNER_TEST_TOKEN',
  });
  const signerAdapter = createHttpReviewerReceiptSignerAdapter({
    configuration: signerConfiguration,
    environment: { REVIEWER_SIGNER_TEST_TOKEN: 'signer-secret' },
    fetchImpl: async (_url, init) => {
      const body = JSON.parse(init.body);
      assert.equal(init.headers.authorization, 'Bearer signer-secret');
      assert.equal(body.subjectHash, subjectHash);
      return {
        ok: true,
        async json() {
          return {
            requestHash: body.requestHash,
            serviceId: signerConfiguration.serviceId,
            serviceIdentityHash: signerConfiguration.serviceIdentityHash,
            externalActionPerformed: true,
            signedReviewerReceipt: signedReceipt,
          };
        },
      };
    },
  });
  assert.equal((await signerAdapter.sign({
    subjectHash,
    principal: { ...reviewer, researchPrincipalPoolHash: pool.researchPrincipalPoolHash },
  })).signedReviewerReceiptHash, signedReceipt.signedReviewerReceiptHash);

  const originalExperimentHash = digest('original-experiment');
  const formalReplayHash = digest('formal-replay');
  const replayRequest = buildExternalResearchReplayRequest({
    paperId: 'paper-generalized-1',
    campaignId: 'campaign-generalized-1',
    sourceSnapshotHash: digest('source-snapshot'),
    experimentPairs: [{
      originalExperimentRunReceiptHash: originalExperimentHash,
      localReplayExperimentRunReceiptHash: digest('local-replay'),
      localReplayObservationManifestHash: digest('local-observations'),
    }],
    formalReplayReceiptHashes: [formalReplayHash],
  });
  const replayReceipt = buildExternalResearchReplayReceipt({
    request: replayRequest,
    serviceId: 'offhost-replay-service-1',
    principalId: 'offhost-replay-principal-1',
    providerAccountIdentityHash: digest('offhost-account'),
    credentialRootIdentityHash: digest('offhost-credential'),
    hostIdentityHash: digest('offhost-host'),
    processIdentityHash: digest('offhost-process'),
    trustDomainIdentityHash: digest('offhost-domain'),
    resultManifestHash: digest('offhost-results'),
    reproducedExperimentRunReceiptHashes: [originalExperimentHash],
    reproducedFormalReplayReceiptHashes: [formalReplayHash],
    signerIdentityHash: digest('offhost-signer'),
    signatureHash: digest('offhost-signature'),
    signatureVerificationReceiptHash: digest('offhost-signature-verification'),
    replayedAt: FIXED_TIME,
  });
  assert.equal(verifyExternalResearchReplayReceipt(replayReceipt, {
    request: replayRequest,
  }), true);
  assert.equal(replayReceipt.processIndependent, true);
  assert.equal(replayReceipt.hostIndependent, true);
  assert.equal(replayReceipt.accountIndependent, true);
  assert.equal(replayReceipt.trustDomainIndependent, true);
  const replayConfiguration = buildExternalResearchReplayServiceConfiguration({
    serviceId: replayReceipt.serviceId,
    endpoint: 'https://external-replay.example.test/replay',
    serviceIdentityHash: digest('external-replay-service'),
    tokenEnvironmentVariable: 'EXTERNAL_REPLAY_TEST_TOKEN',
  });
  const replayAdapter = createHttpExternalResearchReplayAdapter({
    configuration: replayConfiguration,
    environment: { EXTERNAL_REPLAY_TEST_TOKEN: 'replay-secret' },
    fetchImpl: async (_url, init) => {
      const body = JSON.parse(init.body);
      assert.equal(init.headers.authorization, 'Bearer replay-secret');
      assert.equal(body.requestHash, replayRequest.requestHash);
      return {
        ok: true,
        async json() {
          return {
            requestHash: replayRequest.requestHash,
            serviceId: replayConfiguration.serviceId,
            serviceIdentityHash: replayConfiguration.serviceIdentityHash,
            externalActionPerformed: true,
            externalResearchReplayReceipt: replayReceipt,
          };
        },
      };
    },
  });
  assert.throws(() => assertExternalResearchReplayPort(replayAdapter, {
    expectedConfigurationHash: digest('different-replay-configuration'),
  }), /external_research_replay_configuration_binding_invalid/);
  assert.equal((await replayAdapter.replay({ request: replayRequest }))
    .externalResearchReplayReceiptHash, replayReceipt.externalResearchReplayReceiptHash);
  const campaignReplay = await runCampaignExternalResearchReplay({
    campaign: {
      paperId: replayRequest.paperId,
      campaignId: replayRequest.campaignId,
      spec: {
        autonomousResearchPreparation: {
          externalResearchReplayConfigurationHash: replayConfiguration.configurationHash,
          capabilityScopeManifest: { replayMode: 'external-trust-domain-v1' },
        },
      },
    },
    campaignResearchSourceSnapshot: {
      campaignResearchSourceSnapshotHash: replayRequest.sourceSnapshotHash,
    },
    campaignExperiments: [{
      experimentRunReceipt: { experimentRunReceiptHash: originalExperimentHash },
      reproducibilityReceipt: {
        replayExperimentRunReceiptHash: digest('local-replay'),
      },
      replayWorkerReceipt: { observationManifestHash: digest('local-observations') },
    }],
    authoritativeFormalReceipt: { formalReplayReceiptHashes: [formalReplayHash] },
    externalResearchReplay: replayAdapter,
  });
  assert.equal(campaignReplay.required, true);
  assert.equal(campaignReplay.request.requestHash, replayRequest.requestHash);
  assert.equal(campaignReplay.receipt.externalResearchReplayReceiptHash,
    replayReceipt.externalResearchReplayReceiptHash);
  assert.deepEqual(await runCampaignExternalResearchReplay({
    campaign: { spec: { autonomousResearchPreparation: {
      capabilityScopeManifest: { replayMode: 'same-process-recomputation-v1' },
    } } },
  }), { required: false, request: null, receipt: null });

  const signedTamper = structuredClone(signedReceipt);
  signedTamper.signatureHash = digest('replacement-signature');
  assert.equal(verifySignedReviewerReceipt(signedTamper), false);
  const replayTamper = structuredClone(replayReceipt);
  replayTamper.hostIndependent = false;
  assert.equal(verifyExternalResearchReplayReceipt(replayTamper, {
    request: replayRequest,
  }), false);
});

test('external replay v2 requires a pinned Ed25519 receipt and does not self-assert identity independence', async () => {
  const replayKey = crypto.generateKeyPairSync('ed25519');
  const originalExperimentHash = digest('v2-original-experiment');
  const request = buildExternalResearchReplayRequest({
    paperId: 'paper-cryptographic-replay-1',
    campaignId: 'campaign-cryptographic-replay-1',
    sourceSnapshotHash: digest('v2-source-snapshot'),
    experimentPairs: [{
      originalExperimentRunReceiptHash: originalExperimentHash,
      localReplayExperimentRunReceiptHash: digest('v2-local-replay'),
      localReplayObservationManifestHash: digest('v2-local-observations'),
    }],
  });
  const legacyReceipt = buildExternalResearchReplayReceipt({
    request,
    serviceId: 'offhost-cryptographic-replay-service-1',
    principalId: 'offhost-cryptographic-replay-principal-1',
    providerAccountIdentityHash: digest('v2-offhost-account'),
    credentialRootIdentityHash: digest('v2-offhost-credential'),
    hostIdentityHash: digest('v2-offhost-host'),
    processIdentityHash: digest('v2-offhost-process'),
    trustDomainIdentityHash: digest('v2-offhost-domain'),
    resultManifestHash: digest('v2-offhost-results'),
    reproducedExperimentRunReceiptHashes: [originalExperimentHash],
    signerIdentityHash: digest('v2-offhost-signer'),
    signatureHash: digest('legacy-v2-offhost-signature'),
    signatureVerificationReceiptHash: digest('legacy-v2-offhost-verification'),
    replayedAt: FIXED_TIME,
  });
  const authorityEnvelope = signedReplayAuthorityEnvelope(
    replayKey,
    legacyReceipt.externalResearchReplayReceiptHash,
  );
  const configuration = buildExternalResearchReplayServiceConfiguration({
    version: 2,
    serviceId: legacyReceipt.serviceId,
    endpoint: 'https://external-replay.example.test/v2/replay',
    serviceIdentityHash: digest('v2-external-replay-service'),
    tokenEnvironmentVariable: 'EXTERNAL_REPLAY_V2_TEST_TOKEN',
    receiptTrustStore: {
      version: 1,
      kind: 'AuthorityTrustStore',
      keys: [{
        keyId: 'external-replay-key-1',
        subjectId: 'external-replay-authority-1',
        organization: 'External Replay Test Authority',
        algorithm: 'ed25519',
        publicKeyPem: replayKey.publicKey.export({ type: 'spki', format: 'pem' }),
        roles: ['external_research_replay_attestor'],
        status: 'active',
        effectiveFrom: '2026-07-18T00:00:00.000Z',
        expiresAt: '2026-07-20T00:00:00.000Z',
        revokedAt: null,
      }],
    },
    receiptSignerKeyIds: ['external-replay-key-1'],
    receiptMaximumLifetimeMs: 5 * 60 * 1000,
  });
  const adapter = createHttpExternalResearchReplayAdapter({
    configuration,
    environment: { EXTERNAL_REPLAY_V2_TEST_TOKEN: 'v2-replay-secret' },
    clock: { now: () => new Date(FIXED_TIME) },
    fetchImpl: async () => ({
      ok: true,
      async json() {
        return {
          requestHash: request.requestHash,
          serviceId: configuration.serviceId,
          serviceIdentityHash: configuration.serviceIdentityHash,
          externalActionPerformed: true,
          externalResearchReplayReceipt: legacyReceipt,
          authorityEnvelope,
        };
      },
    }),
  });
  assert.equal(adapter.cryptographicAuthorityReady, true);
  assert.equal(adapter.identityIndependenceReady, false);
  const receipt = await adapter.replay({ request });
  assert.equal(receipt.version, 2);
  assert.equal(receipt.cryptographicAuthorityReady, true);
  assert.equal(receipt.identityIndependenceReady, false);
  assert.equal(receipt.hostIndependent, false);
  assert.equal(receipt.accountIndependent, false);
  assert.equal(receipt.credentialIndependent, false);
  assert.equal(receipt.trustDomainIndependent, false);
  assert.equal(verifyExternalResearchReplayReceipt(receipt, { request }), true);

  const tamperedEnvelope = structuredClone(authorityEnvelope);
  tamperedEnvelope.subjectHash = digest('tampered-replay-receipt');
  const rejectingAdapter = createHttpExternalResearchReplayAdapter({
    configuration,
    environment: { EXTERNAL_REPLAY_V2_TEST_TOKEN: 'v2-replay-secret' },
    clock: { now: () => new Date(FIXED_TIME) },
    fetchImpl: async () => ({
      ok: true,
      async json() {
        return {
          requestHash: request.requestHash,
          serviceId: configuration.serviceId,
          serviceIdentityHash: configuration.serviceIdentityHash,
          externalActionPerformed: true,
          externalResearchReplayReceipt: legacyReceipt,
          authorityEnvelope: tamperedEnvelope,
        };
      },
    }),
  });
  await assert.rejects(rejectingAdapter.replay({ request }),
    /pinned_external_evidence_verification_capability_invalid/);
});
