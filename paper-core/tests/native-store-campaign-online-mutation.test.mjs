import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';

import {
  createExternallyFencedSqliteMutationTransaction,
} from '../../paper-adapters/automation/externally-fenced-sqlite-mutation-plan.mjs';
import {
  NATIVE_STORE_CAMPAIGN_MUTATION_PLANS,
  NATIVE_STORE_CAMPAIGN_OPERATION_IDS,
  NATIVE_STORE_CAMPAIGN_STATEMENT_IDS,
} from '../../paper-adapters/persistence/native-store-campaign-mutation-plan.mjs';
import {
  createSqliteCampaignStore,
} from '../../paper-adapters/persistence/sqlite-campaign-store.mjs';
import {
  createDefaultPaperStore,
} from '../../paper-adapters/persistence/store-provider.mjs';
import { buildPaperCampaignPlan } from '../../paper-domain/automation/campaign-plan.mjs';
import { hashRecord } from '../../workflow-kernel/record-hash.mjs';

function plan(campaignId, { maxAgentCalls = 10, nodes = null } = {}) {
  return Object.freeze({
    version: 2,
    kind: 'PaperCampaignPlan',
    campaignId,
    paperId: `${campaignId}:paper`,
    sourceWorkspace: '/tmp',
    maxRounds: 1,
    budgets: Object.freeze({ maxAgentCalls }),
    nodes: Object.freeze(nodes || [Object.freeze({
      nodeId: `${campaignId}:writer`,
      kind: 'writer',
      roundIndex: 0,
      priority: 10,
      maxAttempts: 3,
      dependencies: Object.freeze([]),
    })]),
  });
}

function integrationReceipt(integrationKey) {
  const payload = Object.freeze({
    version: 1,
    kind: 'WorkspaceAttemptIntegrationReceipt',
    descriptorHash: integrationKey,
    changedPaths: Object.freeze([]),
    alreadyIntegratedPaths: Object.freeze([]),
    status: 'workspace_attempt_integrated',
    externalActionPerformed: false,
  });
  return Object.freeze({
    ...payload,
    workspaceAttemptIntegrationReceiptHash: hashRecord(
      'WorkspaceAttemptIntegrationReceipt',
      payload,
    ),
  });
}

function invoke(statement, operation, parameters) {
  if (Array.isArray(parameters)) return statement[operation](...parameters);
  if (parameters && typeof parameters === 'object') return statement[operation](parameters);
  return statement[operation]();
}

function fixture(t, {
  failStatementId = null,
  failStatementOccurrence = 1,
  committedFailureOperationId = null,
} = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hepta-native-campaign-'));
  const offline = createDefaultPaperStore({ root, runtimeRoot: root });
  const databasePath = offline.dbPath;
  offline.close();
  const database = new DatabaseSync(databasePath);
  database.exec('PRAGMA foreign_keys=ON');
  let milliseconds = Date.parse('2026-07-18T12:00:00.000Z');
  let genericWriteAttempts = 0;
  let failMatches = 0;
  const operationIds = [];
  const strictStore = {
    version: 3,
    kind: 'TestExternallyFencedNativeSqliteStoreAdapter',
    query(sql, parameters = []) {
      const rows = invoke(database.prepare(String(sql)), 'all', parameters)
        .map((row) => ({ ...row }));
      return { ok: true, status: 0, rows, stdout: JSON.stringify(rows), stderr: '', error: null };
    },
    run() {
      genericWriteAttempts += 1;
      return { ok: false, status: 1, error: 'native_store_unfenced_write_forbidden' };
    },
    execute() {
      genericWriteAttempts += 1;
      return { ok: false, status: 1, error: 'native_store_unfenced_write_forbidden' };
    },
    transaction(callback, { readOnly = false } = {}) {
      if (!readOnly) throw new Error('native_store_unfenced_write_forbidden');
      return callback(strictStore);
    },
    mutate({ operationId, mutate }) {
      const operationPlan = NATIVE_STORE_CAMPAIGN_MUTATION_PLANS[operationId];
      if (!operationPlan) throw new Error('native_store_online_mutation_input_invalid');
      operationIds.push(operationId);
      database.exec('BEGIN IMMEDIATE');
      const scoped = createExternallyFencedSqliteMutationTransaction(
        database,
        operationPlan,
      );
      const transaction = Object.freeze({
        get: (...args) => scoped.transaction.get(...args),
        all: (...args) => scoped.transaction.all(...args),
        run(statementId, ...parameters) {
          if (statementId === failStatementId
            && ++failMatches === failStatementOccurrence) {
            throw new Error('injected_native_campaign_statement_failure');
          }
          return scoped.transaction.run(statementId, ...parameters);
        },
      });
      let value;
      try {
        value = mutate(transaction);
        scoped.revoke();
        database.exec('COMMIT');
      } catch (error) {
        scoped.revoke();
        if (database.isTransaction) database.exec('ROLLBACK');
        throw error;
      }
      if (operationId === committedFailureOperationId) {
        const error = new Error(
          'externally_fenced_sqlite_mutation_committed_finalization_pending',
        );
        error.committed = true;
        throw error;
      }
      return Object.freeze({
        status: 'externally_fenced_sqlite_mutation_finalized',
        value,
      });
    },
  };
  const clock = Object.freeze({
    now: () => new Date(milliseconds),
    nowIso: () => new Date(milliseconds += 1).toISOString(),
    advance: (delta) => { milliseconds += delta; },
  });
  const campaigns = createSqliteCampaignStore({ store: strictStore, clock });
  t.after(() => {
    database.close();
    fs.rmSync(root, { recursive: true, force: true });
  });
  return Object.freeze({
    campaigns,
    clock,
    database,
    operationIds,
    root,
    genericWriteAttempts: () => genericWriteAttempts,
  });
}

