import { buildPaperCampaignPlan } from '../../paper-domain/automation/campaign-plan.mjs';
import { buildCampaignSloReport } from '../../paper-domain/automation/campaign-slo.mjs';
import {
  presentCampaignStatus,
  presentNodeLog,
  summarizeCampaign,
  summarizeEvent,
  summarizeNode,
} from './campaign-query-presenter.mjs';

export function campaignBudgetOverrides(options = {}) {
  return Object.fromEntries([
    ['maxWallTimeMs', 'max-wall-ms'],
    ['maxAgentCalls', 'max-agent-calls'],
    ['maxCpuJobs', 'max-cpu-jobs'],
    ['maxGpuJobs', 'max-gpu-jobs'],
    ['maxTokenCount', 'max-tokens'],
    ['maxCostUsd', 'max-cost-usd'],
    ['maxMemoryMiB', 'memory-mib'],
  ].filter(([, option]) => options[option] !== undefined)
    .map(([budget, option]) => [budget, Number(options[option])]));
}

function extendedCampaignPlan(existing, campaignId, options) {
  const persistedPaperTask = existing.spec.researchVerificationInput?.paperTask || null;
  const approvedProposalSeed = existing.spec.approvedProposalSeed || null;
  const paperTask = persistedPaperTask && approvedProposalSeed
    ? {
      ...persistedPaperTask,
      registry: {
        inventorySource: 'proposal_materialization',
        proposalEnvelopeHash: approvedProposalSeed.proposalEnvelopeHash,
        productionPlanEnvelopeHash: approvedProposalSeed.productionPlanEnvelopeHash,
        reviewGateHash: approvedProposalSeed.reviewGateHash,
        proposalSeedContractBundleHash: approvedProposalSeed.proposalSeedContractBundleHash,
      },
      source: { proposalSeedContracts: approvedProposalSeed.contractPath },
    }
    : persistedPaperTask;
  return buildPaperCampaignPlan({
    paperId: existing.paperId,
    sourceWorkspace: existing.spec.sourceWorkspace,
    campaignId,
    mode: existing.spec.requestedMode || existing.requestedMode || existing.spec.mode,
    maxRounds: Number(options.rounds || existing.maxRounds + 1),
    refereeCount: existing.spec.refereeCount,
    minimumRevisionRounds: existing.spec.convergenceThresholds?.minimumRoundIndex || 1,
    languages: existing.spec.languages,
    requiresGpu: existing.spec.requiresGpu,
    datasetMounts: existing.spec.datasetMounts,
    metricSchema: existing.spec.metricSchema,
    paperQualityProfile: existing.spec.paperQualityProfile || null,
    paperQualityProfiles: existing.spec.paperQualityProfiles || [],
    commandBinding: existing.spec.commandBinding || null,
    venueTarget: existing.spec.venueTarget || null,
    datasetRoot: existing.spec.datasetRoot || null,
    benchmarkId: existing.spec.benchmarkId || null,
    empiricalClaimUniverse: existing.spec.empiricalClaimUniverse || null,
    scientificClaimAuthority: existing.spec.scientificClaimAuthority || null,
    paperTask,
    paperState: existing.spec.researchVerificationInput?.state || null,
    autonomousResearchPreparation: existing.spec.autonomousResearchPreparation || null,
    autonomousResearchMachineIntake: existing.spec.autonomousResearchMachineIntake || null,
    autonomousResearchMachineIntakeAdmission:
      existing.spec.autonomousResearchMachineIntakeAdmission || null,
    localOnly: existing.spec.localOnly === true,
    directLocalRunBudgetWaiver: existing.spec.directLocalRunBudgetWaiver || null,
    advancedNumericalExecutionPlan:
      existing.spec.advancedNumericalExecutionPlan || null,
    applyManuscript: Boolean(existing.spec.applyManuscript),
    budgets: { ...existing.spec.budgets, ...campaignBudgetOverrides(options) },
    parentCampaignId: existing.parentCampaignId || existing.spec.parentCampaignId || null,
    supersedesCampaignId: existing.supersedesCampaignId || existing.spec.supersedesCampaignId || null,
    recoveryOfCampaignId: existing.recoveryOfCampaignId || existing.spec.recoveryOfCampaignId || null,
  });
}

export class CampaignCommandService {
  constructor({
    campaignStore,
    workspaceRegistry = null,
    receiptLedger = null,
    runtimeRetentionReceiptLedger = null,
    runtimeRetentionReachabilityProvider = null,
    runtimeRoot,
    buildRuntimeRetentionPlan,
    executeRuntimeRetentionPlan,
    reconcileRuntimeRetentionIntents,
  } = {}) {
    if (!campaignStore || !runtimeRoot) throw new Error('campaign_command_service_dependencies_required');
    this.campaignStore = campaignStore;
    this.workspaceRegistry = workspaceRegistry;
    this.receiptLedger = receiptLedger;
    this.runtimeRetentionReceiptLedger = runtimeRetentionReceiptLedger;
    this.runtimeRetentionReachabilityProvider = runtimeRetentionReachabilityProvider;
    this.runtimeRoot = runtimeRoot;
    this.buildRuntimeRetentionPlan = buildRuntimeRetentionPlan;
    this.executeRuntimeRetentionPlan = executeRuntimeRetentionPlan;
    this.reconcileRuntimeRetentionIntents = reconcileRuntimeRetentionIntents;
  }

