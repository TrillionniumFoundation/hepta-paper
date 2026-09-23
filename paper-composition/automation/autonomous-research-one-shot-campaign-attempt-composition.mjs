import {
  AUTONOMOUS_RESEARCH_ONE_SHOT_FORBIDDEN_PREPARE_ENVIRONMENT_KEYS,
  AUTONOMOUS_RESEARCH_ONE_SHOT_PROTECTED_CAMPAIGN_ID,
  AUTONOMOUS_RESEARCH_ONE_SHOT_PROVIDER_CONFIGURATION_HASH,
  AUTONOMOUS_RESEARCH_ONE_SHOT_TARGET_CAMPAIGN_ID,
  AUTONOMOUS_RESEARCH_ONE_SHOT_TARGET_OBJECTIVE,
  AUTONOMOUS_RESEARCH_ONE_SHOT_TARGET_PAPER_ID,
  autonomousResearchOneShotCampaignCodeProvenanceHash,
  autonomousResearchOneShotCampaignEnvironmentProjectionHash,
  autonomousResearchOneShotProtectedCampaignFingerprintHash,
  autonomousResearchOneShotProviderRuntimeBindingHash,
  autonomousResearchOneShotCampaignSourceExecutionSnapshotHash,
  autonomousResearchOneShotTargetCampaignDefinitionHash,
  buildAutonomousResearchOneShotCampaignAttemptReservation,
} from '../../paper-domain/automation/autonomous-research-one-shot-campaign-attempt.mjs';
import {
  createCampaignOneShotAttemptJournalRepository,
} from '../../paper-adapters/automation/campaign-one-shot-attempt-journal-repository.mjs';
import { currentCodeProvenance } from '../../paper-adapters/runtime/code-provenance.mjs';
import {
  inspectWorkspaceExecutionSnapshot,
  sourceTreeExcludedNames,
} from '../../paper-adapters/runtime/execution-snapshot.mjs';
import { hashRecord } from '../../workflow-kernel/record-hash.mjs';
import { sqlText } from '../../paper-ports/store-port.mjs';
import {
  resolveAutonomousResearchDirectLocalRunBudgetWaiver,
} from '../../paper-application/automation/autonomous-research-cli-policy.mjs';
import {
  createReadOnlyPaperStore,
  createSqliteCampaignStore,
} from '../bootstrap/operator-persistence-composition.mjs';
import {
  composeAutonomousResearchCampaignAction,
} from './autonomous-research-campaign-composition.mjs';
import {
  resolveAutonomousResearchProviderConfiguration,
} from './autonomous-research-qualification-composition.mjs';
import {
  runAutonomousResearchProviderCanaryPair,
} from './autonomous-research-provider-canary.mjs';
import {
  composeAutonomousResearchOneShotCampaignAttempt,
} from './autonomous-research-one-shot-campaign-attempt-state-machine.mjs';
import {
  assertAutonomousResearchOneShotProviderCanaryReceiptBound,
  canonicalAutonomousResearchOneShotDatasetMounts,
  createAutonomousResearchOneShotCampaignExecutionBindingFence,
  createAutonomousResearchOneShotExternalActionGate,
  inspectAutonomousResearchOneShotProviderRuntimeBinding,
} from './autonomous-research-one-shot-campaign-execution-fence.mjs';
import {
  autonomousResearchOneShotCampaignAttemptIdempotencyKey,
  selectAutonomousResearchOneShotCampaignAttemptReservation,
} from './autonomous-research-one-shot-campaign-attempt-replay.mjs';
import {
  createAutonomousResearchOneShotPrepareSideEffectGuard,
  fixedAutonomousResearchOneShotPrepareEnvironment,
  fixedAutonomousResearchOneShotProviderEnvironment,
} from './autonomous-research-one-shot-provider-environment.mjs';
import {
  AUTONOMOUS_RESEARCH_ONE_SHOT_PREFLIGHT_ACTIONS,
  defaultAutonomousResearchOneShotDatasetAuthorityInspector as defaultDatasetAuthorityInspector,
  inspectAutonomousResearchOneShotCampaignPreflight,
} from './autonomous-research-one-shot-campaign-preflight.mjs';

const PREFLIGHT_ACTIONS = new Set(AUTONOMOUS_RESEARCH_ONE_SHOT_PREFLIGHT_ACTIONS);

