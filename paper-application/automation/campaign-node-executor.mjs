import { hashRecord } from '../../workflow-kernel/record-hash.mjs';
import { assertCampaignNodePrimitivesPort } from '../../paper-ports/campaign-node-primitives-port.mjs';
import { assertCampaignWorkspaceAttemptPort } from '../../paper-ports/campaign-workspace-attempt-port.mjs';
import {
  deriveCampaignNodeExecutionContext,
} from './campaign-node-execution-context.mjs';
import {
  executeCampaignAgentNode,
  executeCampaignFormalVerificationNode,
  executeCampaignResearchVerificationNode,
} from './campaign-agent-node-orchestrator.mjs';
import { executeCampaignEmpiricalNode } from './campaign-empirical-node-orchestrator.mjs';
import {
  executeCampaignAdvancedNumericalNode,
} from './campaign-advanced-numerical-node-orchestrator.mjs';
import {
  executeCampaignGpuScientificNode,
} from './campaign-gpu-scientific-node-orchestrator.mjs';
import {
  executeCampaignConvergenceNode,
  executeCampaignPackageNode,
  executeCampaignQualityRevalidationNode,
} from './campaign-quality-release-orchestrator.mjs';

export { campaignNodeOperation } from './campaign-node-execution-context.mjs';

function executeNoop(node) {
  const payload = {
    version: 1,
    kind: 'CampaignNoopNodeReceipt',
    nodeKind: node.kind,
    status: 'campaign_node_completed',
    externalActionPerformed: false,
  };
  return Object.freeze({ ...payload, receiptHash: hashRecord('CampaignNoopNodeReceipt', payload) });
}

async function executeOperation({
  primitives,
  campaign,
  node,
  context,
  input,
  experimentRegistryAuthorityVerifier,
  reviewerEvidenceAuthority,
  advancedNumericalExecution,
  gpuScientificExecution,
}) {
  const { workspace, manuscript } = primitives.workspace.describe({ sourceWorkspace: campaign.spec.sourceWorkspace });
  const common = {
    primitives,
    campaign,
    node,
    context,
    workspace,
    manuscript,
    executionBudget: input.executionBudget || {},
    executionSignal: input.executionSignal || null,
    executionResources: input.executionResources || null,
  };
  switch (context.operation) {
    case 'advanced-numerical': return executeCampaignAdvancedNumericalNode({
      ...common,
      advancedNumericalExecution,
    });
    case 'gpu-scientific': return executeCampaignGpuScientificNode({
      ...common,
      gpuScientificExecution,
    });
    case 'formal-verification': return executeCampaignFormalVerificationNode(common);
    case 'research-verification': return executeCampaignResearchVerificationNode(common);
    case 'agent': return executeCampaignAgentNode(common);
    case 'convergence': return executeCampaignConvergenceNode(common);
    case 'quality-revalidation': return executeCampaignQualityRevalidationNode(common);
    case 'package': return executeCampaignPackageNode({
      ...common, experimentRegistryAuthorityVerifier, reviewerEvidenceAuthority,
    });
    case 'empirical': return executeCampaignEmpiricalNode(common);
    case 'noop': return executeNoop(node);
    default: throw new Error(`campaign_node_operation_invalid:${context.operation}`);
  }
}

export function createCampaignNodeExecutor({
  nodePrimitives,
  workspaceAttempts,
  experimentRegistryAuthorityVerifier = null,
  signedReviewerReceiptVerifier = null,
  sessionReviewerReceiptVerifier = null,
  reviewerEvidenceAuthority = null,
  advancedNumericalExecution = null,
  gpuScientificExecution = null,
} = {}) {
  if (signedReviewerReceiptVerifier !== null
    && typeof signedReviewerReceiptVerifier !== 'function') {
    throw new Error('signed_reviewer_receipt_verifier_invalid');
  }
  if (sessionReviewerReceiptVerifier !== null
    && typeof sessionReviewerReceiptVerifier !== 'function') {
    throw new Error('session_reviewer_receipt_verifier_invalid');
  }
  const primitives = assertCampaignNodePrimitivesPort(nodePrimitives);
  const attempts = assertCampaignWorkspaceAttemptPort(workspaceAttempts);
  return Object.freeze({
    version: 1,
    kind: 'CampaignNodeExecutor',
    verifySignedReviewerReceipt: signedReviewerReceiptVerifier,
    verifySessionReviewerReceipt: sessionReviewerReceiptVerifier,
    async execute(input = {}) {
      let campaign = input.campaign;
      const { node } = input;
      let workspaceAttempt = null;
      if (input.deferWorkspaceIntegration) {
        if (!node?.attemptId) throw new Error('campaign_node_attempt_id_required_for_workspace_isolation');
        workspaceAttempt = attempts.prepare({ campaign, node });
        campaign = Object.freeze({
          ...campaign,
          spec: Object.freeze({ ...campaign.spec, sourceWorkspace: workspaceAttempt.attemptWorkspace }),
        });
      }
      const context = deriveCampaignNodeExecutionContext({ node, allNodes: input.allNodes });
      const result = await executeOperation({
        primitives,
        campaign,
        node,
        context,
        input,
        experimentRegistryAuthorityVerifier,
        reviewerEvidenceAuthority,
        advancedNumericalExecution,
        gpuScientificExecution,
      });
      if (!workspaceAttempt) return result;
      return Object.freeze({
        ...result,
        workspaceAttemptIntegration: attempts.describe(workspaceAttempt),
      });
    },
    integratePrepared(input = {}) {
      if (!input.result?.workspaceAttemptIntegration) return null;
      return attempts.integrate(input);
    },
  });
}
