import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import test from 'node:test';

import {
  withRawEventRecomputationSandboxFixtureForTest,
  withRawEventRecomputationSandboxRunnerForTest,
} from './support/raw-event-recomputation-sandbox-test-seam.mjs';
import {
  createRawEventRecomputationSandboxTestFixture,
} from './support/raw-event-recomputation-sandbox-fixture.mjs';

const processRecomputationModule = new URL(
  '../../paper-adapters/research-verify/process-isolated-system-benchmark-recomputation.mjs',
  import.meta.url,
);
const {
  RAW_EVENT_RECOMPUTATION_MAXIMUM_CPU_SECONDS,
  RAW_EVENT_RECOMPUTATION_MAXIMUM_MEMORY_BYTES,
  RAW_EVENT_RECOMPUTATION_MAXIMUM_PROCESSES,
  RAW_EVENT_RECOMPUTATION_MAXIMUM_WALL_TIME_MS,
  runProcessIsolatedRawEventRecomputation,
  verifyProcessIsolatedRawEventRecomputationAssurance,
} = await import(processRecomputationModule.href);
const {
  verifyProcessIsolatedRawEventRecomputationAssurance:
    verifyUnhookedProductionProcessAssurance,
} = await import(`${processRecomputationModule.href}?unhooked-production-verifier`);
const {
  buildIndependentRecomputationAssurance,
} = await import('../../paper-adapters/automation/system-benchmark-independent-recomputation-assurance.mjs');
const {
  createRawEventRecomputationSandboxRunner,
  RAW_EVENT_RECOMPUTATION_DOCKER_FALLBACK_IMAGE,
} = await import('../../paper-adapters/research-verify/raw-event-recomputation-sandbox-runner-factory.mjs');
import { buildDockerWorkerCommand } from '../../paper-adapters/runtime/docker-worker-command.mjs';
import { createWorkerEnvironmentBomPreparer } from '../../paper-adapters/runtime/worker-environment-bom-binding.mjs';
import { buildCampaignBenchmarkSelector } from '../../paper-domain/automation/campaign-benchmark-selector.mjs';
import { buildCampaignBenchmarkSchedule } from '../../paper-domain/automation/experiment-run-contract.mjs';
import { hashBytes, hashRecord } from '../../workflow-kernel/record-hash.mjs';
import {
  SYSTEM_BENCHMARK_CPU_BUDGET_SEMANTICS,
  verifyRawEventRecomputationResourceBudget,
} from '../../paper-domain/automation/system-benchmark-resource-budget-contract.mjs';
import {
  verifyOsSandboxWorkerReceipt,
  verifyProductionOsSandboxWorkerReceipt,
} from '../../paper-domain/automation/os-sandbox-worker-receipt-contract.mjs';

function runWithSandbox(runner, input, options = {}) {
  return withRawEventRecomputationSandboxRunnerForTest(
    runner,
    () => runProcessIsolatedRawEventRecomputation(input, options),
  );
}

const workerUrl = new URL(
  '../../paper-adapters/research-verify/independent-system-benchmark-recomputation-worker.mjs',
  import.meta.url,
);

function fixture() {
  const selector = buildCampaignBenchmarkSelector({
    benchmarkId: 'ml_algorithm_benchmark',
    datasetMounts: [],
  });
  const scheduled = buildCampaignBenchmarkSchedule(selector)[0];
  const document = {
    version: 2,
    kind: 'SystemBenchmarkCellRawPrimitiveArtifact',
    cellId: scheduled.cellId,
    events: [
      { referenceScore: 0, robustnessScore: 1, score: 1 },
      { referenceScore: 1, robustnessScore: 0, score: 1 },
    ],
  };
  const line = `${JSON.stringify(document)}\n`;
  return {
    cells: [{
      ...scheduled,
      rawEventArtifactHash: hashBytes(line),
      rawEventCount: 2,
      metrics: {
        baseline_gap: 0.5,
        mean_score: 1,
        robustness_gap: 0.5,
        standard_error: 0,
      },
    }],
    rawEventRows: [{ cellId: scheduled.cellId, document, line }],
    requiredMetrics: selector.experimentDesign.requiredMetrics,
    metricSpecs: selector.experimentDesign.metricSpecs,
  };
}

