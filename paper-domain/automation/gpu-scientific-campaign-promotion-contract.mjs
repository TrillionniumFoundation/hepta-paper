import { deepFreezeJsonValue } from '../../workflow-kernel/deep-freeze-json-value.mjs';
import { hasExactObjectKeys } from '../../workflow-kernel/exact-object-keys.mjs';
import { hashRecord } from '../../workflow-kernel/record-hash.mjs';
import {
  compileSignatures,
  compileTimeWindow,
  isGpuScientificCampaignDeviceSelector,
  processIdentityHashes,
  requiredHash,
  requiredId,
} from './gpu-scientific-campaign-promotion-contract-validation.mjs';

export {
  GPU_SCIENTIFIC_CAMPAIGN_AUTHORITY_MAXIMUM_LIFETIME_MS,
} from './gpu-scientific-campaign-promotion-contract-validation.mjs';

export const GPU_SCIENTIFIC_SAME_DEVICE_REPLAY_AUTHORITY_ROLE =
  'gpu_scientific_same_device_replay_authority';
export const GPU_SCIENTIFIC_PRODUCTION_QUALIFICATION_AUTHORITY_ROLE =
  'gpu_scientific_production_qualification_authority';
export const GPU_SCIENTIFIC_CAMPAIGN_RELEASE_AUTHORITY_BLOCKER =
  'gpu_scientific_release_manifest_authority_required';

const REQUEST_KEYS = Object.freeze([
  'artifactArchiveManifestHash', 'attemptId', 'campaignId', 'campaignPlanHash',
  'deepLearningTaskReceiptHash', 'executionPlanHash', 'gpuDeviceSelector',
  'gpuDeviceSelectorHash', 'gpuScientificCampaignAttemptAuthorityHash',
  'gpuScientificCampaignExecutionResultHash',
  'gpuScientificCampaignQualificationRequestHash', 'kind', 'leaseGeneration',
  'nodeId', 'originalExecutionProcessIdentityHashes', 'paperId',
  'pdeTaskReceiptHash', 'qualificationPolicyHash', 'runtimeImageDigest',
  'runtimePackageClosureHash', 'scientificOutputCommitmentHash', 'status',
  'taskSetHash', 'version',
]);
const REPLAY_KEYS = Object.freeze([
  'artifactArchiveManifestHash', 'campaignId', 'expiresAt',
  'externalActionPerformed', 'gpuDeviceSelectorHash',
  'gpuScientificCampaignExecutionResultHash',
  'gpuScientificCampaignQualificationRequestHash',
  'gpuScientificCampaignSameDeviceReplayReceiptHash', 'kind',
  'originalExecutionProcessIdentityHashes',
  'originalScientificOutputCommitmentHash', 'paperId',
  'replayDeepLearningTaskReceiptHash', 'replayedAt',
  'replayExecutionProcessIdentityHashes', 'replayPdeTaskReceiptHash',
  'replayScientificOutputCommitmentHash', 'runtimeImageDigest',
  'runtimePackageClosureHash', 'signatures', 'signedAt', 'status',
  'validFrom', 'version',
]);
const AUTHORITY_KEYS = Object.freeze([
  'approved', 'artifactArchiveManifestHash', 'campaignId', 'expiresAt',
  'externalActionPerformed', 'gpuScientificCampaignExecutionResultHash',
  'gpuScientificCampaignProductionQualificationAuthorityHash',
  'gpuScientificCampaignQualificationRequestHash',
  'gpuScientificCampaignSameDeviceReplayReceiptHash', 'kind', 'paperId',
  'productionQualified', 'promotionEligible', 'scientificOutputCommitmentHash',
  'signatures', 'signedAt', 'status', 'validFrom', 'version',
]);
const QUALIFICATION_EVIDENCE_KEYS = Object.freeze([
  'artifactArchiveManifestHash', 'blockers', 'campaignId',
  'externalActionPerformed', 'gpuScientificCampaignExecutionResultHash',
  'gpuScientificCampaignProductionQualificationAuthority',
  'gpuScientificCampaignProductionQualificationAuthorityHash',
  'gpuScientificCampaignQualificationEvidenceHash',
  'gpuScientificCampaignQualificationRequest',
  'gpuScientificCampaignQualificationRequestHash',
  'gpuScientificCampaignSameDeviceReplayReceipt',
  'gpuScientificCampaignSameDeviceReplayReceiptHash', 'kind', 'paperId',
  'preReleaseQualified', 'productionQualified', 'promotionEligible',
  'scientificOutputCommitmentHash', 'status', 'version',
]);
const PROMOTION_EVIDENCE_KEYS = Object.freeze([
  'artifactArchiveManifestHash', 'blockers', 'campaignId',
  'externalActionPerformed', 'gpuScientificCampaignExecutionResultHash',
  'gpuScientificCampaignProductionQualificationAuthorityHash',
  'gpuScientificCampaignPromotionEvidenceHash',
  'gpuScientificCampaignQualificationEvidence',
  'gpuScientificCampaignQualificationEvidenceHash',
  'gpuScientificCampaignQualificationRequestHash',
  'gpuScientificCampaignSameDeviceReplayReceiptHash', 'kind', 'paperId',
  'productionQualified', 'promotionEligible',
  'researchEvidenceCapsuleManifestFileHash',
  'researchEvidenceCapsuleManifestHash',
  'researchExecutionReleaseAttestationHash',
  'scientificOutputCommitmentHash', 'status', 'version',
]);

