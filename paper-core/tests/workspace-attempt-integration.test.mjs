import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  buildWorkspaceIntegrationDescriptorSync,
  integrateWorkspaceAttemptSync,
  prepareWorkspaceAttemptSync,
  snapshotWorkspaceFilesSync,
} from '../../paper-adapters/automation/workspace-attempt-repository.mjs';
import { createCampaignNodeExecutor } from '../../paper-composition/automation/campaign-node-execution-composition.mjs';
import { createDefaultPaperStore } from '../../paper-adapters/persistence/store-provider.mjs';
import { createSqliteCampaignStore } from '../../paper-adapters/persistence/sqlite-campaign-store.mjs';
import { runPaperCampaign as executePaperCampaign } from '../../paper-application/automation/campaign-engine.mjs';
import { hashRecord } from '../../workflow-kernel/record-hash.mjs';
import { createSystemScheduler } from '../../paper-adapters/runtime/system-scheduler.mjs';
import { createRandomIdGenerator } from '../../paper-adapters/runtime/random-id-generator.mjs';
import { acquireWorkspaceCommitLock } from '../../paper-adapters/automation/workspace-attempt-commit-journal-repository.mjs';
import { currentProcessIdentity } from '../../workflow-kernel/runtime/process-identity.mjs';

const campaignClocks = new WeakMap();
const scheduler = createSystemScheduler();
const idGenerator = createRandomIdGenerator();

function runPaperCampaign(input) {
  return executePaperCampaign({ ...input, clock: campaignClocks.get(input.campaignStore), scheduler, idGenerator });
}

function workspaceFixture(t, name) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `hepta-${name}-`));
  const source = path.join(root, 'source');
  const runtime = path.join(root, 'runtime');
  fs.mkdirSync(source);
  fs.mkdirSync(runtime);
  fs.writeFileSync(path.join(source, 'main.tex'), 'before\n');
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return { root, source, runtime };
}

function campaignFixture(t, name, { maxWallTimeMs = 60_000 } = {}) {
  const fixture = workspaceFixture(t, name);
  let milliseconds = Date.parse('2026-07-14T00:00:00.000Z');
  const clock = {
    now: () => new Date(milliseconds),
    nowIso: () => new Date(milliseconds += 1).toISOString(),
    advance: (delta) => { milliseconds += delta; },
  };
  const store = createDefaultPaperStore({ root: fixture.root, runtimeRoot: fixture.runtime });
  t.after(() => store.close?.());
  const campaigns = createSqliteCampaignStore({ store, clock });
  campaignClocks.set(campaigns, clock);
  const campaignId = `${name}-campaign`;
  campaigns.createCampaign({
    version: 2,
    kind: 'PaperCampaignPlan',
    campaignId,
    paperId: `${name}-paper`,
    sourceWorkspace: fixture.source,
    maxRounds: 1,
    budgets: {
      maxWallTimeMs,
      maxAgentCalls: 10,
      maxCpuJobs: 10,
      maxGpuJobs: 0,
      maxTokenCount: 10_000,
      maxCostUsd: 10,
      maxMemoryMiB: 2048,
    },
    nodes: [{ nodeId: `${campaignId}:writer`, kind: 'writer', roundIndex: 0, priority: 10, maxAttempts: 3, dependencies: [] }],
  });
  return { ...fixture, clock, store, campaigns, campaignId };
}

function createWritingCampaignExecutor({ runtime, onExecute = null } = {}) {
  return createCampaignNodeExecutor({
    runtimeRoot: runtime,
    empiricalExecutor: { async execute() { throw new Error('empirical executor should not run for writer fixture'); } },
    agentExecutor: {
      async execute(input) {
        onExecute?.(input);
        fs.writeFileSync(path.join(input.workspacePath, 'main.tex'), 'after\n');
        fs.writeFileSync(path.join(input.workspacePath, 'NEW.md'), 'new\n');
        return {
          status: 'agent_execution_completed',
          agentExecutionReceiptHash: 'sha256:writer-fixture',
          usage: { totalTokens: 5 },
        };
      },
    },
  });
}

