import { hashRecord } from '../../workflow-kernel/record-hash.mjs';
import { verifyPriorArtEvidenceReceipt } from '../research/prior-art-evidence-contract.mjs';
import {
  REQUIRED_RUNTIME_IMAGE_REPRODUCIBILITY_PROFILES,
  RUNTIME_IMAGE_REPRODUCIBILITY_ACTIVE_PLUGIN_SCOPE,
} from './runtime-image-reproducibility-receipt-contract.mjs';
import {
  MANUSCRIPT_RELEASE_PROOF_FIELDS,
  inspectAutonomousResearchReleaseQualificationScope,
  inspectSuccessfulFullResearchRelease,
} from './full-research-release-qualification-inspection.mjs';
import {
  REQUIRED_SCOPED_SCHEMA_VERSIONS,
} from './scoped-schema-version-contract.mjs';

const SHA256 = /^sha256:[0-9a-f]{64}$/i;

export const FULL_RESEARCH_QUALIFICATION_MAXIMUM_AGE_MS = 24 * 60 * 60 * 1000;
export const CODEX_MODEL_AVAILABILITY_CANARY_MAXIMUM_AGE_MS = 15 * 60 * 1000;
export const FULL_RESEARCH_QUALIFICATION_ATTESTOR_ROLE = 'research_execution_release_attestor';

export function providerPrincipalIndependenceAttestationSigningPayloadHash(attestation) {
  if (!attestation || typeof attestation !== 'object') return null;
  const {
    signature: _signature,
    providerPrincipalIndependenceAttestationHash: _hash,
    ...payload
  } = attestation;
  return hashRecord('ProviderPrincipalIndependenceAttestationSigningPayload', payload);
}

function unique(values) {
  return [...new Set(values.filter(Boolean))];
}

function withoutQualificationEnvelope(record) {
  if (!record || typeof record !== 'object') return null;
  const {
    signature: _signature,
    fullResearchQualificationReceiptHash: _receiptHash,
    ...payload
  } = record;
  return payload;
}

function withoutReceiptHash(record) {
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
  return fields.every((field) => (left?.[field] ?? null) === (right?.[field] ?? null));
}

function codeIdentityValid(record, expected) {
  const fields = [
    'version', 'packageVersion', 'commit', 'commitTree', 'treeDirty', 'indexStateHash',
    'repositoryEntryCount', 'repositoryContentHash', 'worktreeStateHash',
  ];
  return record?.version === 2
    && fields.filter((field) => field.endsWith('Hash')).every((field) => SHA256.test(String(record?.[field] || '')))
    && sameFields(record, expected, fields);
}

function capabilityValid(receipt, kind, status, hashField) {
  return receipt?.version === 1 && receipt?.kind === kind && receipt?.status === status
    && receipt?.provider === 'openai' && receipt?.authenticationStatus === 'codex_authentication_verified'
    && receipt?.modelOptionVerified === true
    && ['codexBinaryIdentityHash', 'credentialRootIdentityHash', 'credentialConfigIdentityHash']
      .every((field) => SHA256.test(String(receipt?.[field] || '')))
    && recordHashValid(receipt, kind, hashField);
}

function canonicalTimestampMs(value) {
  const parsed = Date.parse(String(value || ''));
  return Number.isFinite(parsed) && new Date(parsed).toISOString() === value ? parsed : null;
}