const GPU_SCIENTIFIC_QUALIFICATION_POLICY_PAYLOAD = Object.freeze({
  version: 1,
  kind: 'GpuScientificCampaignQualificationPolicy',
  exactGpuDeviceSelectorRequired: true,
  exactRuntimeImageRequired: true,
  exactRuntimePackageClosureRequired: true,
  exactScientificOutputCommitmentRequired: true,
  independentExecutionProcessRequired: true,
  externalReplayAuthorityRequired: true,
  externalProductionQualificationAuthorityRequired: true,
  signedReleaseManifestAuthorityRequiredForPromotion: true,
  rawExecutionResultMaySelfPromote: false,
});

export const GPU_SCIENTIFIC_CAMPAIGN_QUALIFICATION_POLICY = Object.freeze({
  ...GPU_SCIENTIFIC_QUALIFICATION_POLICY_PAYLOAD,
  gpuScientificCampaignQualificationPolicyHash: hashRecord(
    'GpuScientificCampaignQualificationPolicy',
    GPU_SCIENTIFIC_QUALIFICATION_POLICY_PAYLOAD,
  ),
});

function frozenClone(value, code) {
  try {
    return deepFreezeJsonValue(structuredClone(value));
  } catch {
    throw new Error(code);
  }
}

function envelopeMatches(left, right, kind) {
  return hashRecord(`${kind}Envelope`, left)
    === hashRecord(`${kind}Envelope`, right);
}

function expectedFieldsMatch(value, expected, fields) {
  return fields.every((field) => (
    expected[field] === undefined || value?.[field] === expected[field]
  ));
}

export function gpuScientificCampaignDeviceSelectorHash(gpuDeviceSelector) {
  if (!isGpuScientificCampaignDeviceSelector(gpuDeviceSelector)) {
    throw new Error('gpu_scientific_campaign_qualification_gpu_selector_invalid');
  }
  return hashRecord('GpuScientificCampaignGpuDeviceSelector', {
    gpuDeviceSelector,
  });
}

