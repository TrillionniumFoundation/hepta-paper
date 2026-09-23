import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { createCampaignNodeExecutor } from '../../paper-composition/automation/campaign-node-execution-composition.mjs';
import { hashRecord } from '../../workflow-kernel/record-hash.mjs';

function reviewReceipt({ agentId, attempt }) {
  const structuredOutput = {
    verdict: 'revise', score: 0.7, criticalFindingCount: 1,
    findings: ['Clarify the limitation.'], summary: 'One revision is required.',
  };
  const payload = {
    status: 'agent_execution_completed', agentId, principalId: agentId,
    sessionId: `${agentId}:${attempt}`, structuredOutput,
    finalOutput: JSON.stringify(structuredOutput), externalActionPerformed: false,
    externalModelInvocationPerformed: false,
  };
  return { ...payload, agentExecutionReceiptHash: hashRecord('AgentExecutionReceipt', payload) };
}

function campaign(workspace) {
  return {
    campaignId: 'independent-review-campaign', paperId: 'independent-review-paper',
    spec: { sourceWorkspace: workspace, datasetMounts: [] },
  };
}

test('ordinary and revision referees cannot fall back to the author principal', async (t) => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'hepta-independent-referee-'));
  t.after(() => fs.rmSync(workspace, { recursive: true, force: true }));
  fs.writeFileSync(path.join(workspace, 'main.tex'), '\\section{Claim}A bounded draft.\n');
  fs.mkdirSync(path.join(workspace, 'runtime'), { recursive: true });
  let authorCalls = 0;
  const withoutIndependentReviewer = createCampaignNodeExecutor({
    runtimeRoot: path.join(workspace, 'runtime'),
    agentExecutor: { async execute() { authorCalls += 1; throw new Error('author_must_not_review'); } },
    empiricalExecutor: { execute() { throw new Error('empirical_not_expected'); } },
  });
  await assert.rejects(
    () => withoutIndependentReviewer.execute({
      campaign: campaign(workspace),
      node: { nodeId: 'referee', kind: 'referee-1', role: 'referee-1', roundIndex: 1, attemptId: 'review-attempt-1' },
      allNodes: [], executionBudget: { remainingTokenCount: 1024, remainingWallTimeMs: 60_000 },
    }),
    /independent_review_principal_executor_required/,
  );
  assert.equal(authorCalls, 0);

  let reviewerCalls = 0;
  const withIndependentReviewer = createCampaignNodeExecutor({
    runtimeRoot: path.join(workspace, 'runtime'),
    agentExecutor: { async execute() { authorCalls += 1; throw new Error('author_must_not_review'); } },
    formalReviewAgentExecutor: {
      async execute(input) {
        reviewerCalls += 1;
        return reviewReceipt({ agentId: 'independent-referee-principal', attempt: input.context.nodeId });
      },
    },
    empiricalExecutor: { execute() { throw new Error('empirical_not_expected'); } },
  });
  for (const [index, kind] of ['referee-1', 'revision-referee-1'].entries()) {
    const result = await withIndependentReviewer.execute({
      campaign: campaign(workspace),
      node: {
        nodeId: kind, kind, role: kind, roundIndex: 1,
        attemptId: `independent-review-attempt-${index + 1}`,
      },
      allNodes: [], executionBudget: { remainingTokenCount: 1024, remainingWallTimeMs: 60_000 },
    });
    assert.equal(result.reviewPrincipalId, 'independent-referee-principal');
    assert.equal(result.reviewAttemptId, `independent-review-attempt-${index + 1}`);
    assert.match(result.childSessionId, /^independent-referee-principal:/);
  }
  assert.equal(authorCalls, 0);
  assert.equal(reviewerCalls, 2);
});
