import path from 'node:path';
import { verifyPaperRecordHash } from '../../paper-domain/contracts/primitives.mjs';
import {
  verifySubmissionHandoffExportRequest,
} from '../../paper-domain/submission/submission-handoff-export-request.mjs';
import { hashBytes, hashRecord } from '../../workflow-kernel/record-hash.mjs';
import {
  readScopedFileSync,
} from '../../workflow-kernel/runtime/scoped-file-identity.mjs';

const SHA256 = /^sha256:[0-9a-f]{64}$/u;
const DESCRIPTOR_KEYS = Object.freeze([
  'bytes',
  'contentHash',
  'kind',
  'path',
  'recordHash',
  'recordHashField',
  'role',
]);
const RECORD_SPECS = Object.freeze({
  artifact_package: Object.freeze({
    kind: 'PaperArtifactPackage',
    hashField: 'artifactPackageHash',
    paperRecord: true,
    excludedFields: Object.freeze([
      'semanticIdentityHash',
      'semanticIdentityVersion',
    ]),
  }),
  campaign_release_bundle: Object.freeze({
    kind: 'CampaignReleaseBundle',
    hashField: 'campaignReleaseBundleHash',
    status: 'campaign_release_bundle_prepared',
  }),
  campaign_release_integration_receipt: Object.freeze({
    kind: 'WorkspaceAttemptIntegrationReceipt',
    hashField: 'workspaceAttemptIntegrationReceiptHash',
    status: 'workspace_attempt_integrated',
  }),
  campaign_release_materialization_receipt: Object.freeze({
    kind: 'CampaignReleaseBundleMaterializationReceipt',
    hashField: 'campaignReleaseBundleMaterializationReceiptHash',
    status: 'campaign_release_bundle_materialized',
  }),
  campaign_release_package_result: Object.freeze({
    kind: 'CampaignReleasePackageResult',
    hashField: 'campaignReleasePackageResultHash',
    status: 'campaign_release_prepared',
    excludedFields: Object.freeze(['workspaceAttemptIntegration']),
  }),
  campaign_release_promotion_receipt: Object.freeze({
    kind: 'CampaignReleasePromotionReceipt',
    hashField: 'campaignReleasePromotionReceiptHash',
    status: 'campaign_release_current_completed',
  }),
  campaign_release_verification_receipt: Object.freeze({
    kind: 'SubmissionCampaignReleaseVerificationReceipt',
    hashField: 'submissionCampaignReleaseVerificationReceiptHash',
    status: 'submission_campaign_release_verified',
  }),
  package_verification_receipt: Object.freeze({
    kind: 'PackageVerificationReceipt',
    hashField: 'packageVerificationReceiptHash',
    status: 'package_verification_passed',
  }),
  persisted_submission_handoff_export_authority: Object.freeze({
    kind: 'PersistedSubmissionHandoffExportAuthority',
    hashField: 'submissionHandoffExportAuthorityHash',
    status: 'submission_handoff_export_authority_ready',
  }),
  submission_handoff_export_request: Object.freeze({
    kind: 'SubmissionHandoffExportRequest',
    hashField: 'submissionHandoffExportRequestHash',
  }),
  submission_handoff_export_request_verification_receipt: Object.freeze({
    kind: 'SubmissionHandoffExportRequestVerificationReceipt',
    hashField: 'submissionHandoffExportRequestVerificationReceiptHash',
    status: 'submission_handoff_export_request_verified',
  }),
});
const REQUIRED_RECORD_ROLES = Object.freeze([
  'artifact_package',
  'campaign_release_bundle',
  'package_verification_receipt',
  'persisted_submission_handoff_export_authority',
  'submission_handoff_export_request',
  'submission_handoff_export_request_verification_receipt',
]);

function hasExactKeys(value, expected) {
  return value && typeof value === 'object'
    && Object.keys(value).sort().join('\0') === [...expected].sort().join('\0');
}

function portableRelativePath(value) {
  const relative = String(value || '').replace(/\\/gu, '/');
  if (!relative || relative.startsWith('/')
    || relative.split('/').some(
      (part) => !part || part === '.' || part === '..',
    )) {
    throw new Error('handoff_bundle_detached_record_path_invalid');
  }
  return relative;
}

function recordPayload(record, spec) {
  const payload = { ...(record || {}) };
  delete payload[spec.hashField];
  for (const field of spec.excludedFields || []) delete payload[field];
  return payload;
}

