#!/usr/bin/env node
import fs from 'node:fs';
import crypto from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createDefaultPaperStore, createSqliteCampaignStore } from '../../paper-composition/bootstrap/operator-persistence-composition.mjs';
import {
  createOpenClawAgentExecutor,
  createOllamaStructuredAgentExecutor,
  createAgentBackendRouter,
  createIsolatedAgentExecutor,
  createMultiLanguageEmpiricalExecutor,
  createFilesystemEmpiricalCacheRepository,
  runtimeImagesForCampaign,
} from '../../paper-composition/bootstrap/operator-automation-composition.mjs';
import { createCampaignNodeExecutor } from '../../paper-composition/automation/campaign-node-execution-composition.mjs';
import { createOsSandboxedWorkerRunner, createSystemScheduler, createRandomIdGenerator } from '../../paper-composition/bootstrap/operator-runtime-composition.mjs';
import { runPaperCampaign } from '../../paper-application/automation/campaign-engine.mjs';
import { createResourceGovernor } from '../../paper-application/automation/resource-governor.mjs';
import { buildPaperCampaignPlan } from '../../paper-domain/automation/campaign-plan.mjs';
import { sha256FileSync } from '../../workflow-kernel/runtime/file-utils.mjs';

const sourceRoot = path.resolve(process.env.HEPTA_STRICT_REREVIEW_SOURCE || '/data/home-data/hepta-paper-assets/drafts/DQL_Stochastic_Optimization');
const paperId = process.env.HEPTA_STRICT_REREVIEW_PAPER_ID || path.basename(sourceRoot);
if (!fs.existsSync(path.join(sourceRoot, 'main.tex'))) throw new Error(`real paper source missing: ${sourceRoot}`);
const ignoredTopLevel = new Set(['.git', 'packages', 'runtime', '.artifact-cas']);
const ignoredGenerated = /\.(?:aux|fdb_latexmk|fls|log|out|pdf|synctex\.gz)$/i;
function includeLiveSource(candidate) {
  const relative = path.relative(sourceRoot, candidate).replace(/\\/g, '/');
  if (!relative) return true;
  if (ignoredTopLevel.has(relative.split('/')[0])) return false;
  return !ignoredGenerated.test(relative);
}
function liveSourceHash() {
  const rows = [];
  const walk = (current) => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true }).sort((left, right) => left.name.localeCompare(right.name))) {
      const candidate = path.join(current, entry.name);
      if (!includeLiveSource(candidate)) continue;
      const relative = path.relative(sourceRoot, candidate).replace(/\\/g, '/');
      if (entry.isDirectory()) walk(candidate);
      else if (entry.isFile()) rows.push(`${relative}\0${sha256FileSync(candidate, { prefix: false })}`);
    }
  };
  walk(sourceRoot);
  return `sha256:${crypto.createHash('sha256').update(rows.join('\n')).digest('hex')}`;
}
const requestedResumeRoot = process.env.HEPTA_STRICT_REREVIEW_RESUME_ROOT
  ? path.resolve(process.env.HEPTA_STRICT_REREVIEW_RESUME_ROOT)
  : null;
