import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

import {
  buildBubblewrapWorkerCommand,
  buildDockerWorkerCommand,
  normalizeNvidiaGpuDeviceSelector,
  parseNvidiaGpuDeviceSelectorList,
} from '../../paper-adapters/runtime/docker-worker-command.mjs';
import {
  createOsSandboxedWorkerRunnerForTest as createOsSandboxedWorkerRunner,
} from './support/os-sandboxed-worker-runner-test-driver.mjs';
import {
  createOsSandboxedWorkerRunner as createProductionOsSandboxedWorkerRunner,
} from '../../paper-adapters/runtime/os-sandboxed-worker-runner.mjs';
import {
  inspectNvidiaGpuDeviceCapacity,
  parseNvidiaGpuDeviceCapacityRows,
} from '../../paper-adapters/runtime/nvidia-gpu-device-capacity-observer.mjs';
import {
  buildGpuDispatchMemoryAdmissionRequirement,
  buildNvidiaGpuDeviceCapacityObservation,
} from '../../paper-domain/automation/nvidia-gpu-device-capacity-contract.mjs';
import {
  verifyOsSandboxWorkerReceipt,
  verifyProductionOsSandboxWorkerReceipt,
} from '../../paper-domain/automation/os-sandbox-worker-receipt-contract.mjs';
import { hashRecord } from '../../workflow-kernel/record-hash.mjs';

const GPU_UUID = 'GPU-a33875b7-7eb7-679e-df08-19227d3decee';

function dockerCommand(overrides = {}) {
  return buildDockerWorkerCommand({
    limits: { memory: 1024, cpu: 1, pids: 8 },
    uid: 1000,
    gid: 1000,
    environment: [],
    requiresGpu: false,
    systemMounts: [],
    workRoot: '/fixture/work',
    outputRoot: '/fixture/output',
    supervisorRoot: '/fixture/supervisor',
    runtimeExecutableSnapshot: null,
    mountedDatasets: [],
    relativeCwd: '',
    containerImageDigest: `sha256:${'a'.repeat(64)}`,
    executable: 'python3',
    arguments: ['run.py'],
    ...overrides,
  });
}

test('GPU selector normalization accepts one GPU UUID and rejects broad selectors', () => {
  assert.equal(normalizeNvidiaGpuDeviceSelector(GPU_UUID.toUpperCase()), GPU_UUID);
  assert.equal(normalizeNvidiaGpuDeviceSelector('all'), null);
  assert.equal(normalizeNvidiaGpuDeviceSelector('0'), null);
  assert.equal(normalizeNvidiaGpuDeviceSelector(`${GPU_UUID},GPU-${'1'.repeat(32)}`), null);
  assert.deepEqual(parseNvidiaGpuDeviceSelectorList(`${GPU_UUID}\n${GPU_UUID.toUpperCase()}\ninvalid\n`), [GPU_UUID]);
  const [capacity] = parseNvidiaGpuDeviceCapacityRows(`${GPU_UUID}, 8188, 5924\n`);
  assert.equal(capacity.gpuDeviceSelector, GPU_UUID);
  assert.equal(capacity.totalMemoryBytes, 8188 * 1024 ** 2);
  assert.equal(capacity.freeMemoryBytes, 5924 * 1024 ** 2);
  assert.equal(capacity.gpuMemoryIsolationClaimed, false);
  assert.equal(capacity.multiTenantExclusivityClaimed, false);
  assert.deepEqual(parseNvidiaGpuDeviceCapacityRows(
    `${GPU_UUID}, 8188, not-a-number\n`,
  ), []);
  assert.deepEqual(parseNvidiaGpuDeviceCapacityRows(`${GPU_UUID}, 8188\n`), []);
});

test('Docker GPU command pins exactly one UUID without claiming MIG or VRAM isolation', () => {
  const command = dockerCommand({ requiresGpu: true, gpuDeviceSelector: GPU_UUID });
  assert.ok(command.includes(`device=${GPU_UUID}`));
  assert.ok(command.includes(`NVIDIA_VISIBLE_DEVICES=${GPU_UUID}`));
  assert.equal(command.includes('--runtime'), false);
  assert.equal(command.some((value) => String(value).includes('NVIDIA_VISIBLE_DEVICES=all')), false);
  assert.throws(() => dockerCommand({ requiresGpu: true }), /gpu_device_selector_invalid/);
  assert.throws(() => dockerCommand({ requiresGpu: true, gpuDeviceSelector: 'all' }), /gpu_device_selector_invalid/);
  assert.throws(() => dockerCommand({ gpuDeviceSelector: GPU_UUID }), /selector_without_gpu_request/);
  const cpuCommand = dockerCommand();
  assert.equal(cpuCommand.includes('--gpus'), false);
  assert.equal(cpuCommand.some((value) => String(value).startsWith('NVIDIA_VISIBLE_DEVICES=')), false);
});