function campaignStoreProxy(store, overrides = {}) {
  const proxy = new Proxy(store, {
    get(target, property) {
      if (Object.prototype.hasOwnProperty.call(overrides, property)) return overrides[property];
      return Reflect.get(target, property);
    },
  });
  campaignClocks.set(proxy, campaignClocks.get(store));
  return proxy;
}

function directAttempt({ source, runtime, suffix = 'a', campaignId = 'campaign', nodeId = 'campaign:writer', attemptId = `attempt-${suffix}` } = {}) {
  const attemptRelative = `attempts/${suffix}`;
  const attempt = prepareWorkspaceAttemptSync({
    sourceRoot: source,
    attemptBaseRoot: runtime,
    attemptRelative,
    campaignId,
    nodeId,
    attemptId,
  });
  const authority = {
    campaignId,
    nodeId,
    originalAttemptId: attemptId,
    sourceRoot: source,
    attemptRoot: attempt.attemptWorkspace,
    runtimeRoot: runtime,
  };
  return { attempt, authority };
}

function rehashDescriptor(descriptor, patch = {}) {
  const { workspaceAttemptIntegrationDescriptorHash: ignored, ...payload } = { ...descriptor, ...patch };
  return {
    ...payload,
    workspaceAttemptIntegrationDescriptorHash: hashRecord('WorkspaceAttemptIntegrationDescriptor', payload),
  };
}

test('workspace attempt snapshots and clones always exclude materialization recovery state', (t) => {
  const { source, runtime } = workspaceFixture(t, 'workspace-attempt-recovery-exclusion');
  const recovery = path.join(source, '.hepta-materialization-recovery');
  fs.mkdirSync(recovery);
  fs.writeFileSync(path.join(recovery, 'completed-operation.tombstone'), 'internal recovery state\n');

  const snapshot = snapshotWorkspaceFilesSync({ root: source, excludedNames: new Set() });
  assert.deepEqual([...snapshot.keys()], ['main.tex']);

  const { attempt } = directAttempt({ source, runtime, suffix: 'recovery-exclusion' });
  assert.equal(attempt.excludedNames.includes('.hepta-materialization-recovery'), true);
  assert.equal(fs.existsSync(path.join(attempt.attemptWorkspace, '.hepta-materialization-recovery')), false);

  const attemptRecovery = path.join(attempt.attemptWorkspace, '.hepta-materialization-recovery');
  fs.mkdirSync(attemptRecovery);
  fs.writeFileSync(path.join(attemptRecovery, 'attempt-only.tombstone'), 'attempt recovery state\n');
  const descriptor = buildWorkspaceIntegrationDescriptorSync(attempt);
  assert.deepEqual(descriptor.changes, []);
  assert.equal(descriptor.attemptPostimage.some((entry) => entry.path.includes('.hepta-materialization-recovery')), false);
});

test('workspace attempt preparation and executor writes leave the source unchanged until integration', async (t) => {
  const { source, runtime } = workspaceFixture(t, 'workspace-attempt-source-isolation');
  let delegatedWorkspace = null;
  const executor = createWritingCampaignExecutor({ runtime, onExecute: (input) => { delegatedWorkspace = input.workspacePath; } });
  const campaign = { campaignId: 'campaign', paperId: 'paper', spec: { sourceWorkspace: source } };
  const node = { nodeId: 'campaign:writer', kind: 'writer', roundIndex: 0, attemptId: 'attempt-1' };
  const result = await executor.execute({
    campaign,
    node,
    allNodes: [],
    deferWorkspaceIntegration: true,
  });

  assert.notEqual(path.resolve(delegatedWorkspace), path.resolve(source));
  assert.equal(fs.readFileSync(path.join(source, 'main.tex'), 'utf8'), 'before\n');
  assert.equal(fs.existsSync(path.join(source, 'NEW.md')), false);
  assert.equal(fs.readFileSync(path.join(delegatedWorkspace, 'main.tex'), 'utf8'), 'after\n');
  assert.ok(result.workspaceAttemptIntegration?.workspaceAttemptIntegrationDescriptorHash);

  const receipt = executor.integratePrepared({ campaign, node, result });
  assert.equal(receipt.status, 'workspace_attempt_integrated');
  assert.equal(fs.readFileSync(path.join(source, 'main.tex'), 'utf8'), 'after\n');
  assert.equal(fs.readFileSync(path.join(source, 'NEW.md'), 'utf8'), 'new\n');
});