test('every campaign DML entrypoint binds a unique fixed strict-store operation', () => {
  const expected = Object.values(NATIVE_STORE_CAMPAIGN_OPERATION_IDS).sort();
  assert.equal(expected.length, 25);
  assert.equal(new Set(expected).size, expected.length);
  assert.deepEqual(Object.keys(NATIVE_STORE_CAMPAIGN_MUTATION_PLANS).sort(), expected);

  const sources = [
    'paper-adapters/persistence/sqlite-campaign-store.mjs',
    'paper-adapters/persistence/sqlite-campaign-lifecycle-operations.mjs',
    'paper-adapters/persistence/sqlite-campaign-lifecycle-terminal-operations.mjs',
    'paper-adapters/persistence/sqlite-campaign-lease-operations.mjs',
    'paper-adapters/persistence/sqlite-campaign-node-attempt-operations.mjs',
    'paper-adapters/persistence/sqlite-campaign-node-infrastructure-operations.mjs',
    'paper-adapters/persistence/sqlite-campaign-node-external-action-operations.mjs',
    'paper-adapters/persistence/sqlite-campaign-prepared-integration-operations.mjs',
  ].map((file) => fs.readFileSync(path.resolve(file), 'utf8')).join('\n');
  const bindings = [...sources.matchAll(
    /operationId:\s*'(native-store\.[^']+\.v1)'/g,
  )]
    .map((match) => match[1])
    .sort();
  assert.deepEqual(bindings, expected);
  assert.doesNotMatch(
    sources.replace(/function transaction[\s\S]*?\n  }\n/, ''),
    /store\.(?:run|execute)\s*\(/,
  );
});

test('strict campaign creation rolls back every fixed statement on an injected node failure', (t) => {
  const fixtureState = fixture(t, {
    failStatementId: NATIVE_STORE_CAMPAIGN_STATEMENT_IDS.createCampaignNode,
    failStatementOccurrence: 2,
  });
  const definition = plan('strict-create-atomic', {
    nodes: Object.freeze([
      Object.freeze({ nodeId: 'strict-create-atomic:a', kind: 'writer', dependencies: Object.freeze([]) }),
      Object.freeze({ nodeId: 'strict-create-atomic:b', kind: 'compile', dependencies: Object.freeze(['strict-create-atomic:a']) }),
    ]),
  });
  assert.throws(
    () => fixtureState.campaigns.createCampaign(definition),
    /injected_native_campaign_statement_failure|campaign_create_failed/,
  );
  assert.equal(fixtureState.database.prepare(`SELECT count(*) AS count
    FROM paper_campaigns WHERE campaign_id=?`).get(definition.campaignId).count, 0);
  assert.equal(fixtureState.database.prepare(`SELECT count(*) AS count
    FROM campaign_nodes WHERE campaign_id=?`).get(definition.campaignId).count, 0);
  assert.equal(fixtureState.database.prepare(`SELECT count(*) AS count
    FROM campaign_events WHERE campaign_id=?`).get(definition.campaignId).count, 0);
  assert.equal(fixtureState.genericWriteAttempts(), 0);
});

