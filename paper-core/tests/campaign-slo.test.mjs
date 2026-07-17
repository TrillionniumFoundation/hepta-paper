import assert from 'node:assert/strict';
import test from 'node:test';
import { buildCampaignSloReport } from '../../paper-domain/automation/campaign-slo.mjs';

test('campaign SLO report measures queue, recovery, success, usage and cost honesty', () => {
  const nodes = [
    { nodeId: 'n1', status: 'completed', createdAt: '2026-01-01T00:00:00.000Z', childSessionId: 's1' },
    { nodeId: 'n2', status: 'failed_terminal', createdAt: '2026-01-01T00:00:00.000Z', dependencies: ['n1'] },
  ];
  const events = [
    { nodeId: 'n1', kind: 'campaign_node_started', createdAt: '2026-01-01T00:00:01.000Z' },
    { nodeId: 'n1', kind: 'campaign_node_completed', createdAt: '2026-01-01T00:00:01.500Z' },
    { nodeId: 'n2', kind: 'campaign_node_retry_queued', createdAt: '2026-01-01T00:00:02.000Z' },
    { nodeId: 'n2', kind: 'campaign_node_started', createdAt: '2026-01-01T00:00:05.000Z' },
  ];
  const report = buildCampaignSloReport({
    campaigns: [{ status: 'completed', agentCallCount: 2, cpuJobCount: 1, gpuJobCount: 0, tokenCount: 20, costKnown: false, costUsd: null }],
    nodes,
    events,
    telemetrySamples: [{ phases: { dispatch: 2, lockAcquire: 3, command: 100, lockRelease: 2, total: 107 }, lockWaitMs: 3, queueContentionCount: 1 }],
    runtimeBytes: 100,
    targets: { minimumTerminalNodeSuccessRate: 0.5, maximumQueueWaitP95Ms: 6000, maximumRecoveryP95Ms: 4000, maximumRuntimeBytes: 1000 },
  });
  assert.equal(report.observed.terminalNodeSuccessRate, 0.5);
  assert.equal(report.observed.queueWaitP95Ms, 3500);
  assert.equal(report.observed.recoveryP95Ms, 3000);
  assert.equal(report.observed.uniqueChildSessionCount, 1);
  assert.equal(report.observed.phaseTimingP95Ms.command, 100);
  assert.equal(report.observed.lockWaitHistogram.at(-1).count, 1);
  assert.equal(report.objectives.costsAuditable, false);
  assert.equal(report.status, 'campaign_slos_not_met');
});

test('campaign SLO never treats missing latency samples as passing', () => {
  const report = buildCampaignSloReport({ campaigns: [], nodes: [], events: [] });
  assert.equal(report.objectives.queueWaitP95, false);
  assert.equal(report.objectives.recoveryP95, false);
  assert.equal(report.objectiveStates.queueWaitP95, 'insufficient_data');
  assert.equal(report.objectiveStates.recoveryP95, 'insufficient_data');
  assert.equal(report.status, 'campaign_slos_not_met');
});
