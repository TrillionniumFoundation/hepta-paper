#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { createReadOnlyPaperStore } from '../../paper-adapters/persistence/store-provider.mjs';
import { defaultPaperAssetRoot, defaultPaperRuntimeRoot } from '../src/workspace-layout.mjs';
import { probeOsSandbox } from '../../paper-adapters/runtime/os-sandboxed-worker-runner.mjs';
import { AUTOMATION_RUNTIME_IMAGES } from '../../paper-adapters/automation/runtime-image-registry.mjs';

function command(name, args = ['--version']) {
  const located = spawnSync('which', [name], { encoding: 'utf8', timeout: 3000 });
  if (located.status !== 0) return { present: false, executable: null, usable: false };
  const probe = spawnSync(name, args, { encoding: 'utf8', timeout: 10000 });
  return { present: true, executable: String(located.stdout || '').trim(), usable: probe.status === 0, detail: String(probe.stdout || probe.stderr || '').trim().split(/\n/)[0] || null };
}

function image(name) {
  const probe = spawnSync('docker', ['image', 'inspect', name], { encoding: 'utf8', timeout: 10000 });
  return { image: name, present: probe.status === 0, usable: probe.status === 0 };
}

function jsonContainsAgent(value, expectedId) {
  if (Array.isArray(value)) return value.some((item) => jsonContainsAgent(item, expectedId));
  if (!value || typeof value !== 'object') return false;
  if ([value.id, value.agentId, value.agent_id, value.name].some((item) => item === expectedId)) return true;
  return Object.values(value).some((item) => jsonContainsAgent(item, expectedId));
}