export function assertSubmissionHandoffDetachedRecord(role, record) {
  const spec = RECORD_SPECS[role];
  if (!spec) throw new Error(`handoff_bundle_detached_record_role_unknown:${role}`);
  if (!record || typeof record !== 'object' || Array.isArray(record)
    || record.kind !== spec.kind
    || (spec.status && record.status !== spec.status)
    || !SHA256.test(String(record[spec.hashField] || ''))) {
    throw new Error(`handoff_bundle_detached_record_contract_invalid:${role}`);
  }
  const payload = recordPayload(record, spec);
  const validHash = spec.paperRecord
    ? verifyPaperRecordHash({
      kind: spec.kind,
      payload,
      recordHash: record[spec.hashField],
    }).valid
    : hashRecord(spec.kind, payload) === record[spec.hashField];
  if (!validHash) {
    throw new Error(`handoff_bundle_detached_record_hash_invalid:${role}`);
  }
  if (role === 'artifact_package' && record.submitReady !== true) {
    throw new Error('handoff_bundle_detached_artifact_package_not_ready');
  }
  if (role === 'persisted_submission_handoff_export_authority'
    && (record.readOnly !== true || record.externalActionPerformed !== false)) {
    throw new Error('handoff_bundle_detached_authority_safety_invalid');
  }
  return spec;
}

function canonicalRecordBytes(record) {
  return Buffer.from(`${JSON.stringify(record, null, 2)}\n`, 'utf8');
}

export function hashSubmissionHandoffDetachedRecordSet(descriptors) {
  return hashRecord('SubmissionHandoffDetachedRecordSet', descriptors);
}

function recordDocument(role, sourceRecord) {
  const record = JSON.parse(JSON.stringify(sourceRecord));
  const spec = assertSubmissionHandoffDetachedRecord(role, record);
  const bytes = canonicalRecordBytes(record);
  const relative = `records/${role}.json`;
  const descriptor = Object.freeze({
    role,
    kind: spec.kind,
    path: relative,
    recordHashField: spec.hashField,
    recordHash: record[spec.hashField],
    contentHash: hashBytes(bytes),
    bytes: bytes.length,
  });
  return Object.freeze({
    role,
    path: relative,
    record: Object.freeze(record),
    bytes,
    descriptor,
  });
}

function sameRecord(left, right) {
  return hashRecord('SubmissionHandoffDetachedBoundValue', left)
    === hashRecord('SubmissionHandoffDetachedBoundValue', right);
}

function inspectReleaseReceiptBindings(records, releaseBundle) {
  const blockers = [];
  const promotion = records.get('campaign_release_promotion_receipt');
  const materialization = records.get(
    'campaign_release_materialization_receipt',
  );
  const packageResult = records.get('campaign_release_package_result');
  const integration = records.get('campaign_release_integration_receipt');
  const verification = records.get('campaign_release_verification_receipt');
  if (promotion && promotion.campaignReleaseBundleHash
      !== releaseBundle.campaignReleaseBundleHash) {
    blockers.push('handoff_bundle_detached_promotion_bundle_binding_invalid');
  }
  if (materialization
    && (materialization.campaignReleaseBundleHash
        !== releaseBundle.campaignReleaseBundleHash
      || (promotion && promotion.materializationReceiptHash
        !== materialization
          .campaignReleaseBundleMaterializationReceiptHash))) {
    blockers.push('handoff_bundle_detached_materialization_binding_invalid');
  }
  if (packageResult
    && (packageResult.campaignReleaseBundleHash
        !== releaseBundle.campaignReleaseBundleHash
      || !sameRecord(packageResult.releaseBundle, releaseBundle)
      || (promotion && promotion.packageResultHash
        !== hashRecord('PaperCampaignNodeResult', packageResult)))) {
    blockers.push('handoff_bundle_detached_package_result_binding_invalid');
  }
  if (packageResult && materialization
    && (packageResult.campaignReleaseBundleMaterializationReceiptHash
        !== materialization
          .campaignReleaseBundleMaterializationReceiptHash
      || !sameRecord(packageResult.materializationReceipt, materialization))) {
    blockers.push('handoff_bundle_detached_package_result_materialization_invalid');
  }
  if (packageResult && integration
    && packageResult.workspaceAttemptIntegration
      ?.workspaceAttemptIntegrationDescriptorHash
        !== integration.descriptorHash) {
    blockers.push('handoff_bundle_detached_package_result_integration_invalid');
  }
  if (integration && promotion
    && (promotion.integrationReceiptHash
        !== integration.workspaceAttemptIntegrationReceiptHash
      || promotion.integrationDescriptorHash !== integration.descriptorHash)) {
    blockers.push('handoff_bundle_detached_integration_binding_invalid');
  }
  if (verification
    && (verification.campaignReleaseBundleHash
        !== releaseBundle.campaignReleaseBundleHash
      || (promotion
        && verification.campaignReleasePromotionReceiptHash
          !== promotion.campaignReleasePromotionReceiptHash)
      || (promotion && verification.packageResultHash
        !== promotion.packageResultHash)
      || (promotion && verification.integrationDescriptorHash
        !== promotion.integrationDescriptorHash)
      || (promotion && verification.integrationReceiptHash
        !== promotion.integrationReceiptHash))) {
    blockers.push('handoff_bundle_detached_release_verification_binding_invalid');
  }
  return blockers;
}

