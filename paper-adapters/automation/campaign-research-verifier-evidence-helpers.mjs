import { hashRecord } from '../../workflow-kernel/record-hash.mjs';
import {
  buildCampaignEmpiricalAttemptId,
} from '../../paper-domain/automation/campaign-empirical-attempt-identity.mjs';

export function assertCompletedNodeResult(node, label) {
  if (!node || node.status !== 'completed' || !node.attemptId
    || !Number.isInteger(node.leaseGeneration) || node.leaseGeneration < 1
    || !node.result || !node.resultSha256
    || hashRecord('PaperCampaignNodeResult', node.result) !== node.resultSha256) {
    throw new Error(`campaign_experiment_${label}_store_evidence_invalid`);
  }
  return node;
}

export function replayProfile(kind) {
  return String(kind || '')
    .replace(/^revalidate-/, '')
    .replace(/^empirical-reproduce(?:-|$)/, '')
    .replace(/^-?source-seal(?=-|$)/, '') || 'default';
}

export function sourceClosureTerminal(node) {
  return Boolean(node?.sourceClosureTerminal || node?.spec?.sourceClosureTerminal);
}

export function expectedCampaignEmpiricalAttemptId(campaign, node, receipt) {
  return buildCampaignEmpiricalAttemptId({
    campaignId: campaign.campaignId,
    nodeId: node.nodeId,
    attemptId: node.attemptId,
    attemptVersion: receipt?.preDataAccessFreeze?.attemptVersion || 1,
  });
}
