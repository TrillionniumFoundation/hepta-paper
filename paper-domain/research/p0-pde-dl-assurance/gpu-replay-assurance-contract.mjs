import { deepFreezeJsonValue } from '../../../workflow-kernel/deep-freeze-json-value.mjs';
import { hashRecord } from '../../../workflow-kernel/record-hash.mjs';
import {
  exactPlainObject,
  finiteNumberInRange,
  jsonEqual,
  requiredDeepLearningHash,
  requiredDeepLearningId,
} from '../deep-learning-contract-primitives.mjs';

// This contract is the common boundary for the two scientific GPU profiles.
// It deliberately records observations rather than pretending that a local
// process is a second authority.  A receipt produced here is therefore useful
// for replay diagnostics, but can never by itself promote a run.

const CAPABILITIES = Object.freeze([
  'cupy-single-gpu-supervised-classification-fp32-v1',
  'pde_poisson_2d_manufactured_solution_v1',
]);
const SCOPES = Object.freeze({
  sameDevice: 'same-device-v1',
  secondHardware: 'independent-second-hardware-v1',
});
const METRIC_NAME = /^[a-z][a-z0-9_]{0,63}$/u;
const OBSERVATION_KEYS = Object.freeze([
  'capabilityKind', 'checkpointIrHash', 'dataIrHash', 'deterministicAlgorithmsConfigured',
  'deterministicConfigHash', 'deviceIdentityHash', 'hardwareFingerprintHash',
  'modelIrHash', 'metrics', 'outputArtifactHash', 'outputByteLength', 'runId',
  'runtimeBomHash', 'runtimeIdentityHash', 'runtimeImageDigest', 'sourceImplementationHash',
]);
const METRIC_KEYS = Object.freeze(['name', 'value']);
const BUDGET_KEYS = Object.freeze([
  'kind', 'maximumAbsoluteMetricError', 'maximumAbsoluteOutputError',
  'maximumRelativeMetricError', 'maximumRelativeOutputL2', 'requireByteIdentityOnSameDevice',
  'requireFiniteOutputs', 'version',
]);
const IR_KEYS = Object.freeze([
  'capabilityKind', 'checkpointIrHash', 'dataIrHash', 'deterministicPolicyHash',
  'executablePayloadAllowed', 'gpuScientificRunIrBindingHash', 'kind', 'modelIrHash',
  'runId', 'sourceImplementationHash', 'runtimeBomHash', 'version',
]);
const PLAN_KEYS = Object.freeze([
  'errorBudget', 'gpuReplayPlanHash', 'kind', 'originalObservationHash',
  'originalRuntimeIdentityHash', 'productionAuthorityRequired', 'replayDeviceIdentityHash',
  'replayHardwareFingerprintHash', 'replayRuntimeIdentityHash', 'replayScope',
  'status', 'version',
]);
const COMPARISON_KEYS = Object.freeze([
  'byteIdentical', 'maximumAbsoluteError', 'relativeOutputL2',
]);
const RECEIPT_KEYS = Object.freeze([
  'blockers', 'comparison', 'errorBudget', 'gpuReplayReceiptHash', 'kind',
  'originalObservation', 'originalObservationHash', 'productionBlockers',
  'productionPromotionEligible', 'replayObservation', 'replayObservationHash',
  'replayPlanHash', 'replayScope', 'scientificChecksPassed', 'status', 'version',
]);

export const GPU_REPLAY_SCOPES = SCOPES;

// Values are intentionally conservative.  They are policy inputs, not a
// claim that the currently available RTX 4060 has met them.
export const GPU_REPLAY_ERROR_BUDGET = Object.freeze({
  version: 1,
  kind: 'GpuReplayErrorBudget',
  maximumRelativeOutputL2: 1e-10,
  maximumAbsoluteOutputError: 1e-10,
  maximumRelativeMetricError: 1e-4,
  maximumAbsoluteMetricError: 1e-4,
  requireByteIdentityOnSameDevice: true,
  requireFiniteOutputs: true,
});

