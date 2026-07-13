import { hashRecord } from '../../workflow-kernel/record-hash.mjs';
import { normalizeDatasetMounts } from './empirical-contract.mjs';

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
    requiresGpu: Boolean(options.requiresGpu),
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
  parentCampaignId = null,
  supersedesCampaignId = null,
  recoveryOfCampaignId = null,
  metricSchema = {},
  paperQualityProfile = null,
} = {}) {
  if (!paperId || !sourceWorkspace) throw new Error('paperId and sourceWorkspace are required');
  const rounds = Math.max(1, Math.min(10, Number(maxRounds) || 3));
  const reviewers = Math.max(2, Math.min(7, Number(refereeCount) || 3));
  const id = campaignId || `paper-campaign:${paperId}`;
  const inferredRecovery = id.includes(':recovery-') ? id.slice(0, id.indexOf(':recovery-')) : null;
  const normalizedLanguages = [...new Set(languages.map((language) => String(language).trim().toLowerCase()).filter(Boolean))];
  const empiricalLanguages = normalizedLanguages.filter((language) => language !== 'latex');
  const executionProfiles = empiricalLanguages.map((label) => Object.freeze({
    label,
    language: label === 'gpu' ? 'python' : label,
    requiresGpu: label === 'gpu' || (Boolean(requiresGpu) && label === 'python'),
  }));
  const singleEmpirical = executionProfiles.length === 1;
  const nodes = [];
  const research = node(id, 'research-plan', [], { priority: 10 });
  const writer = node(id, 'writer', [research.nodeId], { priority: 20, role: 'writer' });
  const empiricalChains = executionProfiles.map((profile) => {
    const suffix = singleEmpirical ? '' : `-${profile.label}`;
    const coder = node(id, `coder${suffix}`, [research.nodeId], { priority: 20, role: `coder-${profile.label}`, language: profile.language, requiresGpu: profile.requiresGpu });
    const empirical = node(id, `empirical${suffix}`, [coder.nodeId], { priority: 30, language: profile.language, requiresGpu: profile.requiresGpu });
    const reproduce = node(id, `empirical-reproduce${suffix}`, [empirical.nodeId], { priority: 35, language: profile.language, requiresGpu: profile.requiresGpu });
    return { profile, coder, empirical, reproduce };
  });
  const integrate = node(id, 'manuscript-integrate', [writer.nodeId, ...empiricalChains.map((chain) => chain.reproduce.nodeId)], { priority: 40, role: 'writer' });
  const initialCompile = node(id, 'compile', [integrate.nodeId], { priority: 50, language: 'latex' });
  nodes.push(research, writer, ...empiricalChains.flatMap((chain) => [chain.coder, chain.empirical, chain.reproduce]), integrate, initialCompile);
  let previous = initialCompile.nodeId;
  for (let roundIndex = 1; roundIndex <= rounds; roundIndex += 1) {
    const refereeNodes = Array.from({ length: reviewers }, (_, index) => node(
      id,
      `referee-${index + 1}`,
      [previous],
      { roundIndex, priority: 60, role: `referee-${index + 1}` },
    ));
    const revise = node(id, 'revise', refereeNodes.map((item) => item.nodeId), { roundIndex, priority: 70, role: 'reviser' });
    const languageRevalidation = executionProfiles.flatMap((profile) => {
      const suffix = singleEmpirical ? '' : `-${profile.label}`;
      const code = node(id, `revalidate-code${suffix}`, [revise.nodeId], { roundIndex, priority: 80, language: profile.language, requiresGpu: profile.requiresGpu });
      const empirical = node(id, `revalidate-empirical${suffix}`, [code.nodeId], { roundIndex, priority: 81, language: profile.language, requiresGpu: profile.requiresGpu });
      return [code, empirical];
    });
    const verifyCompile = node(id, 'revalidate-compile', [revise.nodeId], { roundIndex, priority: 80, language: 'latex' });
    const verifyCitations = node(id, 'revalidate-citations', [revise.nodeId], { roundIndex, priority: 80, language: 'latex' });
    const verifyArtifacts = node(id, 'revalidate-artifacts', [revise.nodeId], { roundIndex, priority: 80 });
    const revisionRefereeNodes = Array.from({ length: reviewers }, (_, index) => node(
      id,
      `revision-referee-${index + 1}`,
      [...languageRevalidation.map((item) => item.nodeId), verifyCompile.nodeId, verifyCitations.nodeId, verifyArtifacts.nodeId],
      { roundIndex, priority: 85, role: `revision-referee-${index + 1}` },
    ));
    const convergence = node(id, 'convergence', [
      ...revisionRefereeNodes.map((item) => item.nodeId),
    ], { roundIndex, priority: 90 });
    nodes.push(...refereeNodes, revise, ...languageRevalidation, verifyCompile, verifyCitations, verifyArtifacts, ...revisionRefereeNodes, convergence);
    previous = convergence.nodeId;
  }
  const packageNode = node(id, 'package', [previous], { roundIndex: rounds + 1, priority: 100, language: 'latex' });
  nodes.push(packageNode);
  const payload = {
    version: 2,
    kind: 'PaperCampaignPlan',
    campaignId: id,
    parentCampaignId: parentCampaignId || inferredRecovery,
    supersedesCampaignId: supersedesCampaignId || inferredRecovery,
    recoveryOfCampaignId: recoveryOfCampaignId || inferredRecovery,
    paperId,
    sourceWorkspace,
    maxRounds: rounds,
    refereeCount: reviewers,
    languages: normalizedLanguages,
    requiresGpu: Boolean(requiresGpu),
    paperQualityProfile,
    convergenceThresholds: { minimumRoundIndex: Math.max(1, Math.min(rounds, Number(minimumRevisionRounds || 1))) },
    datasetMounts: normalizeDatasetMounts(datasetMounts),
    metricSchema: {
      version: 1,
      minimumMetricCount: Math.max(1, Number(metricSchema.minimumMetricCount || 1)),
      absoluteTolerance: Math.max(0, Number(metricSchema.absoluteTolerance ?? 1e-9)),
      relativeTolerance: Math.max(0, Number(metricSchema.relativeTolerance ?? 1e-6)),
      metrics: Array.isArray(metricSchema.metrics) ? metricSchema.metrics.map((item) => ({ path: String(item.path) })) : [],
    },
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