export function buildGpuScientificCampaignQualificationRequest({
  campaignId,
  paperId,
  campaignPlanHash,
  nodeId,
  attemptId,
  leaseGeneration,
  executionPlanHash,
  taskSetHash,
  gpuDeviceSelector,
  gpuScientificCampaignAttemptAuthorityHash,
  gpuScientificCampaignExecutionResultHash,
  artifactArchiveManifestHash,
  scientificOutputCommitmentHash,
  pdeTaskReceiptHash,
  deepLearningTaskReceiptHash,
  runtimeImageDigest,
  runtimePackageClosureHash,
  originalExecutionProcessIdentityHashes,
} = {}) {
  const selectedLease = Number(leaseGeneration);
  if (!Number.isSafeInteger(selectedLease) || selectedLease < 1
    || !isGpuScientificCampaignDeviceSelector(gpuDeviceSelector)) {
    throw new Error('gpu_scientific_campaign_qualification_request_invalid');
  }
  const payload = {
    version: 1,
    kind: 'GpuScientificCampaignQualificationRequest',
    status: 'gpu_scientific_campaign_qualification_requested',
    campaignId: requiredId(
      campaignId,
      'gpu_scientific_campaign_qualification_request_invalid',
    ),
    paperId: requiredId(
      paperId,
      'gpu_scientific_campaign_qualification_request_invalid',
    ),
    campaignPlanHash: requiredHash(
      campaignPlanHash,
      'gpu_scientific_campaign_qualification_request_invalid',
    ),
    nodeId: requiredId(
      nodeId,
      'gpu_scientific_campaign_qualification_request_invalid',
    ),
    attemptId: requiredId(
      attemptId,
      'gpu_scientific_campaign_qualification_request_invalid',
    ),
    leaseGeneration: selectedLease,
    executionPlanHash: requiredHash(
      executionPlanHash,
      'gpu_scientific_campaign_qualification_request_invalid',
    ),
    taskSetHash: requiredHash(
      taskSetHash,
      'gpu_scientific_campaign_qualification_request_invalid',
    ),
    gpuDeviceSelector,
    gpuDeviceSelectorHash:
      gpuScientificCampaignDeviceSelectorHash(gpuDeviceSelector),
    gpuScientificCampaignAttemptAuthorityHash: requiredHash(
      gpuScientificCampaignAttemptAuthorityHash,
      'gpu_scientific_campaign_qualification_request_invalid',
    ),
    gpuScientificCampaignExecutionResultHash: requiredHash(
      gpuScientificCampaignExecutionResultHash,
      'gpu_scientific_campaign_qualification_request_invalid',
    ),
    artifactArchiveManifestHash: requiredHash(
      artifactArchiveManifestHash,
      'gpu_scientific_campaign_qualification_request_invalid',
    ),
    scientificOutputCommitmentHash: requiredHash(
      scientificOutputCommitmentHash,
      'gpu_scientific_campaign_qualification_request_invalid',
    ),
    pdeTaskReceiptHash: requiredHash(
      pdeTaskReceiptHash,
      'gpu_scientific_campaign_qualification_request_invalid',
    ),
    deepLearningTaskReceiptHash: requiredHash(
      deepLearningTaskReceiptHash,
      'gpu_scientific_campaign_qualification_request_invalid',
    ),
    runtimeImageDigest: requiredHash(
      runtimeImageDigest,
      'gpu_scientific_campaign_qualification_request_invalid',
    ),
    runtimePackageClosureHash: requiredHash(
      runtimePackageClosureHash,
      'gpu_scientific_campaign_qualification_request_invalid',
    ),
    originalExecutionProcessIdentityHashes: processIdentityHashes(
      originalExecutionProcessIdentityHashes,
      'gpu_scientific_campaign_qualification_request_invalid',
    ),
    qualificationPolicyHash:
      GPU_SCIENTIFIC_CAMPAIGN_QUALIFICATION_POLICY
        .gpuScientificCampaignQualificationPolicyHash,
  };
  return deepFreezeJsonValue({
    ...payload,
    gpuScientificCampaignQualificationRequestHash: hashRecord(
      'GpuScientificCampaignQualificationRequest',
      payload,
    ),
  });
}

export function verifyGpuScientificCampaignQualificationRequest(
  value,
  expected = {},
) {
  if (!hasExactObjectKeys(value, REQUEST_KEYS)
    || value?.version !== 1
    || value?.kind !== 'GpuScientificCampaignQualificationRequest'
    || value?.status !== 'gpu_scientific_campaign_qualification_requested') {
    return false;
  }
  try {
    const rebuilt = buildGpuScientificCampaignQualificationRequest(value);
    return envelopeMatches(
      rebuilt,
      value,
      'GpuScientificCampaignQualificationRequest',
    ) && expectedFieldsMatch(value, expected, [
      'campaignId', 'paperId', 'campaignPlanHash', 'nodeId', 'attemptId',
      'leaseGeneration', 'executionPlanHash',
      'gpuScientificCampaignExecutionResultHash',
      'artifactArchiveManifestHash', 'scientificOutputCommitmentHash',
    ]);
  } catch {
    return false;
  }
}

