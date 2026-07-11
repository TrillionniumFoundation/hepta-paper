#!/usr/bin/env node
import fs from 'node:fs';
import crypto from 'node:crypto';
import path from 'node:path';
import { createSqliteCampaignStore } from '../../paper-adapters/persistence/sqlite-campaign-store.mjs';
import { createCodexAgentExecutor } from '../../paper-adapters/automation/codex-agent-executor.mjs';
import { createOllamaStructuredAgentExecutor } from '../../paper-adapters/automation/ollama-structured-agent-executor.mjs';
import { createOpenClawAgentExecutor } from '../../paper-adapters/automation/openclaw-agent-executor.mjs';
import { createAgentBackendRouter } from '../../paper-adapters/automation/agent-backend-router.mjs';
import { createIsolatedAgentExecutor } from '../../paper-adapters/automation/isolated-agent-executor.mjs';
import { createCampaignNodeExecutor } from '../../paper-adapters/automation/campaign-node-executor.mjs';
import { createMultiLanguageEmpiricalExecutor } from '../../paper-adapters/automation/multi-language-empirical-executor.mjs';
import { createFilesystemEmpiricalCacheRepository } from '../../paper-adapters/automation/empirical-cache-repository.mjs';
import { createOsSandboxedWorkerRunner, directoryMerkleHash } from '../../paper-adapters/runtime/os-sandboxed-worker-runner.mjs';
import { runtimeImagesForCampaign } from '../../paper-adapters/automation/runtime-image-registry.mjs';
import { bootstrapPaperExecutionContext } from '../../paper-application/bootstrap/service-bootstrap.mjs';
import { runPaperCampaign } from '../../paper-application/automation/campaign-engine.mjs';
import { createResourceGovernor } from '../../paper-application/automation/resource-governor.mjs';
import { buildPaperCampaignPlan } from '../../paper-domain/automation/campaign-plan.mjs';
import { discoverInventory } from '../../paper-adapters/inventory/index.mjs';
import { defaultPaperAssetRoot, defaultPaperRuntimeRoot } from '../src/workspace-layout.mjs';