test('workspace integration is idempotent and reports already-integrated postimages', (t) => {
  const { source, runtime } = workspaceFixture(t, 'workspace-attempt-idempotent');
  const { attempt, authority } = directAttempt({ source, runtime });
  fs.writeFileSync(path.join(attempt.attemptWorkspace, 'main.tex'), 'after\n');
  fs.writeFileSync(path.join(attempt.attemptWorkspace, 'NEW.md'), 'new\n');
  const descriptor = buildWorkspaceIntegrationDescriptorSync(attempt);

  const first = integrateWorkspaceAttemptSync(descriptor, { authority });
  const second = integrateWorkspaceAttemptSync(descriptor, { authority });
  assert.deepEqual(first.changedPaths.slice().sort(), ['NEW.md', 'main.tex']);
  assert.deepEqual(second.alreadyIntegratedPaths.slice().sort(), ['NEW.md', 'main.tex']);
  assert.equal(fs.readFileSync(path.join(source, 'main.tex'), 'utf8'), 'after\n');
  assert.equal(fs.readFileSync(path.join(source, 'NEW.md'), 'utf8'), 'new\n');
});

test('workspace integration rejects a source preimage conflict without overwriting concurrent work', (t) => {
  const { source, runtime } = workspaceFixture(t, 'workspace-attempt-preimage-conflict');
  const { attempt, authority } = directAttempt({ source, runtime });
  fs.writeFileSync(path.join(attempt.attemptWorkspace, 'main.tex'), 'attempt-change\n');
  const descriptor = buildWorkspaceIntegrationDescriptorSync(attempt);
  fs.writeFileSync(path.join(source, 'main.tex'), 'concurrent-change\n');

  assert.throws(
    () => integrateWorkspaceAttemptSync(descriptor, { authority }),
    (error) => error.retryable === true
      && error.message === 'workspace_attempt_integration_conflict:main.tex'
      && error.conflicts?.[0] === 'main.tex',
  );
  assert.equal(fs.readFileSync(path.join(source, 'main.tex'), 'utf8'), 'concurrent-change\n');
});

test('workspace integration rejects descriptor and attempt-postimage tampering', (t) => {
  const { source, runtime } = workspaceFixture(t, 'workspace-attempt-tamper');
  const { attempt, authority } = directAttempt({ source, runtime });
  fs.writeFileSync(path.join(attempt.attemptWorkspace, 'main.tex'), 'after\n');
  const descriptor = buildWorkspaceIntegrationDescriptorSync(attempt);
  const tamperedDescriptor = {
    ...descriptor,
    changes: descriptor.changes.map((change) => ({ ...change, postimageHash: 'sha256:forged' })),
  };
  assert.throws(() => integrateWorkspaceAttemptSync(tamperedDescriptor, { authority }), /workspace_attempt_integration_change_manifest_mismatch|workspace_attempt_integration_descriptor_hash_invalid/);

  fs.writeFileSync(path.join(attempt.attemptWorkspace, 'main.tex'), 'tampered-after-prepare\n');
  assert.throws(() => integrateWorkspaceAttemptSync(descriptor, { authority }), /workspace_attempt_postimage_manifest_mismatch/);
  assert.equal(fs.readFileSync(path.join(source, 'main.tex'), 'utf8'), 'before\n');
});

test('workspace integration durably applies and replays a file deletion', (t) => {
  const { source, runtime } = workspaceFixture(t, 'workspace-attempt-delete');
  fs.writeFileSync(path.join(source, 'obsolete.txt'), 'remove me\n');
  const { attempt, authority } = directAttempt({ source, runtime });
  fs.unlinkSync(path.join(attempt.attemptWorkspace, 'obsolete.txt'));
  const descriptor = buildWorkspaceIntegrationDescriptorSync(attempt);

  const first = integrateWorkspaceAttemptSync(descriptor, { authority });
  const replay = integrateWorkspaceAttemptSync(descriptor, { authority });

  assert.equal(fs.existsSync(path.join(source, 'obsolete.txt')), false);
  assert.deepEqual(first.changedPaths, ['obsolete.txt']);
  assert.deepEqual(replay.alreadyIntegratedPaths, ['obsolete.txt']);
  assert.ok(replay.journalHash);
});

