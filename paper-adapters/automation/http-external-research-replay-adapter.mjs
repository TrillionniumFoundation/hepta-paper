import fs from 'node:fs';
import path from 'node:path';
import { assertExternalResearchReplayPort } from '../../paper-ports/external-research-replay-port.mjs';
import {
  buildCryptographicExternalResearchReplayReceipt,
  verifyExternalResearchReplayRequest,
  verifyExternalResearchReplayReceipt,
} from '../../paper-domain/research/external-research-replay-contract.mjs';
import {
  buildExternalResearchReplayRecoveryOutcome,
} from '../../paper-domain/research/external-operation-recovery-outcome-contract.mjs';
import {
  assertPinnedExternalEvidenceEnvelope,
  inspectPinnedExternalEvidenceTrustStore,
} from '../authority/pinned-external-evidence-verifier.mjs';
import {
  buildExternalResearchReplayIdentityAttestationBundle,
} from './external-research-replay-identity-attestation.mjs';
import {
  createExternalResearchReplayReceiptVerifier,
} from './external-research-replay-receipt-verifier.mjs';
import { hasExactObjectKeys } from '../../workflow-kernel/exact-object-keys.mjs';
import { hashRecord } from '../../workflow-kernel/record-hash.mjs';
import { resolveOpaqueRuntimeCredential } from './opaque-runtime-credential-file.mjs';

const SHA256 = /^sha256:[0-9a-f]{64}$/;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,191}$/;
const CONFIG_KEYS_V1 = Object.freeze([
  'configurationHash', 'endpoint', 'kind', 'serviceId', 'serviceIdentityHash',
  'timeoutMs', 'tokenEnvironmentVariable', 'version',
]);
const CONFIG_KEYS_V2 = Object.freeze([
  ...CONFIG_KEYS_V1,
  'receiptMaximumLifetimeMs', 'receiptSignerKeyIds', 'receiptSignerRole',
  'receiptTrustStore', 'receiptTrustStoreHash',
]);
const CONFIG_KEYS_V3 = Object.freeze([
  ...CONFIG_KEYS_V2,
  'localOriginIdentityAttestationBundles', 'remoteIdentityAttestationBundle',
]);
const CONFIG_KEYS_V4 = Object.freeze([
  ...CONFIG_KEYS_V3,
  'lookupEndpoint', 'resumeEndpoint',
]);
const REPLAY_SIGNER_ROLE = 'external_research_replay_attestor';

function requestAbortError(signal, code) {
  if (signal?.reason instanceof Error) return signal.reason;
  const error = new Error(code);
  error.name = 'AbortError';
  return error;
}

