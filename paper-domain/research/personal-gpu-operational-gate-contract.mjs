import { deepFreezeJsonValue } from '../../workflow-kernel/deep-freeze-json-value.mjs';
import { hashRecord } from '../../workflow-kernel/record-hash.mjs';
import { hasExactPlainObjectKeys } from '../../workflow-kernel/exact-object-keys.mjs';

const SHA256 = /^sha256:[0-9a-f]{64}$/u;
const COMMIT = /^[0-9a-f]{40}$/u;
const GPU_UUID = /^GPU-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;

const GPU_KEYS = Object.freeze([
  'computeCapability', 'driverVersion', 'gpuModel', 'gpuUuid', 'memoryMiB',
]);
const RUNTIME_KEYS = Object.freeze([
  'dockerDigestBound', 'image', 'imageDigest', 'networkDisabled',
  'singleDevicePinned',
]);
const PDE_KEYS = Object.freeze([
  'cpuOracleHash', 'cpuOracleStatus', 'receiptHash', 'scientificChecksPassed',
  'status',
]);
const DL_KEYS = Object.freeze([
  'checkpointManifestHash', 'cpuOracleHash', 'cpuOracleStatus',
  'datasetManifestHash', 'deterministicReplay', 'errorBudgetHash',
  'hiddenEvaluationHash', 'hiddenEvaluationStatus', 'modelIrHash',
  'originalReceiptHash', 'replayReceiptHash', 'sameDeviceReplayHash',
  'status',
]);
const IR_KEYS = Object.freeze([
  'checkpointExecutablePayloadAllowed', 'checkpointHash', 'datasetHash',
  'modelExecutableCodeEmbedded', 'modelHash', 'pickleAllowed',
]);
const POLICY_KEYS = Object.freeze([
  'externalAuthorityStatus', 'kind', 'profileId', 'secondHardwareStatus',
  'scope', 'version',
]);
const RELEASE_BOUNDARY_KEYS = Object.freeze([
  'independentSecondHardwareRequired', 'releaseBlockers',
  'releasePromotionEligible',
]);
const RECEIPT_KEYS = Object.freeze([
  'blockers', 'createdAtEpochMs', 'deepLearning',
  'externalActionPerformed', 'gpu', 'ir',
  'kind', 'localPolicy', 'networkActionPerformed',
  'pde', 'personalProductionReady', 'profileId',
  'releaseBoundary', 'runtime', 'version',
  'personalGpuOperationalReceiptHash', 'workspaceCommit',
]);

export const PERSONAL_GPU_OPERATIONAL_PROFILE = Object.freeze({
  version: 1,
  kind: 'PersonalGpuOperationalProfile',
  profileId: 'personal-single-host-gpu-v1',
  scope: 'single-owner-local-runtime-v1',
  secondHardwareStatus: 'not_applicable_for_personal_use',
  externalAuthorityStatus: 'not_applicable_for_personal_use',
});

export const PERSONAL_GPU_RELEASE_BOUNDARY = Object.freeze({
  independentSecondHardwareRequired: true,
  releasePromotionEligible: false,
  releaseBlockers: Object.freeze([
    'independent_second_hardware_required_for_release',
    'external_authority_required_for_release',
  ]),
});

function sha(value) {
  const selected = String(value || '').toLowerCase();
  return SHA256.test(selected) ? selected : null;
}

function uniqueSorted(values) {
  return [...new Set((values || []).map((value) => String(value)))].sort();
}

function exactKeys(value, keys) {
  return hasExactPlainObjectKeys(value, keys);
}

function validGpu(value) {
  return exactKeys(value, GPU_KEYS)
    && GPU_UUID.test(String(value.gpuUuid || ''))
    && typeof value.gpuModel === 'string' && value.gpuModel.length > 0
    && /^\d{1,2}\.\d{1,2}$/u.test(String(value.computeCapability || ''))
    && /^\d+(?:\.\d+){1,3}$/u.test(String(value.driverVersion || ''))
    && Number.isSafeInteger(value.memoryMiB) && value.memoryMiB > 0;
}

function validRuntime(value) {
  return exactKeys(value, RUNTIME_KEYS)
    && typeof value.image === 'string' && value.image.length > 0
    && sha(value.imageDigest)
    && value.dockerDigestBound === true
    && value.networkDisabled === true
    && value.singleDevicePinned === true;
}

function validPde(value) {
  return exactKeys(value, PDE_KEYS)
    && sha(value.receiptHash)
    && sha(value.cpuOracleHash)
    && value.status === 'canonical_pde_poisson_2d_gpu_scientifically_verified_non_promotable'
    && value.cpuOracleStatus === 'process_isolated_pde_poisson_2d_cpu_oracle_verified'
    && value.scientificChecksPassed === true;
}

function validDl(value) {
  return exactKeys(value, DL_KEYS)
    && sha(value.originalReceiptHash)
    && sha(value.replayReceiptHash)
    && sha(value.sameDeviceReplayHash)
    && sha(value.cpuOracleHash)
    && sha(value.hiddenEvaluationHash)
    && sha(value.modelIrHash)
    && sha(value.datasetManifestHash)
    && sha(value.checkpointManifestHash)
    && sha(value.errorBudgetHash)
    && value.status === 'personal_deep_learning_gpu_verified_non_promotable'
    && value.cpuOracleStatus === 'process_isolated_deep_learning_cpu_oracle_verified'
    && value.hiddenEvaluationStatus === 'deep_learning_hidden_evaluation_recorded'
    && value.deterministicReplay === true;
}

