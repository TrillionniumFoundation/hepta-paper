import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  buildPinnedExternalEvidenceEnvelope,
  pinnedExternalEvidenceSigningPayload,
} from '../../paper-adapters/authority/pinned-external-evidence-verifier.mjs';
import {
  buildImmutableReviewerWorkspaceSnapshot,
  buildRecoverableReviewerExecutionOutcome,
  buildRecoverableReviewerExecutorServiceConfiguration,
  createHttpRecoverableReviewerExecutorAdapter,
  verifyRecoverableReviewerExecutorServiceConfiguration,
} from '../../paper-adapters/automation/http-recoverable-reviewer-executor-adapter.mjs';
import { hashRecord } from '../../workflow-kernel/record-hash.mjs';

const NOW = new Date('2026-07-25T03:00:00.000Z');
const ROLE = 'reviewer_execution_attestor';
const H = (label) => hashRecord('RecoverableReviewerExecutorTest', { label });

function signedEnvelope(pair, { subjectKind, subjectHash }) {
  const placeholder = buildPinnedExternalEvidenceEnvelope({
    subjectKind,
    subjectHash,
    signedAt: '2026-07-25T02:59:00.000Z',
    expiresAt: '2026-07-25T03:10:00.000Z',
    signatures: [{
      keyId: 'reviewer-execution-key',
      role: ROLE,
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
      keyId: 'reviewer-execution-key',
      role: ROLE,
      algorithm: 'ed25519',
      value,
    }],
  });
}

function principal() {
  return Object.freeze({
    principalId: 'recoverable-reviewer-principal',
    provider: 'provider-neutral-test',
    principalDescriptorHash: H('principal-descriptor'),
    modelIdentityHash: H('model'),
    providerAccountIdentityHash: H('provider-account'),
    credentialRootIdentityHash: H('credential-root'),
    credentialConfigIdentityHash: H('credential-config'),
    trustDomainIdentityHash: H('trust-domain'),
    capabilityReceiptHash: H('capability'),
    signerIdentityHash: H('signer'),
  });
}