const store = createReadOnlyPaperStore({ root: defaultPaperAssetRoot(), runtimeRoot: defaultPaperRuntimeRoot() });
const runtimes = {
  codex: command('codex'),
  python: command('python3'),
  node: command('node'),
  r: command('Rscript'),
  julia: command('julia'),
  lean: command('lake'),
  latex: command('latexmk', ['-version']),
  sandbox: (() => { const probe = probeOsSandbox({ refresh: true }); return { ...probe, present: true, usable: probe.available }; })(),
  gpu: command('nvidia-smi', ['-L']),
  images: {
    python: image(AUTOMATION_RUNTIME_IMAGES.python.image),
    pythonGpu: image(AUTOMATION_RUNTIME_IMAGES.pythonGpu.image),
    r: image(AUTOMATION_RUNTIME_IMAGES.r.image),
  },
};
const gpuContainerProbe = runtimes.gpu.usable && runtimes.images.pythonGpu.present
  ? spawnSync('docker', ['run', '--pull', 'never', '--rm', '--runtime', 'nvidia', '--env', 'NVIDIA_VISIBLE_DEVICES=all', '--env', 'NVIDIA_DRIVER_CAPABILITIES=compute,utility', '--env', 'HOME=/tmp', '--tmpfs', '/tmp:rw,noexec,nosuid,size=64m', '--network', 'none', '--read-only', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges', AUTOMATION_RUNTIME_IMAGES.pythonGpu.image, 'python', '-c', 'import cupy as cp; x=cp.arange(32); assert int(cp.asnumpy((x*x)[17])) == 289; assert cp.cuda.runtime.getDeviceCount() > 0'], { encoding: 'utf8', timeout: 30000 })
  : null;
runtimes.gpuContainer = {
  present: runtimes.images.pythonGpu.present,
  usable: gpuContainerProbe?.status === 0,
  detail: gpuContainerProbe ? String(gpuContainerProbe.stderr || gpuContainerProbe.error?.message || '').trim().slice(-1000) || 'cupy_cuda_probe_passed' : 'gpu_image_or_host_gpu_unavailable',
};
runtimes.images.pythonGpu.usable = runtimes.gpuContainer.usable;
const codexLogin = spawnSync('codex', ['login', 'status'], { encoding: 'utf8', timeout: 5000 });
const ollamaTags = spawnSync('ollama', ['list'], { encoding: 'utf8', timeout: 5000 });
const openclawHealth = spawnSync('openclaw', ['gateway', 'health', '--json'], { encoding: 'utf8', timeout: 10000 });
const openclawAgents = spawnSync('openclaw', ['agents', 'list', '--json'], { encoding: 'utf8', timeout: 15000 });
let heptaWorkerConfigured = false;
try { heptaWorkerConfigured = jsonContainsAgent(JSON.parse(String(openclawAgents.stdout || '{}')), 'hepta-paper-worker'); }
catch { heptaWorkerConfigured = /"(?:id|agentId|agent_id|name)"\s*:\s*"hepta-paper-worker"/.test(String(openclawAgents.stdout || '')); }
const localAgentModels = String(ollamaTags.stdout || '').split(/\n/).slice(1).map((line) => line.trim().split(/\s+/)[0]).filter((name) => name && !/embed/i.test(name));
const codexLoginText = String(codexLogin.stdout || codexLogin.stderr || '');
const openAiLoggedIn = /logged in/i.test(codexLoginText) && !/not logged in/i.test(codexLoginText);
runtimes.agent = {
  usable: openclawHealth.status === 0 || openAiLoggedIn || localAgentModels.length > 0,
  defaultProvider: 'openclaw',
  defaultBackendReady: openclawHealth.status === 0 && heptaWorkerConfigured,
  fallbackReady: openAiLoggedIn || localAgentModels.length > 0,
  openclawGatewayReady: openclawHealth.status === 0,
  heptaWorkerConfigured,
  openAiLoggedIn,
  localModels: localAgentModels,
};
const campaignQuery = store.query('SELECT status,count(*) AS count FROM paper_campaigns GROUP BY status ORDER BY status;');
const nodeQuery = store.query('SELECT status,count(*) AS count FROM campaign_nodes GROUP BY status ORDER BY status;');
const campaignRows = campaignQuery.ok ? campaignQuery.rows : [];
const nodeRows = nodeQuery.ok ? nodeQuery.rows : [];
const automationRuntimeReady = runtimes.agent.usable && runtimes.python.usable && runtimes.latex.usable && runtimes.sandbox.usable;
const now = new Date().toISOString();
const expiredNodesResult = store.query(`SELECT count(*) AS count FROM campaign_nodes WHERE status IN ('leased','running') AND lease_expires_at IS NOT NULL AND lease_expires_at<='${now}';`);
const expiredResourceLeasesResult = store.query(`SELECT count(*) AS count FROM automation_resource_leases WHERE expires_at<='${now}';`);
const expiredWaitersResult = store.query(`SELECT count(*) AS count FROM automation_resource_waiters WHERE expires_at IS NOT NULL AND expires_at<='${now}';`);
const stalledCampaignsResult = store.query(`SELECT count(DISTINCT campaign_id) AS count FROM campaign_nodes WHERE status IN ('leased','running') AND lease_expires_at IS NOT NULL AND lease_expires_at<='${now}';`);
const operationalIntegrity = {
  expiredActiveNodeCount: Number(expiredNodesResult.rows?.[0]?.count || 0),
  expiredResourceLeaseCount: Number(expiredResourceLeasesResult.rows?.[0]?.count || 0),
  expiredWaiterCount: Number(expiredWaitersResult.rows?.[0]?.count || 0),
  stalledRecoverableCampaignCount: Number(stalledCampaignsResult.rows?.[0]?.count || 0),
};
operationalIntegrity.degraded = Object.values(operationalIntegrity).some((value) => typeof value === 'number' && value > 0);
const report = {
  version: 1,
  kind: 'AutomationPlaneStatus',
  status: !automationRuntimeReady ? 'automation_plane_runtime_blocked' : operationalIntegrity.degraded ? 'automation_plane_runtime_degraded' : 'automation_plane_runtime_ready',
  automationRuntimeReady,
  automationOperationalReady: automationRuntimeReady && !operationalIntegrity.degraded,
  operationalIntegrity,
  runtimes,
  empiricalLanguagesReady: Object.entries({ python: { usable: runtimes.python.usable || runtimes.images.python.usable }, node: runtimes.node, r: { usable: runtimes.r.usable || runtimes.images.r.usable }, julia: runtimes.julia, lean: runtimes.lean, latex: runtimes.latex }).filter(([, value]) => value.usable).map(([name]) => name),
  empiricalLanguagesUnavailable: Object.entries({ python: { usable: runtimes.python.usable || runtimes.images.python.usable }, node: runtimes.node, r: { usable: runtimes.r.usable || runtimes.images.r.usable }, julia: runtimes.julia, lean: runtimes.lean, latex: runtimes.latex }).filter(([, value]) => !value.usable).map(([name]) => name),
  campaignStoreReady: campaignQuery.ok && nodeQuery.ok,
  campaigns: campaignRows,
  nodes: nodeRows,
  submissionPlaneRequired: false,
  authorityKeysRequired: false,
  ownerSignaturesRequired: false,
  coldVolumeRequiredForUnrelatedPapers: false,
  externalActionPerformed: false,
};
process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
if (!automationRuntimeReady) process.exitCode = 1;
else if (operationalIntegrity.degraded) process.exitCode = 2;
