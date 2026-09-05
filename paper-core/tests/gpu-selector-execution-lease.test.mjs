import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import test from 'node:test';

import {
  GPU_SELECTOR_EXECUTION_LEASE_MECHANISM,
  GPU_SELECTOR_EXECUTION_LEASE_RESIDUAL_RISK_DISCLOSURES,
  GPU_SELECTOR_EXECUTION_LEASE_SCOPE,
  buildGpuSelectorExecutionLeaseReceipt,
  buildGpuSelectorExecutionLeaseReleaseReceipt,
  buildGpuSelectorExecutionLeaseWorkerBinding,
  normalizeGpuSelectorExecutionLeaseSelector,
  verifyGpuSelectorExecutionLeaseReceipt,
  verifyGpuSelectorExecutionLeaseReleaseReceipt,
  verifyGpuSelectorExecutionLeaseWorkerBinding,
} from '../../paper-domain/automation/gpu-selector-execution-lease-contract.mjs';
import {
  assertGpuSelectorExecutionLeasePort,
} from '../../paper-ports/gpu-selector-execution-lease-port.mjs';
import {
  createGpuSelectorExecutionLeaseRepository,
  gpuSelectorExecutionLockFileName,
  gpuSelectorExecutionLeaseRootForRuntime,
} from '../../paper-adapters/runtime/gpu-selector-execution-lease-repository.mjs';
import {
  createOsSandboxWorkerGpuSelectorLeaseCoordinator,
} from '../../paper-adapters/runtime/os-sandbox-worker-gpu-selector-lease.mjs';
import {
  buildDockerWorkerContainerOwnership,
} from '../../paper-adapters/runtime/docker-worker-container-recovery.mjs';

const GPU_UUID = 'GPU-a33875b7-7eb7-679e-df08-19227d3decee';
const OTHER_GPU_UUID = 'GPU-b44875b7-7eb7-679e-df08-19227d3decee';
const H = (character) => `sha256:${character.repeat(64)}`;

function fixture(t, label) {
  const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), `hepta-${label}-`));
  const root = path.join(temporaryRoot, 'gpu-selector-leases');
  t.after(() => fs.rmSync(temporaryRoot, { recursive: true, force: true }));
  return { temporaryRoot, root };
}

function captureChild(child) {
  return new Promise((resolve, reject) => {
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.once('error', reject);
    child.once('close', (code, signal) => resolve({ code, signal, stdout, stderr }));
  });
}