export function buildExternalResearchReplayServiceConfiguration({
  version = 1,
  serviceId,
  endpoint,
  serviceIdentityHash,
  tokenEnvironmentVariable,
  timeoutMs = 60 * 60 * 1000,
  receiptTrustStore = null,
  receiptSignerKeyIds = [],
  receiptSignerRole = REPLAY_SIGNER_ROLE,
  receiptMaximumLifetimeMs = 60 * 60 * 1000,
  remoteIdentityAttestationBundle = null,
  localOriginIdentityAttestationBundles = [],
  lookupEndpoint = null,
  resumeEndpoint = null,
} = {}) {
  let url;
  try { url = new URL(String(endpoint || '')); }
  catch { throw new Error('external_research_replay_endpoint_invalid'); }
  if (![1, 2, 3, 4].includes(Number(version))
    || url.protocol !== 'https:' || !SAFE_ID.test(String(serviceId || ''))
    || !SHA256.test(String(serviceIdentityHash || '').toLowerCase())
    || !/^[A-Z][A-Z0-9_]{1,127}$/.test(String(tokenEnvironmentVariable || ''))
    || !Number.isSafeInteger(Number(timeoutMs)) || Number(timeoutMs) < 60_000
    || Number(timeoutMs) > 12 * 60 * 60 * 1000) {
    throw new Error('external_research_replay_service_configuration_invalid');
  }
  const payload = {
    version: Number(version),
    kind: 'ExternalResearchReplayServiceConfiguration',
    serviceId: String(serviceId),
    endpoint: url.toString(),
    serviceIdentityHash: String(serviceIdentityHash).toLowerCase(),
    tokenEnvironmentVariable: String(tokenEnvironmentVariable),
    timeoutMs: Number(timeoutMs),
  };
  if (Number(version) >= 2) {
    const expectedKeyIds = [...new Set((Array.isArray(receiptSignerKeyIds)
      ? receiptSignerKeyIds : []).map(String))].sort();
    const trust = inspectPinnedExternalEvidenceTrustStore(receiptTrustStore, {
      requiredRole: receiptSignerRole,
      expectedKeyIds,
    });
    if (!trust.ready || receiptSignerRole !== REPLAY_SIGNER_ROLE
      || expectedKeyIds.length < 1 || expectedKeyIds.length > 4
      || !Number.isSafeInteger(Number(receiptMaximumLifetimeMs))
      || Number(receiptMaximumLifetimeMs) < 1_000
      || Number(receiptMaximumLifetimeMs) > 24 * 60 * 60 * 1000) {
      throw new Error('external_research_replay_trust_configuration_invalid');
    }
    Object.assign(payload, {
      receiptTrustStore: trust.canonicalTrustStore,
      receiptTrustStoreHash: trust.trustStoreHash,
      receiptSignerKeyIds: Object.freeze(expectedKeyIds),
      receiptSignerRole: REPLAY_SIGNER_ROLE,
      receiptMaximumLifetimeMs: Number(receiptMaximumLifetimeMs),
    });
    if (Number(version) >= 3) {
      const remoteIdentity = buildExternalResearchReplayIdentityAttestationBundle(
        remoteIdentityAttestationBundle,
      );
      const localOrigins = (Array.isArray(localOriginIdentityAttestationBundles)
        ? localOriginIdentityAttestationBundles : []).map((bundle) => (
        buildExternalResearchReplayIdentityAttestationBundle(bundle)
      ));
      if (localOrigins.length < 1 || localOrigins.length > 64) {
        throw new Error('external_research_replay_origin_identity_set_invalid');
      }
      Object.assign(payload, {
        remoteIdentityAttestationBundle: remoteIdentity,
        localOriginIdentityAttestationBundles: Object.freeze(localOrigins),
      });
      if (Number(version) === 4) {
        let lookupUrl;
        let resumeUrl;
        try {
          lookupUrl = new URL(String(lookupEndpoint || ''));
          resumeUrl = new URL(String(resumeEndpoint || ''));
        } catch {
          throw new Error('external_research_replay_recovery_endpoint_invalid');
        }
        if (lookupUrl.protocol !== 'https:' || resumeUrl.protocol !== 'https:') {
          throw new Error('external_research_replay_recovery_endpoint_invalid');
        }
        Object.assign(payload, {
          lookupEndpoint: lookupUrl.toString(),
          resumeEndpoint: resumeUrl.toString(),
        });
      }
    }
  }
  return Object.freeze({
    ...payload,
    configurationHash:
      hashRecord('ExternalResearchReplayServiceConfiguration', payload),
  });
}

export function readExternalResearchReplayServiceConfiguration({ configPath } = {}) {
  const candidate = path.resolve(String(configPath || ''));
  let parsed;
  try {
    const stat = fs.lstatSync(candidate);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 1024 * 1024) throw new Error('invalid');
    parsed = JSON.parse(fs.readFileSync(candidate, 'utf8'));
  } catch { throw new Error('external_research_replay_configuration_file_invalid'); }
  const expectedKeys = parsed?.version === 4
    ? CONFIG_KEYS_V4 : parsed?.version === 3
      ? CONFIG_KEYS_V3 : parsed?.version === 2 ? CONFIG_KEYS_V2 : CONFIG_KEYS_V1;
  if (!hasExactObjectKeys(parsed, expectedKeys)) {
    throw new Error('external_research_replay_configuration_shape_invalid');
  }
  const rebuilt = buildExternalResearchReplayServiceConfiguration(parsed);
  if (JSON.stringify(rebuilt) !== JSON.stringify(parsed)) {
    throw new Error('external_research_replay_configuration_verification_failed');
  }
  return rebuilt;
}

