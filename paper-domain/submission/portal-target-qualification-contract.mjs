import { hasExactObjectKeys } from '../../workflow-kernel/exact-object-keys.mjs';
import { hashRecord } from '../../workflow-kernel/record-hash.mjs';
import {
  getJournalSubmissionTargetProfile,
} from './journal-submission-target-registry.mjs';
import {
  getSubmissionConnectorFamily,
} from './submission-connector-family-registry.mjs';

const SHA256 = /^sha256:[0-9a-f]{64}$/;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9_.:@/-]{0,255}$/;
const MAXIMUM_REGISTRY_LIFETIME_MS = 7 * 24 * 60 * 60 * 1000;

export const PORTAL_TARGET_QUALIFICATION_LEVELS = Object.freeze([
  'sandbox',
  'production',
]);

export const PORTAL_TARGET_QUALIFICATION_EVIDENCE_TYPES = Object.freeze([
  'discovery',
  'sandboxCanary',
  'portalIdentity',
  'dispatcherChallenge',
  'cycleRecovery',
  'productionAuthorization',
]);

export const PORTAL_TARGET_QUALIFICATION_AUTHORITY_ROLES = Object.freeze({
  owner: 'portal_target_owner',
  observer: 'portal_target_independent_observer',
  productionAuthorizer: 'portal_production_authorizer',
});

export const PORTAL_TARGET_QUALIFICATION_EVIDENCE_POLICIES = Object.freeze({
  discovery: Object.freeze({
    artifactKind: 'SubmissionPortalBinding',
    verificationReceiptKind: 'PortalTargetDiscoveryVerificationReceipt',
    authorityRole: PORTAL_TARGET_QUALIFICATION_AUTHORITY_ROLES.owner,
    evidenceEnvironment: 'production',
    authorizationScope: null,
    externalActionPerformed: true,
    maximumAgeMs: 24 * 60 * 60 * 1000,
    maximumLifetimeMs: 48 * 60 * 60 * 1000,
  }),
  sandboxCanary: Object.freeze({
    artifactKind: 'AutonomousSubmissionPortalReadinessCanaryEvidence',
    verificationReceiptKind:
      'AutonomousSubmissionPortalReadinessCanaryVerificationReceipt',
    authorityRole: PORTAL_TARGET_QUALIFICATION_AUTHORITY_ROLES.observer,
    evidenceEnvironment: 'sandbox',
    authorizationScope: null,
    externalActionPerformed: false,
    maximumAgeMs: 60 * 60 * 1000,
    maximumLifetimeMs: 2 * 60 * 60 * 1000,
  }),
  portalIdentity: Object.freeze({
    artifactKind: 'AutonomousSubmissionPortalIdentitySeparationInspection',
    verificationReceiptKind:
      'AutonomousSubmissionPortalIdentitySeparationInspection',
    authorityRole: PORTAL_TARGET_QUALIFICATION_AUTHORITY_ROLES.observer,
    evidenceEnvironment: 'production',
    authorizationScope: null,
    externalActionPerformed: false,
    maximumAgeMs: 60 * 60 * 1000,
    maximumLifetimeMs: 2 * 60 * 60 * 1000,
  }),
  dispatcherChallenge: Object.freeze({
    artifactKind: 'AutonomousSubmissionDispatcherChallenge',
    verificationReceiptKind:
      'AutonomousSubmissionDispatcherChallengeVerificationReceipt',
    authorityRole: PORTAL_TARGET_QUALIFICATION_AUTHORITY_ROLES.observer,
    evidenceEnvironment: 'production',
    authorizationScope: null,
    externalActionPerformed: false,
    maximumAgeMs: 60 * 60 * 1000,
    maximumLifetimeMs: 2 * 60 * 60 * 1000,
  }),
  cycleRecovery: Object.freeze({
    artifactKind: 'AutonomousSubmissionDispatcherCycleReceipt',
    verificationReceiptKind: 'AutonomousSubmissionDispatcherCycleReceipt',
    authorityRole: PORTAL_TARGET_QUALIFICATION_AUTHORITY_ROLES.observer,
    evidenceEnvironment: 'sandbox',
    authorizationScope: null,
    externalActionPerformed: false,
    maximumAgeMs: 60 * 60 * 1000,
    maximumLifetimeMs: 2 * 60 * 60 * 1000,
  }),
  productionAuthorization: Object.freeze({
    artifactKind: 'ProviderCapabilityVerificationReceipt',
    verificationReceiptKind:
      'PortalTargetProductionQualificationAuthorizationReceipt',
    authorityRole: PORTAL_TARGET_QUALIFICATION_AUTHORITY_ROLES.productionAuthorizer,
    evidenceEnvironment: 'production',
    authorizationScope: 'portal-qualification-only',
    externalActionPerformed: false,
    maximumAgeMs: 30 * 60 * 1000,
    maximumLifetimeMs: 60 * 60 * 1000,
  }),
});

