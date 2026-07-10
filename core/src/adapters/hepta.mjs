import { CHANNEL_IDS, createChannelTask, normalizeText } from '../contracts.mjs';

function firstValue(...values) {
  for (const value of values) {
    const text = normalizeText(value);
    if (text) return text;
  }
  return null;
}

function numericBudget(...values) {
  for (const value of values) {
    if (typeof value === 'number' && Number.isFinite(value)) return value;
    const match = normalizeText(value).match(/\d+(?:\.\d+)?/);
    if (match) return Number(match[0]);
  }
  return null;
}

export function channelTaskFromHepta(input = {}, options = {}) {
  const externalId = firstValue(input.orderId, input.order_id, input.id, input.checkoutId, input.sessionId);
  if (!externalId) throw new Error('Hepta channel task requires orderId/id/checkoutId/sessionId');
  const includeSourceSnapshot = options.includeSourceSnapshot !== false;
  return createChannelTask({
    channelId: CHANNEL_IDS.HEPTA,
    externalId,
    title: firstValue(input.title, input.productName, input.serviceName, input.skuName, input.name),
    status: firstValue(input.status, input.orderStatus, input.paymentStatus, input.stage),
    url: firstValue(input.url, input.orderUrl, input.deliveryUrl),
    budget: numericBudget(input.amount, input.price, input.total, input.totalAmount),
    deadline: firstValue(input.deadline, input.dueAt, input.deliveryDueAt),
    rawCategory: firstValue(input.category, input.productLineId, input.workflowId, input.sku),
    accountProfile: firstValue(input.accountProfile, input.customerProfile, 'hepta-default'),
    sourceSnapshot: includeSourceSnapshot ? input : null,
    evidenceRefs: input.evidenceRefs || [],
  });
}
