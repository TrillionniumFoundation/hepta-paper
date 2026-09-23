import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildExperimentIrExecutionAuthorityReceipt,
  verifyExperimentIrExecutionAuthorityReceipt,
} from '../../paper-domain/automation/experiment-ir-execution-authority-contract.mjs';
import {
  inspectAutomationReadinessCanonicalExperimentRows,
  inspectPersistedExperimentIrExecutionAuthority,
} from '../../paper-composition/automation/automation-readiness-experiment-ir-authority-inspection.mjs';
import { hashRecord } from '../../workflow-kernel/record-hash.mjs';

test('Experiment IR execution authority cannot be minted without a verified replay', () => {
  assert.throws(() => buildExperimentIrExecutionAuthorityReceipt({
    campaignId: 'campaign-1',
    paperId: 'paper-1',
    campaignPlanHash: hashRecord('FixtureCampaignPlan', {}),
    nodeId: 'campaign-1:0:empirical-reproduce',
    nodeKind: 'empirical-reproduce',
    researchAgendaIr: {},
    researchAgendaProducerReceipt: {},
    experimentReplayReceipt: {},
  }), /experiment_ir_execution_authority_context_invalid/);
  assert.equal(verifyExperimentIrExecutionAuthorityReceipt({
    version: 1,
    kind: 'ExperimentIrExecutionAuthorityReceipt',
    status: 'experiment_ir_execution_authority_verified',
  }), false);
});
test('readiness inspection is read-only and fails closed when campaign state is unavailable', () => {
  let statement = null;
  const inspection = inspectPersistedExperimentIrExecutionAuthority({
    store: { query(sql) { statement = sql; return { ok: false, rows: [] }; } },
  });
  assert.equal(inspection.ready, false);
  assert.equal(inspection.statusReadOnly, true);
  assert.deepEqual(inspection.blockers, [
    'experiment_ir_execution_authority_query_failed',
  ]);
  assert.match(statement, /experimentIrExecutionAuthorityReceipt/);
});

test('a self-shaped database result cannot satisfy persisted execution authority', () => {
  const originalNode = {
    nodeId: 'campaign-1:0:empirical',
    kind: 'empirical',
    roundIndex: 0,
    dependencies: [],
  };
  const replayNode = {
    nodeId: 'campaign-1:0:empirical-reproduce',
    kind: 'empirical-reproduce',
    roundIndex: 0,
    dependencies: [originalNode.nodeId],
  };
  const researchNode = {
    nodeId: 'campaign-1:1:research-verify',
    kind: 'research-verify',
    roundIndex: 1,
    dependencies: [replayNode.nodeId],
  };
  const packageNode = {
    nodeId: 'campaign-1:1:package',
    kind: 'package',
    roundIndex: 1,
    dependencies: [researchNode.nodeId],
  };
  const planPayload = {
    version: 4,
    kind: 'PaperCampaignPlan',
    campaignId: 'campaign-1',
    paperId: 'paper-1',
    executionIntent: { benchmarkSelectorHash: hashRecord('FixtureSelector', {}) },
    benchmarkSelector: {
      campaignBenchmarkSelectorHash: hashRecord('FixtureSelector', {}),
    },
    autonomousResearchPreparation: {
      launchMode: 'production-run',
      researchAgendaProducerReceipt: {},
      researchAgendaIr: {},
    },
    nodes: [originalNode, replayNode, researchNode, packageNode],
  };
  const plan = {
    ...planPayload,
    campaignPlanHash: hashRecord('PaperCampaignPlan', planPayload),
  };
  const result = {
    experimentIrExecutionAuthorityReceipt: {
      version: 1,
      kind: 'ExperimentIrExecutionAuthorityReceipt',
      status: 'experiment_ir_execution_authority_verified',
      nodeId: 'campaign-1:0:empirical-reproduce',
      nodeKind: 'empirical-reproduce',
    },
  };
  const originalResult = { experimentRunReceipt: {} };
  const row = (node, nodeResult) => ({
    campaign_id: 'campaign-1',
    paper_id: 'paper-1',
    campaign_status: 'running',
    campaign_revision: 1,
    spec_json: JSON.stringify(plan),
    node_id: node.nodeId,
    node_kind: node.kind,
    node_status: 'completed',
    attempt_id: `${node.nodeId}:attempt-1`,
    lease_generation: 1,
    round_index: node.roundIndex,
    node_revision: 1,
    dependencies_json: JSON.stringify(node.dependencies),
    node_spec_json: JSON.stringify(node),
    result_json: JSON.stringify(nodeResult),
    result_sha256: hashRecord('PaperCampaignNodeResult', nodeResult),
  });
  const inspection = inspectPersistedExperimentIrExecutionAuthority({
    store: { query: () => ({
      ok: true,
      rows: [row(originalNode, originalResult), row(replayNode, result)],
    }) },
    agendaAuthorityInspection: {
      ready: true,
      campaignId: 'campaign-1',
      paperId: 'paper-1',
      campaignStatus: 'running',
      campaignRevision: 1,
      campaignPlanHash: plan.campaignPlanHash,
      researchAgendaIr: {},
      researchAgendaProducerReceipt: {},
    },
  });
  assert.equal(inspection.ready, false);
  assert.deepEqual(inspection.blockers, [
    'experiment_ir_execution_current_replay_authority_invalid',
  ]);
});

