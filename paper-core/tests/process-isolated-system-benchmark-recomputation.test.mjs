import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import test from 'node:test';

import {
  runProcessIsolatedRawEventRecomputation,
  verifyProcessIsolatedRawEventRecomputationAssurance,
} from '../../paper-adapters/research-verify/process-isolated-system-benchmark-recomputation.mjs';
import { buildCampaignBenchmarkSelector } from '../../paper-domain/automation/campaign-benchmark-selector.mjs';
import { buildCampaignBenchmarkSchedule } from '../../paper-domain/automation/experiment-run-contract.mjs';
import { hashBytes } from '../../workflow-kernel/record-hash.mjs';

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

test('numeric recomputation executes in a fresh process with a hash-bound receipt', () => {
  const input = fixture();
  const assurance = runProcessIsolatedRawEventRecomputation(input);
  assert.equal(assurance.status, 'process_isolated_raw_event_recomputation_verified');
  assert.equal(assurance.processIndependent, true);
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
    spawnSyncImpl() {
      return { status: 1, signal: null, error: null, stdout: '', stderr: '', pid: 99 };
    },
  });
  assert.equal(assurance.status, 'process_isolated_raw_event_recomputation_blocked');
  assert.ok(assurance.blockers.includes('process_isolated_recomputation_worker_failed'));
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