test('workspace integration rejects duplicate change paths even with a recomputed descriptor hash', (t) => {
  const { source, runtime } = workspaceFixture(t, 'workspace-attempt-duplicate-path');
  const { attempt, authority } = directAttempt({ source, runtime });
  fs.writeFileSync(path.join(attempt.attemptWorkspace, 'main.tex'), 'after\n');
  const descriptor = buildWorkspaceIntegrationDescriptorSync(attempt);
  const duplicate = rehashDescriptor(descriptor, { changes: [...descriptor.changes, descriptor.changes[0]] });

  assert.throws(
    () => integrateWorkspaceAttemptSync(duplicate, { authority }),
    /workspace_attempt_integration_duplicate_path:main\.tex/,
  );
  assert.equal(fs.readFileSync(path.join(source, 'main.tex'), 'utf8'), 'before\n');
});

test('workspace integration rejects root substitution even when the descriptor hash is recomputed', (t) => {
  const { root, source, runtime } = workspaceFixture(t, 'workspace-attempt-root-substitution');
  const substitutedSource = path.join(root, 'substituted-source');
  fs.mkdirSync(substitutedSource);
  fs.writeFileSync(path.join(substitutedSource, 'main.tex'), 'substituted\n');
  const { attempt, authority } = directAttempt({ source, runtime });
  fs.writeFileSync(path.join(attempt.attemptWorkspace, 'main.tex'), 'after\n');
  const descriptor = buildWorkspaceIntegrationDescriptorSync(attempt);
  const substituted = rehashDescriptor(descriptor, { sourceWorkspace: substitutedSource });

  assert.throws(
    () => integrateWorkspaceAttemptSync(substituted, { authority }),
    /workspace_attempt_integration_authoritative_root_mismatch/,
  );
  assert.equal(fs.readFileSync(path.join(source, 'main.tex'), 'utf8'), 'before\n');
  assert.equal(fs.readFileSync(path.join(substitutedSource, 'main.tex'), 'utf8'), 'substituted\n');
});

test('workspace integration rejects a stale unchanged read-set before any changed path is committed', (t) => {
  const { source, runtime } = workspaceFixture(t, 'workspace-attempt-stale-read-set');
  fs.writeFileSync(path.join(source, 'inputs.txt'), 'input-v1\n');
  const { attempt, authority } = directAttempt({ source, runtime });
  fs.writeFileSync(path.join(attempt.attemptWorkspace, 'main.tex'), 'based-on-input-v1\n');
  const descriptor = buildWorkspaceIntegrationDescriptorSync(attempt);
  fs.writeFileSync(path.join(source, 'inputs.txt'), 'input-v2\n');

  assert.throws(
    () => integrateWorkspaceAttemptSync(descriptor, { authority }),
    (error) => error.retryable === true && /workspace_attempt_read_set_stale:inputs\.txt/.test(error.message),
  );
  assert.equal(fs.readFileSync(path.join(source, 'main.tex'), 'utf8'), 'before\n');
});

