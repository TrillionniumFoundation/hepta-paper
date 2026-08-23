import fs from 'node:fs';
import path from 'node:path';
import { runPaperCampaign } from '../../paper-application/automation/campaign-engine.mjs';
import { summarizePlan, summarizeRun } from '../../paper-application/automation/campaign-query-presenter.mjs';
import { bootstrapCampaignExecutionContext } from '../bootstrap/campaign-execution-context-bootstrap.mjs';
import { composeCampaignCommandService } from './campaign-command-composition.mjs';
import {
  authorizeOperatorDatasetMount,
  campaignDatasetContentHash,
  composeCampaignWorkerExecution,
  loadOperatorDatasetAuthorityTrustStoreSync,
} from './campaign-worker-composition.mjs';
import {
  buildCanonicalGpuScientificCampaignExecutionPlan,
} from '../../paper-domain/automation/gpu-scientific-campaign-execution-contract.mjs';
import {
  inspectNvidiaGpuDeviceCapacity,
  selectSingleNvidiaGpuDeviceCapacity,
} from '../../paper-adapters/runtime/nvidia-gpu-device-capacity-observer.mjs';

const LOCAL_ONLY_CAMPAIGN_MODES = new Set(['empirical-analysis', 'local-review-loop']);

function namedValues(values, { flag, syntax }, transform = (value) => value) {
  const entries = (values || []).map((value) => {
    const separator = String(value).indexOf('=');
    if (separator < 1) throw new Error(`${flag} must use ${syntax} syntax`);
    return [String(value).slice(0, separator), transform(String(value).slice(separator + 1), String(value).slice(0, separator))];
  });
  const result = new Map(entries);
  if (result.size !== entries.length) throw new Error(`duplicate ${flag} name`);
  return result;
}

function resolveDatasetMounts({ options, runtimeRoot }) {
  const datasetLicenses = namedValues(options['dataset-license'], {
    flag: '--dataset-license', syntax: 'name=SPDX',
  });
  const datasetAuthorizations = namedValues(options['dataset-authorization'], {
    flag: '--dataset-authorization', syntax: 'name=sha256:...',
  }, (value, name) => {
    if (!/^sha256:[0-9a-f]{64}$/i.test(value)) throw new Error(`--dataset-authorization hash is invalid for ${name}`);
    return value;
  });
  const datasetHarnesses = namedValues(options['dataset-harness'], {
    flag: '--dataset-harness', syntax: 'name=/host/path/envelope.json',
  }, (value) => path.resolve(value));
  const authorityTrustStore = datasetHarnesses.size
    ? loadOperatorDatasetAuthorityTrustStoreSync({ runtimeRoot })
    : null;
  const datasetMounts = (options.dataset || []).map((value, index) => {
    const separator = String(value).indexOf('=');
    const name = separator >= 0 ? String(value).slice(0, separator) : `dataset-${index + 1}`;
    const source = path.resolve(separator >= 0 ? String(value).slice(separator + 1) : String(value));
    if (!fs.existsSync(source)) throw new Error(`dataset path does not exist: ${source}`);
    const mount = {
      name,
      source,
      readOnly: true,
      manifestHash: campaignDatasetContentHash(source),
      licenseId: datasetLicenses.get(name) || null,
      ...(datasetAuthorizations.has(name) ? { operatorAuthorizationHash: datasetAuthorizations.get(name) } : {}),
    };
    return datasetHarnesses.has(name)
      ? authorizeOperatorDatasetMount(mount, {
        envelopePath: datasetHarnesses.get(name),
        authorityTrustStore,
        runtimeRoot,
        persistPrivateEnvelope: Boolean(options.execute),
      })
      : mount;
  });
  const datasetNames = new Set(datasetMounts.map((mount) => mount.name));
  for (const name of [...datasetLicenses.keys(), ...datasetAuthorizations.keys(), ...datasetHarnesses.keys()]) {
    if (!datasetNames.has(name)) throw new Error(`dataset metadata references an unknown mount: ${name}`);
  }
  return datasetMounts;
}

