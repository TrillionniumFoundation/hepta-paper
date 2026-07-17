#!/usr/bin/env node
import fs from 'node:fs';
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
  AUTOMATION_RUNTIME_IMAGES,
} from '../../paper-composition/bootstrap/operator-automation-composition.mjs';
import { createCampaignNodeExecutor } from '../../paper-composition/automation/campaign-node-execution-composition.mjs';
import {
  createOsSandboxedWorkerRunner,
  directoryMerkleHash,
  createSystemScheduler,
  createRandomIdGenerator,
} from '../../paper-composition/bootstrap/operator-runtime-composition.mjs';
import { runPaperCampaign } from '../../paper-application/automation/campaign-engine.mjs';
import { createResourceGovernor } from '../../paper-application/automation/resource-governor.mjs';
import { buildPaperCampaignPlan } from '../../paper-domain/automation/campaign-plan.mjs';
import { hashRecord } from '../../workflow-kernel/record-hash.mjs';

function concurrencyAcceptancePlan(input) {
  const base = buildPaperCampaignPlan({ ...input, maxRounds: 1, refereeCount: 3 });
  const writerId = base.nodes.find((node) => node.kind === 'writer').nodeId;
  const coderId = base.nodes.find((node) => node.kind === 'coder').nodeId;
  const nodes = base.nodes.filter((node) => ['research-plan', 'writer', 'coder'].includes(node.kind) || /^referee-\d+$/.test(node.kind)).map((node) => (
    /^referee-\d+$/.test(node.kind) ? Object.freeze({ ...node, dependencies: [writerId, coderId] }) : node
  ));
  const { campaignPlanHash: _discarded, ...rest } = base;
  const payload = { ...rest, maxRounds: 1, nodes, acceptanceMode: 'openclaw_writer_coder_three_independent_referees' };
  return Object.freeze({ ...payload, campaignPlanHash: hashRecord('PaperCampaignPlan', payload) });
}