const root = requestedResumeRoot || fs.mkdtempSync(path.join(os.tmpdir(), 'hepta-strict-rereview-'));
const workspace = path.join(root, 'paper');
const runtimeRoot = path.join(root, 'runtime');
const resuming = Boolean(requestedResumeRoot);
let remove = false;
try {
  const sourceHashBefore = liveSourceHash();
  if (resuming) {
    if (!fs.existsSync(path.join(workspace, 'main.tex')) || !fs.existsSync(path.join(runtimeRoot, 'hepta-paper.sqlite'))) throw new Error(`resumable strict workspace is incomplete: ${root}`);
  } else {
    fs.cpSync(sourceRoot, workspace, { recursive: true, dereference: false, filter: includeLiveSource });
  }
  const store = createDefaultPaperStore({ root, runtimeRoot });
  const clock = { now: () => new Date(), nowIso: () => new Date().toISOString() };
  const campaignRuntime = { clock, scheduler: createSystemScheduler(), idGenerator: createRandomIdGenerator() };
  const campaignStore = createSqliteCampaignStore({ store, clock });
  let campaignId;
  if (resuming) {
    const existing = campaignStore.listCampaigns({ limit: 2 });
    if (existing.length !== 1) throw new Error(`strict resume requires exactly one campaign, found ${existing.length}`);
    campaignId = existing[0].campaignId;
    const failed = campaignStore.listNodes(campaignId).filter((node) => node.status === 'failed_terminal');
    if (!failed.length) throw new Error('strict resume requires at least one failed terminal node');
    failed.forEach((node) => campaignStore.retryNode(node.nodeId));
    campaignStore.pauseCampaign(campaignId, 'strict_acceptance_resume_checkpoint');
    campaignStore.resumeCampaign(campaignId);
  } else {
    campaignId = `strict-rereview-${paperId}-${Date.now()}`;
    const plan = buildPaperCampaignPlan({
      paperId,
      sourceWorkspace: workspace,
      campaignId,
      mode: 'local-review-loop',
      maxRounds: 3,
      minimumRevisionRounds: 2,
      refereeCount: 3,
      languages: ['python', 'latex'],
      budgets: { maxWallTimeMs: 6 * 60 * 60 * 1000, maxAgentCalls: 30, maxCpuJobs: 32, maxGpuJobs: 1, maxTokenCount: 1500000, maxMemoryMiB: 8192 },
    });
    campaignStore.createCampaign(plan);
  }
  const runtimeImages = runtimeImagesForCampaign({ gpu: false });
  const runner = createOsSandboxedWorkerRunner({
    allowedExecutables: ['python3', 'latexmk'],
    allowedRoots: [workspace],
    allowedOutputRoots: [path.join(runtimeRoot, 'automation-artifacts')],
    allowedContainerImages: Object.values(runtimeImages).map((item) => item.image),
    maximumTimeoutMs: 30 * 60 * 1000,
    maximumMemoryBytes: 4 * 1024 * 1024 * 1024,
    maximumCpuSeconds: 1800,
  });
  const primary = createOpenClawAgentExecutor({
    agentId: process.env.HEPTA_OPENCLAW_AGENT || 'hepta-paper-worker',
    model: process.env.HEPTA_OPENCLAW_MODEL || undefined,
    thinking: process.env.HEPTA_OPENCLAW_THINKING || 'high',
    timeoutMs: 30 * 60 * 1000,
  });
  let ollamaModel = process.env.HEPTA_AGENT_MODEL || null;
  if (!ollamaModel) {
    const tags = spawnSync('ollama', ['list'], { encoding: 'utf8', timeout: 5000 });
    ollamaModel = String(tags.stdout || '').split(/\n/).slice(1).map((line) => line.trim().split(/\s+/)[0]).find((name) => name && !/embed/i.test(name)) || null;
  }
  const router = createAgentBackendRouter({ primary, fallbacks: ollamaModel ? [createOllamaStructuredAgentExecutor({ model: ollamaModel })] : [], cooldownMs: 5 * 60 * 1000 });
  const agentExecutor = createIsolatedAgentExecutor({ delegate: router, isolationRoot: path.join(runtimeRoot, 'automation-workspaces'), keepWorkspaces: false, keepFailedWorkspaces: true });
  const empiricalExecutor = createMultiLanguageEmpiricalExecutor({ workerRunner: runner, runtimeImages, cache: createFilesystemEmpiricalCacheRepository({ root: path.join(runtimeRoot, 'automation-cache', 'empirical') }) });
  const executor = createCampaignNodeExecutor({ agentExecutor, empiricalExecutor, runtimeRoot });
  const governor = createResourceGovernor({ agent: 3, cpu: 2, gpu: 1, memoryMiB: 8192 });
  const result = await runPaperCampaign({ campaignId, campaignStore, executor, concurrency: 8, resourceGovernor: governor, pollMs: 50, ...campaignRuntime });
  const convergence = result.nodes.filter((node) => node.kind === 'convergence' && node.status === 'completed').sort((left, right) => left.roundIndex - right.roundIndex);
  const initialReviews = result.nodes.filter((node) => /^referee-\d+$/.test(node.kind) && node.status === 'completed');
  const revisedReviews = result.nodes.filter((node) => /^revision-referee-\d+$/.test(node.kind) && node.status === 'completed');
  const reviseNodes = result.nodes.filter((node) => node.kind === 'revise' && node.status === 'completed');
  const revisedHashesByRound = Object.fromEntries(convergence.map(({ roundIndex }) => [roundIndex, [...new Set(revisedReviews.filter((node) => node.roundIndex === roundIndex).map((node) => node.result?.manuscriptHash).filter(Boolean))]]));
  const criticalFindingCount = initialReviews.reduce((sum, node) => sum + Number(node.result?.criticalFindingCount || 0), 0);
  const sourceAssetsMutated = liveSourceHash() !== sourceHashBefore;
  const passed = result.campaign.status === 'completed'
    && convergence.length >= 2
    && convergence.slice(0, -1).every((node) => node.result?.accepted === false)
    && convergence.at(-1)?.result?.accepted === true
    && criticalFindingCount > 0
    && reviseNodes.length === convergence.length
    && revisedReviews.length === convergence.length * 3
    && Object.values(revisedHashesByRound).every((hashes) => hashes.length === 1)
    && !sourceAssetsMutated;
  const report = {
    status: passed ? 'strict_rereview_smoke_passed' : 'strict_rereview_smoke_failed',
    passed,
    paperId,
    campaignId,
    campaignStatus: result.campaign.status,
    stopReason: result.campaign.stopReason,
    completedNodes: result.nodes.filter((node) => node.status === 'completed').length,
    criticalFindingCount,
    revisionRoundCount: reviseNodes.length,
    revisedReviewCount: revisedReviews.length,
    revisedHashesByRound,
    convergence: convergence.map((node) => ({ roundIndex: node.roundIndex, accepted: node.result?.accepted, meanScore: node.result?.meanScore, criticalFindingCount: node.result?.criticalFindingCount, manuscriptHashBound: node.result?.manuscriptHashBound })),
    resourceUsage: governor.snapshot(),
    sourceAssetsMutated,
    externalActionPerformed: false,
  };
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  remove = passed;
  if (!passed) {
    process.stderr.write(`[strict-rereview] failure workspace preserved at ${root}\n`);
    process.exitCode = 1;
  }
} finally {
  if (remove) fs.rmSync(root, { recursive: true, force: true });
}
