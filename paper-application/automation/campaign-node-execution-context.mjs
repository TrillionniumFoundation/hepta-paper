import { hashRecord } from '../../workflow-kernel/record-hash.mjs';
import {
  campaignEmpiricalNodeClassification,
  campaignNodeOperation,
} from './campaign-node-kind-policy.mjs';

export {
  campaignEmpiricalNodeClassification,
  campaignNodeOperation,
  isCampaignAgentNode,
  isCampaignRefereeNode,
} from './campaign-node-kind-policy.mjs';

function directDependency(nodes, node, predicate) {
  const dependencies = new Set(node?.dependencies || []);
  return nodes.find((item) => dependencies.has(item.nodeId) && predicate(item)) || null;
}

function latestCompletedDirectDependency(nodes, node, predicate) {
  const dependencies = new Set(node?.dependencies || []);
  return [...nodes]
    .filter((item) => dependencies.has(item.nodeId) && item.status === 'completed' && item.result && predicate(item))
    .sort((left, right) => Number(Boolean(right.sourceClosureTerminal || right.spec?.sourceClosureTerminal))
      - Number(Boolean(left.sourceClosureTerminal || left.spec?.sourceClosureTerminal))
      || Number(right.roundIndex || 0) - Number(left.roundIndex || 0)
      || String(right.nodeId || '').localeCompare(String(left.nodeId || '')))[0] || null;
}

function latestFormalReview(nodes) {
  return [...nodes]
    .filter((item) => item.kind === 'formal-review' && item.result?.kind === 'FormalClaimSemanticReviewEnvelope')
    .sort((left, right) => Number(right.roundIndex || 0) - Number(left.roundIndex || 0))[0] || null;
}

function latestPriorConvergence(nodes, node) {
  const roundIndex = Number(node?.roundIndex || 0);
  const prior = [...nodes]
    .filter((item) => {
      const { refereeConvergenceDecisionHash: claimedHash, ...payload } = item.result || {};
      return item.kind === 'convergence'
      && item.status === 'completed'
      && item.result?.kind === 'RefereeConvergenceDecision'
      && claimedHash === hashRecord('RefereeConvergenceDecision', payload)
      && Number(item.roundIndex || 0) < roundIndex;
    })
    .sort((left, right) => Number(right.roundIndex || 0) - Number(left.roundIndex || 0))[0] || null;
  if (!prior) return null;
  return Object.freeze({
    nodeId: prior.nodeId || null,
    roundIndex: Number(prior.roundIndex || 0),
    status: prior.result.status || null,
    accepted: prior.result.accepted === true,
    qualityGateBlockers: Object.freeze([...(prior.result.qualityGateBlockers || [])].map(String)),
    revisionMaterialization: prior.result.revisionMaterialization || null,
    refereeConvergenceDecisionHash: prior.result.refereeConvergenceDecisionHash || null,
  });
}

function empiricalBaseline(nodes, node, classification) {
  if (!classification.reproduction) return null;
  return directDependency(nodes, node, (item) => {
    const candidate = campaignEmpiricalNodeClassification(item.kind);
    return classification.reproduce ? candidate.primary : candidate.revalidate;
  });
}

export function deriveCampaignNodeExecutionContext({ node, allNodes = [] } = {}) {
  const nodes = Array.isArray(allNodes) ? allNodes : [];
  const empirical = campaignEmpiricalNodeClassification(node?.kind);
  const directFormalReview = directDependency(nodes, node, (item) => item.kind === 'formal-review');
  const directFormalVerification = latestCompletedDirectDependency(nodes, node, (item) => item.kind === 'formal-verify');
  const priorConvergence = latestPriorConvergence(nodes, node);
  return Object.freeze({
    operation: campaignNodeOperation(node?.kind),
    campaignNodes: nodes,
    reviews: nodes
      .filter((item) => item.roundIndex === node?.roundIndex && /^referee-\d+$/.test(item.kind))
      .map((item) => item.result)
      .filter(Boolean),
    priorConvergence,
    qualityGateBlockers: priorConvergence?.qualityGateBlockers || Object.freeze([]),
    revisionMaterialization: priorConvergence?.revisionMaterialization || null,
    revisionNode: nodes.find((item) => item.roundIndex === node?.roundIndex && item.kind === 'revise') || null,
    formalAuthorNode: directDependency(nodes, node, (item) => item.kind === 'formal-author'),
    theoremSpecificationNode: directDependency(nodes, node, (item) => item.kind === 'theorem-spec'),
    formalReviewNode: node?.kind === 'formal-verify' ? directFormalReview : latestFormalReview(nodes),
    formalVerificationNode: directFormalVerification,
    finalCompileNode: directDependency(nodes, node, (item) => item.kind === 'final-compile'),
    researchVerifyNode: directDependency(nodes, node, (item) => item.kind === 'research-verify'),
    empirical,
    empiricalBaselineNode: empiricalBaseline(nodes, node, empirical),
  });
}
