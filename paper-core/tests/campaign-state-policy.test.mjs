import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import {
  cascadeCancelledNodeIds,
  decideCampaignCommand,
  decideManualNodeRetry,
  decideNodeFailureTransition,
  deriveCampaignOperationalProjection,
  selectReadyCampaignNodes,
  selectFutureRoundNodeIds,
} from '../../paper-domain/automation/campaign-state-policy.mjs';

const workspaceRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..', '..');

test('campaign domain policy owns projection, ready selection and retry semantics', () => {
  const nodes = [
    { nodeId: 'compile', kind: 'compile', status: 'completed', priority: 10, dependencies: [], roundIndex: 0 },
    { nodeId: 'review', kind: 'referee-1', status: 'queued', priority: 20, dependencies: ['compile'], roundIndex: 1 },
    { nodeId: 'revise', kind: 'revision-referee-1', status: 'queued', priority: 30, dependencies: ['review'], roundIndex: 1 },
  ];
  assert.deepEqual(selectReadyCampaignNodes(nodes).map((node) => node.nodeId), ['review']);
  assert.deepEqual(selectFutureRoundNodeIds([...nodes, { nodeId: 'later', kind: 'referee-2', status: 'queued', roundIndex: 2 }], { afterRound: 1 }), ['later']);
  assert.deepEqual(deriveCampaignOperationalProjection(nodes), {
    version: 1,
    kind: 'CampaignOperationalProjection',
    status: 'running',
    currentPhase: 'referee-1',
    currentReviewRound: 0,
    terminal: false,
  });
  assert.equal(decideNodeFailureTransition({ attemptCount: 1, maxAttempts: 3 }, { retryable: true }).status, 'queued');
  assert.equal(decideNodeFailureTransition({ attemptCount: 3, maxAttempts: 3 }, { retryable: true }).status, 'failed_terminal');
  assert.equal(decideManualNodeRetry({ status: 'failed_terminal' }).apply, true);
});

test('early convergence skips only round work and preserves immutable terminal definitions', () => {
  const nodes = [
    { nodeId: 'replay-1', kind: 'revalidate-empirical-reproduce', status: 'completed', roundIndex: 1 },
    { nodeId: 'convergence-1', kind: 'convergence', status: 'completed', roundIndex: 1 },
    { nodeId: 'replay-2', kind: 'revalidate-empirical-reproduce', status: 'queued', roundIndex: 2 },
    { nodeId: 'convergence-2', kind: 'convergence', status: 'queued', roundIndex: 2 },
    { nodeId: 'final', kind: 'final-compile', status: 'queued', roundIndex: 3, dependencies: ['convergence-2'] },
    { nodeId: 'research', kind: 'research-verify', status: 'queued', roundIndex: 4, dependencies: ['final', 'replay-2'] },
    { nodeId: 'package', kind: 'package', status: 'queued', roundIndex: 4, dependencies: ['final', 'research'] },
  ];
  assert.deepEqual(selectFutureRoundNodeIds(nodes, { afterRound: 1 }), ['convergence-2', 'replay-2']);
  assert.deepEqual(nodes.find((node) => node.nodeId === 'final').dependencies, ['convergence-2']);
  assert.deepEqual(nodes.find((node) => node.nodeId === 'research').dependencies, ['final', 'replay-2']);
});

test('campaign command and cancellation cascade policy is independent of SQLite', () => {
  const nodes = [
    { nodeId: 'root', dependencies: [] },
    { nodeId: 'child', dependencies: ['root'] },
    { nodeId: 'sibling', dependencies: [] },
    { nodeId: 'grandchild', dependencies: ['child'] },
  ];
  assert.deepEqual(cascadeCancelledNodeIds(nodes, 'root'), ['child', 'grandchild', 'root']);
  assert.deepEqual(decideCampaignCommand({ status: 'running' }, 'pause'), { apply: true, nextStatus: 'paused' });
  assert.equal(decideCampaignCommand({ status: 'completed' }, 'cancel').apply, false);
  assert.equal(deriveCampaignOperationalProjection([{ nodeId: 'n', kind: 'compile', status: 'failed_terminal' }]).status, 'failed');
  assert.equal(deriveCampaignOperationalProjection([{ nodeId: 'n', kind: 'compile', status: 'completed' }]).status, 'completed');
});

test('campaign application consumes canonical camelCase DTOs only', () => {
  const engine = fs.readFileSync(path.join(workspaceRoot, 'paper-application/automation/campaign-engine.mjs'), 'utf8');
  assert.doesNotMatch(engine, /\.(?:node_id|campaign_id|paper_id|lease_owner|failure_class|round_index|lease_generation|node_revision)\b/);
  const persistenceSources = [
    'sqlite-campaign-store.mjs',
    'sqlite-campaign-lifecycle-operations.mjs',
    'sqlite-campaign-lease-operations.mjs',
    'sqlite-campaign-prepared-integration-operations.mjs',
  ].map((file) => fs.readFileSync(path.join(workspaceRoot, 'paper-adapters/persistence', file), 'utf8')).join('\n');
  assert.equal(persistenceSources.includes('selectReadyCampaignNodes'), true);
  assert.equal(persistenceSources.includes('decideNodeFailureTransition'), true);
  assert.equal(persistenceSources.includes('cascadeCancelledNodeIds'), true);
  assert.equal(persistenceSources.includes('selectFutureRoundNodeIds'), true);
  assert.equal(persistenceSources.includes('buildSqliteCampaignProjectionStatement'), true);
  assert.equal(persistenceSources.includes('const terminalFailure ='), false);
});