function fixture(t, { fetchFactory = null } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hepta-recoverable-reviewer-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const workspacePath = path.join(root, 'workspace');
  fs.mkdirSync(workspacePath, { mode: 0o700 });
  fs.writeFileSync(path.join(workspacePath, 'evidence.json'), '{"ready":true}\n', {
    mode: 0o600,
  });
  const credentialPath = path.join(root, 'reviewer-token');
  fs.writeFileSync(credentialPath, 'opaque-test-token\n', { mode: 0o600 });
  const pair = crypto.generateKeyPairSync('ed25519');
  const configuration = buildRecoverableReviewerExecutorServiceConfiguration({
    serviceId: 'recoverable-reviewer-service',
    endpoint: 'https://reviewer-execution.example.test/v1/execute',
    lookupEndpoint: 'https://reviewer-execution.example.test/v1/operations',
    resumeEndpoint: 'https://reviewer-execution.example.test/v1/resume',
    serviceIdentityHash: H('service'),
    tokenEnvironmentVariable: 'REVIEWER_EXECUTION_TOKEN_FILE',
    timeoutMs: 5_000,
    maximumWorkspaceSnapshotBytes: 1024 * 1024,
    outcomeTrustStore: {
      version: 1,
      kind: 'AuthorityTrustStore',
      keys: [{
        keyId: 'reviewer-execution-key',
        subjectId: 'reviewer-execution-authority',
        organization: 'Independent Reviewer Execution Test Authority',
        algorithm: 'ed25519',
        publicKeyPem: pair.publicKey.export({ type: 'spki', format: 'pem' }),
        roles: [ROLE],
        status: 'active',
        effectiveFrom: '2026-07-25T00:00:00.000Z',
        expiresAt: '2026-07-26T00:00:00.000Z',
        revokedAt: null,
      }],
    },
    outcomeSignerKeyIds: ['reviewer-execution-key'],
    outcomeMaximumLifetimeMs: 15 * 60 * 1000,
  });
  const calls = [];
  let adapter;
  const resultDocument = ({
    operationId,
    idempotencyKey,
    requestHash,
    request,
    operationStatus = 'completed',
    mutate = {},
  }) => {
    let receipt = null;
    if (operationStatus === 'completed') {
      const payload = {
        version: 1,
        kind: 'AgentExecutionReceipt',
        executorId: request.executorId,
        providerMode: 'provider-neutral-test',
        agentId: request.principal.principalId,
        role: request.prompt.role,
        status: 'agent_execution_completed',
        promptHash: request.promptHash,
        changedPaths: Object.freeze([]),
        blockers: Object.freeze([]),
        finalOutput: '{"status":"approved"}',
        structuredOutput: Object.freeze({ status: 'approved' }),
        externalActionPerformed: false,
        externalActionVerification: 'signed_recoverable_reviewer_service',
        recoverableReviewerRequestHash: requestHash,
        recoverableReviewerServiceIdentityHash:
          configuration.serviceIdentityHash,
        recoverableReviewerConfigurationHash: configuration.configurationHash,
        recoverableReviewerTrustStoreHash: configuration.outcomeTrustStoreHash,
        immutableWorkspaceSnapshotHash: request.immutableWorkspaceSnapshotHash,
      };
      receipt = Object.freeze({
        ...payload,
        agentExecutionReceiptHash: hashRecord('AgentExecutionReceipt', payload),
      });
    }
    const resultReceiptHash = receipt?.agentExecutionReceiptHash || null;
    const outcome = buildRecoverableReviewerExecutionOutcome({
      serviceId: configuration.serviceId,
      serviceIdentityHash: configuration.serviceIdentityHash,
      configurationHash: configuration.configurationHash,
      outcomeTrustStoreHash: configuration.outcomeTrustStoreHash,
      recoveryOutcomeVerificationPolicyHash:
        adapter.recoveryOutcomeVerificationPolicyHash,
      operationId,
      idempotencyKey,
      requestHash,
      operationStatus,
      externalActionPerformed: operationStatus === 'completed',
      resultReceiptHash,
    });
    return {
      serviceId: configuration.serviceId,
      serviceIdentityHash: configuration.serviceIdentityHash,
      configurationHash: configuration.configurationHash,
      outcomeTrustStoreHash: configuration.outcomeTrustStoreHash,
      recoveryOutcomeVerificationPolicyHash:
        adapter.recoveryOutcomeVerificationPolicyHash,
      operationId,
      idempotencyKey,
      requestHash,
      operationStatus,
      externalActionPerformed: operationStatus === 'completed',
      resultReceiptHash,
      agentExecutionReceipt: receipt,
      recoveryAuthorityEnvelope: signedEnvelope(pair, {
        subjectKind: outcome.kind,
        subjectHash: outcome.recoverableReviewerExecutionOutcomeHash,
      }),
      ...mutate,
    };
  };
  const defaultFetch = async (url, init) => {
    const body = init.body ? JSON.parse(init.body) : null;
    calls.push({ url: String(url), init, body });
    const operationId = init.headers['operation-id'];
    const idempotencyKey = init.headers['idempotency-key'];
    if (init.method === 'GET') {
      const selected = new URL(url);
      const requestHash = selected.searchParams.get('requestHash');
      const prior = calls.find((call) => call.body?.requestHash === requestHash);
      return {
        ok: true,
        status: 200,
        async json() {
          return resultDocument({
            operationId,
            idempotencyKey,
            requestHash,
            request: prior.body.request,
          });
        },
      };
    }
    return {
      ok: true,
      status: 200,
      async json() {
        return resultDocument({
          operationId,
          idempotencyKey,
          requestHash: body.requestHash,
          request: body.request,
        });
      },
    };
  };
  const fetchImpl = fetchFactory
    ? fetchFactory({ calls, resultDocument, workspacePath })
    : defaultFetch;
  adapter = createHttpRecoverableReviewerExecutorAdapter({
    configuration,
    principal: principal(),
    environment: {
      REVIEWER_EXECUTION_TOKEN_FILE: credentialPath,
    },
    fetchImpl,
    clock: { now: () => NOW },
  });
  const request = {
    role: 'formal-review',
    instructions: 'Review every bound formal artifact and return a verdict.',
    context: {
      campaignId: 'recoverable-review-campaign',
      nodeId: 'recoverable-review-node',
      evidenceHash: H('evidence'),
    },
    requiredChecks: ['verify receipt hashes'],
    sandbox: 'read-only',
    outputTokenBudget: 4096,
    timeoutMs: 4_000,
    workspacePath,
  };
  return {
    adapter,
    calls,
    configuration,
    request,
    resultDocument,
    workspacePath,
  };
}

test('recoverable reviewer executor binds exact prompt, context, snapshot, and signed recovery', async (t) => {
  const input = fixture(t);
  assert.equal(
    verifyRecoverableReviewerExecutorServiceConfiguration(input.configuration),
    true,
  );
  assert.equal(input.adapter.crashRecoveryReady, true);
  assert.equal(input.adapter.recoveryOutcomeCryptographicAuthorityReady, true);
  const snapshot = buildImmutableReviewerWorkspaceSnapshot({
    workspacePath: input.workspacePath,
  });
  const operationId = H('operation');
  const idempotencyKey = H('idempotency');
  const receipt = await input.adapter.execute({
    ...input.request,
    operationId,
    idempotencyKey,
  });
  assert.equal(receipt.agentId, principal().principalId);
  assert.equal(
    receipt.immutableWorkspaceSnapshotHash,
    snapshot.immutableReviewerWorkspaceSnapshotHash,
  );
  assert.equal(input.calls[0].body.request.prompt.instructions, input.request.instructions);
  assert.deepEqual(input.calls[0].body.request.prompt.context, {
    ...input.request.context,
    immutableWorkspaceSnapshotHash:
      snapshot.immutableReviewerWorkspaceSnapshotHash,
  });
  assert.equal(input.calls[0].body.workspaceSnapshot.files[0].path, 'evidence.json');
  assert.equal(
    Buffer.from(input.calls[0].body.workspaceSnapshot.files[0].contentBase64, 'base64')
      .toString('utf8'),
    '{"ready":true}\n',
  );

  const stableRequest = {
    ...input.request,
    context: input.calls[0].body.request.prompt.context,
  };
  delete stableRequest.workspacePath;
  const recovered = await input.adapter.lookup({
    operationId,
    idempotencyKey,
    request: stableRequest,
  });
  assert.equal(recovered.status, 'completed');
  assert.deepEqual(recovered.receipt, receipt);

  const resumed = await input.adapter.resume({
    operationId,
    idempotencyKey,
    request: stableRequest,
    executionRequest: {
      ...stableRequest,
      workspacePath: input.workspacePath,
    },
  });
  assert.equal(resumed.status, 'completed');
  assert.deepEqual(resumed.receipt, receipt);
  assert.equal(input.calls[2].body.kind, 'RecoverableReviewerExecutionResumeRequest');
});