function runChild(source) {
  return captureChild(spawn(
    process.execPath,
    ['--input-type=module', '--eval', source],
    {
      env: { PATH: '/usr/bin:/bin', LANG: 'C', LC_ALL: 'C' },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  ));
}

test('GPU selector lease receipts are exact, hash-bound, and never claim production exclusivity', () => {
  assert.equal(normalizeGpuSelectorExecutionLeaseSelector(GPU_UUID.toUpperCase()), GPU_UUID);
  assert.equal(normalizeGpuSelectorExecutionLeaseSelector('all'), null);
  const acquisition = buildGpuSelectorExecutionLeaseReceipt({
    gpuDeviceSelector: GPU_UUID,
    ownerAuthorityHash: H('a'),
    leaseId: H('b'),
    fencingToken: H('c'),
    lockScopeIdentityHash: H('d'),
    lockIdentityHash: H('e'),
    requestedAtEpochMs: 100,
    acquiredAtEpochMs: 101,
    absoluteDeadlineEpochMs: 200,
  });
  assert.equal(verifyGpuSelectorExecutionLeaseReceipt(acquisition), true);
  assert.equal(acquisition.productionExclusivityClaimed, false);
  const tampered = structuredClone(acquisition);
  tampered.gpuDeviceSelector = OTHER_GPU_UUID;
  assert.equal(verifyGpuSelectorExecutionLeaseReceipt(tampered), false);

  const released = buildGpuSelectorExecutionLeaseReleaseReceipt({
    acquisitionReceipt: acquisition,
    releasedAtEpochMs: 150,
  });
  assert.equal(verifyGpuSelectorExecutionLeaseReleaseReceipt(released, {
    acquisitionReceipt: acquisition,
  }), true);
  const forged = structuredClone(released);
  forged.fencingToken = H('f');
  assert.equal(verifyGpuSelectorExecutionLeaseReleaseReceipt(forged, {
    acquisitionReceipt: acquisition,
  }), false);

  const workerBinding = buildGpuSelectorExecutionLeaseWorkerBinding({
    acquisitionReceipt: acquisition,
    workerInvocationAuthorityHash: H('f'),
    absoluteDeadlineEpochMs: 200,
    leaseBoundAtLaunchEpochMs: 120,
    launchTimeoutMs: 50,
    leaseHeldAtFinalization: true,
  });
  assert.equal(verifyGpuSelectorExecutionLeaseWorkerBinding(workerBinding), true);
  assert.equal(workerBinding.productionExclusivityClaimed, false);
  assert.equal(workerBinding.multiTenantExclusivityClaimed, false);
  assert.equal(workerBinding
    .dockerDeterministicContainerNameCrashRecoveryBackstopVerified, false);
  assert.deepEqual(
    workerBinding.residualRiskDisclosures,
    GPU_SELECTOR_EXECUTION_LEASE_RESIDUAL_RISK_DISCLOSURES,
  );
  assert.ok(workerBinding.residualRiskDisclosures.includes(
    'gpu_selector_lease_holder_deadline_requires_responsive_event_loop',
  ));
  const hiddenRisk = structuredClone(workerBinding);
  hiddenRisk.residualRiskDisclosures = [];
  assert.equal(verifyGpuSelectorExecutionLeaseWorkerBinding(hiddenRisk), false);
});

test('lease capabilities distinguish bounded acquisition from cooperative holder expiry', (t) => {
  const { root } = fixture(t, 'gpu-selector-lease-capabilities');
  const repository = createGpuSelectorExecutionLeaseRepository({ root });
  const capabilities = repository.capabilities();
  assert.deepEqual(Object.keys(capabilities).sort(), [
    'abortableWait',
    'acquisitionWaitDeadlineBound',
    'asyncContextReentrant',
    'crossProcess',
    'deadlineBound',
    'holderDeadlineEnforcement',
    'holderHardDeadlineBound',
    'kind',
    'lockScopeIdentityHash',
    'mechanism',
    'perGpuUuid',
    'productionExclusivityClaimed',
    'scope',
    'version',
  ].sort());
  assert.deepEqual({
    deadlineBound: capabilities.deadlineBound,
    acquisitionWaitDeadlineBound:
      capabilities.acquisitionWaitDeadlineBound,
    holderHardDeadlineBound: capabilities.holderHardDeadlineBound,
    holderDeadlineEnforcement: capabilities.holderDeadlineEnforcement,
  }, {
    deadlineBound: false,
    acquisitionWaitDeadlineBound: true,
    holderHardDeadlineBound: false,
    holderDeadlineEnforcement:
      'cooperative_same_event_loop_watchdog_v1',
  });
  assert.equal(capabilities.mechanism,
    GPU_SELECTOR_EXECUTION_LEASE_MECHANISM);
  assert.equal(capabilities.scope, GPU_SELECTOR_EXECUTION_LEASE_SCOPE);
  assert.match(capabilities.lockScopeIdentityHash, /^sha256:[0-9a-f]{64}$/);

  assert.throws(() => assertGpuSelectorExecutionLeasePort({
    ...repository,
    capabilities: () => Object.freeze({
      ...capabilities,
      deadlineBound: true,
    }),
  }), /GpuSelectorExecutionLeasePort capabilities invalid/);
});

test('secure flock lease exposes held identity and idempotent release receipts', async (t) => {
  const { root } = fixture(t, 'gpu-selector-lease-basic');
  const repository = createGpuSelectorExecutionLeaseRepository({ root });
  const lease = await repository.acquire({
    gpuDeviceSelector: GPU_UUID,
    ownerAuthorityHash: H('1'),
    absoluteDeadlineEpochMs: Date.now() + 2_000,
  });
  assert.equal(lease.assertHeld(), true);
  assert.equal(verifyGpuSelectorExecutionLeaseReceipt(lease.receipt), true);
  assert.equal(repository.currentLease(), null);
  const first = lease.release();
  const second = lease.release();
  assert.equal(first, second);
  assert.equal(verifyGpuSelectorExecutionLeaseReleaseReceipt(first, {
    acquisitionReceipt: lease.receipt,
  }), true);
  assert.throws(() => lease.assertHeld(), /gpu_selector_execution_lease_released/);
});

test('quarantine relinquishes the OFD lock but preserves durable recovery fencing', async (t) => {
  const { root } = fixture(t, 'gpu-selector-lease-quarantine-relinquish');
  let recoveryAllowed = false;
  let recoveryCount = 0;
  const repository = createGpuSelectorExecutionLeaseRepository({
    root,
    recoverStaleState() {
      recoveryCount += 1;
      return { recovered: recoveryAllowed, receipt: null };
    },
  });
  const request = {
    gpuDeviceSelector: GPU_UUID,
    ownerAuthorityHash: H('2'),
    absoluteDeadlineEpochMs: Date.now() + 5_000,
  };
  let quarantinedLease;
  assert.equal(await repository.withLease(request, async (lease) => {
    quarantinedLease = lease;
    lease.quarantine('fixture_recovery_required');
    return 'quarantined';
  }), 'quarantined');
  assert.throws(() => quarantinedLease.assertHeld(),
    /gpu_selector_execution_lease_released/);

  await assert.rejects(repository.acquire({
    ...request,
    ownerAuthorityHash: H('3'),
  }), /gpu_selector_execution_lease_recovery_required/);
  assert.equal(recoveryCount, 1);

  recoveryAllowed = true;
  const recovered = await repository.acquire({
    ...request,
    ownerAuthorityHash: H('4'),
  });
  assert.equal(recoveryCount, 2);
  recovered.release();
});

test('AsyncLocalStorage exposes the held lease but rejects nested worker operations', async (t) => {
  const { temporaryRoot, root } = fixture(t, 'gpu-selector-lease-reentrant');
  const repository = createGpuSelectorExecutionLeaseRepository({ root });
  const otherScope = createGpuSelectorExecutionLeaseRepository({
    root: path.join(temporaryRoot, 'other-gpu-selector-leases'),
  });
  let outerLease = null;
  const ownerAuthorityHash = H('2');
  const absoluteDeadlineEpochMs = Date.now() + 10_000;
  const result = await repository.withLease({
    gpuDeviceSelector: GPU_UUID,
    ownerAuthorityHash,
    absoluteDeadlineEpochMs,
  }, async (lease) => {
    outerLease = lease;
    assert.equal(repository.currentLease({ gpuDeviceSelector: GPU_UUID }), lease);
    await assert.rejects(repository.withLease({
      gpuDeviceSelector: GPU_UUID,
      ownerAuthorityHash,
      absoluteDeadlineEpochMs,
    }, async () => null),
    /gpu_selector_execution_lease_nested_worker_operation_forbidden/);
    await assert.rejects(repository.withLease({
      gpuDeviceSelector: GPU_UUID,
      ownerAuthorityHash: H('3'),
      absoluteDeadlineEpochMs,
    }, async () => null), /gpu_selector_execution_lease_reentrant_owner_mismatch/);
    await assert.rejects(repository.withLease({
      gpuDeviceSelector: GPU_UUID,
      ownerAuthorityHash,
      absoluteDeadlineEpochMs: absoluteDeadlineEpochMs - 1,
    }, async () => null), /gpu_selector_execution_lease_reentrant_deadline_mismatch/);
    await assert.rejects(repository.withLease({
      gpuDeviceSelector: OTHER_GPU_UUID,
      ownerAuthorityHash,
      absoluteDeadlineEpochMs,
    }, async () => null), /gpu_selector_execution_lease_reentrant_selector_mismatch/);
    await assert.rejects(otherScope.withLease({
      gpuDeviceSelector: GPU_UUID,
      ownerAuthorityHash,
      absoluteDeadlineEpochMs,
    }, async () => null), /gpu_selector_execution_lease_reentrant_scope_mismatch/);
    return 'completed';
  });
  assert.equal(result, 'completed');
  assert.equal(repository.currentLease(), null);
  assert.throws(() => outerLease.assertHeld(), /gpu_selector_execution_lease_released/);
});

test('an opaque outer-owner delegation permits one sequential canonical worker lane', async (t) => {
  const { root } = fixture(t, 'gpu-selector-lease-delegated-worker');
  const repository = createGpuSelectorExecutionLeaseRepository({ root });
  const outerOwnerAuthorityHash = H('3');
  const absoluteDeadlineEpochMs = Date.now() + 10_000;
  const outerRequest = {
    gpuDeviceSelector: GPU_UUID,
    ownerAuthorityHash: outerOwnerAuthorityHash,
    absoluteDeadlineEpochMs,
  };
  await repository.withLease(outerRequest, async (outerLease) => {
    const delegation = outerLease.workerDelegation();
    const delegatedRequest = {
      gpuDeviceSelector: GPU_UUID,
      ownerAuthorityHash: H('4'),
      absoluteDeadlineEpochMs,
      gpuSelectorExecutionLeaseDelegation: delegation,
      gpuSelectorExecutionLeaseDelegationAuthorityHash:
        outerOwnerAuthorityHash,
    };
    assert.equal(await repository.withLease(
      delegatedRequest,
      async (workerLease) => workerLease,
    ), outerLease);
    assert.equal(await repository.withLease(
      { ...delegatedRequest, ownerAuthorityHash: H('5') },
      async (workerLease) => workerLease.leaseId,
    ), outerLease.leaseId);
    await assert.rejects(repository.withLease({
      ...delegatedRequest,
      gpuSelectorExecutionLeaseDelegation: Object.freeze({ ...delegation }),
    }, async () => null), /gpu_selector_execution_lease_delegation_invalid/);
    await assert.rejects(repository.withLease({
      ...delegatedRequest,
      gpuSelectorExecutionLeaseDelegationAuthorityHash: H('6'),
    }, async () => null), /gpu_selector_execution_lease_delegation_invalid/);
    await assert.rejects(repository.withLease({
      ...delegatedRequest,
      absoluteDeadlineEpochMs: absoluteDeadlineEpochMs - 1,
    }, async () => null), /gpu_selector_execution_lease_reentrant_deadline_mismatch/);

    let enterFirstWorker;
    let finishFirstWorker;
    const firstWorkerEntered = new Promise((resolve) => { enterFirstWorker = resolve; });
    const finishFirstWorkerPromise = new Promise(
      (resolve) => { finishFirstWorker = resolve; },
    );
    const firstWorker = repository.withLease(delegatedRequest, async () => {
      enterFirstWorker();
      await finishFirstWorkerPromise;
    });
    await firstWorkerEntered;
    await assert.rejects(repository.withLease(
      delegatedRequest,
      async () => null,
    ), /gpu_selector_execution_lease_nested_worker_operation_forbidden/);
    finishFirstWorker();
    await firstWorker;
  });
});

test('parallel nested worker operations fail closed before launch', async (t) => {
  const { root } = fixture(t, 'gpu-selector-lease-nested-lane');
  const repository = createGpuSelectorExecutionLeaseRepository({ root });
  const request = {
    gpuDeviceSelector: GPU_UUID,
    ownerAuthorityHash: H('4'),
    absoluteDeadlineEpochMs: Date.now() + 10_000,
  };
  await repository.withLease(request, async () => {
    let started = 0;
    const worker = () => repository.withLease(request, async () => {
      started += 1;
    });
    const outcomes = await Promise.allSettled([worker(), worker()]);
    assert.equal(started, 0);
    assert.equal(outcomes.every((outcome) => (
      outcome.status === 'rejected'
        && /nested_worker_operation_forbidden/.test(outcome.reason?.message)
    )), true);
  });
});

test('contended acquisition honors AbortSignal and absolute deadline', async (t) => {
  const { root } = fixture(t, 'gpu-selector-lease-wait');
  const holderRepository = createGpuSelectorExecutionLeaseRepository({ root });
  const waiterRepository = createGpuSelectorExecutionLeaseRepository({ root });
  const holder = await holderRepository.acquire({
    gpuDeviceSelector: GPU_UUID,
    ownerAuthorityHash: H('6'),
    absoluteDeadlineEpochMs: Date.now() + 2_000,
  });
  const controller = new AbortController();
  const waiting = waiterRepository.acquire({
    gpuDeviceSelector: GPU_UUID,
    ownerAuthorityHash: H('7'),
    absoluteDeadlineEpochMs: Date.now() + 2_000,
    signal: controller.signal,
  });
  setTimeout(() => controller.abort('fixture-cancel'), 25);
  await assert.rejects(waiting, (error) => (
    error?.code === 'gpu_selector_execution_lease_acquire_aborted'
      && error.retryable === true
  ));
  await assert.rejects(waiterRepository.acquire({
    gpuDeviceSelector: GPU_UUID,
    ownerAuthorityHash: H('8'),
    absoluteDeadlineEpochMs: Date.now() + 60,
  }), /gpu_selector_execution_lease_deadline_exhausted/);
  holder.release();
});

test('responsive holder deadline watchdog fences expiry and releases its OFD lock', async (t) => {
  const { root } = fixture(t, 'gpu-selector-lease-holder-deadline');
  const holderRepository = createGpuSelectorExecutionLeaseRepository({ root });
  let recoveredState = null;
  const waiterRepository = createGpuSelectorExecutionLeaseRepository({
    root,
    recoverStaleState({ state }) {
      recoveredState = state;
      return { recovered: true, receipt: null };
    },
  });
  const holderDeadlineEpochMs = Date.now() + 250;
  const holder = await holderRepository.acquire({
    gpuDeviceSelector: GPU_UUID,
    ownerAuthorityHash: H('8'),
    absoluteDeadlineEpochMs: holderDeadlineEpochMs,
  });
  assert.equal(holder.assertHeld(), true);

  const waiter = await waiterRepository.acquire({
    gpuDeviceSelector: GPU_UUID,
    ownerAuthorityHash: H('9'),
    absoluteDeadlineEpochMs: Date.now() + 3_000,
  });
  assert.equal(Date.now() >= holderDeadlineEpochMs, true);
  assert.equal(recoveredState?.leaseId, holder.leaseId);
  assert.equal(recoveredState?.fencingToken, holder.fencingToken);
  assert.equal(recoveredState?.absoluteDeadlineEpochMs, holderDeadlineEpochMs);
  assert.notEqual(waiter.fencingToken, holder.fencingToken);
  assert.equal(waiter.assertHeld(), true);

  assert.throws(() => holder.assertHeld(), (error) => (
    error?.code === 'gpu_selector_execution_lease_deadline_exhausted'
  ));
  assert.throws(() => holder.release(), (error) => (
    error?.code === 'gpu_selector_execution_lease_deadline_exhausted'
  ));
  assert.equal(waiter.assertHeld(), true);
  waiter.release();
});

test('busy-loop holder cannot be hard-preempted and capabilities disclose cooperative expiry', async (t) => {
  const { root } = fixture(t, 'gpu-selector-lease-busy-holder');
  const repository = createGpuSelectorExecutionLeaseRepository({ root });
  assert.equal(repository.capabilities().deadlineBound, false);
  assert.equal(repository.capabilities().acquisitionWaitDeadlineBound, true);
  assert.equal(repository.capabilities().holderHardDeadlineBound, false);
  assert.equal(
    repository.capabilities().holderDeadlineEnforcement,
    'cooperative_same_event_loop_watchdog_v1',
  );

  const moduleUrl = pathToFileURL(path.resolve(
    'paper-adapters/runtime/gpu-selector-execution-lease-repository.mjs',
  )).href;
  const holder = spawn(process.execPath, ['--input-type=module', '--eval', `
    import fs from 'node:fs';
    import { createGpuSelectorExecutionLeaseRepository } from ${JSON.stringify(moduleUrl)};
    const repository = createGpuSelectorExecutionLeaseRepository({
      root: ${JSON.stringify(root)},
    });
    const absoluteDeadlineEpochMs = Date.now() + 400;
    const lease = await repository.acquire({
      gpuDeviceSelector: ${JSON.stringify(GPU_UUID)},
      ownerAuthorityHash: ${JSON.stringify(H('a'))},
      absoluteDeadlineEpochMs,
    });
    fs.writeSync(1, JSON.stringify({
      status: 'held',
      absoluteDeadlineEpochMs,
      leaseId: lease.leaseId,
    }) + '\\n');
    while (true) { /* deliberately block the watchdog event loop */ }
  `], {
    env: { PATH: '/usr/bin:/bin', LANG: 'C', LC_ALL: 'C' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  t.after(() => {
    if (holder.exitCode === null && holder.signalCode === null) {
      holder.kill('SIGKILL');
    }
  });
  const holderOutcome = captureChild(holder);
  let readinessBuffer = '';
  const readiness = await Promise.race([
    new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(
        new Error('busy holder readiness timed out'),
      ), 5_000);
      holder.stdout.on('data', (chunk) => {
        readinessBuffer += chunk;
        const newline = readinessBuffer.indexOf('\n');
        if (newline < 0) return;
        clearTimeout(timeout);
        resolve(JSON.parse(readinessBuffer.slice(0, newline)));
      });
    }),
    holderOutcome.then((outcome) => {
      throw new Error(`busy holder exited before readiness: ${JSON.stringify(outcome)}`);
    }),
  ]);
  assert.equal(readiness.status, 'held');

  const waiter = await runChild(`
    import fs from 'node:fs';
    import { createGpuSelectorExecutionLeaseRepository } from ${JSON.stringify(moduleUrl)};
    const repository = createGpuSelectorExecutionLeaseRepository({
      root: ${JSON.stringify(root)},
      recoverStaleState() { return { recovered: true, receipt: null }; },
    });
    const requestedAtEpochMs = Date.now();
    const absoluteDeadlineEpochMs = requestedAtEpochMs + 900;
    try {
      const lease = await repository.acquire({
        gpuDeviceSelector: ${JSON.stringify(GPU_UUID)},
        ownerAuthorityHash: ${JSON.stringify(H('b'))},
        absoluteDeadlineEpochMs,
      });
      fs.writeSync(1, JSON.stringify({
        status: 'acquired',
        observedAtEpochMs: Date.now(),
        leaseId: lease.leaseId,
      }));
    } catch (error) {
      fs.writeSync(1, JSON.stringify({
        status: 'blocked',
        code: error.code || error.message,
        requestedAtEpochMs,
        absoluteDeadlineEpochMs,
        observedAtEpochMs: Date.now(),
      }));
    }
  `);
  assert.equal(waiter.code, 0, waiter.stderr);
  const waiterResult = JSON.parse(waiter.stdout);
  assert.equal(waiterResult.status, 'blocked');
  assert.equal(
    waiterResult.code,
    'gpu_selector_execution_lease_deadline_exhausted',
  );
  assert.ok(waiterResult.observedAtEpochMs
    >= readiness.absoluteDeadlineEpochMs);
  assert.ok(waiterResult.observedAtEpochMs
    >= waiterResult.absoluteDeadlineEpochMs);
  assert.equal(holder.exitCode, null);
  assert.equal(holder.signalCode, null);

  assert.equal(holder.kill('SIGKILL'), true);
  const killedHolder = await holderOutcome;
  assert.equal(killedHolder.code, null, killedHolder.stderr);
  assert.equal(killedHolder.signal, 'SIGKILL');
});

test('the same secure flock lease serializes a separate Node process', async (t) => {
  const { root } = fixture(t, 'gpu-selector-lease-process');
  const repository = createGpuSelectorExecutionLeaseRepository({ root });
  const holder = await repository.acquire({
    gpuDeviceSelector: GPU_UUID,
    ownerAuthorityHash: H('9'),
    absoluteDeadlineEpochMs: Date.now() + 3_000,
  });
  const moduleUrl = pathToFileURL(path.resolve(
    'paper-adapters/runtime/gpu-selector-execution-lease-repository.mjs',
  )).href;
  const childSource = ({ deadlineMs, authority }) => `
    import { createGpuSelectorExecutionLeaseRepository } from ${JSON.stringify(moduleUrl)};
    const repository = createGpuSelectorExecutionLeaseRepository({ root: ${JSON.stringify(root)} });
    try {
      const lease = await repository.acquire({
        gpuDeviceSelector: ${JSON.stringify(GPU_UUID)},
        ownerAuthorityHash: ${JSON.stringify(authority)},
        absoluteDeadlineEpochMs: Date.now() + ${Number(deadlineMs)},
      });
      const released = lease.release();
      process.stdout.write(JSON.stringify({ status: 'acquired', released: released.status }));
    } catch (error) {
      process.stdout.write(JSON.stringify({ status: 'blocked', code: error.code || error.message }));
    }
  `;
  const blocked = await runChild(childSource({ deadlineMs: 100, authority: H('a') }));
  assert.equal(blocked.code, 0, blocked.stderr);
  assert.deepEqual(JSON.parse(blocked.stdout), {
    status: 'blocked',
    code: 'gpu_selector_execution_lease_deadline_exhausted',
  });
  holder.release();
  const acquired = await runChild(childSource({ deadlineMs: 1_000, authority: H('b') }));
  assert.equal(acquired.code, 0, acquired.stderr);
  assert.deepEqual(JSON.parse(acquired.stdout), {
    status: 'acquired',
    released: 'gpu_selector_execution_lease_released',
  });
});

test('a SIGKILL leaves durable owner identity and blocks automatic reacquisition', async (t) => {
  const { root } = fixture(t, 'gpu-selector-lease-sigkill');
  const moduleUrl = pathToFileURL(path.resolve(
    'paper-adapters/runtime/gpu-selector-execution-lease-repository.mjs',
  )).href;
  const child = spawn(process.execPath, ['--input-type=module', '--eval', `
    import { createGpuSelectorExecutionLeaseRepository } from ${JSON.stringify(moduleUrl)};
    const repository = createGpuSelectorExecutionLeaseRepository({ root: ${JSON.stringify(root)} });
    await repository.acquire({
      gpuDeviceSelector: ${JSON.stringify(GPU_UUID)},
      ownerAuthorityHash: ${JSON.stringify(H('e'))},
      absoluteDeadlineEpochMs: Date.now() + 10_000,
    });
    process.stdout.write('acquired\\n');
    setInterval(() => {}, 1_000);
  `], {
    env: { PATH: '/usr/bin:/bin', LANG: 'C', LC_ALL: 'C' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stderr = '';
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(
      `lease holder readiness timed out: ${stderr}`,
    )), 2_000);
    child.stdout.on('data', (chunk) => {
      if (String(chunk).includes('acquired')) {
        clearTimeout(timer);
        resolve();
      }
    });
    child.once('error', reject);
    child.once('close', (code, signal) => {
      if (code !== null || signal !== 'SIGKILL') {
        clearTimeout(timer);
        reject(new Error(`lease holder exited early: ${code}/${signal}: ${stderr}`));
      }
    });
  });
  child.kill('SIGKILL');
  await new Promise((resolve) => child.once('close', resolve));

  const repository = createGpuSelectorExecutionLeaseRepository({ root });
  await assert.rejects(repository.acquire({
    gpuDeviceSelector: GPU_UUID,
    ownerAuthorityHash: H('f'),
    absoluteDeadlineEpochMs: Date.now() + 1_000,
  }), /gpu_selector_execution_lease_recovery_required/);
  const lockPath = path.join(root, gpuSelectorExecutionLockFileName(GPU_UUID));
  const durableState = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
  assert.equal(durableState.status, 'held');
  assert.equal(durableState.ownerProcessIdentity.pid, child.pid);
  assert.match(durableState.ownerProcessIdentity.bootId,
    /^[0-9a-f-]{36}$/);
  assert.match(durableState.ownerProcessIdentity.processStartTicks, /^\d+$/);
});