export function createHttpExternalResearchReplayAdapter({
  configuration,
  environment = process.env,
  fetchImpl = globalThis.fetch,
  requiredLocalOriginIdentitySubjectHashes = [],
  clock = { now: () => new Date() },
} = {}) {
  const selected = buildExternalResearchReplayServiceConfiguration(configuration);
  const token = resolveOpaqueRuntimeCredential({
    environment,
    variableName: selected.tokenEnvironmentVariable,
  });
  if (!token || typeof fetchImpl !== 'function') {
    throw new Error('external_research_replay_runtime_credentials_missing');
  }
  const receiptVerifier = selected.version >= 3
    ? createExternalResearchReplayReceiptVerifier({ configuration: selected, clock })
    : null;
  const requiredOriginHashes = [...new Set((Array.isArray(
    requiredLocalOriginIdentitySubjectHashes,
  ) ? requiredLocalOriginIdentitySubjectHashes : []).map((value) => (
    String(value || '').toLowerCase()
  )))].sort();
  const observedOriginHashes = receiptVerifier?.identitySeparationInspection
    ?.localOriginIdentitySubjects?.map((subject) => (
      subject?.externalPrincipalIdentityAttestationSubjectHash || null
    )) || [];
  if (requiredOriginHashes.some((value) => !SHA256.test(value))
    || requiredOriginHashes.some((value) => !observedOriginHashes.includes(value))) {
    throw new Error('external_research_replay_required_origin_identity_missing');
  }
  const recoveryConfigurationIdentityHash = selected.version === 4
    ? hashRecord('ExternalResearchReplayRecoveryConfiguration', {
      configurationHash: selected.configurationHash,
      lookupEndpoint: selected.lookupEndpoint,
      resumeEndpoint: selected.resumeEndpoint,
      protocol: 'pinned-signed-lookup-resume-idempotency-v1',
    }) : null;
  const recoveryOutcomeVerificationPolicyHash = selected.version === 4
    ? hashRecord('ExternalResearchReplayRecoveryOutcomeVerificationPolicy', {
      receiptTrustStoreHash: selected.receiptTrustStoreHash,
      receiptSignerKeyIds: selected.receiptSignerKeyIds,
      receiptSignerRole: selected.receiptSignerRole,
      receiptMaximumLifetimeMs: selected.receiptMaximumLifetimeMs,
      policy: 'pinned-canonical-json-ed25519-v1',
    }) : null;
  const verifyRecoveryOutcome = (document, request, {
    operationId,
    idempotencyKey,
    resultHash,
  }) => {
    if (selected.version !== 4
      || document?.operationId !== operationId
      || document?.idempotencyKey !== idempotencyKey
      || document?.requestHash !== request.requestHash
      || document?.serviceId !== selected.serviceId
      || document?.serviceIdentityHash !== selected.serviceIdentityHash) {
      throw new Error('external_research_replay_recovery_response_invalid');
    }
    let outcome;
    try {
      outcome = buildExternalResearchReplayRecoveryOutcome({
        serviceId: selected.serviceId,
        serviceIdentityHash: selected.serviceIdentityHash,
        operationId,
        idempotencyKey,
        requestHash: request.requestHash,
        operationStatus: document.operationStatus,
        externalActionPerformed: document.externalActionPerformed,
        resultHash,
      });
    } catch {
      throw new Error('external_research_replay_recovery_response_invalid');
    }
    assertPinnedExternalEvidenceEnvelope({
      envelope: document?.recoveryAuthorityEnvelope,
      subjectKind: outcome.kind,
      subjectHash: outcome.externalResearchReplayRecoveryOutcomeHash,
      trustStore: selected.receiptTrustStore,
      requiredRole: selected.receiptSignerRole,
      expectedKeyIds: selected.receiptSignerKeyIds,
      now: clock.now(),
      maximumLifetimeMs: selected.receiptMaximumLifetimeMs,
    });
    return outcome;
  };
  const receiptFromDocument = (document, request, {
    operationId = null,
    idempotencyKey = null,
  } = {}) => {
    const legacyReceipt = document?.externalResearchReplayReceipt;
    if (document?.requestHash !== request.requestHash
      || document?.serviceId !== selected.serviceId
      || document?.serviceIdentityHash !== selected.serviceIdentityHash
      || document?.externalActionPerformed !== true
      || (selected.version === 4
        && (document?.operationStatus !== 'completed'
          || document?.operationId !== operationId
          || document?.idempotencyKey !== idempotencyKey))
      || !verifyExternalResearchReplayReceipt(legacyReceipt, { request })) {
      throw new Error('external_research_replay_response_invalid');
    }
    if (selected.version === 4) {
      verifyRecoveryOutcome(document, request, {
        operationId,
        idempotencyKey,
        resultHash: legacyReceipt.externalResearchReplayReceiptHash,
      });
    }
    if (selected.version === 1) return Object.freeze(legacyReceipt);
    const signatureVerificationReceipt = assertPinnedExternalEvidenceEnvelope({
      envelope: document?.authorityEnvelope,
      subjectKind: 'ExternalResearchReplayReceiptV1',
      subjectHash: legacyReceipt.externalResearchReplayReceiptHash,
      trustStore: selected.receiptTrustStore,
      requiredRole: selected.receiptSignerRole,
      expectedKeyIds: selected.receiptSignerKeyIds,
      now: clock.now(),
      maximumLifetimeMs: selected.receiptMaximumLifetimeMs,
    });
    if (selected.version >= 3) {
      return receiptVerifier.wrap({
        request,
        legacyReceipt,
        resultAuthorityEnvelope: document.authorityEnvelope,
      });
    }
    return buildCryptographicExternalResearchReplayReceipt({
      request,
      legacyReceipt,
      authorityEnvelope: document.authorityEnvelope,
      signatureVerificationReceipt,
    });
  };
  const invokeHttp = async (endpoint, init, signal) => {
    if (signal?.aborted) {
      throw requestAbortError(signal, 'external_research_replay_request_aborted');
    }
    const controller = new AbortController();
    const abort = () => controller.abort(signal?.reason);
    signal?.addEventListener?.('abort', abort, { once: true });
    if (signal?.aborted) abort();
    const timer = setTimeout(() => controller.abort(), selected.timeoutMs);
    try {
      if (controller.signal.aborted) {
        throw requestAbortError(signal, 'external_research_replay_request_aborted');
      }
      return await fetchImpl(endpoint, {
        ...init,
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener?.('abort', abort);
    }
  };
  const recoveryResolution = async (action, {
    operationId,
    request,
    idempotencyKey,
    signal = null,
  } = {}) => {
    if (selected.version !== 4
      || !verifyExternalResearchReplayRequest(request)
      || !SHA256.test(String(operationId || ''))
      || !SHA256.test(String(idempotencyKey || ''))) {
      throw new Error('external_research_replay_recovery_request_invalid');
    }
    const headers = {
      authorization: `Bearer ${token}`,
      accept: 'application/json',
      'content-type': 'application/json',
      'idempotency-key': idempotencyKey,
      'operation-id': operationId,
    };
    let endpoint = selected.resumeEndpoint;
    let init = {
      method: 'POST',
      headers,
      body: JSON.stringify({
        version: 1,
        kind: 'ExternalResearchReplayResumeRequest',
        operationId,
        idempotencyKey,
        request,
      }),
    };
    if (action === 'lookup') {
      endpoint = new URL(selected.lookupEndpoint);
      endpoint.searchParams.set('operationId', operationId);
      endpoint.searchParams.set('idempotencyKey', idempotencyKey);
      endpoint.searchParams.set('requestHash', request.requestHash);
      init = { method: 'GET', headers };
    }
    const response = await invokeHttp(endpoint, init, signal);
    if (!response?.ok) {
      throw new Error(
        `external_research_replay_recovery_http_failed:${response?.status || 0}`,
      );
    }
    const document = await response.json();
    if (document?.operationId !== operationId
      || document?.idempotencyKey !== idempotencyKey
      || document?.requestHash !== request.requestHash
      || document?.serviceId !== selected.serviceId
      || document?.serviceIdentityHash !== selected.serviceIdentityHash
      || !['completed', 'in_progress', 'not_found']
        .includes(document?.operationStatus)) {
      throw new Error('external_research_replay_recovery_response_invalid');
    }
    if (document.operationStatus !== 'completed') {
      if ((document.externalResearchReplayReceipt !== null
          && document.externalResearchReplayReceipt !== undefined)
        || (document.authorityEnvelope !== null
          && document.authorityEnvelope !== undefined)) {
        throw new Error('external_research_replay_recovery_response_invalid');
      }
      verifyRecoveryOutcome(document, request, {
        operationId,
        idempotencyKey,
        resultHash: null,
      });
      return Object.freeze({
        status: document.operationStatus,
        receipt: null,
      });
    }
    return Object.freeze({
      status: 'completed',
      receipt: receiptFromDocument(document, request, {
        operationId,
        idempotencyKey,
      }),
    });
  };
  return assertExternalResearchReplayPort(Object.freeze({
    version: 1,
    kind: 'ExternalResearchReplayPort',
    serviceId: selected.serviceId,
    configurationHash: selected.configurationHash,
    crashRecoveryReady: selected.version === 4,
    recoveryConfigurationIdentityHash,
    recoveryOutcomeCryptographicAuthorityReady: selected.version === 4,
    recoveryOutcomeVerificationPolicyHash,
    cryptographicAuthorityReady: selected.version >= 2,
    identityIndependenceReady: selected.version >= 3,
    evidenceProfile: selected.version >= 3
      ? 'pinned-signed-offhost-replay-v3' : 'bounded-external-replay-v1',
    trustSetHash: receiptVerifier?.trustSetHash
      || (selected.version === 2 ? selected.receiptTrustStoreHash : null),
    signatureVerificationPolicyHash: receiptVerifier?.signatureVerificationPolicyHash
      || (selected.version === 2
        ? hashRecord('ExternalResearchReplayV2SignatureVerificationPolicy', {
          configurationHash: selected.configurationHash,
          policy: 'pinned-canonical-json-ed25519-v1',
        }) : null),
    identitySeparationInspection:
      receiptVerifier?.identitySeparationInspection || null,
    receiptVerifier,
    verifyReceipt({ request, receipt } = {}) {
      return receiptVerifier
        ? receiptVerifier.verify({ request, receipt })
        : verifyExternalResearchReplayReceipt(receipt, { request });
    },
    async lookup(input) {
      return recoveryResolution('lookup', input);
    },
    async resume(input) {
      return recoveryResolution('resume', input);
    },
    async replay({
      operationId = null,
      request,
      idempotencyKey = null,
      signal = null,
    } = {}) {
      if (!verifyExternalResearchReplayRequest(request)
        || (selected.version === 4
          && (!SHA256.test(String(operationId || ''))
            || !SHA256.test(String(idempotencyKey || ''))))) {
        throw new Error('external_research_replay_request_invalid');
      }
      const headers = {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
        ...(selected.version === 4 ? {
          'idempotency-key': idempotencyKey,
          'operation-id': operationId,
        } : {}),
      };
      const response = await invokeHttp(selected.endpoint, {
        method: 'POST',
        headers,
        body: JSON.stringify(selected.version === 4 ? {
          version: 1,
          kind: 'ExternalResearchReplayOperationRequest',
          operationId,
          idempotencyKey,
          request,
        } : request),
      }, signal);
      if (!response?.ok) {
        throw new Error(`external_research_replay_http_failed:${response?.status || 0}`);
      }
      const document = await response.json();
      return receiptFromDocument(document, request, {
        operationId,
        idempotencyKey,
      });
    },
  }));
}