test('recoverable reviewer lookup accepts only signed definitive-not-found', async (t) => {
  let requestDocument = null;
  const input = fixture(t, {
    fetchFactory: ({ calls, resultDocument }) => async (url, init) => {
      const body = init.body ? JSON.parse(init.body) : null;
      calls.push({ url: String(url), init, body });
      if (body) requestDocument = body;
      if (init.method !== 'GET') {
        return {
          ok: true,
          async json() {
            return resultDocument({
              operationId: init.headers['operation-id'],
              idempotencyKey: init.headers['idempotency-key'],
              requestHash: body.requestHash,
              request: body.request,
            });
          },
        };
      }
      const requestHash = new URL(url).searchParams.get('requestHash');
      return {
        ok: true,
        async json() {
          return resultDocument({
            operationId: init.headers['operation-id'],
            idempotencyKey: init.headers['idempotency-key'],
            requestHash,
            request: requestDocument.request,
            operationStatus: 'not_found',
          });
        },
      };
    },
  });
  const operationId = H('not-found-operation');
  const idempotencyKey = H('not-found-idempotency');
  await input.adapter.execute({ ...input.request, operationId, idempotencyKey });
  const stableRequest = {
    ...input.request,
    context: input.calls[0].body.request.prompt.context,
  };
  delete stableRequest.workspacePath;
  assert.deepEqual(await input.adapter.lookup({
    operationId,
    idempotencyKey,
    request: stableRequest,
  }), { status: 'not_found', receipt: null });
});

test('recoverable reviewer rejects tampering, snapshot drift, and pre-aborted execution', async (t) => {
  const tampered = fixture(t, {
    fetchFactory: ({ calls, resultDocument }) => async (url, init) => {
      const body = JSON.parse(init.body);
      calls.push({ url: String(url), init, body });
      return {
        ok: true,
        async json() {
          return resultDocument({
            operationId: init.headers['operation-id'],
            idempotencyKey: init.headers['idempotency-key'],
            requestHash: body.requestHash,
            request: body.request,
            mutate: { configurationHash: H('attacker-configuration') },
          });
        },
      };
    },
  });
  await assert.rejects(
    () => tampered.adapter.execute(tampered.request),
    /recoverable_reviewer_executor_recovery_response_invalid/,
  );

  const drifted = fixture(t, {
    fetchFactory: ({ calls, resultDocument, workspacePath }) => async (url, init) => {
      const body = JSON.parse(init.body);
      calls.push({ url: String(url), init, body });
      fs.writeFileSync(path.join(workspacePath, 'evidence.json'), '{"ready":false}\n');
      return {
        ok: true,
        async json() {
          return resultDocument({
            operationId: init.headers['operation-id'],
            idempotencyKey: init.headers['idempotency-key'],
            requestHash: body.requestHash,
            request: body.request,
          });
        },
      };
    },
  });
  await assert.rejects(
    () => drifted.adapter.execute(drifted.request),
    /recoverable_reviewer_workspace_snapshot_drift/,
  );

  let fetchCalls = 0;
  const aborted = fixture(t, {
    fetchFactory: () => async () => {
      fetchCalls += 1;
      throw new Error('fetch_must_not_run');
    },
  });
  const controller = new AbortController();
  controller.abort(new Error('already_aborted'));
  await assert.rejects(
    () => aborted.adapter.execute({
      ...aborted.request,
      signal: controller.signal,
    }),
    /already_aborted/,
  );
  assert.equal(fetchCalls, 0);
});

test('recoverable reviewer configuration requires an opaque file reference', (t) => {
  const input = fixture(t);
  assert.throws(() => buildRecoverableReviewerExecutorServiceConfiguration({
    ...input.configuration,
    tokenEnvironmentVariable: 'REVIEWER_EXECUTION_TOKEN',
  }), /recoverable_reviewer_executor_service_configuration_invalid/);
});
