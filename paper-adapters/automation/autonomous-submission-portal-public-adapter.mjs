import fs from 'node:fs';
import path from 'node:path';

import {
  inspectPinnedExternalEvidenceTrustStore,
} from '../authority/pinned-external-evidence-verifier.mjs';
import {
  createAutonomousSubmissionCompletedReceiptVerifier,
} from './autonomous-submission-completed-receipt-verifier.mjs';
import {
  buildAutonomousSubmissionPortalIdentityAttestationBundle,
  inspectAutonomousSubmissionPortalIdentitySeparation,
} from './autonomous-submission-portal-identity-attestation.mjs';
import { hasExactObjectKeys } from '../../workflow-kernel/exact-object-keys.mjs';
import { hashRecord } from '../../workflow-kernel/record-hash.mjs';

const SHA256 = /^sha256:[0-9a-f]{64}$/;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,191}$/;
const PORTAL_SIGNER_ROLE = 'autonomous_submission_portal';
const CONFIG_KEYS_V1 = Object.freeze([
  'configurationHash', 'endpoint', 'kind', 'portalAccountIdentityHash',
  'portalId', 'portalTrustDomainIdentityHash', 'serviceIdentityHash',
  'timeoutMs', 'tokenEnvironmentVariable', 'version',
]);
const CONFIG_KEYS_V2 = Object.freeze([
  ...CONFIG_KEYS_V1,
  'receiptMaximumLifetimeMs', 'receiptSignerKeyIds', 'receiptSignerRole',
  'receiptTrustStore', 'receiptTrustStoreHash',
]);
const CONFIG_KEYS_V3 = Object.freeze([
  ...CONFIG_KEYS_V2,
  'localOriginIdentityAttestationBundles', 'portalIdentityAttestationBundle',
]);
const PUBLIC_CONFIG_KEYS_V1 = Object.freeze([
  'configurationHash', 'kind', 'portalAccountIdentityHash', 'portalId',
  'portalTrustDomainIdentityHash', 'serviceIdentityHash',
  'tokenEnvironmentVariableNameHash', 'version',
]);
const PUBLIC_CONFIG_KEYS_V2 = Object.freeze([
  ...PUBLIC_CONFIG_KEYS_V1,
  'receiptMaximumLifetimeMs', 'receiptSignerKeyIds', 'receiptSignerRole',
  'receiptTrustStore', 'receiptTrustStoreHash',
]);
const PUBLIC_CONFIG_KEYS_V3 = Object.freeze([
  ...PUBLIC_CONFIG_KEYS_V2,
  'localOriginIdentityAttestationBundles', 'portalIdentityAttestationBundle',
]);

export function buildAutonomousSubmissionPortalConfiguration({
  version = 1,
  portalId,
  endpoint,
  serviceIdentityHash,
  portalAccountIdentityHash,
  portalTrustDomainIdentityHash,
  tokenEnvironmentVariable,
  timeoutMs = 10 * 60 * 1000,
  receiptTrustStore = null,
  receiptSignerKeyIds = [],
  receiptSignerRole = PORTAL_SIGNER_ROLE,
  receiptMaximumLifetimeMs = 5 * 60 * 1000,
  portalIdentityAttestationBundle = null,
  localOriginIdentityAttestationBundles = [],
} = {}) {
  let url;
  try { url = new URL(String(endpoint || '')); }
  catch { throw new Error('autonomous_submission_portal_endpoint_invalid'); }
  if (![1, 2, 3].includes(Number(version))
    || url.protocol !== 'https:' || !SAFE_ID.test(String(portalId || ''))
    || ![serviceIdentityHash, portalAccountIdentityHash, portalTrustDomainIdentityHash]
      .every((value) => SHA256.test(String(value || '').toLowerCase()))
    || !/^[A-Z][A-Z0-9_]{1,127}$/.test(String(tokenEnvironmentVariable || ''))
    || !Number.isSafeInteger(Number(timeoutMs)) || Number(timeoutMs) < 1_000
    || Number(timeoutMs) > 60 * 60 * 1000) {
    throw new Error('autonomous_submission_portal_configuration_invalid');
  }
  const payload = {
    version: Number(version),
    kind: 'AutonomousSubmissionPortalConfiguration',
    portalId: String(portalId),
    endpoint: url.toString(),
    serviceIdentityHash: String(serviceIdentityHash).toLowerCase(),
    portalAccountIdentityHash: String(portalAccountIdentityHash).toLowerCase(),
    portalTrustDomainIdentityHash: String(portalTrustDomainIdentityHash).toLowerCase(),
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
    if (!trust.ready || receiptSignerRole !== PORTAL_SIGNER_ROLE
      || expectedKeyIds.length < 1 || expectedKeyIds.length > 4
      || !Number.isSafeInteger(Number(receiptMaximumLifetimeMs))
      || Number(receiptMaximumLifetimeMs) < 1_000
      || Number(receiptMaximumLifetimeMs) > 24 * 60 * 60 * 1000) {
      throw new Error('autonomous_submission_portal_trust_configuration_invalid');
    }
    Object.assign(payload, {
      receiptTrustStore: trust.canonicalTrustStore,
      receiptTrustStoreHash: trust.trustStoreHash,
      receiptSignerKeyIds: Object.freeze(expectedKeyIds),
      receiptSignerRole: PORTAL_SIGNER_ROLE,
      receiptMaximumLifetimeMs: Number(receiptMaximumLifetimeMs),
    });
    if (Number(version) === 3) {
      const portalIdentity = buildAutonomousSubmissionPortalIdentityAttestationBundle(
        portalIdentityAttestationBundle,
      );
      const originIdentities = (Array.isArray(localOriginIdentityAttestationBundles)
        ? localOriginIdentityAttestationBundles : [])
        .map((bundle) => buildAutonomousSubmissionPortalIdentityAttestationBundle(bundle));
      if (originIdentities.length < 1 || originIdentities.length > 64) {
        throw new Error('autonomous_submission_portal_origin_identity_set_invalid');
      }
      Object.assign(payload, {
        portalIdentityAttestationBundle: portalIdentity,
        localOriginIdentityAttestationBundles: Object.freeze(originIdentities),
      });
    }
  }
  return Object.freeze({
    ...payload,
    configurationHash: hashRecord('AutonomousSubmissionPortalConfiguration', payload),
  });
}