export {
  autonomousResearchOneShotCampaignAttemptIdempotencyKey,
  selectAutonomousResearchOneShotCampaignAttemptReservation,
} from './autonomous-research-one-shot-campaign-attempt-replay.mjs';
export {
  createAutonomousResearchOneShotPrepareSideEffectGuard,
  fixedAutonomousResearchOneShotPrepareEnvironment,
  fixedAutonomousResearchOneShotProviderEnvironment,
} from './autonomous-research-one-shot-provider-environment.mjs';
export {
  inspectAutonomousResearchOneShotProviderRuntimeBinding,
} from './autonomous-research-one-shot-campaign-execution-fence.mjs';
export {
  composeAutonomousResearchOneShotCampaignAttempt,
} from './autonomous-research-one-shot-campaign-attempt-state-machine.mjs';

export const AUTONOMOUS_RESEARCH_ONE_SHOT_CAMPAIGN_OPTIONS = Object.freeze({
  paperId: AUTONOMOUS_RESEARCH_ONE_SHOT_TARGET_PAPER_ID,
  campaignId: AUTONOMOUS_RESEARCH_ONE_SHOT_TARGET_CAMPAIGN_ID,
  objective: AUTONOMOUS_RESEARCH_ONE_SHOT_TARGET_OBJECTIVE,
  protocolFamily: 'finance_asset_pricing_benchmark',
  revisionRounds: 3,
  refereeCount: 3,
  requestedLaunchMode: 'local-run',
  launchMode: 'golden-bootstrap',
  localOnly: true,
  humanSubjects: false,
  privateData: false,
  requireLaunchReady: true,
  requireCampaignAbsentAtLaunch: true,
  worker: Object.freeze({
    concurrency: 8,
    agentSlots: 4,
    cpuSlots: 4,
    gpuSlots: 1,
    memoryMiB: 8192,
  }),
  budgets: Object.freeze({
    maxWallTimeMs: 7_200_000,
    maxAgentCalls: 201,
    maxCpuJobs: 14_400,
    maxGpuJobs: 16,
    maxMemoryMiB: 8192,
    maxTokenCount: Number.MAX_SAFE_INTEGER,
    maxCostUsd: Number.MAX_SAFE_INTEGER,
  }),
});

function count(store, sql, code) {
  const result = store.query(sql);
  if (!result?.ok || result.rows.length !== 1) throw new Error(code);
  return Number(result.rows[0].count || 0);
}

export function inspectAutonomousResearchOneShotProtectedCampaign({
  store,
  campaignStore,
} = {}) {
  if (!store || !campaignStore) {
    throw new Error('autonomous_research_one_shot_protected_campaign_store_required');
  }
  const campaign = campaignStore.getCampaign(
    AUTONOMOUS_RESEARCH_ONE_SHOT_PROTECTED_CAMPAIGN_ID,
  );
  if (!campaign) throw new Error('autonomous_research_one_shot_protected_campaign_missing');
  const nodes = campaignStore.listNodes(campaign.campaignId);
  const failed = nodes.filter((node) => node.status === 'failed_terminal');
  const skipped = nodes.filter((node) => node.status === 'skipped');
  const active = nodes.filter((node) => ['leased', 'running'].includes(node.status));
  const escapedCampaignId = sqlText(campaign.campaignId);
  const escapedPaperId = sqlText(campaign.paperId);
  const resourceLeaseCount = count(store,
    `SELECT COUNT(*) AS count FROM automation_resource_leases
      WHERE campaign_id=${escapedCampaignId};`,
    'autonomous_research_one_shot_protected_resource_lease_count_failed');
  const waiterCount = count(store,
    `SELECT COUNT(*) AS count FROM automation_resource_waiters
      WHERE campaign_id=${escapedCampaignId};`,
    'autonomous_research_one_shot_protected_waiter_count_failed');
  const submissionCount = count(store,
    `SELECT COUNT(*) AS count FROM submissions WHERE slug=${escapedPaperId};`,
    'autonomous_research_one_shot_protected_submission_count_failed');
  const outboxCount = count(store,
    `SELECT COUNT(*) AS count FROM submission_outbox
      WHERE json_extract(payload_json,'$.paperId')=${escapedPaperId};`,
    'autonomous_research_one_shot_protected_outbox_count_failed');
  const ledgerCount = count(store,
    `SELECT COUNT(*) AS count FROM receipt_ledger
      WHERE json_extract(receipt_json,'$.campaignId')=${escapedCampaignId};`,
    'autonomous_research_one_shot_protected_ledger_count_failed');
  const logicalStateHash = hashRecord(
    'AutonomousResearchOneShotProtectedCampaignLogicalState',
    {
      campaign,
      nodes,
      resourceLeaseCount,
      waiterCount,
      submissionCount,
      outboxCount,
      ledgerCount,
    },
  );
  return Object.freeze({
    version: 1,
    campaignId: campaign.campaignId,
    status: campaign.status,
    failedTerminalNodeCount: failed.length,
    skippedNodeCount: skipped.length,
    activeNodeCount: active.length,
    nodeLeaseCount: nodes.filter((node) => node.leaseOwner !== null).length,
    resourceLeaseCount,
    waiterCount,
    failureClass: failed.length === 1 ? failed[0].failureClass : null,
    submissionCount,
    outboxCount,
    ledgerCount,
    logicalStateHash,
  });
}