test('workspace integration replays a durable journal after a mid-commit crash', (t) => {
  const { source, runtime } = workspaceFixture(t, 'workspace-attempt-mid-commit');
  fs.writeFileSync(path.join(source, 'second.txt'), 'second-before\n');
  const { attempt, authority } = directAttempt({ source, runtime });
  fs.writeFileSync(path.join(attempt.attemptWorkspace, 'main.tex'), 'main-after\n');
  fs.writeFileSync(path.join(attempt.attemptWorkspace, 'second.txt'), 'second-after\n');
  const descriptor = buildWorkspaceIntegrationDescriptorSync(attempt);
  let injected = false;

  assert.throws(
    () => integrateWorkspaceAttemptSync(descriptor, {
      authority,
      faultInjector(event) {
        if (!injected && event.phase === 'after_path_commit_before_journal') {
          injected = true;
          throw new Error('injected_mid_commit_crash');
        }
      },
    }),
    /injected_mid_commit_crash/,
  );
  const partialValues = [
    fs.readFileSync(path.join(source, 'main.tex'), 'utf8'),
    fs.readFileSync(path.join(source, 'second.txt'), 'utf8'),
  ];
  assert.equal(partialValues.filter((value) => value.endsWith('after\n')).length, 1);

  const replay = integrateWorkspaceAttemptSync(descriptor, { authority });
  assert.equal(replay.status, 'workspace_attempt_integrated');
  assert.equal(fs.readFileSync(path.join(source, 'main.tex'), 'utf8'), 'main-after\n');
  assert.equal(fs.readFileSync(path.join(source, 'second.txt'), 'utf8'), 'second-after\n');
  assert.equal(replay.alreadyIntegratedPaths.length, 1);
});

test('workspace integration removes a staged temporary file when commit preparation throws', (t) => {
  const { source, runtime } = workspaceFixture(t, 'workspace-attempt-stage-cleanup');
  const { attempt, authority } = directAttempt({ source, runtime });
  fs.writeFileSync(path.join(attempt.attemptWorkspace, 'main.tex'), 'after\n');
  const descriptor = buildWorkspaceIntegrationDescriptorSync(attempt);

  assert.throws(
    () => integrateWorkspaceAttemptSync(descriptor, {
      authority,
      faultInjector(event) {
        if (event.phase === 'after_path_staged_before_commit') throw new Error('injected_before_commit');
      },
    }),
    /injected_before_commit/,
  );
  assert.equal(fs.readFileSync(path.join(source, 'main.tex'), 'utf8'), 'before\n');
  assert.deepEqual(fs.readdirSync(source).filter((name) => name.includes('.hepta-') && name.endsWith('.tmp')), []);

  const replay = integrateWorkspaceAttemptSync(descriptor, { authority });
  assert.equal(replay.status, 'workspace_attempt_integrated');
  assert.equal(fs.readFileSync(path.join(source, 'main.tex'), 'utf8'), 'after\n');
});

test('workspace commit lock rejects a concurrent integrator for the same source root', (t) => {
  const { source, runtime } = workspaceFixture(t, 'workspace-attempt-concurrent-lock');
  const { attempt, authority } = directAttempt({ source, runtime });
  fs.writeFileSync(path.join(attempt.attemptWorkspace, 'main.tex'), 'after\n');
  const descriptor = buildWorkspaceIntegrationDescriptorSync(attempt);
  let nestedError = null;

  const receipt = integrateWorkspaceAttemptSync(descriptor, {
    authority,
    faultInjector(event) {
      if (event.phase !== 'after_path_commit_before_journal' || nestedError) return;
      try { integrateWorkspaceAttemptSync(descriptor, { authority }); }
      catch (error) { nestedError = error; }
    },
  });

  assert.equal(receipt.status, 'workspace_attempt_integrated');
  assert.match(nestedError?.message || '', /workspace_attempt_commit_lock_busy/);
  assert.equal(nestedError?.retryable, true);
});