export function readAutonomousSubmissionPortalConfiguration({ configPath } = {}) {
  const candidate = path.resolve(String(configPath || ''));
  let parsed;
  try {
    const stat = fs.lstatSync(candidate);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 1024 * 1024) {
      throw new Error('invalid');
    }
    parsed = JSON.parse(fs.readFileSync(candidate, 'utf8'));
  } catch { throw new Error('autonomous_submission_portal_configuration_file_invalid'); }
  const expectedKeys = parsed?.version === 3
    ? CONFIG_KEYS_V3 : parsed?.version === 2 ? CONFIG_KEYS_V2 : CONFIG_KEYS_V1;
  if (!hasExactObjectKeys(parsed, expectedKeys)
    || JSON.stringify(buildAutonomousSubmissionPortalConfiguration(parsed))
      !== JSON.stringify(parsed)) {
    throw new Error('autonomous_submission_portal_configuration_verification_failed');
  }
  return parsed;
}

export function buildAutonomousSubmissionPortalPublicConfiguration(input = {}) {
  const version = Number(input?.version);
  const expectedKeys = version === 3
    ? PUBLIC_CONFIG_KEYS_V3 : version === 2
      ? PUBLIC_CONFIG_KEYS_V2 : PUBLIC_CONFIG_KEYS_V1;
  if (![1, 2, 3].includes(version)
    || input?.kind !== 'AutonomousSubmissionPortalPublicConfiguration'
    || !hasExactObjectKeys(input, expectedKeys)
    || !SAFE_ID.test(String(input.portalId || ''))
    || !SHA256.test(String(input.configurationHash || '').toLowerCase())
    || !SHA256.test(String(input.tokenEnvironmentVariableNameHash || '').toLowerCase())
    || ![
      input.serviceIdentityHash,
      input.portalAccountIdentityHash,
      input.portalTrustDomainIdentityHash,
    ].every((value) => SHA256.test(String(value || '').toLowerCase()))) {
    throw new Error('autonomous_submission_portal_public_configuration_invalid');
  }
  const selected = {
    version,
    kind: 'AutonomousSubmissionPortalPublicConfiguration',
    portalId: String(input.portalId),
    configurationHash: String(input.configurationHash).toLowerCase(),
    serviceIdentityHash: String(input.serviceIdentityHash).toLowerCase(),
    portalAccountIdentityHash: String(input.portalAccountIdentityHash).toLowerCase(),
    portalTrustDomainIdentityHash:
      String(input.portalTrustDomainIdentityHash).toLowerCase(),
    tokenEnvironmentVariableNameHash:
      String(input.tokenEnvironmentVariableNameHash).toLowerCase(),
  };
  if (version >= 2) {
    const expectedKeyIds = [...new Set((Array.isArray(input.receiptSignerKeyIds)
      ? input.receiptSignerKeyIds : []).map(String))].sort();
    const trust = inspectPinnedExternalEvidenceTrustStore(input.receiptTrustStore, {
      requiredRole: input.receiptSignerRole,
      expectedKeyIds,
    });
    if (!trust.ready || input.receiptSignerRole !== PORTAL_SIGNER_ROLE
      || expectedKeyIds.length < 1 || expectedKeyIds.length > 4
      || input.receiptTrustStoreHash !== trust.trustStoreHash
      || !Number.isSafeInteger(Number(input.receiptMaximumLifetimeMs))
      || Number(input.receiptMaximumLifetimeMs) < 1_000
      || Number(input.receiptMaximumLifetimeMs) > 24 * 60 * 60 * 1000) {
      throw new Error('autonomous_submission_portal_public_trust_invalid');
    }
    Object.assign(selected, {
      receiptTrustStore: trust.canonicalTrustStore,
      receiptTrustStoreHash: trust.trustStoreHash,
      receiptSignerKeyIds: Object.freeze(expectedKeyIds),
      receiptSignerRole: PORTAL_SIGNER_ROLE,
      receiptMaximumLifetimeMs: Number(input.receiptMaximumLifetimeMs),
    });
    if (version === 3) {
      const portalIdentityAttestationBundle =
        buildAutonomousSubmissionPortalIdentityAttestationBundle(
          input.portalIdentityAttestationBundle,
        );
      const localOriginIdentityAttestationBundles = (Array.isArray(
        input.localOriginIdentityAttestationBundles,
      ) ? input.localOriginIdentityAttestationBundles : []).map((bundle) => (
        buildAutonomousSubmissionPortalIdentityAttestationBundle(bundle)
      ));
      if (localOriginIdentityAttestationBundles.length < 1
        || localOriginIdentityAttestationBundles.length > 64) {
        throw new Error('autonomous_submission_portal_public_identity_set_invalid');
      }
      Object.assign(selected, {
        portalIdentityAttestationBundle,
        localOriginIdentityAttestationBundles:
          Object.freeze(localOriginIdentityAttestationBundles),
      });
    }
  }
  return Object.freeze(selected);
}