function validIr(value, deepLearning) {
  return Boolean(deepLearning) && exactKeys(value, IR_KEYS)
    && value.modelHash === deepLearning.modelIrHash
    && value.datasetHash === deepLearning.datasetManifestHash
    && value.checkpointHash === deepLearning.checkpointManifestHash
    && value.modelExecutableCodeEmbedded === false
    && value.checkpointExecutablePayloadAllowed === false
    && value.pickleAllowed === false;
}

function validPolicy(value) {
  return exactKeys(value, POLICY_KEYS)
    && JSON.stringify(value) === JSON.stringify(PERSONAL_GPU_OPERATIONAL_PROFILE);
}

function validReleaseBoundary(value) {
  return exactKeys(value, RELEASE_BOUNDARY_KEYS)
    && JSON.stringify(value) === JSON.stringify(PERSONAL_GPU_RELEASE_BOUNDARY);
}

/**
 * Build a local-only operational receipt.  A successful receipt means the
 * configured personal host passed its actual GPU/PDE/DL checks.  It never
 * means that a release has independent authority or second-hardware proof.
 */
export function buildPersonalGpuOperationalReceipt({
  createdAtEpochMs = Date.now(),
  workspaceCommit,
  gpu,
  runtime,
  pde,
  deepLearning,
  ir,
  blockers = [],
  externalActionPerformed = false,
  networkActionPerformed = false,
} = {}) {
  const localBlockers = uniqueSorted([
    ...blockers,
    ...(Number.isSafeInteger(createdAtEpochMs) && createdAtEpochMs > 0
      ? [] : ['personal_gpu_receipt_timestamp_invalid']),
    ...(COMMIT.test(String(workspaceCommit || ''))
      ? [] : ['personal_gpu_receipt_workspace_commit_invalid']),
    ...(validGpu(gpu) ? [] : ['personal_gpu_receipt_gpu_observation_invalid']),
    ...(validRuntime(runtime) ? [] : ['personal_gpu_receipt_runtime_invalid']),
    ...(validPde(pde) ? [] : ['personal_gpu_receipt_pde_evidence_invalid']),
    ...(validDl(deepLearning) ? [] : ['personal_gpu_receipt_deep_learning_evidence_invalid']),
    ...(validIr(ir, deepLearning) ? [] : ['personal_gpu_receipt_ir_binding_invalid']),
    ...(externalActionPerformed === false
      ? [] : ['personal_gpu_receipt_external_action_forbidden']),
    ...(networkActionPerformed === false
      ? [] : ['personal_gpu_receipt_network_action_forbidden']),
  ]);
  const payload = {
    version: 1,
    kind: 'PersonalGpuOperationalReceipt',
    profileId: PERSONAL_GPU_OPERATIONAL_PROFILE.profileId,
    createdAtEpochMs,
    workspaceCommit: COMMIT.test(String(workspaceCommit || ''))
      ? String(workspaceCommit).toLowerCase() : null,
    gpu: validGpu(gpu) ? Object.freeze({ ...gpu }) : null,
    runtime: validRuntime(runtime) ? Object.freeze({ ...runtime }) : null,
    pde: validPde(pde) ? Object.freeze({ ...pde }) : null,
    deepLearning: validDl(deepLearning) ? Object.freeze({ ...deepLearning }) : null,
    ir: validIr(ir, deepLearning) ? Object.freeze({ ...ir }) : null,
    localPolicy: PERSONAL_GPU_OPERATIONAL_PROFILE,
    releaseBoundary: PERSONAL_GPU_RELEASE_BOUNDARY,
    personalProductionReady: localBlockers.length === 0,
    blockers: Object.freeze(localBlockers),
    externalActionPerformed: externalActionPerformed === true,
    networkActionPerformed: networkActionPerformed === true,
  };
  return deepFreezeJsonValue({
    ...payload,
    personalGpuOperationalReceiptHash: hashRecord(
      'PersonalGpuOperationalReceipt', payload,
    ),
  });
}

export function verifyPersonalGpuOperationalReceipt(value) {
  if (!exactKeys(value, RECEIPT_KEYS)
    || value.version !== 1
    || value.kind !== 'PersonalGpuOperationalReceipt'
    || value.profileId !== PERSONAL_GPU_OPERATIONAL_PROFILE.profileId
    || value.localPolicy === null
    || value.releaseBoundary === null
    || !Array.isArray(value.blockers)
    || value.personalProductionReady !== (value.blockers.length === 0)
    || value.externalActionPerformed !== false
    || value.networkActionPerformed !== false
    || !validPolicy(value.localPolicy)
    || !validReleaseBoundary(value.releaseBoundary)) return false;
  try {
    const rebuilt = buildPersonalGpuOperationalReceipt({
      createdAtEpochMs: value.createdAtEpochMs,
      workspaceCommit: value.workspaceCommit,
      gpu: value.gpu,
      runtime: value.runtime,
      pde: value.pde,
      deepLearning: value.deepLearning,
      ir: value.ir,
      blockers: value.blockers,
      externalActionPerformed: value.externalActionPerformed,
      networkActionPerformed: value.networkActionPerformed,
    });
    return JSON.stringify(rebuilt) === JSON.stringify(value);
  } catch {
    return false;
  }
}