export function buildGpuScientificCampaignSameDeviceReplayReceipt({
  request,
  replayPdeTaskReceiptHash,
  replayDeepLearningTaskReceiptHash,
  replayExecutionProcessIdentityHashes,
  replayScientificOutputCommitmentHash,
  replayedAt,
  signedAt,
  validFrom = signedAt,
  expiresAt,
  signatures = [],
} = {}) {
  if (!verifyGpuScientificCampaignQualificationRequest(request)) {
    throw new Error('gpu_scientific_campaign_same_device_replay_request_invalid');
  }
  const replayProcesses = processIdentityHashes(
    replayExecutionProcessIdentityHashes,
    'gpu_scientific_campaign_same_device_replay_process_identity_invalid',
  );
  const originalProcesses = request.originalExecutionProcessIdentityHashes;
  if (Object.values(replayProcesses).some((hash) => (
    Object.values(originalProcesses).includes(hash)
  )) || requiredHash(
    replayScientificOutputCommitmentHash,
    'gpu_scientific_campaign_same_device_replay_output_invalid',
  ) !== request.scientificOutputCommitmentHash) {
    throw new Error('gpu_scientific_campaign_same_device_replay_binding_invalid');
  }
  const time = compileTimeWindow({
    signedAt,
    validFrom,
    expiresAt,
    observedAt: replayedAt,
  });
  const payload = {
    version: 1,
    kind: 'GpuScientificCampaignSameDeviceReplayReceipt',
    status: 'gpu_scientific_campaign_same_device_replay_verified',
    campaignId: request.campaignId,
    paperId: request.paperId,
    gpuScientificCampaignQualificationRequestHash:
      request.gpuScientificCampaignQualificationRequestHash,
    gpuScientificCampaignExecutionResultHash:
      request.gpuScientificCampaignExecutionResultHash,
    artifactArchiveManifestHash: request.artifactArchiveManifestHash,
    gpuDeviceSelectorHash: request.gpuDeviceSelectorHash,
    runtimeImageDigest: request.runtimeImageDigest,
    runtimePackageClosureHash: request.runtimePackageClosureHash,
    originalScientificOutputCommitmentHash:
      request.scientificOutputCommitmentHash,
    replayScientificOutputCommitmentHash:
      request.scientificOutputCommitmentHash,
    originalExecutionProcessIdentityHashes:
      request.originalExecutionProcessIdentityHashes,
    replayExecutionProcessIdentityHashes: replayProcesses,
    replayPdeTaskReceiptHash: requiredHash(
      replayPdeTaskReceiptHash,
      'gpu_scientific_campaign_same_device_replay_receipt_invalid',
    ),
    replayDeepLearningTaskReceiptHash: requiredHash(
      replayDeepLearningTaskReceiptHash,
      'gpu_scientific_campaign_same_device_replay_receipt_invalid',
    ),
    replayedAt: new Date(replayedAt).toISOString(),
    ...time,
    externalActionPerformed: true,
  };
  return deepFreezeJsonValue({
    ...payload,
    gpuScientificCampaignSameDeviceReplayReceiptHash: hashRecord(
      'GpuScientificCampaignSameDeviceReplayReceipt',
      payload,
    ),
    signatures: compileSignatures(
      signatures,
      GPU_SCIENTIFIC_SAME_DEVICE_REPLAY_AUTHORITY_ROLE,
    ),
  });
}

export function verifyGpuScientificCampaignSameDeviceReplayReceipt(
  value,
  { request } = {},
) {
  if (!hasExactObjectKeys(value, REPLAY_KEYS)
    || value?.version !== 1
    || value?.kind !== 'GpuScientificCampaignSameDeviceReplayReceipt'
    || value?.status !== 'gpu_scientific_campaign_same_device_replay_verified'
    || value?.externalActionPerformed !== true
    || value?.signatures?.length !== 1) return false;
  try {
    const rebuilt = buildGpuScientificCampaignSameDeviceReplayReceipt({
      request,
      replayPdeTaskReceiptHash: value.replayPdeTaskReceiptHash,
      replayDeepLearningTaskReceiptHash:
        value.replayDeepLearningTaskReceiptHash,
      replayExecutionProcessIdentityHashes:
        value.replayExecutionProcessIdentityHashes,
      replayScientificOutputCommitmentHash:
        value.replayScientificOutputCommitmentHash,
      replayedAt: value.replayedAt,
      signedAt: value.signedAt,
      validFrom: value.validFrom,
      expiresAt: value.expiresAt,
      signatures: value.signatures,
    });
    return envelopeMatches(
      rebuilt,
      value,
      'GpuScientificCampaignSameDeviceReplayReceipt',
    );
  } catch {
    return false;
  }
}

