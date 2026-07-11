import { hashRecord } from '../../workflow-kernel/record-hash.mjs';

function node(campaignId, kind, dependencies = [], options = {}) {
  const roundIndex = Number(options.roundIndex || 0);
  return Object.freeze({
    nodeId: `${campaignId}:${roundIndex}:${kind}`,
    kind,
    roundIndex,
    dependencies,
    priority: Number(options.priority || 100),
    maxAttempts: Number(options.maxAttempts || 3),
    role: options.role || null,
    language: options.language || null,
  });
}

export function buildPaperCampaignPlan({
  paperId,
  sourceWorkspace,
  maxRounds = 3,
  refereeCount = 3,
  languages = ['python', 'latex'],
  campaignId = null,
  requiresGpu = false,
  budgets = {},
} = {}) {
  if (!paperId || !sourceWorkspace) throw new Error('paperId and sourceWorkspace are required');
  const rounds = Math.max(1, Math.min(10, Number(maxRounds) || 3));
  const reviewers = Math.max(2, Math.min(7, Number(refereeCount) || 3));
  const id = campaignId || `paper-campaign:${paperId}`;
  const nodes = [];
  const research = node(id, 'research-plan', [], { priority: 10 });
  const writer = node(id, 'writer', [research.nodeId], { priority: 20, role: 'writer' });
  const coder = node(id, 'coder', [research.nodeId], { priority: 20, role: 'coder' });
  const empirical = node(id, 'empirical', [coder.nodeId], { priority: 30, language: languages[0] || 'python' });
  const integrate = node(id, 'manuscript-integrate', [writer.nodeId, empirical.nodeId], { priority: 40, role: 'writer' });
  const initialCompile = node(id, 'compile', [integrate.nodeId], { priority: 50, language: 'latex' });
  nodes.push(research, writer, coder, empirical, integrate, initialCompile);
  let previous = initialCompile.nodeId;
  for (let roundIndex = 1; roundIndex <= rounds; roundIndex += 1) {
    const refereeNodes = Array.from({ length: reviewers }, (_, index) => node(
      id,
      `referee-${index + 1}`,
      [previous],
      { roundIndex, priority: 60, role: `referee-${index + 1}` },
    ));
    const revise = node(id, 'revise', refereeNodes.map((item) => item.nodeId), { roundIndex, priority: 70, role: 'reviser' });
    const verifyCode = node(id, 'revalidate-code', [revise.nodeId], { roundIndex, priority: 80, language: languages[0] || 'python' });
    const verifyEmpirical = node(id, 'revalidate-empirical', [revise.nodeId], { roundIndex, priority: 80, language: languages[0] || 'python' });
    const verifyCompile = node(id, 'revalidate-compile', [revise.nodeId], { roundIndex, priority: 80, language: 'latex' });
    const convergence = node(id, 'convergence', [
      ...refereeNodes.map((item) => item.nodeId),
      verifyCode.nodeId,
      verifyEmpirical.nodeId,
      verifyCompile.nodeId,
    ], { roundIndex, priority: 90 });
    nodes.push(...refereeNodes, revise, verifyCode, verifyEmpirical, verifyCompile, convergence);
    previous = convergence.nodeId;
  }
  const packageNode = node(id, 'package', [previous], { roundIndex: rounds + 1, priority: 100, language: 'latex' });
  nodes.push(packageNode);
  const payload = {
    version: 1,
    kind: 'PaperCampaignPlan',
    campaignId: id,
    paperId,
    sourceWorkspace,
    maxRounds: rounds,
    refereeCount: reviewers,
    languages: [...new Set(languages.map(String))],
    requiresGpu: Boolean(requiresGpu),
    budgets: {
      maxWallTimeMs: Number(budgets.maxWallTimeMs || 6 * 60 * 60 * 1000),
      maxAgentCalls: Number(budgets.maxAgentCalls || 30),
      maxCpuJobs: Number(budgets.maxCpuJobs || 8),
      maxGpuJobs: Number(budgets.maxGpuJobs || 1),
    },
    nodes,
    externalSubmissionEnabled: false,
  };
  return Object.freeze({ ...payload, campaignPlanHash: hashRecord('PaperCampaignPlan', payload) });
}