  retentionAuthority(nodes, { persist = false } = {}) {
    if (typeof this.buildRuntimeRetentionPlan !== 'function') {
      throw new Error('campaign_runtime_retention_planner_required');
    }
    const activeNodeIds = nodes.filter((node) => ['leased', 'running'].includes(node.status))
      .map((node) => node.nodeId);
    let reachabilityManifest = null;
    try {
      reachabilityManifest = this.runtimeRetentionReachabilityProvider?.createManifest?.({
        activeNodeIds,
        persist,
      }) || null;
    } catch { /* an unavailable authority must protect every governed entry */ }
    const plan = this.buildRuntimeRetentionPlan({
      runtimeRoot: this.runtimeRoot,
      activeNodeIds,
      workspaceRecords: this.workspaceRegistry?.retentionRecords() || [],
      receiptLedger: this.receiptLedger,
      reachabilityManifest,
    });
    return Object.freeze({ plan, reachabilityManifest });
  }

  retentionPlan(nodes) {
    return this.retentionAuthority(nodes).plan;
  }

  selectWorkerBatch({ campaignId = null, limit = 100 } = {}) {
    const campaigns = campaignId
      ? [this.campaignStore.getCampaign(campaignId)].filter(Boolean)
      : this.campaignStore.listCampaigns({ status: 'running', limit: Number(limit), effectiveOnly: true });
    const plans = campaigns.map((campaign) => campaign.spec);
    const seenDatasets = new Set();
    const datasetMounts = campaigns.flatMap((campaign) => campaign.spec?.datasetMounts || []).filter((mount) => {
      const key = `${mount.name}:${mount.source}:${mount.manifestHash || ''}`;
      if (seenDatasets.has(key)) return false;
      seenDatasets.add(key);
      return true;
    });
    return Object.freeze({ campaigns: Object.freeze(campaigns), plans: Object.freeze(plans), datasetMounts: Object.freeze(datasetMounts) });
  }

  buildPlanBatch({ inventoryRows = [], datasetMounts = [], metricSchema = {}, benchmarkId = null, options = {}, runId = null } = {}) {
    return Object.freeze(inventoryRows.map(({ task, state, sourceWorkspace }) => buildPaperCampaignPlan({
      paperId: task.paperId,
      sourceWorkspace,
      maxRounds: Number(options.rounds || 3),
      refereeCount: Number(options.referees || 3),
      minimumRevisionRounds: Number(options['minimum-revision-rounds'] || 1),
      languages: String(options.languages || 'python,latex').split(',').filter(Boolean),
      requiresGpu: Boolean(options.gpu),
      budgets: {
        maxWallTimeMs: Number(options['max-wall-ms'] || 6 * 60 * 60 * 1000),
        ...(options['max-agent-calls'] !== undefined ? { maxAgentCalls: Number(options['max-agent-calls']) } : {}),
        maxCpuJobs: Number(options['max-cpu-jobs'] || 32),
        maxGpuJobs: Number(options['max-gpu-jobs'] || 8),
        maxTokenCount: Number(options['max-tokens'] || 500000),
        maxCostUsd: Number(options['max-cost-usd'] || 100),
        maxMemoryMiB: Number(options['memory-mib'] || 8192),
      },
      datasetMounts,
      metricSchema,
      benchmarkId,
      mode: options.mode || 'full-campaign',
      localOnly: Boolean(options['local-only']),
      applyManuscript: Boolean(options['apply-manuscript']),
      paperQualityProfile: options['quality-profile'] || task.paperQualityProfile || null,
      paperQualityProfiles: task.paperQualityProfiles || [],
      venueTarget: task.venueTarget || null,
      paperTask: task,
      paperState: state,
      campaignId: options.paper?.length === 1 && options['campaign-id']
        ? options['campaign-id']
        : runId ? `paper-campaign:${task.paperId}:${runId}` : null,
      parentCampaignId: options['parent-campaign-id'] || null,
      supersedesCampaignId: options['supersedes-campaign-id'] || null,
      recoveryOfCampaignId: options['recovery-of-campaign-id'] || null,
      advancedNumericalExecutionPlan:
        options.advancedNumericalExecutionPlan || null,
    })));
  }