test('workspace commit lock binds process start time and reclaims a PID-reused owner', (t) => {
  const { runtime } = workspaceFixture(t, 'workspace-attempt-pid-reuse-lock');
  const identity = currentProcessIdentity();
  if (!identity.pidStartTime) {
    t.skip('process start time is unavailable on this platform');
    return;
  }
  const sourceIdentity = { workspaceAttemptRootIdentityHash: 'pid-reuse-source' };
  const lockDirectory = path.join(runtime, 'workspace-attempt-integration-locks');
  fs.mkdirSync(lockDirectory);
  const lockPath = path.join(lockDirectory, `${sourceIdentity.workspaceAttemptRootIdentityHash}.lock`);
  const staleToken = '11111111-1111-4111-8111-111111111111';
  fs.mkdirSync(lockPath);
  fs.writeFileSync(path.join(lockPath, `owner-${staleToken}.json`), `${JSON.stringify({
    version: 2,
    kind: 'WorkspaceAttemptCommitLock',
    pid: identity.pid,
    pidStartTime: `${identity.pidStartTime}0`,
    token: staleToken,
    descriptorHash: 'sha256:stale-descriptor',
    sourceRootIdentityHash: sourceIdentity.workspaceAttemptRootIdentityHash,
    createdAt: new Date().toISOString(),
  })}\n`);

  const lock = acquireWorkspaceCommitLock({
    runtimeRoot: runtime,
    sourceIdentity,
    descriptorHash: 'sha256:current-descriptor',
  });
  try {
    const persisted = JSON.parse(fs.readFileSync(lock.ownerPath, 'utf8'));
    assert.equal(persisted.pid, identity.pid);
    assert.equal(persisted.pidStartTime, identity.pidStartTime);
    assert.notEqual(persisted.token, staleToken);
    lock.assertOwned();
  } finally {
    lock.release();
  }
});

test('workspace commit lock recovery cannot unlink or supersede a competing reaper at removal', (t) => {
  const { runtime } = workspaceFixture(t, 'workspace-attempt-stale-lock-replaced');
  const identity = currentProcessIdentity();
  const sourceIdentity = { workspaceAttemptRootIdentityHash: 'stale-lock-replaced-source' };
  const lockDirectory = path.join(runtime, 'workspace-attempt-integration-locks');
  fs.mkdirSync(lockDirectory);
  const lockPath = path.join(lockDirectory, `${sourceIdentity.workspaceAttemptRootIdentityHash}.lock`);
  const lockPayload = (overrides) => ({
    version: 2,
    kind: 'WorkspaceAttemptCommitLock',
    pid: identity.pid,
    pidStartTime: identity.pidStartTime,
    descriptorHash: 'sha256:descriptor',
    sourceRootIdentityHash: sourceIdentity.workspaceAttemptRootIdentityHash,
    createdAt: new Date().toISOString(),
    ...overrides,
  });
  const writeLockDirectory = (target, payload) => {
    fs.mkdirSync(target);
    fs.writeFileSync(
      path.join(target, `owner-${payload.token}.json`),
      `${JSON.stringify(payload)}\n`,
    );
  };
  const staleToken = '22222222-2222-4222-8222-222222222222';
  writeLockDirectory(lockPath, lockPayload({
    pid: 999_999_999,
    pidStartTime: null,
    token: staleToken,
  }));

  const staleOwnerPath = path.join(lockPath, `owner-${staleToken}.json`);
  const originalUnlinkSync = fs.unlinkSync;
  let competingLock = null;
  let competingReaperStarted = false;
  fs.unlinkSync = function unlinkWithReplacement(target) {
    if (!competingReaperStarted && target === staleOwnerPath) {
      competingReaperStarted = true;
      competingLock = acquireWorkspaceCommitLock({
        runtimeRoot: runtime,
        sourceIdentity,
        descriptorHash: 'sha256:competing-reaper-descriptor',
      });
    }
    return originalUnlinkSync.call(this, target);
  };
  try {
    assert.throws(
      () => acquireWorkspaceCommitLock({
        runtimeRoot: runtime,
        sourceIdentity,
        descriptorHash: 'sha256:contender-descriptor',
      }),
      (error) => error.retryable === true && /workspace_attempt_commit_lock_busy/.test(error.message),
    );
  } finally {
    fs.unlinkSync = originalUnlinkSync;
  }

  assert.equal(competingReaperStarted, true);
  assert.ok(competingLock);
  try {
    competingLock.assertOwned();
    assert.equal(JSON.parse(fs.readFileSync(competingLock.ownerPath, 'utf8')).token, competingLock.token);
    assert.deepEqual(fs.readdirSync(lockPath), [path.basename(competingLock.ownerPath)]);
  } finally {
    competingLock.release();
  }
});

