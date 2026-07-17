import assert from 'node:assert/strict';
import test from 'node:test';

import { buildCampaignAgentExecutionRequest } from '../../paper-application/automation/campaign-agent-policy.mjs';
import { deriveCampaignNodeExecutionContext } from '../../paper-application/automation/campaign-node-execution-context.mjs';
import { evaluateRefereeConvergence } from '../../paper-domain/automation/referee-convergence.mjs';

function blockedConvergence(roundIndex, blocker, requestCount = 1) {
  return evaluateRefereeConvergence({
    paperId: 'paper-formal-feedback',
    roundIndex,
    reviews: [],
    qualityGates: [{
      kind: 'TheoremManuscriptReadinessPolicy',
      status: 'theorem_manuscript_not_ready',
      passed: false,
      blockers: [blocker],
      theoremManuscriptReadinessPolicyHash: `sha256:${String(roundIndex).padStart(64, '0')}`,
    }],
    revisionMaterialization: {
      status: 'theorem_quality_revision_requests_materialized',
      requestCount,
      policyHash: `sha256:${String(roundIndex).padStart(64, '1')}`,
    },
  });
}

test('a later revise receives prior theorem readiness blockers and revision materialization', () => {
  const node = { nodeId: 'campaign:2:revise', kind: 'revise', role: 'reviser', roundIndex: 2 };
  const prior = {
    nodeId: 'campaign:1:convergence', kind: 'convergence', roundIndex: 1,
    status: 'completed', result: blockedConvergence(1, 'theorem_proof_status_missing'),
  };
  const sameRound = {
    nodeId: 'campaign:2:convergence', kind: 'convergence', roundIndex: 2,
    status: 'completed', result: blockedConvergence(2, 'must_not_leak_from_same_round'),
  };
  const context = deriveCampaignNodeExecutionContext({ node, allNodes: [prior, sameRound, node] });
  assert.equal(context.priorConvergence.nodeId, prior.nodeId);
  assert.deepEqual(context.qualityGateBlockers, ['theorem_proof_status_missing']);
  assert.equal(context.revisionMaterialization.requestCount, 1);

  const request = buildCampaignAgentExecutionRequest({
    campaign: {
      campaignId: 'campaign', paperId: 'paper-formal-feedback',
      spec: { datasetMounts: [], paperQualityProfile: 'formal_theorem_or_proof' },
    },
    node,
    workspace: '/tmp/formal-feedback',
    manuscript: 'main.tex',
    reviews: [],
    priorConvergence: context.priorConvergence,
    qualityGateBlockers: context.qualityGateBlockers,
    revisionMaterialization: context.revisionMaterialization,
    executionBudget: { remainingTokenCount: 4096, remainingWallTimeMs: 60_000 },
    executionSignal: null,
  });
  assert.match(request.instructions, /create proof_status\.md/i);
  assert.match(request.instructions, /theorem_proof_status_missing/);
  assert.doesNotMatch(request.instructions, /must_not_leak_from_same_round/);
  assert.deepEqual(request.context.qualityGateBlockers, ['theorem_proof_status_missing']);
  assert.ok(request.requiredChecks.includes('rerun theorem manuscript readiness and clear every carried-forward blocker'));
});

test('revise fails closed against future, current-round, incomplete, and unhashed convergence context', () => {
  const node = { nodeId: 'campaign:2:revise', kind: 'revise', role: 'reviser', roundIndex: 2 };
  const candidates = [
    { nodeId: 'future', kind: 'convergence', roundIndex: 3, status: 'completed', result: blockedConvergence(3, 'future_blocker') },
    { nodeId: 'current', kind: 'convergence', roundIndex: 2, status: 'completed', result: blockedConvergence(2, 'current_blocker') },
    { nodeId: 'incomplete', kind: 'convergence', roundIndex: 1, status: 'running', result: blockedConvergence(1, 'incomplete_blocker') },
    { nodeId: 'unhashed', kind: 'convergence', roundIndex: 1, status: 'completed', result: { kind: 'RefereeConvergenceDecision', qualityGateBlockers: ['unhashed_blocker'], refereeConvergenceDecisionHash: 'sha256:not-valid' } },
  ];
  const context = deriveCampaignNodeExecutionContext({ node, allNodes: candidates });
  assert.equal(context.priorConvergence, null);
  assert.deepEqual(context.qualityGateBlockers, []);
  assert.equal(context.revisionMaterialization, null);
});
