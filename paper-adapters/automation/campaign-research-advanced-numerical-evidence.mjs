import {
  verifyCampaignAdvancedNumericalExecutionResult,
} from '../../paper-domain/automation/advanced-numerical-campaign-execution-contract.mjs';
import { assertCompletedNodeResult } from './campaign-research-verifier-evidence-helpers.mjs';

export function requireCampaignResearchAdvancedNumericalEvidence({
  campaign,
  authoritativeNodes,
  directDependencies,
} = {}) {
  const advancedNumericalPlan = campaign.spec.advancedNumericalExecutionPlan || null;
  const advancedNumericalDependencyNodes = authoritativeNodes.filter((candidate) => (
    directDependencies.has(candidate.nodeId)
      && candidate.kind === 'advanced-numerical-analysis'
  ));
  if (!advancedNumericalPlan) {
    if (advancedNumericalDependencyNodes.length) {
      throw new Error('campaign_research_unplanned_advanced_numerical_dependency');
    }
    return null;
  }
  if (advancedNumericalDependencyNodes.length !== 1) {
    throw new Error('campaign_research_advanced_numerical_dependency_required');
  }
  const advancedNode = assertCompletedNodeResult(
    advancedNumericalDependencyNodes[0],
    'advanced_numerical_node',
  );
  if (!verifyCampaignAdvancedNumericalExecutionResult(advancedNode.result, {
    campaign,
    node: advancedNode,
    plan: advancedNumericalPlan,
  })) {
    throw new Error('campaign_research_advanced_numerical_evidence_invalid');
  }
  const {
    workspaceAttemptIntegration: _workspaceAttemptIntegration,
    ...advancedNumericalSemanticResult
  } = advancedNode.result;
  const evidence = Object.freeze({
    nodeId: advancedNode.nodeId,
    attemptId: advancedNode.attemptId,
    leaseGeneration: advancedNode.leaseGeneration,
    nodeResultHash: advancedNode.resultSha256,
    executionPlanHash:
      advancedNumericalPlan.advancedNumericalCampaignExecutionPlanHash,
    executionReceiptHash:
      advancedNode.result.advancedNumericalCampaignExecutionReceiptHash,
    evidenceHash: advancedNode.result.advancedNumericalCampaignEvidenceHash,
    evidenceDocumentHash: advancedNode.result.evidenceDocumentHash,
    productionQualified: advancedNode.result.productionQualified,
    promotionEligible: advancedNode.result.promotionEligible,
    result: Object.freeze(advancedNumericalSemanticResult),
  });
  if (!evidence.promotionEligible) {
    const error = new Error(
      'campaign_research_advanced_numerical_production_qualification_required',
    );
    error.retryable = false;
    error.receipt = advancedNode.result;
    throw error;
  }
  return evidence;
}
