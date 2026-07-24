#!/usr/bin/env node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createDefaultPaperStore, createSqliteCampaignStore } from '../../paper-composition/bootstrap/operator-persistence-composition.mjs';
import { createIsolatedAgentExecutor, createOllamaStructuredAgentExecutor } from '../../paper-composition/bootstrap/operator-automation-composition.mjs';
import { createCampaignNodeExecutor } from '../../paper-composition/automation/campaign-node-execution-composition.mjs';
import { composeCampaignWorkerEmpiricalExecution } from '../../paper-composition/automation/campaign-worker-empirical-composition.mjs';
import { createSystemScheduler, createRandomIdGenerator } from '../../paper-composition/bootstrap/operator-runtime-composition.mjs';
import { buildPaperCampaignPlan } from '../../paper-domain/automation/campaign-plan.mjs';
import { runPaperCampaign } from '../../paper-application/automation/campaign-engine.mjs';

const model = process.env.HEPTA_AGENT_MODEL;
const maximumOutputTokens = Number(process.env.HEPTA_AGENT_MAX_OUTPUT_TOKENS || 8192);
const maximumRounds = Number(process.env.HEPTA_SMOKE_MAX_ROUNDS || 1);
if (!model) throw new Error('HEPTA_AGENT_MODEL is required');
if (!Number.isSafeInteger(maximumOutputTokens) || maximumOutputTokens < 8192) {
  throw new Error('HEPTA_AGENT_MAX_OUTPUT_TOKENS must be an integer of at least 8192');
}
if (!Number.isSafeInteger(maximumRounds) || maximumRounds < 1 || maximumRounds > 10) {
  throw new Error('HEPTA_SMOKE_MAX_ROUNDS must be an integer from 1 through 10');
}
const resumeRoot = process.env.HEPTA_SMOKE_RESUME_ROOT ? path.resolve(process.env.HEPTA_SMOKE_RESUME_ROOT) : null;
const root = resumeRoot || fs.mkdtempSync(path.join(os.tmpdir(), 'hepta-real-campaign-smoke-'));
let removeWorkspace = false;
const runtimeRoot = path.join(root, 'runtime');
const paperRoot = path.join(root, 'paper');
if (!resumeRoot) {
  fs.mkdirSync(paperRoot, { recursive: true });
  fs.writeFileSync(path.join(paperRoot, 'main.tex'), '\\documentclass{article}\n\\title{Automation Smoke Study}\n\\begin{document}\n\\maketitle\n\\section{Introduction}\nWe test an automated research campaign.\n\\end{document}\n');
}
try {
  const store = createDefaultPaperStore({ root, runtimeRoot });
  const clock = { now: () => new Date(), nowIso: () => new Date().toISOString() };
  const campaignRuntime = { clock, scheduler: createSystemScheduler(), idGenerator: createRandomIdGenerator() };
  const campaignStore = createSqliteCampaignStore({ store, clock });
  const existingId = resumeRoot ? store.query('SELECT campaign_id FROM paper_campaigns ORDER BY created_at LIMIT 1;').rows[0]?.campaign_id : null;
  const plan = existingId
    ? campaignStore.getCampaign(existingId).spec
    : buildPaperCampaignPlan({ paperId: 'automation-smoke-paper', sourceWorkspace: paperRoot, campaignId: `automation-smoke-${Date.now()}`, maxRounds: maximumRounds, refereeCount: 3 });
  const campaignId = existingId || plan.campaignId;
  if (!existingId) campaignStore.createCampaign(plan);
  const { empiricalExecutor } = composeCampaignWorkerEmpiricalExecution({
    plans: [plan],
    runtimeRoot,
  });
  const createLocalAgentExecutor = (principal) => createIsolatedAgentExecutor({
    delegate: createOllamaStructuredAgentExecutor({
      model,
      maximumOutputTokens,
      timeoutMs: 20 * 60 * 1000,
    }),
    isolationRoot: path.join(runtimeRoot, 'automation-workspaces', principal),
    keepWorkspaces: false,
    keepFailedWorkspaces: true,
  });
  const executor = createCampaignNodeExecutor({
    agentExecutor: createLocalAgentExecutor('author'),
    formalReviewAgentExecutor: createLocalAgentExecutor('reviewer'),
    empiricalExecutor,
    runtimeRoot,
  });
  let lastProgress = '';
  const progressTimer = setInterval(() => {
    const nodes = campaignStore.listNodes(campaignId);
    const progress = nodes.filter((node) => node.status !== 'queued').map((node) => `${node.kind}:${node.status}:${node.attemptCount}`).join(',');
    if (progress !== lastProgress) {
      process.stderr.write(`[automation-smoke] ${progress}\n`);
      lastProgress = progress;
    }
  }, 1000);
  progressTimer.unref();
  let result;
  try {
    result = await runPaperCampaign({ campaignId, campaignStore, executor, concurrency: 4, pollMs: 10, ...campaignRuntime });
  } finally {
    clearInterval(progressTimer);
  }
  const report = {
    status: result.campaign.status === 'completed' ? 'real_automation_campaign_smoke_passed' : 'real_automation_campaign_smoke_failed',
    campaignStatus: result.campaign.status,
    nodeCount: result.nodes.length,
    completed: result.nodes.filter((node) => node.status === 'completed').length,
    skipped: result.nodes.filter((node) => node.status === 'skipped').length,
    failed: result.nodes.filter((node) => node.status === 'failed_terminal').length,
    retries: result.retryCount,
    configuredMaximumRounds: maximumRounds,
    maximumObservedConcurrency: result.maximumObservedConcurrency,
    finalManuscriptPresent: fs.existsSync(path.join(paperRoot, 'main.tex')),
    externalActionPerformed: false,
    nodes: result.nodes.map((node) => ({ kind: node.kind, roundIndex: node.roundIndex, status: node.status, attemptCount: node.attemptCount, failureClass: node.failureClass })),
  };
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  removeWorkspace = report.status === 'real_automation_campaign_smoke_passed';
  if (!removeWorkspace) {
    process.stderr.write(`[automation-smoke] failure workspace preserved at ${root}\n`);
    process.exitCode = 1;
  }
} finally {
  if (removeWorkspace) fs.rmSync(root, { recursive: true, force: true });
}