test('workspace attempt preparation rejects a runtime destination nested under the source root', (t) => {
  const { root, source } = workspaceFixture(t, 'workspace-attempt-overlap');
  const nestedRuntime = path.join(source, 'custom-runtime');
  fs.mkdirSync(nestedRuntime);
  const sourceAlias = path.join(root, 'source-alias');
  fs.symlinkSync(source, sourceAlias, 'dir');

  assert.throws(
    () => prepareWorkspaceAttemptSync({
      sourceRoot: source,
      attemptBaseRoot: path.join(sourceAlias, 'custom-runtime'),
      attemptRelative: 'attempts/a',
      campaignId: 'campaign',
      nodeId: 'campaign:writer',
      attemptId: 'attempt-a',
    }),
    /workspace_attempt_roots_overlap/,
  );
  assert.equal(fs.existsSync(path.join(nestedRuntime, 'attempts', 'a')), false);
});

test('integration replay after a crash before the durable mark is idempotent and does not re-execute the node', async (t) => {
  const { source, runtime, campaigns, campaignId } = campaignFixture(t, 'workspace-attempt-mark-crash');
  let executionCount = 0;
  let integrationCount = 0;
  const delegate = createWritingCampaignExecutor({ runtime, onExecute: () => { executionCount += 1; } });
  const executor = {
    execute: (input) => delegate.execute(input),
    integratePrepared(input) {
      integrationCount += 1;
      const receipt = delegate.integratePrepared(input);
      if (integrationCount === 1) {
        const error = new Error('injected_crash_after_integration_before_mark');
        error.retryable = true;
        throw error;
      }
      return receipt;
    },
  };

  const run = await runPaperCampaign({ campaignId, campaignStore: campaigns, executor, concurrency: 1, pollMs: 1 });
  assert.equal(run.campaign.status, 'completed');
  assert.equal(run.retryCount, 1);
  assert.equal(executionCount, 1);
  assert.equal(integrationCount, 2);
  assert.equal(fs.readFileSync(path.join(source, 'main.tex'), 'utf8'), 'after\n');
  assert.equal(fs.readFileSync(path.join(source, 'NEW.md'), 'utf8'), 'new\n');
  assert.ok(run.nodes[0].preparedIntegratedAt);
  assert.ok(run.nodes[0].integratedAt);
});

test('cancellation after prepare fences workspace integration and leaves the source unchanged', async (t) => {
  const { source, runtime, campaigns, campaignId } = campaignFixture(t, 'workspace-attempt-cancel-fence');
  let integrationCount = 0;
  const executor = createWritingCampaignExecutor({ runtime });
  const fencedStore = campaignStoreProxy(campaigns, {
    prepareNodeResult(input) {
      const prepared = campaigns.prepareNodeResult(input);
      campaigns.cancelCampaign(campaignId, 'injected_cancel_after_prepare');
      return prepared;
    },
  });
  const wrappedExecutor = {
    execute: (input) => executor.execute(input),
    integratePrepared(input) { integrationCount += 1; return executor.integratePrepared(input); },
  };

  const run = await runPaperCampaign({ campaignId, campaignStore: fencedStore, executor: wrappedExecutor, concurrency: 1, pollMs: 1 });
  assert.equal(run.campaign.status, 'cancelled');
  assert.equal(integrationCount, 0);
  assert.equal(fs.readFileSync(path.join(source, 'main.tex'), 'utf8'), 'before\n');
  assert.equal(fs.existsSync(path.join(source, 'NEW.md')), false);
});

