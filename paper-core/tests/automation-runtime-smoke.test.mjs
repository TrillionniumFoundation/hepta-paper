import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

import {
  RUNTIME_SMOKE_FIXTURE_ROOT,
  RUNTIME_SMOKE_REPETITIONS,
  RUNTIME_SMOKE_STAGE_NAMES,
  createRuntimeSmokeProgressReporter,
  parseRuntimeSmokeArguments,
  resolveRuntimeSmokeGpuDeviceSelector,
  runAuditedRuntimeSmokeAttempt,
  runtimeSmokeFailureContext,
} from '../bin/automation-runtime-smoke.mjs';

const workspaceRoot = path.resolve(import.meta.dirname, '../..');
const smokeEntrypoint = path.join(workspaceRoot, 'paper-core/bin/automation-runtime-smoke.mjs');

function fixtureFiles() {
  const files = [];
  const walk = (directory) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const candidate = path.join(directory, entry.name);
      if (entry.isDirectory()) walk(candidate);
      else if (entry.isFile()) files.push(candidate);
    }
  };
  walk(RUNTIME_SMOKE_FIXTURE_ROOT);
  return files.sort();
}

test('runtime smoke defaults to a small repository-owned fixture without private paths', () => {
  const parsed = parseRuntimeSmokeArguments([], {});
  assert.equal(parsed.fixtureSource, 'repository-owned');
  assert.equal(parsed.rAssetRoot, path.join(RUNTIME_SMOKE_FIXTURE_ROOT, 'r-dataset'));
  assert.equal(path.relative(workspaceRoot, RUNTIME_SMOKE_FIXTURE_ROOT).startsWith('..'), false);

  const files = fixtureFiles();
  assert.equal(files.length, 7);
  assert.ok(files.reduce((total, file) => total + fs.statSync(file).size, 0) < 32 * 1024);
  for (const file of files) {
    assert.equal(fs.lstatSync(file).isSymbolicLink(), false);
    assert.doesNotMatch(fs.readFileSync(file, 'utf8'), /\/data\/home-data\/hepta-paper-assets/);
  }
  assert.doesNotMatch(fs.readFileSync(smokeEntrypoint, 'utf8'), /\/data\/home-data\/hepta-paper-assets/);
});

test('runtime smoke retains all real runtime probes and two independent repetitions', () => {
  assert.deepEqual(RUNTIME_SMOKE_STAGE_NAMES, [
    'pythonCpu', 'pythonGpu', 'pdeGpu', 'deepLearningGpu',
    'rDatasetHelper', 'cudaGpu', 'lean', 'latex',
  ]);
  assert.deepEqual(RUNTIME_SMOKE_REPETITIONS, ['first', 'second']);
  assert.match(fs.readFileSync(path.join(RUNTIME_SMOKE_FIXTURE_ROOT, 'workload/cpu.py'), 'utf8'), /sklearn\.linear_model/);
  assert.match(fs.readFileSync(path.join(RUNTIME_SMOKE_FIXTURE_ROOT, 'workload/gpu.py'), 'utf8'), /import cupy as cp/);
  assert.match(fs.readFileSync(path.join(RUNTIME_SMOKE_FIXTURE_ROOT, 'workload/pde_gpu.py'), 'utf8'), /conjugate gradient solves the finite-difference Poisson system/i);
  assert.match(fs.readFileSync(path.join(RUNTIME_SMOKE_FIXTURE_ROOT, 'workload/deep_learning_gpu.py'), 'utf8'), /all forward\/backward optimization runs/i);
  assert.match(fs.readFileSync(path.join(RUNTIME_SMOKE_FIXTURE_ROOT, 'workload/gpu.cu'), 'utf8'), /cudaMalloc/);
  assert.match(fs.readFileSync(path.join(RUNTIME_SMOKE_FIXTURE_ROOT, 'workload/actual_asset.R'), 'utf8'), /source\('\/datasets\/runtime-smoke\/TBRL_functions\.R'\)/);
});

