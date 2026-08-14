import {
  campaignEmpiricalNodeClassification,
  isCampaignAgentNode,
} from './campaign-node-kind-policy.mjs';
import {
  GPU_SCIENTIFIC_CAMPAIGN_RESOURCE_BUDGET,
  gpuScientificCampaignNodeBinding,
} from '../../paper-domain/automation/gpu-scientific-campaign-execution-contract.mjs';

const DEFAULTS = Object.freeze({ agent: 4, cpu: 4, gpu: 1, memoryMiB: 8192 });

function normalize(request = {}) {
  return {
    agent: Math.max(0, Number(request.agent || 0)),
    cpu: Math.max(0, Number(request.cpu || 0)),
    gpu: Math.max(0, Number(request.gpu || 0)),
    memoryMiB: Math.max(0, Number(request.memoryMiB || 0)),
  };
}

export function resourcesForCampaignNode(campaign, node) {
  if (node.kind === 'gpu-scientific-execution') {
    if (gpuScientificCampaignNodeBinding(node).resourceBudgetHash
      !== GPU_SCIENTIFIC_CAMPAIGN_RESOURCE_BUDGET
        .gpuScientificCampaignResourceBudgetHash) {
      throw new Error('gpu_scientific_campaign_resource_budget_binding_invalid');
    }
    return normalize(GPU_SCIENTIFIC_CAMPAIGN_RESOURCE_BUDGET.nodeReservation);
  }
  const classification = campaignEmpiricalNodeClassification(node.kind);
  const agent = isCampaignAgentNode(node.kind);
  const empirical = classification.empirical || ['advanced-numerical-analysis', 'gpu-scientific-execution', 'formal-verify', 'package', 'revalidate-citations', 'revalidate-artifacts'].includes(node.kind);
  const gpuExecution = classification.primary || classification.reproduction
    || classification.revalidate || ['advanced-numerical-analysis', 'gpu-scientific-execution'].includes(node.kind);
  const gpu = gpuExecution && Boolean(node.spec?.requiresGpu || node.requiresGpu || campaign?.spec?.requiresGpu);
  const empiricalMemoryMiB = Math.max(1, Math.ceil(Number(campaign?.spec?.workerMemoryBytes || 4 * 1024 * 1024 * 1024) / (1024 * 1024)));
  return normalize({ agent: agent ? 1 : 0, cpu: empirical ? 1 : 0, gpu: gpu ? 1 : 0, memoryMiB: agent ? 2048 : empirical ? empiricalMemoryMiB : 128 });
}

export function createResourceGovernor(limits = {}) {
  const maximum = { ...DEFAULTS, ...normalize({ ...DEFAULTS, ...limits }) };
  const used = { agent: 0, cpu: 0, gpu: 0, memoryMiB: 0 };
  const peak = { ...used };
  const queue = [];
  const fits = (request) => Object.keys(used).every((key) => used[key] + request[key] <= maximum[key]);
  const drain = () => {
    for (let index = 0; index < queue.length;) {
      const waiter = queue[index];
      if (waiter.signal?.aborted) {
        queue.splice(index, 1);
        waiter.signal.removeEventListener('abort', waiter.abort);
        waiter.reject(Object.assign(new Error(`resource_acquire_aborted:${String(waiter.signal.reason || 'aborted')}`), { name: 'AbortError', code: 'resource_acquire_aborted' }));
        continue;
      }
      if (!fits(waiter.request)) { index += 1; continue; }
      queue.splice(index, 1);
      waiter.signal?.removeEventListener('abort', waiter.abort);
      Object.keys(used).forEach((key) => { used[key] += waiter.request[key]; peak[key] = Math.max(peak[key], used[key]); });
      waiter.resolve(() => {
        Object.keys(used).forEach((key) => { used[key] -= waiter.request[key]; });
        drain();
      });
    }
  };
  return Object.freeze({
    version: 1,
    kind: 'GlobalResourceGovernor',
    limits: Object.freeze({ ...maximum }),
    snapshot: () => Object.freeze({ limits: { ...maximum }, used: { ...used }, peak: { ...peak }, waiting: queue.length }),
    acquire(request = {}, { signal = null } = {}) {
      const normalized = normalize(request);
      for (const key of Object.keys(maximum)) if (normalized[key] > maximum[key]) throw new Error(`resource_request_exceeds_limit:${key}`);
      if (signal?.aborted) return Promise.reject(Object.assign(new Error(`resource_acquire_aborted:${String(signal.reason || 'aborted')}`), { name: 'AbortError', code: 'resource_acquire_aborted' }));
      return new Promise((resolve, reject) => {
        const waiter = { request: normalized, resolve, reject, signal, abort: null };
        waiter.abort = () => {
          const index = queue.indexOf(waiter);
          if (index >= 0) queue.splice(index, 1);
          signal?.removeEventListener('abort', waiter.abort);
          reject(Object.assign(new Error(`resource_acquire_aborted:${String(signal?.reason || 'aborted')}`), { name: 'AbortError', code: 'resource_acquire_aborted' }));
        };
        signal?.addEventListener('abort', waiter.abort, { once: true });
        queue.push(waiter);
        drain();
      });
    },
  });
}
