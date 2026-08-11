import assert from 'node:assert/strict';
import test from 'node:test';

import { buildCampaignAgentExecutionRequest } from '../../paper-application/automation/campaign-agent-policy.mjs';
import { deriveCampaignNodeExecutionContext } from '../../paper-application/automation/campaign-node-execution-context.mjs';
import { workspaceMutationPolicyBlockers } from '../../paper-adapters/automation/workspace-change-tracker.mjs';
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
  assert.equal(request.timeoutMs, 60_000);
});

test('revision instructions preserve theorem and proof adjacency', () => {
  const request = buildCampaignAgentExecutionRequest({
    campaign: {
      campaignId: 'campaign', paperId: 'paper-formal-adjacency',
      spec: { datasetMounts: [], paperQualityProfile: 'formal_theorem_or_proof' },
    },
    node: { nodeId: 'campaign:1:revise', kind: 'revise', roundIndex: 1 },
    workspace: '/tmp/formal-adjacency',
    manuscript: 'main.tex',
    reviews: [],
    empiricalOutcomeObserved: true,
    executionBudget: { remainingTokenCount: 4096, remainingWallTimeMs: 60_000 },
    executionSignal: null,
  });
  assert.match(request.instructions, /proof environment immediately adjacent/i);
  assert.match(request.instructions, /limitations after the proof/i);
});

test('revise treats current-round formal bindings and generic entailment as downstream', () => {
  const finding = 'THEOREM_SPEC belongs to another campaign; create AUTONOMOUS_MANUSCRIPT_ENTAILMENT.json';
  const request = buildCampaignAgentExecutionRequest({
    campaign: {
      campaignId: 'campaign', paperId: 'paper-stage-boundary',
      spec: {
        datasetMounts: [],
        paperQualityProfiles: ['formal_theorem_or_proof', 'empirical_or_experiment'],
      },
    },
    node: { nodeId: 'campaign:1:revise', kind: 'revise', roundIndex: 1 },
    workspace: '/tmp/formal-stage-boundary',
    manuscript: 'main.tex',
    reviews: [{ verdict: 'revise', findings: [finding] }],
    empiricalOutcomeObserved: true,
    executionBudget: { remainingTokenCount: 4096, remainingWallTimeMs: 60_000 },
    executionSignal: null,
  });
  assert.equal(request.context.evidenceEntailmentMode, 'not_applicable');
  assert.match(request.instructions, /system-owned downstream artifacts/);
  assert.match(request.instructions, /must not make the task status blocked/);
  assert.match(request.instructions, /not in trusted autonomous manuscript entailment mode/);
  assert.match(request.instructions, /must not make this task blocked/);
  assert.match(request.instructions, /never create or edit it/);
  assert.match(request.instructions, /do not return blocked solely because it is absent/);
  assert.match(request.instructions, /Complete every actionable manuscript-local change/);
  assert.match(request.instructions, /THEOREM_SPEC belongs to another campaign/);
});

test('agent requests cap one call below the whole-campaign wall-time budget', () => {
  const request = buildCampaignAgentExecutionRequest({
    campaign: {
      campaignId: 'campaign', paperId: 'paper-timeout-cap',
      spec: { datasetMounts: [] },
    },
    node: {
      nodeId: 'campaign:0:research-plan', kind: 'research-plan', roundIndex: 0,
    },
    workspace: '/tmp/agent-timeout-cap',
    manuscript: 'main.tex',
    reviews: [],
    executionBudget: {
      remainingTokenCount: 8192,
      remainingWallTimeMs: 6 * 60 * 60 * 1000,
    },
    executionSignal: null,
  });
  assert.equal(request.timeoutMs, 20 * 60 * 1000);
  assert.deepEqual(request.workspaceMutationPolicy.allowedPaths, ['RESEARCH_PLAN.md']);
  assert.deepEqual(request.workspaceMutationPolicy.allowedExtensions, []);
});