export const GPU_REPLAY_PRODUCTION_BLOCKERS = Object.freeze([
  'gpu_replay_external_authority_required',
  'gpu_replay_independent_operator_attestation_required',
]);

function hash(value) {
  return requiredDeepLearningHash(value);
}

function capability(value) {
  return typeof value === 'string' && CAPABILITIES.includes(value)
    ? value : null;
}

function number(value) {
  return finiteNumberInRange(value, 0, Number.MAX_VALUE);
}

function canonicalMetrics(value) {
  if (!Array.isArray(value) || value.length > 128) {
    throw new Error('gpu_replay_metrics_invalid');
  }
  const names = new Set();
  const metrics = value.map((entry) => {
    if (!exactPlainObject(entry, METRIC_KEYS)
      || !METRIC_NAME.test(entry.name || '')
      || names.has(entry.name)
      || !number(entry.value)) {
      throw new Error('gpu_replay_metrics_invalid');
    }
    names.add(entry.name);
    return Object.freeze({ name: entry.name, value: entry.value });
  }).sort((left, right) => left.name.localeCompare(right.name));
  return Object.freeze(metrics);
}

function canonicalBudget(value) {
  if (!exactPlainObject(value, BUDGET_KEYS)
    || value.version !== 1
    || value.kind !== 'GpuReplayErrorBudget'
    || !number(value.maximumRelativeOutputL2)
    || !number(value.maximumAbsoluteOutputError)
    || !number(value.maximumRelativeMetricError)
    || !number(value.maximumAbsoluteMetricError)
    || typeof value.requireByteIdentityOnSameDevice !== 'boolean'
    || value.requireFiniteOutputs !== true) {
    throw new Error('gpu_replay_error_budget_invalid');
  }
  return Object.freeze({ ...value });
}

function canonicalObservation(value) {
  if (!exactPlainObject(value, OBSERVATION_KEYS)
    || !capability(value.capabilityKind)
    || !requiredDeepLearningId(value.runId)
    || !hash(value.modelIrHash)
    || !hash(value.dataIrHash)
    || !hash(value.runtimeBomHash)
    || !hash(value.runtimeIdentityHash)
    || !hash(value.runtimeImageDigest)
    || !hash(value.deviceIdentityHash)
    || !hash(value.hardwareFingerprintHash)
    || !hash(value.deterministicConfigHash)
    || !hash(value.sourceImplementationHash)
    || (value.checkpointIrHash !== null && !hash(value.checkpointIrHash))
    || !hash(value.outputArtifactHash)
    || !Number.isSafeInteger(value.outputByteLength)
    || value.outputByteLength < 1
    || value.deterministicAlgorithmsConfigured !== true) {
    throw new Error('gpu_replay_observation_invalid');
  }
  return deepFreezeJsonValue({
    capabilityKind: value.capabilityKind,
    modelIrHash: value.modelIrHash,
    dataIrHash: value.dataIrHash,
    checkpointIrHash: value.checkpointIrHash,
    runtimeBomHash: value.runtimeBomHash,
    runtimeIdentityHash: value.runtimeIdentityHash,
    runtimeImageDigest: value.runtimeImageDigest,
    deviceIdentityHash: value.deviceIdentityHash,
    hardwareFingerprintHash: value.hardwareFingerprintHash,
    deterministicConfigHash: value.deterministicConfigHash,
    deterministicAlgorithmsConfigured: true,
    sourceImplementationHash: value.sourceImplementationHash,
    outputArtifactHash: value.outputArtifactHash,
    outputByteLength: value.outputByteLength,
    metrics: canonicalMetrics(value.metrics),
    runId: value.runId,
  });
}

export function buildGpuReplayObservation(value = {}) {
  return canonicalObservation(value);
}

