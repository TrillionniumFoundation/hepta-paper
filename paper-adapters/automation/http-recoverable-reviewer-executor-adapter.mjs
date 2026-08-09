import {
  assertPinnedExternalEvidenceEnvelope,
  inspectPinnedExternalEvidenceTrustStore,
} from '../authority/pinned-external-evidence-verifier.mjs';
import {
  verifyAgentExecutionReceipt,
} from '../../paper-domain/evidence/agent-execution-receipt-contract.mjs';
import { assertAgentExecutorPort } from '../../paper-ports/agent-executor-port.mjs';
import {
  buildExecutorCapabilities,
  capabilityRequestFromExecution,
  evaluateExecutorCapabilityRequest,
} from '../../paper-ports/executor-capabilities.mjs';
import { hasExactObjectKeys } from '../../workflow-kernel/exact-object-keys.mjs';
import { hashRecord } from '../../workflow-kernel/record-hash.mjs';
import { resolveOpaqueRuntimeCredential } from './opaque-runtime-credential-file.mjs';
import {
  buildImmutableReviewerWorkspaceSnapshot,
} from './recoverable-reviewer-workspace-snapshot.mjs';
import {
  canonicalExternalPrincipalKeyIds,
} from '../authority/external-principal-identity-attestation-bundle-codec.mjs';

export {
  buildImmutableReviewerWorkspaceSnapshot,
} from './recoverable-reviewer-workspace-snapshot.mjs';

const SHA256 = /^sha256:[0-9a-f]{64}$/;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,191}$/;
const TOKEN_FILE_VARIABLE = /^[A-Z][A-Z0-9_]{1,122}_FILE$/;
const OPERATION_STATUSES = new Set(['completed', 'in_progress', 'not_found']);
const CONFIGURATION_KEYS = Object.freeze([
  'configurationHash', 'endpoint', 'kind', 'lookupEndpoint',
  'maximumWorkspaceSnapshotBytes', 'outcomeMaximumLifetimeMs',
  'outcomeSignerKeyIds', 'outcomeSignerRole', 'outcomeTrustStore',
  'outcomeTrustStoreHash', 'resumeEndpoint', 'serviceId',
  'serviceIdentityHash', 'timeoutMs', 'tokenEnvironmentVariable', 'version',
]);
const PRINCIPAL_BINDING_FIELDS = Object.freeze([
  'capabilityReceiptHash', 'credentialConfigIdentityHash',
  'credentialRootIdentityHash', 'modelIdentityHash', 'principalDescriptorHash',
  'principalId', 'provider', 'providerAccountIdentityHash',
  'signerIdentityHash', 'trustDomainIdentityHash',
]);

export const REVIEWER_EXECUTION_ATTESTOR_ROLE = 'reviewer_execution_attestor';

function httpsUrl(value, code) {
  let selected;
  try { selected = new URL(String(value || '')); }
  catch { throw new Error(code); }
  if (selected.protocol !== 'https:') throw new Error(code);
  return selected.toString();
}

