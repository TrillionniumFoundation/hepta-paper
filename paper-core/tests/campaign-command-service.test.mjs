import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { buildCampaignBenchmarkSelector } from '../../paper-domain/automation/campaign-benchmark-selector.mjs';
import { empiricalClaimDeclarationsFromAnalysisProtocol } from '../../paper-domain/automation/analysis-protocol-contract.mjs';
import { CampaignCommandService } from '../../paper-application/automation/campaign-command-service.mjs';
import { buildPaperCampaignPlan } from '../../paper-domain/automation/campaign-plan.mjs';
import { readEmpiricalClaimUniverse } from '../../paper-adapters/research-verify/empirical-claim-universe-reader.mjs';

function fixture(planOverride = null) {
  const plan = planOverride || buildPaperCampaignPlan({
    paperId: 'paper-1',
    sourceWorkspace: '/tmp/paper-1',
    campaignId: 'campaign-1',
    maxRounds: 2,
    refereeCount: 2,
    languages: ['latex'],
  });
  const campaign = { ...plan, spec: plan, status: 'running', maxRounds: plan.maxRounds };
  const nodes = [{
    nodeId: 'writer',
    kind: 'writer',
    status: 'running',
    createdAt: '2026-07-15T00:00:00.000Z',
    dependencies: [],
  }];
  const calls = [];
  const campaignStore = {
    listCampaigns: (query) => { calls.push(['listCampaigns', query]); return [campaign]; },
    listNodes: (campaignId) => { calls.push(['listNodes', campaignId]); return nodes; },
    listEvents: (campaignId, query) => { calls.push(['listEvents', campaignId, query]); return []; },
    listTelemetry: () => [],
    getCampaign: () => campaign,
    pauseCampaign: (campaignId, reason) => ({ ...campaign, campaignId, status: 'paused', stopReason: reason }),
    resumeCampaign: (campaignId, input) => { calls.push(['resumeCampaign', campaignId, input]); return { ...campaign, campaignId }; },
    extendCampaign: (nextPlan) => { calls.push(['extendCampaign', nextPlan]); return nextPlan; },
    cancelCampaign: (campaignId, reason) => ({ ...campaign, campaignId, status: 'cancelled', stopReason: reason }),
    cancelNode: (nodeId, reason) => ({ ...nodes[0], nodeId, status: 'cancelled', reason }),
    retryNode: (nodeId) => ({ ...nodes[0], nodeId, status: 'queued' }),
  };
  const service = new CampaignCommandService({
    campaignStore,
    workspaceRegistry: { retentionRecords: () => [{ workspaceId: 'workspace-1' }] },
    receiptLedger: { kind: 'receipt-ledger' },
    runtimeRetentionReceiptLedger: { kind: 'retention-ledger' },
    runtimeRoot: '/tmp/runtime',
    buildRuntimeRetentionPlan: (input) => ({
      version: 1,
      kind: 'RuntimeRetentionPlan',
      input,
      categories: [{ bytesBefore: 64 }],
    }),
    reconcileRuntimeRetentionIntents: (input) => ({ status: 'runtime_retention_recovery_completed', input }),
    executeRuntimeRetentionPlan: (planValue, input) => ({ status: input.apply ? 'runtime_retention_applied' : 'runtime_retention_planned', planValue, input }),
  });
  return { service, calls, campaign, nodes };
}

function empiricalExtensionPlan(t) {
  const sourceWorkspace = fs.mkdtempSync(path.join(os.tmpdir(), 'hepta-campaign-extension-'));
  t.after(() => fs.rmSync(sourceWorkspace, { recursive: true, force: true }));
  const templateSelector = buildCampaignBenchmarkSelector({ benchmarkId: 'ml_algorithm_benchmark' });
  const templateProtocol = Object.freeze({
    ...templateSelector.experimentDesign.analysisProtocol,
    analysisProtocolHash: templateSelector.experimentDesign.analysisProtocolHash,
  });
  const manuscript = empiricalClaimDeclarationsFromAnalysisProtocol(templateProtocol)
    .map((declaration, index) => [
      `% HEPTA_EMPIRICAL_CLAIM_BEGIN ${JSON.stringify(declaration)}`,
      `Confirmatory extension claim ${index + 1}.`,
      `% HEPTA_EMPIRICAL_CLAIM_END ${declaration.claimId}`,
    ].join('\n'))
    .join('\n\n');
  fs.writeFileSync(path.join(sourceWorkspace, 'main.tex'), `${manuscript}\n`);
  const empiricalClaimUniverse = readEmpiricalClaimUniverse({
    sourceRoot: sourceWorkspace,
    manuscriptPath: 'main.tex',
  });
  return buildPaperCampaignPlan({
    paperId: 'empirical-paper',
    sourceWorkspace,
    campaignId: 'empirical-campaign',
    mode: 'local-review-loop',
    maxRounds: 2,
    refereeCount: 2,
    languages: ['python', 'latex'],
    benchmarkId: 'ml_algorithm_benchmark',
    empiricalClaimUniverse,
    applyManuscript: true,
  });
}