export function buildAutonomousResearchOneShotCampaignExecutionBinding({
  codeProvenance,
  sourceExecutionSnapshot,
  protectedCampaignDefinition,
  datasetMounts,
  providerConfigurationHash,
  providerRuntimeBinding,
} = {}) {
  const options = AUTONOMOUS_RESEARCH_ONE_SHOT_CAMPAIGN_OPTIONS;
  const environmentProjection = Object.freeze({
    HEPTA_AUTONOMOUS_RESEARCH_CONTENT_MODE: 'deterministic-bounded',
  });
  const targetCampaignDefinition = Object.freeze({
    version: 1,
    campaignId: options.campaignId,
    paperId: options.paperId,
    objective: options.objective,
    protocolFamily: options.protocolFamily,
    revisionRounds: options.revisionRounds,
    refereeCount: options.refereeCount,
    requestedLaunchMode: options.requestedLaunchMode,
    effectiveLaunchMode: options.launchMode,
    localOnly: options.localOnly,
    humanSubjects: options.humanSubjects,
    privateData: options.privateData,
    unlimitedAggregateTokens: true,
    unlimitedAggregateCost: true,
    requireLaunchReady: options.requireLaunchReady,
    requireCampaignAbsentAtLaunch: options.requireCampaignAbsentAtLaunch,
    datasetMountsHash: hashRecord(
      'AutonomousResearchOneShotCampaignDatasetMounts',
      datasetMounts,
    ),
    worker: options.worker,
    budgets: options.budgets,
  });
  return Object.freeze({
    version: 1,
    codeProvenance,
    codeProvenanceHash:
      autonomousResearchOneShotCampaignCodeProvenanceHash(codeProvenance),
    sourceExecutionSnapshot,
    sourceExecutionSnapshotHash:
      autonomousResearchOneShotCampaignSourceExecutionSnapshotHash(sourceExecutionSnapshot),
    autonomousResearchProviderConfigurationHash: providerConfigurationHash,
    providerRuntimeBinding,
    providerRuntimeBindingHash:
      autonomousResearchOneShotProviderRuntimeBindingHash(providerRuntimeBinding),
    protectedCampaignDefinition,
    protectedCampaignFingerprintHash:
      autonomousResearchOneShotProtectedCampaignFingerprintHash(
        protectedCampaignDefinition,
      ),
    targetCampaignDefinition,
    targetCampaignDefinitionHash:
      autonomousResearchOneShotTargetCampaignDefinitionHash(targetCampaignDefinition),
    environmentProjection,
    preparationPolicy: Object.freeze({
      version: 1,
      mode: 'deterministic-bounded-offline-v1',
      contentMode: 'deterministic-bounded',
      providerFreeRequired: true,
      allowedExternalActionKinds: Object.freeze([]),
      forbiddenEnvironmentKeys:
        AUTONOMOUS_RESEARCH_ONE_SHOT_FORBIDDEN_PREPARE_ENVIRONMENT_KEYS,
      environmentProjectionHash:
        autonomousResearchOneShotCampaignEnvironmentProjectionHash(environmentProjection),
    }),
    campaignLaunchPolicy: Object.freeze({
      version: 1,
      createOnly: true,
      allowedRecoveryActions: Object.freeze(['status']),
      forbiddenActions: Object.freeze(['converge', 'resume']),
    }),
  });
}

