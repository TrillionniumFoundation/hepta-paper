import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildGpuReplayObservation,
  buildGpuReplayPlan,
  buildGpuReplayReceipt,
  buildScientificRunIrBinding,
  GPU_REPLAY_ERROR_BUDGET,
  GPU_REPLAY_SCOPES,
  verifyGpuReplayObservation,
  verifyGpuReplayPlan,
  verifyGpuReplayReceipt,
  verifyScientificRunIrBinding,
} from '../../paper-domain/research/p0-pde-dl-assurance/gpu-replay-assurance-contract.mjs';
import {
  buildProcessIsolatedDeepLearningCpuOracleAssurance,
} from '../../paper-domain/research/process-isolated-deep-learning-independent-cpu-oracle-contract.mjs';
import { hashRecord } from '../../workflow-kernel/record-hash.mjs';

const H = (label) => hashRecord('P0PdeDlAssuranceFixture', { label });

function observation({
  runId = 'run-original',
  device = 'device-a',
  hardware = 'hardware-a',
  runtime = 'runtime-a',
  output = 'output-a',
  metrics = [{ name: 'accuracy', value: 0.75 }, { name: 'cross_entropy', value: 0.5 }],
} = {}) {
  return buildGpuReplayObservation({
    capabilityKind: 'cupy-single-gpu-supervised-classification-fp32-v1',
    modelIrHash: H('model-ir'),
    dataIrHash: H('data-ir'),
    checkpointIrHash: H('checkpoint-ir'),
    runtimeBomHash: H('runtime-bom'),
    runtimeIdentityHash: H(runtime),
    runtimeImageDigest: H('image'),
    deviceIdentityHash: H(device),
    hardwareFingerprintHash: H(hardware),
    deterministicConfigHash: H('deterministic-config'),
    deterministicAlgorithmsConfigured: true,
    sourceImplementationHash: H('implementation'),
    outputArtifactHash: H(output),
    outputByteLength: 128,
    metrics,
    runId,
  });
}

test('scientific run IR envelope binds model, data, checkpoint and runtime without executable payloads', () => {
  const ir = buildScientificRunIrBinding({
    capabilityKind: 'cupy-single-gpu-supervised-classification-fp32-v1',
    runId: 'ir-run',
    modelIrHash: H('model-ir'),
    dataIrHash: H('data-ir'),
    checkpointIrHash: H('checkpoint-ir'),
    runtimeBomHash: H('runtime-bom'),
    sourceImplementationHash: H('implementation'),
    deterministicPolicyHash: H('deterministic-policy'),
  });
  assert.equal(ir.executablePayloadAllowed, false);
  assert.equal(verifyScientificRunIrBinding(ir), true);
  const tampered = structuredClone(ir);
  tampered.executablePayloadAllowed = true;
  assert.equal(verifyScientificRunIrBinding(tampered), false);
});

test('same-device replay requires exact identity and is non-promotable without authority', () => {
  const original = observation();
  assert.equal(verifyGpuReplayObservation(original), true);
  const plan = buildGpuReplayPlan({
    originalObservation: original,
    replayScope: GPU_REPLAY_SCOPES.sameDevice,
    replayDeviceIdentityHash: original.deviceIdentityHash,
    replayHardwareFingerprintHash: original.hardwareFingerprintHash,
    replayRuntimeIdentityHash: H('runtime-same-device'),
  });
  assert.equal(verifyGpuReplayPlan(plan), true);
  const replay = observation({
    runId: 'run-replay',
    runtime: 'runtime-same-device',
  });
  const receipt = buildGpuReplayReceipt({
    plan,
    originalObservation: original,
    replayObservation: replay,
    comparison: {
      byteIdentical: true,
      maximumAbsoluteError: 0,
      relativeOutputL2: 0,
    },
  });
  assert.equal(receipt.status, 'gpu_replay_verified_non_promotable');
  assert.equal(receipt.scientificChecksPassed, true);
  assert.equal(receipt.productionPromotionEligible, false);
  assert.deepEqual(receipt.blockers, ['gpu_replay_external_authority_required']);
  assert.equal(verifyGpuReplayReceipt(receipt), true);
});

