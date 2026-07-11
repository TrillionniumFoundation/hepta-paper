#!/usr/bin/env node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createDefaultPaperStore } from '../../paper-adapters/persistence/store-provider.mjs';
import { createSqliteCampaignStore } from '../../paper-adapters/persistence/sqlite-campaign-store.mjs';
import { createOllamaStructuredAgentExecutor } from '../../paper-adapters/automation/ollama-structured-agent-executor.mjs';
import { createCampaignNodeExecutor } from '../../paper-adapters/automation/campaign-node-executor.mjs';
import { createMultiLanguageEmpiricalExecutor } from '../../paper-adapters/automation/multi-language-empirical-executor.mjs';
import { createOsSandboxedWorkerRunner } from '../../paper-adapters/runtime/os-sandboxed-worker-runner.mjs';
import { buildPaperCampaignPlan } from '../../paper-domain/automation/campaign-plan.mjs';
import { runPaperCampaign } from '../../paper-application/automation/campaign-engine.mjs';

const model = process.env.HEPTA_AGENT_MODEL;
const maximumOutputTokens = Number(process.env.HEPTA_AGENT_MAX_OUTPUT_TOKENS || 1536);
if (!model) throw new Error('HEPTA_AGENT_MODEL is required');
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
  const campaignStore = createSqliteCampaignStore({ store, clock });
  const existingId = resumeRoot ? store.query('SELECT campaign_id FROM paper_campaigns ORDER BY created_at LIMIT 1;').rows[0]?.campaign_id : null;
  const plan = existingId
    ? campaignStore.getCampaign(existingId).spec
    : buildPaperCampaignPlan({ paperId: 'automation-smoke-paper', sourceWorkspace: paperRoot, campaignId: `automation-smoke-${Date.now()}`, maxRounds: 1, refereeCount: 3 });
  const campaignId = existingId || plan.campaignId;
  if (!existingId) campaignStore.createCampaign(plan);
  const workerRunner = createOsSandboxedWorkerRunner({ allowedExecutables: ['python3', 'latexmk'], allowedRoots: [paperRoot], allowedOutputRoots: [path.join(runtimeRoot, 'automation-artifacts')] });
  const executor = createCampaignNodeExecutor({
    agentExecutor: createOllamaStructuredAgentExecutor({ model, maximumOutputTokens, timeoutMs: 5 * 60 * 1000 }),
    empiricalExecutor: createMultiLanguageEmpiricalExecutor({ workerRunner }),
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
    result = await runPaperCampaign({ campaignId, campaignStore, executor, concurrency: 4, pollMs: 10 });
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
    maximumObservedConcurrency: result.maximumObservedConcurrency,
    finalManuscriptPresent: fs.existsSync(path.join(paperRoot, 'main.tex')),
    externalActionPerformed: false,
    nodes: result.nodes.map((node) => ({ kind: node.kind, roundIndex: node.roundIndex, status: node.status, attemptCount: node.attemptCount, failureClass: node.failure_class })),
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