function resolveInventoryRows(inventory, root) {
  return inventory.rows.map((row) => {
    const mainTex = row.task.mainTex ? path.resolve(root, row.task.mainTex) : null;
    const sourceWorkspace = mainTex && fs.existsSync(mainTex) && fs.statSync(mainTex).isFile()
      ? path.dirname(mainTex)
      : path.resolve(root, row.task.sourceWorkspace || '.');
    return Object.freeze({ task: row.task, state: row.state, sourceWorkspace });
  });
}

function gpuScientificExecutionPlanFactory({ options, clock }) {
  const requested = options['gpu-scientific'] === true;
  const selectorRequested = options['gpu-device-selector'] !== undefined;
  const deadlineRequested = options['gpu-scientific-deadline-ms'] !== undefined;
  if (!requested) {
    if (selectorRequested || deadlineRequested) {
      throw new Error('--gpu-device-selector and --gpu-scientific-deadline-ms require --gpu-scientific');
    }
    return null;
  }
  if (options.gpuScientificExecutionPlan) {
    throw new Error('campaign_gpu_scientific_execution_plan_ambiguous');
  }
  const observation = selectorRequested
    ? inspectNvidiaGpuDeviceCapacity(String(options['gpu-device-selector']))
    : selectSingleNvidiaGpuDeviceCapacity();
  if (!observation) {
    throw new Error(selectorRequested
      ? 'campaign_gpu_scientific_device_unavailable'
      : 'campaign_gpu_scientific_single_device_required');
  }
  const deadlineWindowMs = Number(
    options['gpu-scientific-deadline-ms']
      ?? options['max-wall-ms']
      ?? 6 * 60 * 60 * 1_000,
  );
  if (!Number.isSafeInteger(deadlineWindowMs)
    || deadlineWindowMs < 60_000
    || deadlineWindowMs > 24 * 60 * 60 * 1_000) {
    throw new Error('campaign_gpu_scientific_deadline_window_invalid');
  }
  const absoluteExecutionDeadlineEpochMs = clock.now().getTime() + deadlineWindowMs;
  return ({ campaignId, paperId }) => buildCanonicalGpuScientificCampaignExecutionPlan({
    campaignId,
    paperId,
    gpuDeviceSelector: observation.gpuDeviceSelector,
    absoluteExecutionDeadlineEpochMs,
  });
}