const EVIDENCE_KEYS = Object.freeze([
  'artifactHash',
  'artifactKind',
  'authorizationScope',
  'evidenceEnvironment',
  'evidenceType',
  'expiresAt',
  'externalActionPerformed',
  'fixtureEvidence',
  'issuerPrincipalId',
  'kind',
  'liveCommitPerformed',
  'observedAt',
  'signatures',
  'status',
  'subjectHash',
  'verificationPolicyHash',
  'verificationReceiptHash',
  'verificationReceiptKind',
  'verifierRole',
  'version',
]);

const ENTRY_KEYS = Object.freeze([
  'authenticationProfileHash',
  'automationPolicyEvidenceHash',
  'baseTargetProfileHash',
  'connectorFamily',
  'edition',
  'evidence',
  'expiresAt',
  'humanSingleUseAuthorizationRequired',
  'kind',
  'liveCommitAuthorized',
  'liveCommitPermitHash',
  'portalConfigurationHash',
  'portalDescriptorHash',
  'portalOriginHash',
  'portalTargetSubjectHash',
  'portalTargetQualificationHash',
  'productionQualified',
  'qualificationLevel',
  'qualifiedAt',
  'sandboxQualified',
  'schemaFingerprintHash',
  'status',
  'statusMappingHash',
  'submissionRouteHash',
  'targetInstanceId',
  'track',
  'venueId',
  'venueKind',
  'version',
]);

const REGISTRY_KEYS = Object.freeze([
  'entries',
  'expiresAt',
  'generation',
  'humanSingleUseAuthorizationRequired',
  'issuedAt',
  'kind',
  'liveCommitAuthorizationIncluded',
  'maximumTargetCount',
  'portalTargetQualificationRegistryHash',
  'predecessorRegistryHash',
  'revokedQualificationHashes',
  'signatures',
  'status',
  'version',
]);

function canonicalInstant(value, code) {
  const milliseconds = Date.parse(String(value || ''));
  if (!Number.isFinite(milliseconds)
    || new Date(milliseconds).toISOString() !== value) throw new Error(code);
  return value;
}

function sha(value, code) {
  const selected = String(value || '').toLowerCase();
  if (!SHA256.test(selected)) throw new Error(code);
  return selected;
}

function optionalText(value, code) {
  if (value === null) return null;
  const selected = String(value || '').trim();
  if (!selected || selected.length > 256) throw new Error(code);
  return selected;
}

