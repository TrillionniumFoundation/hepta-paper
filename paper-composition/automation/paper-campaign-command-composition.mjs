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
import {
  buildVenueMigrationManifest,
  buildVenueMigrationReviewQueue,
  sourceVenueMatch,
} from '../../paper-domain/automation/venue-migration-campaign-contract.mjs';
import {
  materializeVenueMigrationWorkspacesSync,
} from '../../paper-adapters/automation/venue-migration-workspace-repository.mjs';

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
    // Keep the declared workspace as the package root.  Deriving the root
    // from the selected TeX file silently drops sibling assets when a paper's
    // entry point is nested (as in the AI-dual package).  Only fall back to
    // the TeX parent when the declaration is absent or invalid.
    const declaredWorkspace = row.task.sourceWorkspace
      ? path.resolve(root, row.task.sourceWorkspace)
      : null;
    const sourceWorkspace = declaredWorkspace && fs.existsSync(declaredWorkspace)
      && fs.statSync(declaredWorkspace).isDirectory()
      ? declaredWorkspace
      : mainTex && fs.existsSync(mainTex) && fs.statSync(mainTex).isFile()
        ? path.dirname(mainTex)
        : path.resolve(root, row.task.sourceWorkspace || '.');
    const sourcePaperContractPath = path.join(sourceWorkspace, 'paper.json');
    let sourcePaperContract = null;
    try {
      const stat = fs.lstatSync(sourcePaperContractPath);
      if (stat.isFile()) {
        const parsed = JSON.parse(fs.readFileSync(sourcePaperContractPath, 'utf8'));
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
          sourcePaperContract = Object.freeze({
            path: sourcePaperContractPath,
            contractSchema: parsed.paper_production?.contract_schema || null,
            profile: parsed.paper_production?.profile || null,
            migrationState: parsed.paper_production?.migration_state || null,
            proofReadiness: parsed.proof_readiness || null,
          });
        }
      }
    } catch {
      // Optional metadata is never treated as verified when malformed.
    }
    return Object.freeze({
      task: row.task,
      state: row.state,
      sourceWorkspace,
      // Keep raw inventory provenance available to venue-migration planning;
      // the campaign plan itself still binds only the canonical PaperTask.
      paper: row.paper || null,
      artifacts: row.artifacts || null,
      submissionIntent: row.submissionIntent || null,
      sourcePaperContract,
    });
  });
}

function safeRuntimeSegment(value) {
  return String(value || 'venue-migration')
    .replace(/[^A-Za-z0-9_.-]/g, '_')
    .replace(/^\.+$/, '_')
    .slice(0, 160) || 'venue-migration';
}