function rebindSandboxWorkerProcessIdentity(sandboxReceipt, {
  backend = sandboxReceipt.backend,
  workerPid,
  parentPid,
} = {}) {
  const workerReceipt = JSON.parse(String(sandboxReceipt.stdout || '').trim());
  const {
    processIsolatedRawEventRecomputationWorkerReceiptHash: _workerReceiptHash,
    ...workerPayload
  } = workerReceipt;
  const reboundWorkerPayload = { ...workerPayload, workerPid, parentPid };
  const reboundWorkerReceipt = {
    ...reboundWorkerPayload,
    processIsolatedRawEventRecomputationWorkerReceiptHash: hashRecord(
      'ProcessIsolatedRawEventRecomputationWorkerReceipt',
      reboundWorkerPayload,
    ),
  };
  const {
    ok: _ok,
    receiptHash: _receiptHash,
    blockers: _blockers,
    ...sandboxPayload
  } = sandboxReceipt;
  const reboundSandboxPayload = {
    ...sandboxPayload,
    backend,
    runnerId: `${backend}-kernel-isolation-worker-v4`,
    evidenceClass: 'verification-fixture-v1',
    productionEvidenceEligible: false,
    isolation: {
      ...sandboxPayload.isolation,
      memoryLimitScope: backend === 'docker'
        ? 'container-cgroup-aggregate-v1'
        : 'process-address-space-not-descendant-tree-v1',
      processLimitMechanism: backend === 'docker'
        ? 'docker-pids-cgroup' : 'rlimit-nproc',
      processLimitScope: backend === 'docker'
        ? 'container-cgroup-concurrent-tasks-v1'
        : 'real-uid-concurrent-processes-not-sandbox-local-v1',
    },
    stdout: `${JSON.stringify(reboundWorkerReceipt)}\n`,
  };
  return Object.freeze({
    ok: true,
    ...reboundSandboxPayload,
    receiptHash: hashRecord('OsSandboxWorkerReceipt', reboundSandboxPayload),
    blockers: Object.freeze([]),
  });
}

function rehashProcessAssurance(assurance) {
  const {
    processIsolatedRawEventRecomputationAssuranceHash: _assuranceHash,
    ...payload
  } = assurance;
  return {
    ...payload,
    processIsolatedRawEventRecomputationAssuranceHash: hashRecord(
      'ProcessIsolatedRawEventRecomputationAssurance',
      payload,
    ),
  };
}

function rebindSandboxStdout(sandboxReceipt, stdout) {
  const {
    ok: _ok,
    receiptHash: _receiptHash,
    blockers: _blockers,
    ...payload
  } = sandboxReceipt;
  const rebound = { ...payload, stdout };
  return {
    ok: true,
    ...rebound,
    receiptHash: hashRecord('OsSandboxWorkerReceipt', rebound),
    blockers: [],
  };
}

function rebindSandboxIsolation(sandboxReceipt, isolation) {
  const {
    ok: _ok,
    receiptHash: _receiptHash,
    blockers: _blockers,
    ...payload
  } = sandboxReceipt;
  const rebound = { ...payload, isolation: { ...payload.isolation, ...isolation } };
  return {
    ok: true,
    ...rebound,
    receiptHash: hashRecord('OsSandboxWorkerReceipt', rebound),
    blockers: [],
  };
}

test('numeric recomputation executes in an OS-sandboxed process with a hash-bound receipt', () => {
  const input = fixture();
  const assurance = runWithSandbox(
    createRawEventRecomputationSandboxTestFixture(),
    input,
  );
  assert.equal(assurance.status, 'process_isolated_raw_event_recomputation_verified');
  assert.equal(assurance.processIndependent, true);
  assert.equal(assurance.osSandboxed, true);
  assert.equal(assurance.osSandboxWorkerReceipt.status, 'os_sandbox_worker_passed');
  assert.equal(assurance.osSandboxWorkerReceipt.backend, 'fixture');
  assert.equal(assurance.osSandboxBackend, 'fixture');
  assert.notEqual(assurance.workerPid, process.pid);
  assert.equal(assurance.parentPid, process.pid);
  assert.equal(
    assurance.workerReceipt.manifest.cells[0].metrics.mean_score,
    1,
  );
  assert.equal(verifyProcessIsolatedRawEventRecomputationAssurance(assurance, input), true);

  const rebound = structuredClone(input);
  rebound.cells[0].metrics.mean_score = 0.5;
  assert.equal(verifyProcessIsolatedRawEventRecomputationAssurance(assurance, rebound), false);
});