function canonicalReplayFixture() {
  const campaignId = 'campaign-current-replay';
  const paperId = 'paper-current-replay';
  const oldOriginal = {
    nodeId: `${campaignId}:0:empirical`,
    kind: 'empirical',
    roundIndex: 0,
    dependencies: [],
  };
  const oldReplay = {
    nodeId: `${campaignId}:0:empirical-reproduce`,
    kind: 'empirical-reproduce',
    roundIndex: 0,
    dependencies: [oldOriginal.nodeId],
  };
  const currentOriginal = {
    nodeId: `${campaignId}:0:revalidate-empirical-source-seal`,
    kind: 'revalidate-empirical-source-seal',
    roundIndex: 0,
    dependencies: [],
    sourceClosureTerminal: true,
  };
  const currentReplay = {
    nodeId: `${campaignId}:0:revalidate-empirical-reproduce-source-seal`,
    kind: 'revalidate-empirical-reproduce-source-seal',
    roundIndex: 0,
    dependencies: [currentOriginal.nodeId],
    sourceClosureTerminal: true,
  };
  const research = {
    nodeId: `${campaignId}:1:research-verify`,
    kind: 'research-verify',
    roundIndex: 1,
    dependencies: [oldReplay.nodeId, currentReplay.nodeId],
  };
  const packageNode = {
    nodeId: `${campaignId}:1:package`,
    kind: 'package',
    roundIndex: 1,
    dependencies: [research.nodeId],
  };
  const payload = {
    version: 4,
    kind: 'PaperCampaignPlan',
    campaignId,
    paperId,
    autonomousResearchPreparation: { launchMode: 'production-run' },
    nodes: [
      oldOriginal,
      oldReplay,
      currentOriginal,
      currentReplay,
      research,
      packageNode,
    ],
  };
  const plan = {
    ...payload,
    campaignPlanHash: hashRecord('PaperCampaignPlan', payload),
  };
  const row = (node, status = 'completed') => {
    const result = { status: `${node.nodeId}:completed` };
    return {
      campaign_id: campaignId,
      paper_id: paperId,
      spec_json: JSON.stringify(plan),
      node_id: node.nodeId,
      node_kind: node.kind,
      node_status: status,
      attempt_id: `${node.nodeId}:attempt-1`,
      lease_generation: 1,
      round_index: node.roundIndex,
      node_revision: 1,
      dependencies_json: JSON.stringify(node.dependencies),
      node_spec_json: JSON.stringify(node),
      result_json: JSON.stringify(result),
      result_sha256: hashRecord('PaperCampaignNodeResult', result),
    };
  };
  return {
    plan,
    oldOriginal,
    oldReplay,
    currentOriginal,
    currentReplay,
    row,
  };
}

test('canonical experiment authority never falls back from the current planned replay', () => {
  const fixture = canonicalReplayFixture();
  const rows = [
    fixture.row(fixture.oldOriginal),
    fixture.row(fixture.oldReplay),
    fixture.row(fixture.currentOriginal),
    fixture.row(fixture.currentReplay, 'running'),
  ];
  const inspected = inspectAutomationReadinessCanonicalExperimentRows(
    fixture.plan,
    rows,
  );
  assert.equal(inspected.ready, false);
  assert.equal(inspected.replay.row.node_id, fixture.currentReplay.nodeId);
  assert.ok(inspected.blockers.includes(
    'experiment_ir_execution_current_replay_not_completed',
  ));
});