function canaryValid(receipt, capability, { freshAtMs = null } = {}) {
  const observedAtMs = canonicalTimestampMs(receipt?.observedAt);
  const expiresAtMs = canonicalTimestampMs(receipt?.expiresAt);
  return receipt?.version === 1 && receipt?.kind === 'CodexModelAvailabilityCanaryReceipt'
    && receipt?.status === 'codex_model_live_canary_verified'
    && receipt?.provider === 'openai' && receipt?.selectedModelExecutionCanaryVerified === true
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

function schemaValid(receipt, expected) {
  return receipt?.version === 1 && receipt?.kind === 'ScopedSchemaVersionGateReceipt'
    && receipt?.status === 'scoped_schema_version_verified'
    && Array.isArray(receipt?.requiredVersions)
    && JSON.stringify(receipt.requiredVersions)
      === JSON.stringify(REQUIRED_SCOPED_SCHEMA_VERSIONS)
    && recordHashValid(receipt, 'ScopedSchemaVersionGateReceipt', 'scopedSchemaVersionGateReceiptHash')
    && receipt.scopedSchemaVersionGateReceiptHash === expected?.scopedSchemaVersionGateReceiptHash;
}

function runtimeImagesValid(observed, expected) {
  if (!observed || typeof observed !== 'object' || !expected || typeof expected !== 'object') return false;
  const keys = Object.keys(observed).sort();
  if (JSON.stringify(keys)
    !== JSON.stringify([...REQUIRED_RUNTIME_IMAGE_REPRODUCIBILITY_PROFILES])) return false;
  return REQUIRED_RUNTIME_IMAGE_REPRODUCIBILITY_PROFILES.every((profile) => (
    SHA256.test(String(observed[profile] || ''))
    && observed[profile] === expected[profile]
  ));
}

function runtimeImageReproducibilityBindingShapeValid(receipt) {
  const profiles = receipt?.runtimeImageReproducibilityRequiredProfiles;
  const definitions = receipt?.runtimeImageReproducibilityDefinitionManifestHashes;
  const scope = RUNTIME_IMAGE_REPRODUCIBILITY_ACTIVE_PLUGIN_SCOPE;
  return SHA256.test(String(receipt?.runtimeImageReproducibilityReceiptHash || ''))
    && Array.isArray(profiles)
    && JSON.stringify(profiles) === JSON.stringify(
      REQUIRED_RUNTIME_IMAGE_REPRODUCIBILITY_PROFILES,
    )
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

function runtimeImageReproducibilityBindingValid(receipt, inspection) {
  return runtimeImageReproducibilityBindingShapeValid(receipt)
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

function independentHypothesisPriorArtQualificationValid(receipt, releaseBinding, {
  allowBoundedGoldenCapability = false,
  releaseScope = null,
} = {}) {
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
      agendaSelectionReceiptHash:
        priorArtEvidenceReceipt.agendaSelectionReceiptHash,
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

function releaseAttestorSignerTrustedAt(inspection, signer, signedAt) {
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

function providerPrincipalIndependenceVerified({
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
    || attestation.authorCredentialConfigIdentityHash !== authorCapability?.credentialConfigIdentityHash
    || attestation.reviewerCredentialConfigIdentityHash !== reviewerCapability?.credentialConfigIdentityHash
    || !SHA256.test(String(attestation.authorProviderAccountIdentityHash || ''))
    || !SHA256.test(String(attestation.reviewerProviderAccountIdentityHash || ''))
    || attestation.authorProviderAccountIdentityHash === attestation.reviewerProviderAccountIdentityHash
    || attestation.signer?.keyId !== signer?.keyId
    || attestation.signer?.keyVersion !== signer?.keyVersion
    || attestation.signer?.subjectId !== signer?.subjectId
    || attestation.signer?.role !== signer?.role
    || attestation.signer?.algorithm !== 'ed25519') return false;
  const { providerPrincipalIndependenceAttestationHash: claimedHash, ...payload } = attestation;
  if (!SHA256.test(String(claimedHash || ''))
    || hashRecord('ProviderPrincipalIndependenceAttestation', payload) !== claimedHash) return false;
  const attestedAt = Date.parse(String(attestation.attestedAt || ''));
  const expiresAt = Date.parse(String(attestation.expiresAt || ''));
  if (!Number.isFinite(attestedAt) || !Number.isFinite(expiresAt) || expiresAt <= attestedAt
    || expiresAt - attestedAt > FULL_RESEARCH_QUALIFICATION_MAXIMUM_AGE_MS
    || !Number.isFinite(nowMs) || nowMs < attestedAt || nowMs >= expiresAt) return false;
  const signingPayloadHash = providerPrincipalIndependenceAttestationSigningPayloadHash(attestation);
  return SHA256.test(String(signingPayloadHash || ''))
    && typeof verifySignature === 'function'
    && verifySignature({
      signingPayloadHash,
      signature: attestation.signature,
      signer: attestation.signer,
      signedAt: attestation.attestedAt,
    }) === true;
}

export function fullResearchQualificationSigningPayloadHash(receipt) {
  const payload = withoutQualificationEnvelope(receipt);
  return payload ? hashRecord('FullResearchQualificationSigningPayload', payload) : null;
}

export function verifyFullResearchQualificationReceiptEnvelope(receipt, {
  now = null,
  campaignReleaseAuthority = null,
  expectedPaperId = null,
  expectedProposalHash = null,
  expectedPolicyAuthorizationHash = null,
  expectedSeedBindingHash = null,
  verifyQualificationSignature = null,
  allowBoundedGoldenCapability = false,
} = {}) {
  const blockers = [];
  const nowMs = now instanceof Date ? now.getTime() : Date.parse(String(now));
  const authority = campaignReleaseAuthority;
  const autonomousBinding = authority?.releaseBundle?.autonomousResearchReleaseBinding || null;
  const releaseScope = inspectAutonomousResearchReleaseQualificationScope({
    authority,
    receipt,
    allowBoundedGoldenCapability,
  });
  if (!Number.isFinite(nowMs)) blockers.push('external_qualification_verification_time_invalid');
  if (receipt?.version !== 1
    || receipt?.kind !== 'FullResearchGoldenMicroCampaignQualificationReceipt'
    || receipt?.status !== 'full_research_golden_micro_campaign_qualified'
    || receipt?.externalActionPerformed !== true) {
    blockers.push('external_qualification_receipt_shape_invalid');
  }
  if (!independentHypothesisPriorArtQualificationValid(receipt, autonomousBinding, {
    allowBoundedGoldenCapability,
    releaseScope,
  })) {
    blockers.push('external_qualification_independent_hypothesis_prior_art_qualification_invalid');
  }
  if (!runtimeImageReproducibilityBindingShapeValid(receipt)) {
    blockers.push('external_qualification_runtime_image_reproducibility_binding_invalid');
  }
  const receiptPayload = withoutReceiptHash(receipt);
  if (!receiptPayload || !SHA256.test(String(receipt?.fullResearchQualificationReceiptHash || ''))
    || hashRecord('FullResearchGoldenMicroCampaignQualificationReceipt', receiptPayload)
      !== receipt?.fullResearchQualificationReceiptHash) {
    blockers.push('external_qualification_receipt_hash_invalid');
  }
  const issuedAt = Date.parse(String(receipt?.issuedAt || ''));
  const expiresAt = Date.parse(String(receipt?.expiresAt || ''));
  if (!Number.isFinite(issuedAt) || !Number.isFinite(expiresAt) || expiresAt <= issuedAt
    || expiresAt - issuedAt > FULL_RESEARCH_QUALIFICATION_MAXIMUM_AGE_MS
    || (Number.isFinite(nowMs) && (nowMs < issuedAt || nowMs >= expiresAt))) {
    blockers.push('external_qualification_receipt_outside_time_window');
  }
  const autonomousBindingPayload = autonomousBinding && typeof autonomousBinding === 'object'
    ? (() => {
      const { autonomousResearchReleaseBindingHash: _hash, ...payload } = autonomousBinding;
      return payload;
    })() : null;
  if (authority?.status !== 'current_completed_release'
    || authority?.campaignStatus !== 'completed'
    || authority?.packageNodeStatus !== 'completed'
    || !SHA256.test(String(authority?.campaignReleaseBundleHash || ''))
    || authority?.campaignId !== receipt?.campaignId
    || authority?.paperId !== receipt?.paperId
    || (expectedPaperId && expectedPaperId !== receipt?.paperId)
    || authority?.campaignReleaseBundleHash !== receipt?.campaignReleaseBundleHash
    || authority?.releaseBundle?.campaignReleaseBundleHash !== receipt?.campaignReleaseBundleHash
    || authority?.releaseBundle?.researchReport?.promotionEligibility?.status
      !== 'research_promotion_ready') {
    blockers.push('external_qualification_current_release_pointer_mismatch');
  }
  if (!autonomousBindingPayload
    || hashRecord('AutonomousResearchReleaseBinding', autonomousBindingPayload)
      !== autonomousBinding?.autonomousResearchReleaseBindingHash
    || authority?.releaseBundle?.autonomousResearchReleaseBindingHash
      !== autonomousBinding?.autonomousResearchReleaseBindingHash
    || autonomousBinding?.campaignId !== authority?.campaignId
    || autonomousBinding?.paperId !== authority?.paperId
    || autonomousBinding?.campaignPlanHash !== authority?.releaseBundle?.campaignPlanHash
    || autonomousBinding?.proposalHash !== expectedProposalHash
    || autonomousBinding?.policyAuthorizationHash !== expectedPolicyAuthorizationHash
    || autonomousBinding?.seedBindingHash !== expectedSeedBindingHash
    || receipt?.proposalHash !== expectedProposalHash
    || receipt?.policyAuthorizationHash !== expectedPolicyAuthorizationHash
    || receipt?.seedBindingHash !== expectedSeedBindingHash) {
    blockers.push('external_qualification_autonomous_preparation_binding_mismatch');
  }
  if (releaseScope.blockers.includes('research_release_qualification_scope_invalid')) {
    blockers.push('external_qualification_release_scope_not_eligible');
  }
  if (releaseScope.blockers.includes('research_release_manuscript_proof_mismatch')) {
    blockers.push('external_qualification_manuscript_release_proof_mismatch');
  }
  const signer = receipt?.signer || null;
  const signingPayloadHash = fullResearchQualificationSigningPayloadHash(receipt);
  if (signer?.role !== FULL_RESEARCH_QUALIFICATION_ATTESTOR_ROLE
    || signer?.algorithm !== 'ed25519'
    || !SHA256.test(String(signingPayloadHash || ''))
    || typeof receipt?.signature !== 'string' || !receipt.signature
    || typeof verifyQualificationSignature !== 'function'
    || verifyQualificationSignature({
      signingPayloadHash,
      signature: receipt.signature,
      signer,
      signedAt: receipt.issuedAt,
    }) !== true) {
    blockers.push('external_qualification_signature_invalid');
  }
  const uniqueBlockers = Object.freeze(unique(blockers));
  return Object.freeze({
    version: 1,
    kind: 'FullResearchQualificationReceiptEnvelopeVerification',
    status: uniqueBlockers.length
      ? 'full_research_qualification_receipt_envelope_blocked'
      : 'full_research_qualification_receipt_envelope_verified',
    ready: uniqueBlockers.length === 0,
    signatureVerified: !uniqueBlockers.includes('external_qualification_signature_invalid'),
    timeWindowVerified: !uniqueBlockers.includes('external_qualification_receipt_outside_time_window')
      && !uniqueBlockers.includes('external_qualification_verification_time_invalid'),
    releasePointerVerified:
      !uniqueBlockers.includes('external_qualification_current_release_pointer_mismatch'),
    campaignId: uniqueBlockers.length ? null : receipt.campaignId,
    paperId: uniqueBlockers.length ? null : receipt.paperId,
    campaignReleaseBundleHash: uniqueBlockers.length ? null : receipt.campaignReleaseBundleHash,
    qualificationReceiptHash: uniqueBlockers.length
      ? null : receipt.fullResearchQualificationReceiptHash,
    issuedAt: uniqueBlockers.length ? null : receipt.issuedAt,
    expiresAt: uniqueBlockers.length ? null : receipt.expiresAt,
    remainingValidityMs: uniqueBlockers.length || !Number.isFinite(nowMs)
      ? null : expiresAt - nowMs,
    runtimeImageReproducibilityReceiptHash: uniqueBlockers.length
      ? null : receipt.runtimeImageReproducibilityReceiptHash,
    runtimeImageReproducibilityRequiredProfiles: uniqueBlockers.length
      ? null : receipt.runtimeImageReproducibilityRequiredProfiles,
    runtimeImageReproducibilityDefinitionManifestHashes: uniqueBlockers.length
      ? null : receipt.runtimeImageReproducibilityDefinitionManifestHashes,
    empiricalFamilyPluginPackageHash: uniqueBlockers.length
      ? null : receipt.empiricalFamilyPluginPackageHash,
    empiricalFamilyPluginRegistryHash: uniqueBlockers.length
      ? null : receipt.empiricalFamilyPluginRegistryHash,
    empiricalFamilyPluginStartupInspectionHash: uniqueBlockers.length
      ? null : receipt.empiricalFamilyPluginStartupInspectionHash,
    activeEmpiricalProductionProfileHashes: uniqueBlockers.length
      ? null : receipt.activeEmpiricalProductionProfileHashes,
    runtimeImageReproducibilityActivePluginScopeHash: uniqueBlockers.length
      ? null : receipt.runtimeImageReproducibilityActivePluginScopeHash,
    proposalHash: uniqueBlockers.length ? null : receipt.proposalHash,
    policyAuthorizationHash: uniqueBlockers.length ? null : receipt.policyAuthorizationHash,
    seedBindingHash: uniqueBlockers.length ? null : receipt.seedBindingHash,
    qualificationScope: uniqueBlockers.length ? null : receipt.qualificationScope,
    genericContentCanaryVerified: uniqueBlockers.length
      ? false : autonomousBinding?.genericContentCanaryVerified === true,
    ...Object.fromEntries(MANUSCRIPT_RELEASE_PROOF_FIELDS.map((field) => [
      field,
      uniqueBlockers.length ? null : receipt?.[field] || null,
    ])),
    independentHypothesisPriorArtReviewVerified: uniqueBlockers.length === 0,
    independentHypothesisPriorArtReceiptHash: uniqueBlockers.length
      ? null : receipt.independentHypothesisPriorArtReceiptHash,
    structuredPriorArtEvidenceVerified: uniqueBlockers.length === 0
      && Boolean(receipt.priorArtEvidenceReceipt),
    blockers: uniqueBlockers,
  });
}

export function verifyFullResearchQualificationReceipt(receipt, {
  now = null,
  codeProvenance = null,
  researchAuthorCapabilityReceipt = null,
  formalReviewerCapabilityReceipt = null,
  campaignStoreSchemaReceipt = null,
  runtimeImageDigests = null,
  runtimeImageReproducibilityInspection = null,
  researchAuthorProviderCanaryReceipt = null,
  formalReviewerProviderCanaryReceipt = null,
  releaseAttestorInspection = null,
  resolveCampaignReleaseAuthority = null,
  verifyReleaseAttestation = null,
  verifyQualificationSignature = null,
  requireGlobalGoldenAuthority = false,
  runtimePrincipalBinding = null,
  reviewerEvidenceAuthority = null,
} = {}) {
  const blockers = [];
  const nowMs = now instanceof Date ? now.getTime() : Date.parse(String(now));
  if (!Number.isFinite(nowMs)) blockers.push('golden_micro_campaign_qualification_verification_time_invalid');
  if (receipt?.version !== 1 || receipt?.kind !== 'FullResearchGoldenMicroCampaignQualificationReceipt'
    || receipt?.status !== 'full_research_golden_micro_campaign_qualified'
    || receipt?.externalActionPerformed !== true) {
    blockers.push('golden_micro_campaign_qualification_receipt_shape_invalid');
  }
  const receiptPayload = withoutReceiptHash(receipt);
  if (!receiptPayload || !SHA256.test(String(receipt?.fullResearchQualificationReceiptHash || ''))
    || hashRecord('FullResearchGoldenMicroCampaignQualificationReceipt', receiptPayload)
      !== receipt?.fullResearchQualificationReceiptHash) {
    blockers.push('golden_micro_campaign_qualification_receipt_hash_invalid');
  }
  const issuedAt = Date.parse(String(receipt?.issuedAt || ''));
  const expiresAt = Date.parse(String(receipt?.expiresAt || ''));
  if (!Number.isFinite(issuedAt) || !Number.isFinite(expiresAt) || expiresAt <= issuedAt
    || expiresAt - issuedAt > FULL_RESEARCH_QUALIFICATION_MAXIMUM_AGE_MS
    || (Number.isFinite(nowMs) && (nowMs < issuedAt || nowMs >= expiresAt))) {
    blockers.push('golden_micro_campaign_qualification_receipt_outside_time_window');
  }
  if (!codeIdentityValid(receipt?.codeProvenance, codeProvenance)) {
    blockers.push('golden_micro_campaign_code_worktree_identity_mismatch');
  }
  const authorCapability = receipt?.researchAuthorCapabilityReceipt;
  const reviewerCapability = receipt?.formalReviewerCapabilityReceipt;
  if (!capabilityValid(authorCapability, 'CodexResearchAuthorCapabilityReceipt',
    'codex_research_author_capability_ready', 'codexResearchAuthorCapabilityReceiptHash')
    || authorCapability?.codexResearchAuthorCapabilityReceiptHash
      !== researchAuthorCapabilityReceipt?.codexResearchAuthorCapabilityReceiptHash) {
    blockers.push('golden_micro_campaign_research_author_configuration_mismatch');
  }
  if (!capabilityValid(reviewerCapability, 'CodexFormalReviewerCapabilityReceipt',
    'codex_formal_reviewer_capability_ready', 'codexFormalReviewerCapabilityReceiptHash')
    || reviewerCapability?.codexFormalReviewerCapabilityReceiptHash
      !== formalReviewerCapabilityReceipt?.codexFormalReviewerCapabilityReceiptHash
    || reviewerCapability?.credentialIndependenceVerified !== true
    || reviewerCapability?.authorCredentialRootIdentityHash !== authorCapability?.credentialRootIdentityHash
    || reviewerCapability?.credentialRootIdentityHash === authorCapability?.credentialRootIdentityHash) {
    blockers.push('golden_micro_campaign_formal_reviewer_configuration_mismatch');
  }
  const capabilityAccountIndependenceVerified = authorCapability?.providerAccountIdentityAttested === true
    && reviewerCapability?.providerAccountIdentityAttested === true
    && reviewerCapability?.providerAccountIndependenceVerified === true
    && SHA256.test(String(authorCapability?.providerAccountIdentityHash || ''))
    && SHA256.test(String(reviewerCapability?.providerAccountIdentityHash || ''))
    && reviewerCapability?.authorProviderAccountIdentityHash === authorCapability?.providerAccountIdentityHash
    && reviewerCapability?.providerAccountIdentityHash !== authorCapability?.providerAccountIdentityHash;
  const signedAccountIndependenceVerified = providerPrincipalIndependenceVerified({
    attestation: receipt?.providerPrincipalIndependenceAttestation,
    authorCapability,
    reviewerCapability,
    signer: receipt?.signer,
    nowMs,
    verifySignature: verifyQualificationSignature,
  });
  if (!capabilityAccountIndependenceVerified && !signedAccountIndependenceVerified) {
    blockers.push('golden_micro_campaign_provider_account_independence_not_verified');
  }
  /* A distinct credential root remains mandatory even when account identity is
     externally attested; filesystem separation alone is never account proof. */
  if (authorCapability?.credentialRootIdentityHash === reviewerCapability?.credentialRootIdentityHash) {
    blockers.push('golden_micro_campaign_provider_credential_root_independence_not_verified');
  }
  /* Keep this explicit shape guard so partially upgraded capability receipts
     cannot accidentally be interpreted as native account attestations. */
  if ((authorCapability?.providerAccountIdentityAttested === true
      || reviewerCapability?.providerAccountIdentityAttested === true)
    && (authorCapability?.providerAccountIdentityAttested !== true
    || reviewerCapability?.providerAccountIdentityAttested !== true
    || !capabilityAccountIndependenceVerified)) {
    blockers.push('golden_micro_campaign_provider_account_identity_capability_incomplete');
  }
  if (!schemaValid(receipt?.campaignStoreSchemaReceipt, campaignStoreSchemaReceipt)) {
    blockers.push('golden_micro_campaign_store_schema_mismatch');
  }
  if (!runtimeImagesValid(receipt?.runtimeImageDigests, runtimeImageDigests)) {
    blockers.push('golden_micro_campaign_runtime_image_digests_mismatch');
  }
  if (!runtimeImageReproducibilityBindingValid(
    receipt,
    runtimeImageReproducibilityInspection,
  )) {
    blockers.push('golden_micro_campaign_runtime_image_reproducibility_binding_invalid');
  }
  const receiptAuthorCanary = receipt?.researchAuthorProviderCanaryReceipt || null;
  const receiptReviewerCanary = receipt?.formalReviewerProviderCanaryReceipt || null;
  const currentAuthorCanaryFreshAtMs =
    researchAuthorProviderCanaryReceipt?.codexModelAvailabilityCanaryReceiptHash
      === receiptAuthorCanary?.codexModelAvailabilityCanaryReceiptHash
      ? issuedAt : nowMs;
  const currentReviewerCanaryFreshAtMs =
    formalReviewerProviderCanaryReceipt?.codexModelAvailabilityCanaryReceiptHash
      === receiptReviewerCanary?.codexModelAvailabilityCanaryReceiptHash
      ? issuedAt : nowMs;
  if (!canaryValid(receiptAuthorCanary, authorCapability, { freshAtMs: issuedAt })
    || !canaryValid(researchAuthorProviderCanaryReceipt, researchAuthorCapabilityReceipt, {
      freshAtMs: currentAuthorCanaryFreshAtMs,
    })) {
    blockers.push('golden_micro_campaign_research_author_provider_canary_invalid');
  }
  if (!canaryValid(receiptReviewerCanary, reviewerCapability, { freshAtMs: issuedAt })
    || !canaryValid(formalReviewerProviderCanaryReceipt, formalReviewerCapabilityReceipt, {
      freshAtMs: currentReviewerCanaryFreshAtMs,
    })) {
    blockers.push('golden_micro_campaign_formal_reviewer_provider_canary_invalid');
  }
  const signer = receipt?.signer || null;
  if (signer?.role !== FULL_RESEARCH_QUALIFICATION_ATTESTOR_ROLE
    || signer?.algorithm !== 'ed25519'
    || !releaseAttestorSignerTrustedAt(releaseAttestorInspection, signer, receipt?.issuedAt)) {
    blockers.push('golden_micro_campaign_release_attestor_identity_mismatch');
  }
  let authority = null;
  if (typeof resolveCampaignReleaseAuthority !== 'function') {
    blockers.push('golden_micro_campaign_release_authority_verifier_required');
  } else {
    try { authority = resolveCampaignReleaseAuthority({ campaignId: receipt?.campaignId }); }
    catch { authority = null; }
    if (!authority) blockers.push('golden_micro_campaign_release_authority_verification_failed');
  }
  const releaseScope = authority
    ? inspectAutonomousResearchReleaseQualificationScope({
      authority,
      receipt,
      allowBoundedGoldenCapability: requireGlobalGoldenAuthority,
    }) : null;
  if (!independentHypothesisPriorArtQualificationValid(
    receipt,
    authority?.releaseBundle?.autonomousResearchReleaseBinding || null,
    {
      allowBoundedGoldenCapability: requireGlobalGoldenAuthority,
      releaseScope,
    },
  )) {
    blockers.push('golden_micro_campaign_independent_hypothesis_prior_art_qualification_invalid');
  }
  const releaseInspection = authority ? inspectSuccessfulFullResearchRelease({
    authority,
    receipt,
    issuedAt,
    maximumReceiptAgeMs: FULL_RESEARCH_QUALIFICATION_MAXIMUM_AGE_MS,
    allowBoundedGoldenCapability: requireGlobalGoldenAuthority,
    runtimePrincipalBinding,
    reviewerEvidenceAuthority,
  }) : null;
  if (releaseInspection) blockers.push(...releaseInspection.blockers);
  const bundle = releaseInspection?.bundle || null;
  if (bundle && requireGlobalGoldenAuthority) {
    const releaseBinding = bundle.autonomousResearchReleaseBinding || null;
    if (!releaseBinding?.globalGoldenQualificationAuthorityHash
      || !releaseBinding?.globalGoldenQualificationAuthority
      || bundle.autonomousResearchReleaseBindingHash
        !== releaseBinding.autonomousResearchReleaseBindingHash
      || releaseBinding.launchMode !== 'golden-bootstrap') {
      blockers.push('golden_micro_campaign_global_golden_qualification_authority_required');
    }
  }
  const releaseAttestation = bundle?.researchExecutionReleaseAttestation || null;
  if (bundle && !releaseAttestorSignerTrustedAt(
    releaseAttestorInspection,
    releaseAttestation,
    releaseAttestation?.signedAt,
  )) {
    blockers.push('golden_micro_campaign_release_attestation_signer_mismatch');
  }
  const releaseAttestationValidFrom = Date.parse(String(releaseAttestation?.validFrom || ''));
  const releaseAttestationExpiresAt = Date.parse(String(releaseAttestation?.expiresAt || ''));
  if (bundle && (!Number.isFinite(releaseAttestationValidFrom)
    || !Number.isFinite(releaseAttestationExpiresAt)
    || !Number.isFinite(nowMs) || nowMs < releaseAttestationValidFrom
    || nowMs >= releaseAttestationExpiresAt)) {
    blockers.push('golden_micro_campaign_release_attestation_outside_time_window');
  }
  if (bundle && (typeof verifyReleaseAttestation !== 'function'
    || verifyReleaseAttestation({
      attestation: releaseAttestation,
      manifest: bundle.researchEvidenceCapsuleManifest,
      manifestFileHash: bundle?.packageOutput?.researchEvidenceCapsuleManifestFileHash,
    }) !== true)) {
    blockers.push('golden_micro_campaign_release_attestation_signature_invalid');
  }
  const signingPayloadHash = fullResearchQualificationSigningPayloadHash(receipt);
  if (!SHA256.test(String(signingPayloadHash || ''))
    || typeof receipt?.signature !== 'string' || !receipt.signature
    || typeof verifyQualificationSignature !== 'function'
    || verifyQualificationSignature({
      signingPayloadHash,
      signature: receipt.signature,
      signer,
      signedAt: receipt.issuedAt,
    }) !== true) {
    blockers.push('golden_micro_campaign_qualification_signature_invalid');
  }
  const uniqueBlockers = Object.freeze(unique(blockers));
  return Object.freeze({
    version: 1,
    kind: 'FullResearchQualificationVerification',
    status: uniqueBlockers.length
      ? 'full_research_qualification_blocked'
      : 'full_research_qualification_verified',
    ready: uniqueBlockers.length === 0,
    receiptAccepted: uniqueBlockers.length === 0,
    maximumReceiptAgeMs: FULL_RESEARCH_QUALIFICATION_MAXIMUM_AGE_MS,
    campaignId: uniqueBlockers.length ? null : receipt.campaignId,
    paperId: uniqueBlockers.length ? null : receipt.paperId,
    campaignReleaseBundleHash: uniqueBlockers.length ? null : receipt.campaignReleaseBundleHash,
    qualificationReceiptHash: uniqueBlockers.length ? null : receipt.fullResearchQualificationReceiptHash,
    qualificationScope: uniqueBlockers.length ? null : receipt.qualificationScope,
    genericContentCanaryVerified: uniqueBlockers.length
      ? false : bundle?.autonomousResearchReleaseBinding
        ?.genericContentCanaryVerified === true,
    ...Object.fromEntries(MANUSCRIPT_RELEASE_PROOF_FIELDS.map((field) => [
      field,
      uniqueBlockers.length ? null : receipt?.[field] || null,
    ])),
    issuedAt: uniqueBlockers.length ? null : receipt.issuedAt,
    expiresAt: uniqueBlockers.length ? null : receipt.expiresAt,
    remainingValidityMs: uniqueBlockers.length || !Number.isFinite(nowMs)
      ? null : expiresAt - nowMs,
    runtimeImageReproducibilityReceiptHash: uniqueBlockers.length
      ? null : receipt.runtimeImageReproducibilityReceiptHash,
    runtimeImageReproducibilityRequiredProfiles: uniqueBlockers.length
      ? null : receipt.runtimeImageReproducibilityRequiredProfiles,
    runtimeImageReproducibilityDefinitionManifestHashes: uniqueBlockers.length
      ? null : receipt.runtimeImageReproducibilityDefinitionManifestHashes,
    empiricalFamilyPluginPackageHash: uniqueBlockers.length
      ? null : receipt.empiricalFamilyPluginPackageHash,
    empiricalFamilyPluginRegistryHash: uniqueBlockers.length
      ? null : receipt.empiricalFamilyPluginRegistryHash,
    empiricalFamilyPluginStartupInspectionHash: uniqueBlockers.length
      ? null : receipt.empiricalFamilyPluginStartupInspectionHash,
    activeEmpiricalProductionProfileHashes: uniqueBlockers.length
      ? null : receipt.activeEmpiricalProductionProfileHashes,
    runtimeImageReproducibilityActivePluginScopeHash: uniqueBlockers.length
      ? null : receipt.runtimeImageReproducibilityActivePluginScopeHash,
    independentHypothesisPriorArtReviewVerified: uniqueBlockers.length === 0,
    independentHypothesisPriorArtReceiptHash: uniqueBlockers.length
      ? null : receipt.independentHypothesisPriorArtReceiptHash,
    structuredPriorArtEvidenceVerified: uniqueBlockers.length === 0
      && Boolean(receipt.priorArtEvidenceReceipt),
    blockers: uniqueBlockers,
  });
}
