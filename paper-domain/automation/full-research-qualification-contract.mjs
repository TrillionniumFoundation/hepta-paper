import { hashRecord } from '../../workflow-kernel/record-hash.mjs';
import {
  MANUSCRIPT_RELEASE_PROOF_FIELDS,
  inspectAutonomousResearchReleaseQualificationScope,
  inspectSuccessfulFullResearchRelease,
} from './full-research-release-qualification-inspection.mjs';
import {
  CODEX_MODEL_AVAILABILITY_CANARY_MAXIMUM_AGE_MS,
  FULL_RESEARCH_QUALIFICATION_ATTESTOR_ROLE,
  FULL_RESEARCH_QUALIFICATION_MAXIMUM_AGE_MS,
  independentHypothesisPriorArtQualificationValid,
  providerPrincipalIndependenceAttestationSigningPayloadHash,
  providerPrincipalIndependenceVerified,
  qualificationCanaryValid,
  qualificationCapabilityValid,
  qualificationCodeIdentityValid,
  qualificationRuntimeImageBindingShapeValid,
  qualificationRuntimeImageBindingValid,
  qualificationRuntimeImagesValid,
  qualificationSchemaValid,
  releaseAttestorSignerTrustedAt,
  uniqueQualificationBlockers,
  withoutQualificationEnvelope,
  withoutQualificationReceiptHash,
} from './full-research-qualification-validation.mjs';

const SHA256 = /^sha256:[0-9a-f]{64}$/i;

export {
  CODEX_MODEL_AVAILABILITY_CANARY_MAXIMUM_AGE_MS,
  FULL_RESEARCH_QUALIFICATION_ATTESTOR_ROLE,
  FULL_RESEARCH_QUALIFICATION_MAXIMUM_AGE_MS,
  providerPrincipalIndependenceAttestationSigningPayloadHash,
};

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
  if (!qualificationRuntimeImageBindingShapeValid(receipt)) {
    blockers.push('external_qualification_runtime_image_reproducibility_binding_invalid');
  }
  const receiptPayload = withoutQualificationReceiptHash(receipt);
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
  const uniqueBlockers = Object.freeze(uniqueQualificationBlockers(blockers));
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
  const receiptPayload = withoutQualificationReceiptHash(receipt);
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
  if (!qualificationCodeIdentityValid(receipt?.codeProvenance, codeProvenance)) {
    blockers.push('golden_micro_campaign_code_worktree_identity_mismatch');
  }
  const authorCapability = receipt?.researchAuthorCapabilityReceipt;
  const reviewerCapability = receipt?.formalReviewerCapabilityReceipt;
  if (!qualificationCapabilityValid(authorCapability, 'CodexResearchAuthorCapabilityReceipt',
    'codex_research_author_capability_ready', 'codexResearchAuthorCapabilityReceiptHash')
    || authorCapability?.codexResearchAuthorCapabilityReceiptHash
      !== researchAuthorCapabilityReceipt?.codexResearchAuthorCapabilityReceiptHash) {
    blockers.push('golden_micro_campaign_research_author_configuration_mismatch');
  }
  if (!qualificationCapabilityValid(reviewerCapability, 'CodexFormalReviewerCapabilityReceipt',
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
  if (!qualificationSchemaValid(
    receipt?.campaignStoreSchemaReceipt,
    campaignStoreSchemaReceipt,
  )) {
    blockers.push('golden_micro_campaign_store_schema_mismatch');
  }
  if (!qualificationRuntimeImagesValid(
    receipt?.runtimeImageDigests,
    runtimeImageDigests,
  )) {
    blockers.push('golden_micro_campaign_runtime_image_digests_mismatch');
  }
  if (!qualificationRuntimeImageBindingValid(
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
  if (!qualificationCanaryValid(
    receiptAuthorCanary,
    authorCapability,
    { freshAtMs: issuedAt },
  )
    || !qualificationCanaryValid(
      researchAuthorProviderCanaryReceipt,
      researchAuthorCapabilityReceipt,
      {
      freshAtMs: currentAuthorCanaryFreshAtMs,
      },
    )) {
    blockers.push('golden_micro_campaign_research_author_provider_canary_invalid');
  }
  if (!qualificationCanaryValid(
    receiptReviewerCanary,
    reviewerCapability,
    { freshAtMs: issuedAt },
  )
    || !qualificationCanaryValid(
      formalReviewerProviderCanaryReceipt,
      formalReviewerCapabilityReceipt,
      {
      freshAtMs: currentReviewerCanaryFreshAtMs,
      },
    )) {
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
  const uniqueBlockers = Object.freeze(uniqueQualificationBlockers(blockers));
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