export function verifyGpuReplayObservation(value) {
  try {
    return exactPlainObject(value, OBSERVATION_KEYS)
      && jsonEqual(canonicalObservation(value), value);
  } catch {
    return false;
  }
}

function sameLineage(original, replay) {
  return original.capabilityKind === replay.capabilityKind
    && original.modelIrHash === replay.modelIrHash
    && original.dataIrHash === replay.dataIrHash
    && original.checkpointIrHash === replay.checkpointIrHash
    && original.runtimeBomHash === replay.runtimeBomHash
    && original.runtimeImageDigest === replay.runtimeImageDigest
    && original.deterministicConfigHash === replay.deterministicConfigHash
    && original.sourceImplementationHash === replay.sourceImplementationHash
    && original.outputByteLength === replay.outputByteLength;
}

function metricMap(observation) {
  return new Map(observation.metrics.map(({ name, value }) => [name, value]));
}

function canonicalComparison(value) {
  if (!exactPlainObject(value, COMPARISON_KEYS)
    || typeof value.byteIdentical !== 'boolean'
    || !number(value.maximumAbsoluteError)
    || !number(value.relativeOutputL2)) {
    throw new Error('gpu_replay_comparison_invalid');
  }
  return Object.freeze({ ...value });
}

function compareMetrics(original, replay, budget) {
  const left = metricMap(original);
  const right = metricMap(replay);
  if (left.size !== right.size || [...left.keys()].some((key) => !right.has(key))) {
    return ['gpu_replay_metric_set_mismatch'];
  }
  const blockers = [];
  for (const [name, expected] of left) {
    const observed = right.get(name);
    const absolute = Math.abs(observed - expected);
    const relative = absolute / Math.max(Math.abs(expected), 1e-12);
    if (absolute > budget.maximumAbsoluteMetricError
      && relative > budget.maximumRelativeMetricError) {
      blockers.push(`gpu_replay_metric_outside_budget:${name}`);
    }
  }
  return blockers;
}

export function buildScientificRunIrBinding({
  capabilityKind,
  runId,
  modelIrHash,
  dataIrHash,
  checkpointIrHash = null,
  runtimeBomHash,
  sourceImplementationHash,
  deterministicPolicyHash,
} = {}) {
  const payload = {
    version: 1,
    kind: 'GpuScientificRunIrBinding',
    capabilityKind,
    runId,
    modelIrHash,
    dataIrHash,
    checkpointIrHash,
    runtimeBomHash,
    sourceImplementationHash,
    deterministicPolicyHash,
    executablePayloadAllowed: false,
  };
  // Reuse the observation validators for IDs/hashes without accepting an
  // executable model or dataset payload in this envelope.
  if (!capability(capabilityKind)
    || !requiredDeepLearningId(runId)
    || !hash(modelIrHash) || !hash(dataIrHash)
    || (checkpointIrHash !== null && !hash(checkpointIrHash))
    || !hash(runtimeBomHash) || !hash(sourceImplementationHash)
    || !hash(deterministicPolicyHash)) {
    throw new Error('gpu_scientific_run_ir_binding_invalid');
  }
  return deepFreezeJsonValue({
    ...payload,
    gpuScientificRunIrBindingHash: hashRecord('GpuScientificRunIrBinding', payload),
  });
}

export function verifyScientificRunIrBinding(value) {
  try {
    if (!exactPlainObject(value, IR_KEYS)
      || value.executablePayloadAllowed !== false) return false;
    const payload = { ...value };
    delete payload.gpuScientificRunIrBindingHash;
    return hashRecord('GpuScientificRunIrBinding', payload)
      === value.gpuScientificRunIrBindingHash;
  } catch {
    return false;
  }
}

