import { hashRecord } from '../../workflow-kernel/record-hash.mjs';
import { CAPABILITY_CATALOG } from '../../paper-domain/governance/capability-catalog.mjs';

const SHA256 = /^sha256:[a-f0-9]{64}$/;
const GIT_OBJECT_ID = /^[a-f0-9]{40,64}$/;
const MAXIMUM_PACKAGE_AUTHORITY_VALIDITY_MS = 5 * 60 * 1000;
const MAXIMUM_PACKAGE_AUTHORITY_RESPONSE_DELAY_MS = 30 * 1000;
export const FULL_PRODUCTION_OWNER_ACCEPTANCE_REQUIRED = 249;
export const FULL_PRODUCTION_OWNER_FAMILY_MANIFEST_HASH =
  'sha256:5937b03f562e7c2c26abd461bae87ffe25845e8511eee039f134f0db18c09b94';
export const FULL_PRODUCTION_OPERATIONAL_CAPABILITY_IDS = Object.freeze(
  Object.keys(CAPABILITY_CATALOG).sort(),
);
const PACKAGE_READINESS_KEYS = Object.freeze([
  'blockers',
  'deletionFailClosedWhenUnavailable',
  'deletionLeasePortConfigured',
  'deletionLeasePortOperational',
  'finalizedAt',
  'inspectedAt',
  'kind',
  'lifecycleLockConfigured',
  'lifecycleLockOperational',
  'packageRetentionRecoveryReadinessHash',
  'recoveryAuthorityAuthenticated',
  'recoveryAuthorityConfigured',
  'recoveryAuthorityInspectionHash',
  'recoveryAuthorityReadinessVerifierConfigured',
  'recoveryAuthorityReadinessVerifierOperational',
  'recoveryAuthoritySnapshotHash',
  'recoveryAuthorityValidUntil',
  'status',
  'version',
]);
const PACKAGE_BOOLEAN_KEYS = Object.freeze([
  'recoveryAuthorityConfigured',
  'recoveryAuthorityReadinessVerifierConfigured',
  'recoveryAuthorityReadinessVerifierOperational',
  'recoveryAuthorityAuthenticated',
  'deletionLeasePortConfigured',
  'deletionLeasePortOperational',
  'lifecycleLockConfigured',
  'lifecycleLockOperational',
  'deletionFailClosedWhenUnavailable',
]);

function exactKeys(value, expected) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
    && JSON.stringify(Object.keys(value).sort())
      === JSON.stringify([...expected].sort());
}

function canonicalInstant(value) {
  const milliseconds = Date.parse(String(value || ''));
  return Number.isFinite(milliseconds) && new Date(milliseconds).toISOString() === value
    ? value : null;
}

function packageReadinessProtocolError() {
  throw new Error('full_production_package_readiness_protocol_invalid');
}