test('a torn append preserves fail-closed recovery instead of becoming an empty lease', async (t) => {
  const { root } = fixture(t, 'gpu-selector-lease-torn-state');
  const repository = createGpuSelectorExecutionLeaseRepository({ root });
  const lease = await repository.acquire({
    gpuDeviceSelector: GPU_UUID,
    ownerAuthorityHash: H('1'),
    absoluteDeadlineEpochMs: Date.now() + 2_000,
  });
  const lockPath = path.join(root, gpuSelectorExecutionLockFileName(GPU_UUID));
  fs.appendFileSync(lockPath, '{"status":"recovery_required"');
  assert.throws(() => lease.assertHeld(),
    /gpu_selector_execution_lease_state_changed/);
  assert.throws(() => lease.release(),
    /gpu_selector_execution_lease_state_changed/);
  assert.ok(fs.statSync(lockPath).size > 0);
});

test('production coordinator reclaims a dead bound owner only after Docker confirms absence', async (t) => {
  const { temporaryRoot } = fixture(t, 'gpu-selector-lease-stale-recovery');
  const root = gpuSelectorExecutionLeaseRootForRuntime(temporaryRoot);
  const repositoryUrl = pathToFileURL(path.resolve(
    'paper-adapters/runtime/gpu-selector-execution-lease-repository.mjs',
  )).href;
  const recoveryUrl = pathToFileURL(path.resolve(
    'paper-adapters/runtime/docker-worker-container-recovery.mjs',
  )).href;
  const child = spawn(process.execPath, ['--input-type=module', '--eval', `
    import { createGpuSelectorExecutionLeaseRepository } from ${JSON.stringify(repositoryUrl)};
    import { buildDockerWorkerContainerOwnership } from ${JSON.stringify(recoveryUrl)};
    const repository = createGpuSelectorExecutionLeaseRepository({ root: ${JSON.stringify(root)} });
    const lease = await repository.acquire({
      gpuDeviceSelector: ${JSON.stringify(GPU_UUID)},
      ownerAuthorityHash: ${JSON.stringify(H('7'))},
      absoluteDeadlineEpochMs: Date.now() + 20_000,
    });
    lease.bindWorkerInvocationAuthority(${JSON.stringify(H('8'))}, {
      dockerWorkerContainerOwnership: buildDockerWorkerContainerOwnership({
        processInvocationId: ${JSON.stringify(H('9'))},
        containerIdPath: ${JSON.stringify(path.join(temporaryRoot, 'dead.cid'))},
        gpuSelectorExecutionLease: lease,
      }),
    });
    process.stdout.write('bound\\n');
    setInterval(() => {}, 1_000);
  `], {
    env: { PATH: '/usr/bin:/bin', LANG: 'C', LC_ALL: 'C' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stderr = '';
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(
      `bound lease holder readiness timed out: ${stderr}`,
    )), 2_000);
    child.stdout.on('data', (chunk) => {
      if (String(chunk).includes('bound')) {
        clearTimeout(timer);
        resolve();
      }
    });
    child.once('error', reject);
  });
  child.kill('SIGKILL');
  await new Promise((resolve) => child.once('close', resolve));

  let inspectionCount = 0;
  const coordinator = createOsSandboxWorkerGpuSelectorLeaseCoordinator({
    allowGpu: true,
    runtimeRoot: temporaryRoot,
    availability: { available: true, backend: 'docker' },
    dockerContainerRecoveryExecutor() {
      inspectionCount += 1;
      return {
        status: 1,
        stdout: '',
        stderr: 'Error: No such object: fixture',
        signal: null,
        error: null,
      };
    },
    environment: {},
  });
  let started = false;
  const result = await coordinator.run({
    requiresGpu: true,
    gpuDeviceSelector: GPU_UUID,
    executable: '/usr/bin/true',
    args: [],
    cwd: temporaryRoot,
    sourceRoot: temporaryRoot,
    containerImage: 'fixture@sha256:deadbeef',
    executionIdentity: { runtimeIdentityHash: H('a') },
    absoluteDeadlineEpochMs: Date.now() + 5_000,
  }, async () => {
    started = true;
    return { ok: true };
  });
  assert.equal(result.ok, true);
  assert.equal(started, true);
  assert.equal(inspectionCount, 5);
});

