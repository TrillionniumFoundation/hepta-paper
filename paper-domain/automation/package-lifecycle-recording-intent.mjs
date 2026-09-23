import { hasExactObjectKeys } from '../../workflow-kernel/exact-object-keys.mjs';
import { hashRecord } from '../../workflow-kernel/record-hash.mjs';

const SHA256 = /^sha256:[a-f0-9]{64}$/;
const INTENT_KEYS = Object.freeze([
  'version', 'kind', 'status', 'runtimeRoot', 'campaignId', 'paperId',
  'campaignPlanHash', 'packageNodeId', 'packageAttemptId', 'leaseGeneration',
  'packageResultHash', 'integrationDescriptorHash', 'integrationReceiptHash',
  'campaignReleaseBundleHash', 'materializationReceiptHash', 'packagePath',
  'packageContentHash', 'immutableCampaignPackageOutputHash', 'preparedAt',
  'externalActionPerformed', 'packageLifecycleRecordingIntentReceiptHash',
]);

function nonEmpty(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

function validHash(value) {
  return SHA256.test(String(value || ''));
}

export function createPackageLifecycleRecordingIntent({
  runtimeRoot,
  campaign,
  packageNode,
  packageResult,
  packagePath,
  packageContentHash,
  preparedAt,
} = {}) {
  const releaseBundle = packageResult?.releaseBundle;
  const payload = {
    version: 1,
    kind: 'PackageLifecycleRecordingIntent',
    status: 'package_lifecycle_recording_intent_prepared',
    runtimeRoot,
    campaignId: campaign?.campaignId,
    paperId: campaign?.paperId,
    campaignPlanHash: campaign?.spec?.campaignPlanHash,
    packageNodeId: packageNode?.nodeId,
    packageAttemptId: packageNode?.attemptId,
    leaseGeneration: Number(packageNode?.leaseGeneration),
    packageResultHash: packageNode?.preparedResultHash,
    integrationDescriptorHash: packageNode?.preparedIntegrationKey,
    integrationReceiptHash: packageNode?.preparedIntegrationReceiptHash,
    campaignReleaseBundleHash: releaseBundle?.campaignReleaseBundleHash,
    materializationReceiptHash:
      packageResult?.campaignReleaseBundleMaterializationReceiptHash,
    packagePath,
    packageContentHash,
    immutableCampaignPackageOutputHash:
      releaseBundle?.immutableCampaignPackageOutputHash,
    preparedAt,
    externalActionPerformed: false,
  };
  const intent = Object.freeze({
    ...payload,
    packageLifecycleRecordingIntentReceiptHash:
      hashRecord('PackageLifecycleRecordingIntent', payload),
  });
  if (!verifyPackageLifecycleRecordingIntent(intent).valid) {
    throw new Error('package_lifecycle_recording_intent_invalid');
  }
  return intent;
}

export function verifyPackageLifecycleRecordingIntent(intent, expected = {}) {
  const blockers = [];
  const {
    packageLifecycleRecordingIntentReceiptHash = null,
    ...payload
  } = intent || {};
  if (!hasExactObjectKeys(intent, INTENT_KEYS)
    || intent?.version !== 1
    || intent.kind !== 'PackageLifecycleRecordingIntent'
    || intent.status !== 'package_lifecycle_recording_intent_prepared'
    || !nonEmpty(intent.runtimeRoot)
    || !nonEmpty(intent.campaignId)
    || !nonEmpty(intent.paperId)
    || !nonEmpty(intent.packageNodeId)
    || !nonEmpty(intent.packageAttemptId)
    || !Number.isInteger(intent.leaseGeneration)
    || intent.leaseGeneration < 1
    || !nonEmpty(intent.packagePath)
    || !validHash(intent.campaignPlanHash)
    || !validHash(intent.packageResultHash)
    || !validHash(intent.integrationDescriptorHash)
    || !validHash(intent.integrationReceiptHash)
    || !validHash(intent.campaignReleaseBundleHash)
    || !validHash(intent.materializationReceiptHash)
    || !validHash(intent.packageContentHash)
    || !validHash(intent.immutableCampaignPackageOutputHash)
    || !Number.isFinite(Date.parse(intent.preparedAt || ''))
    || intent.externalActionPerformed !== false
    || hashRecord('PackageLifecycleRecordingIntent', payload)
      !== packageLifecycleRecordingIntentReceiptHash) {
    blockers.push('package_lifecycle_recording_intent_invalid');
  }
  for (const [field, value] of Object.entries(expected)) {
    if (value !== undefined && intent?.[field] !== value) {
      blockers.push(`package_lifecycle_recording_intent_${field}_mismatch`);
    }
  }
  return Object.freeze({
    valid: blockers.length === 0,
    blockers: Object.freeze([...new Set(blockers)]),
  });
}
