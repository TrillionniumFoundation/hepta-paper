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

function plan(campaignId, {
  maxAgentCalls = 10,
  budgets = {},
  nodes = null,
  terminalSiblingSettlementPolicyVersion = null,
} = {}) {
  return Object.freeze({
    version: 2,
    kind: 'PaperCampaignPlan',
    campaignId,
    paperId: `${campaignId}:paper`,
    sourceWorkspace: '/tmp',
    maxRounds: 1,
    ...(terminalSiblingSettlementPolicyVersion === null ? {} : {
      terminalSiblingSettlementPolicyVersion,
    }),
    budgets: Object.freeze({ maxAgentCalls, ...budgets }),
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
  assert.equal(expected.length, 26);
  assert.equal(new Set(expected).size, expected.length);
  assert.deepEqual(Object.keys(NATIVE_STORE_CAMPAIGN_MUTATION_PLANS).sort(), expected);

  const sources = [
    'paper-adapters/persistence/sqlite-campaign-store.mjs',
    'paper-adapters/persistence/sqlite-campaign-creation-operations.mjs',
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
  assert.match(
    sources,
    /packageDeletionWriterSelector[\s\S]*packagePath:\s*prepared\.releaseBundle\.packageOutput\.packageDir/,
  );
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

test('strict terminal failure atomically settles ordinary and integrating siblings', (t) => {
  const fixtureState = fixture(t);
  const campaignId = 'strict-terminal-sibling-settlement';
  fixtureState.campaigns.createCampaign(plan(campaignId, {
    terminalSiblingSettlementPolicyVersion: 1,
    nodes: Object.freeze([
      ...['terminal', 'ordinary', 'integrating'].map((kind) => Object.freeze({
      nodeId: `${campaignId}:${kind}`,
      kind,
      roundIndex: 1,
      priority: 10,
      maxAttempts: 1,
      dependencies: Object.freeze([]),
      })),
      Object.freeze({
        nodeId: `${campaignId}:queued-dependent`,
        kind: 'queued-dependent',
        roundIndex: 1,
        priority: 20,
        maxAttempts: 1,
        dependencies: Object.freeze([`${campaignId}:terminal`]),
      }),
      Object.freeze({
        nodeId: `${campaignId}:queued-independent`,
        kind: 'queued-independent',
        roundIndex: 1,
        priority: 20,
        maxAttempts: 1,
        dependencies: Object.freeze([]),
      }),
    ]),
  }));
  const workerId = 'worker:terminal-sibling-settlement';
  const claims = fixtureState.campaigns.claimReady({ campaignId, workerId, limit: 3 });
  assert.equal(claims.length, 3);
  const fences = new Map(claims.map((claim) => [claim.kind, Object.freeze({
    nodeId: claim.nodeId,
    workerId,
    attemptId: claim.attemptId,
    leaseGeneration: claim.leaseGeneration,
  })]));
  for (const fence of fences.values()) fixtureState.campaigns.startNode(fence);

  const integrationKey = 'sha256:strict-terminal-sibling-integration';
  fixtureState.campaigns.prepareNodeResult({
    ...fences.get('integrating'),
    result: {
      status: 'prepared',
      workspaceAttemptIntegration: {
        workspaceAttemptIntegrationDescriptorHash: integrationKey,
      },
    },
    requiresIntegration: true,
    integrationKey,
  });
  fixtureState.campaigns.beginNodeResultIntegration({
    ...fences.get('integrating'),
    integrationKey,
  });

  const terminalFailureDetail = Object.freeze({ injected: true });
  const terminalFailureHash = hashRecord(
    'PaperCampaignNodeFailure',
    terminalFailureDetail,
  );
  fixtureState.campaigns.failNode({
    ...fences.get('terminal'),
    retryable: false,
    failureClass: 'strict_terminal_failure',
    failureDetail: terminalFailureDetail,
  });

  const byKind = new Map(fixtureState.campaigns.listNodes(campaignId)
    .map((node) => [node.kind, node]));
  assert.equal(fixtureState.campaigns.getCampaign(campaignId).status, 'failed');
  assert.equal(byKind.get('terminal').status, 'failed_terminal');
  assert.equal(byKind.get('ordinary').status, 'skipped');
  assert.equal(byKind.get('ordinary').failureClass,
    'campaign_terminal_sibling_cancelled');
  assert.equal(byKind.get('integrating').status, 'external_outcome_uncertain');
  assert.equal(byKind.get('integrating').failureClass,
    'campaign_terminal_sibling_outcome_uncertain');
  assert.equal(byKind.get('integrating').preparedIntegrationStatus, 'integrating');
  assert.ok(byKind.get('integrating').preparedResultHash);
  for (const kind of ['queued-dependent', 'queued-independent']) {
    const queued = byKind.get(kind);
    assert.equal(queued.status, 'skipped');
    assert.equal(queued.failureClass, 'campaign_terminal_sibling_cancelled');
    assert.equal(queued.failureDetail.previousStatus, 'queued');
    assert.equal(queued.failureDetail.terminalNodeId, fences.get('terminal').nodeId);
    assert.equal(queued.failureDetail.terminalFailureHash, terminalFailureHash);
    assert.equal(queued.attemptId, null);
    assert.equal(queued.leaseOwner, null);
  }

  for (const kind of ['ordinary', 'integrating']) {
    const node = byKind.get(kind);
    assert.equal(node.attemptId, null);
    assert.equal(node.leaseOwner, null);
    assert.equal(node.leaseExpiresAt, null);
    assert.equal(node.failureDetail.reason, node.failureClass);
    assert.equal(node.failureDetail.terminalNodeId, fences.get('terminal').nodeId);
    assert.equal(node.failureDetail.terminalFailureHash, terminalFailureHash);
    assert.equal(node.failureDetail.previousAttemptId, fences.get(kind).attemptId);
    assert.equal(node.failureDetail.previousLeaseGeneration,
      fences.get(kind).leaseGeneration);
    assert.equal(
      node.failureSha256,
      hashRecord('PaperCampaignNodeFailure', node.failureDetail),
    );
  }
  assert.throws(
    () => fixtureState.campaigns.renewNodeLease({
      ...fences.get('ordinary'),
      leaseSeconds: 10,
    }),
    /campaign_node_lease_renew_failed|campaign_node_lease_lost/,
  );
  assert.throws(
    () => fixtureState.campaigns.failNode({
      ...fences.get('ordinary'),
      retryable: false,
      failureClass: 'late_failure',
    }),
    /campaign_node_lease_lost/,
  );
  assert.throws(
    () => fixtureState.campaigns.markNodeResultIntegrated({
      ...fences.get('integrating'),
      integrationKey,
      integrationReceipt: integrationReceipt(integrationKey),
    }),
    /campaign_node_lease_lost|campaign_node_attempt_fence_check_failed/,
  );
  assert.equal(fixtureState.campaigns.listEvents(campaignId)
    .filter((event) => event.kind === 'campaign_terminal_sibling_settled').length, 4);
  assert.ok(fixtureState.operationIds.includes(
    NATIVE_STORE_CAMPAIGN_OPERATION_IDS.failNode,
  ));
  assert.equal(fixtureState.genericWriteAttempts(), 0);
});

test('strict terminal failure skips a queued peer whose integration already completed', (t) => {
  const fixtureState = fixture(t);
  const campaignId = 'strict-terminal-queued-integrated';
  fixtureState.campaigns.createCampaign(plan(campaignId, {
    terminalSiblingSettlementPolicyVersion: 1,
    nodes: Object.freeze(['terminal', 'integrated-retry'].map((kind) => Object.freeze({
      nodeId: `${campaignId}:${kind}`,
      kind,
      roundIndex: 1,
      priority: 10,
      maxAttempts: 1,
      dependencies: Object.freeze([]),
    }))),
  }));
  const workerId = 'worker:terminal-queued-integrated';
  const claims = fixtureState.campaigns.claimReady({ campaignId, workerId, limit: 2 });
  const fences = new Map(claims.map((claim) => [claim.kind, Object.freeze({
    nodeId: claim.nodeId,
    workerId,
    attemptId: claim.attemptId,
    leaseGeneration: claim.leaseGeneration,
  })]));
  for (const fence of fences.values()) fixtureState.campaigns.startNode(fence);

  const retryFence = fences.get('integrated-retry');
  const integrationKey = 'sha256:strict-terminal-queued-integrated';
  fixtureState.campaigns.prepareNodeResult({
    ...retryFence,
    result: {
      status: 'prepared',
      workspaceAttemptIntegration: {
        workspaceAttemptIntegrationDescriptorHash: integrationKey,
      },
    },
    requiresIntegration: true,
    integrationKey,
  });
  fixtureState.campaigns.beginNodeResultIntegration({ ...retryFence, integrationKey });
  fixtureState.campaigns.markNodeResultIntegrated({
    ...retryFence,
    integrationKey,
    integrationReceipt: integrationReceipt(integrationKey),
  });
  const queued = fixtureState.campaigns.failNode({
    ...retryFence,
    retryable: true,
    failureClass: 'post_integration_retry',
    failureDetail: { integrationCompleted: true },
  });
  assert.equal(queued.status, 'queued');
  assert.equal(queued.preparedIntegrationStatus, 'integrated');

  fixtureState.campaigns.failNode({
    ...fences.get('terminal'),
    retryable: false,
    failureClass: 'strict_terminal_failure',
  });
  const settled = fixtureState.campaigns.listNodes(campaignId)
    .find((node) => node.kind === 'integrated-retry');
  assert.equal(settled.status, 'skipped');
  assert.equal(settled.failureClass, 'campaign_terminal_sibling_cancelled');
  assert.equal(settled.failureDetail.previousStatus, 'queued');
  assert.equal(settled.failureDetail.preparedIntegrationStatus, 'integrated');
  assert.equal(settled.attemptId, null);
  assert.equal(fixtureState.campaigns.getCampaign(campaignId).status, 'failed');
  fixtureState.campaigns.retryNode(fences.get('terminal').nodeId);
  const reopened = fixtureState.campaigns.listNodes(campaignId)
    .find((node) => node.kind === 'integrated-retry');
  assert.equal(reopened.status, 'queued');
  assert.equal(reopened.preparedIntegrationStatus, 'integrated');
  assert.equal(reopened.preparedResultHash, settled.preparedResultHash);
  assert.deepEqual(reopened.preparedResult, settled.preparedResult);
  assert.equal(reopened.preparedAttemptId, settled.preparedAttemptId);
  assert.equal(fixtureState.campaigns.getCampaign(campaignId).status, 'running');
  assert.equal(fixtureState.genericWriteAttempts(), 0);
});

test('strict queued peer settlement failure rolls back the full terminal transaction', (t) => {
  const fixtureState = fixture(t, {
    failStatementId: NATIVE_STORE_CAMPAIGN_STATEMENT_IDS.settleTerminalSiblingNodes,
    failStatementOccurrence: 2,
  });
  const campaignId = 'strict-terminal-queued-rollback';
  fixtureState.campaigns.createCampaign(plan(campaignId, {
    terminalSiblingSettlementPolicyVersion: 1,
    nodes: Object.freeze([
      Object.freeze({
        nodeId: `${campaignId}:terminal`,
        kind: 'terminal',
        priority: 10,
        dependencies: Object.freeze([]),
        maxAttempts: 1,
      }),
      Object.freeze({
        nodeId: `${campaignId}:active`,
        kind: 'active',
        priority: 10,
        dependencies: Object.freeze([]),
        maxAttempts: 1,
      }),
      Object.freeze({
        nodeId: `${campaignId}:z-queued`,
        kind: 'z-queued',
        priority: 20,
        dependencies: Object.freeze([`${campaignId}:terminal`]),
        maxAttempts: 1,
      }),
    ]),
  }));
  const workerId = 'worker:terminal-queued-rollback';
  const claims = fixtureState.campaigns.claimReady({ campaignId, workerId, limit: 2 });
  const fences = new Map(claims.map((claim) => [claim.kind, Object.freeze({
    nodeId: claim.nodeId,
    workerId,
    attemptId: claim.attemptId,
    leaseGeneration: claim.leaseGeneration,
  })]));
  for (const fence of fences.values()) fixtureState.campaigns.startNode(fence);
  assert.throws(() => fixtureState.campaigns.failNode({
    ...fences.get('terminal'),
    retryable: false,
    failureClass: 'strict_terminal_failure',
  }), /injected_native_campaign_statement_failure|campaign_node_lease_lost/);
  assert.equal(fixtureState.campaigns.getCampaign(campaignId).status, 'running');
  assert.deepEqual(
    fixtureState.campaigns.listNodes(campaignId).map((node) => node.status).sort(),
    ['queued', 'running', 'running'],
  );
  assert.equal(fixtureState.campaigns.listEvents(campaignId)
    .filter((event) => ['campaign_node_failed', 'campaign_terminal_sibling_settled']
      .includes(event.kind)).length, 0);
  assert.equal(fixtureState.genericWriteAttempts(), 0);
});

test('strict sibling reopen failure rolls back the full manual retry transaction', (t) => {
  const fixtureState = fixture(t, {
    failStatementId: NATIVE_STORE_CAMPAIGN_STATEMENT_IDS.retrySiblingNode,
  });
  const campaignId = 'strict-retry-sibling-rollback';
  fixtureState.campaigns.createCampaign(plan(campaignId, {
    terminalSiblingSettlementPolicyVersion: 1,
    nodes: Object.freeze([
      Object.freeze({
        nodeId: `${campaignId}:terminal`,
        kind: 'terminal',
        priority: 10,
        dependencies: Object.freeze([]),
        maxAttempts: 1,
      }),
      Object.freeze({
        nodeId: `${campaignId}:sibling`,
        kind: 'sibling',
        priority: 20,
        dependencies: Object.freeze([`${campaignId}:terminal`]),
        maxAttempts: 1,
      }),
    ]),
  }));
  const workerId = 'worker:retry-sibling-rollback';
  const [claim] = fixtureState.campaigns.claimReady({ campaignId, workerId });
  const fence = {
    nodeId: claim.nodeId,
    workerId,
    attemptId: claim.attemptId,
    leaseGeneration: claim.leaseGeneration,
  };
  fixtureState.campaigns.startNode(fence);
  fixtureState.campaigns.failNode({
    ...fence,
    retryable: false,
    failureClass: 'strict_terminal_failure',
  });
  const beforeCampaign = fixtureState.campaigns.getCampaign(campaignId);
  const beforeNodes = fixtureState.campaigns.listNodes(campaignId);
  const beforeEventCount = fixtureState.campaigns.listEvents(campaignId).length;
  assert.throws(
    () => fixtureState.campaigns.retryNode(claim.nodeId),
    /injected_native_campaign_statement_failure|campaign_node_retry_failed/,
  );
  assert.equal(fixtureState.campaigns.getCampaign(campaignId).status, 'failed');
  assert.equal(fixtureState.campaigns.getCampaign(campaignId).revision,
    beforeCampaign.revision);
  assert.deepEqual(fixtureState.campaigns.listNodes(campaignId), beforeNodes);
  assert.equal(fixtureState.campaigns.listEvents(campaignId).length,
    beforeEventCount);
  assert.equal(fixtureState.genericWriteAttempts(), 0);
});

test('legacy terminal failure preserves queued peers outside policy v1', (t) => {
  const fixtureState = fixture(t);
  const campaignId = 'legacy-terminal-queued-preserved';
  fixtureState.campaigns.createCampaign(plan(campaignId, {
    nodes: Object.freeze([
      Object.freeze({
        nodeId: `${campaignId}:terminal`,
        kind: 'terminal',
        priority: 10,
        dependencies: Object.freeze([]),
        maxAttempts: 1,
      }),
      Object.freeze({
        nodeId: `${campaignId}:queued`,
        kind: 'queued',
        priority: 20,
        dependencies: Object.freeze([`${campaignId}:terminal`]),
        maxAttempts: 1,
      }),
    ]),
  }));
  const workerId = 'worker:legacy-terminal-queued';
  const [claimed] = fixtureState.campaigns.claimReady({ campaignId, workerId, limit: 1 });
  const fence = Object.freeze({
    nodeId: claimed.nodeId,
    workerId,
    attemptId: claimed.attemptId,
    leaseGeneration: claimed.leaseGeneration,
  });
  fixtureState.campaigns.startNode(fence);
  fixtureState.campaigns.failNode({
    ...fence,
    retryable: false,
    failureClass: 'legacy_terminal_failure',
  });
  assert.equal(fixtureState.campaigns.getCampaign(campaignId).status, 'failed');
  assert.deepEqual(
    fixtureState.campaigns.listNodes(campaignId).map((node) => node.status).sort(),
    ['failed_terminal', 'queued'],
  );
  assert.equal(fixtureState.campaigns.listEvents(campaignId)
    .filter((event) => event.kind === 'campaign_terminal_sibling_settled').length, 0);
});

test('strict policy-v1 terminal failure closes a campaign-sized queued lineage', (t) => {
  const fixtureState = fixture(t);
  const campaignId = 'strict-terminal-high-cardinality';
  const terminalNodeId = `${campaignId}:terminal`;
  fixtureState.campaigns.createCampaign(plan(campaignId, {
    terminalSiblingSettlementPolicyVersion: 1,
    nodes: Object.freeze([
      Object.freeze({
        nodeId: terminalNodeId,
        kind: 'terminal',
        priority: 10,
        dependencies: Object.freeze([]),
        maxAttempts: 1,
      }),
      ...Array.from({ length: 45 }, (_, index) => Object.freeze({
        nodeId: `${campaignId}:queued-${String(index).padStart(2, '0')}`,
        kind: `queued-${index}`,
        priority: 20,
        dependencies: Object.freeze([terminalNodeId]),
        maxAttempts: 1,
      })),
    ]),
  }));
  const workerId = 'worker:terminal-high-cardinality';
  const [claimed] = fixtureState.campaigns.claimReady({ campaignId, workerId, limit: 1 });
  const fence = Object.freeze({
    nodeId: claimed.nodeId,
    workerId,
    attemptId: claimed.attemptId,
    leaseGeneration: claimed.leaseGeneration,
  });
  fixtureState.campaigns.startNode(fence);
  fixtureState.campaigns.failNode({
    ...fence,
    retryable: false,
    failureClass: 'strict_terminal_failure',
    failureDetail: Object.freeze({ highCardinality: true }),
  });
  const nodes = fixtureState.campaigns.listNodes(campaignId);
  assert.equal(fixtureState.campaigns.getCampaign(campaignId).status, 'failed');
  assert.equal(nodes.filter((node) => node.status === 'failed_terminal').length, 1);
  assert.equal(nodes.filter((node) => node.status === 'skipped').length, 45);
  assert.equal(nodes.some((node) => ['queued', 'leased', 'running'].includes(node.status)), false);
  for (const node of nodes.filter((candidate) => candidate.status === 'skipped')) {
    assert.equal(node.failureClass, 'campaign_terminal_sibling_cancelled');
    assert.equal(node.failureDetail.previousStatus, 'queued');
    assert.equal(node.failureDetail.terminalNodeId, terminalNodeId);
    assert.equal(
      node.failureSha256,
      hashRecord('PaperCampaignNodeFailure', node.failureDetail),
    );
  }
  assert.equal(fixtureState.campaigns.listEvents(campaignId)
    .filter((event) => event.kind === 'campaign_terminal_sibling_settled').length, 45);
  assert.equal(fixtureState.genericWriteAttempts(), 0);
});

test('strict terminal sibling settlement statement failure rolls back the root failure', (t) => {
  const fixtureState = fixture(t, {
    failStatementId: NATIVE_STORE_CAMPAIGN_STATEMENT_IDS.settleTerminalSiblingNodes,
  });
  const campaignId = 'strict-terminal-sibling-rollback';
  fixtureState.campaigns.createCampaign(plan(campaignId, {
    nodes: Object.freeze(['terminal', 'sibling'].map((kind) => Object.freeze({
      nodeId: `${campaignId}:${kind}`,
      kind,
      dependencies: Object.freeze([]),
      maxAttempts: 1,
    }))),
  }));
  const workerId = 'worker:terminal-sibling-rollback';
  const claims = fixtureState.campaigns.claimReady({ campaignId, workerId, limit: 2 });
  const fences = new Map(claims.map((claim) => [claim.kind, Object.freeze({
    nodeId: claim.nodeId,
    workerId,
    attemptId: claim.attemptId,
    leaseGeneration: claim.leaseGeneration,
  })]));
  for (const fence of fences.values()) fixtureState.campaigns.startNode(fence);
  assert.throws(() => fixtureState.campaigns.failNode({
    ...fences.get('terminal'),
    retryable: false,
    failureClass: 'strict_terminal_failure',
  }), /injected_native_campaign_statement_failure|campaign_node_lease_lost/);
  assert.equal(fixtureState.campaigns.getCampaign(campaignId).status, 'running');
  assert.deepEqual(
    fixtureState.campaigns.listNodes(campaignId).map((node) => node.status).sort(),
    ['running', 'running'],
  );
  assert.equal(fixtureState.campaigns.listEvents(campaignId)
    .filter((event) => ['campaign_node_failed', 'campaign_terminal_sibling_settled']
      .includes(event.kind)).length, 0);
  assert.equal(fixtureState.genericWriteAttempts(), 0);
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

test('strict usage mutation preserves operationally unlimited token and cost sentinels', (t) => {
  const fixtureState = fixture(t);
  const campaignId = 'strict-unlimited-token-cost-sentinel';
  fixtureState.campaigns.createCampaign(plan(campaignId, {
    maxAgentCalls: 2,
    budgets: {
      maxTokenCount: Number.MAX_SAFE_INTEGER,
      maxCostUsd: Number.MAX_SAFE_INTEGER,
    },
  }));
  fixtureState.campaigns.recordUsage(campaignId, {
    agentCalls: 1,
    tokens: Number.MAX_SAFE_INTEGER - 1,
    costUsd: Number.MAX_SAFE_INTEGER - 1,
    pricedAgentCalls: 1,
  }, { enforceBudget: true });
  const atBoundary = fixtureState.campaigns.recordUsage(campaignId, {
    tokens: 1,
    costUsd: 1,
    pricedAgentCalls: 0,
  }, { enforceBudget: true });
  assert.equal(atBoundary.tokenCount, Number.MAX_SAFE_INTEGER);
  assert.equal(atBoundary.costUsd, Number.MAX_SAFE_INTEGER);
  assert.throws(() => fixtureState.campaigns.recordUsage(campaignId, {
    costUsd: 1,
    pricedAgentCalls: 0,
  }, { enforceBudget: true }), /campaign_usage_budget_reservation_failed/);
  assert.throws(() => fixtureState.campaigns.recordUsage(campaignId, {
    tokens: 1,
  }, { enforceBudget: true }), /campaign_usage_budget_reservation_failed/);
  const afterRejectedReservation = fixtureState.campaigns.getCampaign(campaignId);
  assert.equal(afterRejectedReservation.tokenCount, Number.MAX_SAFE_INTEGER);
  assert.equal(afterRejectedReservation.costUsd, Number.MAX_SAFE_INTEGER);
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
  const startedAction = fixtureState.campaigns.markNodeExternalActionStarted({
    ...startedFence,
    action: 'test_external_action',
  });
  const completedAction = fixtureState.campaigns.completeNodeExternalAction({
    ...startedFence,
    externalActionId: startedAction.externalActionId,
    outcome: { status: 'test_external_action_completed' },
  });
  assert.equal(completedAction.status, 'completed');
  assert.deepEqual(completedAction.outcomePayload, {
    status: 'test_external_action_completed',
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
  assert.ok(fixtureState.operationIds.includes(
    NATIVE_STORE_CAMPAIGN_OPERATION_IDS.completeNodeExternalAction,
  ));
});

test('strict lifecycle and recovery plans execute every remaining fixed parameter shape', (t) => {
  const fixtureState = fixture(t);

  fixtureState.campaigns.createCampaign(plan('strict-pause-resume'));
  fixtureState.campaigns.pauseCampaign('strict-pause-resume');
  fixtureState.campaigns.resumeCampaign('strict-pause-resume');
  fixtureState.campaigns.recordUsage('strict-pause-resume', { cpuJobs: 1 });
  fixtureState.campaigns.cancelCampaign('strict-pause-resume');

  fixtureState.campaigns.createCampaign(plan('strict-stopped-resume'));
  fixtureState.campaigns.stopCampaign(
    'strict-stopped-resume',
    'supervisor_process_shutdown',
  );
  assert.equal(
    fixtureState.campaigns.resumeCampaign('strict-stopped-resume').status,
    'running',
  );
  assert.equal(
    fixtureState.campaigns.listNodes('strict-stopped-resume')[0].status,
    'queued',
  );

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

  fixtureState.campaigns.createCampaign(plan('strict-cancel-only-node'));
  fixtureState.campaigns.cancelNode('strict-cancel-only-node:writer');
  assert.equal(
    fixtureState.campaigns.getCampaign('strict-cancel-only-node').status,
    'completed',
  );

  fixtureState.campaigns.createCampaign(plan('strict-fail-campaign'));
  fixtureState.campaigns.failCampaign('strict-fail-campaign');

  const extendPaperTask = Object.freeze({
    version: 'fixture',
    kind: 'PaperTask',
    paperId: 'strict-extend:paper',
    taskKey: 'paper:strict-extend:paper',
    semanticIdentityHash: `sha256:${'e'.repeat(64)}`,
    sourceWorkspace: fixtureState.root,
    evidenceRefs: Object.freeze([]),
  });
  const first = buildPaperCampaignPlan({
    paperId: extendPaperTask.paperId,
    sourceWorkspace: fixtureState.root,
    campaignId: 'strict-extend',
    maxRounds: 1,
    paperTask: extendPaperTask,
    paperState: { evidenceRefs: [] },
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
    paperTask: extendPaperTask,
    paperState: { evidenceRefs: [] },
  });
  fixtureState.campaigns.extendCampaign(second);

  fixtureState.campaigns.createCampaign(plan('strict-retry', {
    terminalSiblingSettlementPolicyVersion: 1,
    nodes: Object.freeze([
      Object.freeze({
        nodeId: 'strict-retry:writer',
        kind: 'writer',
        dependencies: Object.freeze([]),
      }),
      Object.freeze({
        nodeId: 'strict-retry:compile',
        kind: 'compile',
        dependencies: Object.freeze([]),
      }),
    ]),
  }));
  const retryClaims = fixtureState.campaigns.claimReady({
    campaignId: 'strict-retry',
    workerId: 'worker:retry',
    limit: 2,
  });
  const retryClaim = retryClaims.find((claim) => claim.kind === 'writer');
  const retrySiblingClaim = retryClaims.find((claim) => claim.kind === 'compile');
  const retryFence = {
    nodeId: retryClaim.nodeId,
    workerId: 'worker:retry',
    attemptId: retryClaim.attemptId,
    leaseGeneration: retryClaim.leaseGeneration,
  };
  const retrySiblingFence = {
    nodeId: retrySiblingClaim.nodeId,
    workerId: 'worker:retry',
    attemptId: retrySiblingClaim.attemptId,
    leaseGeneration: retrySiblingClaim.leaseGeneration,
  };
  fixtureState.campaigns.startNode(retryFence);
  fixtureState.campaigns.startNode(retrySiblingFence);
  const retrySiblingIntegrationKey = 'sha256:strict-retry-pending-sibling';
  fixtureState.campaigns.prepareNodeResult({
    ...retrySiblingFence,
    result: {
      status: 'prepared_pending_sibling',
      workspaceAttemptIntegration: {
        workspaceAttemptIntegrationDescriptorHash: retrySiblingIntegrationKey,
      },
    },
    requiresIntegration: true,
    integrationKey: retrySiblingIntegrationKey,
  });
  fixtureState.campaigns.failNode({
    ...retryFence,
    retryable: false,
    failureClass: 'strict_terminal_failure',
    failureDetail: { injected: true },
  });
  const retrySiblingNodeIds = fixtureState.campaigns.listNodes('strict-retry')
    .filter((node) => node.status === 'skipped'
      && node.failureClass === 'campaign_terminal_sibling_cancelled'
      && node.failureDetail?.terminalNodeId === retryClaim.nodeId)
    .map((node) => node.nodeId)
    .sort();
  assert.ok(retrySiblingNodeIds.length > 0);
  assert.ok(fixtureState.campaigns.listNodes('strict-retry')
    .find((node) => node.nodeId === retrySiblingClaim.nodeId).preparedResultHash);
  assert.equal(fixtureState.campaigns.listNodes('strict-retry')
    .find((node) => node.nodeId === retrySiblingClaim.nodeId)
    .preparedIntegrationStatus, 'pending');
  fixtureState.campaigns.retryNode(retryClaim.nodeId);
  assert.deepEqual(
    fixtureState.campaigns.listNodes('strict-retry')
      .filter((node) => retrySiblingNodeIds.includes(node.nodeId))
      .map((node) => node.status),
    retrySiblingNodeIds.map(() => 'queued'),
  );
  const reopenedPreparedSibling = fixtureState.campaigns.listNodes('strict-retry')
    .find((node) => node.nodeId === retrySiblingClaim.nodeId);
  assert.equal(reopenedPreparedSibling.preparedResult, null);
  assert.equal(reopenedPreparedSibling.preparedResultHash, null);
  assert.equal(reopenedPreparedSibling.preparedAttemptId, null);
  assert.equal(reopenedPreparedSibling.preparedRequiresIntegration, false);
  assert.equal(reopenedPreparedSibling.preparedIntegrationStatus, 'none');
  assert.deepEqual(
    fixtureState.campaigns.listEvents('strict-retry').at(-1).event.detail
      .reopenedSiblingNodeIds,
    retrySiblingNodeIds,
  );

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

  fixtureState.campaigns.createCampaign(plan('strict-running-recover'));
  const [runningRecoveryClaim] = fixtureState.campaigns.claimReady({
    campaignId: 'strict-running-recover',
    workerId: 'worker:running-expired',
    leaseSeconds: 1,
  });
  fixtureState.campaigns.startNode({
    nodeId: runningRecoveryClaim.nodeId,
    workerId: 'worker:running-expired',
    attemptId: runningRecoveryClaim.attemptId,
    leaseGeneration: runningRecoveryClaim.leaseGeneration,
    usageDelta: { agentCalls: 1, cpuJobs: 1 },
  });
  fixtureState.clock.advance(2_000);
  const [runningRecovered] = fixtureState.campaigns.recoverExpiredLeases(
    'strict-running-recover',
  );
  assert.equal(runningRecovered.status, 'queued');
  assert.equal(runningRecovered.attemptCount, 0);
  assert.equal(
    fixtureState.campaigns.getCampaign('strict-running-recover').agentCallCount,
    0,
  );
  assert.equal(
    fixtureState.campaigns.getCampaign('strict-running-recover').cpuJobCount,
    0,
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
