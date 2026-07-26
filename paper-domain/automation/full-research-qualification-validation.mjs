import { hashRecord } from '../../workflow-kernel/record-hash.mjs';
import { verifyPriorArtEvidenceReceipt } from '../research/prior-art-evidence-contract.mjs';
import {
  REQUIRED_RUNTIME_IMAGE_REPRODUCIBILITY_PROFILES,
  RUNTIME_IMAGE_REPRODUCIBILITY_ACTIVE_PLUGIN_SCOPE,
} from './runtime-image-reproducibility-receipt-contract.mjs';
import {
  REQUIRED_SCOPED_SCHEMA_VERSIONS,
} from './scoped-schema-version-contract.mjs';

const SHA256 = /^sha256:[0-9a-f]{64}$/i;

export const FULL_RESEARCH_QUALIFICATION_MAXIMUM_AGE_MS = 24 * 60 * 60 * 1000;
export const CODEX_MODEL_AVAILABILITY_CANARY_MAXIMUM_AGE_MS = 15 * 60 * 1000;
export const FULL_RESEARCH_QUALIFICATION_ATTESTOR_ROLE =
  'research_execution_release_attestor';

export function providerPrincipalIndependenceAttestationSigningPayloadHash(attestation) {
  if (!attestation || typeof attestation !== 'object') return null;
  const {
    signature: _signature,
    providerPrincipalIndependenceAttestationHash: _hash,
    ...payload
  } = attestation;
  return hashRecord('ProviderPrincipalIndependenceAttestationSigningPayload', payload);
}

export function uniqueQualificationBlockers(values) {
  return [...new Set(values.filter(Boolean))];
}

export function withoutQualificationEnvelope(record) {
  if (!record || typeof record !== 'object') return null;
  const {
    signature: _signature,
    fullResearchQualificationReceiptHash: _receiptHash,
    ...payload
  } = record;
  return payload;
}

export function withoutQualificationReceiptHash(record) {
  if (!record || typeof record !== 'object') return null;
  const { fullResearchQualificationReceiptHash: _receiptHash, ...payload } = record;
  return payload;
}

function recordHashValid(record, kind, hashField) {
  if (!record || !SHA256.test(String(record?.[hashField] || ''))) return false;
  const { [hashField]: _hash, ...payload } = record;
  return hashRecord(kind, payload) === record[hashField];
}

function sameFields(left, right, fields) {
  return fields.every(
    (field) => (left?.[field] ?? null) === (right?.[field] ?? null),
  );
}

export function qualificationCodeIdentityValid(record, expected) {
  const fields = [
    'version', 'packageVersion', 'commit', 'commitTree', 'treeDirty', 'indexStateHash',
    'repositoryEntryCount', 'repositoryContentHash', 'worktreeStateHash',
  ];
  return record?.version === 2
    && fields.filter((field) => field.endsWith('Hash')).every(
      (field) => SHA256.test(String(record?.[field] || '')),
    )
    && sameFields(record, expected, fields);
}

export function qualificationCapabilityValid(receipt, kind, status, hashField) {
  return receipt?.version === 1 && receipt?.kind === kind && receipt?.status === status
    && receipt?.provider === 'openai'
    && receipt?.authenticationStatus === 'codex_authentication_verified'
    && receipt?.modelOptionVerified === true
    && ['codexBinaryIdentityHash', 'credentialRootIdentityHash', 'credentialConfigIdentityHash']
      .every((field) => SHA256.test(String(receipt?.[field] || '')))
    && recordHashValid(receipt, kind, hashField);
}

function canonicalTimestampMs(value) {
  const parsed = Date.parse(String(value || ''));
  return Number.isFinite(parsed) && new Date(parsed).toISOString() === value ? parsed : null;
}