test('runtime smoke CLI validates bounded independent timeouts and fixture overrides', () => {
  const parsed = parseRuntimeSmokeArguments([
    '--r-asset-root', '/tmp/operator-r-fixture',
    '--stage-timeout-ms', '45000',
    '--compile-timeout-ms=12000',
    '--gpu-device-selector', 'GPU-a33875b7-7eb7-679e-df08-19227d3decee',
    '--keep-failed-workspace',
  ], {});
  assert.equal(parsed.rAssetRoot, '/tmp/operator-r-fixture');
  assert.equal(parsed.fixtureSource, 'operator-supplied');
  assert.equal(parsed.stageTimeoutMs, 45_000);
  assert.equal(parsed.compileTimeoutMs, 12_000);
  assert.equal(parsed.keepFailedWorkspace, true);
  assert.equal(parsed.gpuDeviceSelector, 'GPU-a33875b7-7eb7-679e-df08-19227d3decee');
  assert.throws(() => parseRuntimeSmokeArguments(['--stage-timeout-ms', '14999'], {}), /stage_timeout_ms_invalid/);
  assert.throws(() => parseRuntimeSmokeArguments(['--compile-timeout-ms', '999'], {}), /compile_timeout_ms_invalid/);
  assert.throws(() => parseRuntimeSmokeArguments(['--unknown'], {}), /unknown_cli_option/);
  assert.throws(() => parseRuntimeSmokeArguments([
    '--gpu-device-selector', 'all',
  ], {}), /gpu_device_selector_invalid/);
  assert.equal(resolveRuntimeSmokeGpuDeviceSelector({ gpuDeviceSelector: null }, {
    spawnSyncImpl() {
      return {
        status: 0,
        stdout: 'GPU-a33875b7-7eb7-679e-df08-19227d3decee\n',
      };
    },
    environment: {},
  }), 'GPU-a33875b7-7eb7-679e-df08-19227d3decee');
  assert.throws(() => resolveRuntimeSmokeGpuDeviceSelector({ gpuDeviceSelector: null }, {
    spawnSyncImpl() {
      return {
        status: 0,
        stdout: [
          'GPU-a33875b7-7eb7-679e-df08-19227d3decee',
          'GPU-b33875b7-7eb7-679e-df08-19227d3decee',
        ].join('\n'),
      };
    },
    environment: {},
  }), /runtime_smoke_exact_gpu_device_selector_required/);
});

test('runtime smoke help is side-effect free and documents progress and timeout controls', () => {
  const result = spawnSync(process.execPath, [smokeEntrypoint, '--help'], {
    cwd: workspaceRoot,
    encoding: 'utf8',
    timeout: 10_000,
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, '');
  assert.match(result.stdout, /repository-owned minimal R fixture/);
  assert.match(result.stdout, /--stage-timeout-ms/);
  assert.match(result.stdout, /--gpu-device-selector/);
  assert.match(result.stdout, /Progress is emitted as JSON Lines on stderr/);
});

test('audited runtime stages emit structured start and completion progress', async () => {
  const lines = [];
  const progress = createRuntimeSmokeProgressReporter({
    write: (line) => lines.push(JSON.parse(line)),
    now: () => new Date('2026-07-18T00:00:00.000Z'),
  });
  const attempt = await runAuditedRuntimeSmokeAttempt({
    stageName: 'pythonCpu',
    repetition: 'first',
    hardTimeoutMs: 100,
    heartbeatIntervalMs: 10,
    progress,
    execute: async () => ({
      status: 'empirical_execution_completed',
      multiLanguageEmpiricalReceiptHash: `sha256:${'a'.repeat(64)}`,
      artifacts: [{ path: 'results.json', sha256: `sha256:${'b'.repeat(64)}` }],
    }),
  });
  assert.equal(attempt.passed, true);
  assert.deepEqual(lines.map((event) => event.phase), ['stage_started', 'stage_completed']);
  assert.equal(lines[0].kind, 'AutomationRuntimeSmokeProgress');
  assert.equal(lines[1].receiptHash, `sha256:${'a'.repeat(64)}`);
});

test('audited runtime stages enforce an outer hard timeout and expose failure context', async () => {
  const events = [];
  const attempt = await runAuditedRuntimeSmokeAttempt({
    stageName: 'rDatasetHelper',
    repetition: 'second',
    hardTimeoutMs: 20,
    heartbeatIntervalMs: 5,
    progress: (event) => events.push(event),
    execute: () => new Promise((resolve) => setTimeout(() => resolve({
      status: 'empirical_execution_failed',
      blockers: ['late_result'],
    }), 50)),
  });
  assert.equal(attempt.passed, false);
  assert.equal(attempt.hardTimeoutTriggered, true);
  assert.equal(attempt.failure.status, 'automation_runtime_smoke_stage_exception');
  assert.equal(events[0].phase, 'stage_started');
  assert.ok(events.some((event) => event.phase === 'stage_heartbeat'));
  assert.equal(events.at(-1).phase, 'stage_failed');

  const context = runtimeSmokeFailureContext({
    status: 'empirical_execution_failed',
    blockers: ['outer'],
    stderrTail: 'diagnostic stderr',
    runnerReceipt: {
      blockers: ['os_sandbox_command_timed_out'],
      signal: 'SIGTERM',
      exitCode: null,
    },
  });
  assert.deepEqual(context.blockers, ['outer', 'os_sandbox_command_timed_out']);
  assert.equal(context.timedOut, true);
  assert.equal(context.signal, 'SIGTERM');
  assert.equal(context.stderrTail, 'diagnostic stderr');
});