export function buildPortalTargetQualificationEvidenceAttestation({
  evidenceType,
  issuerPrincipalId,
  subjectHash,
  artifactKind,
  artifactHash,
  verificationReceiptKind,
  verificationReceiptHash,
  verificationPolicyHash,
  verifierRole,
  evidenceEnvironment,
  observedAt,
  expiresAt,
  authorizationScope = null,
  fixtureEvidence = false,
  externalActionPerformed = undefined,
  liveCommitPerformed = false,
  signatures = [],
} = {}) {
  if (!PORTAL_TARGET_QUALIFICATION_EVIDENCE_TYPES.includes(evidenceType)) {
    throw new Error('portal_target_qualification_evidence_type_invalid');
  }
  const policy = PORTAL_TARGET_QUALIFICATION_EVIDENCE_POLICIES[evidenceType];
  const observed = canonicalInstant(
    observedAt,
    'portal_target_qualification_evidence_observed_at_invalid',
  );
  const expiry = canonicalInstant(
    expiresAt,
    'portal_target_qualification_evidence_expires_at_invalid',
  );
  if (!SAFE_ID.test(String(issuerPrincipalId || ''))
    || artifactKind !== policy.artifactKind
    || verificationReceiptKind !== policy.verificationReceiptKind
    || verifierRole !== policy.authorityRole
    || evidenceEnvironment !== policy.evidenceEnvironment
    || authorizationScope !== policy.authorizationScope
    || fixtureEvidence !== false
    || (externalActionPerformed !== undefined
      && externalActionPerformed !== policy.externalActionPerformed)
    || liveCommitPerformed !== false
    || Date.parse(expiry) <= Date.parse(observed)
    || Date.parse(expiry) - Date.parse(observed) > policy.maximumLifetimeMs) {
    throw new Error('portal_target_qualification_evidence_policy_invalid');
  }
  return Object.freeze({
    version: 1,
    kind: 'PortalTargetQualificationEvidenceAttestation',
    status: 'portal_target_evidence_cryptographically_attested',
    evidenceType,
    artifactKind,
    artifactHash: sha(
      artifactHash,
      'portal_target_qualification_evidence_artifact_hash_invalid',
    ),
    verificationReceiptKind,
    verificationReceiptHash: sha(
      verificationReceiptHash,
      'portal_target_qualification_evidence_verification_receipt_hash_invalid',
    ),
    verificationPolicyHash: sha(
      verificationPolicyHash,
      'portal_target_qualification_evidence_verification_policy_hash_invalid',
    ),
    verifierRole,
    issuerPrincipalId: String(issuerPrincipalId),
    subjectHash: sha(subjectHash, 'portal_target_qualification_subject_hash_invalid'),
    evidenceEnvironment,
    observedAt: observed,
    expiresAt: expiry,
    authorizationScope,
    fixtureEvidence: false,
    externalActionPerformed: policy.externalActionPerformed,
    liveCommitPerformed: false,
    signatures: Object.freeze((Array.isArray(signatures) ? signatures : [])
      .map(normalizeSignature)),
  });
}

export function verifyPortalTargetQualificationEvidenceAttestation(value, {
  evidenceType = value?.evidenceType,
} = {}) {
  if (!hasExactObjectKeys(value, EVIDENCE_KEYS)
    || value?.version !== 1
    || value?.kind !== 'PortalTargetQualificationEvidenceAttestation'
    || value?.status !== 'portal_target_evidence_cryptographically_attested'
    || value?.evidenceType !== evidenceType) return false;
  try {
    return JSON.stringify(buildPortalTargetQualificationEvidenceAttestation(value))
      === JSON.stringify(value);
  } catch { return false; }
}

function normalizeEvidence(evidence, level, subjectHash) {
  const source = evidence && typeof evidence === 'object' && !Array.isArray(evidence)
    ? evidence : {};
  if (!hasExactObjectKeys(source, PORTAL_TARGET_QUALIFICATION_EVIDENCE_TYPES)) {
    throw new Error('portal_target_qualification_evidence_set_invalid');
  }
  const required = level === 'production'
    ? PORTAL_TARGET_QUALIFICATION_EVIDENCE_TYPES
    : PORTAL_TARGET_QUALIFICATION_EVIDENCE_TYPES.slice(0, 3);
  return Object.freeze(Object.fromEntries(
    PORTAL_TARGET_QUALIFICATION_EVIDENCE_TYPES.map((type) => {
      const reference = source[type];
      if (required.includes(type)) {
        if (!verifyPortalTargetQualificationEvidenceAttestation(reference, {
          evidenceType: type,
        })) throw new Error(`portal_target_qualification_evidence_required:${type}`);
        if (reference.subjectHash !== subjectHash) {
          throw new Error(`portal_target_qualification_evidence_subject_mismatch:${type}`);
        }
        return [type, buildPortalTargetQualificationEvidenceAttestation(reference)];
      }
      if (reference !== null) {
        throw new Error(`portal_target_qualification_evidence_forbidden:${type}`);
      }
      return [type, null];
    }),
  ));
}

