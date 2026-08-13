import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import test from 'node:test';

import {
  createRawEventRecomputationSandboxRunner,
  RAW_EVENT_RECOMPUTATION_MAXIMUM_CPU_SECONDS,
  RAW_EVENT_RECOMPUTATION_MAXIMUM_WALL_TIME_MS,
  RAW_EVENT_RECOMPUTATION_DOCKER_FALLBACK_IMAGE,
  runProcessIsolatedRawEventRecomputation,
  verifyProcessIsolatedRawEventRecomputationAssurance,
} from '../../paper-adapters/research-verify/process-isolated-system-benchmark-recomputation.mjs';
import {
  buildIndependentRecomputationAssurance,
} from '../../paper-adapters/automation/system-benchmark-independent-recomputation-assurance.mjs';
import { buildDockerWorkerCommand } from '../../paper-adapters/runtime/docker-worker-command.mjs';
import { buildCampaignBenchmarkSelector } from '../../paper-domain/automation/campaign-benchmark-selector.mjs';
import { buildCampaignBenchmarkSchedule } from '../../paper-domain/automation/experiment-run-contract.mjs';
import { hashBytes, hashRecord } from '../../workflow-kernel/record-hash.mjs';
import {
  createRawEventRecomputationSandboxTestFixture,
} from './support/raw-event-recomputation-sandbox-fixture.mjs';

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
    stdout: `${JSON.stringify(reboundWorkerReceipt)}\n`,
  };
  return Object.freeze({
    ok: true,
    ...reboundSandboxPayload,
    receiptHash: hashRecord('OsSandboxWorkerReceipt', reboundSandboxPayload),
    blockers: Object.freeze([]),
  });
}

test('numeric recomputation executes in an OS-sandboxed process with a hash-bound receipt', () => {
  const input = fixture();
  const assurance = runProcessIsolatedRawEventRecomputation(input, {
    sandboxWorkerRunner: createRawEventRecomputationSandboxTestFixture(),
    environment: {},
  });
  assert.equal(assurance.status, 'process_isolated_raw_event_recomputation_verified');
  assert.equal(assurance.processIndependent, true);
  assert.equal(assurance.osSandboxed, true);
  assert.equal(assurance.osSandboxWorkerReceipt.status, 'os_sandbox_worker_passed');
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
  const assurance = runProcessIsolatedRawEventRecomputation(fixture(), {
    sandboxWorkerRunner: createRawEventRecomputationSandboxTestFixture({
      spawnSyncImpl() {
      return { status: 1, signal: null, error: null, stdout: '', stderr: '', pid: 99 };
      },
    }),
    environment: {},
  });
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

test('manifest mismatch remains explicit when a present worker envelope is invalid', () => {
  const input = fixture();
  const processAssurance = runProcessIsolatedRawEventRecomputation(input, {
    sandboxWorkerRunner: createRawEventRecomputationSandboxTestFixture(),
    environment: {},
  });
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
      return rebindSandboxWorkerProcessIdentity(fixtureRunner.run(spec), {
        backend: 'docker',
        parentPid: 0,
        workerPid: 1,
      });
    },
  };
  const input = fixture();
  const assurance = runProcessIsolatedRawEventRecomputation(input, {
    sandboxWorkerRunner,
    environment: {},
  });
  assert.equal(assurance.parentPid, 0);
  assert.equal(assurance.workerPid, 1);
  assert.equal(verifyProcessIsolatedRawEventRecomputationAssurance(assurance, input), true);
});

test('process assurance rejects tampered Docker worker PID claims', () => {
  const fixtureRunner = createRawEventRecomputationSandboxTestFixture();
  const assurance = runProcessIsolatedRawEventRecomputation(fixture(), {
    sandboxWorkerRunner: {
      run(spec) {
        return rebindSandboxWorkerProcessIdentity(fixtureRunner.run(spec), {
          backend: 'docker',
          parentPid: 0,
          workerPid: 2,
        });
      },
    },
    environment: {},
  });
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
  const assurance = runProcessIsolatedRawEventRecomputation(fixture(), {
    sandboxWorkerRunner: {
      run(spec) {
        capturedSpec = spec;
        return fixtureRunner.run(spec);
      },
    },
    environment: {},
  });
  assert.equal(assurance.status, 'process_isolated_raw_event_recomputation_verified');
  assert.equal(RAW_EVENT_RECOMPUTATION_MAXIMUM_WALL_TIME_MS, 300_000);
  assert.equal(RAW_EVENT_RECOMPUTATION_MAXIMUM_CPU_SECONDS, 120);
  assert.equal(capturedSpec.timeoutMs, RAW_EVENT_RECOMPUTATION_MAXIMUM_WALL_TIME_MS);
  assert.equal(capturedSpec.cpuSeconds, RAW_EVENT_RECOMPUTATION_MAXIMUM_CPU_SECONDS);
});

test('raw-event recomputation rejects an out-of-policy wall timeout before dispatch', () => {
  let dispatched = false;
  const assurance = runProcessIsolatedRawEventRecomputation(fixture(), {
    timeoutMs: RAW_EVENT_RECOMPUTATION_MAXIMUM_WALL_TIME_MS + 1,
    sandboxWorkerRunner: {
      run() {
        dispatched = true;
        return null;
      },
    },
    environment: {},
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
