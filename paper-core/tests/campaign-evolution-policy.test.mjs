import assert from 'node:assert/strict';
import test from 'node:test';
import { evolveCampaignForResume, validateCampaignRoundExtension } from '../../paper-domain/automation/campaign-evolution-policy.mjs';

test('campaign budget evolution is a pure fail-closed domain policy', () => {
  const campaign = { status: 'stopped', stopReason: 'campaign_cpu_job_budget_exhausted', cpuJobCount: 4, spec: { campaignId: 'c', budgets: { maxCpuJobs: 4, maxAgentCalls: 2 }, campaignPlanHash: 'sha256:old' } };
  assert.throws(() => evolveCampaignForResume({ campaign, budgetOverrides: { maxAgentCalls: 3 } }), /campaign_budget_extension_required:maxCpuJobs/);
  const evolved = evolveCampaignForResume({ campaign, budgetOverrides: { maxCpuJobs: 5, maxAgentCalls: 3 } });
  assert.equal(evolved.nextSpec.budgets.maxCpuJobs, 5);
  assert.notEqual(evolved.nextSpec.campaignPlanHash, 'sha256:old');
  assert.equal(evolved.stoppedForBudget, true);
  assert.throws(() => evolveCampaignForResume({ campaign, budgetOverrides: { maxCpuJobs: 3 } }), /campaign_budget_cannot_decrease/);
});

test('round extension policy validates monotonic budgets, lineage and compatible existing nodes', () => {
  const campaign = { status: 'stopped', stopReason: 'referee_convergence_not_reached_within_budget', paperId: 'p', maxRounds: 1, recoveryOfCampaignId: 'original', spec: { paperId: 'p', recoveryOfCampaignId: 'original', sourceWorkspace: '/paper', budgets: { maxAgentCalls: 2 }, nodes: [] } };
  const spec = { paperId: 'p', maxRounds: 2, recoveryOfCampaignId: 'original', sourceWorkspace: '/paper', budgets: { maxAgentCalls: 3 }, nodes: [{ nodeId: 'old', kind: 'compile', roundIndex: 0 }, { nodeId: 'new-review', kind: 'referee-1', roundIndex: 2 }, { nodeId: 'new-package', kind: 'package', roundIndex: 3 }] };
  const result = validateCampaignRoundExtension({ campaign, spec, existingNodes: [{ nodeId: 'old', kind: 'compile', roundIndex: 0 }] });
  assert.deepEqual(result.additions.map((node) => node.nodeId), ['new-review', 'new-package']);
  assert.throws(() => validateCampaignRoundExtension({ campaign, spec: { ...spec, budgets: { maxAgentCalls: 1 } }, existingNodes: [] }), /campaign_budget_cannot_decrease/);
  assert.throws(() => validateCampaignRoundExtension({ campaign, spec: { ...spec, recoveryOfCampaignId: null }, existingNodes: [] }), /campaign_extension_lineage_mismatch:recoveryOfCampaignId/);
  assert.throws(() => validateCampaignRoundExtension({ campaign, spec: { ...spec, sourceWorkspace: '/other' }, existingNodes: [{ nodeId: 'old', kind: 'compile', roundIndex: 0 }] }), /campaign_extension_immutable_definition_mismatch/);
  assert.throws(() => validateCampaignRoundExtension({ campaign, spec: { ...spec, nodes: spec.nodes.filter((node) => node.nodeId !== 'old') }, existingNodes: [{ nodeId: 'old', kind: 'compile', roundIndex: 0 }] }), /campaign_extension_existing_node_missing/);
});
