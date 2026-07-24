import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildExperimentIrExecutionAuthorityReceipt,
  verifyExperimentIrExecutionAuthorityReceipt,
} from '../../paper-domain/automation/experiment-ir-execution-authority-contract.mjs';
import {
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
      researchAgendaProducerReceipt: {},
      researchAgendaIr: {},
    },
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
  const inspection = inspectPersistedExperimentIrExecutionAuthority({
    store: { query: () => ({
      ok: true,
      rows: [{
        campaign_id: 'campaign-1',
        paper_id: 'paper-1',
        spec_json: JSON.stringify(plan),
        node_id: 'campaign-1:0:empirical-reproduce',
        node_kind: 'empirical-reproduce',
        node_status: 'completed',
        result_json: JSON.stringify(result),
        result_sha256: hashRecord('PaperCampaignNodeResult', result),
      }],
    }) },
  });
  assert.equal(inspection.ready, false);
  assert.deepEqual(inspection.blockers, [
    'experiment_ir_execution_authority_not_persisted',
  ]);
});