test('unresolved Docker recovery quarantines the selector before another launch', async (t) => {
  const { temporaryRoot } = fixture(t, 'gpu-selector-lease-recovery');
  const coordinator = createOsSandboxWorkerGpuSelectorLeaseCoordinator({
    allowGpu: true,
    runtimeRoot: temporaryRoot,
    availability: { available: true, backend: 'docker' },
  });
  const baseSpec = {
    requiresGpu: true,
    gpuDeviceSelector: GPU_UUID,
    executable: '/usr/bin/true',
    args: [],
    cwd: temporaryRoot,
    sourceRoot: temporaryRoot,
    containerImage: 'fixture@sha256:deadbeef',
    executionIdentity: { runtimeIdentityHash: H('a') },
  };
  const first = await coordinator.run({
    ...baseSpec,
    absoluteDeadlineEpochMs: Date.now() + 2_000,
  }, async () => ({
    ok: false,
    dockerWorkerContainerRecoveryReceipt: {
      status: 'docker_worker_container_recovery_blocked',
      blockers: ['worker_container_recovery_unresolved'],
    },
  }));
  assert.equal(first.ok, false);

  let secondWorkerStarted = false;
  await assert.rejects(coordinator.run({
    ...baseSpec,
    absoluteDeadlineEpochMs: Date.now() + 80,
  }, async () => {
    secondWorkerStarted = true;
    return { ok: true };
  }), /gpu_selector_execution_lease_recovery_required/);
  assert.equal(secondWorkerStarted, false);
});