export async function executePaperCampaignCommand({
  options = {},
  root,
  runtimeRoot,
  environment = {},
  packageRecoveryAuthority = null,
  packageRecoveryAuthorityReadinessVerifier = null,
  packageRecoveryDeletionLeasePort = null,
} = {}) {
  if (!root || !runtimeRoot) throw new Error('paper_campaign_command_roots_required');
  if (options['local-only'] === true
    && !LOCAL_ONLY_CAMPAIGN_MODES.has(String(options.mode || ''))) {
    throw new Error('paper_campaign_local_only_mode_invalid');
  }
  if (options['campaign-id'] && options['run-id']) throw new Error('--campaign-id and --run-id cannot be combined');
  const runId = options['run-id'] ? String(options['run-id']).replace(/[^A-Za-z0-9_.-]/g, '_') : null;
  if (options['run-id'] && !runId) throw new Error('--run-id must contain at least one safe character');
  const planOnly = !options.action && !options.execute;
  const readOnlyAction = [
    'list', 'status', 'events', 'logs', 'slo', 'gc',
    'retention-recovery-readiness',
  ].includes(String(options.action || ''))
    && !options.apply;
  const campaignExecutionContext = bootstrapCampaignExecutionContext({
    root,
    runtimeRoot,
    mode: 'paper-campaign',
    execute: Boolean(options.execute),
    readOnly: Boolean(planOnly || readOnlyAction),
    allowMissingReadOnlyStore: planOnly,
    submissionHandoffReadOnly: options['local-only'] === true,
    environment,
    packageRecoveryAuthority,
    packageRecoveryAuthorityReadinessVerifier,
    packageRecoveryDeletionLeasePort,
  });
  const { context } = campaignExecutionContext;
  const campaignStore = context.services.campaignStore;
  const workspaceRegistry = context.services.workspaceRegistry;
  const commandService = composeCampaignCommandService({ runtimeRoot, services: context.services });
  const workAction = options.action === 'work';
  if (options.action && !workAction) {
    return commandService.execute({
      action: String(options.action),
      campaignId: options['campaign-id'] || null,
      options,
    });
  }
  let datasetMounts;
  let plans;
  if (workAction) {
    const batch = commandService.selectWorkerBatch({
      campaignId: options['campaign-id'] || null,
      limit: options.limit || 100,
    });
    ({ plans, datasetMounts } = batch);
  } else {
    const inventory = await context.services.inventoryRepository.discover({
      root,
      paperIds: options.paper,
      inventorySource: 'auto',
      proposalStagingRoot: path.join(runtimeRoot, 'proposal-staging'),
    });
    datasetMounts = resolveDatasetMounts({ options, runtimeRoot });
    const metricSchema = options['metric-schema']
      ? JSON.parse(fs.readFileSync(path.resolve(options['metric-schema']), 'utf8'))
      : {};
    if (datasetMounts.length > 1 && !options['benchmark-id']) {
      throw new Error('--benchmark-id is required when more than one dataset is mounted');
    }
    const benchmarkId = options['benchmark-id'] || (datasetMounts.length === 1 ? datasetMounts[0].name : null);
    plans = commandService.buildPlanBatch({
      inventoryRows: resolveInventoryRows(inventory, root),
      datasetMounts,
      metricSchema,
      benchmarkId,
      options,
      runId,
      gpuScientificExecutionPlanFactory: gpuScientificExecutionPlanFactory({
        options,
        clock: context.services.clock,
      }),
    });
  }
  if (!workAction && !options.execute) {
    return Object.freeze({
      status: 'paper_campaigns_planned',
      execute: false,
      plans: options.details ? plans : plans.map(summarizePlan),
    });
  }
  if (!plans.length) return Object.freeze({ status: 'paper_campaign_worker_idle', campaignCount: 0 });
  const governor = workAction || options.inline
    ? context.services.resourceGovernorFactory({
      agent: Number(options['agent-slots'] || 4),
      cpu: Number(options['cpu-slots'] || 4),
      gpu: Number(options['gpu-slots'] || 1),
      memoryMiB: Number(options['memory-mib'] || 8192),
    })
    : null;
  const { nodeExecutor } = composeCampaignWorkerExecution({
    options,
    plans,
    runtimeRoot,
    datasetMounts,
    workspaceRegistry,
    campaignExecutionContext,
    services: context.services,
    environment,
    executionRequested: workAction || options.inline === true,
  });
  if (!workAction) for (const plan of plans) campaignStore.createCampaign(plan);
  if (!workAction && !options.inline) {
    return Object.freeze({
      status: 'paper_campaigns_submitted',
      execute: false,
      campaignCount: plans.length,
      campaignIds: plans.map((plan) => plan.campaignId),
    });
  }
  const results = await Promise.all(plans.map((plan) => runPaperCampaign({
    campaignId: plan.campaignId,
    campaignStore,
    executor: nodeExecutor,
    concurrency: Math.max(1, Number(options.concurrency || 8)),
    resourceGovernor: governor,
    clock: context.services.clock,
    scheduler: context.services.scheduler,
    idGenerator: context.services.idGenerator,
    packageLifecycleAuthority: context.services.packageLifecycleAuthority,
  })));
  return Object.freeze({
    status: workAction ? 'paper_campaign_worker_batch_completed' : 'paper_campaigns_completed',
    execute: true,
    campaignCount: results.length,
    results: options.details ? results : results.map(summarizeRun),
  });
}