export function qualificationCanaryValid(receipt, capability, { freshAtMs = null } = {}) {
  const observedAtMs = canonicalTimestampMs(receipt?.observedAt);
  const expiresAtMs = canonicalTimestampMs(receipt?.expiresAt);
  return receipt?.version === 1
    && receipt?.kind === 'CodexModelAvailabilityCanaryReceipt'
    && receipt?.status === 'codex_model_live_canary_verified'
    && receipt?.provider === 'openai'
    && receipt?.selectedModelExecutionCanaryVerified === true
    && receipt?.authenticationStatus === 'codex_authentication_verified'
    && receipt?.externalActionPerformed === true
    && receipt?.externalActionScope === 'single_read_only_ephemeral_model_canary'
    && ['challengeHash', 'responseHash', 'codexBinaryIdentityHash', 'credentialRootIdentityHash',
      'credentialConfigIdentityHash', 'codexModelAvailabilityCanaryReceiptHash']
      .every((field) => SHA256.test(String(receipt?.[field] || '')))
    && observedAtMs !== null && expiresAtMs !== null
    && expiresAtMs - observedAtMs === CODEX_MODEL_AVAILABILITY_CANARY_MAXIMUM_AGE_MS
    && Number.isFinite(freshAtMs) && freshAtMs >= observedAtMs && freshAtMs < expiresAtMs
    && sameFields(receipt, capability, [
      'provider', 'model', 'codexVersion', 'codexBinaryIdentityHash',
      'credentialRootIdentityHash', 'credentialConfigIdentityHash', 'authenticationStatus',
    ])
    && recordHashValid(
      receipt,
      'CodexModelAvailabilityCanaryReceipt',
      'codexModelAvailabilityCanaryReceiptHash',
    );
}

export function qualificationSchemaValid(receipt, expected) {
  return receipt?.version === 1 && receipt?.kind === 'ScopedSchemaVersionGateReceipt'
    && receipt?.status === 'scoped_schema_version_verified'
    && Array.isArray(receipt?.requiredVersions)
    && JSON.stringify(receipt.requiredVersions)
      === JSON.stringify(REQUIRED_SCOPED_SCHEMA_VERSIONS)
    && recordHashValid(
      receipt,
      'ScopedSchemaVersionGateReceipt',
      'scopedSchemaVersionGateReceiptHash',
    )
    && receipt.scopedSchemaVersionGateReceiptHash
      === expected?.scopedSchemaVersionGateReceiptHash;
}

export function qualificationRuntimeImagesValid(observed, expected) {
  if (!observed || typeof observed !== 'object'
    || !expected || typeof expected !== 'object') return false;
  const keys = Object.keys(observed).sort();
  if (JSON.stringify(keys)
    !== JSON.stringify([...REQUIRED_RUNTIME_IMAGE_REPRODUCIBILITY_PROFILES])) return false;
  return REQUIRED_RUNTIME_IMAGE_REPRODUCIBILITY_PROFILES.every((profile) => (
    SHA256.test(String(observed[profile] || ''))
    && observed[profile] === expected[profile]
  ));
}

export function qualificationRuntimeImageBindingShapeValid(receipt) {
  const profiles = receipt?.runtimeImageReproducibilityRequiredProfiles;
  const definitions = receipt?.runtimeImageReproducibilityDefinitionManifestHashes;
  const scope = RUNTIME_IMAGE_REPRODUCIBILITY_ACTIVE_PLUGIN_SCOPE;
  return SHA256.test(String(receipt?.runtimeImageReproducibilityReceiptHash || ''))
    && Array.isArray(profiles)
    && JSON.stringify(profiles)
      === JSON.stringify(REQUIRED_RUNTIME_IMAGE_REPRODUCIBILITY_PROFILES)
    && definitions && typeof definitions === 'object' && !Array.isArray(definitions)
    && JSON.stringify(Object.keys(definitions)) === JSON.stringify(profiles)
    && profiles.every((profile) => SHA256.test(String(definitions[profile] || '')))
    && receipt?.empiricalFamilyPluginPackageHash
      === scope.empiricalFamilyPluginPackageHash
    && receipt?.empiricalFamilyPluginRegistryHash
      === scope.empiricalFamilyPluginRegistryHash
    && receipt?.empiricalFamilyPluginStartupInspectionHash
      === scope.empiricalFamilyPluginStartupInspectionHash
    && JSON.stringify(receipt?.activeEmpiricalProductionProfileHashes)
      === JSON.stringify(scope.activeProductionProfileHashes)
    && receipt?.runtimeImageReproducibilityActivePluginScopeHash
      === scope.runtimeImageReproducibilityActivePluginScopeHash;
}

export function qualificationRuntimeImageBindingValid(receipt, inspection) {
  return qualificationRuntimeImageBindingShapeValid(receipt)
    && inspection?.kind === 'RuntimeImageReproducibilityReceiptInspection'
    && inspection?.ready === true && inspection?.receiptAccepted === true
    && receipt.runtimeImageReproducibilityReceiptHash === inspection.receiptHash
    && JSON.stringify(receipt.runtimeImageReproducibilityRequiredProfiles)
      === JSON.stringify(inspection.requiredProfiles)
    && JSON.stringify(receipt.runtimeImageReproducibilityDefinitionManifestHashes)
      === JSON.stringify(inspection.definitionManifestHashes)
    && receipt.empiricalFamilyPluginPackageHash
      === inspection.empiricalFamilyPluginPackageHash
    && receipt.empiricalFamilyPluginRegistryHash
      === inspection.empiricalFamilyPluginRegistryHash
    && receipt.empiricalFamilyPluginStartupInspectionHash
      === inspection.empiricalFamilyPluginStartupInspectionHash
    && JSON.stringify(receipt.activeEmpiricalProductionProfileHashes)
      === JSON.stringify(inspection.activeProductionProfileHashes)
    && receipt.runtimeImageReproducibilityActivePluginScopeHash
      === inspection.runtimeImageReproducibilityActivePluginScopeHash;
}

