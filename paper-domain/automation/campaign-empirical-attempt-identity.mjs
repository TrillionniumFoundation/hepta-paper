import { hashRecord } from '../../workflow-kernel/record-hash.mjs';

export function buildCampaignEmpiricalAttemptRootId({
  campaignId,
  nodeId,
  attemptId,
} = {}) {
  const campaign = String(campaignId || 'campaign');
  const node = String(nodeId || 'node');
  const attempt = String(attemptId || 'direct');
  const scopedNode = node.startsWith(`${campaign}:`) ? node : `${campaign}:${node}`;
  const readable = `${scopedNode}:${attempt}`;
  if (/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,79}$/.test(readable)) return readable;
  return `empirical-attempt:${hashRecord('CampaignEmpiricalAttemptRoot', {
    campaignId: campaign,
    nodeId: scopedNode,
    attemptId: attempt,
  }).slice('sha256:'.length)}`;
}

export function buildCampaignEmpiricalAttemptId({
  campaignId,
  nodeId,
  attemptId,
  attemptVersion = 1,
} = {}) {
  const version = Number(attemptVersion);
  if (!Number.isSafeInteger(version) || version < 1) {
    throw new Error('campaign_empirical_attempt_version_invalid');
  }
  const root = buildCampaignEmpiricalAttemptRootId({
    campaignId,
    nodeId,
    attemptId,
  });
  return version === 1 ? root : `${root}:v${version}`;
}