test('Bubblewrap refuses GPU requests because device UUID isolation is not established', () => {
  assert.throws(() => buildBubblewrapWorkerCommand({
    limits: { memory: 1024, cpu: 1, pids: 8 },
    bubblewrap: 'bwrap',
    texMounts: [],
    runtimeMounts: [],
    workRoot: '/fixture/work',
    outputRoot: '/fixture/output',
    runtimeExecutableSnapshot: null,
    mountedDatasets: [],
    relativeCwd: '',
    requiresGpu: true,
    environment: [],
    executable: 'python3',
    arguments: ['run.py'],
  }), /bubblewrap_gpu_device_isolation_unsupported/);
});

test('GPU dispatch admission rechecks free VRAM immediately before execution', (t) => {
  if (!fs.existsSync('/dev/nvidia0')) {
    t.skip('NVIDIA GPU device unavailable');
    return;
  }
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hepta-gpu-admission-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.writeFileSync(path.join(root, 'run.py'), 'print(1)\n');
  const image = 'fixture/python-gpu:locked';
  const digest = `sha256:${'d'.repeat(64)}`;
  const planning = buildNvidiaGpuDeviceCapacityObservation({
    gpuDeviceSelector: GPU_UUID,
    reportedTotalMemoryMiB: 8_188,
    reportedFreeMemoryMiB: 1_200,
  });
  const admission = buildGpuDispatchMemoryAdmissionRequirement({
    gpuDeviceSelector: GPU_UUID,
    gpuMemoryCapacityPlanHash: `sha256:${'1'.repeat(64)}`,
    capacityPolicyId: 'fixture-total-and-free-v1',
    planningCapacityObservationHash:
      planning.nvidiaGpuDeviceCapacityObservationHash,
    planningTotalMemoryBytes: planning.totalMemoryBytes,
    planningFreeMemoryBytes: planning.freeMemoryBytes,
    estimatedPeakVramBytes: 256 * 1024 ** 2,
    minimumFreeMemoryHeadroomBytes: 512 * 1024 ** 2,
  });
  const runSpec = {
    executable: 'python3', containerImage: image, containerExecutable: 'python3',
    args: ['run.py'], cwd: root, sourceRoot: root, requiresGpu: true,
    gpuDeviceSelector: GPU_UUID, gpuDispatchMemoryAdmission: admission,
  };
  const runnerFor = (dispatchFreeMiB, onExecute) => {
    let observations = 0;
    return createOsSandboxedWorkerRunner({
      allowedExecutables: ['python3'], allowedRoots: [root],
      allowedContainerImages: [image], allowGpu: true,
      probe: { available: true, backend: 'docker', status: 'os_sandbox_available', image },
      imageDigestResolver: (candidate) => candidate === image ? digest : null,
      gpuDeviceCapacityObserver() {
        observations += 1;
        return buildNvidiaGpuDeviceCapacityObservation({
          gpuDeviceSelector: GPU_UUID,
          reportedTotalMemoryMiB: 8_188,
          reportedFreeMemoryMiB: observations === 1 ? 1_100 : dispatchFreeMiB,
        });
      },
      executor() { onExecute(); return { status: 0, stdout: '', stderr: '' }; },
    });
  };
  let insufficientExecutions = 0;
  const insufficient = runnerFor(700, () => { insufficientExecutions += 1; })
    .run(runSpec);
  assert.equal(insufficient.ok, false);
  assert.deepEqual(insufficient.blockers,
    ['worker_gpu_dispatch_memory_capacity_insufficient']);
  assert.equal(insufficientExecutions, 0);
  assert.equal(insufficient.gpuDispatchMemoryAdmissionEvaluation
    .freeMemoryRequirementSatisfied, false);

  let sufficientExecutions = 0;
  const sufficientRunner = runnerFor(1_024, () => { sufficientExecutions += 1; });
  const sufficient = sufficientRunner.run(runSpec);
  assert.equal(sufficient.ok, true, JSON.stringify(sufficient.blockers));
  assert.equal(sufficientExecutions, 1);
  assert.equal(sufficient.gpuDeviceRequest.version, 3);
  assert.notEqual(sufficient.gpuDeviceRequest.capacityObservationHash,
    admission.planningCapacityObservationHash);
  assert.equal(sufficient.gpuDeviceRequest.dispatchMemoryAdmissionEvaluation
    .admissionSatisfied, true);
  assert.equal(verifyOsSandboxWorkerReceipt(sufficient), true);

  const cpu = sufficientRunner.run({
    executable: 'python3', containerImage: image, containerExecutable: 'python3',
    args: ['run.py'], cwd: root, sourceRoot: root,
    gpuDispatchMemoryAdmission: admission,
  });
  assert.equal(cpu.ok, false);
  assert.ok(cpu.blockers.includes(
    'worker_gpu_dispatch_memory_admission_without_gpu_request',
  ));
  assert.equal(sufficientExecutions, 1);
});