test('process verifier fails closed on a worker execution failure', () => {
  const assurance = runWithSandbox(
    createRawEventRecomputationSandboxTestFixture({
      spawnSyncImpl() {
      return { status: 1, signal: null, error: null, stdout: '', stderr: '', pid: 99 };
      },
    }),
    fixture(),
  );
  assert.equal(assurance.status, 'process_isolated_raw_event_recomputation_blocked');
  assert.ok(assurance.blockers.includes('raw_event_recomputation_os_sandbox_invalid'));
  const independent = buildIndependentRecomputationAssurance({
    producerManifest: { status: 'raw_event_recomputation_verified' },
    processAssurance: assurance,
    recomputationInput: fixture(),
  });
  assert.ok(independent.blockers.includes('independent_raw_event_recomputation_blocked'));
  assert.ok(independent.blockers.some((blocker) => blocker.startsWith(
    'independent_raw_event_recomputation_process:',
  )));
  assert.equal(independent.maximumAbsoluteResidual, null);
  assert.equal(
    independent.blockers.includes('independent_raw_event_recomputation_manifest_mismatch'),
    false,
    'a missing worker manifest is a sandbox failure, not a content mismatch',
  );
});

test('unhooked production verifier rejects actual verification seam output', () => {
  const rawFixtureReceipt = createRawEventRecomputationSandboxTestFixture().run({
    executable: process.execPath,
    args: ['--input-type=module', '--eval', "process.stdout.write('{}\\n')"],
    cwd: process.cwd(),
  });
  assert.equal(verifyOsSandboxWorkerReceipt(rawFixtureReceipt), true);
  assert.equal(verifyProductionOsSandboxWorkerReceipt(rawFixtureReceipt), false);
  const input = fixture();
  const assurance = withRawEventRecomputationSandboxFixtureForTest(
    () => runProcessIsolatedRawEventRecomputation(input),
  );
  assert.equal(assurance.status, 'process_isolated_raw_event_recomputation_verified');
  assert.equal(assurance.osSandboxWorkerReceipt.backend, 'fixture');
  assert.equal(assurance.osSandboxBackend, 'fixture');
  assert.equal(verifyProcessIsolatedRawEventRecomputationAssurance(
    assurance,
    input,
  ), true);
  assert.equal(verifyUnhookedProductionProcessAssurance(assurance, input), false);
});

test('malformed sandbox receipts fail closed without escaping the recomputation API', () => {
  const cyclic = {};
  cyclic.self = cyclic;
  for (const receipt of [
    { blockers: 'not-an-array' },
    Object.defineProperty({}, 'ok', {
      get() { throw new Error('hostile_getter'); },
    }),
    Object.defineProperty({}, 'backend', {
      enumerable: true,
      get() { throw new Error('hostile_backend_getter'); },
    }),
    { toJSON() { throw new Error('hostile_to_json'); } },
    new Proxy({}, { ownKeys() { throw new Error('hostile_own_keys'); } }),
    new Proxy({}, { get() { throw new Error('hostile_proxy_get'); } }),
    cyclic,
  ]) {
    const assurance = runWithSandbox({ run() { return receipt; } }, fixture());
    assert.equal(assurance.status, 'process_isolated_raw_event_recomputation_blocked');
    assert.equal(assurance.osSandboxWorkerReceipt, null);
    assert.ok(assurance.blockers.includes('raw_event_recomputation_os_sandbox_invalid'));
    assert.ok(assurance.blockers.includes('process_isolated_recomputation_receipt_invalid'));
  }
});

test('test seam requires an explicit fixture runner context', () => {
  const assurance = runProcessIsolatedRawEventRecomputation(fixture());
  assert.equal(assurance.status, 'process_isolated_raw_event_recomputation_blocked');
  assert.equal(assurance.osSandboxWorkerReceipt, null);
  assert.ok(assurance.blockers.includes('raw_event_recomputation_os_sandbox_invalid'));
});