test('machine-authorized initial writer is confined to manuscript and IR draft', () => {
  const request = buildCampaignAgentExecutionRequest({
    campaign: {
      campaignId: 'campaign',
      paperId: 'paper-machine-writer-scope',
      spec: {
        datasetMounts: [],
        paperQualityProfile: 'formal_theorem_or_proof',
        scientificClaimAuthority: {
          status: 'autonomous_research_seed_bound',
          claimAuthorityType: 'machine-policy-authorized',
          contractPath: 'AUTONOMOUS_RESEARCH_SEED_CONTRACTS.json',
          autonomousResearchSeedBindingHash: `sha256:${'a'.repeat(64)}`,
        },
      },
    },
    node: {
      nodeId: 'campaign:0:writer',
      kind: 'writer',
      role: 'writer',
      roundIndex: 0,
    },
    workspace: '/tmp/machine-writer-scope',
    manuscript: 'main.tex',
    reviews: [],
    executionBudget: {
      remainingTokenCount: 8192,
      remainingWallTimeMs: 60_000,
    },
    executionSignal: null,
  });
  assert.deepEqual(request.workspaceMutationPolicy.allowedPaths, [
    'main.tex',
    'AUTONOMOUS_MANUSCRIPT_IR_DRAFT.json',
  ]);
  assert.deepEqual(request.workspaceMutationPolicy.allowedPrefixes, []);
  assert.deepEqual(request.workspaceMutationPolicy.allowedExtensions, []);
  assert.match(request.instructions,
    /initial writer may modify exactly main\.tex and AUTONOMOUS_MANUSCRIPT_IR_DRAFT\.json/i);
  assert.match(request.instructions,
    /Do not create or edit proof_status\.md, evidence_manifest\.md, an appendix, a bibliography/i);
  assert.match(request.instructions,
    /scope and method prose may cite only compatible proposal, proposal-claim, policy, or seed/i);
  assert.match(request.instructions,
    /never cite empirical claim-lineage or result identities as scope\/method evidence/i);
  assert.match(request.instructions,
    /never use theorem-specification identities as manuscript evidenceRefs/i);
  assert.deepEqual(workspaceMutationPolicyBlockers({
    policy: request.workspaceMutationPolicy,
    changedPaths: ['main.tex', 'AUTONOMOUS_MANUSCRIPT_IR_DRAFT.json'],
  }), []);
  assert.deepEqual(workspaceMutationPolicyBlockers({
    policy: request.workspaceMutationPolicy,
    changedPaths: ['proof_status.md', 'appendix.tex', 'references.bib'],
  }), [
    'workspace_mutation_forbidden:proof_status.md',
    'workspace_mutation_not_allowlisted:appendix.tex',
    'workspace_mutation_not_allowlisted:references.bib',
  ]);

  const revise = buildCampaignAgentExecutionRequest({
    campaign: {
      campaignId: 'campaign',
      paperId: 'paper-machine-writer-scope',
      spec: { datasetMounts: [], paperQualityProfile: 'formal_theorem_or_proof' },
    },
    node: {
      nodeId: 'campaign:2:revise',
      kind: 'revise',
      role: 'reviser',
      roundIndex: 2,
    },
    workspace: '/tmp/machine-writer-scope',
    manuscript: 'main.tex',
    reviews: [],
    qualityGateBlockers: [
      'theorem_proof_status_missing',
      'theorem_evidence_manifest_missing',
    ],
    executionBudget: {
      remainingTokenCount: 8192,
      remainingWallTimeMs: 60_000,
    },
    executionSignal: null,
  });
  assert.ok(revise.workspaceMutationPolicy.allowedPaths.includes('proof_status.md'));
  assert.ok(revise.workspaceMutationPolicy.allowedPaths.includes('evidence_manifest.md'));
  assert.ok(revise.workspaceMutationPolicy.allowedExtensions.includes('.tex'));
  assert.match(revise.instructions, /create proof_status\.md/i);
  assert.match(revise.instructions, /create evidence_manifest\.md/i);
});

test('nested formal requests retain a persisted parent node while exposing their operation identity', () => {
  const request = buildCampaignAgentExecutionRequest({
    campaign: {
      campaignId: 'campaign', paperId: 'paper-formal-node-identity',
      spec: { datasetMounts: [], paperQualityProfile: 'formal_theorem_or_proof' },
    },
    node: {
      nodeId: 'campaign:0:formal-verify:formal-author:0',
      persistedNodeId: 'campaign:0:formal-verify',
      kind: 'formal-author',
      role: 'formal-author',
      roundIndex: 0,
    },
    workspace: '/tmp/formal-node-identity',
    manuscript: 'main.tex',
    reviews: [],
    executionBudget: { remainingTokenCount: 4096, remainingWallTimeMs: 60_000 },
    executionSignal: null,
  });
  assert.equal(request.context.nodeId, 'campaign:0:formal-verify');
  assert.equal(
    request.context.operationNodeId,
    'campaign:0:formal-verify:formal-author:0',
  );
});

test('referee instructions require verdict and score coherence', () => {
  const request = buildCampaignAgentExecutionRequest({
    campaign: { campaignId: 'campaign', paperId: 'paper', spec: { datasetMounts: [] } },
    node: { nodeId: 'review', kind: 'revision-referee-1', role: 'reviewer', roundIndex: 1 },
    workspace: '/tmp/referee-coherence',
    manuscript: 'main.tex',
    reviews: [],
    executionBudget: { remainingTokenCount: 1024, remainingWallTimeMs: 30_000 },
  });
  assert.match(request.instructions, /accept only when no actionable revision is required/i);
  assert.match(request.instructions, /findings must contain deficiencies, not praise/i);
  assert.match(request.instructions, /never mechanically return revise or score 0/i);
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
