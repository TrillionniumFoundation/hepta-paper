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
  const agent = ['research-plan', 'writer', 'coder', 'manuscript-integrate', 'revise'].includes(node.kind) || /^(?:revision-)?referee-\d+$/.test(node.kind);
  const empirical = ['empirical', 'compile', 'package', 'revalidate-code', 'revalidate-empirical', 'revalidate-compile', 'revalidate-citations', 'revalidate-artifacts'].includes(node.kind);
  const gpu = Boolean(campaign?.spec?.requiresGpu && ['empirical', 'revalidate-empirical'].includes(node.kind));
  return normalize({ agent: agent ? 1 : 0, cpu: empirical ? 1 : 0, gpu: gpu ? 1 : 0, memoryMiB: agent ? 2048 : empirical ? 1024 : 128 });
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
      if (!fits(waiter.request)) { index += 1; continue; }
      queue.splice(index, 1);
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
    acquire(request = {}) {
      const normalized = normalize(request);
      for (const key of Object.keys(maximum)) if (normalized[key] > maximum[key]) throw new Error(`resource_request_exceeds_limit:${key}`);
      return new Promise((resolve) => { queue.push({ request: normalized, resolve }); drain(); });
    },
  });
}
