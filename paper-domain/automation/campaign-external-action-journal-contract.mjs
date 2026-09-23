import { hashRecord } from '../../workflow-kernel/record-hash.mjs';

const SHA256 = /^sha256:[0-9a-f]{64}$/;
const MAX_OUTCOME_BYTES = 8 * 1024 * 1024;
const TRANSIENT_REQUEST_FIELDS = new Set([
  'assertExternalSideEffectReady',
  'attemptId',
  'externalActionId',
  'leaseGeneration',
  'requestDigest',
  'signal',
  'workerId',
]);

function stableRequestValue(value) {
  if (Array.isArray(value)) return value.map(stableRequestValue);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value)
      .filter(([key, item]) => !TRANSIENT_REQUEST_FIELDS.has(key)
        && item !== undefined && typeof item !== 'function'
        && typeof item !== 'symbol')
      .map(([key, item]) => [key, stableRequestValue(item)]));
  }
  return value;
}

export function campaignPlanIdentityHash(campaign) {
  const claimed = campaign?.spec?.campaignPlanHash;
  return SHA256.test(String(claimed || ''))
    ? claimed
    : hashRecord('PaperCampaignPlanSnapshot', campaign?.spec || {});
}

export function campaignNodeSemanticSpecHash(node) {
  return hashRecord('PaperCampaignNodeSemanticSpec', node?.spec || {});
}

export function campaignExternalActionRequestDigest(request = {}) {
  return hashRecord(
    'CampaignNodeExternalActionRequest',
    stableRequestValue(request),
  );
}

export function buildCampaignExternalActionDescriptor({
  campaign,
  node,
  request = {},
  actionOrdinal,
  resolverKind = 'unqualified',
} = {}) {
  const action = String(request.action || 'unspecified');
  const ordinal = Number(actionOrdinal);
  const campaignPlanHash = campaignPlanIdentityHash(campaign);
  const nodeSemanticSpecHash = campaignNodeSemanticSpecHash(node);
  const requestDigest = SHA256.test(String(request.requestDigest || ''))
    ? request.requestDigest
    : campaignExternalActionRequestDigest(request);
  if (!campaign?.campaignId || !node?.nodeId || node.campaignId !== campaign.campaignId
    || !Number.isSafeInteger(ordinal) || ordinal < 1
    || !resolverKind || !SHA256.test(campaignPlanHash)
    || !SHA256.test(nodeSemanticSpecHash) || !SHA256.test(requestDigest)) {
    throw new Error('campaign_external_action_descriptor_invalid');
  }
  const identity = Object.freeze({
    campaignId: campaign.campaignId,
    nodeId: node.nodeId,
    campaignPlanHash,
    nodeSemanticSpecHash,
    action,
    actionOrdinal: ordinal,
    requestDigest,
    resolverKind: String(resolverKind),
  });
  return Object.freeze({
    ...identity,
    externalActionId: hashRecord('CampaignNodeExternalActionIdentity', identity),
  });
}

export function assertCampaignExternalActionDescriptor(value, expected = {}) {
  if (!value || !value.campaignId || !value.nodeId || !value.action
    || !value.resolverKind || !Number.isSafeInteger(Number(value.actionOrdinal))
    || Number(value.actionOrdinal) < 1
    || !SHA256.test(String(value.externalActionId || ''))
    || !SHA256.test(String(value.campaignPlanHash || ''))
    || !SHA256.test(String(value.nodeSemanticSpecHash || ''))
    || !SHA256.test(String(value.requestDigest || ''))) {
    throw new Error('campaign_external_action_descriptor_invalid');
  }
  const identity = {
    campaignId: value.campaignId,
    nodeId: value.nodeId,
    campaignPlanHash: value.campaignPlanHash,
    nodeSemanticSpecHash: value.nodeSemanticSpecHash,
    action: value.action,
    actionOrdinal: Number(value.actionOrdinal),
    requestDigest: value.requestDigest,
    resolverKind: value.resolverKind,
  };
  if (hashRecord('CampaignNodeExternalActionIdentity', identity)
      !== value.externalActionId
    || Object.entries(expected).some(([key, item]) => (
      item !== undefined && identity[key] !== item && value[key] !== item
    ))) {
    throw new Error('campaign_external_action_descriptor_conflict');
  }
  return Object.freeze({ ...identity, externalActionId: value.externalActionId });
}

export function buildCampaignExternalActionOutcome(payload) {
  let encoded;
  try { encoded = JSON.stringify(payload === undefined ? null : payload); }
  catch { throw new Error('campaign_external_action_outcome_invalid'); }
  if (encoded === undefined || Buffer.byteLength(encoded, 'utf8') > MAX_OUTCOME_BYTES) {
    throw new Error('campaign_external_action_outcome_invalid');
  }
  const canonicalPayload = JSON.parse(encoded);
  return Object.freeze({
    payload: canonicalPayload,
    outcomeHash: hashRecord('CampaignNodeExternalActionOutcome', canonicalPayload),
  });
}

export function assertCampaignExternalActionOutcome(payload, outcomeHash) {
  const outcome = buildCampaignExternalActionOutcome(payload);
  if (outcome.outcomeHash !== outcomeHash) {
    throw new Error('campaign_external_action_outcome_hash_invalid');
  }
  return outcome;
}
