#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { createSqliteCampaignStore } from '../../paper-adapters/persistence/sqlite-campaign-store.mjs';
import { createCodexAgentExecutor } from '../../paper-adapters/automation/codex-agent-executor.mjs';
import { createOllamaStructuredAgentExecutor } from '../../paper-adapters/automation/ollama-structured-agent-executor.mjs';
import { createCampaignNodeExecutor } from '../../paper-adapters/automation/campaign-node-executor.mjs';
import { createMultiLanguageEmpiricalExecutor } from '../../paper-adapters/automation/multi-language-empirical-executor.mjs';
import { createOsSandboxedWorkerRunner } from '../../paper-adapters/runtime/os-sandboxed-worker-runner.mjs';
import { bootstrapPaperExecutionContext } from '../../paper-application/bootstrap/service-bootstrap.mjs';
import { runPaperCampaign } from '../../paper-application/automation/campaign-engine.mjs';
import { buildPaperCampaignPlan } from '../../paper-domain/automation/campaign-plan.mjs';
import { discoverInventory } from '../../paper-adapters/inventory/index.mjs';
import { defaultPaperAssetRoot, defaultPaperRuntimeRoot } from '../src/workspace-layout.mjs';

function args(argv) {
  const out = { paper: [] };
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === '--execute' || token === '--json' || token === '--help' || token === '--gpu') out[token.slice(2)] = true;
    else if (token.startsWith('--')) {
      const key = token.slice(2);
      const value = argv[++index];
      if (key === 'paper') out.paper.push(value); else out[key] = value;
    }
  }
  return out;
}

async function main() {
  const options = args(process.argv.slice(2));
  if (options.help) {
    process.stdout.write([
      'Usage: npm run paper:campaign -- [options]',
      '',
      '  --paper <id>              select a paper; repeat for several papers',
      '  --execute                 persist and execute campaigns (default is plan-only)',
      '  --agent-provider ollama   use a local structured Ollama model',
      '  --model <name>            agent model name',
      '  --concurrency <n>         total dependency-ready node concurrency (default 8)',
      '  --rounds <n>              maximum referee/revise rounds (default 3)',
      '  --referees <n>            independent referees per round (default 3)',
      '  --languages <csv>         empirical languages (default python,latex)',
      '  --gpu                     allow and require GPU access for empirical nodes',
      '  --root <path>             paper asset root',
      '  --runtime-root <path>     runtime and campaign store root',
      '',
    ].join('\n'));
    return;
  }
  const root = path.resolve(options.root || defaultPaperAssetRoot());
  const runtimeRoot = path.resolve(options['runtime-root'] || defaultPaperRuntimeRoot());
  const context = bootstrapPaperExecutionContext({ root, runtimeRoot, mode: 'paper-campaign', execute: Boolean(options.execute) });
  const inventory = await discoverInventory({ root, store: context.services.store, paperIds: options.paper, inventorySource: 'auto', proposalStagingRoot: path.join(runtimeRoot, 'proposal-staging') });
  const plans = inventory.rows.map((row) => {
    const mainTex = path.resolve(root, row.task.mainTex || '');
    const sourceWorkspace = fs.existsSync(mainTex) ? path.dirname(mainTex) : path.resolve(root, row.task.sourceWorkspace || '.');
    return buildPaperCampaignPlan({
      paperId: row.task.paperId,
      sourceWorkspace,
      maxRounds: Number(options.rounds || 3),
      refereeCount: Number(options.referees || 3),
      languages: String(options.languages || 'python,latex').split(',').filter(Boolean),
      requiresGpu: Boolean(options.gpu),
      campaignId: options.paper.length === 1 && options['campaign-id'] ? options['campaign-id'] : null,
    });
  });
  if (!options.execute) {
    process.stdout.write(`${JSON.stringify({ status: 'paper_campaigns_planned', execute: false, plans }, null, 2)}\n`);
    return;
  }
  const campaignStore = createSqliteCampaignStore({ store: context.services.store, clock: context.services.clock });
  const executables = ['python3', process.execPath, 'Rscript', 'julia', 'lake', 'latexmk'];
  const workerRunner = createOsSandboxedWorkerRunner({ allowedExecutables: executables, allowedRoots: plans.map((plan) => plan.sourceWorkspace), allowedOutputRoots: [path.join(runtimeRoot, 'automation-artifacts')], allowGpu: Boolean(options.gpu) });
  const empiricalExecutor = createMultiLanguageEmpiricalExecutor({ workerRunner });
  const localProvider = options['agent-provider'] || null;
  const agentExecutor = localProvider === 'ollama'
    ? createOllamaStructuredAgentExecutor({ model: options.model })
    : createCodexAgentExecutor({ model: options.model || null });
  const nodeExecutor = createCampaignNodeExecutor({ agentExecutor, empiricalExecutor, runtimeRoot });
  for (const plan of plans) campaignStore.createCampaign(plan);
  const totalConcurrency = Math.max(1, Number(options.concurrency || 8));
  const perCampaign = Math.max(1, Math.floor(totalConcurrency / Math.max(1, plans.length)));
  const results = await Promise.all(plans.map((plan) => runPaperCampaign({ campaignId: plan.campaignId, campaignStore, executor: nodeExecutor, concurrency: perCampaign })));
  process.stdout.write(`${JSON.stringify({ status: 'paper_campaigns_completed', execute: true, campaignCount: results.length, results }, null, 2)}\n`);
}

main().catch((error) => { process.stderr.write(`${error?.stack || error}\n`); process.exitCode = 1; });