export function deriveAutonomousSubmissionPortalPublicConfiguration({
  configuration,
} = {}) {
  const selected = buildAutonomousSubmissionPortalConfiguration(configuration);
  const publicConfiguration = {
    version: selected.version,
    kind: 'AutonomousSubmissionPortalPublicConfiguration',
    portalId: selected.portalId,
    configurationHash: selected.configurationHash,
    serviceIdentityHash: selected.serviceIdentityHash,
    portalAccountIdentityHash: selected.portalAccountIdentityHash,
    portalTrustDomainIdentityHash: selected.portalTrustDomainIdentityHash,
    tokenEnvironmentVariableNameHash: hashRecord(
      'AutonomousSubmissionPortalTokenEnvironmentVariableName',
      { name: selected.tokenEnvironmentVariable },
    ),
  };
  for (const field of [
    'receiptTrustStore', 'receiptTrustStoreHash', 'receiptSignerKeyIds',
    'receiptSignerRole', 'receiptMaximumLifetimeMs',
    'portalIdentityAttestationBundle', 'localOriginIdentityAttestationBundles',
  ]) {
    if (Object.hasOwn(selected, field)) publicConfiguration[field] = selected[field];
  }
  return buildAutonomousSubmissionPortalPublicConfiguration(publicConfiguration);
}

export function readAutonomousSubmissionPortalPublicConfiguration({
  configPath,
  expectedConfigurationHash = null,
} = {}) {
  const candidate = path.resolve(String(configPath || ''));
  let parsed;
  try {
    const stat = fs.lstatSync(candidate);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 1024 * 1024) {
      throw new Error('invalid');
    }
    parsed = JSON.parse(fs.readFileSync(candidate, 'utf8'));
  } catch {
    throw new Error('autonomous_submission_portal_public_configuration_file_invalid');
  }
  const selected = buildAutonomousSubmissionPortalPublicConfiguration(parsed);
  if (JSON.stringify(selected) !== JSON.stringify(parsed)
    || (expectedConfigurationHash !== null
      && selected.configurationHash !== expectedConfigurationHash)) {
    throw new Error('autonomous_submission_portal_public_configuration_verification_failed');
  }
  return selected;
}

export function autonomousSubmissionPortalPublicDescriptorHash(configuration) {
  return hashRecord(
    'AutonomousSubmissionPortalPublicDescriptorConfiguration',
    buildAutonomousSubmissionPortalPublicConfiguration(configuration),
  );
}

