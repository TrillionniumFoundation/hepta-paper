import {
  evaluateExternalPrincipalIdentitySeparation,
  verifyExternalPrincipalIdentityAttestationSubject,
} from '../evidence/external-principal-identity-attestation-contract.mjs';
import { hasExactObjectKeys as exactKeys } from '../../workflow-kernel/exact-object-keys.mjs';
import { hashRecord } from '../../workflow-kernel/record-hash.mjs';

const SHA256 = /^sha256:[0-9a-f]{64}$/;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{2,191}$/;
const SAFE_ORGANIZATION = /^[A-Za-z0-9][A-Za-z0-9 .,&_:@/'()-]{2,191}$/;
const PLACEHOLDER = /(?:REPLACE_WITH|PLACEHOLDER|CHANGEME|INSERT_|TODO)/i;
const POD_UID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const CONTRACT = 'hepta-nested-container-runtime-v1';
const DISTINCT_IDENTITY_FIELDS = Object.freeze([
  'credentialRoot', 'host', 'process', 'providerAccount', 'signerSpki', 'trustDomain',
]);

export const NESTED_RUNTIME_AUTHORITY_INDEPENDENCE_ATTESTOR_ROLE =
  'nested_runtime_authority_independence_attestor';

function canonicalInstant(value) {
  const parsed = Date.parse(String(value || ''));
  return Number.isFinite(parsed) && new Date(parsed).toISOString() === value ? value : null;
}

function safeId(value) {
  return SAFE_ID.test(String(value || '')) && !PLACEHOLDER.test(String(value));
}

function canonicalOrganization(value) {
  const selected = String(value || '');
  if (!SAFE_ORGANIZATION.test(selected) || selected !== selected.trim()
    || selected.normalize('NFC') !== selected || PLACEHOLDER.test(selected)) return null;
  return selected;
}

function organizationIdentity(value) {
  return String(value || '').normalize('NFKC').trim().replace(/\s+/g, ' ').toLowerCase();
}

function identityLabel(value) {
  return String(value || '').normalize('NFKC').trim().toLowerCase();
}

function canonicalIdentity(value) {
  if (!verifyExternalPrincipalIdentityAttestationSubject(value, {
    requirePlatformAttestation: true,
  })) {
    throw new Error('nested_runtime_authority_principal_identity_invalid');
  }
  return Object.freeze({ ...value });
}

function identitiesAreIndependent(identities) {
  const receipts = [
    evaluateExternalPrincipalIdentitySeparation({
      candidate: identities.qualification,
      references: [identities.conformance, identities.deploymentOperator],
      requiredDistinctFields: DISTINCT_IDENTITY_FIELDS,
      requirePlatformAttestation: true,
    }),
    evaluateExternalPrincipalIdentitySeparation({
      candidate: identities.conformance,
      references: [identities.deploymentOperator],
      requiredDistinctFields: DISTINCT_IDENTITY_FIELDS,
      requirePlatformAttestation: true,
    }),
  ];
  const categoricalFields = ['principalId', 'provider', 'serviceId'];
  return receipts.every((receipt) => receipt.identityIndependenceReady === true)
    && categoricalFields.every((field) => (
      new Set(Object.values(identities).map((identity) => (
        identityLabel(identity[field])
      ))).size === 3
    ));
}

function canonicalControlDomainOrganizations(value) {
  if (!exactKeys(value, ['conformance', 'deploymentOperator', 'qualification'])) {
    throw new Error('nested_runtime_authority_control_domain_organization_invalid');
  }
  const selected = Object.freeze({
    qualification: canonicalOrganization(value.qualification),
    conformance: canonicalOrganization(value.conformance),
    deploymentOperator: canonicalOrganization(value.deploymentOperator),
  });
  if (Object.values(selected).some((organization) => organization === null)
    || new Set(Object.values(selected).map(organizationIdentity)).size !== 3) {
    throw new Error('nested_runtime_authority_control_domain_organization_invalid');
  }
  return selected;
}

function timeWindow({
  issuedAt,
  validFrom,
  expiresAt,
  now,
  maximumLifetimeMs,
}) {
  const issued = canonicalInstant(issuedAt);
  const valid = canonicalInstant(validFrom);
  const expires = canonicalInstant(expiresAt);
  const observed = now instanceof Date ? now : new Date(String(now || ''));
  const blockers = [];
  if (!issued || !valid || !expires || !Number.isFinite(observed.getTime())) {
    blockers.push('nested_runtime_authority_independence_time_window_invalid');
  } else {
    const issuedMs = Date.parse(issued);
    const validMs = Date.parse(valid);
    const expiresMs = Date.parse(expires);
    if (validMs < issuedMs || expiresMs <= validMs) {
      blockers.push('nested_runtime_authority_independence_time_window_invalid');
    }
    if (observed.getTime() < validMs) {
      blockers.push('nested_runtime_authority_independence_not_yet_valid');
    }
    if (observed.getTime() >= expiresMs) {
      blockers.push('nested_runtime_authority_independence_expired');
    }
    if (!Number.isSafeInteger(maximumLifetimeMs) || maximumLifetimeMs < 1
      || expiresMs - issuedMs > maximumLifetimeMs) {
      blockers.push('nested_runtime_authority_independence_lifetime_exceeds_policy');
    }
  }
  return Object.freeze(blockers);
}

export function buildNestedRuntimeAuthorityIndependenceSubject(value) {
  if (!exactKeys(value, [
    'conformancePrincipalIdentity', 'conformanceSubjectHash', 'contractVersion',
    'controlDomainOrganizations', 'deploymentOperatorPrincipalIdentity', 'expiresAt',
    'issuedAt', 'kind', 'planHash', 'podUid', 'profileId',
    'qualificationPrincipalIdentity', 'qualificationSubjectHash', 'validFrom', 'version',
  ]) || value.version !== 1
    || value.kind !== 'NestedRuntimeAuthorityIndependenceAttestation'
    || value.contractVersion !== CONTRACT || !safeId(value.profileId)
    || !POD_UID.test(String(value.podUid || ''))
    || !SHA256.test(String(value.planHash || ''))
    || !SHA256.test(String(value.qualificationSubjectHash || ''))
    || !SHA256.test(String(value.conformanceSubjectHash || ''))
    || !canonicalInstant(value.issuedAt) || !canonicalInstant(value.validFrom)
    || !canonicalInstant(value.expiresAt)) {
    throw new Error('nested_runtime_authority_independence_subject_invalid');
  }
  const identities = Object.freeze({
    qualification: canonicalIdentity(value.qualificationPrincipalIdentity),
    conformance: canonicalIdentity(value.conformancePrincipalIdentity),
    deploymentOperator: canonicalIdentity(value.deploymentOperatorPrincipalIdentity),
  });
  const organizations = canonicalControlDomainOrganizations(
    value.controlDomainOrganizations,
  );
  if (!identitiesAreIndependent(identities)
    || identities.qualification.challengeHash !== value.qualificationSubjectHash
    || identities.conformance.challengeHash !== value.conformanceSubjectHash
    || identities.deploymentOperator.challengeHash !== value.planHash
    || Date.parse(value.validFrom) < Math.max(...Object.values(identities)
      .map((identity) => Date.parse(identity.attestedAt)))
    || Date.parse(value.expiresAt) > Math.min(...Object.values(identities)
      .map((identity) => Date.parse(identity.expiresAt)))) {
    throw new Error('nested_runtime_authority_control_domain_independence_invalid');
  }
  return Object.freeze({
    version: 1,
    kind: 'NestedRuntimeAuthorityIndependenceAttestation',
    contractVersion: CONTRACT,
    profileId: String(value.profileId),
    qualificationSubjectHash: String(value.qualificationSubjectHash),
    conformanceSubjectHash: String(value.conformanceSubjectHash),
    podUid: String(value.podUid),
    planHash: String(value.planHash),
    qualificationPrincipalIdentity: identities.qualification,
    conformancePrincipalIdentity: identities.conformance,
    deploymentOperatorPrincipalIdentity: identities.deploymentOperator,
    controlDomainOrganizations: organizations,
    issuedAt: value.issuedAt,
    validFrom: value.validFrom,
    expiresAt: value.expiresAt,
  });
}

export function inspectNestedRuntimeAuthorityIndependenceSubject(subject, {
  expectedProfileId,
  expectedQualificationSubjectHash,
  expectedConformanceSubjectHash,
  expectedPodUid,
  expectedPlanHash,
  expectedQualificationPrincipalId,
  expectedQualificationSignerSpkiHash,
  expectedQualificationOrganization,
  expectedConformancePrincipalId,
  expectedConformanceSignerSpkiHash,
  expectedConformanceOrganization,
  expectedDeploymentOperator,
  now = null,
  maximumLifetimeMs = 15 * 60 * 1000,
} = {}) {
  const blockers = [];
  let canonical = null;
  try { canonical = buildNestedRuntimeAuthorityIndependenceSubject(subject); }
  catch (error) {
    blockers.push(error?.message || 'nested_runtime_authority_independence_subject_invalid');
  }
  if (canonical) {
    blockers.push(...timeWindow({ ...canonical, now, maximumLifetimeMs }));
    const identityOptions = {
      now,
      maximumLifetimeMs,
      requirePlatformAttestation: true,
    };
    if (!verifyExternalPrincipalIdentityAttestationSubject(
      canonical.qualificationPrincipalIdentity,
      identityOptions,
    ) || !verifyExternalPrincipalIdentityAttestationSubject(
      canonical.conformancePrincipalIdentity,
      identityOptions,
    ) || !verifyExternalPrincipalIdentityAttestationSubject(
      canonical.deploymentOperatorPrincipalIdentity,
      identityOptions,
    )) {
      blockers.push('nested_runtime_authority_principal_identity_invalid');
    }
    const qualification = canonical.qualificationPrincipalIdentity;
    const conformance = canonical.conformancePrincipalIdentity;
    const deployment = canonical.deploymentOperatorPrincipalIdentity;
    if (canonical.profileId !== expectedProfileId
      || canonical.qualificationSubjectHash !== expectedQualificationSubjectHash
      || canonical.conformanceSubjectHash !== expectedConformanceSubjectHash
      || canonical.podUid !== expectedPodUid || canonical.planHash !== expectedPlanHash) {
      blockers.push('nested_runtime_authority_independence_runtime_binding_mismatch');
    }
    if (qualification.principalId !== expectedQualificationPrincipalId
      || qualification.signerPublicKeySpkiHash !== expectedQualificationSignerSpkiHash
      || organizationIdentity(canonical.controlDomainOrganizations.qualification)
        !== organizationIdentity(expectedQualificationOrganization)
      || conformance.principalId !== expectedConformancePrincipalId
      || conformance.signerPublicKeySpkiHash !== expectedConformanceSignerSpkiHash
      || organizationIdentity(canonical.controlDomainOrganizations.conformance)
        !== organizationIdentity(expectedConformanceOrganization)) {
      blockers.push('nested_runtime_authority_independence_signer_binding_mismatch');
    }
    if (!expectedDeploymentOperator
      || deployment.principalId !== expectedDeploymentOperator.principalId
      || deployment.provider !== expectedDeploymentOperator.provider
      || deployment.trustDomainIdentityHash
        !== expectedDeploymentOperator.trustDomainIdentityHash
      || deployment.externalPrincipalIdentityAttestationSubjectHash
        !== expectedDeploymentOperator.identitySubjectHash
      || organizationIdentity(canonical.controlDomainOrganizations.deploymentOperator)
        !== organizationIdentity(expectedDeploymentOperator.organization)) {
      blockers.push('nested_runtime_deployment_operator_identity_binding_mismatch');
    }
  }
  return Object.freeze({
    ready: blockers.length === 0,
    canonical,
    subjectHash: canonical
      ? hashRecord('NestedRuntimeAuthorityIndependenceAttestation', canonical) : null,
    blockers: Object.freeze([...new Set(blockers)]),
  });
}