const sourceRoot = path.resolve(process.env.HEPTA_MULTIPAPER_SOURCE_ROOT || '/data/home-data/hepta-paper-assets/drafts');
const names = String(process.env.HEPTA_MULTIPAPER_NAMES || 'DQL_Replay_Convergence,DQL_Stochastic_Optimization,DQL_Exploration_Convergence').split(',').map((value) => value.trim()).filter(Boolean);
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hepta-openclaw-multipaper-'));
const papersRoot = path.join(root, 'papers');
const runtimeRoot = path.join(root, 'runtime');
let remove = false;
try {
  fs.mkdirSync(papersRoot, { recursive: true });
  const sourceHashesBefore = new Map(names.map((name) => [name, directoryMerkleHash(path.join(sourceRoot, name))]));
  const workspaces = names.map((name) => {
    const source = path.join(sourceRoot, name);
    const destination = path.join(papersRoot, name);
    if (!fs.existsSync(path.join(source, 'main.tex'))) throw new Error(`real paper source missing: ${source}`);
    fs.cpSync(source, destination, { recursive: true, dereference: false });
    return { paperId: name, workspace: destination };
  });
  const store = createDefaultPaperStore({ root, runtimeRoot });
  const clock = { now: () => new Date(), nowIso: () => new Date().toISOString() };
  const campaignRuntime = { clock, scheduler: createSystemScheduler(), idGenerator: createRandomIdGenerator() };
  const campaignStore = createSqliteCampaignStore({ store, clock });
  const plans = workspaces.map(({ paperId, workspace }) => concurrencyAcceptancePlan({
    paperId,
    sourceWorkspace: workspace,
    campaignId: `openclaw-live-${paperId}-${Date.now()}`,
    languages: ['python', 'latex'],
    budgets: { maxWallTimeMs: 3 * 60 * 60 * 1000, maxAgentCalls: 15, maxCpuJobs: 2, maxGpuJobs: 1 },
  }));
  plans.forEach((plan) => campaignStore.createCampaign(plan));
  const pythonImageReady = spawnSync('docker', ['image', 'inspect', AUTOMATION_RUNTIME_IMAGES.python.image], { encoding: 'utf8', timeout: 5000 }).status === 0;
  const runtimeImages = pythonImageReady ? { python: AUTOMATION_RUNTIME_IMAGES.python } : {};
  const workerRunner = createOsSandboxedWorkerRunner({
    allowedExecutables: ['python3', 'latexmk'],
    allowedRoots: workspaces.map((item) => item.workspace),
    allowedOutputRoots: [path.join(runtimeRoot, 'automation-artifacts')],
    allowedContainerImages: Object.values(runtimeImages).map((item) => item.image),
    maximumTimeoutMs: 30 * 60 * 1000,
    maximumMemoryBytes: 4 * 1024 * 1024 * 1024,
    maximumCpuSeconds: 1800,
  });
  const primary = createOpenClawAgentExecutor({ agentId: process.env.HEPTA_OPENCLAW_AGENT || 'hepta-paper-worker', model: process.env.HEPTA_OPENCLAW_MODEL || undefined, thinking: process.env.HEPTA_OPENCLAW_THINKING || 'high', timeoutMs: 30 * 60 * 1000 });
  let ollamaModel = process.env.HEPTA_AGENT_MODEL || null;
  if (!ollamaModel) {
    const tags = spawnSync('ollama', ['list'], { encoding: 'utf8', timeout: 5000 });
    ollamaModel = String(tags.stdout || '').split(/\n/).slice(1).map((line) => line.trim().split(/\s+/)[0]).find((name) => name && !/embed/i.test(name)) || null;
  }
  const router = createAgentBackendRouter({ primary, fallbacks: ollamaModel ? [createOllamaStructuredAgentExecutor({ model: ollamaModel })] : [], cooldownMs: 5 * 60 * 1000 });
  const agentExecutor = createIsolatedAgentExecutor({ delegate: router, isolationRoot: path.join(runtimeRoot, 'automation-workspaces'), keepWorkspaces: false, keepFailedWorkspaces: true });
  const executor = createCampaignNodeExecutor({ agentExecutor, empiricalExecutor: createMultiLanguageEmpiricalExecutor({ workerRunner, runtimeImages }), runtimeRoot });
  const governor = createResourceGovernor({ agent: 3, cpu: 2, gpu: 1, memoryMiB: 8192 });
  const results = await Promise.all(plans.map((plan) => runPaperCampaign({ campaignId: plan.campaignId, campaignStore, executor, concurrency: 8, resourceGovernor: governor, pollMs: 50, ...campaignRuntime })));
  const sourceAssetsMutated = names.some((name) => directoryMerkleHash(path.join(sourceRoot, name)) !== sourceHashesBefore.get(name));
  const resourceUsage = governor.snapshot();
  const requiredIndependentAgentKinds = ['writer', 'coder', 'referee-1', 'referee-2', 'referee-3'];
  const completedExactly = results.every((result) => result.campaign.status === 'completed'
    && result.nodes.length === 6
    && result.nodes.every((node) => node.status === 'completed')
    && requiredIndependentAgentKinds.every((kind) => {
      const node = result.nodes.find((item) => item.kind === kind);
      return Boolean(node?.result?.sessionKey || node?.result?.childSessionId);
    }));
  const resourceBounded = Object.keys(resourceUsage.limits).every((key) => resourceUsage.peak[key] <= resourceUsage.limits[key]);
  const passed = completedExactly && resourceBounded && !sourceAssetsMutated;
  const report = {
    status: passed ? 'openclaw_multipaper_smoke_completed' : 'openclaw_multipaper_smoke_failed',
    passed,
    campaignCount: results.length,
    resourceUsage,
    results: results.map((result) => ({ campaignId: result.campaign.campaignId, paperId: result.campaign.paperId, status: result.campaign.status, stopReason: result.campaign.stopReason, completed: result.nodes.filter((node) => node.status === 'completed').length, skipped: result.nodes.filter((node) => node.status === 'skipped').length, failed: result.nodes.filter((node) => node.status === 'failed_terminal').length, childSessions: result.nodes.map((node) => node.result?.sessionKey || node.result?.childSessionId).filter(Boolean), backends: Object.fromEntries([...new Set(result.nodes.map((node) => node.result?.selectedExecutorId).filter(Boolean))].map((backend) => [backend, result.nodes.filter((node) => node.result?.selectedExecutorId === backend).length])), tokenCount: result.campaign.tokenCount })),
    sourceAssetsMutated,
    externalActionPerformed: false,
  };
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  remove = passed;
  if (!remove) { process.stderr.write(`[openclaw-multipaper] failure workspace preserved at ${root}\n`); process.exitCode = 1; }
} finally {
  if (remove) fs.rmSync(root, { recursive: true, force: true });
}