export function independentHypothesisPriorArtQualificationValid(
  receipt,
  releaseBinding,
  {
    allowBoundedGoldenCapability = false,
    releaseScope = null,
  } = {},
) {
  const priorArtEvidenceReceipt = receipt?.priorArtEvidenceReceipt || null;
  const currentPriorArtEvidenceReceipt = releaseBinding?.priorArtEvidenceReceipt || null;
  if (receipt?.independentHypothesisPriorArtReviewVerified !== true
    || !SHA256.test(String(receipt?.independentHypothesisPriorArtReceiptHash || ''))
    || priorArtEvidenceReceipt?.version !== 2
    || currentPriorArtEvidenceReceipt?.version !== 2
    || !SHA256.test(String(releaseBinding?.priorArtEvidenceReceiptHash || ''))
    || releaseBinding.priorArtEvidenceReceiptHash
      !== currentPriorArtEvidenceReceipt.priorArtEvidenceReceiptHash
    || receipt.independentHypothesisPriorArtReceiptHash
      !== releaseBinding.priorArtEvidenceReceiptHash
    || priorArtEvidenceReceipt.priorArtEvidenceReceiptHash
      !== receipt.independentHypothesisPriorArtReceiptHash
    || JSON.stringify(priorArtEvidenceReceipt)
      !== JSON.stringify(currentPriorArtEvidenceReceipt)) return false;
  const boundedGoldenScope = allowBoundedGoldenCapability === true
    && releaseScope?.valid === true
    && releaseScope?.boundedGoldenScope === true
    && releaseScope?.releaseBinding?.autonomousResearchReleaseBindingHash
      === releaseBinding?.autonomousResearchReleaseBindingHash;
  if (boundedGoldenScope) {
    if (releaseBinding?.version !== 3
      || releaseBinding?.proposal
      || releaseBinding?.researchAgendaIr
      || (releaseBinding?.researchAgendaIrHash || null) !== null
      || !SHA256.test(String(priorArtEvidenceReceipt.agendaSelectionReceiptHash || ''))
      || !SHA256.test(String(priorArtEvidenceReceipt.researchAgendaIrHash || ''))
      || !Array.isArray(priorArtEvidenceReceipt.priorArtQueryPlan)
      || priorArtEvidenceReceipt.priorArtQueryPlan.length === 0
      || !SHA256.test(String(priorArtEvidenceReceipt.priorArtQueryPlanHash || ''))) {
      return false;
    }
    const verification = verifyPriorArtEvidenceReceipt(priorArtEvidenceReceipt, {
      paperId: releaseBinding.paperId,
      agendaSelectionReceiptHash: priorArtEvidenceReceipt.agendaSelectionReceiptHash,
      researchAgendaIrHash: priorArtEvidenceReceipt.researchAgendaIrHash,
      priorArtQueryPlan: priorArtEvidenceReceipt.priorArtQueryPlan,
      priorArtQueryPlanHash: priorArtEvidenceReceipt.priorArtQueryPlanHash,
      requireVerified: true,
    });
    return verification.ready
      && verification.priorArtEvidenceReceiptHash
        === releaseBinding.priorArtEvidenceReceiptHash;
  }
  const researchAgendaIr = releaseBinding?.researchAgendaIr || null;
  const agendaSelectionReceiptHash =
    releaseBinding?.proposal?.agendaSelectionReceiptHash || null;
  if (!SHA256.test(String(releaseBinding?.researchAgendaIrHash || ''))
    || !SHA256.test(String(agendaSelectionReceiptHash || ''))
    || !Array.isArray(researchAgendaIr?.priorArtQueryPlan)
    || researchAgendaIr.priorArtQueryPlan.length === 0
    || releaseBinding.researchAgendaIrHash !== researchAgendaIr.researchAgendaIrHash) {
    return false;
  }
  const verification = verifyPriorArtEvidenceReceipt(priorArtEvidenceReceipt, {
    paperId: releaseBinding.paperId,
    agendaSelectionReceiptHash,
    researchAgendaIrHash: releaseBinding.researchAgendaIrHash,
    priorArtQueryPlan: researchAgendaIr.priorArtQueryPlan,
    priorArtQueryPlanHash: currentPriorArtEvidenceReceipt.priorArtQueryPlanHash,
    requireVerified: true,
  });
  return verification.ready
    && verification.priorArtEvidenceReceiptHash
      === releaseBinding.priorArtEvidenceReceiptHash;
}