export function inspectPackageRetentionRecoveryReadinessResponse({
  response,
  observedAt,
} = {}) {
  const observation = canonicalInstant(observedAt);
  if (!observation || !exactKeys(response, ['result', 'status'])
    || response.status !== 'paper_campaign_retention-recovery-readiness') {
    return packageReadinessProtocolError();
  }
  const readiness = response.result;
  if (!exactKeys(readiness, PACKAGE_READINESS_KEYS)
    || readiness.version !== 2
    || readiness.kind !== 'PackageRetentionRecoveryReadiness'
    || ![
      'package_retention_recovery_authority_ready',
      'package_retention_recovery_authority_unavailable',
    ].includes(readiness.status)
    || PACKAGE_BOOLEAN_KEYS.some((key) => typeof readiness[key] !== 'boolean')
    || readiness.deletionFailClosedWhenUnavailable !== true
    || !Array.isArray(readiness.blockers)
    || readiness.blockers.some((blocker) => typeof blocker !== 'string' || !blocker)
    || new Set(readiness.blockers).size !== readiness.blockers.length
    || !canonicalInstant(readiness.inspectedAt)
    || !canonicalInstant(readiness.finalizedAt)
    || Date.parse(readiness.inspectedAt) > Date.parse(readiness.finalizedAt)
    || Date.parse(readiness.finalizedAt) - Date.parse(readiness.inspectedAt)
      > MAXIMUM_PACKAGE_AUTHORITY_RESPONSE_DELAY_MS
    || ![readiness.recoveryAuthoritySnapshotHash, readiness.recoveryAuthorityInspectionHash]
      .every((value) => value === null || SHA256.test(String(value)))
    || (readiness.recoveryAuthorityValidUntil !== null
      && !canonicalInstant(readiness.recoveryAuthorityValidUntil))
    || !SHA256.test(String(readiness.packageRetentionRecoveryReadinessHash || ''))) {
    return packageReadinessProtocolError();
  }
  const {
    packageRetentionRecoveryReadinessHash,
    ...payload
  } = readiness;
  if (hashRecord('PackageRetentionRecoveryReadiness', payload)
      !== packageRetentionRecoveryReadinessHash) {
    return packageReadinessProtocolError();
  }
  const declaredReady = readiness.status
    === 'package_retention_recovery_authority_ready';
  const declaredReadyFieldsValid = PACKAGE_BOOLEAN_KEYS.every((key) => readiness[key] === true)
    && readiness.blockers.length === 0
    && SHA256.test(String(readiness.recoveryAuthoritySnapshotHash || ''))
    && SHA256.test(String(readiness.recoveryAuthorityInspectionHash || ''))
    && canonicalInstant(readiness.recoveryAuthorityValidUntil)
    && Date.parse(readiness.finalizedAt) < Date.parse(readiness.recoveryAuthorityValidUntil)
    && Date.parse(readiness.recoveryAuthorityValidUntil) - Date.parse(readiness.inspectedAt)
      <= MAXIMUM_PACKAGE_AUTHORITY_VALIDITY_MS;
  if (declaredReady && !declaredReadyFieldsValid) return packageReadinessProtocolError();
  const ready = declaredReady
    && Date.parse(readiness.finalizedAt) <= Date.parse(observation)
    && Date.parse(observation) < Date.parse(readiness.recoveryAuthorityValidUntil);
  return Object.freeze({
    version: 1,
    kind: 'PackageRetentionRecoveryReadinessInspection',
    status: ready
      ? 'package_retention_recovery_readiness_verified'
      : 'package_retention_recovery_readiness_blocked',
    ready,
    observedAt: observation,
    readiness,
  });
}

function boundedCount(value, required, code) {
  if (!Number.isSafeInteger(value) || !Number.isSafeInteger(required)
    || required < 1 || value < 0 || value > required) {
    throw new Error(`full_production_${code}_count_invalid`);
  }
}

function validateOwnerAcceptanceInspection(inspection) {
  if (inspection?.version !== 1
    || inspection.kind !== 'IndependentExternalOwnerAcceptanceInspection'
    || ![
      'independent_external_owner_acceptance_ready',
      'independent_external_owner_acceptance_blocked',
    ].includes(inspection.status)
    || inspection.required !== FULL_PRODUCTION_OWNER_ACCEPTANCE_REQUIRED
    || !Number.isSafeInteger(inspection.localAdminAccepted)
    || inspection.localAdminAccepted < 0
    || inspection.localAdminAccepted > FULL_PRODUCTION_OWNER_ACCEPTANCE_REQUIRED
    || typeof inspection.familyManifestBound !== 'boolean'
    || typeof inspection.automaticAcceptanceForbidden !== 'boolean') {
    throw new Error('full_production_owner_acceptance_inspection_invalid');
  }
  boundedCount(
    inspection.externallyAccepted,
    inspection.required,
    'external_owner_acceptance',
  );
}