async function persistVenueMigrationQueue({
  services,
  runtimeRoot,
  manifest,
  reviewQueue,
} = {}) {
  if (!services?.artifactRepositoryFactory) {
    throw new Error('venue_migration_artifact_repository_required');
  }
  const runSegment = safeRuntimeSegment(
    manifest.runId || manifest.manifestHash.slice('sha256:'.length, 24),
  );
  const outputRoot = path.join(runtimeRoot, 'venue-migrations', runSegment);
  const repository = services.artifactRepositoryFactory(runtimeRoot);
  const manifestPath = path.join(outputRoot, 'manifest.json');
  const reviewQueuePath = path.join(outputRoot, 'review-queue.json');
  const manifestReceipt = await repository.writeJson(manifestPath, manifest, {
    role: 'venue_migration_campaign_manifest',
  });
  const queueReceipt = await repository.writeJson(reviewQueuePath, reviewQueue, {
    role: 'venue_migration_review_queue',
  });
  return Object.freeze({
    outputRoot,
    manifestPath,
    reviewQueuePath,
    manifestReceipt,
    queueReceipt,
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
  if (options['write-queue'] && !options.execute) {
    throw new Error('venue_migration_queue_persistence_requires_execute');
  }
  if ((options.target || options.venue) && !options['from-venue']) {
    throw new Error('venue_migration_source_venue_required');
  }
  if ((options.target || options.venue) && options.execute
    && !options['from-venue'] && !options.paper?.length) {
    throw new Error('campaign_target_override_requires_explicit_papers_or_source_venue');
  }
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
  let venueMigrationManifest = null;
  let venueMigrationReviewQueue = null;
  let venueMigrationPersistence = null;
  let venueMigrationWorkspacePreparation = null;
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
    const allInventoryRows = resolveInventoryRows(inventory, root);
    const sourceVenue = options['from-venue'] || null;
    const targetVenue = options.target || options.venue || null;
    if (sourceVenue) {
      if (!targetVenue) throw new Error('venue_migration_target_venue_required');
      if (!runId) throw new Error('venue_migration_run_id_required');
      if (options['local-only'] !== true || String(options.mode || '') !== 'local-review-loop') {
        throw new Error('venue_migration_requires_local_review_loop_local_only');
      }
      const selected = allInventoryRows.filter((row) => sourceVenueMatch(row, sourceVenue).matched);
      if (!selected.length) throw new Error('venue_migration_source_venue_selection_empty');
      // An explicit paper list narrows the source-venue selection; it must not
      // silently widen it or admit a paper with unrelated provenance.
      if (options.paper?.length && selected.length !== allInventoryRows.length) {
        const selectedIds = new Set(selected.map(({ task }) => task.paperId));
        const requestedIds = options.paper.map(String);
        const rejected = requestedIds.filter((paperId) => !selectedIds.has(paperId));
        if (rejected.length) {
          throw new Error(`venue_migration_requested_paper_source_mismatch:${rejected.join(',')}`);
        }
      }
      venueMigrationManifest = buildVenueMigrationManifest({
        rows: selected,
        sourceVenue,
        targetVenue,
        runtimeRoot,
        runId,
        mode: 'local-review-loop',
        rounds: Number(options.rounds || 3),
        referees: Number(options.referees || 3),
      });
    }
    let inventoryRows = sourceVenue
      ? allInventoryRows.filter((row) => venueMigrationManifest.entries.some((entry) => entry.paperId === row.task.paperId))
      : allInventoryRows;
    if (venueMigrationManifest) {
      // A campaign-level COW is mandatory before any revise/rewrite node is
      // submitted.  The canonical inventory source remains in the row/task
      // provenance, while the executable plan points at the private clone.
      if (options.execute) {
        venueMigrationWorkspacePreparation = materializeVenueMigrationWorkspacesSync({
          manifest: venueMigrationManifest,
          runtimeRoot,
        });
      }
      const migrationEntries = new Map(
        venueMigrationManifest.entries.map((entry) => [entry.paperId, entry]),
      );
      inventoryRows = inventoryRows.map((row) => {
        const entry = migrationEntries.get(row.task.paperId);
        if (!entry) return row;
        return Object.freeze({
          ...row,
          sourceWorkspace: entry.workspaceIsolation.campaignWorkspaceRoot,
        });
      });
    }
    datasetMounts = resolveDatasetMounts({ options, runtimeRoot });
    const metricSchema = options['metric-schema']
      ? JSON.parse(fs.readFileSync(path.resolve(options['metric-schema']), 'utf8'))
      : {};
    if (datasetMounts.length > 1 && !options['benchmark-id']) {
      throw new Error('--benchmark-id is required when more than one dataset is mounted');
    }
    const benchmarkId = options['benchmark-id'] || (datasetMounts.length === 1 ? datasetMounts[0].name : null);
    plans = commandService.buildPlanBatch({
      inventoryRows,
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
    if (venueMigrationManifest) {
      venueMigrationReviewQueue = buildVenueMigrationReviewQueue(venueMigrationManifest, {
        observedAt: context.services.clock.nowIso(),
        campaignPlans: plans,
        workspaceBindings: venueMigrationWorkspacePreparation?.bindings || [],
      });
      if (options.execute || options['write-queue']) {
        venueMigrationPersistence = await persistVenueMigrationQueue({
          services: context.services,
          runtimeRoot,
          manifest: venueMigrationManifest,
          reviewQueue: venueMigrationReviewQueue,
        });
      }
    }
  }
  if (!workAction && !options.execute) {
    return Object.freeze({
      status: 'paper_campaigns_planned',
      execute: false,
      plans: options.details ? plans : plans.map(summarizePlan),
      ...(venueMigrationManifest ? {
        venueMigrationManifest,
        venueMigrationReviewQueue,
        venueMigrationWorkspacePreparation,
        venueMigrationPersistence,
      } : {}),
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
  if (!workAction) for (const plan of plans) campaignStore.createCampaign(plan);
  if (!workAction && !options.inline) {
    return Object.freeze({
      status: 'paper_campaigns_submitted',
      execute: false,
      campaignCount: plans.length,
      campaignIds: plans.map((plan) => plan.campaignId),
      ...(venueMigrationManifest ? {
        venueMigrationManifest,
        venueMigrationReviewQueue,
        venueMigrationWorkspacePreparation,
        venueMigrationPersistence,
      } : {}),
    });
  }
  // Queue submission must not initialize a worker or its reviewer/author
  // runtimes.  Those runtimes may require private credentials and are only
  // relevant when this process is actually executing nodes (`--inline`) or
  // servicing an existing queue (`--action work`).  Deferring composition
  // keeps local migration planning/persistence usable without silently
  // turning a queue write into a credential preflight.
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
    ...(venueMigrationManifest ? {
      venueMigrationManifest,
      venueMigrationReviewQueue,
      venueMigrationWorkspacePreparation,
      venueMigrationPersistence,
    } : {}),
  });
}