test('second-hardware replay must be distinct and cannot claim evidence without operator attestation', () => {
  const original = observation();
  const plan = buildGpuReplayPlan({
    originalObservation: original,
    replayScope: GPU_REPLAY_SCOPES.secondHardware,
    replayDeviceIdentityHash: H('device-b'),
    replayHardwareFingerprintHash: H('hardware-b'),
    replayRuntimeIdentityHash: H('runtime-b'),
  });
  const replay = observation({
    runId: 'run-second-hardware',
    device: 'device-b',
    hardware: 'hardware-b',
    runtime: 'runtime-b',
    output: 'output-b',
    metrics: [{ name: 'accuracy', value: 0.75001 }, { name: 'cross_entropy', value: 0.50001 }],
  });
  const receipt = buildGpuReplayReceipt({
    plan,
    originalObservation: original,
    replayObservation: replay,
    comparison: {
      byteIdentical: false,
      maximumAbsoluteError: 1e-12,
      relativeOutputL2: 1e-12,
    },
  });
  assert.equal(receipt.status, 'gpu_replay_blocked');
  assert.equal(receipt.scientificChecksPassed, false);
  assert.ok(receipt.blockers.includes(
    'gpu_replay_independent_operator_attestation_required',
  ));
  assert.equal(receipt.productionPromotionEligible, false);
  assert.equal(verifyGpuReplayReceipt(receipt), true);
  assert.deepEqual(GPU_REPLAY_ERROR_BUDGET, receipt.errorBudget);
});

test('identity drift and metric drift fail closed', () => {
  const original = observation();
  assert.throws(() => buildGpuReplayPlan({
    originalObservation: original,
    replayScope: GPU_REPLAY_SCOPES.sameDevice,
    replayDeviceIdentityHash: H('other-device'),
    replayHardwareFingerprintHash: original.hardwareFingerprintHash,
    replayRuntimeIdentityHash: H('runtime'),
  }), /same_device_identity_mismatch/);
  const plan = buildGpuReplayPlan({
    originalObservation: original,
    replayScope: GPU_REPLAY_SCOPES.secondHardware,
    replayDeviceIdentityHash: H('device-b'),
    replayHardwareFingerprintHash: H('hardware-b'),
    replayRuntimeIdentityHash: H('runtime-b'),
  });
  const replay = observation({
    runId: 'run-drift', device: 'device-b', hardware: 'hardware-b', runtime: 'runtime-b',
    metrics: [{ name: 'accuracy', value: 0.1 }, { name: 'cross_entropy', value: 99 }],
  });
  const receipt = buildGpuReplayReceipt({
    plan,
    originalObservation: original,
    replayObservation: replay,
    comparison: { byteIdentical: false, maximumAbsoluteError: 0, relativeOutputL2: 0 },
    independentOperatorAttestationHash: H('operator'),
  });
  assert.ok(receipt.blockers.some((item) => item.startsWith('gpu_replay_metric_outside_budget:')));
  assert.ok(receipt.blockers.includes('gpu_replay_external_authority_required'));
  assert.equal(verifyGpuReplayReceipt(receipt), true);
});

test('DL CPU assurance requires the runtime attestation boundary and fails closed when absent', () => {
  const assurance = buildProcessIsolatedDeepLearningCpuOracleAssurance({
    absoluteDeadlineEpochMs: Date.now() + 60_000,
  });
  assert.equal(assurance.status, 'process_isolated_deep_learning_cpu_oracle_blocked');
  assert.equal(assurance.runtimeAttestation, null);
  assert.ok(assurance.blockers.includes(
    'deep_learning_cpu_oracle_runtime_attestation_invalid',
  ));
  assert.equal(assurance.productionPromotionEligible, false);
});