function validateOperationalProofInspection(inspection) {
  const capabilities = inspection?.capabilities;
  if (inspection?.version !== 1
    || inspection.kind !== 'IndependentProductionOperationalProofInspection'
    || ![
      'independent_production_operational_proof_ready',
      'independent_production_operational_proof_blocked',
    ].includes(inspection.status)
    || !GIT_OBJECT_ID.test(String(inspection.releaseCommit || ''))
    || inspection.required !== FULL_PRODUCTION_OPERATIONAL_CAPABILITY_IDS.length
    || !Array.isArray(capabilities)
    || capabilities.length !== FULL_PRODUCTION_OPERATIONAL_CAPABILITY_IDS.length
    || typeof inspection.externalIndependentRequired !== 'boolean'
    || typeof inspection.conformanceCannotQualify !== 'boolean') {
    throw new Error('full_production_operational_proof_inspection_invalid');
  }
  const capabilityIds = capabilities.map((item) => item?.capabilityId).sort();
  if (new Set(capabilityIds).size !== capabilityIds.length
    || JSON.stringify(capabilityIds)
      !== JSON.stringify(FULL_PRODUCTION_OPERATIONAL_CAPABILITY_IDS)
    || capabilities.some((item) => !exactKeys(item, [
      'capabilityId', 'verified', 'operationalReceiptHashes', 'issuerAssurances',
    ])
      || typeof item.verified !== 'boolean'
      || !Array.isArray(item.operationalReceiptHashes)
      || item.operationalReceiptHashes.some((value) => !SHA256.test(String(value || '')))
      || new Set(item.operationalReceiptHashes).size !== item.operationalReceiptHashes.length
      || !Array.isArray(item.issuerAssurances)
      || item.issuerAssurances.some((value) => typeof value !== 'string' || !value)
      || new Set(item.issuerAssurances).size !== item.issuerAssurances.length)
    || inspection.verified !== capabilities.filter((item) => item.verified).length) {
    throw new Error('full_production_operational_proof_inspection_invalid');
  }
  boundedCount(inspection.verified, inspection.required, 'operational_proof');
}