export function buildRecoverableReviewerExecutorServiceConfiguration({
  version = 1,
  serviceId,
  endpoint,
  lookupEndpoint,
  resumeEndpoint,
  serviceIdentityHash,
  tokenEnvironmentVariable,
  timeoutMs = 30 * 60 * 1000,
  maximumWorkspaceSnapshotBytes = 16 * 1024 * 1024,
  outcomeTrustStore,
  outcomeSignerKeyIds = [],
  outcomeSignerRole = REVIEWER_EXECUTION_ATTESTOR_ROLE,
  outcomeMaximumLifetimeMs = 15 * 60 * 1000,
} = {}) {
  const selectedKeyIds = canonicalExternalPrincipalKeyIds(outcomeSignerKeyIds);
  const trust = inspectPinnedExternalEvidenceTrustStore(outcomeTrustStore, {
    requiredRole: outcomeSignerRole,
    expectedKeyIds: selectedKeyIds || [],
  });
  const selectedServiceIdentityHash = String(serviceIdentityHash || '').toLowerCase();
  const selectedTokenVariable = String(tokenEnvironmentVariable || '');
  if (Number(version) !== 1 || !SAFE_ID.test(String(serviceId || ''))
    || !SHA256.test(selectedServiceIdentityHash)
    || !TOKEN_FILE_VARIABLE.test(selectedTokenVariable)
    || !Number.isSafeInteger(Number(timeoutMs)) || Number(timeoutMs) < 1_000
    || Number(timeoutMs) > 60 * 60 * 1000
    || !Number.isSafeInteger(Number(maximumWorkspaceSnapshotBytes))
    || Number(maximumWorkspaceSnapshotBytes) < 1_024
    || Number(maximumWorkspaceSnapshotBytes) > 64 * 1024 * 1024
    || !Number.isSafeInteger(Number(outcomeMaximumLifetimeMs))
    || Number(outcomeMaximumLifetimeMs) < 1_000
    || Number(outcomeMaximumLifetimeMs) > 24 * 60 * 60 * 1000
    || outcomeSignerRole !== REVIEWER_EXECUTION_ATTESTOR_ROLE
    || !selectedKeyIds || !trust.ready) {
    throw new Error('recoverable_reviewer_executor_service_configuration_invalid');
  }
  const payload = {
    version: 1,
    kind: 'RecoverableReviewerExecutorServiceConfiguration',
    serviceId: String(serviceId),
    endpoint: httpsUrl(endpoint, 'recoverable_reviewer_executor_endpoint_invalid'),
    lookupEndpoint: httpsUrl(
      lookupEndpoint,
      'recoverable_reviewer_executor_recovery_endpoint_invalid',
    ),
    resumeEndpoint: httpsUrl(
      resumeEndpoint,
      'recoverable_reviewer_executor_recovery_endpoint_invalid',
    ),
    serviceIdentityHash: selectedServiceIdentityHash,
    tokenEnvironmentVariable: selectedTokenVariable,
    timeoutMs: Number(timeoutMs),
    maximumWorkspaceSnapshotBytes: Number(maximumWorkspaceSnapshotBytes),
    outcomeTrustStore: trust.canonicalTrustStore,
    outcomeTrustStoreHash: trust.trustStoreHash,
    outcomeSignerKeyIds: selectedKeyIds,
    outcomeSignerRole: REVIEWER_EXECUTION_ATTESTOR_ROLE,
    outcomeMaximumLifetimeMs: Number(outcomeMaximumLifetimeMs),
  };
  return Object.freeze({
    ...payload,
    configurationHash: hashRecord(
      'RecoverableReviewerExecutorServiceConfiguration',
      payload,
    ),
  });
}

export function verifyRecoverableReviewerExecutorServiceConfiguration(configuration) {
  if (!hasExactObjectKeys(configuration, CONFIGURATION_KEYS)) return false;
  try {
    return JSON.stringify(buildRecoverableReviewerExecutorServiceConfiguration(
      configuration,
    )) === JSON.stringify(configuration);
  } catch {
    return false;
  }
}

function canonicalJsonValue(value, code) {
  try {
    const serialized = JSON.stringify(value);
    if (serialized === undefined) throw new Error('undefined');
    return JSON.parse(serialized);
  } catch {
    throw new Error(code);
  }
}

function principalBinding(principal) {
  const selected = Object.fromEntries(PRINCIPAL_BINDING_FIELDS.map((field) => (
    [field, principal?.[field] ?? null]
  )));
  if (!SAFE_ID.test(String(selected.principalId || ''))
    || !SAFE_ID.test(String(selected.provider || ''))
    || !PRINCIPAL_BINDING_FIELDS.filter((field) => field.endsWith('Hash'))
      .every((field) => SHA256.test(String(selected[field] || '')))) {
    throw new Error('recoverable_reviewer_executor_principal_binding_invalid');
  }
  return Object.freeze(selected);
}