function inspectPublicTrust({
  configuration,
  requiredLocalOriginIdentitySubjectHashes = [],
  clock = { now: () => new Date() },
} = {}) {
  const cryptographicAuthorityReady = configuration.version >= 2;
  const completedReceiptVerifier = cryptographicAuthorityReady
    ? createAutonomousSubmissionCompletedReceiptVerifier({ configuration }) : null;
  const identityInspection = configuration.version === 3
    ? inspectAutonomousSubmissionPortalIdentitySeparation({
      portalId: configuration.portalId,
      serviceIdentityHash: configuration.serviceIdentityHash,
      portalAccountIdentityHash: configuration.portalAccountIdentityHash,
      portalTrustDomainIdentityHash: configuration.portalTrustDomainIdentityHash,
      receiptTrustStore: configuration.receiptTrustStore,
      receiptSignerRole: configuration.receiptSignerRole,
      receiptSignerKeyIds: configuration.receiptSignerKeyIds,
      portalIdentityAttestationBundle: configuration.portalIdentityAttestationBundle,
      localOriginIdentityAttestationBundles:
        configuration.localOriginIdentityAttestationBundles,
      now: clock.now(),
    }) : null;
  const required = [...new Set((Array.isArray(requiredLocalOriginIdentitySubjectHashes)
    ? requiredLocalOriginIdentitySubjectHashes : []).map((value) => (
    String(value || '').toLowerCase()
  )))].sort();
  const observed = identityInspection?.localOriginIdentitySubjects?.map((subject) => (
    subject?.externalPrincipalIdentityAttestationSubjectHash || null
  )) || [];
  if (required.some((value) => !SHA256.test(value))
    || required.some((value) => !observed.includes(value))) {
    throw new Error('autonomous_submission_portal_required_origin_identity_missing');
  }
  if (configuration.version === 3 && identityInspection?.identityIndependenceReady !== true) {
    throw new Error(`autonomous_submission_portal_identity_separation_invalid:${
      identityInspection?.blockers?.join(',') || 'unknown'}`);
  }
  const identityIndependenceReady = identityInspection?.identityIndependenceReady === true;
  return Object.freeze({
    cryptographicAuthorityReady,
    identityIndependenceReady,
    trustSetHash: identityIndependenceReady
      ? hashRecord('AutonomousSubmissionPortalTrustSet', {
        completedReceiptTrustSetHash: completedReceiptVerifier.trustSetHash,
        identityTrustSetHash: identityInspection.trustSetHash,
      }) : completedReceiptVerifier?.trustSetHash || null,
    signatureVerificationPolicyHash: identityIndependenceReady
      ? hashRecord('AutonomousSubmissionPortalSignatureVerificationPolicy', {
        completedReceiptVerificationPolicyHash:
          completedReceiptVerifier.signatureVerificationPolicyHash,
        identitySeparationPolicyHash: identityInspection.signatureVerificationPolicyHash,
      }) : completedReceiptVerifier?.signatureVerificationPolicyHash || null,
    identityInspection,
    completedReceiptVerifier,
  });
}

export function createAutonomousSubmissionPortalDescriptor({
  configuration,
  requiredLocalOriginIdentitySubjectHashes = [],
  clock = { now: () => new Date() },
} = {}) {
  const selected = configuration?.kind === 'AutonomousSubmissionPortalPublicConfiguration'
    ? buildAutonomousSubmissionPortalPublicConfiguration(configuration)
    : buildAutonomousSubmissionPortalConfiguration(configuration);
  const trust = inspectPublicTrust({
    configuration: selected,
    requiredLocalOriginIdentitySubjectHashes,
    clock,
  });
  return Object.freeze({
    version: 1,
    kind: 'AutonomousSubmissionPortalDescriptor',
    portalId: selected.portalId,
    configurationHash: selected.configurationHash,
    idempotencyLookupSupported: true,
    signedCompletedReceiptSupported: trust.cryptographicAuthorityReady,
    cryptographicAuthorityReady: trust.cryptographicAuthorityReady,
    identityIndependenceReady: trust.identityIndependenceReady,
    evidenceProfile: trust.identityIndependenceReady
      ? 'pinned-signed-independent-submission-portal-v3'
      : 'bounded-submission-portal-v1',
    trustSetHash: trust.trustSetHash,
    signatureVerificationPolicyHash: trust.signatureVerificationPolicyHash,
    identitySeparationInspection: trust.identityInspection,
    completedReceiptVerifier: trust.completedReceiptVerifier,
  });
}