function inspectManifestBindings({
  artifactPackage,
  authority,
  manifest,
  packageVerification,
  records,
  releaseBundle,
  request,
  requestReceipt,
}) {
  if (!manifest) return [];
  const blockers = [];
  const rootBindings = [
    [manifest.submissionHandoffExportRequestHash,
      request.submissionHandoffExportRequestHash,
      'handoff_bundle_detached_manifest_request_binding_invalid'],
    [manifest.submissionHandoffExportRequestVerificationReceiptHash,
      requestReceipt.submissionHandoffExportRequestVerificationReceiptHash,
      'handoff_bundle_detached_manifest_request_receipt_binding_invalid'],
    [manifest.submissionHandoffExportAuthorityHash,
      authority.submissionHandoffExportAuthorityHash,
      'handoff_bundle_detached_manifest_authority_binding_invalid'],
    [manifest.campaignReleaseBundleHash,
      releaseBundle.campaignReleaseBundleHash,
      'handoff_bundle_detached_manifest_release_binding_invalid'],
    [manifest.artifactPackageHash,
      artifactPackage.artifactPackageHash,
      'handoff_bundle_detached_manifest_artifact_binding_invalid'],
    [manifest.packageVerificationReceiptHash,
      packageVerification.packageVerificationReceiptHash,
      'handoff_bundle_detached_manifest_package_verification_binding_invalid'],
    [manifest.dispatchAuthorizationHash,
      request.dispatchAuthorization?.submissionDispatchAuthorizationHash,
      'handoff_bundle_detached_manifest_dispatch_binding_invalid'],
  ];
  for (const [actual, expected, blocker] of rootBindings) {
    if (actual !== expected) blockers.push(blocker);
  }
  const optionalReceiptBindings = [
    ['campaignReleasePromotionReceiptHash',
      'campaign_release_promotion_receipt',
      'campaignReleasePromotionReceiptHash'],
    ['campaignReleaseMaterializationReceiptHash',
      'campaign_release_materialization_receipt',
      'campaignReleaseBundleMaterializationReceiptHash'],
    ['campaignReleasePackageResultHash',
      'campaign_release_package_result',
      'campaignReleasePackageResultHash'],
    ['campaignReleaseIntegrationReceiptHash',
      'campaign_release_integration_receipt',
      'workspaceAttemptIntegrationReceiptHash'],
    ['submissionCampaignReleaseVerificationReceiptHash',
      'campaign_release_verification_receipt',
      'submissionCampaignReleaseVerificationReceiptHash'],
  ];
  for (const [manifestField, role, hashField] of optionalReceiptBindings) {
    if (manifest[manifestField] !== (records.get(role)?.[hashField] || null)) {
      blockers.push(
        `handoff_bundle_detached_manifest_optional_receipt_binding_invalid:${
          role}`,
      );
    }
  }
  if (manifest.persistedSubmissionAuthority
    ?.submissionHandoffExportAuthorityHash
      !== authority.submissionHandoffExportAuthorityHash) {
    blockers.push('handoff_bundle_detached_manifest_lineage_binding_invalid');
  }
  return blockers;
}