function throwIfAborted(signal) {
  if (signal?.aborted !== true) return;
  if (signal.reason instanceof Error) throw signal.reason;
  const error = new Error('recoverable_reviewer_executor_aborted');
  error.name = 'AbortError';
  throw error;
}

export function buildRecoverableReviewerExecutionOutcome({
  serviceId,
  serviceIdentityHash,
  configurationHash,
  outcomeTrustStoreHash,
  recoveryOutcomeVerificationPolicyHash,
  operationId,
  idempotencyKey,
  requestHash,
  operationStatus,
  externalActionPerformed,
  resultReceiptHash,
} = {}) {
  const completed = operationStatus === 'completed';
  if (!SAFE_ID.test(String(serviceId || ''))
    || ![
      serviceIdentityHash,
      configurationHash,
      outcomeTrustStoreHash,
      recoveryOutcomeVerificationPolicyHash,
      operationId,
      idempotencyKey,
      requestHash,
    ].every((value) => SHA256.test(String(value || '')))
    || !OPERATION_STATUSES.has(operationStatus)
    || externalActionPerformed !== completed
    || (completed
      ? !SHA256.test(String(resultReceiptHash || ''))
      : resultReceiptHash !== null)) {
    throw new Error('recoverable_reviewer_execution_outcome_invalid');
  }
  const payload = {
    version: 1,
    kind: 'RecoverableReviewerExecutionOutcome',
    serviceId,
    serviceIdentityHash,
    configurationHash,
    outcomeTrustStoreHash,
    recoveryOutcomeVerificationPolicyHash,
    operationId,
    idempotencyKey,
    requestHash,
    operationStatus,
    externalActionPerformed,
    resultReceiptHash,
  };
  return Object.freeze({
    ...payload,
    recoverableReviewerExecutionOutcomeHash: hashRecord(
      'RecoverableReviewerExecutionOutcome',
      payload,
    ),
  });
}

function normalizedRequest({
  input,
  principal,
  selected,
  executorId,
  requireWorkspace,
} = {}) {
  const role = String(input?.role || '');
  const instructions = String(input?.instructions || '');
  const requiredChecks = canonicalJsonValue(
    input?.requiredChecks || [],
    'recoverable_reviewer_executor_request_invalid',
  );
  const originalContext = canonicalJsonValue(
    input?.context || {},
    'recoverable_reviewer_executor_request_invalid',
  );
  if (!['formal-review', 'independent-review'].includes(role)
    || !instructions.trim() || !Array.isArray(requiredChecks)
    || requiredChecks.some((value) => typeof value !== 'string')
    || !originalContext || typeof originalContext !== 'object'
    || Array.isArray(originalContext)
    || (input?.sandbox || 'read-only') !== 'read-only') {
    throw new Error('recoverable_reviewer_executor_request_invalid');
  }
  let workspaceSnapshot = null;
  if (input?.workspacePath) {
    workspaceSnapshot = buildImmutableReviewerWorkspaceSnapshot({
      workspacePath: input.workspacePath,
      maximumBytes: selected.maximumWorkspaceSnapshotBytes,
    });
  } else if (requireWorkspace) {
    throw new Error('recoverable_reviewer_executor_workspace_required');
  }
  const observedSnapshotHash =
    workspaceSnapshot?.immutableReviewerWorkspaceSnapshotHash || null;
  const declaredSnapshotHash = String(
    originalContext.immutableWorkspaceSnapshotHash || '',
  ).toLowerCase();
  if ((observedSnapshotHash && declaredSnapshotHash
      && observedSnapshotHash !== declaredSnapshotHash)
    || (!observedSnapshotHash && !SHA256.test(declaredSnapshotHash))) {
    throw new Error('recoverable_reviewer_workspace_snapshot_binding_invalid');
  }
  const immutableWorkspaceSnapshotHash =
    observedSnapshotHash || declaredSnapshotHash;
  const context = Object.freeze({
    ...originalContext,
    immutableWorkspaceSnapshotHash,
  });
  const prompt = Object.freeze({
    role,
    instructions,
    context,
    requiredChecks: Object.freeze(requiredChecks),
    sandbox: 'read-only',
    outputTokenBudget: input?.outputTokenBudget ?? null,
    timeoutMs: input?.timeoutMs ?? null,
    workspaceMutationPolicy: canonicalJsonValue(
      input?.workspaceMutationPolicy ?? null,
      'recoverable_reviewer_executor_request_invalid',
    ),
  });
  const promptHash = hashRecord('RecoverableReviewerExecutionPrompt', prompt);
  const requestPayload = Object.freeze({
    version: 1,
    kind: 'RecoverableReviewerExecutionRequest',
    serviceId: selected.serviceId,
    serviceIdentityHash: selected.serviceIdentityHash,
    configurationHash: selected.configurationHash,
    outcomeTrustStoreHash: selected.outcomeTrustStoreHash,
    executorId,
    principal: principalBinding(principal),
    prompt,
    promptHash,
    immutableWorkspaceSnapshotHash,
  });
  return Object.freeze({
    requestPayload,
    requestHash: hashRecord(
      'RecoverableReviewerExecutionRequest',
      requestPayload,
    ),
    workspaceSnapshot,
  });
}