export function buildGpuReplayPlan({
  originalObservation,
  replayScope,
  replayDeviceIdentityHash,
  replayHardwareFingerprintHash,
  replayRuntimeIdentityHash,
  errorBudget = GPU_REPLAY_ERROR_BUDGET,
} = {}) {
  if (!verifyGpuReplayObservation(originalObservation)
    || !Object.values(SCOPES).includes(replayScope)
    || !hash(replayDeviceIdentityHash)
    || !hash(replayHardwareFingerprintHash)
    || !hash(replayRuntimeIdentityHash)) {
    throw new Error('gpu_replay_plan_invalid');
  }
  const budget = canonicalBudget(errorBudget);
  if (replayScope === SCOPES.sameDevice
    && (replayDeviceIdentityHash !== originalObservation.deviceIdentityHash
      || replayHardwareFingerprintHash !== originalObservation.hardwareFingerprintHash)) {
    throw new Error('gpu_replay_same_device_identity_mismatch');
  }
  if (replayScope === SCOPES.secondHardware
    && (replayDeviceIdentityHash === originalObservation.deviceIdentityHash
      || replayHardwareFingerprintHash === originalObservation.hardwareFingerprintHash)) {
    throw new Error('gpu_replay_second_hardware_must_be_distinct');
  }
  const payload = {
    version: 1,
    kind: 'GpuReplayPlan',
    status: 'gpu_replay_plan_bound_non_promotable',
    replayScope,
    replayRuntimeIdentityHash,
    replayDeviceIdentityHash,
    replayHardwareFingerprintHash,
    originalRuntimeIdentityHash: originalObservation.runtimeIdentityHash,
    originalObservationHash: hashRecord('GpuReplayObservation', originalObservation),
    errorBudget: budget,
    productionAuthorityRequired: true,
  };
  return deepFreezeJsonValue({
    ...payload,
    gpuReplayPlanHash: hashRecord('GpuReplayPlan', payload),
  });
}

export function verifyGpuReplayPlan(value) {
  try {
    if (!exactPlainObject(value, PLAN_KEYS)
      || value.version !== 1
      || value.kind !== 'GpuReplayPlan'
      || value.status !== 'gpu_replay_plan_bound_non_promotable'
      || value.productionAuthorityRequired !== true
      || !Object.values(SCOPES).includes(value.replayScope)
      || !hash(value.replayRuntimeIdentityHash)
      || !hash(value.replayDeviceIdentityHash)
      || !hash(value.replayHardwareFingerprintHash)
      || !hash(value.originalRuntimeIdentityHash)
      || !hash(value.originalObservationHash)) return false;
    canonicalBudget(value.errorBudget);
    const payload = { ...value };
    delete payload.gpuReplayPlanHash;
    return hashRecord('GpuReplayPlan', payload) === value.gpuReplayPlanHash;
  } catch {
    return false;
  }
}

