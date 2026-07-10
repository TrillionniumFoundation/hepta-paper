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

export function channelTaskFromEpwk(input = {}, options = {}) {
  const externalId = firstValue(input.taskId, input.task_id, input.taskIdStr, input.id, input.task_id_str);
  if (!externalId) throw new Error('EPWK channel task requires taskId/task_id/id');
  const includeSourceSnapshot = options.includeSourceSnapshot !== false;
  return createChannelTask({
    channelId: CHANNEL_IDS.EPWK,
    externalId,
    title: firstValue(input.title, input.taskTitle, input.task_title, input.name),
    status: firstValue(input.statusName, input.status_name, input.status, input.stage),
    url: firstValue(input.url, input.taskUrl, input.task_url) || `https://task.epwk.com/${externalId}/`,
    budget: numericBudget(input.cash, input.taskCash, input.task_cash, input.budget, input.price),
    deadline: firstValue(input.deadline, input.endTime, input.end_time, input.expireTime),
    rawCategory: firstValue(input.category, input.categoryName, input.category_name, input.serviceName),
    accountProfile: firstValue(input.accountProfile, input.profileName, 'tomas'),
    sourceSnapshot: includeSourceSnapshot ? input : null,
    evidenceRefs: input.evidenceRefs || [],
  });
}