export function releaseAttestorSignerTrustedAt(inspection, signer, signedAt) {
  const signedAtMs = Date.parse(String(signedAt || ''));
  if (!Number.isFinite(signedAtMs) || inspection?.ready !== true) return false;
  const keys = Array.isArray(inspection?.trustedKeys) && inspection.trustedKeys.length
    ? inspection.trustedKeys
    : [Object.freeze({
      keyId: inspection?.keyId,
      keyVersion: inspection?.keyVersion,
      subjectId: inspection?.subjectId,
      organization: inspection?.organization || null,
      role: inspection?.role,
      algorithm: inspection?.algorithm,
      status: 'active',
      effectiveFrom: inspection?.effectiveFrom,
      expiresAt: inspection?.expiresAt,
      revokedAt: null,
    })];
  return keys.some((key) => {
    const effectiveFrom = Date.parse(String(key?.effectiveFrom || ''));
    const expiresAt = Date.parse(String(key?.expiresAt || ''));
    return key?.keyId === signer?.keyId
      && key?.keyVersion === signer?.keyVersion
      && key?.subjectId === signer?.subjectId
      && (key?.organization || null) === (signer?.organization || null)
      && key?.role === signer?.role
      && key?.algorithm === 'ed25519'
      && ['active', 'retiring'].includes(key?.status)
      && key?.revokedAt === null
      && Number.isFinite(effectiveFrom) && Number.isFinite(expiresAt)
      && signedAtMs >= effectiveFrom && signedAtMs < expiresAt;
  });
}

export function providerPrincipalIndependenceVerified({
  attestation,
  authorCapability,
  reviewerCapability,
  signer,
  nowMs,
  verifySignature,
} = {}) {
  if (!attestation || attestation.version !== 1
    || attestation.kind !== 'ProviderPrincipalIndependenceAttestation'
    || attestation.status !== 'provider_principal_independence_attested'
    || attestation.assurance !== 'external-operator-attested-distinct-provider-accounts-v1'
    || attestation.authorCredentialConfigIdentityHash
      !== authorCapability?.credentialConfigIdentityHash
    || attestation.reviewerCredentialConfigIdentityHash
      !== reviewerCapability?.credentialConfigIdentityHash
    || !SHA256.test(String(attestation.authorProviderAccountIdentityHash || ''))
    || !SHA256.test(String(attestation.reviewerProviderAccountIdentityHash || ''))
    || attestation.authorProviderAccountIdentityHash
      === attestation.reviewerProviderAccountIdentityHash
    || attestation.signer?.keyId !== signer?.keyId
    || attestation.signer?.keyVersion !== signer?.keyVersion
    || attestation.signer?.subjectId !== signer?.subjectId
    || attestation.signer?.role !== signer?.role
    || attestation.signer?.algorithm !== 'ed25519') return false;
  const { providerPrincipalIndependenceAttestationHash: claimedHash, ...payload } =
    attestation;
  if (!SHA256.test(String(claimedHash || ''))
    || hashRecord('ProviderPrincipalIndependenceAttestation', payload)
      !== claimedHash) return false;
  const attestedAt = Date.parse(String(attestation.attestedAt || ''));
  const expiresAt = Date.parse(String(attestation.expiresAt || ''));
  if (!Number.isFinite(attestedAt) || !Number.isFinite(expiresAt)
    || expiresAt <= attestedAt
    || expiresAt - attestedAt > FULL_RESEARCH_QUALIFICATION_MAXIMUM_AGE_MS
    || !Number.isFinite(nowMs) || nowMs < attestedAt || nowMs >= expiresAt) return false;
  const signingPayloadHash =
    providerPrincipalIndependenceAttestationSigningPayloadHash(attestation);
  return SHA256.test(String(signingPayloadHash || ''))
    && typeof verifySignature === 'function'
    && verifySignature({
      signingPayloadHash,
      signature: attestation.signature,
      signer: attestation.signer,
      signedAt: attestation.attestedAt,
    }) === true;
}