export function evaluateFullProductionReadiness({
  automationReport,
  packageRetentionRecoveryInspection,
  offhostWormCustodyInspection,
  independentExternalOwnerAcceptanceInspection,
  independentProductionOperationalProofInspection,
  offhostWormContractId,
  observedAt,
} = {}) {
  const observation = canonicalInstant(observedAt);
  if (!observation
    || !automationReport || typeof automationReport !== 'object' || Array.isArray(automationReport)
    || packageRetentionRecoveryInspection?.kind
      !== 'PackageRetentionRecoveryReadinessInspection'
    || offhostWormCustodyInspection?.kind !== 'OffhostWormTargetStatus'
    || independentExternalOwnerAcceptanceInspection?.kind
      !== 'IndependentExternalOwnerAcceptanceInspection'
    || independentProductionOperationalProofInspection?.kind
      !== 'IndependentProductionOperationalProofInspection'
    || typeof offhostWormContractId !== 'string' || !offhostWormContractId) {
    throw new Error('full_production_readiness_inputs_invalid');
  }
  validateOwnerAcceptanceInspection(independentExternalOwnerAcceptanceInspection);
  validateOperationalProofInspection(independentProductionOperationalProofInspection);
  const automationPlaneReady = automationReport.version === 2
    && automationReport.kind === 'AutomationPlaneStatus'
    && automationReport.status === 'automation_plane_production_ready'
    && automationReport.productionReady === true
    && automationReport.fullyAutonomousResearchSystemReady === true
    && automationReport.fullyAutonomousResearchSystemStatus
      === 'generic_domain_autonomous_research_system_ready'
    && automationReport.liveProviderCanaryRequested === true
    && automationReport.liveProviderCanaryReady === true
    && automationReport.liveReleaseAttestorVerificationRequested === true
    && automationReport.researchExecutionReleaseAttestorProductionReady === true;
  const packageInspectionObservedAt = canonicalInstant(
    packageRetentionRecoveryInspection.observedAt,
  );
  let finalPackageInspection = null;
  try {
    finalPackageInspection = inspectPackageRetentionRecoveryReadinessResponse({
      response: {
        status: 'paper_campaign_retention-recovery-readiness',
        result: packageRetentionRecoveryInspection.readiness,
      },
      observedAt: observation,
    });
  } catch { /* A malformed nested protocol is not production ready. */ }
  const packageRetentionRecoveryReady = Boolean(
    packageRetentionRecoveryInspection.version === 1
    && packageRetentionRecoveryInspection.status
      === 'package_retention_recovery_readiness_verified'
    && packageRetentionRecoveryInspection.ready === true
    && packageInspectionObservedAt
    && Date.parse(packageInspectionObservedAt) <= Date.parse(observation)
    && finalPackageInspection?.ready === true,
  );
  const offhostWormCustodyReady = offhostWormCustodyInspection.version === 1
    && offhostWormCustodyInspection.status === 'offhost_worm_target_ready'
    && offhostWormCustodyInspection.contractId === offhostWormContractId
    && offhostWormCustodyInspection.custodyRequired === true
    && offhostWormCustodyInspection.custodyDeclaredQualified === true
    && offhostWormCustodyInspection.offHostOrOffsiteCustodyQualified === true
    && offhostWormCustodyInspection.custodyStatus
      === 'offhost_or_offsite_custody_qualified'
    && offhostWormCustodyInspection.custodyEvidenceStatus
      === 'offhost_worm_custody_evidence_verified'
    && [
      offhostWormCustodyInspection.custodyEvidenceBundleHash,
      offhostWormCustodyInspection.custodyTrustStoreHash,
      offhostWormCustodyInspection.storageIdentityHash,
    ].every((value) => SHA256.test(String(value || '')))
    && canonicalInstant(offhostWormCustodyInspection.custodyEvidenceExpiresAt)
    && Date.parse(observation) < Date.parse(offhostWormCustodyInspection.custodyEvidenceExpiresAt)
    && Array.isArray(offhostWormCustodyInspection.blockers)
    && offhostWormCustodyInspection.blockers.length === 0;
  const independentExternalOwnerAcceptanceReady =
    independentExternalOwnerAcceptanceInspection.status
      === 'independent_external_owner_acceptance_ready'
    && independentExternalOwnerAcceptanceInspection.externallyAccepted
      === FULL_PRODUCTION_OWNER_ACCEPTANCE_REQUIRED
    && independentExternalOwnerAcceptanceInspection.familyManifestBound === true
    && independentExternalOwnerAcceptanceInspection.familyManifestHash
      === FULL_PRODUCTION_OWNER_FAMILY_MANIFEST_HASH
    && independentExternalOwnerAcceptanceInspection.automaticAcceptanceForbidden === true;
  const independentProductionOperationalProofReady =
    independentProductionOperationalProofInspection.status
      === 'independent_production_operational_proof_ready'
    && independentProductionOperationalProofInspection.verified
      === FULL_PRODUCTION_OPERATIONAL_CAPABILITY_IDS.length
    && independentProductionOperationalProofInspection.capabilities.every((item) => (
      item.verified === true
      && item.operationalReceiptHashes.length > 0
      && item.issuerAssurances.length === 1
      && item.issuerAssurances[0] === 'external_independent'
    ))
    && independentProductionOperationalProofInspection.externalIndependentRequired === true
    && independentProductionOperationalProofInspection.conformanceCannotQualify === true;
  const blockers = Object.freeze([
    ...(automationPlaneReady ? [] : ['automation_plane_not_full_production_ready']),
    ...(packageRetentionRecoveryReady
      ? [] : ['package_retention_recovery_not_ready']),
    ...(offhostWormCustodyReady ? [] : ['offhost_worm_custody_not_ready']),
    ...(independentExternalOwnerAcceptanceReady
      ? [] : ['independent_external_owner_acceptance_not_ready']),
    ...(independentProductionOperationalProofReady
      ? [] : ['independent_production_operational_proof_not_ready']),
  ]);
  const fullProductionReady = blockers.length === 0;
  const payload = Object.freeze({
    ...automationReport,
    version: 1,
    kind: 'FullProductionReadinessStatus',
    status: fullProductionReady
      ? 'full_production_ready' : 'full_production_blocked',
    fullProductionStatus: fullProductionReady
      ? 'full_production_ready' : 'full_production_blocked',
    fullProductionReady,
    observedAt: observation,
    automationPlaneStatus: automationReport.status || null,
    automationPlaneReady,
    packageRetentionRecoveryReady,
    packageRetentionRecoveryInspection,
    offhostWormCustodyReady,
    offhostWormCustodyInspection,
    independentExternalOwnerAcceptanceReady,
    independentExternalOwnerAcceptanceInspection,
    independentProductionOperationalProofReady,
    independentProductionOperationalProofInspection,
    blockers,
  });
  return Object.freeze({
    ...payload,
    fullProductionReadinessStatusHash:
      hashRecord('FullProductionReadinessStatus', payload),
  });
}