function args(argv) {
  const out = { paper: [], dataset: [] };
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === '--execute' || token === '--json' || token === '--help' || token === '--gpu') out[token.slice(2)] = true;
    else if (token.startsWith('--')) {
      const key = token.slice(2);
      const value = argv[++index];
      if (key === 'paper') out.paper.push(value); else if (key === 'dataset') out.dataset.push(value); else out[key] = value;
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
      '  --agent-provider <name>   auto|openclaw|ollama|codex (default auto)',
      '  --openclaw-agent <id>     OpenClaw agent id (default hepta-paper-worker)',
      '  --model <name>            primary agent model override',
      '  --ollama-model <name>     local fallback model',
      '  --concurrency <n>         total dependency-ready node concurrency (default 8)',
      '  --agent-slots <n>         global OpenClaw/model slots (default 4)',
      '  --cpu-slots <n>           global empirical CPU slots (default 4)',
      '  --gpu-slots <n>           global GPU slots (default 1)',
      '  --memory-mib <n>          global campaign memory budget (default 8192)',
      '  --max-wall-ms <n>         per-campaign wall-time budget',
      '  --max-agent-calls <n>     per-campaign agent-call budget',
      '  --max-cpu-jobs <n>        per-campaign CPU-job budget',
      '  --max-gpu-jobs <n>        per-campaign GPU-job budget',
      '  --max-tokens <n>          per-campaign model-token budget',
      '  --max-cost-usd <n>        per-campaign model-cost budget',
      '  --action <name>           list|status|events|pause|resume|cancel|cancel-node|retry',
      '  --campaign-id <id>        campaign for an operational action',
      '  --run-id <id>             suffix new campaign ids so a paper can be rerun',
      '  --node-id <id>            failed node for retry',
      '  --rounds <n>              maximum referee/revise rounds (default 3)',
      '  --referees <n>            independent referees per round (default 3)',
      '  --minimum-revision-rounds <n>  require this many revise/re-review rounds before convergence',
      '  --languages <csv>         empirical languages (default python,latex)',
      '  --gpu                     allow and require GPU access for empirical nodes',
      '  --dataset <name=path>     add a read-only dataset mount; repeat as needed',
      '  --root <path>             paper asset root',
      '  --runtime-root <path>     runtime and campaign store root',
      '',
    ].join('\n'));
    return;
  }
  const root = path.resolve(options.root || defaultPaperAssetRoot());
  const runtimeRoot = path.resolve(options['runtime-root'] || defaultPaperRuntimeRoot());
  if (options['campaign-id'] && options['run-id']) throw new Error('--campaign-id and --run-id cannot be combined');
  const runId = options['run-id'] ? String(options['run-id']).replace(/[^A-Za-z0-9_.-]/g, '_') : null;
  if (options['run-id'] && !runId) throw new Error('--run-id must contain at least one safe character');
  const context = bootstrapPaperExecutionContext({ root, runtimeRoot, mode: 'paper-campaign', execute: Boolean(options.execute) });
  const campaignStore = createSqliteCampaignStore({ store: context.services.store, clock: context.services.clock });
  if (options.action) {
    const action = String(options.action);
    const campaignId = options['campaign-id'];
    let result;
    if (action === 'list') result = campaignStore.listCampaigns({ status: options.status || null, limit: options.limit || 100 });
    else if (action === 'status') result = { campaign: campaignStore.getCampaign(campaignId), nodes: campaignStore.listNodes(campaignId) };
    else if (action === 'events') result = campaignStore.listEvents(campaignId);
    else if (action === 'pause') result = campaignStore.pauseCampaign(campaignId, options.reason || 'operator_paused');
    else if (action === 'resume') result = campaignStore.resumeCampaign(campaignId);
    else if (action === 'cancel') result = campaignStore.cancelCampaign(campaignId, options.reason || 'operator_cancelled');
    else if (action === 'cancel-node') result = campaignStore.cancelNode(options['node-id'], options.reason || 'operator_node_cancelled');
    else if (action === 'retry') result = campaignStore.retryNode(options['node-id']);
    else throw new Error(`unsupported campaign action: ${action}`);
    process.stdout.write(`${JSON.stringify({ status: `paper_campaign_${action}`, result }, null, 2)}\n`);
    return;
  }
  const inventory = await discoverInventory({ root, store: context.services.store, paperIds: options.paper, inventorySource: 'auto', proposalStagingRoot: path.join(runtimeRoot, 'proposal-staging') });
  const datasetMounts = options.dataset.map((value, index) => {
    const separator = String(value).indexOf('=');
    const name = separator >= 0 ? String(value).slice(0, separator) : `dataset-${index + 1}`;
    const source = path.resolve(separator >= 0 ? String(value).slice(separator + 1) : String(value));
    if (!fs.existsSync(source)) throw new Error(`dataset path does not exist: ${source}`);
    const manifestHash = fs.statSync(source).isDirectory()
      ? directoryMerkleHash(source)
      : `sha256:${crypto.createHash('sha256').update(fs.readFileSync(source)).digest('hex')}`;
    return { name, source, readOnly: true, manifestHash };
  });
  const plans = inventory.rows.map((row) => {
    const mainTex = path.resolve(root, row.task.mainTex || '');
    const sourceWorkspace = fs.existsSync(mainTex) ? path.dirname(mainTex) : path.resolve(root, row.task.sourceWorkspace || '.');
    return buildPaperCampaignPlan({
      paperId: row.task.paperId,
      sourceWorkspace,
      maxRounds: Number(options.rounds || 3),
      refereeCount: Number(options.referees || 3),
      minimumRevisionRounds: Number(options['minimum-revision-rounds'] || 1),
      languages: String(options.languages || 'python,latex').split(',').filter(Boolean),
      requiresGpu: Boolean(options.gpu),
      budgets: {
        maxWallTimeMs: Number(options['max-wall-ms'] || 6 * 60 * 60 * 1000),
        maxAgentCalls: Number(options['max-agent-calls'] || 30),
        maxCpuJobs: Number(options['max-cpu-jobs'] || 32),
        maxGpuJobs: Number(options['max-gpu-jobs'] || 8),
        maxTokenCount: Number(options['max-tokens'] || 500000),
        maxCostUsd: Number(options['max-cost-usd'] || 100),
        maxMemoryMiB: Number(options['memory-mib'] || 8192),
      },
      datasetMounts,
      campaignId: options.paper.length === 1 && options['campaign-id']
        ? options['campaign-id']
        : runId ? `paper-campaign:${row.task.paperId}:${runId}` : null,
    });
  });
  if (!options.execute) {
    process.stdout.write(`${JSON.stringify({ status: 'paper_campaigns_planned', execute: false, plans }, null, 2)}\n`);
    return;
  }
  const executables = ['python3', process.execPath, 'Rscript', 'julia', 'lake', 'latexmk'];
  const runtimeImages = runtimeImagesForCampaign({ gpu: Boolean(options.gpu) });
  const workerRunner = createOsSandboxedWorkerRunner({
    allowedExecutables: executables,
    allowedRoots: plans.map((plan) => plan.sourceWorkspace),
    allowedOutputRoots: [path.join(runtimeRoot, 'automation-artifacts')],
    allowedDatasetRoots: datasetMounts.map((mount) => mount.source),
    allowedContainerImages: Object.values(runtimeImages).map((item) => item.image),
    allowGpu: Boolean(options.gpu),
    maximumTimeoutMs: Number(options['max-wall-ms'] || 6 * 60 * 60 * 1000),
    maximumMemoryBytes: Number(options['worker-memory-mib'] || 4096) * 1024 * 1024,
    maximumCpuSeconds: Number(options['worker-cpu-seconds'] || 3600),
  });
  const empiricalExecutor = createMultiLanguageEmpiricalExecutor({ workerRunner, runtimeImages, cache: createFilesystemEmpiricalCacheRepository({ root: path.join(runtimeRoot, 'automation-cache', 'empirical') }) });
  const provider = String(options['agent-provider'] || 'auto');
  const openclaw = createOpenClawAgentExecutor({ agentId: options['openclaw-agent'] || 'hepta-paper-worker', model: options.model || undefined });
  let ollamaModel = options['ollama-model'] || (provider === 'ollama' ? options.model : null) || null;
  if (!ollamaModel) {
    const { spawnSync } = await import('node:child_process');
    const tags = spawnSync('ollama', ['list'], { encoding: 'utf8', timeout: 5000 });
    ollamaModel = String(tags.stdout || '').split(/\n/).slice(1).map((line) => line.trim().split(/\s+/)[0]).find((name) => name && !/embed/i.test(name)) || null;
  }
  const ollama = ollamaModel ? createOllamaStructuredAgentExecutor({ model: ollamaModel }) : null;
  const codex = createCodexAgentExecutor({ model: provider === 'codex' ? options.model || null : null });
  const selected = provider === 'openclaw' ? openclaw
    : provider === 'ollama' ? ollama
      : provider === 'codex' ? codex
        : createAgentBackendRouter({ primary: openclaw, fallbacks: [ollama] });
  if (!selected) throw new Error(`agent provider unavailable: ${provider}`);
  const agentExecutor = createIsolatedAgentExecutor({ delegate: selected, isolationRoot: path.join(runtimeRoot, 'automation-workspaces'), keepWorkspaces: false, keepFailedWorkspaces: true });
  const nodeExecutor = createCampaignNodeExecutor({ agentExecutor, empiricalExecutor, runtimeRoot });
  for (const plan of plans) campaignStore.createCampaign(plan);
  const totalConcurrency = Math.max(1, Number(options.concurrency || 8));
  const governor = createResourceGovernor({ agent: Number(options['agent-slots'] || 4), cpu: Number(options['cpu-slots'] || 4), gpu: Number(options['gpu-slots'] || 1), memoryMiB: Number(options['memory-mib'] || 8192) });
  const results = await Promise.all(plans.map((plan) => runPaperCampaign({ campaignId: plan.campaignId, campaignStore, executor: nodeExecutor, concurrency: totalConcurrency, resourceGovernor: governor })));
  process.stdout.write(`${JSON.stringify({ status: 'paper_campaigns_completed', execute: true, campaignCount: results.length, results }, null, 2)}\n`);
}

main().catch((error) => { process.stderr.write(`${error?.stack || error}\n`); process.exitCode = 1; });