test('strict campaign lease, integration and completion use only fixed mutations', (t) => {
  const fixtureState = fixture(t);
  const campaignId = 'strict-campaign-flow';
  fixtureState.campaigns.createCampaign(plan(campaignId));
  const [claimed] = fixtureState.campaigns.claimReady({
    campaignId,
    workerId: 'worker:strict',
    leaseSeconds: 60,
  });
  const fence = Object.freeze({
    nodeId: claimed.nodeId,
    workerId: 'worker:strict',
    attemptId: claimed.attemptId,
    leaseGeneration: claimed.leaseGeneration,
  });
  fixtureState.campaigns.startNode({ ...fence, usageDelta: { agentCalls: 1 } });
  fixtureState.campaigns.renewNodeLease({ ...fence, leaseSeconds: 120 });
  const integrationKey = 'sha256:strict-campaign-integration';
  fixtureState.campaigns.prepareNodeResult({
    ...fence,
    result: {
      status: 'prepared',
      workspaceAttemptIntegration: {
        workspaceAttemptIntegrationDescriptorHash: integrationKey,
      },
    },
    requiresIntegration: true,
    integrationKey,
  });
  fixtureState.campaigns.beginNodeResultIntegration({ ...fence, integrationKey });
  fixtureState.campaigns.beginNodeResultIntegration({ ...fence, integrationKey });
  const receipt = integrationReceipt(integrationKey);
  const integrated = fixtureState.campaigns.markNodeResultIntegrated({
    ...fence,
    integrationKey,
    integrationReceipt: receipt,
  });
  fixtureState.campaigns.markNodeResultIntegrated({
    ...fence,
    integrationKey,
    integrationReceipt: receipt,
  });
  const completed = fixtureState.campaigns.completeNode({
    ...fence,
    preparedResultHash: integrated.preparedResultHash,
    usageDelta: { tokens: 7 },
  });
  assert.equal(completed.status, 'completed');
  assert.equal(fixtureState.campaigns.getCampaign(campaignId).status, 'completed');
  assert.equal(fixtureState.genericWriteAttempts(), 0);
  for (const operation of [
    'createCampaign',
    'claimReady',
    'startNode',
    'renewNodeLease',
    'prepareNodeResult',
    'beginNodeResultIntegration',
    'assertLiveNodeAttempt',
    'markNodeResultIntegrated',
    'completeNode',
  ]) {
    assert.ok(fixtureState.operationIds.includes(
      NATIVE_STORE_CAMPAIGN_OPERATION_IDS[operation],
    ), operation);
  }
});

test('strict start budget CAS rolls back the node transition and event', (t) => {
  const fixtureState = fixture(t);
  const campaignId = 'strict-budget-fence';
  fixtureState.campaigns.createCampaign(plan(campaignId, { maxAgentCalls: 0 }));
  const [claimed] = fixtureState.campaigns.claimReady({
    campaignId,
    workerId: 'worker:budget',
  });
  assert.throws(() => fixtureState.campaigns.startNode({
    nodeId: claimed.nodeId,
    workerId: 'worker:budget',
    attemptId: claimed.attemptId,
    leaseGeneration: claimed.leaseGeneration,
    usageDelta: { agentCalls: 1 },
  }), /campaign_node_budget_reservation_failed/);
  assert.equal(fixtureState.campaigns.listNodes(campaignId)
    .find((node) => node.nodeId === claimed.nodeId).status, 'leased');
  assert.equal(fixtureState.campaigns.listEvents(campaignId)
    .filter((event) => event.kind === 'campaign_node_started').length, 0);
  assert.equal(fixtureState.genericWriteAttempts(), 0);
});

