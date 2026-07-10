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

export function channelTaskFromZbj(input = {}, options = {}) {
  const externalId = firstValue(input.taskId, input.task_id, input.orderId, input.order_id, input.id);
  if (!externalId) throw new Error('ZBJ channel task requires taskId/orderId/id');
  const includeSourceSnapshot = options.includeSourceSnapshot !== false;
  return createChannelTask({
    channelId: CHANNEL_IDS.ZBJ,
    externalId,
    title: firstValue(input.title, input.taskTitle, input.taskName, input.name),
    status: firstValue(input.statusName, input.status, input.stateName, input.stage),
    url: firstValue(input.url, input.taskUrl, input.sourceUrl) || `https://task.zbj.com/${externalId}/`,
    budget: numericBudget(input.amount, input.budget, input.budgetAmount, input.price, input.reward),
    deadline: firstValue(input.deadline, input.endTime, input.end_time, input.expireTime),
    rawCategory: firstValue(input.category, input.categoryName, input.industryName, input.serviceName),
    accountProfile: firstValue(input.accountProfile, input.sellerProfile, 'zbj-default'),
    sourceSnapshot: includeSourceSnapshot ? input : null,
    evidenceRefs: input.evidenceRefs || [],
  });
}