test('malformed recomputation input fails closed without dispatch or escape', () => {
  const cyclic = {};
  cyclic.self = cyclic;
  for (const input of [{ cells: [1n] }, { cells: [cyclic] }]) {
    let dispatched = false;
    const assurance = runWithSandbox({
      run() { dispatched = true; return null; },
    }, input);
    assert.equal(dispatched, false);
    assert.equal(assurance.status, 'process_isolated_raw_event_recomputation_blocked');
    assert.ok(assurance.blockers.includes(
      'process_isolated_recomputation_request_invalid',
    ));
  }
});

test('malformed assurance objects fail closed without escaping the verifier', () => {
  const assurance = Object.defineProperty({}, 'version', {
    get() { throw new Error('hostile_assurance_getter'); },
  });
  assert.equal(verifyProcessIsolatedRawEventRecomputationAssurance(
    assurance,
    fixture(),
  ), false);
});

test('process verifier binds canonical implementation identity and nested worker hash', () => {
  const input = fixture();
  const assurance = runWithSandbox(
    createRawEventRecomputationSandboxTestFixture(),
    input,
  );
  assert.equal(verifyProcessIsolatedRawEventRecomputationAssurance(assurance, input), true);

  const forgedIdentity = rehashProcessAssurance({
    ...structuredClone(assurance),
    independentImplementationHash: `sha256:${'0'.repeat(64)}`,
  });
  assert.equal(verifyProcessIsolatedRawEventRecomputationAssurance(
    forgedIdentity,
    input,
  ), false);

  const forgedWorker = structuredClone(assurance);
  forgedWorker.workerReceipt.processIsolatedRawEventRecomputationWorkerReceiptHash =
    `sha256:${'0'.repeat(64)}`;
  forgedWorker.workerReceiptHash =
    forgedWorker.workerReceipt.processIsolatedRawEventRecomputationWorkerReceiptHash;
  forgedWorker.osSandboxWorkerReceipt = rebindSandboxStdout(
    forgedWorker.osSandboxWorkerReceipt,
    `${JSON.stringify(forgedWorker.workerReceipt)}\n`,
  );
  forgedWorker.osSandboxWorkerReceiptHash =
    forgedWorker.osSandboxWorkerReceipt.receiptHash;
  assert.equal(verifyProcessIsolatedRawEventRecomputationAssurance(
    rehashProcessAssurance(forgedWorker),
    input,
  ), false);

  for (const isolation of [
    { memoryLimitScope: 'process-tree-aggregate-memory-v1' },
    { processLimitScope: 'sandbox-local-process-tree-v1' },
  ]) {
    const forgedScope = structuredClone(assurance);
    forgedScope.osSandboxWorkerReceipt = rebindSandboxIsolation(
      forgedScope.osSandboxWorkerReceipt,
      isolation,
    );
    forgedScope.osSandboxWorkerReceiptHash = forgedScope.osSandboxWorkerReceipt.receiptHash;
    assert.equal(verifyProcessIsolatedRawEventRecomputationAssurance(
      rehashProcessAssurance(forgedScope),
      input,
    ), false);
  }
});

test('process recomputation cannot bypass inherited plugin configuration', () => {
  const prior = process.env.HEPTA_AUTONOMOUS_EMPIRICAL_PLUGIN_BUNDLE;
  process.env.HEPTA_AUTONOMOUS_EMPIRICAL_PLUGIN_BUNDLE = '/test/plugin-bundle';
  let dispatched = false;
  try {
    const assurance = runWithSandbox({
      run() {
        dispatched = true;
        return null;
      },
    }, fixture());
    assert.equal(dispatched, false);
    assert.ok(assurance.blockers.includes(
      'raw_event_recomputation_external_plugin_configuration_not_sandbox_mounted',
    ));
  } finally {
    if (prior === undefined) delete process.env.HEPTA_AUTONOMOUS_EMPIRICAL_PLUGIN_BUNDLE;
    else process.env.HEPTA_AUTONOMOUS_EMPIRICAL_PLUGIN_BUNDLE = prior;
  }
});