function normalizedTargetSubject(value = {}) {
  const target = getJournalSubmissionTargetProfile(String(value.venueId || ''));
  const family = getSubmissionConnectorFamily(String(value.connectorFamily || ''));
  const edition = optionalText(value.edition ?? null, 'portal_target_edition_invalid');
  const track = optionalText(value.track ?? null, 'portal_target_track_invalid');
  if (!SAFE_ID.test(String(value.targetInstanceId || ''))
    || (family.connectorFamily === 'openreview-api-v2'
      && (!/^[A-Za-z0-9][A-Za-z0-9._/-]{0,255}$/.test(
        String(value.targetInstanceId || ''),
      ) || String(value.targetInstanceId).includes('/-/')))
    || target.venueKind !== value.venueKind
    || target.journalSubmissionTargetProfileHash !== value.baseTargetProfileHash
    || !target.candidateConnectorFamilies.includes(family.connectorFamily)
    || target.adapterImplemented !== true
    || family.capabilities.discoverProfile !== true
    || (target.venueKind === 'conference' && (!edition || !track))) {
    throw new Error('portal_target_qualification_target_binding_invalid');
  }
  const payload = {
    version: 1,
    kind: 'PortalTargetQualificationSubject',
    venueId: target.venueId,
    venueKind: target.venueKind,
    baseTargetProfileHash: target.journalSubmissionTargetProfileHash,
    targetInstanceId: String(value.targetInstanceId),
    edition,
    track,
    connectorFamily: family.connectorFamily,
    portalOriginHash: sha(value.portalOriginHash, 'portal_target_origin_hash_invalid'),
    submissionRouteHash: sha(value.submissionRouteHash, 'portal_target_route_hash_invalid'),
    schemaFingerprintHash: sha(
      value.schemaFingerprintHash,
      'portal_target_schema_hash_invalid',
    ),
    authenticationProfileHash: sha(
      value.authenticationProfileHash,
      'portal_target_authentication_hash_invalid',
    ),
    automationPolicyEvidenceHash: sha(
      value.automationPolicyEvidenceHash,
      'portal_target_automation_policy_hash_invalid',
    ),
    statusMappingHash: sha(
      value.statusMappingHash,
      'portal_target_status_mapping_hash_invalid',
    ),
    portalConfigurationHash: sha(
      value.portalConfigurationHash,
      'portal_target_portal_configuration_hash_invalid',
    ),
    portalDescriptorHash: sha(
      value.portalDescriptorHash,
      'portal_target_portal_descriptor_hash_invalid',
    ),
  };
  return Object.freeze({
    payload: Object.freeze(payload),
    subjectHash: hashRecord('PortalTargetQualificationSubject', payload),
  });
}

export function buildPortalTargetQualificationSubjectHash(value = {}) {
  return normalizedTargetSubject(value).subjectHash;
}