export function buildGpuScientificCampaignProductionQualificationAuthority({
  request,
  sameDeviceReplayReceipt,
  approved = true,
  signedAt,
  validFrom = signedAt,
  expiresAt,
  signatures = [],
} = {}) {
  if (!verifyGpuScientificCampaignSameDeviceReplayReceipt(
    sameDeviceReplayReceipt,
    { request },
  ) || approved !== true) {
    throw new Error(
      'gpu_scientific_campaign_production_qualification_evidence_invalid',
    );
  }
  const time = compileTimeWindow({ signedAt, validFrom, expiresAt });
  if (Date.parse(signedAt) < Date.parse(sameDeviceReplayReceipt.signedAt)
    || Date.parse(expiresAt) > Date.parse(sameDeviceReplayReceipt.expiresAt)) {
    throw new Error(
      'gpu_scientific_campaign_production_qualification_time_binding_invalid',
    );
  }
  const payload = {
    version: 1,
    kind: 'GpuScientificCampaignProductionQualificationAuthority',
    status: 'gpu_scientific_campaign_production_qualified_pre_release',
    campaignId: request.campaignId,
    paperId: request.paperId,
    gpuScientificCampaignQualificationRequestHash:
      request.gpuScientificCampaignQualificationRequestHash,
    gpuScientificCampaignExecutionResultHash:
      request.gpuScientificCampaignExecutionResultHash,
    artifactArchiveManifestHash: request.artifactArchiveManifestHash,
    scientificOutputCommitmentHash: request.scientificOutputCommitmentHash,
    gpuScientificCampaignSameDeviceReplayReceiptHash:
      sameDeviceReplayReceipt
        .gpuScientificCampaignSameDeviceReplayReceiptHash,
    approved: true,
    productionQualified: true,
    promotionEligible: false,
    ...time,
    externalActionPerformed: true,
  };
  return deepFreezeJsonValue({
    ...payload,
    gpuScientificCampaignProductionQualificationAuthorityHash: hashRecord(
      'GpuScientificCampaignProductionQualificationAuthority',
      payload,
    ),
    signatures: compileSignatures(
      signatures,
      GPU_SCIENTIFIC_PRODUCTION_QUALIFICATION_AUTHORITY_ROLE,
    ),
  });
}

export function verifyGpuScientificCampaignProductionQualificationAuthority(
  value,
  { request, sameDeviceReplayReceipt } = {},
) {
  if (!hasExactObjectKeys(value, AUTHORITY_KEYS)
    || value?.version !== 1
    || value?.kind !== 'GpuScientificCampaignProductionQualificationAuthority'
    || value?.status !== 'gpu_scientific_campaign_production_qualified_pre_release'
    || value?.approved !== true
    || value?.productionQualified !== true
    || value?.promotionEligible !== false
    || value?.externalActionPerformed !== true
    || value?.signatures?.length !== 1) return false;
  try {
    const rebuilt = buildGpuScientificCampaignProductionQualificationAuthority({
      request,
      sameDeviceReplayReceipt,
      approved: value.approved,
      signedAt: value.signedAt,
      validFrom: value.validFrom,
      expiresAt: value.expiresAt,
      signatures: value.signatures,
    });
    return envelopeMatches(
      rebuilt,
      value,
      'GpuScientificCampaignProductionQualificationAuthority',
    );
  } catch {
    return false;
  }
}