export function createHttpRecoverableReviewerExecutorAdapter({
  configuration,
  principal,
  environment = process.env,
  fetchImpl = globalThis.fetch,
  clock = { now: () => new Date() },
  assertExternalSideEffectReady = null,
} = {}) {
  const selected = buildRecoverableReviewerExecutorServiceConfiguration(configuration);
  const boundPrincipal = principalBinding(principal);
  if (assertExternalSideEffectReady !== null
    && typeof assertExternalSideEffectReady !== 'function') {
    throw new Error('recoverable_reviewer_executor_side_effect_gate_invalid');
  }
  const token = resolveOpaqueRuntimeCredential({
    environment,
    variableName: selected.tokenEnvironmentVariable,
  });
  if (!token || typeof fetchImpl !== 'function') {
    throw new Error('recoverable_reviewer_executor_runtime_credentials_missing');
  }
  const executorId = `http-recoverable-reviewer-v1:${boundPrincipal.principalId}`;
  const capabilities = buildExecutorCapabilities({
    executorId,
    sandboxModes: ['read-only'],
    networkPolicy: 'provider-scoped',
    externalActions: false,
    workspaceIsolation: true,
    maximumTimeoutMs: selected.timeoutMs,
    receiptKinds: ['AgentExecutionReceipt'],
    provider: 'provider-neutral-recoverable-reviewer-service',
  });
  const recoveryConfigurationIdentityHash = hashRecord(
    'RecoverableReviewerExecutorRecoveryConfiguration',
    {
      configurationHash: selected.configurationHash,
      principalDescriptorHash: boundPrincipal.principalDescriptorHash,
      lookupEndpoint: selected.lookupEndpoint,
      resumeEndpoint: selected.resumeEndpoint,
      workspaceSnapshotTransport: 'inline-canonical-base64-v1',
      protocol: 'pinned-signed-execute-lookup-resume-idempotency-v1',
    },
  );
  const recoveryOutcomeVerificationPolicyHash = hashRecord(
    'RecoverableReviewerExecutionOutcomeVerificationPolicy',
    {
      configurationHash: selected.configurationHash,
      outcomeTrustStoreHash: selected.outcomeTrustStoreHash,
      outcomeSignerKeyIds: selected.outcomeSignerKeyIds,
      outcomeSignerRole: selected.outcomeSignerRole,
      outcomeMaximumLifetimeMs: selected.outcomeMaximumLifetimeMs,
      principalDescriptorHash: boundPrincipal.principalDescriptorHash,
      policy: 'pinned-canonical-json-ed25519-v1',
    },
  );
  const assertCapabilities = (input) => {
    const preflight = evaluateExecutorCapabilityRequest({
      capabilities,
      request: capabilityRequestFromExecution(input),
    });
    if (preflight.blockers.length) {
      throw new Error(preflight.blockers.join(','));
    }
  };

  const invokeHttp = async (endpoint, init, signal) => {
    throwIfAborted(signal);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), selected.timeoutMs);
    const abort = () => controller.abort(signal?.reason);
    signal?.addEventListener?.('abort', abort, { once: true });
    try {
      throwIfAborted(signal);
      return await fetchImpl(endpoint, {
        ...init,
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener?.('abort', abort);
    }
  };

  const verifyReceipt = (receipt, context) => (
    verifyAgentExecutionReceipt(receipt)
    && receipt.status === 'agent_execution_completed'
    && receipt.executorId === executorId
    && receipt.agentId === boundPrincipal.principalId
    && receipt.role === context.requestPayload.prompt.role
    && receipt.promptHash === context.requestPayload.promptHash
    && receipt.recoverableReviewerRequestHash === context.requestHash
    && receipt.recoverableReviewerServiceIdentityHash
      === selected.serviceIdentityHash
    && receipt.recoverableReviewerConfigurationHash
      === selected.configurationHash
    && receipt.recoverableReviewerTrustStoreHash
      === selected.outcomeTrustStoreHash
    && receipt.immutableWorkspaceSnapshotHash
      === context.requestPayload.immutableWorkspaceSnapshotHash
    && receipt.externalActionPerformed === false
    && Array.isArray(receipt.changedPaths)
    && receipt.changedPaths.length === 0
  );

  const verifyOutcome = (document, context, {
    operationId,
    idempotencyKey,
    resultReceiptHash,
  }) => {
    if (document?.serviceId !== selected.serviceId
      || document?.serviceIdentityHash !== selected.serviceIdentityHash
      || document?.configurationHash !== selected.configurationHash
      || document?.outcomeTrustStoreHash !== selected.outcomeTrustStoreHash
      || document?.recoveryOutcomeVerificationPolicyHash
        !== recoveryOutcomeVerificationPolicyHash
      || document?.operationId !== operationId
      || document?.idempotencyKey !== idempotencyKey
      || document?.requestHash !== context.requestHash) {
      throw new Error('recoverable_reviewer_executor_recovery_response_invalid');
    }
    let outcome;
    try {
      outcome = buildRecoverableReviewerExecutionOutcome({
        serviceId: selected.serviceId,
        serviceIdentityHash: selected.serviceIdentityHash,
        configurationHash: selected.configurationHash,
        outcomeTrustStoreHash: selected.outcomeTrustStoreHash,
        recoveryOutcomeVerificationPolicyHash,
        operationId,
        idempotencyKey,
        requestHash: context.requestHash,
        operationStatus: document.operationStatus,
        externalActionPerformed: document.externalActionPerformed,
        resultReceiptHash,
      });
    } catch {
      throw new Error('recoverable_reviewer_executor_recovery_response_invalid');
    }
    assertPinnedExternalEvidenceEnvelope({
      envelope: document.recoveryAuthorityEnvelope,
      subjectKind: outcome.kind,
      subjectHash: outcome.recoverableReviewerExecutionOutcomeHash,
      trustStore: selected.outcomeTrustStore,
      requiredRole: selected.outcomeSignerRole,
      expectedKeyIds: selected.outcomeSignerKeyIds,
      now: clock.now(),
      maximumLifetimeMs: selected.outcomeMaximumLifetimeMs,
    });
    return outcome;
  };

  const completedReceipt = (document, context, {
    operationId,
    idempotencyKey,
  }) => {
    const receipt = document?.agentExecutionReceipt;
    if (document?.operationStatus !== 'completed'
      || document?.externalActionPerformed !== true
      || document?.resultReceiptHash !== receipt?.agentExecutionReceiptHash
      || !verifyReceipt(receipt, context)) {
      throw new Error('recoverable_reviewer_executor_response_invalid');
    }
    verifyOutcome(document, context, {
      operationId,
      idempotencyKey,
      resultReceiptHash: receipt.agentExecutionReceiptHash,
    });
    return Object.freeze(receipt);
  };

  const authorize = async (input, action, operationId, idempotencyKey) => {
    const gate = input?.assertExternalSideEffectReady
      || assertExternalSideEffectReady;
    if (gate !== null && gate !== undefined && typeof gate !== 'function') {
      throw new Error('recoverable_reviewer_executor_side_effect_gate_invalid');
    }
    if (!gate) return;
    await gate({
      action,
      campaignId: input?.context?.campaignId || null,
      nodeId: input?.context?.nodeId || null,
      operationId,
      idempotencyKey,
    });
    gate.assertCurrent?.({
      action,
      campaignId: input?.context?.campaignId || null,
      nodeId: input?.context?.nodeId || null,
      operationId,
      idempotencyKey,
    });
    await gate.markStarted?.({ action, operationId, idempotencyKey });
  };

  const recoveryResolution = async (action, input = {}) => {
    throwIfAborted(input.signal);
    if (!SHA256.test(String(input.operationId || ''))
      || !SHA256.test(String(input.idempotencyKey || ''))) {
      throw new Error('recoverable_reviewer_executor_recovery_request_invalid');
    }
    const requiresWorkspace = action === 'resume';
    if (requiresWorkspace) {
      assertCapabilities(input.executionRequest || input.request);
    }
    const context = normalizedRequest({
      input: input.request && !requiresWorkspace
        ? input.request : input.executionRequest || input.request,
      principal: boundPrincipal,
      selected,
      executorId,
      requireWorkspace: requiresWorkspace,
    });
    if (action === 'resume') {
      await authorize(
        input.executionRequest || input.request,
        'recoverable_reviewer_resume',
        input.operationId,
        input.idempotencyKey,
      );
    }
    const headers = {
      authorization: `Bearer ${token}`,
      accept: 'application/json',
      'content-type': 'application/json',
      'operation-id': input.operationId,
      'idempotency-key': input.idempotencyKey,
    };
    let endpoint = selected.resumeEndpoint;
    let init = {
      method: 'POST',
      headers,
      body: JSON.stringify({
        version: 1,
        kind: 'RecoverableReviewerExecutionResumeRequest',
        operationId: input.operationId,
        idempotencyKey: input.idempotencyKey,
        request: context.requestPayload,
        requestHash: context.requestHash,
        workspaceSnapshot: context.workspaceSnapshot,
      }),
    };
    if (action === 'lookup') {
      endpoint = new URL(selected.lookupEndpoint);
      endpoint.searchParams.set('operationId', input.operationId);
      endpoint.searchParams.set('idempotencyKey', input.idempotencyKey);
      endpoint.searchParams.set('requestHash', context.requestHash);
      init = { method: 'GET', headers };
    }
    const response = await invokeHttp(endpoint, init, input.signal);
    if (!response?.ok) {
      throw new Error(
        `recoverable_reviewer_executor_recovery_http_failed:${response?.status || 0}`,
      );
    }
    const document = await response.json();
    if (!OPERATION_STATUSES.has(document?.operationStatus)) {
      throw new Error('recoverable_reviewer_executor_recovery_response_invalid');
    }
    if (document.operationStatus !== 'completed') {
      if ((document.agentExecutionReceipt !== null
          && document.agentExecutionReceipt !== undefined)
        || (document.resultReceiptHash !== null
          && document.resultReceiptHash !== undefined)) {
        throw new Error('recoverable_reviewer_executor_recovery_response_invalid');
      }
      verifyOutcome(document, context, {
        operationId: input.operationId,
        idempotencyKey: input.idempotencyKey,
        resultReceiptHash: null,
      });
      return Object.freeze({ status: document.operationStatus, receipt: null });
    }
    const receipt = completedReceipt(document, context, {
      operationId: input.operationId,
      idempotencyKey: input.idempotencyKey,
    });
    if (context.workspaceSnapshot) {
      const postSnapshot = buildImmutableReviewerWorkspaceSnapshot({
        workspacePath: (input.executionRequest || input.request).workspacePath,
        maximumBytes: selected.maximumWorkspaceSnapshotBytes,
      });
      if (postSnapshot.immutableReviewerWorkspaceSnapshotHash
        !== context.requestPayload.immutableWorkspaceSnapshotHash) {
        throw new Error('recoverable_reviewer_workspace_snapshot_drift');
      }
    }
    return Object.freeze({ status: 'completed', receipt });
  };

  return assertAgentExecutorPort(Object.freeze({
    version: 1,
    kind: 'HttpRecoverableReviewerExecutor',
    executorId,
    capabilities: () => capabilities,
    configurationHash: selected.configurationHash,
    serviceId: selected.serviceId,
    serviceIdentityHash: selected.serviceIdentityHash,
    crashRecoveryReady: true,
    recoveryConfigurationIdentityHash,
    recoveryOutcomeCryptographicAuthorityReady: true,
    recoveryOutcomeVerificationPolicyHash,
    async lookup(input) {
      return recoveryResolution('lookup', input);
    },
    async resume(input) {
      return recoveryResolution('resume', input);
    },
    async execute(input = {}) {
      throwIfAborted(input.signal);
      assertCapabilities(input);
      const context = normalizedRequest({
        input,
        principal: boundPrincipal,
        selected,
        executorId,
        requireWorkspace: true,
      });
      if ((input.operationId !== null && input.operationId !== undefined
          && !SHA256.test(String(input.operationId)))
        || (input.idempotencyKey !== null && input.idempotencyKey !== undefined
          && !SHA256.test(String(input.idempotencyKey)))) {
        throw new Error('recoverable_reviewer_executor_operation_identity_invalid');
      }
      const operationId = SHA256.test(String(input.operationId || ''))
        ? input.operationId : hashRecord('RecoverableReviewerExecutionOperation', {
          requestHash: context.requestHash,
          serviceIdentityHash: selected.serviceIdentityHash,
        });
      const idempotencyKey = SHA256.test(String(input.idempotencyKey || ''))
        ? input.idempotencyKey : hashRecord('RecoverableReviewerExecutionIdempotency', {
          operationId,
          requestHash: context.requestHash,
          configurationHash: selected.configurationHash,
        });
      await authorize(
        input,
        'recoverable_reviewer_execute',
        operationId,
        idempotencyKey,
      );
      const response = await invokeHttp(selected.endpoint, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${token}`,
          'content-type': 'application/json',
          'operation-id': operationId,
          'idempotency-key': idempotencyKey,
        },
        body: JSON.stringify({
          version: 1,
          kind: 'RecoverableReviewerExecutionOperationRequest',
          operationId,
          idempotencyKey,
          request: context.requestPayload,
          requestHash: context.requestHash,
          workspaceSnapshot: context.workspaceSnapshot,
        }),
      }, input.signal);
      if (!response?.ok) {
        throw new Error(
          `recoverable_reviewer_executor_http_failed:${response?.status || 0}`,
        );
      }
      const receipt = completedReceipt(await response.json(), context, {
        operationId,
        idempotencyKey,
      });
      const postSnapshot = buildImmutableReviewerWorkspaceSnapshot({
        workspacePath: input.workspacePath,
        maximumBytes: selected.maximumWorkspaceSnapshotBytes,
      });
      if (postSnapshot.immutableReviewerWorkspaceSnapshotHash
        !== context.requestPayload.immutableWorkspaceSnapshotHash) {
        throw new Error('recoverable_reviewer_workspace_snapshot_drift');
      }
      return receipt;
    },
  }));
}