export function inspectSubmissionHandoffDetachedRecordGraph(
  records,
  { manifest = null } = {},
) {
  const blockers = [];
  for (const role of REQUIRED_RECORD_ROLES) {
    if (!records.get(role)) {
      blockers.push(`handoff_bundle_detached_record_required:${role}`);
    }
  }
  if (blockers.length) return blockers;
  const request = records.get('submission_handoff_export_request');
  const requestReceipt = records.get(
    'submission_handoff_export_request_verification_receipt',
  );
  const authority = records.get(
    'persisted_submission_handoff_export_authority',
  );
  const releaseBundle = records.get('campaign_release_bundle');
  const artifactPackage = records.get('artifact_package');
  const packageVerification = records.get('package_verification_receipt');
  const requestVerification = verifySubmissionHandoffExportRequest(request, {
    campaignId: releaseBundle.campaignId,
    paperId: releaseBundle.paperId,
    artifactPackageHash: artifactPackage.artifactPackageHash,
    manuscriptPromotionGateHash:
      releaseBundle.manuscriptPromotionGateHash,
    submissionAuthority: authority,
  });
  if (requestVerification.status
      !== 'submission_handoff_export_request_verified'
    || !sameRecord(requestVerification, requestReceipt)) {
    blockers.push('handoff_bundle_detached_request_verification_invalid');
  }
  if (request.campaignId !== releaseBundle.campaignId
    || request.manifest?.paperId !== releaseBundle.paperId
    || request.dispatchAuthorization?.artifactPackageHash
      !== artifactPackage.artifactPackageHash) {
    blockers.push('handoff_bundle_detached_release_request_binding_invalid');
  }
  if (releaseBundle.artifactPackageHash !== artifactPackage.artifactPackageHash
    || !sameRecord(releaseBundle.artifactPackage, artifactPackage)) {
    blockers.push('handoff_bundle_detached_artifact_package_binding_invalid');
  }
  if (releaseBundle.packageVerificationReceiptHash
      !== packageVerification.packageVerificationReceiptHash
    || artifactPackage.packageVerificationReceiptHash
      !== packageVerification.packageVerificationReceiptHash
    || !sameRecord(
      releaseBundle.packageVerificationReceipt,
      packageVerification,
    )) {
    blockers.push('handoff_bundle_detached_package_verification_binding_invalid');
  }
  blockers.push(...inspectReleaseReceiptBindings(records, releaseBundle));
  const releaseVerification = records.get(
    'campaign_release_verification_receipt',
  );
  if (releaseVerification
    && (releaseVerification.artifactPackageHash
        !== artifactPackage.artifactPackageHash
      || releaseVerification.packageVerificationReceiptHash
        !== packageVerification.packageVerificationReceiptHash)) {
    blockers.push('handoff_bundle_detached_release_verification_binding_invalid');
  }
  blockers.push(...inspectManifestBindings({
    artifactPackage,
    authority,
    manifest,
    packageVerification,
    records,
    releaseBundle,
    request,
    requestReceipt,
  }));
  return [...new Set(blockers)];
}

export function createSubmissionHandoffDetachedRecordsCapsule({
  artifactPackage,
  campaignReleaseBundle,
  campaignReleaseIntegrationReceipt = null,
  campaignReleaseMaterializationReceipt = null,
  campaignReleasePackageResult = null,
  campaignReleasePromotionReceipt = null,
  campaignReleaseVerificationReceipt = null,
  packageVerificationReceipt,
  submissionAuthority,
  submissionHandoffExportRequest,
  submissionHandoffExportRequestVerificationReceipt,
} = {}) {
  const inputs = {
    artifact_package: artifactPackage,
    campaign_release_bundle: campaignReleaseBundle,
    campaign_release_integration_receipt:
      campaignReleaseIntegrationReceipt,
    campaign_release_materialization_receipt:
      campaignReleaseMaterializationReceipt,
    campaign_release_package_result: campaignReleasePackageResult,
    campaign_release_promotion_receipt: campaignReleasePromotionReceipt,
    campaign_release_verification_receipt:
      campaignReleaseVerificationReceipt,
    package_verification_receipt: packageVerificationReceipt,
    persisted_submission_handoff_export_authority: submissionAuthority,
    submission_handoff_export_request: submissionHandoffExportRequest,
    submission_handoff_export_request_verification_receipt:
      submissionHandoffExportRequestVerificationReceipt,
  };
  for (const role of REQUIRED_RECORD_ROLES) {
    if (!inputs[role]) {
      throw new Error(`handoff_bundle_detached_record_required:${role}`);
    }
  }
  const documents = Object.entries(inputs)
    .filter(([, record]) => record !== null && record !== undefined)
    .map(([role, record]) => recordDocument(role, record))
    .sort((left, right) => left.role.localeCompare(right.role));
  const records = new Map(documents.map((document) => [
    document.role,
    document.record,
  ]));
  const graphBlockers = inspectSubmissionHandoffDetachedRecordGraph(records);
  if (graphBlockers.length) {
    throw new Error(`handoff_bundle_detached_record_graph_invalid:${
      graphBlockers.join(',')}`);
  }
  const descriptors = Object.freeze(documents.map(
    (document) => document.descriptor,
  ));
  return Object.freeze({
    documents: Object.freeze(documents),
    manifestBinding: Object.freeze({
      detachedRecords: descriptors,
      submissionHandoffDetachedRecordSetHash:
        hashSubmissionHandoffDetachedRecordSet(descriptors),
      submissionHandoffExportRequestHash:
        submissionHandoffExportRequest.submissionHandoffExportRequestHash,
      submissionHandoffExportRequestVerificationReceiptHash:
        submissionHandoffExportRequestVerificationReceipt
          .submissionHandoffExportRequestVerificationReceiptHash,
      submissionHandoffExportAuthorityHash:
        submissionAuthority.submissionHandoffExportAuthorityHash,
      campaignReleasePromotionReceiptHash:
        campaignReleasePromotionReceipt
          ?.campaignReleasePromotionReceiptHash || null,
      campaignReleaseMaterializationReceiptHash:
        campaignReleaseMaterializationReceipt
          ?.campaignReleaseBundleMaterializationReceiptHash || null,
      campaignReleasePackageResultHash:
        campaignReleasePackageResult?.campaignReleasePackageResultHash || null,
      campaignReleaseIntegrationReceiptHash:
        campaignReleaseIntegrationReceipt
          ?.workspaceAttemptIntegrationReceiptHash || null,
      submissionCampaignReleaseVerificationReceiptHash:
        campaignReleaseVerificationReceipt
          ?.submissionCampaignReleaseVerificationReceiptHash || null,
    }),
  });
}