test('manifest mismatch remains explicit when a present worker envelope is invalid', () => {
  const input = fixture();
  const processAssurance = runWithSandbox(
    createRawEventRecomputationSandboxTestFixture(),
    input,
  );
  const invalidEnvelope = structuredClone(processAssurance);
  invalidEnvelope.status = 'process_isolated_raw_event_recomputation_blocked';
  const producerManifest = structuredClone(processAssurance.workerReceipt.manifest);
  producerManifest.maximumAbsoluteResidual = 1;
  const independent = buildIndependentRecomputationAssurance({
    producerManifest,
    processAssurance: invalidEnvelope,
    recomputationInput: input,
  });
  assert.ok(independent.blockers.includes('independent_raw_event_recomputation_blocked'));
  assert.ok(independent.blockers.includes(
    'independent_raw_event_recomputation_manifest_mismatch',
  ));
});

test('process assurance requires Docker PID-namespace worker evidence', () => {
  const fixtureRunner = createRawEventRecomputationSandboxTestFixture();
  const sandboxWorkerRunner = {
    run(spec) {
      const receipt = rebindSandboxWorkerProcessIdentity(fixtureRunner.run(spec), {
        backend: 'docker',
        parentPid: 0,
        workerPid: 1,
      });
      assert.equal(verifyOsSandboxWorkerReceipt(receipt), true, JSON.stringify(receipt));
      return receipt;
    },
  };
  const input = fixture();
  const assurance = runWithSandbox(sandboxWorkerRunner, input);
  assert.equal(assurance.parentPid, 0, JSON.stringify(assurance));
  assert.equal(assurance.workerPid, 1);
  assert.equal(verifyProcessIsolatedRawEventRecomputationAssurance(assurance, input), true);
});

test('process assurance rejects tampered Docker worker PID claims', () => {
  const fixtureRunner = createRawEventRecomputationSandboxTestFixture();
  const assurance = runWithSandbox({
      run(spec) {
        return rebindSandboxWorkerProcessIdentity(fixtureRunner.run(spec), {
          backend: 'docker',
          parentPid: 0,
          workerPid: 2,
        });
      },
    }, fixture());
  assert.equal(assurance.status, 'process_isolated_raw_event_recomputation_blocked');
  assert.ok(assurance.blockers.includes('process_isolated_recomputation_receipt_invalid'));
  assert.equal(assurance.workerReceipt, null);
  assert.equal(verifyProcessIsolatedRawEventRecomputationAssurance(
    assurance,
    fixture(),
  ), false);
});

test('default recomputation runner selects a digest-pinned Docker fallback', (t) => {
  assert.match(
    RAW_EVENT_RECOMPUTATION_DOCKER_FALLBACK_IMAGE,
    /^hepta\/python-scientific:[^@]+@sha256:[0-9a-f]{64}$/,
  );
  const runner = createRawEventRecomputationSandboxRunner();
  if (!runner.availability.available) {
    t.skip(`host sandbox unavailable: ${JSON.stringify(runner.availability)}`);
    return;
  }
  if (runner.availability.backend === 'docker') {
    assert.equal(runner.availability.image, RAW_EVENT_RECOMPUTATION_DOCKER_FALLBACK_IMAGE);
  }
});

test('raw-event recomputation keeps a 300-second wall ceiling without expanding CPU authority', () => {
  let capturedSpec = null;
  const fixtureRunner = createRawEventRecomputationSandboxTestFixture();
  const assurance = runWithSandbox({
      run(spec) {
        capturedSpec = spec;
        return fixtureRunner.run(spec);
      },
    }, fixture());
  assert.equal(assurance.status, 'process_isolated_raw_event_recomputation_verified');
  assert.equal(RAW_EVENT_RECOMPUTATION_MAXIMUM_WALL_TIME_MS, 300_000);
  assert.equal(RAW_EVENT_RECOMPUTATION_MAXIMUM_CPU_SECONDS, 120);
  assert.equal(capturedSpec.timeoutMs, RAW_EVENT_RECOMPUTATION_MAXIMUM_WALL_TIME_MS);
  assert.equal(capturedSpec.cpuSeconds, RAW_EVENT_RECOMPUTATION_MAXIMUM_CPU_SECONDS);
  assert.equal(capturedSpec.memoryBytes, RAW_EVENT_RECOMPUTATION_MAXIMUM_MEMORY_BYTES);
  assert.equal(capturedSpec.maximumProcesses, RAW_EVENT_RECOMPUTATION_MAXIMUM_PROCESSES);
  assert.deepEqual(assurance.resourceBudget, {
    timeoutMs: RAW_EVENT_RECOMPUTATION_MAXIMUM_WALL_TIME_MS,
    memoryBytes: RAW_EVENT_RECOMPUTATION_MAXIMUM_MEMORY_BYTES,
    cpuSeconds: RAW_EVENT_RECOMPUTATION_MAXIMUM_CPU_SECONDS,
    maximumProcesses: RAW_EVENT_RECOMPUTATION_MAXIMUM_PROCESSES,
  });
  assert.equal(assurance.cpuBudgetSemantics, SYSTEM_BENCHMARK_CPU_BUDGET_SEMANTICS);
});