test('CampaignCommandService owns bounded queries and campaign control policy', () => {
  const { service, calls } = fixture();
  assert.equal(service.execute({ action: 'list' }).result[0].campaignId, 'campaign-1');
  assert.equal(service.execute({ action: 'status', campaignId: 'campaign-1' }).result.activeNodes.length, 1);
  assert.equal(service.execute({ action: 'logs', campaignId: 'campaign-1', options: { kind: 'writer' } }).result.node.nodeId, 'writer');
  assert.equal(service.execute({ action: 'pause', campaignId: 'campaign-1' }).result.status, 'paused');
  assert.equal(service.execute({ action: 'cancel', campaignId: 'campaign-1' }).result.status, 'cancelled');
  assert.equal(service.execute({ action: 'cancel-node', options: { 'node-id': 'writer' } }).result.status, 'cancelled');
  assert.equal(service.execute({ action: 'retry', options: { 'node-id': 'writer' } }).result.status, 'queued');
  service.execute({
    action: 'resume',
    campaignId: 'campaign-1',
    options: { 'max-wall-ms': '2000', 'max-agent-calls': '5' },
  });
  assert.deepEqual(calls.find(([name]) => name === 'resumeCampaign')[2], {
    budgetOverrides: { maxWallTimeMs: 2000, maxAgentCalls: 5 },
  });
});

test('CampaignCommandService preserves extension budgets and retention/SLO behavior', () => {
  const { service, calls } = fixture();
  service.execute({
    action: 'extend',
    campaignId: 'campaign-1',
    options: { rounds: '4', 'max-cost-usd': '25' },
  });
  const extended = calls.find(([name]) => name === 'extendCampaign')[1];
  assert.equal(extended.maxRounds, 4);
  assert.equal(extended.budgets.maxCostUsd, 25);
  const slo = service.execute({ action: 'slo' }).result;
  assert.equal(slo.kind, 'CampaignSloReport');
  assert.equal(slo.observed.runtimeBytes, 64);
  const dryRun = service.execute({ action: 'gc' }).result;
  assert.equal(dryRun.recovery, null);
  assert.equal(dryRun.receipt.status, 'runtime_retention_planned');
  const applied = service.execute({ action: 'gc', options: { apply: true } }).result;
  assert.equal(applied.recovery.status, 'runtime_retention_recovery_completed');
  assert.equal(applied.receipt.status, 'runtime_retention_applied');
});

test('CampaignCommandService preserves frozen empirical claim authority across automatic round extension', (t) => {
  const original = empiricalExtensionPlan(t);
  assert.throws(() => buildPaperCampaignPlan({
    paperId: 'empirical-authority-without-selector',
    sourceWorkspace: original.sourceWorkspace,
    mode: 'local-review-loop',
    languages: ['python', 'latex'],
    empiricalClaimUniverse: original.empiricalClaimUniverse,
  }), /campaign_empirical_claim_universe_requires_benchmark_selector/);
  const { service, calls } = fixture(original);
  service.execute({
    action: 'extend',
    campaignId: original.campaignId,
    options: { rounds: '3' },
  });
  const extended = calls.find(([name]) => name === 'extendCampaign')[1];
  assert.equal(extended.maxRounds, 3);
  assert.deepEqual(extended.empiricalClaimUniverse, original.empiricalClaimUniverse);
  assert.equal(
    extended.benchmarkSelector.experimentDesign.analysisProtocolHash,
    original.benchmarkSelector.experimentDesign.analysisProtocolHash,
  );
  assert.deepEqual(
    extended.benchmarkSelector.experimentDesign.analysisProtocol.hypotheses,
    original.benchmarkSelector.experimentDesign.analysisProtocol.hypotheses,
  );
});

test('CampaignCommandService owns worker selection and inventory-to-plan policy', () => {
  const { service } = fixture();
  const selected = service.selectWorkerBatch({ campaignId: 'campaign-1' });
  assert.equal(selected.plans.length, 1);
  assert.equal(selected.plans[0].campaignId, 'campaign-1');
  const plans = service.buildPlanBatch({
    inventoryRows: [{
      task: {
        paperId: 'paper-2',
        taskKey: 'paper:paper-2',
        semanticIdentityHash: 'sha256:paper-2',
        paperQualityProfiles: [],
      },
      state: { status: 'inventoried' },
      sourceWorkspace: '/tmp/paper-2',
    }],
    options: {
      paper: ['paper-2'],
      'campaign-id': 'campaign-2',
      languages: 'latex',
      rounds: '4',
      referees: '2',
      'max-cpu-jobs': '9',
    },
  });
  assert.equal(plans[0].campaignId, 'campaign-2');
  assert.equal(plans[0].maxRounds, 4);
  assert.equal(plans[0].refereeCount, 2);
  assert.equal(plans[0].budgets.maxCpuJobs, 9);
});

test('CampaignCommandService fails closed for unsupported commands and missing log nodes', () => {
  const { service } = fixture();
  assert.throws(() => service.execute({ action: 'unknown' }), /unsupported campaign action/);
  assert.throws(() => service.execute({
    action: 'logs',
    campaignId: 'campaign-1',
    options: { kind: 'missing' },
  }), /campaign node not found/);
});
