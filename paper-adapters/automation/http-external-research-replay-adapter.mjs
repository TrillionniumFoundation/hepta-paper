import fs from 'node:fs';
import path from 'node:path';
import { assertExternalResearchReplayPort } from '../../paper-ports/external-research-replay-port.mjs';
import {
  buildCryptographicExternalResearchReplayReceipt,
  verifyExternalResearchReplayRequest,
  verifyExternalResearchReplayReceipt,
} from '../../paper-domain/research/external-research-replay-contract.mjs';
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
const REPLAY_SIGNER_ROLE = 'external_research_replay_attestor';

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
} = {}) {
  let url;
  try { url = new URL(String(endpoint || '')); }
  catch { throw new Error('external_research_replay_endpoint_invalid'); }
  if (![1, 2, 3].includes(Number(version))
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
    if (Number(version) === 3) {
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
  const expectedKeys = parsed?.version === 3
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
  const receiptVerifier = selected.version === 3
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
  return assertExternalResearchReplayPort(Object.freeze({
    version: 1,
    kind: 'ExternalResearchReplayPort',
    serviceId: selected.serviceId,
    configurationHash: selected.configurationHash,
    cryptographicAuthorityReady: selected.version >= 2,
    identityIndependenceReady: selected.version === 3,
    evidenceProfile: selected.version === 3
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
    async replay({ request, signal = null } = {}) {
      if (!verifyExternalResearchReplayRequest(request)) {
        throw new Error('external_research_replay_request_invalid');
      }
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), selected.timeoutMs);
      const abort = () => controller.abort();
      signal?.addEventListener?.('abort', abort, { once: true });
      let response;
      try {
        response = await fetchImpl(selected.endpoint, {
          method: 'POST',
          headers: {
            authorization: `Bearer ${token}`,
            'content-type': 'application/json',
          },
          body: JSON.stringify(request),
          signal: controller.signal,
        });
      } finally {
        clearTimeout(timer);
        signal?.removeEventListener?.('abort', abort);
      }
      if (!response?.ok) {
        throw new Error(`external_research_replay_http_failed:${response?.status || 0}`);
      }
      const document = await response.json();
      const legacyReceipt = document?.externalResearchReplayReceipt;
      if (document?.requestHash !== request.requestHash
        || document?.serviceId !== selected.serviceId
        || document?.serviceIdentityHash !== selected.serviceIdentityHash
        || document?.externalActionPerformed !== true
        || !verifyExternalResearchReplayReceipt(legacyReceipt, { request })) {
        throw new Error('external_research_replay_response_invalid');
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
      if (selected.version === 3) {
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
    },
  }));
}