export function buildGpuScientificCampaignQualificationEvidence({
  request,
  sameDeviceReplayReceipt,
  productionQualificationAuthority,
} = {}) {
  if (!verifyGpuScientificCampaignProductionQualificationAuthority(
    productionQualificationAuthority,
    { request, sameDeviceReplayReceipt },
  )) {
    throw new Error('gpu_scientific_campaign_qualification_evidence_invalid');
  }
  const canonicalRequest = frozenClone(
    request,
    'gpu_scientific_campaign_qualification_evidence_invalid',
  );
  const canonicalReplay = frozenClone(
    sameDeviceReplayReceipt,
    'gpu_scientific_campaign_qualification_evidence_invalid',
  );
  const canonicalAuthority = frozenClone(
    productionQualificationAuthority,
    'gpu_scientific_campaign_qualification_evidence_invalid',
  );
  const payload = {
    version: 1,
    kind: 'GpuScientificCampaignQualificationEvidence',
    status: 'gpu_scientific_campaign_pre_release_qualified',
    campaignId: request.campaignId,
    paperId: request.paperId,
    gpuScientificCampaignExecutionResultHash:
      request.gpuScientificCampaignExecutionResultHash,
    artifactArchiveManifestHash: request.artifactArchiveManifestHash,
    scientificOutputCommitmentHash: request.scientificOutputCommitmentHash,
    gpuScientificCampaignQualificationRequestHash:
      request.gpuScientificCampaignQualificationRequestHash,
    gpuScientificCampaignQualificationRequest: canonicalRequest,
    gpuScientificCampaignSameDeviceReplayReceiptHash:
      sameDeviceReplayReceipt
        .gpuScientificCampaignSameDeviceReplayReceiptHash,
    gpuScientificCampaignSameDeviceReplayReceipt: canonicalReplay,
    gpuScientificCampaignProductionQualificationAuthorityHash:
      productionQualificationAuthority
        .gpuScientificCampaignProductionQualificationAuthorityHash,
    gpuScientificCampaignProductionQualificationAuthority: canonicalAuthority,
    preReleaseQualified: true,
    productionQualified: true,
    promotionEligible: false,
    blockers: Object.freeze([
      GPU_SCIENTIFIC_CAMPAIGN_RELEASE_AUTHORITY_BLOCKER,
    ]),
    externalActionPerformed: true,
  };
  return deepFreezeJsonValue({
    ...payload,
    gpuScientificCampaignQualificationEvidenceHash: hashRecord(
      'GpuScientificCampaignQualificationEvidence',
      payload,
    ),
  });
}

export function verifyGpuScientificCampaignQualificationEvidence(
  value,
  expected = {},
) {
  if (!hasExactObjectKeys(value, QUALIFICATION_EVIDENCE_KEYS)
    || value?.version !== 1
    || value?.kind !== 'GpuScientificCampaignQualificationEvidence'
    || value?.status !== 'gpu_scientific_campaign_pre_release_qualified'
    || value?.preReleaseQualified !== true
    || value?.productionQualified !== true
    || value?.promotionEligible !== false
    || value?.externalActionPerformed !== true
    || JSON.stringify(value?.blockers) !== JSON.stringify([
      GPU_SCIENTIFIC_CAMPAIGN_RELEASE_AUTHORITY_BLOCKER,
    ])) return false;
  try {
    const rebuilt = buildGpuScientificCampaignQualificationEvidence({
      request: value.gpuScientificCampaignQualificationRequest,
      sameDeviceReplayReceipt:
        value.gpuScientificCampaignSameDeviceReplayReceipt,
      productionQualificationAuthority:
        value.gpuScientificCampaignProductionQualificationAuthority,
    });
    return envelopeMatches(
      rebuilt,
      value,
      'GpuScientificCampaignQualificationEvidence',
    ) && expectedFieldsMatch(value, expected, [
      'campaignId', 'paperId', 'gpuScientificCampaignExecutionResultHash',
      'artifactArchiveManifestHash', 'scientificOutputCommitmentHash',
    ]);
  } catch {
    return false;
  }
}

