import { hasExactObjectKeys } from '../../workflow-kernel/exact-object-keys.mjs';
import { hashRecord } from '../../workflow-kernel/record-hash.mjs';

// This contract describes *references* to external authorities.  It never
// creates a key, signs an envelope, invokes a provider, or grants a live
// action.  A structurally valid record is therefore only an input to the
// existing cryptographic/operational verifiers; it is not production proof.

const SHA256 = /^sha256:[0-9a-f]{64}$/i;
const SAFE_ID = /^[a-z][a-z0-9][a-z0-9._:@/-]{1,191}$/;
const ABSOLUTE_PATH = /^\//;
const ISO_INSTANT = (value) => {
  const text = String(value || '');
  const milliseconds = Date.parse(text);
  return Number.isFinite(milliseconds)
    && new Date(milliseconds).toISOString() === text;
};

export const EXTERNAL_AUTHORITY_CONFIGURATION_ROLES = Object.freeze([
  'research-author',
  'independent-reviewer',
  'external-qualifier',
  'release-attestor',
  'kms-hardware-attestor',
  'offhost-worm-custodian',
  'restore-authority',
  'anti-rollback-authority',
  'portal-owner',
  'portal-observer',
  'portal-production-authorizer',
]);

export const EXTERNAL_AUTHORITY_CONFIGURATION_KEYS = Object.freeze([
  'attestationEnvelopeHash',
  'attestationSubjectHash',
  'authorityId',
  'backendKind',
  'configurationHash',
  'configurationContentHash',
  'configurationPath',
  'expiresAt',
  'externalActionAllowed',
  'externalActionPerformed',
  'hardwareProtected',
  'humanSingleUseAuthorizationRequired',
  'independentOf',
  'kind',
  'organization',
  'privateKeyExportable',
  'role',
  'status',
  'subjectId',
  'trustDomain',
  'trustStoreHash',
  'trustStorePath',
  'version',
]);

export const EXTERNAL_AUTHORITY_CONFIGURATION_SET_KEYS = Object.freeze([
  'configurationSetHash',
  'entries',
  'expiresAt',
  'kind',
  'requiredRoles',
  'status',
  'version',
]);

const ROLE_POLICY = Object.freeze({
  'research-author': Object.freeze({ independent: false, humanSingleUse: false }),
  'independent-reviewer': Object.freeze({ independent: true, humanSingleUse: false }),
  'external-qualifier': Object.freeze({ independent: true, humanSingleUse: false }),
  'release-attestor': Object.freeze({ hardware: true, nonExportable: true }),
  'kms-hardware-attestor': Object.freeze({ hardware: true, nonExportable: true }),
  'offhost-worm-custodian': Object.freeze({ independent: true, humanSingleUse: false }),
  'restore-authority': Object.freeze({ independent: true, humanSingleUse: false }),
  'anti-rollback-authority': Object.freeze({ independent: true, humanSingleUse: false }),
  'portal-owner': Object.freeze({ independent: true, humanSingleUse: false }),
  'portal-observer': Object.freeze({ independent: true, humanSingleUse: false }),
  'portal-production-authorizer': Object.freeze({
    independent: true,
    humanSingleUse: true,
  }),
});

function identifier(value, code) {
  const selected = String(value || '').trim();
  if (!SAFE_ID.test(selected)) throw new Error(code);
  return selected;
}

function hash(value, code) {
  const selected = String(value || '').toLowerCase();
  if (!SHA256.test(selected)) throw new Error(code);
  return selected;
}

function pathReference(value, code) {
  const selected = String(value || '');
  // References must be absolute and must not contain NULs or template
  // placeholders.  Existence, ownership, and immutability are checked by the
  // adapter that consumes the reference, never inferred here.
  if (!ABSOLUTE_PATH.test(selected) || selected.includes('\0')
    || /(?:REPLACE|PLACEHOLDER|<[^>]+>)/i.test(selected)) {
    throw new Error(code);
  }
  return selected;
}

function organization(value) {
  const selected = String(value || '').normalize('NFKC').trim().replace(/\s+/g, ' ');
  if (!selected || selected.length > 191 || /[\0\r\n]/u.test(selected)) {
    throw new Error('external_authority_configuration_organization_invalid');
  }
  return selected;
}