  slo(options = {}) {
    const campaigns = this.campaignStore.listCampaigns({ limit: Number(options.limit || 1000) });
    const nodes = campaigns.flatMap((campaign) => this.campaignStore.listNodes(campaign.campaignId));
    const events = campaigns.flatMap((campaign) => this.campaignStore.listEvents(campaign.campaignId));
    const telemetrySamples = campaigns.flatMap((campaign) => this.campaignStore.listTelemetry?.(campaign.campaignId) || []);
    const retention = this.retentionPlan(nodes);
    return buildCampaignSloReport({
      campaigns,
      nodes,
      events,
      telemetrySamples,
      runtimeBytes: retention.categories.reduce((total, category) => total + category.bytesBefore, 0),
    });
  }

  gc(options) {
    const apply = Boolean(options.apply);
    if (typeof this.executeRuntimeRetentionPlan !== 'function'
      || (apply && typeof this.reconcileRuntimeRetentionIntents !== 'function')) {
      throw new Error('campaign_runtime_retention_executor_required');
    }
    const activeNodes = this.campaignStore.listCampaigns({ status: 'running', limit: 1000 })
      .flatMap((campaign) => this.campaignStore.listNodes(campaign.campaignId));
    const activeNodeIds = activeNodes.map((node) => node.nodeId);
    const recovery = apply ? this.reconcileRuntimeRetentionIntents({
      runtimeRoot: this.runtimeRoot,
      workspaceRegistry: this.workspaceRegistry,
      receiptLedger: this.receiptLedger,
      retentionReceiptLedger: this.runtimeRetentionReceiptLedger,
      reachabilityManifestProvider: this.runtimeRetentionReachabilityProvider,
      activeNodeIds,
    }) : null;
    if (recovery?.status === 'runtime_retention_recovery_blocked') {
      throw new Error(`runtime_retention_recovery_blocked:${JSON.stringify(recovery.blockers)}`);
    }
    const { plan, reachabilityManifest } = this.retentionAuthority(activeNodes, { persist: apply });
    return {
      recovery,
      plan,
      receipt: this.executeRuntimeRetentionPlan(plan, {
        apply,
        workspaceRegistry: this.workspaceRegistry,
        receiptLedger: this.receiptLedger,
        reachabilityManifest,
        reachabilityManifestProvider: this.runtimeRetentionReachabilityProvider,
        activeNodeIds,
        retentionReceiptLedger: apply ? this.runtimeRetentionReceiptLedger : null,
      }),
    };
  }

  execute({ action, campaignId = null, options = {} } = {}) {
    let result;
    if (action === 'slo') result = this.slo(options);
    else if (action === 'gc') result = this.gc(options);
    else if (action === 'list') {
      const campaigns = this.campaignStore.listCampaigns({
        status: options.status || null,
        limit: options.limit || 100,
        effectiveOnly: Boolean(options.effective),
      });
      result = options.details ? campaigns : campaigns.map(summarizeCampaign);
    } else if (action === 'status') {
      result = presentCampaignStatus(
        this.campaignStore.getCampaign(campaignId),
        this.campaignStore.listNodes(campaignId),
        { details: Boolean(options.details) },
      );
    } else if (action === 'events') {
      const events = this.campaignStore.listEvents(campaignId, {
        limit: Number(options.limit || 50),
        before: options.before || null,
      });
      result = options.details ? events : events.map(summarizeEvent);
    } else if (action === 'logs') {
      const node = this.campaignStore.listNodes(campaignId)
        .find((item) => item.nodeId === options['node-id'] || item.kind === options.kind);
      if (!node) throw new Error('campaign node not found for log query');
      result = presentNodeLog(node, { details: Boolean(options.details) });
    } else if (action === 'pause') {
      result = this.campaignStore.pauseCampaign(campaignId, options.reason || 'operator_paused');
    } else if (action === 'resume') {
      result = this.campaignStore.resumeCampaign(campaignId, { budgetOverrides: campaignBudgetOverrides(options) });
    } else if (action === 'extend') {
      const existing = this.campaignStore.getCampaign(campaignId);
      if (!existing) throw new Error(`campaign not found: ${campaignId}`);
      result = this.campaignStore.extendCampaign(extendedCampaignPlan(existing, campaignId, options));
    } else if (action === 'cancel') {
      result = this.campaignStore.cancelCampaign(campaignId, options.reason || 'operator_cancelled');
    } else if (action === 'cancel-node') {
      result = this.campaignStore.cancelNode(options['node-id'], options.reason || 'operator_node_cancelled');
    } else if (action === 'retry') {
      const nodeId = options['node-id'];
      const node = this.campaignStore.listNodes(campaignId)
        .find((candidate) => candidate.nodeId === nodeId);
      if (!node) throw new Error('campaign node not found for retry');
      result = this.campaignStore.retryNode(nodeId);
    }
    else throw new Error(`unsupported campaign action: ${action}`);
    const presented = options.details
      ? result
      : result?.campaignId && result?.paperId
        ? summarizeCampaign(result)
        : result?.nodeId
          ? summarizeNode(result)
          : result;
    return Object.freeze({ status: `paper_campaign_${action}`, result: presented });
  }
}
