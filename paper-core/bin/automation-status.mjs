#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { createReadOnlyPaperStore } from '../../paper-adapters/persistence/store-provider.mjs';
import { defaultPaperAssetRoot, defaultPaperRuntimeRoot } from '../src/workspace-layout.mjs';
import { probeOsSandbox } from '../../paper-adapters/runtime/os-sandboxed-worker-runner.mjs';

function command(name, args = ['--version']) {
  const located = spawnSync('which', [name], { encoding: 'utf8', timeout: 3000 });
  if (located.status !== 0) return { present: false, executable: null, usable: false };
  const probe = spawnSync(name, args, { encoding: 'utf8', timeout: 10000 });
  return { present: true, executable: String(located.stdout || '').trim(), usable: probe.status === 0, detail: String(probe.stdout || probe.stderr || '').trim().split(/\n/)[0] || null };
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
};
const codexLogin = spawnSync('codex', ['login', 'status'], { encoding: 'utf8', timeout: 5000 });
const ollamaTags = spawnSync('ollama', ['list'], { encoding: 'utf8', timeout: 5000 });
const localAgentModels = String(ollamaTags.stdout || '').split(/\n/).slice(1).map((line) => line.trim().split(/\s+/)[0]).filter((name) => name && !/embed/i.test(name));
const codexLoginText = String(codexLogin.stdout || codexLogin.stderr || '');
const openAiLoggedIn = /logged in/i.test(codexLoginText) && !/not logged in/i.test(codexLoginText);
runtimes.agent = {
  usable: openAiLoggedIn || localAgentModels.length > 0,
  openAiLoggedIn,
  localModels: localAgentModels,
};
const campaignQuery = store.query('SELECT status,count(*) AS count FROM paper_campaigns GROUP BY status ORDER BY status;');
const nodeQuery = store.query('SELECT status,count(*) AS count FROM campaign_nodes GROUP BY status ORDER BY status;');
const campaignRows = campaignQuery.ok ? campaignQuery.rows : [];
const nodeRows = nodeQuery.ok ? nodeQuery.rows : [];
const automationRuntimeReady = runtimes.agent.usable && runtimes.python.usable && runtimes.latex.usable && runtimes.sandbox.usable;
const report = {
  version: 1,
  kind: 'AutomationPlaneStatus',
  status: automationRuntimeReady ? 'automation_plane_runtime_ready' : 'automation_plane_runtime_blocked',
  automationRuntimeReady,
  runtimes,
  empiricalLanguagesReady: Object.entries({ python: runtimes.python, node: runtimes.node, r: runtimes.r, julia: runtimes.julia, lean: runtimes.lean, latex: runtimes.latex }).filter(([, value]) => value.usable).map(([name]) => name),
  empiricalLanguagesUnavailable: Object.entries({ python: runtimes.python, node: runtimes.node, r: runtimes.r, julia: runtimes.julia, lean: runtimes.lean, latex: runtimes.latex }).filter(([, value]) => !value.usable).map(([name]) => name),
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