function entryPayload(value = {}) {
  const level = String(value.qualificationLevel || '');
  if (!PORTAL_TARGET_QUALIFICATION_LEVELS.includes(level)) {
    throw new Error('portal_target_qualification_level_invalid');
  }
  const subject = normalizedTargetSubject(value);
  const qualifiedAt = canonicalInstant(
    value.qualifiedAt,
    'portal_target_qualified_at_invalid',
  );
  const expiresAt = canonicalInstant(
    value.expiresAt,
    'portal_target_expires_at_invalid',
  );
  if (Date.parse(expiresAt) <= Date.parse(qualifiedAt)) {
    throw new Error('portal_target_qualification_target_binding_invalid');
  }
  const evidence = normalizeEvidence(value.evidence, level, subject.subjectHash);
  if (Object.values(evidence).filter(Boolean).some((attestation) => (
    Date.parse(attestation.observedAt) > Date.parse(qualifiedAt)
  ))) throw new Error('portal_target_qualification_evidence_after_qualification');
  const sandboxQualified = true;
  const productionQualified = level === 'production';
  const {
    version: _subjectVersion,
    kind: _subjectKind,
    ...targetBinding
  } = subject.payload;
  const payload = {
    version: 1,
    kind: 'PortalTargetQualification',
    status: productionQualified
      ? 'portal_target_production_qualified'
      : 'portal_target_sandbox_qualified',
    ...targetBinding,
    portalTargetSubjectHash: subject.subjectHash,
    qualificationLevel: level,
    qualifiedAt,
    expiresAt,
    evidence,
    sandboxQualified,
    productionQualified,
    liveCommitAuthorized: false,
    humanSingleUseAuthorizationRequired: true,
    liveCommitPermitHash: null,
  };
  return payload;
}

export function buildPortalTargetQualification(value = {}) {
  const payload = entryPayload(value);
  return Object.freeze({
    ...payload,
    portalTargetQualificationHash:
      hashRecord('PortalTargetQualification', payload),
  });
}

export function verifyPortalTargetQualification(value) {
  if (!hasExactObjectKeys(value, ENTRY_KEYS)
    || !SHA256.test(String(value?.portalTargetQualificationHash || ''))
    || value?.liveCommitAuthorized !== false
    || value?.humanSingleUseAuthorizationRequired !== true
    || value?.liveCommitPermitHash !== null) return false;
  try {
    return JSON.stringify(buildPortalTargetQualification(value)) === JSON.stringify(value);
  } catch { return false; }
}

function normalizeSignature(signature) {
  if (!hasExactObjectKeys(signature, ['algorithm', 'keyId', 'role', 'value'])
    || signature.algorithm !== 'ed25519'
    || !SAFE_ID.test(String(signature.keyId || ''))
    || !Object.values(PORTAL_TARGET_QUALIFICATION_AUTHORITY_ROLES)
      .includes(String(signature.role || ''))
    || !String(signature.value || '')) {
    throw new Error('portal_target_qualification_signature_invalid');
  }
  return Object.freeze({
    keyId: String(signature.keyId),
    role: String(signature.role),
    algorithm: 'ed25519',
    value: String(signature.value),
  });
}

function registryPayload(value = {}) {
  const issuedAt = canonicalInstant(
    value.issuedAt,
    'portal_target_qualification_registry_issued_at_invalid',
  );
  const expiresAt = canonicalInstant(
    value.expiresAt,
    'portal_target_qualification_registry_expires_at_invalid',
  );
  const generation = Number(value.generation);
  const predecessorRegistryHash = value.predecessorRegistryHash === null
      || value.predecessorRegistryHash === undefined
    ? null
    : sha(
      value.predecessorRegistryHash,
      'portal_target_qualification_predecessor_hash_invalid',
    );
  const revokedQualificationHashes = Array.isArray(value.revokedQualificationHashes)
    ? value.revokedQualificationHashes.map((entry) => sha(
      entry,
      'portal_target_qualification_revocation_hash_invalid',
    )) : [];
  if (!Number.isSafeInteger(generation) || generation < 1
    || (generation === 1 && predecessorRegistryHash !== null)
    || (generation > 1 && predecessorRegistryHash === null)
    || new Set(revokedQualificationHashes).size !== revokedQualificationHashes.length
    || Date.parse(expiresAt) <= Date.parse(issuedAt)
    || Date.parse(expiresAt) - Date.parse(issuedAt) > MAXIMUM_REGISTRY_LIFETIME_MS
    || !Array.isArray(value.entries)
    || value.entries.length > 2) {
    throw new Error('portal_target_qualification_registry_policy_invalid');
  }
  const entries = value.entries.map((entry) => {
    if (!verifyPortalTargetQualification(entry)) {
      throw new Error('portal_target_qualification_registry_entry_invalid');
    }
    if (Date.parse(entry.qualifiedAt) > Date.parse(issuedAt)
      || Date.parse(entry.expiresAt) < Date.parse(expiresAt)
      || Object.values(entry.evidence).filter(Boolean).some((reference) => (
        Date.parse(reference.observedAt) > Date.parse(issuedAt)
          || Date.parse(reference.expiresAt) < Date.parse(expiresAt)
          || Date.parse(issuedAt) - Date.parse(reference.observedAt)
            > PORTAL_TARGET_QUALIFICATION_EVIDENCE_POLICIES[
              reference.evidenceType
            ].maximumAgeMs
      ))) throw new Error('portal_target_qualification_registry_freshness_invalid');
    return buildPortalTargetQualification(entry);
  }).sort((left, right) => left.venueId.localeCompare(right.venueId));
  if (new Set(entries.map((entry) => entry.venueId)).size !== entries.length
    || new Set(entries.map((entry) => entry.targetInstanceId)).size !== entries.length) {
    throw new Error('portal_target_qualification_registry_duplicate_target');
  }
  return {
    version: 1,
    kind: 'PortalTargetQualificationRegistry',
    status: 'portal_target_qualification_registry_active',
    generation,
    issuedAt,
    expiresAt,
    maximumTargetCount: 2,
    entries: Object.freeze(entries),
    predecessorRegistryHash,
    revokedQualificationHashes: Object.freeze([...revokedQualificationHashes].sort()),
    liveCommitAuthorizationIncluded: false,
    humanSingleUseAuthorizationRequired: true,
  };
}