export function projectAutonomousResearchCampaignTerminalResult(report) {
  const status = report?.campaign?.status || report?.status || null;
  if (status === 'completed' || status === 'autonomous_research_campaign_completed') {
    return Object.freeze({
      terminalStatus: 'completed',
      outcome: Object.freeze({ campaignStatus: status }),
    });
  }
  if (['failed', 'cancelled', 'stopped', 'autonomous_research_campaign_failed', 'autonomous_research_campaign_cancelled',
    'autonomous_research_campaign_stopped'].includes(status)) {
    return Object.freeze({
      terminalStatus: 'failed_terminal',
      outcome: Object.freeze({ campaignStatus: status }),
    });
  }
  throw new Error(`autonomous_research_one_shot_campaign_not_terminal:${status || 'unknown'}`);
}

export function inspectFixedAutonomousResearchOneShotCampaignPreflight(options = {}) {
  return inspectAutonomousResearchOneShotCampaignPreflight({
    ...options,
    inspectProtectedCampaign: inspectAutonomousResearchOneShotProtectedCampaign,
  });
}

export async function composeFixedAutonomousResearchOneShotCampaignAttempt({
  action = 'execute',
  workspaceRoot,
  root,
  runtimeRoot,
  controlRoot,
  datasetMounts,
  attemptId = null,
  environment = process.env,
  clock = { now: () => new Date() },
  codeProvenanceInspector = currentCodeProvenance,
  sourceSnapshotInspector = inspectWorkspaceExecutionSnapshot,
  providerCanaryRunner = runAutonomousResearchProviderCanaryPair,
  campaignAction = composeAutonomousResearchCampaignAction,
  journalRepositoryFactory = createCampaignOneShotAttemptJournalRepository,
  providerConfigurationResolver = resolveAutonomousResearchProviderConfiguration,
  providerRuntimeBindingInspector =
    inspectAutonomousResearchOneShotProviderRuntimeBinding,
  datasetAuthorityInspector = defaultDatasetAuthorityInspector,
  readOnlyStoreFactory = createReadOnlyPaperStore,
  campaignStoreFactory = createSqliteCampaignStore,
  nativeStoreSnapshotGuardFactory = undefined,
} = {}) {
  if (![...PREFLIGHT_ACTIONS, 'execute', 'status'].includes(action)
    || !workspaceRoot || !root || !runtimeRoot || !Array.isArray(datasetMounts)
    || !controlRoot) {
    throw new Error('autonomous_research_one_shot_campaign_fixed_composition_invalid');
  }
  if (PREFLIGHT_ACTIONS.has(action)) {
    return inspectFixedAutonomousResearchOneShotCampaignPreflight({
      action,
      workspaceRoot,
      root,
      runtimeRoot,
      controlRoot,
      datasetMounts,
      environment,
      clock,
      codeProvenanceInspector,
      sourceSnapshotInspector,
      providerConfigurationResolver,
      datasetAuthorityInspector,
      readOnlyStoreFactory,
      campaignStoreFactory,
      journalRepositoryFactory,
      ...(nativeStoreSnapshotGuardFactory
        ? { nativeStoreSnapshotGuardFactory } : {}),
    });
  }
  if (action === 'status') {
    const repository = journalRepositoryFactory({
      controlRoot,
      runtimeRoot,
      create: false,
      clock,
    });
    try {
      if (!attemptId) throw new Error('autonomous_research_one_shot_attempt_id_required');
      const inspection = repository.inspectHistoricalAttempt({ attemptId });
      if (!inspection) throw new Error('autonomous_research_one_shot_attempt_missing');
      return inspection;
    } finally {
      repository.close();
    }
  }

  const boundDatasetMounts = canonicalAutonomousResearchOneShotDatasetMounts(datasetMounts);
  const fixedEnvironment = fixedAutonomousResearchOneShotProviderEnvironment({
    runtimeRoot, environment,
  });
  const prepareEnvironment = fixedAutonomousResearchOneShotPrepareEnvironment({ runtimeRoot });
  const prepareSideEffectGuard = createAutonomousResearchOneShotPrepareSideEffectGuard();
  const providerConfiguration = providerConfigurationResolver({
    environment: fixedEnvironment,
  });
  if (providerConfiguration.autonomousResearchProviderConfigurationHash
    !== AUTONOMOUS_RESEARCH_ONE_SHOT_PROVIDER_CONFIGURATION_HASH) {
    throw new Error('autonomous_research_one_shot_provider_configuration_mismatch');
  }
  const inspectExecutionBinding = () => {
    const providerRuntimeBinding = providerRuntimeBindingInspector({
      providerConfiguration,
      environment: fixedEnvironment,
    });
    const store = readOnlyStoreFactory({ root, runtimeRoot });
    const campaignStore = campaignStoreFactory({ store, clock });
    let protectedCampaignDefinition;
    let targetCampaign;
    try {
      protectedCampaignDefinition = inspectAutonomousResearchOneShotProtectedCampaign({
        store,
        campaignStore,
      });
      targetCampaign = campaignStore.getCampaign(
        AUTONOMOUS_RESEARCH_ONE_SHOT_TARGET_CAMPAIGN_ID,
      );
    } finally {
      store.close();
    }
    if (targetCampaign) {
      throw new Error('autonomous_research_one_shot_target_campaign_already_exists');
    }
    const codeProvenance = codeProvenanceInspector({
      workspaceRoot,
      allowReleaseCommitEnvironment: false,
    });
    if (codeProvenance?.treeDirty !== false) {
      throw new Error(
        'autonomous_research_one_shot_source_snapshot_blocked:dirty_git_worktree',
      );
    }
    const snapshot = sourceSnapshotInspector(workspaceRoot, {
      excludeNames: sourceTreeExcludedNames(workspaceRoot),
    });
    if (snapshot.blockers?.length) {
      throw new Error(`autonomous_research_one_shot_source_snapshot_blocked:${snapshot.blockers.join(',')}`);
    }
    const sourceExecutionSnapshot = Object.freeze({
      version: 1,
      merkleHash: snapshot.merkleHash,
      manifestHash: snapshot.manifestHash,
    });
    return buildAutonomousResearchOneShotCampaignExecutionBinding({
      codeProvenance,
      sourceExecutionSnapshot,
      protectedCampaignDefinition,
      datasetMounts: boundDatasetMounts,
      providerConfigurationHash:
        providerConfiguration.autonomousResearchProviderConfigurationHash,
      providerRuntimeBinding,
    });
  };
  const executionBinding = inspectExecutionBinding();
  const idempotencyKey =
    autonomousResearchOneShotCampaignAttemptIdempotencyKey(executionBinding);
  const candidateReservation = buildAutonomousResearchOneShotCampaignAttemptReservation({
    attemptId: `campaign-57-${idempotencyKey.slice(-24)}`,
    idempotencyKey,
    campaignId: AUTONOMOUS_RESEARCH_ONE_SHOT_TARGET_CAMPAIGN_ID,
    protectedCampaignId: AUTONOMOUS_RESEARCH_ONE_SHOT_PROTECTED_CAMPAIGN_ID,
    executionBinding,
    reservedAt: clock.now().toISOString(),
  });
  const repository = journalRepositoryFactory({
    controlRoot,
    runtimeRoot,
    create: true,
    clock,
  });
  try {
    const existing = repository.inspectAttempt({ idempotencyKey });
    const reservation = selectAutonomousResearchOneShotCampaignAttemptReservation({
      existing,
      candidateReservation,
    });
    const executionBindingFence =
      createAutonomousResearchOneShotCampaignExecutionBindingFence({
        expectedExecutionBinding: reservation.executionBinding,
        inspectCurrentExecutionBinding: inspectExecutionBinding,
      });
    const budgetWaiver = resolveAutonomousResearchDirectLocalRunBudgetWaiver({
      launchMode: AUTONOMOUS_RESEARCH_ONE_SHOT_CAMPAIGN_OPTIONS.requestedLaunchMode,
      campaignId: AUTONOMOUS_RESEARCH_ONE_SHOT_TARGET_CAMPAIGN_ID,
      paperId: AUTONOMOUS_RESEARCH_ONE_SHOT_TARGET_PAPER_ID,
      unlimitedTokens: true,
      unlimitedCost: true,
    });
    const campaignArguments = Object.freeze({
      launchMode: AUTONOMOUS_RESEARCH_ONE_SHOT_CAMPAIGN_OPTIONS.launchMode,
      localOnly: true,
      directLocalRunBudgetWaiver: budgetWaiver.waiver,
      directLocalRunCliProvenance: budgetWaiver.provenance,
      paperId: AUTONOMOUS_RESEARCH_ONE_SHOT_TARGET_PAPER_ID,
      campaignId: AUTONOMOUS_RESEARCH_ONE_SHOT_TARGET_CAMPAIGN_ID,
      objective: AUTONOMOUS_RESEARCH_ONE_SHOT_TARGET_OBJECTIVE,
      protocolFamily: AUTONOMOUS_RESEARCH_ONE_SHOT_CAMPAIGN_OPTIONS.protocolFamily,
      root,
      runtimeRoot,
      datasetMounts: boundDatasetMounts,
      revisionRounds: 3,
      refereeCount: 3,
      budgets: AUTONOMOUS_RESEARCH_ONE_SHOT_CAMPAIGN_OPTIONS.budgets,
      humanSubjects: false,
      privateData: false,
      worker: AUTONOMOUS_RESEARCH_ONE_SHOT_CAMPAIGN_OPTIONS.worker,
    });
    return await composeAutonomousResearchOneShotCampaignAttempt({
      repository,
      reservation,
      async inspectPreconditions() {
        return Object.freeze({ evidence: Object.freeze({
          protectedCampaignFingerprintHash:
            executionBinding.protectedCampaignFingerprintHash,
          targetCampaignDefinitionHash: executionBinding.targetCampaignDefinitionHash,
          sourceExecutionSnapshotHash: executionBinding.sourceExecutionSnapshotHash,
          codeProvenanceHash: executionBinding.codeProvenanceHash,
        }) });
      },
      async prepareCampaign() {
        const report = await campaignAction({
          ...campaignArguments, action: 'prepare', environment: prepareEnvironment,
          assertExternalSideEffectReady: prepareSideEffectGuard,
        });
        if (report?.autonomousExecutionLaunchReady !== true) {
          throw new Error('autonomous_research_one_shot_prepare_not_launch_ready');
        }
        return Object.freeze({ evidence: Object.freeze({
          autonomousExecutionLaunchReady: true,
          proposalHash: report.proposal?.machineProposedScientificClaimSetHash || null,
        }) });
      },
      async assertProviderActionReady() {
        executionBindingFence.assertCurrent({ phase: 'pre_provider' });
      },
      async executeProviderAction({ inspection }) {
        const sideEffectGate = createAutonomousResearchOneShotExternalActionGate({
          repository, transition: inspection, executionBindingFence,
          phase: 'provider_started',
        });
        sideEffectGate.assertCurrent();
        const receipt = await providerCanaryRunner({
          providerConfiguration,
          expectedProviderConfigurationHash:
            AUTONOMOUS_RESEARCH_ONE_SHOT_PROVIDER_CONFIGURATION_HASH,
          environment: fixedEnvironment,
          clock,
          beforePreflightAction: sideEffectGate,
          beforeCanaryAction: sideEffectGate, beforeModelInvocation: sideEffectGate.assertCurrent,
          betweenCanaryChecks: sideEffectGate,
          onExternalSideEffectStarted: sideEffectGate,
        });
        assertAutonomousResearchOneShotProviderCanaryReceiptBound({
          receipt,
          expectedProviderConfigurationHash:
            reservation.executionBinding.autonomousResearchProviderConfigurationHash,
          expectedProviderRuntimeBinding:
            reservation.executionBinding.providerRuntimeBinding,
          now: clock.now(),
        });
        sideEffectGate.assertCurrent();
        return Object.freeze({ evidence: Object.freeze({
          providerCanaryPairReceiptHash: receipt.providerCanaryPairReceiptHash,
        }) });
      },
      async assertLaunchActionReady() {
        executionBindingFence.assertCurrent({ phase: 'pre_launch' });
      },
      async launchCampaign({ inspection }) {
        const sideEffectGate = createAutonomousResearchOneShotExternalActionGate({
          repository, transition: inspection, executionBindingFence,
          phase: 'launch_started',
        });
        sideEffectGate.assertCurrent();
        const report = await campaignAction({
          ...campaignArguments,
          action: 'launch',
          environment: fixedEnvironment,
          assertExternalSideEffectReady: sideEffectGate,
          requireCampaignAbsentAtLaunch: true,
        });
        return projectAutonomousResearchCampaignTerminalResult(report);
      },
      async inspectLaunchOutcome() {
        const report = await campaignAction({
          ...campaignArguments,
          action: 'status',
          environment: fixedEnvironment,
        });
        const status = report?.campaign?.status || report?.status || null;
        if (!['completed', 'failed', 'cancelled'].includes(status)) {
          return Object.freeze({ terminal: false });
        }
        return Object.freeze({
          terminal: true,
          ...projectAutonomousResearchCampaignTerminalResult(report),
        });
      },
    });
  } finally {
    repository.close();
  }
}