test('GPU fixture worker binds one observed UUID but cannot mint production evidence', (t) => {
  const observation = spawnSync('/usr/bin/nvidia-smi', [
    '--query-gpu=uuid', '--format=csv,noheader',
  ], { encoding: 'utf8', timeout: 5000 });
  const [selector] = observation.status === 0
    ? parseNvidiaGpuDeviceSelectorList(observation.stdout) : [];
  if (!selector || !fs.existsSync('/dev/nvidia0')) {
    t.skip('NVIDIA GPU UUID unavailable');
    return;
  }
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hepta-gpu-selector-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.writeFileSync(path.join(root, 'run.py'), 'print(1)\n');
  const image = 'fixture/python-gpu:locked';
  const digest = `sha256:${'d'.repeat(64)}`;
  let command = [];
  const runner = createOsSandboxedWorkerRunner({
    allowedExecutables: ['python3'],
    allowedRoots: [root],
    allowedContainerImages: [image],
    allowGpu: true,
    probe: { available: true, backend: 'docker', status: 'os_sandbox_available', image },
    imageDigestResolver: (candidate) => candidate === image ? digest : null,
    executor(_launcher, args) {
      command = args;
      return { status: 0, stdout: '', stderr: '' };
    },
  });
  const missing = runner.run({
    executable: 'python3', containerImage: image, containerExecutable: 'python3',
    args: ['run.py'], cwd: root, sourceRoot: root, requiresGpu: true,
  });
  assert.equal(missing.ok, false);
  assert.ok(missing.blockers.includes('worker_gpu_device_selector_invalid'));
  const receipt = runner.run({
    executable: 'python3', containerImage: image, containerExecutable: 'python3',
    args: ['run.py'], cwd: root, sourceRoot: root, requiresGpu: true,
    gpuDeviceSelector: selector,
  });
  assert.equal(receipt.ok, true, JSON.stringify(receipt.blockers));
  assert.equal(receipt.version, 5);
  assert.equal(receipt.executionProcessInvocation.executableTarget, 'python3');
  assert.deepEqual(receipt.executionProcessInvocation.arguments, ['run.py']);
  assert.equal(receipt.executionProcessInvocation.workingDirectory, '/work');
  assert.deepEqual(receipt.executionProcessInvocation.standardInput, {
    present: false, sha256: null, byteLength: 0,
  });
  assert.equal(receipt.executionProcessInvocation.processInvocationId,
    receipt.executionProcessIdentity.processInvocationId);
  assert.equal(receipt.gpuDeviceRequest.deviceSelector, selector);
  assert.equal(receipt.gpuDeviceRequest.version, 2);
  assert.equal(receipt.gpuDeviceRequest.requestedDeviceCount, 1);
  assert.equal(receipt.gpuDeviceRequest.hostDeviceObserved, true);
  const trustedCapacity = inspectNvidiaGpuDeviceCapacity(selector);
  assert.equal(receipt.gpuDeviceRequest.capacityObservationHash,
    trustedCapacity.nvidiaGpuDeviceCapacityObservationHash);
  assert.equal(receipt.gpuDeviceRequest.observedTotalMemoryBytes,
    trustedCapacity.totalMemoryBytes);
  assert.equal(receipt.gpuDeviceRequest.observedFreeMemoryBytes,
    trustedCapacity.freeMemoryBytes);
  assert.equal(receipt.gpuDeviceRequest.capacityObservation.gpuMemoryIsolationClaimed,
    false);
  assert.equal(receipt.gpuDeviceRequest.capacityObservation
    .multiTenantExclusivityClaimed, false);
  assert.equal(receipt.isolation.gpuDeviceIsolationVerified, true);
  assert.equal(receipt.isolation.gpuMemoryIsolationVerified, false);
  assert.equal(receipt.isolation.gpuMigIsolationVerified, false);
  assert.equal(receipt.evidenceClass, 'verification-fixture-v1');
  assert.equal(receipt.productionEvidenceEligible, false);
  assert.ok(command.includes(`device=${selector}`));
  assert.equal(verifyOsSandboxWorkerReceipt(receipt), true);
  assert.equal(verifyProductionOsSandboxWorkerReceipt(receipt), false);

  const legacy = structuredClone(receipt);
  legacy.version = 4;
  delete legacy.executionProcessInvocation;
  delete legacy.executionProcessInvocationHash;
  const legacyPayload = { ...legacy };
  delete legacyPayload.ok;
  delete legacyPayload.receiptHash;
  delete legacyPayload.blockers;
  legacy.receiptHash = hashRecord('OsSandboxWorkerReceipt', legacyPayload);
  assert.equal(verifyOsSandboxWorkerReceipt(legacy), true);
  assert.equal(verifyProductionOsSandboxWorkerReceipt(legacy), false);

  const invocationTamper = structuredClone(receipt);
  invocationTamper.executionProcessInvocation.arguments[0] = '/work/other.py';
  const invocationPayload = { ...invocationTamper };
  delete invocationPayload.ok;
  delete invocationPayload.receiptHash;
  delete invocationPayload.blockers;
  invocationTamper.receiptHash = hashRecord(
    'OsSandboxWorkerReceipt', invocationPayload,
  );
  assert.equal(verifyOsSandboxWorkerReceipt(invocationTamper), false);

  const forged = structuredClone(receipt);
  forged.gpuDeviceRequest.requestedDeviceCount = 2;
  const payload = { ...forged };
  delete payload.ok;
  delete payload.receiptHash;
  delete payload.blockers;
  forged.receiptHash = hashRecord('OsSandboxWorkerReceipt', payload);
  assert.equal(verifyProductionOsSandboxWorkerReceipt(forged), false);

  const capacityForgery = structuredClone(receipt);
  capacityForgery.gpuDeviceRequest.observedTotalMemoryBytes += 1024 ** 3;
  const capacityPayload = { ...capacityForgery };
  delete capacityPayload.ok;
  delete capacityPayload.receiptHash;
  delete capacityPayload.blockers;
  capacityForgery.receiptHash = hashRecord('OsSandboxWorkerReceipt', capacityPayload);
  assert.equal(verifyOsSandboxWorkerReceipt(capacityForgery), false);
  const freeCapacityForgery = structuredClone(receipt);
  freeCapacityForgery.gpuDeviceRequest.observedFreeMemoryBytes += 1024 ** 2;
  const freeCapacityPayload = { ...freeCapacityForgery };
  delete freeCapacityPayload.ok;
  delete freeCapacityPayload.receiptHash;
  delete freeCapacityPayload.blockers;
  freeCapacityForgery.receiptHash = hashRecord(
    'OsSandboxWorkerReceipt', freeCapacityPayload,
  );
  assert.equal(verifyOsSandboxWorkerReceipt(freeCapacityForgery), false);
});

test('production GPU runner facade rejects all dependency injection', () => {
  let poisonCalls = 0;
  for (const injected of [
    { executor() { poisonCalls += 1; } },
    { gpuDeviceCapacityObserver() { poisonCalls += 1; } },
    { probe: { available: true, backend: 'docker' } },
    { imageDigestResolver() { poisonCalls += 1; } },
  ]) {
    assert.throws(
      () => createProductionOsSandboxedWorkerRunner(injected),
      /os_sandbox_worker_dependency_injection_forbidden/,
    );
  }
  assert.equal(poisonCalls, 0);
});