test('infrastructure cancellation refunds only persisted attempt reservations and never post-start work', (t) => {
  const fixtureState = fixture(t);
  const campaignId = 'strict-infrastructure-refund';
  fixtureState.campaigns.createCampaign(plan(campaignId, { maxAgentCalls: 20 }));
  const [claimed] = fixtureState.campaigns.claimReady({
    campaignId,
    workerId: 'worker:infrastructure-refund',
  });
  const fence = Object.freeze({
    nodeId: claimed.nodeId,
    workerId: 'worker:infrastructure-refund',
    attemptId: claimed.attemptId,
    leaseGeneration: claimed.leaseGeneration,
  });
  fixtureState.campaigns.startNode({
    ...fence,
    usageDelta: { agentCalls: 1 },
  });
  fixtureState.campaigns.reserveNodeInfrastructureUsage({
    ...fence,
    usageDelta: { agentCalls: 1, cpuJobs: 1 },
  });
  fixtureState.campaigns.recordUsage(
    campaignId,
    { agentCalls: 5 },
    { enforceBudget: true },
  );
  const cancelled = fixtureState.campaigns.cancelNodeInfrastructureDeferred({
    ...fence,
    usageDelta: { agentCalls: 7, cpuJobs: 99 },
  });
  assert.equal(cancelled.status, 'queued');
  assert.equal(cancelled.attemptCount, 0);
  const campaign = fixtureState.campaigns.getCampaign(campaignId);
  assert.equal(campaign.agentCallCount, 5,
    'caller-supplied refund hints cannot refund unrelated usage');
  assert.equal(campaign.cpuJobCount, 0);
  assert.ok(fixtureState.operationIds.includes(
    NATIVE_STORE_CAMPAIGN_OPERATION_IDS.reserveNodeInfrastructureUsage,
  ));
  assert.ok(fixtureState.operationIds.includes(
    NATIVE_STORE_CAMPAIGN_OPERATION_IDS.cancelNodeInfrastructureDeferred,
  ));

  const startedCampaignId = 'strict-infrastructure-started';
  fixtureState.campaigns.createCampaign(plan(startedCampaignId));
  const [startedClaim] = fixtureState.campaigns.claimReady({
    campaignId: startedCampaignId,
    workerId: 'worker:infrastructure-started',
  });
  const startedFence = Object.freeze({
    nodeId: startedClaim.nodeId,
    workerId: 'worker:infrastructure-started',
    attemptId: startedClaim.attemptId,
    leaseGeneration: startedClaim.leaseGeneration,
  });
  fixtureState.campaigns.startNode({
    ...startedFence,
    usageDelta: { agentCalls: 1 },
  });
  fixtureState.campaigns.markNodeExternalActionStarted({
    ...startedFence,
    action: 'test_external_action',
  });
  fixtureState.campaigns.recordUsage(
    startedCampaignId,
    { agentCalls: 1 },
    { enforceBudget: true },
  );
  assert.throws(
    () => fixtureState.campaigns.cancelNodeInfrastructureDeferred(startedFence),
    /external_action_may_have_started|cancel_fence_lost/,
  );
  assert.equal(fixtureState.campaigns.getCampaign(startedCampaignId).agentCallCount, 2,
    'later same-node actions remain chargeable but non-refundable after the durable start');
  assert.equal(fixtureState.campaigns.listNodes(startedCampaignId)[0].status, 'running');
  assert.ok(fixtureState.operationIds.includes(
    NATIVE_STORE_CAMPAIGN_OPERATION_IDS.markNodeExternalActionStarted,
  ));
});

