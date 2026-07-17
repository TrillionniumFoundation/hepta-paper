const CAMPAIGN_AGENT_NODE_KINDS = Object.freeze(new Set([
  'research-plan',
  'writer',
  'theorem-spec',
  'formal-author',
  'formal-review',
  'manuscript-integrate',
  'revise',
]));

export function isCampaignRefereeNode(kind) {
  return /^(?:revision-)?referee-\d+$/.test(String(kind || ''));
}

export function isCampaignAgentNode(kind) {
  return CAMPAIGN_AGENT_NODE_KINDS.has(kind)
    || /^coder(?:-|$)/.test(String(kind || ''))
    || isCampaignRefereeNode(kind);
}

export function campaignEmpiricalNodeClassification(kind) {
  const normalized = String(kind || '');
  const primary = /^empirical(?:$|-(?!reproduce(?:-|$)))/.test(normalized);
  const reproduce = /^empirical-reproduce(?:-|$)/.test(normalized);
  const revalidateCode = /^revalidate-code(?:-|$)/.test(normalized);
  const revalidateReplay = /^revalidate-empirical-reproduce(?:-|$)/.test(normalized);
  const revalidate = /^revalidate-empirical(?:$|-(?!reproduce(?:-|$)))/.test(normalized);
  const reproduction = reproduce || revalidateReplay;
  const compile = ['compile', 'final-compile', 'revalidate-compile'].includes(normalized);
  return Object.freeze({
    primary,
    reproduce,
    revalidateCode,
    revalidateReplay,
    revalidate,
    reproduction,
    compile,
    empirical: primary || reproduction || revalidateCode || revalidate || compile,
  });
}

export function campaignNodeOperation(kind) {
  if (kind === 'formal-verify') return 'formal-verification';
  if (kind === 'research-verify') return 'research-verification';
  if (isCampaignAgentNode(kind)) return 'agent';
  if (kind === 'convergence') return 'convergence';
  if (['revalidate-citations', 'revalidate-artifacts'].includes(kind)) return 'quality-revalidation';
  if (kind === 'package') return 'package';
  if (campaignEmpiricalNodeClassification(kind).empirical) return 'empirical';
  return 'noop';
}