function normalizeIndependentOf(value, authorityId) {
  if (!Array.isArray(value)) {
    throw new Error('external_authority_configuration_independence_set_invalid');
  }
  const selected = [...new Set(value.map((item) => identifier(
    item,
    'external_authority_configuration_independence_id_invalid',
  )))].sort();
  if (selected.includes(authorityId)) {
    throw new Error('external_authority_configuration_self_independence_invalid');
  }
  return Object.freeze(selected);
}

function normalizeInstant(value) {
  if (!ISO_INSTANT(value)) {
    throw new Error('external_authority_configuration_expiry_invalid');
  }
  return String(value);
}

function payloadFromConfiguration(value = {}) {
  const authorityId = identifier(
    value.authorityId,
    'external_authority_configuration_authority_id_invalid',
  );
  const role = identifier(value.role, 'external_authority_configuration_role_invalid');
  if (!EXTERNAL_AUTHORITY_CONFIGURATION_ROLES.includes(role)) {
    throw new Error('external_authority_configuration_role_unsupported');
  }
  const policy = ROLE_POLICY[role];
  const payload = {
    version: 1,
    kind: 'ExternalAuthorityConfiguration',
    status: value.status === undefined ? 'external_authority_configured' : String(value.status),
    authorityId,
    role,
    subjectId: identifier(
      value.subjectId,
      'external_authority_configuration_subject_id_invalid',
    ),
    organization: organization(value.organization),
    trustDomain: identifier(
      value.trustDomain,
      'external_authority_configuration_trust_domain_invalid',
    ),
    backendKind: identifier(
      value.backendKind,
      'external_authority_configuration_backend_kind_invalid',
    ),
    configurationPath: pathReference(
      value.configurationPath,
      'external_authority_configuration_path_invalid',
    ),
    trustStorePath: pathReference(
      value.trustStorePath,
      'external_authority_configuration_trust_store_path_invalid',
    ),
    configurationContentHash: hash(
      value.configurationContentHash,
      'external_authority_configuration_content_hash_invalid',
    ),
    trustStoreHash: hash(
      value.trustStoreHash,
      'external_authority_configuration_trust_store_hash_invalid',
    ),
    attestationSubjectHash: hash(
      value.attestationSubjectHash,
      'external_authority_configuration_attestation_subject_hash_invalid',
    ),
    attestationEnvelopeHash: hash(
      value.attestationEnvelopeHash,
      'external_authority_configuration_attestation_envelope_hash_invalid',
    ),
    hardwareProtected: value.hardwareProtected === true,
    privateKeyExportable: value.privateKeyExportable === true,
    independentOf: normalizeIndependentOf(value.independentOf, authorityId),
    humanSingleUseAuthorizationRequired:
      value.humanSingleUseAuthorizationRequired === true,
    // Configuration inspection is intentionally read-only.  These two fields
    // can never be true in this contract; live action requires a separate,
    // short-lived, human dual-control permit.
    externalActionAllowed: value.externalActionAllowed === true,
    externalActionPerformed: value.externalActionPerformed === true,
    expiresAt: normalizeInstant(value.expiresAt),
  };
  if (payload.status !== 'external_authority_configured'
    || payload.externalActionAllowed !== false
    || payload.externalActionPerformed !== false
    || (policy.hardware && payload.hardwareProtected !== true)
    || (policy.nonExportable && payload.privateKeyExportable !== false)
    || (policy.independent && payload.independentOf.length < 1)
    || (policy.humanSingleUse && payload.humanSingleUseAuthorizationRequired !== true)
    || (!policy.humanSingleUse && payload.humanSingleUseAuthorizationRequired === true
      && role !== 'portal-production-authorizer')) {
    throw new Error('external_authority_configuration_policy_invalid');
  }
  return Object.freeze(payload);
}

export function buildExternalAuthorityConfiguration(value = {}) {
  const payload = payloadFromConfiguration(value);
  return Object.freeze({
    ...payload,
    configurationHash: hashRecord('ExternalAuthorityConfiguration', payload),
  });
}

export function verifyExternalAuthorityConfiguration(value) {
  if (!hasExactObjectKeys(value, EXTERNAL_AUTHORITY_CONFIGURATION_KEYS)
    || !/^sha256:[0-9a-f]{64}$/i.test(String(value?.configurationHash || ''))) {
    return false;
  }
  try {
    return JSON.stringify(buildExternalAuthorityConfiguration(value))
      === JSON.stringify(value);
  } catch {
    return false;
  }
}