test('strict lifecycle and recovery plans execute every remaining fixed parameter shape', (t) => {
  const fixtureState = fixture(t);

  fixtureState.campaigns.createCampaign(plan('strict-pause-resume'));
  fixtureState.campaigns.pauseCampaign('strict-pause-resume');
  fixtureState.campaigns.resumeCampaign('strict-pause-resume');
  fixtureState.campaigns.recordUsage('strict-pause-resume', { cpuJobs: 1 });
  fixtureState.campaigns.cancelCampaign('strict-pause-resume');

  fixtureState.campaigns.createCampaign(plan('strict-skip', {
    nodes: Object.freeze([
      Object.freeze({ nodeId: 'strict-skip:a', kind: 'writer', roundIndex: 0, dependencies: Object.freeze([]) }),
      Object.freeze({ nodeId: 'strict-skip:b', kind: 'reviewer', roundIndex: 1, dependencies: Object.freeze(['strict-skip:a']) }),
    ]),
  }));
  fixtureState.campaigns.skipFutureRounds({
    campaignId: 'strict-skip',
    afterRound: 0,
  });

  fixtureState.campaigns.createCampaign(plan('strict-cancel-node', {
    nodes: Object.freeze([
      Object.freeze({ nodeId: 'strict-cancel-node:a', kind: 'writer', dependencies: Object.freeze([]) }),
      Object.freeze({ nodeId: 'strict-cancel-node:b', kind: 'compile', dependencies: Object.freeze(['strict-cancel-node:a']) }),
    ]),
  }));
  fixtureState.campaigns.cancelNode('strict-cancel-node:a');

  fixtureState.campaigns.createCampaign(plan('strict-fail-campaign'));
  fixtureState.campaigns.failCampaign('strict-fail-campaign');

  const first = buildPaperCampaignPlan({
    paperId: 'strict-extend:paper',
    sourceWorkspace: fixtureState.root,
    campaignId: 'strict-extend',
    maxRounds: 1,
  });
  fixtureState.campaigns.createCampaign(first);
  fixtureState.campaigns.stopCampaign(
    first.campaignId,
    'referee_convergence_not_reached_within_budget',
  );
  const second = buildPaperCampaignPlan({
    paperId: first.paperId,
    sourceWorkspace: fixtureState.root,
    campaignId: first.campaignId,
    maxRounds: 2,
    budgets: {
      ...first.budgets,
      maxAgentCalls: first.budgets.maxAgentCalls + 4,
    },
  });
  fixtureState.campaigns.extendCampaign(second);

  fixtureState.campaigns.createCampaign(plan('strict-retry'));
  const [retryClaim] = fixtureState.campaigns.claimReady({
    campaignId: 'strict-retry',
    workerId: 'worker:retry',
  });
  const retryFence = {
    nodeId: retryClaim.nodeId,
    workerId: 'worker:retry',
    attemptId: retryClaim.attemptId,
    leaseGeneration: retryClaim.leaseGeneration,
  };
  fixtureState.campaigns.startNode(retryFence);
  fixtureState.campaigns.failNode({
    ...retryFence,
    retryable: false,
    failureClass: 'strict_terminal_failure',
    failureDetail: { injected: true },
  });
  fixtureState.campaigns.retryNode(retryClaim.nodeId);

  fixtureState.campaigns.createCampaign(plan('strict-recover'));
  fixtureState.campaigns.claimReady({
    campaignId: 'strict-recover',
    workerId: 'worker:expired',
    leaseSeconds: 1,
  });
  fixtureState.clock.advance(2_000);
  assert.equal(
    fixtureState.campaigns.recoverExpiredLeases('strict-recover').length,
    1,
  );

  for (const operation of [
    'pauseCampaign',
    'resumeCampaign',
    'recordUsage',
    'cancelCampaign',
    'skipFutureRounds',
    'cancelNode',
    'failCampaign',
    'stopCampaign',
    'extendCampaign',
    'failNode',
    'retryNode',
    'recoverExpiredLeases',
  ]) {
    assert.ok(fixtureState.operationIds.includes(
      NATIVE_STORE_CAMPAIGN_OPERATION_IDS[operation],
    ), operation);
  }
  assert.equal(fixtureState.genericWriteAttempts(), 0);
});

test('committed finalization pending is never rewritten as a campaign retry error', (t) => {
  const fixtureState = fixture(t, {
    committedFailureOperationId: NATIVE_STORE_CAMPAIGN_OPERATION_IDS.pauseCampaign,
  });
  const campaignId = 'strict-finalization-pending';
  fixtureState.campaigns.createCampaign(plan(campaignId));
  assert.throws(
    () => fixtureState.campaigns.pauseCampaign(campaignId),
    (error) => error.committed === true
      && error.message === 'externally_fenced_sqlite_mutation_committed_finalization_pending',
  );
  assert.equal(fixtureState.campaigns.getCampaign(campaignId).status, 'paused');
  assert.equal(fixtureState.genericWriteAttempts(), 0);
});