test('canonical experiment authority mirrors the production replay comparator', () => {
  const fixture = canonicalReplayFixture();
  const profileOriginal = {
    ...fixture.currentOriginal,
    nodeId: `${fixture.plan.campaignId}:0:revalidate-empirical-source-seal-python`,
    kind: 'revalidate-empirical-source-seal-python',
  };
  const profileReplay = {
    ...fixture.currentReplay,
    nodeId: `${fixture.plan.campaignId}:0:revalidate-empirical-reproduce-source-seal-python`,
    kind: 'revalidate-empirical-reproduce-source-seal-python',
    dependencies: [profileOriginal.nodeId],
  };
  const payload = {
    ...fixture.plan,
    nodes: fixture.plan.nodes.map((node) => node.kind === 'research-verify'
      ? { ...node, dependencies: [...node.dependencies, profileReplay.nodeId] }
      : node).flatMap((node) => node.kind === 'research-verify'
      ? [profileOriginal, profileReplay, node] : [node]),
  };
  delete payload.campaignPlanHash;
  const plan = {
    ...payload,
    campaignPlanHash: hashRecord('PaperCampaignPlan', payload),
  };
  const rows = [
    fixture.row(fixture.oldOriginal),
    fixture.row(fixture.oldReplay),
    fixture.row(fixture.currentOriginal),
    fixture.row(fixture.currentReplay),
    fixture.row(profileOriginal),
    fixture.row(profileReplay),
  ].map((row) => ({ ...row, spec_json: JSON.stringify(plan) }));
  const inspected = inspectAutomationReadinessCanonicalExperimentRows(
    plan,
    rows,
  );
  assert.equal(inspected.ready, true, JSON.stringify(inspected.blockers));
  assert.equal(inspected.replay.row.node_id, profileReplay.nodeId);
  assert.equal(inspected.original.row.node_id, profileOriginal.nodeId);
});

test('canonical experiment rows bind exact plan, generation, and completion state', () => {
  const fixture = canonicalReplayFixture();
  const baseline = [
    fixture.row(fixture.oldOriginal),
    fixture.row(fixture.oldReplay),
    fixture.row(fixture.currentOriginal),
    fixture.row(fixture.currentReplay),
  ];
  assert.equal(inspectAutomationReadinessCanonicalExperimentRows(
    fixture.plan,
    baseline,
  ).ready, true);
  for (const mutation of [
    { dependencies_json: JSON.stringify([]) },
    { node_spec_json: JSON.stringify({ ...fixture.currentReplay, priority: 999 }) },
    { node_status: 'failed' },
    { attempt_id: null },
    { lease_generation: 0 },
    { node_revision: -1 },
  ]) {
    const changed = baseline.map((row) => row.node_id === fixture.currentReplay.nodeId
      ? { ...row, ...mutation } : row);
    assert.equal(inspectAutomationReadinessCanonicalExperimentRows(
      fixture.plan,
      changed,
    ).ready, false, JSON.stringify(mutation));
  }
});

test('canonical experiment rows reject rewritten result bodies with retained hashes', () => {
  const fixture = canonicalReplayFixture();
  const baseline = [
    fixture.row(fixture.oldOriginal),
    fixture.row(fixture.oldReplay),
    fixture.row(fixture.currentOriginal),
    fixture.row(fixture.currentReplay),
  ];
  assert.equal(inspectAutomationReadinessCanonicalExperimentRows(
    fixture.plan,
    baseline,
  ).ready, true);
  for (const [nodeId, blocker] of [
    [
      fixture.currentReplay.nodeId,
      'experiment_ir_execution_current_replay_result_identity_invalid',
    ],
    [
      fixture.currentOriginal.nodeId,
      'experiment_ir_execution_current_original_result_identity_invalid',
    ],
  ]) {
    const changed = baseline.map((row) => row.node_id === nodeId
      ? { ...row, result_json: JSON.stringify({ status: 'rewritten' }) }
      : row);
    const inspected = inspectAutomationReadinessCanonicalExperimentRows(
      fixture.plan,
      changed,
    );
    assert.equal(inspected.ready, false, nodeId);
    assert.ok(inspected.blockers.includes(blocker), nodeId);
  }
});