test('a post-launch exception quarantines before the coordinator can release', async (t) => {
  const { temporaryRoot } = fixture(t, 'gpu-selector-lease-finalizer-error');
  const coordinator = createOsSandboxWorkerGpuSelectorLeaseCoordinator({
    allowGpu: true,
    runtimeRoot: temporaryRoot,
    availability: { available: true, backend: 'docker' },
  });
  const baseSpec = {
    requiresGpu: true,
    gpuDeviceSelector: GPU_UUID,
    executable: '/usr/bin/true',
    args: [],
    cwd: temporaryRoot,
    sourceRoot: temporaryRoot,
    containerImage: 'fixture@sha256:deadbeef',
    executionIdentity: { runtimeIdentityHash: H('a') },
  };
  await assert.rejects(coordinator.run({
    ...baseSpec,
    absoluteDeadlineEpochMs: Date.now() + 2_000,
  }, async (lease) => {
    lease.bindWorkerInvocationAuthority(H('b'), {
      dockerWorkerContainerOwnership: buildDockerWorkerContainerOwnership({
        processInvocationId: H('d'),
        containerIdPath: path.join(temporaryRoot, 'fixture.cid'),
        gpuSelectorExecutionLease: lease,
      }),
    });
    throw new Error('fixture_finalizer_failed_after_recovery');
  }), /fixture_finalizer_failed_after_recovery/);

  let secondWorkerStarted = false;
  await assert.rejects(coordinator.run({
    ...baseSpec,
    absoluteDeadlineEpochMs: Date.now() + 2_000,
  }, async () => {
    secondWorkerStarted = true;
    return { ok: true };
  }), /gpu_selector_execution_lease_recovery_required/);
  assert.equal(secondWorkerStarted, false);
});

