import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  acquireCampaignReleasePackageGenerationLeaseSync,
  assertCampaignReleasePackageGenerationLeaseHeldSync,
  withCampaignReleasePackageGenerationLease,
  withHeldCampaignReleasePackageGenerationLeaseSync,
} from '../../paper-adapters/automation/campaign-release-package-generation-lease.mjs';
import {
  beginCampaignReleasePackageBuildTransactionSync,
} from '../../paper-adapters/automation/campaign-release-package-build-transaction-repository.mjs';
import { createDefaultPaperStore } from '../../paper-adapters/persistence/store-provider.mjs';
import { createSqliteCampaignStore } from '../../paper-adapters/persistence/sqlite-campaign-store.mjs';
import { createSystemScheduler } from '../../paper-adapters/runtime/system-scheduler.mjs';
import { createRandomIdGenerator } from '../../paper-adapters/runtime/random-id-generator.mjs';
import { runPaperCampaign } from '../../paper-application/automation/campaign-engine.mjs';
import { hashBytes, hashRecord } from '../../workflow-kernel/record-hash.mjs';

function fixture(t, label) {
  const runtimeRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), `hepta-release-generation-lease-${label}-`),
  );
  t.after(() => fs.rmSync(runtimeRoot, { recursive: true, force: true }));
  const campaignId = `campaign-generation-lease-${label}`;
  const packageNodeId = `${campaignId}:package`;
  const nodeRoot = path.join(
    runtimeRoot,
    'campaign-releases',
    campaignId,
    packageNodeId,
  );
  const oldReleaseRoot = path.join(nodeRoot, 'attempt-old');
  const successorReleaseRoot = path.join(nodeRoot, 'attempt-successor');
  const packagesRoot = path.join(runtimeRoot, 'packages');
  fs.mkdirSync(oldReleaseRoot, { recursive: true, mode: 0o700 });
  fs.mkdirSync(successorReleaseRoot, { recursive: true, mode: 0o700 });
  fs.mkdirSync(packagesRoot, { recursive: true, mode: 0o700 });
  const commonBinding = Object.freeze({
    campaignId,
    campaignPlanHash: hashBytes(Buffer.from(`${label}:plan`)),
    packageNodeId,
    sourceSnapshotHash: hashBytes(Buffer.from(`${label}:source-snapshot`)),
    sourceWorkspaceManifestHash:
      hashBytes(Buffer.from(`${label}:workspace-manifest`)),
  });
  return Object.freeze({
    runtimeRoot,
    oldReleaseRoot,
    oldPackageDir: path.join(packagesRoot, 'attempt-old'),
    oldBinding: Object.freeze({
      ...commonBinding,
      packageAttemptId: 'attempt-old',
      leaseGeneration: 4,
      createdAt: '2026-08-18T00:00:00.000Z',
    }),
    successorReleaseRoot,
    successorPackageDir: path.join(packagesRoot, 'attempt-successor'),
    successorBinding: Object.freeze({
      ...commonBinding,
      packageAttemptId: 'attempt-successor',
      leaseGeneration: 5,
      createdAt: '2026-08-18T00:01:00.000Z',
    }),
  });
}

function exactCode(expected) {
  return (error) => {
    assert.equal(error?.code, expected);
    return true;
  };
}