function setPayload(value = {}) {
  if (!Array.isArray(value.entries) || value.entries.length < 1
    || value.entries.length > 32) {
    throw new Error('external_authority_configuration_set_entries_invalid');
  }
  const requiredRoles = [...new Set((Array.isArray(value.requiredRoles)
    ? value.requiredRoles : []).map((role) => identifier(
      role,
      'external_authority_configuration_set_required_role_invalid',
    )))].sort();
  if (requiredRoles.length < 1) {
    throw new Error('external_authority_configuration_set_required_roles_missing');
  }
  const entries = value.entries.map((entry) => buildExternalAuthorityConfiguration(entry))
    .sort((left, right) => left.authorityId.localeCompare(right.authorityId));
  const expiresAt = normalizeInstant(value.expiresAt);
  if (entries.some((entry) => Date.parse(entry.expiresAt) < Date.parse(expiresAt))) {
    throw new Error('external_authority_configuration_set_expiry_exceeds_entry');
  }
  const authorityIds = entries.map((entry) => entry.authorityId);
  const subjectIds = entries.map((entry) => entry.subjectId);
  const organizations = entries.map((entry) => entry.organization.toLowerCase());
  const trustDomains = entries.map((entry) => entry.trustDomain);
  if (new Set(authorityIds).size !== authorityIds.length
    || new Set(subjectIds).size !== subjectIds.length
    || new Set(organizations).size !== organizations.length
    || new Set(trustDomains).size !== trustDomains.length
    || requiredRoles.some((role) => !entries.some((entry) => entry.role === role))) {
    throw new Error('external_authority_configuration_set_independence_or_coverage_invalid');
  }
  return Object.freeze({
    version: 1,
    kind: 'ExternalAuthorityConfigurationSet',
    status: 'external_authority_configuration_set_structurally_valid',
    entries: Object.freeze(entries),
    requiredRoles: Object.freeze(requiredRoles),
    expiresAt,
  });
}

export function buildExternalAuthorityConfigurationSet(value = {}) {
  const payload = setPayload(value);
  return Object.freeze({
    ...payload,
    configurationSetHash: hashRecord('ExternalAuthorityConfigurationSet', payload),
  });
}

export function verifyExternalAuthorityConfigurationSet(value) {
  if (!hasExactObjectKeys(value, EXTERNAL_AUTHORITY_CONFIGURATION_SET_KEYS)
    || !/^sha256:[0-9a-f]{64}$/i.test(String(value?.configurationSetHash || ''))) {
    return false;
  }
  try {
    return JSON.stringify(buildExternalAuthorityConfigurationSet(value))
      === JSON.stringify(value);
  } catch {
    return false;
  }
}

export function inspectExternalAuthorityConfigurationSet(value, {
  // Domain inspection must never read the process wall clock implicitly.
  // Callers that need freshness must supply an injected observation time;
  // omitting it remains a typed, fail-closed blocker.
  now = null,
  requireProductionEvidence = true,
  verifyAuthority = null,
} = {}) {
  const blockers = [];
  if (!verifyExternalAuthorityConfigurationSet(value)) {
    blockers.push('external_authority_configuration_set_invalid');
  }
  const observedMs = now instanceof Date ? now.getTime() : Date.parse(String(now || ''));
  const expiryMs = Date.parse(String(value?.expiresAt || ''));
  if (!Number.isFinite(observedMs) || !Number.isFinite(expiryMs) || observedMs >= expiryMs) {
    blockers.push('external_authority_configuration_set_expired_or_clock_invalid');
  }
  if (requireProductionEvidence) {
    const entries = Array.isArray(value?.entries) ? value.entries : [];
    if (typeof verifyAuthority !== 'function') {
      blockers.push('external_authority_external_verifier_required');
    } else {
      for (const entry of entries) {
        let verified = false;
        try { verified = verifyAuthority(entry) === true; } catch { verified = false; }
        if (!verified) {
          blockers.push(`external_authority_attestation_not_verified:${entry.authorityId}`);
        }
      }
    }
  }
  const uniqueBlockers = Object.freeze([...new Set(blockers)]);
  return Object.freeze({
    version: 1,
    kind: 'ExternalAuthorityConfigurationSetInspection',
    status: uniqueBlockers.length
      ? 'external_authority_configuration_set_blocked'
      : 'external_authority_configuration_set_verified',
    schemaValid: verifyExternalAuthorityConfigurationSet(value),
    productionReady: uniqueBlockers.length === 0,
    cryptographicVerificationDelegated: typeof verifyAuthority === 'function',
    externalActionPerformed: false,
    blockers: uniqueBlockers,
  });
}