test('unsafe roots, symlink lock files, and hardlinked lock files fail closed', async (t) => {
  const { temporaryRoot } = fixture(t, 'gpu-selector-lease-unsafe');
  const broadRoot = path.join(temporaryRoot, 'broad');
  fs.mkdirSync(broadRoot, { mode: 0o755 });
  assert.throws(() => createGpuSelectorExecutionLeaseRepository({ root: broadRoot }),
    /gpu_selector_execution_lease_root_unsafe/);
  const targetRoot = path.join(temporaryRoot, 'target');
  fs.mkdirSync(targetRoot, { mode: 0o700 });
  const symlinkRoot = path.join(temporaryRoot, 'symlink-root');
  fs.symlinkSync(targetRoot, symlinkRoot);
  assert.throws(() => createGpuSelectorExecutionLeaseRepository({ root: symlinkRoot }),
    /gpu_selector_execution_lease_root_unsafe/);

  for (const mode of ['symlink', 'hardlink']) {
    const root = path.join(temporaryRoot, `${mode}-locks`);
    const repository = createGpuSelectorExecutionLeaseRepository({ root });
    const lockPath = path.join(root, gpuSelectorExecutionLockFileName(GPU_UUID));
    const target = path.join(temporaryRoot, `${mode}-target`);
    fs.writeFileSync(target, '', { mode: 0o600 });
    if (mode === 'symlink') fs.symlinkSync(target, lockPath);
    else fs.linkSync(target, lockPath);
    await assert.rejects(repository.acquire({
      gpuDeviceSelector: GPU_UUID,
      ownerAuthorityHash: H('c'),
      absoluteDeadlineEpochMs: Date.now() + 1_000,
    }), /gpu_selector_execution_lease_lock_file_unsafe/);
  }
});

test('held lease detects lock identity mutation and closes fail-closed', async (t) => {
  const { root } = fixture(t, 'gpu-selector-lease-identity-change');
  const repository = createGpuSelectorExecutionLeaseRepository({ root });
  const lease = await repository.acquire({
    gpuDeviceSelector: GPU_UUID,
    ownerAuthorityHash: H('d'),
    absoluteDeadlineEpochMs: Date.now() + 1_000,
  });
  const lockPath = path.join(root, gpuSelectorExecutionLockFileName(GPU_UUID));
  fs.chmodSync(lockPath, 0o640);
  assert.throws(() => lease.assertHeld(),
    /gpu_selector_execution_lease_identity_changed/);
  assert.throws(() => lease.release(),
    /gpu_selector_execution_lease_identity_changed/);
  assert.throws(() => lease.release(),
    /gpu_selector_execution_lease_identity_changed/);
});