export function submissionHandoffDetachedManifestDescriptors(manifest) {
  const records = manifest?.detachedRecords;
  const recordSetHash = manifest?.submissionHandoffDetachedRecordSetHash;
  if (records === undefined && recordSetHash === undefined) {
    return Object.freeze([]);
  }
  if (!Array.isArray(records)
    || !SHA256.test(String(recordSetHash || ''))
    || hashSubmissionHandoffDetachedRecordSet(records) !== recordSetHash) {
    throw new Error('handoff_bundle_detached_record_set_invalid');
  }
  const roles = records.map((record) => record?.role);
  if (JSON.stringify(roles) !== JSON.stringify([...roles].sort())
    || new Set(roles).size !== roles.length) {
    throw new Error('handoff_bundle_detached_record_role_duplicate_or_unsorted');
  }
  const descriptors = records.map((record) => {
    const spec = RECORD_SPECS[record?.role];
    if (!hasExactKeys(record, DESCRIPTOR_KEYS)
      || !spec
      || record.kind !== spec.kind
      || record.recordHashField !== spec.hashField
      || record.path !== `records/${record.role}.json`
      || !SHA256.test(String(record.recordHash || ''))
      || !SHA256.test(String(record.contentHash || ''))
      || !Number.isSafeInteger(Number(record.bytes))
      || Number(record.bytes) < 0) {
      throw new Error(
        `handoff_bundle_detached_record_descriptor_invalid:${
          record?.role || 'unknown'}`,
      );
    }
    return Object.freeze({
      relative: portableRelativePath(record.path),
      hash: record.contentHash,
      bytes: Number(record.bytes),
      label: record.role,
      role: record.role,
      recordHash: record.recordHash,
      recordHashField: record.recordHashField,
    });
  });
  if (new Set(descriptors.map((record) => record.relative)).size
      !== descriptors.length) {
    throw new Error('handoff_bundle_detached_record_path_duplicate');
  }
  return Object.freeze(descriptors);
}

export function readSubmissionHandoffDetachedRecordMap({
  descriptors,
  root,
} = {}) {
  const records = new Map();
  for (const descriptor of descriptors || []) {
    const read = readScopedFileSync({
      scopeRoot: root,
      candidate: path.join(root, descriptor.relative),
    });
    if (read.status !== 'scoped_file_read_verified'
      || read.hash !== descriptor.hash
      || read.bytes !== descriptor.bytes) {
      throw new Error(
        `handoff_bundle_detached_record_read_invalid:${descriptor.role}`,
      );
    }
    let record;
    try {
      record = JSON.parse(read.content.toString('utf8'));
    } catch {
      throw new Error(
        `handoff_bundle_detached_record_json_invalid:${descriptor.role}`,
      );
    }
    if (!read.content.equals(canonicalRecordBytes(record))) {
      throw new Error(
        `handoff_bundle_detached_record_noncanonical:${descriptor.role}`,
      );
    }
    const spec = assertSubmissionHandoffDetachedRecord(
      descriptor.role,
      record,
    );
    if (descriptor.recordHashField !== spec.hashField
      || descriptor.recordHash !== record[spec.hashField]) {
      throw new Error(
        `handoff_bundle_detached_record_descriptor_hash_mismatch:${
          descriptor.role}`,
      );
    }
    records.set(descriptor.role, Object.freeze(record));
  }
  return records;
}