export function buildGpuScientificCampaignPromotionEvidence({
  qualificationEvidence,
  researchEvidenceCapsuleManifestHash,
  researchEvidenceCapsuleManifestFileHash,
  researchExecutionReleaseAttestationHash,
} = {}) {
  if (!verifyGpuScientificCampaignQualificationEvidence(
    qualificationEvidence,
  )) {
    throw new Error('gpu_scientific_campaign_promotion_evidence_invalid');
  }
  const canonicalQualification = frozenClone(
    qualificationEvidence,
    'gpu_scientific_campaign_promotion_evidence_invalid',
  );
  const payload = {
    version: 1,
    kind: 'GpuScientificCampaignPromotionEvidence',
    status: 'gpu_scientific_campaign_promotion_qualified',
    campaignId: qualificationEvidence.campaignId,
    paperId: qualificationEvidence.paperId,
    gpuScientificCampaignExecutionResultHash:
      qualificationEvidence.gpuScientificCampaignExecutionResultHash,
    artifactArchiveManifestHash:
      qualificationEvidence.artifactArchiveManifestHash,
    scientificOutputCommitmentHash:
      qualificationEvidence.scientificOutputCommitmentHash,
    gpuScientificCampaignQualificationRequestHash:
      qualificationEvidence.gpuScientificCampaignQualificationRequestHash,
    gpuScientificCampaignSameDeviceReplayReceiptHash:
      qualificationEvidence.gpuScientificCampaignSameDeviceReplayReceiptHash,
    gpuScientificCampaignProductionQualificationAuthorityHash:
      qualificationEvidence
        .gpuScientificCampaignProductionQualificationAuthorityHash,
    gpuScientificCampaignQualificationEvidenceHash:
      qualificationEvidence.gpuScientificCampaignQualificationEvidenceHash,
    gpuScientificCampaignQualificationEvidence: canonicalQualification,
    researchEvidenceCapsuleManifestHash: requiredHash(
      researchEvidenceCapsuleManifestHash,
      'gpu_scientific_campaign_promotion_release_binding_invalid',
    ),
    researchEvidenceCapsuleManifestFileHash: requiredHash(
      researchEvidenceCapsuleManifestFileHash,
      'gpu_scientific_campaign_promotion_release_binding_invalid',
    ),
    researchExecutionReleaseAttestationHash: requiredHash(
      researchExecutionReleaseAttestationHash,
      'gpu_scientific_campaign_promotion_release_binding_invalid',
    ),
    productionQualified: true,
    promotionEligible: true,
    blockers: Object.freeze([]),
    externalActionPerformed: true,
  };
  return deepFreezeJsonValue({
    ...payload,
    gpuScientificCampaignPromotionEvidenceHash: hashRecord(
      'GpuScientificCampaignPromotionEvidence',
      payload,
    ),
  });
}

export function verifyGpuScientificCampaignPromotionEvidence(
  value,
  expected = {},
) {
  if (!hasExactObjectKeys(value, PROMOTION_EVIDENCE_KEYS)
    || value?.version !== 1
    || value?.kind !== 'GpuScientificCampaignPromotionEvidence'
    || value?.status !== 'gpu_scientific_campaign_promotion_qualified'
    || value?.productionQualified !== true
    || value?.promotionEligible !== true
    || value?.externalActionPerformed !== true
    || !Array.isArray(value?.blockers) || value.blockers.length !== 0) {
    return false;
  }
  try {
    const rebuilt = buildGpuScientificCampaignPromotionEvidence({
      qualificationEvidence:
        value.gpuScientificCampaignQualificationEvidence,
      researchEvidenceCapsuleManifestHash:
        value.researchEvidenceCapsuleManifestHash,
      researchEvidenceCapsuleManifestFileHash:
        value.researchEvidenceCapsuleManifestFileHash,
      researchExecutionReleaseAttestationHash:
        value.researchExecutionReleaseAttestationHash,
    });
    return envelopeMatches(
      rebuilt,
      value,
      'GpuScientificCampaignPromotionEvidence',
    ) && expectedFieldsMatch(value, expected, [
      'campaignId', 'paperId', 'gpuScientificCampaignExecutionResultHash',
      'artifactArchiveManifestHash', 'scientificOutputCommitmentHash',
      'researchEvidenceCapsuleManifestHash',
      'researchEvidenceCapsuleManifestFileHash',
      'researchExecutionReleaseAttestationHash',
    ]);
  } catch {
    return false;
  }
}
