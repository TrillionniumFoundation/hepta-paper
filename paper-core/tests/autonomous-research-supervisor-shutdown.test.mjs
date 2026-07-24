import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { runPaperCampaign } from '../../paper-application/automation/campaign-engine.mjs';
import { createDefaultPaperStore } from '../../paper-adapters/persistence/store-provider.mjs';
import { createSqliteCampaignStore } from '../../paper-adapters/persistence/sqlite-campaign-store.mjs';
import { createSystemClock } from '../../paper-adapters/runtime/system-clock.mjs';
import { createSystemScheduler } from '../../paper-adapters/runtime/system-scheduler.mjs';
import { createRandomIdGenerator } from '../../paper-adapters/runtime/random-id-generator.mjs';
import {
  provisionAutonomousSubmissionHandoffTestAuthority,
} from './support/autonomous-submission-handoff-fixture.mjs';

const repositoryRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../..');

test('dispatcher signal aborts the active execution and durably pauses it for restart', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hepta-supervisor-signal-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const store = createDefaultPaperStore({
    root,
    runtimeRoot: root,
    dbPath: path.join(root, 'paper.sqlite'),
  });
  t.after(() => store.close());
  const clock = createSystemClock();
  const campaigns = createSqliteCampaignStore({ store, clock });
  const campaignId = 'autonomous-research:signal-paper';
  campaigns.createCampaign({
    campaignId,
    paperId: 'signal-paper',
    budgets: {
      maxWallTimeMs: 60_000,
      maxAgentCalls: 2,
      maxCpuJobs: 2,
      maxGpuJobs: 1,
      maxTokenCount: 1000,
      maxCostUsd: 10,
      maxMemoryMiB: 2048,
    },
    nodes: [{ nodeId: 'signal-node', kind: 'agent', dependencies: [], maxAttempts: 2 }],
  });
  const controller = new AbortController();
  let executionStarted;
  const started = new Promise((resolve) => { executionStarted = resolve; });
  const running = runPaperCampaign({
    campaignId,
    campaignStore: campaigns,
    executor: {
      async execute({ executionSignal }) {
        executionStarted();
        await new Promise((resolve, reject) => {
          executionSignal.addEventListener('abort', () => reject(
            Object.assign(new Error(String(executionSignal.reason)), { retryable: true }),
          ), { once: true });
        });
      },
    },
    concurrency: 1,
    leaseSeconds: 2,
    clock,
    scheduler: createSystemScheduler(),
    idGenerator: createRandomIdGenerator(),
    signal: controller.signal,
  });
  await started;
  controller.abort('supervisor_process_shutdown');
  const receipt = await running;
  assert.equal(receipt.campaign.status, 'paused');
  assert.equal(receipt.campaign.stopReason, 'supervisor_process_shutdown');
  assert.equal(campaigns.listNodes(campaignId)[0].status, 'queued');
});

test('canonical resident command forwards SIGTERM and exits through the graceful receipt', async (t) => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'hepta-supervisor-cli-signal-'));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const assetRoot = path.join(base, 'assets');
  const runtimeRoot = path.join(base, 'runtime');
  fs.mkdirSync(assetRoot, { recursive: true });
  fs.mkdirSync(runtimeRoot, { recursive: true });
  const store = createDefaultPaperStore({ root: assetRoot, runtimeRoot });
  const handoffMutationAuthorityProcessConfig =
    provisionAutonomousSubmissionHandoffTestAuthority({
      root: base,
      runtimeRoot,
      nativeStore: store,
    });
  store.close();
  const child = spawn(process.execPath, [
    'paper-core/bin/hepta-paper.mjs',
    'operator',
    'autonomous-supervisor',
    '--',
    '--root', assetRoot,
    '--runtime-root', runtimeRoot,
    '--poll-ms', '5000',
  ], {
    cwd: repositoryRoot,
    env: {
      ...process.env,
      HEPTA_RESEARCH_AUTHOR_MAXIMUM_COST_PER_CALL_USD: '1',
      HEPTA_FORMAL_REVIEWER_MAXIMUM_COST_PER_CALL_USD: '1',
      HEPTA_RUNTIME_IMAGE_REPRODUCIBILITY_MAXIMUM_REFRESH_ATTEMPTS_PER_EPOCH: '2',
      HEPTA_RUNTIME_IMAGE_REPRODUCIBILITY_MAXIMUM_REFRESH_COST_USD_PER_EPOCH: '10',
      HEPTA_AUTONOMOUS_SUBMISSION_HANDOFF_MUTATION_AUTHORITY_PROCESS_CONFIG:
        handoffMutationAuthorityProcessConfig,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  let signaled = false;
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (chunk) => {
    stdout += chunk;
    if (!signaled && stdout.includes('AutonomousResearchSupervisorCycleReceipt')) {
      signaled = true;
      child.kill('SIGTERM');
    }
  });
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  const watchdog = setTimeout(() => child.kill('SIGKILL'), 15_000);
  const result = await new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', (code, signal) => resolve({ code, signal }));
  });
  clearTimeout(watchdog);
  assert.equal(signaled, true, stderr);
  assert.deepEqual(result, { code: 0, signal: null }, stderr);
  assert.match(stdout, /AutonomousResearchSupervisorRunReceipt/);
  assert.match(stdout, /autonomous_research_supervisor_stopped_gracefully/);
});
