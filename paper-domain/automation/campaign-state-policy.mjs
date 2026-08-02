export const CAMPAIGN_NODE_DONE_STATUSES = Object.freeze(['completed', 'skipped']);
export const CAMPAIGN_TERMINAL_STATUSES = Object.freeze(['completed', 'failed', 'cancelled']);
export const CAMPAIGN_SETTLED_STATUSES = Object.freeze([...CAMPAIGN_TERMINAL_STATUSES, 'stopped']);

const DONE = new Set(CAMPAIGN_NODE_DONE_STATUSES);
const TERMINAL = new Set(CAMPAIGN_TERMINAL_STATUSES);
const CONVERGENCE_TERMINAL_KINDS = new Set(['final-compile', 'research-verify', 'package', 'release-package']);

function nodeId(node) { return node?.nodeId || null; }
function roundIndex(node) { return Number(node?.roundIndex ?? 0); }
function createdAt(node) { return String(node?.createdAt || ''); }

function nodeOrder(left, right) {
  return Number(left?.priority || 100) - Number(right?.priority || 100)
    || createdAt(left).localeCompare(createdAt(right))
    || String(nodeId(left)).localeCompare(String(nodeId(right)));
}

export function deriveCampaignOperationalProjection(nodes = []) {
  const ordered = [...nodes].sort(nodeOrder);
  const terminalFailure = ordered.some((node) => node.status === 'failed_terminal');
  const completed = ordered.length > 0 && ordered.every((node) => DONE.has(node.status));
  const active = ordered.find((node) => ['running', 'leased'].includes(node.status));
  const pending = ordered.find((node) => ![...DONE, 'failed_terminal'].includes(node.status));
  const reviewRounds = ordered
    .filter((node) => roundIndex(node) > 0 && !['package', 'release-package'].includes(node.kind)
      && ['leased', 'running', 'completed', 'failed_terminal'].includes(node.status))
    .map(roundIndex);
  return Object.freeze({
    version: 1,
    kind: 'CampaignOperationalProjection',
    status: terminalFailure ? 'failed' : completed ? 'completed' : 'running',
    currentPhase: terminalFailure ? 'failed' : completed ? 'completed' : active?.kind || pending?.kind || 'running',
    currentReviewRound: reviewRounds.length ? Math.max(...reviewRounds) : 0,
    terminal: terminalFailure || completed,
  });
}

export function selectReadyCampaignNodes(nodes = [], { limit = 1 } = {}) {
  const byId = new Map(nodes.map((node) => [nodeId(node), node]));
  return [...nodes]
    .filter((node) => node.status === 'queued'
      && (node.dependencies || []).every((dependency) => DONE.has(byId.get(dependency)?.status)))
    .sort(nodeOrder)
    .slice(0, Math.max(1, Number(limit || 1)));
}

export function decideNodeFailureTransition(node, { retryable = true } = {}) {
  if (!node) throw new Error('campaign node is required');
  const attemptCount = Number(node.attemptCount ?? 0);
  const maxAttempts = Number(node.maxAttempts ?? 3);
  const retryLimit = node.preparedIntegrationStatus === 'integrated'
    ? maxAttempts + 1 : maxAttempts;
  const canRetry = Boolean(retryable) && attemptCount < retryLimit;
  return Object.freeze({
    status: canRetry ? 'queued' : 'failed_terminal',
    canRetry,
    eventKind: canRetry ? 'campaign_node_retry_queued' : 'campaign_node_failed_terminal',
  });
}

export function cascadeCancelledNodeIds(nodes = [], rootNodeId) {
  if (!rootNodeId) throw new Error('rootNodeId is required');
  const cancelled = new Set([rootNodeId]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const node of nodes) {
      const id = nodeId(node);
      if (!cancelled.has(id) && (node.dependencies || []).some((dependency) => cancelled.has(dependency))) {
        cancelled.add(id);
        changed = true;
      }
    }
  }
  return Object.freeze([...cancelled].sort());
}

export function selectFutureRoundNodeIds(nodes = [], { afterRound } = {}) {
  const threshold = Number(afterRound || 0);
  return Object.freeze(nodes
    .filter((node) => roundIndex(node) > threshold && !CONVERGENCE_TERMINAL_KINDS.has(node.kind) && node.status === 'queued')
    .map(nodeId)
    .filter(Boolean)
    .sort());
}

export function decideCampaignCommand(campaign, command) {
  if (!campaign) throw new Error('campaign is required');
  const status = campaign.status;
  if (command === 'pause') return Object.freeze({ apply: status === 'running', nextStatus: 'paused' });
  if (command === 'resume') return Object.freeze({ apply: ['paused', 'stopped'].includes(status), nextStatus: 'running' });
  if (command === 'cancel') return Object.freeze({ apply: !TERMINAL.has(status), nextStatus: 'cancelled' });
  if (command === 'fail') return Object.freeze({ apply: !TERMINAL.has(status), nextStatus: 'failed' });
  if (command === 'stop') return Object.freeze({ apply: !CAMPAIGN_SETTLED_STATUSES.includes(status), nextStatus: 'stopped' });
  throw new Error(`unknown campaign command: ${command}`);
}

export function decideManualNodeRetry(node) {
  if (!node) throw new Error('campaign node is required');
  return Object.freeze({ apply: node.status === 'failed_terminal', nextStatus: 'queued' });
}