export function buildPortalTargetQualificationRegistry(value = {}) {
  const payload = registryPayload(value);
  const signatures = Object.freeze((Array.isArray(value.signatures)
    ? value.signatures : []).map(normalizeSignature));
  return Object.freeze({
    ...payload,
    portalTargetQualificationRegistryHash: hashRecord(
      'PortalTargetQualificationRegistry',
      payload,
    ),
    signatures,
  });
}

export function verifyPortalTargetQualificationRegistryStructure(value) {
  if (!hasExactObjectKeys(value, REGISTRY_KEYS)
    || !SHA256.test(String(value?.portalTargetQualificationRegistryHash || ''))
    || value?.liveCommitAuthorizationIncluded !== false
    || value?.humanSingleUseAuthorizationRequired !== true) return false;
  try {
    return JSON.stringify(buildPortalTargetQualificationRegistry(value))
      === JSON.stringify(value);
  } catch { return false; }
}

export function requiredPortalTargetQualificationAuthorityRoles(registry) {
  if (!verifyPortalTargetQualificationRegistryStructure(registry)) return Object.freeze([]);
  return Object.freeze([
    PORTAL_TARGET_QUALIFICATION_AUTHORITY_ROLES.owner,
    PORTAL_TARGET_QUALIFICATION_AUTHORITY_ROLES.observer,
    ...(registry.entries.some((entry) => entry.productionQualified)
      ? [PORTAL_TARGET_QUALIFICATION_AUTHORITY_ROLES.productionAuthorizer] : []),
  ]);
}

export function inspectPortalTargetQualificationRegistryFreshness(registry, {
  now = null,
} = {}) {
  const blockers = [];
  const nowMs = now instanceof Date ? now.getTime() : Date.parse(String(now || ''));
  if (!verifyPortalTargetQualificationRegistryStructure(registry)) {
    blockers.push('portal_target_qualification_registry_structure_invalid');
  }
  if (!Number.isFinite(nowMs)) blockers.push('portal_target_qualification_clock_invalid');
  if (Number.isFinite(nowMs) && registry?.issuedAt
    && nowMs < Date.parse(registry.issuedAt)) {
    blockers.push('portal_target_qualification_registry_not_yet_valid');
  }
  if (Number.isFinite(nowMs) && registry?.expiresAt
    && nowMs >= Date.parse(registry.expiresAt)) {
    blockers.push('portal_target_qualification_registry_expired');
  }
  return Object.freeze({
    ready: blockers.length === 0,
    blockers: Object.freeze(blockers),
  });
}