test('raw-event recomputation cannot exceed a smaller upstream resource budget', () => {
  let capturedSpec = null;
  const fixtureRunner = createRawEventRecomputationSandboxTestFixture();
  const resourceBudget = {
    timeoutMs: 45_000,
    memoryBytes: 64 * 1024 * 1024,
    cpuSeconds: 7,
    maximumProcesses: 3,
  };
  const assurance = runWithSandbox({
      run(spec) {
        capturedSpec = spec;
        return fixtureRunner.run(spec);
      },
    }, fixture(), resourceBudget);
  assert.equal(assurance.status, 'process_isolated_raw_event_recomputation_verified');
  assert.deepEqual(assurance.resourceBudget, resourceBudget);
  assert.deepEqual({
    timeoutMs: capturedSpec.timeoutMs,
    memoryBytes: capturedSpec.memoryBytes,
    cpuSeconds: capturedSpec.cpuSeconds,
    maximumProcesses: capturedSpec.maximumProcesses,
  }, resourceBudget);
  assert.equal(verifyProcessIsolatedRawEventRecomputationAssurance(
    assurance,
    fixture(),
  ), true);
});

test('raw-event recomputation rejects resource authority above its ceilings before dispatch', () => {
  const invalidBudgets = [
    { cpuSeconds: RAW_EVENT_RECOMPUTATION_MAXIMUM_CPU_SECONDS + 1 },
    { memoryBytes: RAW_EVENT_RECOMPUTATION_MAXIMUM_MEMORY_BYTES + 1 },
    { maximumProcesses: RAW_EVENT_RECOMPUTATION_MAXIMUM_PROCESSES + 1 },
  ];
  for (const invalidBudget of invalidBudgets) {
    let dispatched = false;
    const assurance = runWithSandbox({
        run() {
          dispatched = true;
          return null;
        },
      }, fixture(), invalidBudget);
    assert.equal(dispatched, false);
    assert.equal(assurance.status, 'process_isolated_raw_event_recomputation_blocked');
    assert.ok(assurance.blockers.includes(
      'process_isolated_recomputation_resource_budget_invalid',
    ));
  }
});

test('worker resource normalization never expands low caller limits', () => {
  const prepareEnvironmentBom = createWorkerEnvironmentBomPreparer({
    maximumTimeoutMs: RAW_EVENT_RECOMPUTATION_MAXIMUM_WALL_TIME_MS,
    maximumMemoryBytes: RAW_EVENT_RECOMPUTATION_MAXIMUM_MEMORY_BYTES,
    maximumCpuSeconds: RAW_EVENT_RECOMPUTATION_MAXIMUM_CPU_SECONDS,
    maximumPids: RAW_EVENT_RECOMPUTATION_MAXIMUM_PROCESSES,
    maximumOutputBytes: 24 * 1024 * 1024,
    maximumCapturedBytes: 24 * 1024 * 1024,
  });
  const prepared = prepareEnvironmentBom({
    timeoutMs: 1,
    memoryBytes: 1,
    cpuSeconds: 1,
    maximumProcesses: 1,
    requestedMaximumOutputBytes: 1,
  });
  assert.deepEqual(prepared.limits, {
    timeoutMs: 1,
    memoryBytes: 1,
    cpuSeconds: 1,
    maximumPids: 1,
    maximumOutputBytes: 1,
    maximumCapturedBytes: 24 * 1024 * 1024,
  });
  const invalid = prepareEnvironmentBom({
    timeoutMs: 0,
    memoryBytes: 0,
    cpuSeconds: 0,
    maximumProcesses: 0,
    requestedMaximumOutputBytes: 0,
  });
  assert.deepEqual(invalid.limits, {
    timeoutMs: 0,
    memoryBytes: 0,
    cpuSeconds: 0,
    maximumPids: 0,
    maximumOutputBytes: 0,
    maximumCapturedBytes: 24 * 1024 * 1024,
  });
  assert.ok(invalid.blockers.includes('worker_environment_bom_invalid'));
});