for (const terminalStatus of ['paused', 'cancelled']) {
  test(`a ${terminalStatus} campaign racing integration intent is fenced before source mutation`, async (t) => {
    const { source, runtime, store, campaigns, campaignId } = campaignFixture(t, `workspace-attempt-${terminalStatus}-after-intent`);
    let integrationCount = 0;
    const executor = createWritingCampaignExecutor({ runtime });
    const fencedStore = campaignStoreProxy(campaigns, {
      beginNodeResultIntegration(input) {
        const integrating = campaigns.beginNodeResultIntegration(input);
        const nodeStatus = terminalStatus === 'paused' ? 'queued' : 'skipped';
        const transition = store.execute(`BEGIN IMMEDIATE;
          UPDATE paper_campaigns SET status='${terminalStatus}',stop_reason='injected_${terminalStatus}_after_intent',last_resumed_at=NULL,revision=revision+1 WHERE campaign_id='${campaignId}';
          UPDATE campaign_nodes SET status='${nodeStatus}',lease_owner=NULL,lease_expires_at=NULL,attempt_id=NULL,node_revision=node_revision+1 WHERE node_id='${input.nodeId}';
          COMMIT;`);
        assert.equal(transition.ok, true);
        return integrating;
      },
    });
    const wrappedExecutor = {
      execute: (input) => executor.execute(input),
      integratePrepared(input) { integrationCount += 1; return executor.integratePrepared(input); },
    };

    const run = await runPaperCampaign({ campaignId, campaignStore: fencedStore, executor: wrappedExecutor, concurrency: 1, pollMs: 1 });
    assert.equal(run.campaign.status, terminalStatus);
    assert.equal(integrationCount, 0);
    assert.equal(fs.readFileSync(path.join(source, 'main.tex'), 'utf8'), 'before\n');
    assert.equal(fs.existsSync(path.join(source, 'NEW.md')), false);
  });
}

test('lease recovery after integration intent is fenced before the stale attempt mutates source', async (t) => {
  const { source, runtime, clock, campaigns, campaignId } = campaignFixture(t, 'workspace-attempt-recovery-after-intent', { maxWallTimeMs: 3_600_000 });
  const executionAttempts = [];
  const integrationAttempts = [];
  const executor = createWritingCampaignExecutor({ runtime });
  let injected = false;
  const fencedStore = campaignStoreProxy(campaigns, {
    beginNodeResultIntegration(input) {
      const integrating = campaigns.beginNodeResultIntegration(input);
      if (!injected) {
        injected = true;
        clock.advance(1_801_000);
        assert.equal(campaigns.recoverExpiredLeases(campaignId).length, 1);
      }
      return integrating;
    },
  });
  const wrappedExecutor = {
    execute(input) {
      executionAttempts.push(input.node.attemptId);
      return executor.execute(input);
    },
    integratePrepared(input) {
      integrationAttempts.push(input.node.attemptId);
      return executor.integratePrepared(input);
    },
  };

  const run = await runPaperCampaign({ campaignId, campaignStore: fencedStore, executor: wrappedExecutor, concurrency: 1, leaseSeconds: 1, pollMs: 1 });
  assert.equal(run.campaign.status, 'completed');
  assert.equal(executionAttempts.length, 1);
  assert.equal(integrationAttempts.length, 1);
  assert.notEqual(integrationAttempts[0], executionAttempts[0]);
  assert.equal(fs.readFileSync(path.join(source, 'main.tex'), 'utf8'), 'after\n');
});

test('a lost attempt never integrates; the recovered attempt replays the prepared descriptor', async (t) => {
  const { source, runtime, clock, campaigns, campaignId } = campaignFixture(t, 'workspace-attempt-lost-lease');
  const executionAttempts = [];
  const integrationAttempts = [];
  const executor = createWritingCampaignExecutor({ runtime });
  let injected = false;
  const fencedStore = campaignStoreProxy(campaigns, {
    prepareNodeResult(input) {
      const prepared = campaigns.prepareNodeResult(input);
      if (!injected) {
        injected = true;
        clock.advance(2000);
        campaigns.recoverExpiredLeases(campaignId);
      }
      return prepared;
    },
  });
  const wrappedExecutor = {
    execute(input) {
      executionAttempts.push(input.node.attemptId);
      return executor.execute(input);
    },
    integratePrepared(input) {
      integrationAttempts.push(input.node.attemptId);
      return executor.integratePrepared(input);
    },
  };

  const run = await runPaperCampaign({ campaignId, campaignStore: fencedStore, executor: wrappedExecutor, concurrency: 1, leaseSeconds: 1, pollMs: 1 });
  assert.equal(run.campaign.status, 'completed');
  assert.equal(integrationAttempts.length, 1);
  assert.notEqual(integrationAttempts[0], executionAttempts[0]);
  assert.equal(fs.readFileSync(path.join(source, 'main.tex'), 'utf8'), 'after\n');
});