function engineFixture(t, label) {
  const value = fixture(t, `engine-${label}`);
  const storeRoot = path.join(value.runtimeRoot, 'campaign-state');
  fs.mkdirSync(storeRoot, { recursive: true, mode: 0o700 });
  const clock = Object.freeze({
    now: () => new Date(),
    nowIso: () => new Date().toISOString(),
  });
  const store = createDefaultPaperStore({
    root: storeRoot,
    runtimeRoot: value.runtimeRoot,
  });
  t.after(() => store.close());
  const campaignStore = createSqliteCampaignStore({ store, clock });
  const campaignId = `campaign-generation-contention-${label}`;
  const finalCompileNodeId = `${campaignId}:0:final-compile`;
  const researchVerifyNodeId = `${campaignId}:1:research-verify`;
  const packageNodeId = `${campaignId}:2:package`;
  const campaignPlanPayload = {
    version: 4,
    kind: 'PaperCampaignPlan',
    campaignId,
    paperId: `${campaignId}-paper`,
    sourceWorkspace: storeRoot,
    maxRounds: 1,
    researchVerificationRequired: true,
    paperQualityRequirements: { researchVerificationRequired: true },
    budgets: {
      maxWallTimeMs: 60_000,
      maxAgentCalls: 2,
      maxCpuJobs: 2,
      maxGpuJobs: 0,
      maxTokenCount: 1_000,
      maxCostUsd: 1,
      maxMemoryMiB: 8_192,
    },
    nodes: [
      {
        nodeId: finalCompileNodeId,
        kind: 'final-compile',
        roundIndex: 0,
        dependencies: [],
        priority: 1,
        maxAttempts: 1,
      },
      {
        nodeId: researchVerifyNodeId,
        kind: 'research-verify',
        roundIndex: 0,
        dependencies: [finalCompileNodeId],
        priority: 2,
        maxAttempts: 1,
      },
      {
        nodeId: packageNodeId,
        kind: 'package',
        roundIndex: 0,
        dependencies: [finalCompileNodeId, researchVerifyNodeId],
        priority: 3,
        maxAttempts: 1,
      },
    ],
  };
  campaignStore.createCampaign({
    ...campaignPlanPayload,
    campaignPlanHash: hashRecord('PaperCampaignPlan', campaignPlanPayload),
  });
  for (const nodeId of [finalCompileNodeId, researchVerifyNodeId]) {
    const claimed = campaignStore.claimReady({
      campaignId,
      workerId: 'generation-contention-fixture',
      leaseSeconds: 60,
      limit: 1,
    })[0];
    assert.equal(claimed.nodeId, nodeId);
    const running = campaignStore.startNode({
      nodeId,
      workerId: 'generation-contention-fixture',
      attemptId: claimed.attemptId,
      leaseGeneration: claimed.leaseGeneration,
    });
    campaignStore.completeNode({
      nodeId,
      workerId: 'generation-contention-fixture',
      attemptId: running.attemptId,
      leaseGeneration: running.leaseGeneration,
      result: Object.freeze({ status: 'fixture_dependency_completed' }),
    });
  }
  return Object.freeze({
    ...value,
    campaignId,
    campaignStore,
    clock,
    scheduler: createSystemScheduler(),
    idGenerator: createRandomIdGenerator(),
  });
}

function runContendedCampaign(value, {
  maximumWaitMs,
  onExecute = () => {},
  resourceGovernor = null,
  signal = null,
} = {}) {
  return runPaperCampaign({
    campaignId: value.campaignId,
    campaignStore: value.campaignStore,
    concurrency: 1,
    pollMs: 1,
    maximumIdlePolls: 5,
    clock: value.clock,
    scheduler: value.scheduler,
    idGenerator: value.idGenerator,
    resourceGovernor,
    signal,
    assertExternalSideEffectReady: async () => true,
    executor: {
      async execute({ executionBudget, executionSignal }) {
        onExecute();
        return withCampaignReleasePackageGenerationLease({
          runtimeRoot: value.runtimeRoot,
          releaseRoot: value.successorReleaseRoot,
          signal: executionSignal,
          maximumWaitMs: maximumWaitMs
            ?? executionBudget.remainingWallTimeMs,
          initialRetryDelayMs: 10,
          maximumRetryDelayMs: 20,
        }, async (generationLease) => {
          generationLease.assertHeld();
          return Object.freeze({
            version: 1,
            kind: 'GenerationLockContentionFixtureResult',
            status: 'generation_lock_contention_completed',
            externalActionPerformed: false,
          });
        });
      },
    },
  });
}

function packageNodeFrom(nodes) {
  return nodes.find((node) => node.kind === 'package');
}