test('raw-event recomputation budget policy rejects hash-consistent ceiling expansion', () => {
  const valid = {
    timeoutMs: RAW_EVENT_RECOMPUTATION_MAXIMUM_WALL_TIME_MS,
    memoryBytes: RAW_EVENT_RECOMPUTATION_MAXIMUM_MEMORY_BYTES,
    cpuSeconds: RAW_EVENT_RECOMPUTATION_MAXIMUM_CPU_SECONDS,
    maximumProcesses: RAW_EVENT_RECOMPUTATION_MAXIMUM_PROCESSES,
  };
  assert.equal(verifyRawEventRecomputationResourceBudget(valid), true);
  for (const [field, value] of [
    ['timeoutMs', RAW_EVENT_RECOMPUTATION_MAXIMUM_WALL_TIME_MS + 1],
    ['memoryBytes', RAW_EVENT_RECOMPUTATION_MAXIMUM_MEMORY_BYTES + 1],
    ['cpuSeconds', RAW_EVENT_RECOMPUTATION_MAXIMUM_CPU_SECONDS + 1],
    ['maximumProcesses', RAW_EVENT_RECOMPUTATION_MAXIMUM_PROCESSES + 1],
  ]) {
    assert.equal(verifyRawEventRecomputationResourceBudget({
      ...valid,
      [field]: value,
    }), false);
  }
});

test('raw-event recomputation rejects a sandbox receipt that expands its requested budget', () => {
  const fixtureRunner = createRawEventRecomputationSandboxTestFixture();
  const assurance = runWithSandbox({
      run(spec) {
        return fixtureRunner.run({ ...spec, cpuSeconds: 8 });
      },
    }, fixture(), { cpuSeconds: 7 });
  assert.equal(assurance.status, 'process_isolated_raw_event_recomputation_blocked');
  assert.ok(assurance.blockers.includes(
    'raw_event_recomputation_os_sandbox_resource_budget_mismatch',
  ));
  assert.equal(assurance.workerReceipt, null);
});

test('raw-event recomputation rejects an out-of-policy wall timeout before dispatch', () => {
  let dispatched = false;
  const assurance = runWithSandbox({
      run() {
        dispatched = true;
        return null;
      },
    }, fixture(), {
      timeoutMs: RAW_EVENT_RECOMPUTATION_MAXIMUM_WALL_TIME_MS + 1,
    });
  assert.equal(dispatched, false);
  assert.equal(assurance.status, 'process_isolated_raw_event_recomputation_blocked');
  assert.ok(assurance.blockers.includes('process_isolated_recomputation_timeout_invalid'));
  assert.equal(assurance.workerReceipt, null);
});

test('Docker recomputation command attaches standard input only when requested', () => {
  const command = (attachStandardInput) => buildDockerWorkerCommand({
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
    containerImageDigest: RAW_EVENT_RECOMPUTATION_DOCKER_FALLBACK_IMAGE,
    executable: '/usr/bin/node',
    arguments: ['/work/worker.mjs'],
    immutableWorkRoot: true,
    attachStandardInput,
  });
  assert.ok(command(true).includes('--interactive'));
  assert.equal(command(false).includes('--interactive'), false);
});

test('numeric recomputation worker import completes without consuming open stdin', async (t) => {
  const importScript = [
    `await import(${JSON.stringify(workerUrl.href)});`,
    "process.stdout.write('worker-import-complete\\n');",
  ].join('\n');
  const child = spawn(process.execPath, ['--input-type=module', '--eval', importScript], {
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  t.after(() => {
    child.stdin.destroy();
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
  });

  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (chunk) => { stdout += chunk; });
  child.stderr.on('data', (chunk) => { stderr += chunk; });

  const result = await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(new Error('worker_module_import_waited_for_stdin_eof'));
    }, 5_000);
    child.once('error', (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.once('close', (code, signal) => {
      clearTimeout(timeout);
      resolve({ code, signal });
    });
  });

  assert.deepEqual(result, { code: 0, signal: null }, stderr);
  assert.equal(stdout, 'worker-import-complete\n');
});
