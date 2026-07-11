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
  datasetMounts = [],
  minimumRevisionRounds = 1,
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
    const verifyCitations = node(id, 'revalidate-citations', [revise.nodeId], { roundIndex, priority: 80, language: 'latex' });
    const verifyArtifacts = node(id, 'revalidate-artifacts', [revise.nodeId], { roundIndex, priority: 80 });
    const revisionRefereeNodes = Array.from({ length: reviewers }, (_, index) => node(
      id,
      `revision-referee-${index + 1}`,
      [verifyCode.nodeId, verifyEmpirical.nodeId, verifyCompile.nodeId, verifyCitations.nodeId, verifyArtifacts.nodeId],
      { roundIndex, priority: 85, role: `revision-referee-${index + 1}` },
    ));
    const convergence = node(id, 'convergence', [
      ...revisionRefereeNodes.map((item) => item.nodeId),
    ], { roundIndex, priority: 90 });
    nodes.push(...refereeNodes, revise, verifyCode, verifyEmpirical, verifyCompile, verifyCitations, verifyArtifacts, ...revisionRefereeNodes, convergence);
    previous = convergence.nodeId;
  }
  const packageNode = node(id, 'package', [previous], { roundIndex: rounds + 1, priority: 100, language: 'latex' });
  nodes.push(packageNode);
  const payload = {
    version: 2,
    kind: 'PaperCampaignPlan',
    campaignId: id,
    paperId,
    sourceWorkspace,
    maxRounds: rounds,
    refereeCount: reviewers,
    languages: [...new Set(languages.map(String))],
    requiresGpu: Boolean(requiresGpu),
    convergenceThresholds: { minimumRoundIndex: Math.max(1, Math.min(rounds, Number(minimumRevisionRounds || 1))) },
    datasetMounts: datasetMounts.map((mount) => Object.freeze({
      name: String(mount.name || 'dataset'),
      source: String(mount.source || ''),
      readOnly: true,
      manifestHash: mount.manifestHash || null,
    })),
    budgets: {
      maxWallTimeMs: Number(budgets.maxWallTimeMs ?? 6 * 60 * 60 * 1000),
      maxAgentCalls: Number(budgets.maxAgentCalls ?? 30),
      maxCpuJobs: Number(budgets.maxCpuJobs ?? 32),
      maxGpuJobs: Number(budgets.maxGpuJobs ?? 8),
      maxTokenCount: Number(budgets.maxTokenCount ?? 500000),
      maxCostUsd: Number(budgets.maxCostUsd ?? 100),
      maxMemoryMiB: Number(budgets.maxMemoryMiB ?? 8192),
    },
    nodes,
    externalSubmissionEnabled: false,
  };
  return Object.freeze({ ...payload, campaignPlanHash: hashRecord('PaperCampaignPlan', payload) });
}