test('generation lease is an opaque scope-bound capability and rejects use after release',
  (t) => {
    const value = fixture(t, 'opaque');
    const lease = acquireCampaignReleasePackageGenerationLeaseSync({
      runtimeRoot: value.runtimeRoot,
      releaseRoot: value.oldReleaseRoot,
    });
    assert.equal(Object.isFrozen(lease), true);
    assert.equal(lease.kind, 'CampaignReleasePackageGenerationLease');
    assert.equal(assertCampaignReleasePackageGenerationLeaseHeldSync({
      lease,
      runtimeRoot: value.runtimeRoot,
      releaseRoot: value.oldReleaseRoot,
    }), lease);

    const forged = Object.freeze({
      version: 1,
      kind: 'CampaignReleasePackageGenerationLease',
      assertHeld() {},
      release() {},
    });
    assert.throws(() => assertCampaignReleasePackageGenerationLeaseHeldSync({
      lease: forged,
      runtimeRoot: value.runtimeRoot,
      releaseRoot: value.oldReleaseRoot,
    }), exactCode('campaign_release_package_generation_lease_invalid'));
    assert.throws(() => withHeldCampaignReleasePackageGenerationLeaseSync({
      lease: forged,
      runtimeRoot: value.runtimeRoot,
      releaseRoot: value.oldReleaseRoot,
    }, () => null), exactCode('campaign_release_package_generation_lease_invalid'));
    assert.throws(() => assertCampaignReleasePackageGenerationLeaseHeldSync({
      lease,
      runtimeRoot: value.runtimeRoot,
      releaseRoot: value.successorReleaseRoot,
    }), exactCode('campaign_release_package_generation_lease_scope_mismatch'));

    assert.equal(lease.release(), true);
    assert.equal(lease.release(), false);
    assert.throws(() => lease.assertHeld(),
      exactCode('campaign_release_package_generation_lease_invalid'));
    assert.throws(() => assertCampaignReleasePackageGenerationLeaseHeldSync({
      lease,
      runtimeRoot: value.runtimeRoot,
      releaseRoot: value.oldReleaseRoot,
    }), exactCode('campaign_release_package_generation_lease_invalid'));
  });

test('held sync operations reuse the same lease and reject a new OFD and thenables',
  (t) => {
    const value = fixture(t, 'nested');
    const lease = acquireCampaignReleasePackageGenerationLeaseSync({
      runtimeRoot: value.runtimeRoot,
      releaseRoot: value.oldReleaseRoot,
    });
    t.after(() => lease.release());

    const transaction = withHeldCampaignReleasePackageGenerationLeaseSync({
      lease,
      runtimeRoot: value.runtimeRoot,
      releaseRoot: value.oldReleaseRoot,
    }, () => beginCampaignReleasePackageBuildTransactionSync({
      runtimeRoot: value.runtimeRoot,
      releaseRoot: value.oldReleaseRoot,
      packageDir: value.oldPackageDir,
      binding: value.oldBinding,
      generationLease: lease,
    }));
    assert.equal(
      transaction.record.packageAttemptId,
      value.oldBinding.packageAttemptId,
    );
    assert.equal(transaction.record.leaseGeneration, 4);
    lease.assertHeld();

    assert.throws(() => withHeldCampaignReleasePackageGenerationLeaseSync({
      lease,
      runtimeRoot: value.runtimeRoot,
      releaseRoot: value.oldReleaseRoot,
    }, () => beginCampaignReleasePackageBuildTransactionSync({
      runtimeRoot: value.runtimeRoot,
      releaseRoot: value.oldReleaseRoot,
      packageDir: value.oldPackageDir,
      binding: value.oldBinding,
    })), exactCode('campaign_release_package_generation_lock_unavailable'));
    lease.assertHeld();

    assert.throws(() => withHeldCampaignReleasePackageGenerationLeaseSync({
      lease,
      runtimeRoot: value.runtimeRoot,
      releaseRoot: value.oldReleaseRoot,
    }, () => Promise.resolve('not-sync')),
    exactCode('campaign_release_package_generation_lease_async_operation_forbidden'));
    lease.assertHeld();
  });