export function buildGpuReplayReceipt({
  plan,
  originalObservation,
  replayObservation,
  comparison,
  independentOperatorAttestationHash = null,
} = {}) {
  const blockers = [];
  let canonicalOriginal = null;
  let canonicalReplay = null;
  let canonicalComparisonValue = null;
  try {
    if (!verifyGpuReplayPlan(plan)) throw new Error('gpu_replay_plan_invalid');
    canonicalOriginal = canonicalObservation(originalObservation);
    canonicalReplay = canonicalObservation(replayObservation);
    canonicalComparisonValue = canonicalComparison(comparison);
  } catch (error) {
    blockers.push(error?.message || 'gpu_replay_input_invalid');
  }
  if (canonicalOriginal && canonicalReplay) {
    if (hashRecord('GpuReplayObservation', canonicalOriginal)
      !== plan.originalObservationHash) blockers.push('gpu_replay_original_observation_mismatch');
    if (!sameLineage(canonicalOriginal, canonicalReplay)) blockers.push('gpu_replay_lineage_mismatch');
    if (canonicalReplay.runtimeIdentityHash !== plan.replayRuntimeIdentityHash) {
      blockers.push('gpu_replay_runtime_identity_mismatch');
    }
    if (canonicalReplay.deviceIdentityHash !== plan.replayDeviceIdentityHash) {
      blockers.push('gpu_replay_device_identity_mismatch');
    }
    if (canonicalReplay.hardwareFingerprintHash !== plan.replayHardwareFingerprintHash) {
      blockers.push('gpu_replay_hardware_identity_mismatch');
    }
    blockers.push(...compareMetrics(canonicalOriginal, canonicalReplay, plan.errorBudget));
    if (plan.replayScope === SCOPES.sameDevice
      && plan.errorBudget.requireByteIdentityOnSameDevice
      && (!canonicalComparisonValue.byteIdentical
        || canonicalComparisonValue.maximumAbsoluteError !== 0
        || canonicalComparisonValue.relativeOutputL2 !== 0)) {
      blockers.push('gpu_replay_same_device_not_bitwise_identical');
    }
    if (canonicalComparisonValue.maximumAbsoluteError > plan.errorBudget.maximumAbsoluteOutputError
      || canonicalComparisonValue.relativeOutputL2 > plan.errorBudget.maximumRelativeOutputL2) {
      blockers.push('gpu_replay_output_outside_budget');
    }
    if (plan.replayScope === SCOPES.secondHardware
      && !independentOperatorAttestationHash) {
      blockers.push('gpu_replay_independent_operator_attestation_required');
    } else if (independentOperatorAttestationHash
      && !hash(independentOperatorAttestationHash)) {
      blockers.push('gpu_replay_independent_operator_attestation_invalid');
    }
  }
  // This local contract never verifies an external signature.  Keep the
  // authority blocker even when all numerical checks pass.
  blockers.push('gpu_replay_external_authority_required');
  const uniqueBlockers = Object.freeze([...new Set(blockers.map(String))].sort());
  const scientificallyValid = uniqueBlockers.length === 1
    && uniqueBlockers[0] === 'gpu_replay_external_authority_required';
  const payload = {
    version: 1,
    kind: 'GpuReplayReceipt',
    status: scientificallyValid ? 'gpu_replay_verified_non_promotable' : 'gpu_replay_blocked',
    replayScope: plan?.replayScope || null,
    replayPlanHash: plan?.gpuReplayPlanHash || null,
    originalObservationHash: canonicalOriginal
      ? hashRecord('GpuReplayObservation', canonicalOriginal) : null,
    originalObservation: canonicalOriginal,
    replayObservationHash: canonicalReplay
      ? hashRecord('GpuReplayObservation', canonicalReplay) : null,
    replayObservation: canonicalReplay,
    comparison: canonicalComparisonValue,
    errorBudget: plan?.errorBudget || GPU_REPLAY_ERROR_BUDGET,
    scientificChecksPassed: scientificallyValid,
    productionPromotionEligible: false,
    productionBlockers: GPU_REPLAY_PRODUCTION_BLOCKERS,
    blockers: uniqueBlockers,
  };
  return deepFreezeJsonValue({
    ...payload,
    gpuReplayReceiptHash: hashRecord('GpuReplayReceipt', payload),
  });
}

export function verifyGpuReplayReceipt(value) {
  try {
    if (!exactPlainObject(value, RECEIPT_KEYS)
      || value.version !== 1
      || value.kind !== 'GpuReplayReceipt'
      || value.productionPromotionEligible !== false
      || !jsonEqual(value.productionBlockers, GPU_REPLAY_PRODUCTION_BLOCKERS)
      || !Array.isArray(value.blockers)
      || !value.errorBudget) return false;
    canonicalBudget(value.errorBudget);
    if (value.originalObservation !== null
      && !verifyGpuReplayObservation(value.originalObservation)) return false;
    if (value.replayObservation !== null
      && !verifyGpuReplayObservation(value.replayObservation)) return false;
    if (value.comparison !== null) canonicalComparison(value.comparison);
    const payload = { ...value };
    delete payload.gpuReplayReceiptHash;
    return hashRecord('GpuReplayReceipt', payload) === value.gpuReplayReceiptHash;
  } catch {
    return false;
  }
}
