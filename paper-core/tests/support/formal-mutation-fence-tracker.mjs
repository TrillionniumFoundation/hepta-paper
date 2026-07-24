import assert from 'node:assert/strict';

import {
  deriveCampaignNodeExecutionContext,
} from '../../../paper-application/automation/campaign-node-execution-context.mjs';

const POST_MUTATION_CONSUMERS = new Set([
  'compile',
  'revalidate-compile',
  'revalidate-citations',
  'revalidate-artifacts',
  'final-compile',
  'research-verify',
]);

export function createFormalMutationFenceTracker() {
  let manuscriptRevision = 0;
  return Object.freeze({
    beforeExecute({ node, allNodes }) {
      const context = deriveCampaignNodeExecutionContext({ node, allNodes });
      if (node.kind === 'writer') manuscriptRevision += 1;
      if (['manuscript-integrate', 'revise'].includes(node.kind)) {
        assert.equal(context.formalVerificationNode?.status, 'completed', node.nodeId);
        assert.equal(
          context.formalVerificationNode?.result?.sourceRevision,
          manuscriptRevision,
          `${node.nodeId} must render from the latest verified manuscript revision`,
        );
        manuscriptRevision += 1;
      }
      if (POST_MUTATION_CONSUMERS.has(node.kind)) {
        assert.equal(context.formalVerificationNode?.status, 'completed', node.nodeId);
        assert.equal(
          context.formalVerificationNode?.result?.sourceRevision,
          manuscriptRevision,
          `${node.nodeId} must consume a post-mutation formal receipt`,
        );
        if (['final-compile', 'research-verify'].includes(node.kind)) {
          assert.equal(
            context.formalVerificationNode?.result?.sourceClosureTerminal,
            true,
            `${node.nodeId} must bind the terminal kernel/replay source closure`,
          );
        }
      }
    },
    resultFor(node) {
      return node.kind === 'formal-verify' ? Object.freeze({
        sourceRevision: manuscriptRevision,
        sourceClosureTerminal: Boolean(
          node.sourceClosureTerminal || node.spec?.sourceClosureTerminal,
        ),
      }) : Object.freeze({});
    },
  });
}