test('a cross-process lease blocks successor fencing until the writer releases it',
  async (t) => {
    const value = fixture(t, 'cross-process');
    const leaseModuleUrl = new URL(
      '../../paper-adapters/automation/campaign-release-package-generation-lease.mjs',
      import.meta.url,
    ).href;
    const transactionModuleUrl = new URL(
      '../../paper-adapters/automation/campaign-release-package-build-transaction-repository.mjs',
      import.meta.url,
    ).href;
    const childSource = `
      import fs from 'node:fs';
      import { once } from 'node:events';
      import { withCampaignReleasePackageGenerationLease } from ${JSON.stringify(leaseModuleUrl)};
      import { beginCampaignReleasePackageBuildTransactionSync } from ${JSON.stringify(transactionModuleUrl)};

      await withCampaignReleasePackageGenerationLease(${JSON.stringify({
    runtimeRoot: value.runtimeRoot,
    releaseRoot: value.oldReleaseRoot,
  })}, async (generationLease) => {
        const transaction = beginCampaignReleasePackageBuildTransactionSync({
          ...${JSON.stringify({
    runtimeRoot: value.runtimeRoot,
    releaseRoot: value.oldReleaseRoot,
    packageDir: value.oldPackageDir,
    binding: value.oldBinding,
  })},
          generationLease,
        });
        fs.mkdirSync(transaction.preparedPackageDir, {
          recursive: true,
          mode: 0o700,
        });
        const partialPath = new URL(
          'partial-output.bin',
          'file://' + transaction.preparedPackageDir + '/',
        );
        fs.writeFileSync(partialPath, Buffer.alloc(4096, 0x5a));
        process.stdout.write(JSON.stringify({
          transactionHash:
            transaction.record.campaignReleasePackageBuildingTransactionHash,
          preparedParent: transaction.preparedParent,
          partialPath: partialPath.pathname,
        }) + '\\n');
        await once(process.stdin, 'data');
      });
    `;
    const child = spawn(
      process.execPath,
      ['--input-type=module', '-e', childSource],
      { stdio: ['pipe', 'pipe', 'pipe'] },
    );
    t.after(() => {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    const ready = new Promise((resolve, reject) => {
      child.stdout.on('data', (chunk) => {
        stdout += chunk;
        if (stdout.includes('\n')) resolve();
      });
      child.once('error', reject);
      child.once('exit', (code, signal) => {
        if (!stdout.includes('\n')) {
          reject(new Error(`generation_lease_child_exited:${code}:${signal}:${stderr}`));
        }
      });
    });
    await ready;
    const held = JSON.parse(stdout.trim().split('\n')[0]);
    assert.equal(fs.existsSync(held.partialPath), true);

    assert.throws(() => beginCampaignReleasePackageBuildTransactionSync({
      runtimeRoot: value.runtimeRoot,
      releaseRoot: value.successorReleaseRoot,
      packageDir: value.successorPackageDir,
      binding: value.successorBinding,
    }), exactCode('campaign_release_package_generation_lock_unavailable'));
    assert.equal(fs.existsSync(path.join(
      value.oldReleaseRoot,
      'CAMPAIGN_RELEASE_PACKAGE_BUILDING_FENCED.json',
    )), false);
    assert.equal(fs.existsSync(path.join(
      value.successorReleaseRoot,
      'CAMPAIGN_RELEASE_PACKAGE_BUILDING.json',
    )), false);
    assert.equal(fs.existsSync(held.preparedParent), true);
    assert.equal(fs.existsSync(held.partialPath), true);

    const exited = once(child, 'exit');
    child.stdin.end('release\n');
    const [code, signal] = await exited;
    assert.equal(code, 0, stderr);
    assert.equal(signal, null, stderr);

    const successor = beginCampaignReleasePackageBuildTransactionSync({
      runtimeRoot: value.runtimeRoot,
      releaseRoot: value.successorReleaseRoot,
      packageDir: value.successorPackageDir,
      binding: value.successorBinding,
    });
    assert.equal(successor.record.leaseGeneration, 5);
    assert.equal(fs.existsSync(held.preparedParent), false);
    assert.equal(fs.existsSync(held.partialPath), false);
    const fence = JSON.parse(fs.readFileSync(path.join(
      value.oldReleaseRoot,
      'CAMPAIGN_RELEASE_PACKAGE_BUILDING_FENCED.json',
    ), 'utf8'));
    assert.equal(
      fence.campaignReleasePackageBuildingTransactionHash,
      held.transactionHash,
    );
    assert.equal(fence.supersededLeaseGeneration, 4);
    assert.equal(fence.supersedingLeaseGeneration, 5);
    assert.equal(
      fence.supersedingPackageAttemptId,
      value.successorBinding.packageAttemptId,
    );
  });

test('async generation lease wait is abortable and never invokes the operation',
  async (t) => {
    const value = fixture(t, 'abort-wait');
    const holder = acquireCampaignReleasePackageGenerationLeaseSync({
      runtimeRoot: value.runtimeRoot,
      releaseRoot: value.oldReleaseRoot,
    });
    t.after(() => holder.release());
    const controller = new AbortController();
    const abortTimer = setTimeout(() => controller.abort('fixture_cancelled'), 40);
    t.after(() => clearTimeout(abortTimer));
    let operationCalls = 0;
    await assert.rejects(() => withCampaignReleasePackageGenerationLease({
      runtimeRoot: value.runtimeRoot,
      releaseRoot: value.successorReleaseRoot,
      signal: controller.signal,
      maximumWaitMs: 2_000,
      initialRetryDelayMs: 10,
      maximumRetryDelayMs: 20,
    }, async () => {
      operationCalls += 1;
    }), (error) => {
      assert.equal(
        error?.code,
        'campaign_release_package_generation_lock_wait_aborted',
      );
      assert.equal(error?.campaignGenerationLockWaitAborted, true);
      assert.equal(error?.stateRecoverabilityDeferred, undefined);
      return true;
    });
    assert.equal(operationCalls, 0);
    holder.release();
    const recovered = await withCampaignReleasePackageGenerationLease({
      runtimeRoot: value.runtimeRoot,
      releaseRoot: value.successorReleaseRoot,
      maximumWaitMs: 100,
    }, async (generationLease) => {
      generationLease.assertHeld();
      return 'recovered';
    });
    assert.equal(recovered, 'recovered');
  });

test('a lock released after the hard wait deadline cannot start the operation',
  async (t) => {
    const value = fixture(t, 'hard-deadline');
    const leaseModuleUrl = new URL(
      '../../paper-adapters/automation/campaign-release-package-generation-lease.mjs',
      import.meta.url,
    ).href;
    const childSource = `
      import { withCampaignReleasePackageGenerationLease } from ${JSON.stringify(leaseModuleUrl)};
      await withCampaignReleasePackageGenerationLease(${JSON.stringify({
    runtimeRoot: value.runtimeRoot,
    releaseRoot: value.oldReleaseRoot,
  })}, async () => {
        process.stdout.write('ready\\n');
        await new Promise((resolve) => setTimeout(resolve, 200));
      });
    `;
    const child = spawn(
      process.execPath,
      ['--input-type=module', '-e', childSource],
      { stdio: ['ignore', 'pipe', 'pipe'] },
    );
    t.after(() => {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    });
    let stderr = '';
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    const exited = once(child, 'exit');
    await new Promise((resolve, reject) => {
      child.stdout.setEncoding('utf8');
      child.stdout.once('data', (chunk) => {
        if (String(chunk).includes('ready')) resolve();
        else reject(new Error(`generation_lease_holder_invalid:${chunk}`));
      });
      child.once('error', reject);
      child.once('exit', (code, signal) => {
        reject(new Error(`generation_lease_holder_exited:${code}:${signal}:${stderr}`));
      });
    });
    let operationCalls = 0;
    const waiting = withCampaignReleasePackageGenerationLease({
      runtimeRoot: value.runtimeRoot,
      releaseRoot: value.successorReleaseRoot,
      maximumWaitMs: 50,
      initialRetryDelayMs: 10,
      maximumRetryDelayMs: 20,
    }, async () => {
      operationCalls += 1;
    });
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 350);
    await assert.rejects(waiting,
      exactCode('campaign_release_package_generation_lock_wait_timeout'));
    assert.equal(operationCalls, 0);
    const [code, signal] = await exited;
    assert.equal(code, 0, stderr);
    assert.equal(signal, null, stderr);
  });

test('a free lock acquired after a tiny execution budget is released before operation',
  async (t) => {
    const value = fixture(t, 'free-lock-hard-deadline');
    let operationCalls = 0;
    await assert.rejects(() => withCampaignReleasePackageGenerationLease({
      runtimeRoot: value.runtimeRoot,
      releaseRoot: value.oldReleaseRoot,
      executionBudget: { remainingWallTimeMs: 1 },
    }, async () => {
      operationCalls += 1;
    }), exactCode('campaign_release_package_generation_lock_wait_timeout'));
    assert.equal(operationCalls, 0);
    const recovered = acquireCampaignReleasePackageGenerationLeaseSync({
      runtimeRoot: value.runtimeRoot,
      releaseRoot: value.oldReleaseRoot,
    });
    recovered.assertHeld();
    recovered.release();
  });

test('an absolute deadline crossed during free acquisition releases before operation',
  async (t) => {
    const value = fixture(t, 'free-lock-absolute-deadline');
    const deadline = Date.parse('2026-08-18T00:00:01.000Z');
    let clockReads = 0;
    const clock = Object.freeze({
      now: () => new Date(clockReads++ === 0 ? deadline - 1_000 : deadline + 1),
    });
    let operationCalls = 0;
    await assert.rejects(() => withCampaignReleasePackageGenerationLease({
      runtimeRoot: value.runtimeRoot,
      releaseRoot: value.oldReleaseRoot,
      executionBudget: {
        remainingWallTimeMs: 60_000,
        absoluteDeadlineEpochMs: deadline,
      },
      clock,
    }, async () => {
      operationCalls += 1;
    }), exactCode('campaign_release_execution_budget_exhausted'));
    assert.equal(operationCalls, 0);
    const recovered = acquireCampaignReleasePackageGenerationLeaseSync({
      runtimeRoot: value.runtimeRoot,
      releaseRoot: value.oldReleaseRoot,
    });
    recovered.assertHeld();
    recovered.release();
  });

test('invalid async wait policy is rejected before lock acquisition', async (t) => {
  const value = fixture(t, 'invalid-wait-policy');
  await assert.rejects(() => withCampaignReleasePackageGenerationLease({
    runtimeRoot: value.runtimeRoot,
    releaseRoot: value.oldReleaseRoot,
    maximumWaitMs: 0,
  }, async () => null),
  exactCode('campaign_release_package_generation_lock_wait_invalid'));
  await assert.rejects(() => withCampaignReleasePackageGenerationLease({
    runtimeRoot: value.runtimeRoot,
    releaseRoot: value.oldReleaseRoot,
    initialRetryDelayMs: Number.NaN,
  }, async () => null),
  exactCode('campaign_release_package_generation_lock_retry_delay_invalid'));
  const lease = acquireCampaignReleasePackageGenerationLeaseSync({
    runtimeRoot: value.runtimeRoot,
    releaseRoot: value.oldReleaseRoot,
  });
  lease.assertHeld();
  lease.release();
});

test('campaign engine waits through contention and completes in its first attempt',
  async (t) => {
    const value = engineFixture(t, 'wait-success');
    const holder = acquireCampaignReleasePackageGenerationLeaseSync({
      runtimeRoot: value.runtimeRoot,
      releaseRoot: value.oldReleaseRoot,
    });
    t.after(() => holder.release());
    const releaseTimer = setTimeout(() => holder.release(), 80);
    t.after(() => clearTimeout(releaseTimer));
    let executions = 0;
    const result = await runContendedCampaign(value, {
      onExecute: () => { executions += 1; },
    });
    assert.equal(result.campaign.status, 'completed');
    assert.equal(executions, 1);
    assert.equal(result.retryCount, 0);
    const packageNode = packageNodeFrom(result.nodes);
    assert.equal(packageNode.status, 'completed');
    assert.equal(packageNode.attemptCount, 1);
    assert.equal(result.campaign.cpuJobCount, 1);
    assert.equal(value.campaignStore.listEvents(value.campaignId).some(
      (event) => event.kind === 'campaign_node_retry_queued',
    ), false);
  });

test('contention timeout defers the engine attempt and succeeds after lock release',
  async (t) => {
    const value = engineFixture(t, 'timeout-deferred');
    const holder = acquireCampaignReleasePackageGenerationLeaseSync({
      runtimeRoot: value.runtimeRoot,
      releaseRoot: value.oldReleaseRoot,
    });
    t.after(() => holder.release());
    let executions = 0;
    await assert.rejects(() => runContendedCampaign(value, {
      maximumWaitMs: 45,
      onExecute: () => { executions += 1; },
    }), (error) => {
      assert.equal(
        error?.code,
        'campaign_release_package_generation_lock_wait_timeout',
      );
      assert.equal(error?.campaignGenerationLockContention, true);
      assert.equal(error?.stateRecoverabilityDeferred, true);
      assert.equal(error?.campaignNodeInfrastructureReservationCancelled, true);
      return true;
    });
    let node = packageNodeFrom(value.campaignStore.listNodes(value.campaignId));
    assert.equal(node.status, 'queued');
    assert.equal(node.attemptCount, 0);
    assert.equal(value.campaignStore.getCampaign(value.campaignId).cpuJobCount, 0);
    assert.equal(value.campaignStore.listEvents(value.campaignId).filter(
      (event) => event.kind === 'campaign_node_infrastructure_deferred',
    ).length, 1);
    assert.equal(value.campaignStore.listEvents(value.campaignId).some(
      (event) => event.kind === 'campaign_node_retry_queued'
        || event.kind === 'campaign_node_failed_terminal',
    ), false);

    holder.release();
    const recovered = await runContendedCampaign(value, {
      maximumWaitMs: 100,
      onExecute: () => { executions += 1; },
    });
    node = packageNodeFrom(recovered.nodes);
    assert.equal(recovered.campaign.status, 'completed');
    assert.equal(node.status, 'completed');
    assert.equal(node.attemptCount, 1);
    assert.equal(recovered.campaign.cpuJobCount, 1);
    assert.equal(executions, 2);
  });

test('internal execution abort during contention refunds the engine attempt',
  async (t) => {
    const value = engineFixture(t, 'internal-abort');
    const holder = acquireCampaignReleasePackageGenerationLeaseSync({
      runtimeRoot: value.runtimeRoot,
      releaseRoot: value.oldReleaseRoot,
    });
    t.after(() => holder.release());
    const lost = new AbortController();
    const releaseResources = () => true;
    releaseResources.lostSignal = lost.signal;
    const resourceGovernor = Object.freeze({
      async acquire() { return releaseResources; },
      snapshot() { return Object.freeze({}); },
    });
    let abortTimer;
    await assert.rejects(() => runContendedCampaign(value, {
      maximumWaitMs: 2_000,
      resourceGovernor,
      onExecute: () => {
        abortTimer = setTimeout(() => lost.abort('fixture_resource_lease_lost'), 40);
      },
    }), (error) => {
      assert.match(String(error?.message || ''), /resource_lease_lost/);
      return true;
    });
    if (abortTimer) clearTimeout(abortTimer);
    const node = packageNodeFrom(value.campaignStore.listNodes(value.campaignId));
    assert.equal(node.status, 'queued');
    assert.equal(node.attemptCount, 0);
    assert.equal(value.campaignStore.getCampaign(value.campaignId).cpuJobCount, 0);
    assert.equal(value.campaignStore.listEvents(value.campaignId).filter(
      (event) => event.kind === 'campaign_node_infrastructure_deferred',
    ).length, 1);
    assert.equal(value.campaignStore.listEvents(value.campaignId).some(
      (event) => event.kind === 'campaign_node_retry_queued'
        || event.kind === 'campaign_node_failed_terminal',
    ), false);
    holder.assertHeld();
  });

test('supervisor abort during contention refunds package attempt and CPU budget',
  async (t) => {
    const value = engineFixture(t, 'supervisor-abort');
    const holder = acquireCampaignReleasePackageGenerationLeaseSync({
      runtimeRoot: value.runtimeRoot,
      releaseRoot: value.oldReleaseRoot,
    });
    t.after(() => holder.release());
    const supervisor = new AbortController();
    let abortTimer;
    const paused = await runContendedCampaign(value, {
      maximumWaitMs: 2_000,
      signal: supervisor.signal,
      onExecute: () => {
        abortTimer = setTimeout(
          () => supervisor.abort('fixture_supervisor_shutdown'),
          40,
        );
      },
    });
    if (abortTimer) clearTimeout(abortTimer);
    assert.equal(paused.campaign.status, 'paused');
    let node = packageNodeFrom(paused.nodes);
    assert.equal(node.status, 'queued');
    assert.equal(node.attemptCount, 0);
    assert.equal(paused.campaign.cpuJobCount, 0);
    assert.equal(value.campaignStore.listEvents(value.campaignId).filter(
      (event) => event.kind === 'campaign_node_infrastructure_deferred',
    ).length, 1);
    holder.assertHeld();

    holder.release();
    value.campaignStore.resumeCampaign(value.campaignId);
    const recovered = await runContendedCampaign(value, { maximumWaitMs: 100 });
    node = packageNodeFrom(recovered.nodes);
    assert.equal(recovered.campaign.status, 'completed');
    assert.equal(node.status, 'completed');
    assert.equal(node.attemptCount, 1);
    assert.equal(recovered.campaign.cpuJobCount, 1);
  });

test('operator pause during contention refunds the already requeued package attempt',
  async (t) => {
    const value = engineFixture(t, 'operator-pause');
    const holder = acquireCampaignReleasePackageGenerationLeaseSync({
      runtimeRoot: value.runtimeRoot,
      releaseRoot: value.oldReleaseRoot,
    });
    t.after(() => holder.release());
    let pauseTimer;
    const paused = await runContendedCampaign(value, {
      maximumWaitMs: 2_000,
      onExecute: () => {
        pauseTimer = setTimeout(() => {
          value.campaignStore.pauseCampaign(
            value.campaignId,
            'fixture_operator_pause',
          );
        }, 40);
      },
    });
    if (pauseTimer) clearTimeout(pauseTimer);
    assert.equal(paused.campaign.status, 'paused');
    const packageNode = packageNodeFrom(paused.nodes);
    assert.equal(packageNode.status, 'queued');
    assert.equal(packageNode.attemptCount, 0);
    assert.equal(paused.campaign.cpuJobCount, 0);
    assert.equal(value.campaignStore.listEvents(value.campaignId).filter(
      (event) => event.kind === 'campaign_node_infrastructure_deferred',
    ).length, 1);
    holder.assertHeld();
  });

test('pause-resume race refunds the old contention attempt before redispatch',
  async (t) => {
    const value = engineFixture(t, 'operator-pause-resume');
    const holder = acquireCampaignReleasePackageGenerationLeaseSync({
      runtimeRoot: value.runtimeRoot,
      releaseRoot: value.oldReleaseRoot,
    });
    t.after(() => holder.release());
    let executions = 0;
    let pauseTimer;
    let resumeTimer;
    const releaseTimer = setTimeout(() => holder.release(), 800);
    t.after(() => clearTimeout(releaseTimer));
    const result = await runContendedCampaign(value, {
      maximumWaitMs: 2_000,
      onExecute: () => {
        executions += 1;
        if (executions !== 1) return;
        pauseTimer = setTimeout(() => value.campaignStore.pauseCampaign(
          value.campaignId,
          'fixture_operator_pause_resume',
        ), 40);
        resumeTimer = setTimeout(() => value.campaignStore.resumeCampaign(
          value.campaignId,
        ), 100);
      },
    });
    if (pauseTimer) clearTimeout(pauseTimer);
    if (resumeTimer) clearTimeout(resumeTimer);
    const packageNode = packageNodeFrom(result.nodes);
    assert.equal(result.campaign.status, 'completed');
    assert.equal(packageNode.status, 'completed');
    assert.equal(packageNode.attemptCount, 1);
    assert.equal(result.campaign.cpuJobCount, 1);
    assert.equal(executions, 2);
    assert.equal(value.campaignStore.listEvents(value.campaignId).filter(
      (event) => event.kind === 'campaign_node_infrastructure_deferred',
    ).length, 1);
  });
