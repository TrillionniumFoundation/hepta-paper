import path from 'node:path';

import {
  AUTONOMOUS_RESEARCH_ONE_SHOT_FORBIDDEN_PREPARE_ENVIRONMENT_KEYS,
  AUTONOMOUS_RESEARCH_ONE_SHOT_CAMPAIGN_ATTEMPT_PHASES,
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
  verifyAutonomousResearchOneShotCampaignAttemptReservation,
} from '../../paper-domain/automation/autonomous-research-one-shot-campaign-attempt.mjs';
import {
  createCampaignOneShotAttemptJournalRepository,
} from '../../paper-adapters/automation/campaign-one-shot-attempt-journal-repository.mjs';
import { currentCodeProvenance } from '../../paper-adapters/runtime/code-provenance.mjs';
import { preflightCodexResearchAuthor } from '../../paper-adapters/automation/codex-research-author-preflight.mjs';
import { preflightCodexFormalReviewer } from '../../paper-adapters/automation/codex-formal-reviewer-preflight.mjs';
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

const PHASES = new Set(AUTONOMOUS_RESEARCH_ONE_SHOT_CAMPAIGN_ATTEMPT_PHASES);

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

export function fixedAutonomousResearchOneShotProviderEnvironment({
  runtimeRoot,
  environment = {},
} = {}) {
  if (!runtimeRoot) {
    throw new Error('autonomous_research_one_shot_runtime_root_required');
  }
  const managedProviderRoot = path.join(
    path.dirname(path.resolve(runtimeRoot)),
    'openclaw-managed-codex',
  );
  const codexBinary = path.join(
    path.resolve(runtimeRoot),
    'local-run',
    'bin',
    'codex-openclaw-managed',
  );
  return Object.freeze({
    ...environment,
    HEPTA_RESEARCH_AUTHOR_PROVIDER: 'codex',
    HEPTA_RESEARCH_AUTHOR_CODEX_BINARY: codexBinary,
    HEPTA_RESEARCH_AUTHOR_CODEX_HOME: path.join(managedProviderRoot, 'research-author'),
    HEPTA_RESEARCH_AUTHOR_MODEL: 'gpt-5.6-sol',
    HEPTA_FORMAL_REVIEW_PROVIDER: 'codex',
    HEPTA_FORMAL_REVIEW_CODEX_BINARY: codexBinary,
    HEPTA_FORMAL_REVIEW_CODEX_HOME: path.join(managedProviderRoot, 'formal-reviewer'),
    HEPTA_FORMAL_REVIEW_MODEL: 'gpt-5.6-sol',
  });
}

function requireFunction(value, code) {
  if (typeof value !== 'function') throw new Error(code);
  return value;
}

function evidenceFromResult(result, code) {
  if (!result || typeof result !== 'object' || Array.isArray(result)
    || !Object.hasOwn(result, 'evidence')) throw new Error(code);
  return result.evidence;
}

function terminalResult(result) {
  if (!result || typeof result !== 'object' || Array.isArray(result)
    || !['completed', 'failed_terminal'].includes(result.terminalStatus)) {
    throw new Error('autonomous_research_one_shot_campaign_launch_result_invalid');
  }
  return Object.freeze({
    terminalStatus: result.terminalStatus,
    outcome: Object.hasOwn(result, 'outcome') ? result.outcome : null,
  });
}

function currentHead(inspection) {
  const head = inspection?.events?.at(-1);
  if (!head || !PHASES.has(head.phase)) {
    throw new Error('autonomous_research_one_shot_campaign_attempt_head_invalid');
  }
  return head;
}

function append(repository, inspection, phase, evidence) {
  const head = currentHead(inspection);
  return repository.appendEvent({
    attemptId: inspection.reservation.attemptId,
    phase,
    evidence,
    expectedSequence: head.sequence + 1,
    expectedPhase: head.phase,
    expectedPreviousEventHash:
      head.autonomousResearchOneShotCampaignAttemptEventHash,
  });
}

function finalize(repository, inspection, terminalStatus, outcome) {
  const head = currentHead(inspection);
  return repository.finalizeAttempt({
    attemptId: inspection.reservation.attemptId,
    terminalStatus,
    outcome,
    expectedSequence: head.sequence + 1,
    expectedPhase: head.phase,
    expectedPreviousEventHash:
      head.autonomousResearchOneShotCampaignAttemptEventHash,
  });
}

function failureOutcome(error, phase) {
  return Object.freeze({
    version: 1,
    kind: 'AutonomousResearchOneShotCampaignAttemptFailure',
    phase,
    errorCode: String(error?.code || error?.message || 'unknown_error').slice(0, 1024),
  });
}

function terminalStatusForFailure(phase) {
  if (['attempt_reserved', 'preconditions_verified', 'prepare_verified'].includes(phase)) {
    return 'blocked_pre_provider';
  }
  if (phase === 'provider_completed') return 'blocked_post_provider';
  if (['provider_started', 'launch_started'].includes(phase)) {
    return 'recovered_incomplete';
  }
  throw new Error('autonomous_research_one_shot_campaign_failure_phase_invalid');
}

function terminalReport(inspection) {
  return Object.freeze({
    version: 1,
    kind: 'AutonomousResearchOneShotCampaignAttemptCompositionReport',
    status: 'autonomous_research_one_shot_campaign_attempt_terminal',
    inspection,
    terminalReceipt: inspection.terminalReceipt,
  });
}

export async function composeAutonomousResearchOneShotCampaignAttempt({
  repository,
  reservation,
  inspectPreconditions,
  prepareCampaign,
  executeProviderAction,
  launchCampaign,
  inspectLaunchOutcome,
} = {}) {
  if (!repository || repository.kind !== 'CampaignOneShotAttemptJournalRepository'
    || !verifyAutonomousResearchOneShotCampaignAttemptReservation(reservation)) {
    throw new Error('autonomous_research_one_shot_campaign_attempt_composition_invalid');
  }
  requireFunction(inspectPreconditions,
    'autonomous_research_one_shot_campaign_preconditions_inspector_required');
  requireFunction(prepareCampaign,
    'autonomous_research_one_shot_campaign_prepare_action_required');
  requireFunction(executeProviderAction,
    'autonomous_research_one_shot_campaign_provider_action_required');
  requireFunction(launchCampaign,
    'autonomous_research_one_shot_campaign_launch_action_required');
  requireFunction(inspectLaunchOutcome,
    'autonomous_research_one_shot_campaign_launch_inspector_required');

  let inspection = repository.reserveAttempt({ reservation });
  if (inspection.terminalReceipt) return terminalReport(inspection);

  while (!inspection.terminalReceipt) {
    const phase = inspection.headPhase;
    try {
      if (phase === 'attempt_reserved') {
        const result = await inspectPreconditions({ reservation, inspection });
        inspection = append(repository, inspection, 'preconditions_verified',
          evidenceFromResult(result,
            'autonomous_research_one_shot_campaign_preconditions_result_invalid'));
        continue;
      }
      if (phase === 'preconditions_verified') {
        const result = await prepareCampaign({ reservation, inspection });
        inspection = append(repository, inspection, 'prepare_verified',
          evidenceFromResult(result,
            'autonomous_research_one_shot_campaign_prepare_result_invalid'));
        continue;
      }
      if (phase === 'prepare_verified') {
        const transition = append(repository, inspection, 'provider_started', {
          action: 'provider',
          status: 'external_action_marker_committed',
        });
        repository.assertExternalActionSideEffectPermit({ transition });
        inspection = transition;
        const result = await executeProviderAction({ reservation, inspection });
        inspection = append(repository, inspection, 'provider_completed',
          evidenceFromResult(result,
            'autonomous_research_one_shot_campaign_provider_result_invalid'));
        continue;
      }
      if (phase === 'provider_started') {
        inspection = finalize(repository, inspection, 'recovered_incomplete', {
          version: 1,
          kind: 'AutonomousResearchOneShotCampaignAttemptRecovery',
          recoveryDisposition: inspection.recoveryDisposition.status,
        });
        continue;
      }
      if (phase === 'provider_completed') {
        const transition = append(repository, inspection, 'launch_started', {
          action: 'launch',
          status: 'external_action_marker_committed',
        });
        repository.assertExternalActionSideEffectPermit({ transition });
        inspection = transition;
        const result = terminalResult(await launchCampaign({ reservation, inspection }));
        inspection = finalize(repository, inspection, result.terminalStatus, result.outcome);
        continue;
      }
      if (phase === 'launch_started') {
        const observed = await inspectLaunchOutcome({ reservation, inspection });
        if (observed === null || observed?.terminal === false) {
          return Object.freeze({
            version: 1,
            kind: 'AutonomousResearchOneShotCampaignAttemptCompositionReport',
            status: 'autonomous_research_one_shot_campaign_attempt_monitor_only',
            inspection,
            terminalReceipt: null,
          });
        }
        const result = terminalResult(observed);
        inspection = finalize(repository, inspection, result.terminalStatus, result.outcome);
        continue;
      }
      throw new Error(`autonomous_research_one_shot_campaign_phase_unsupported:${phase}`);
    } catch (error) {
      const latest = repository.inspectAttempt({
        attemptId: inspection.reservation.attemptId,
      });
      if (latest?.terminalReceipt) return terminalReport(latest);
      const failurePhase = latest?.headPhase || phase;
      const terminalStatus = terminalStatusForFailure(failurePhase);
      const terminal = finalize(repository, latest, terminalStatus,
        failureOutcome(error, failurePhase));
      return terminalReport(terminal);
    }
  }
  return terminalReport(inspection);
}

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

export function inspectAutonomousResearchOneShotProviderRuntimeBinding({
  providerConfiguration,
  environment,
  preflightAuthor = preflightCodexResearchAuthor,
  preflightReviewer = preflightCodexFormalReviewer,
} = {}) {
  const author = preflightAuthor({
    ...providerConfiguration.researchAuthor,
    environment,
  });
  const reviewer = preflightReviewer({
    ...providerConfiguration.formalReviewer,
    authorProvider: providerConfiguration.researchAuthor.provider,
    authorCodexHome: author.codexHome,
    environment,
  });
  const authorReceipt = author.capabilityReceipt;
  const reviewerReceipt = reviewer.capabilityReceipt;
  if (!authorReceipt || !reviewerReceipt
    || authorReceipt.openClawManagedRuntimeProvenanceHash
      !== reviewerReceipt.openClawManagedRuntimeProvenanceHash
    || authorReceipt.openClawManagedAuthSourceIdentityHash
      !== reviewerReceipt.openClawManagedAuthSourceIdentityHash) {
    throw new Error('autonomous_research_one_shot_provider_runtime_binding_invalid');
  }
  return Object.freeze({
    version: 1,
    kind: 'AutonomousResearchOneShotProviderRuntimeBinding',
    providerConfigurationHash:
      providerConfiguration.autonomousResearchProviderConfigurationHash,
    researchAuthorCapabilityReceiptHash:
      authorReceipt.codexResearchAuthorCapabilityReceiptHash,
    formalReviewerCapabilityReceiptHash:
      reviewerReceipt.codexFormalReviewerCapabilityReceiptHash,
    researchAuthorCredentialConfigIdentityHash:
      authorReceipt.credentialConfigIdentityHash,
    formalReviewerCredentialConfigIdentityHash:
      reviewerReceipt.credentialConfigIdentityHash,
    researchAuthorOpenClawManagedAuthProfileIdentityHash:
      authorReceipt.openClawManagedAuthProfileIdentityHash,
    formalReviewerOpenClawManagedAuthProfileIdentityHash:
      reviewerReceipt.openClawManagedAuthProfileIdentityHash,
    openClawManagedRuntimeProvenanceHash:
      authorReceipt.openClawManagedRuntimeProvenanceHash,
    openClawManagedAuthSourceIdentityHash:
      authorReceipt.openClawManagedAuthSourceIdentityHash,
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
  readOnlyStoreFactory = createReadOnlyPaperStore,
  campaignStoreFactory = createSqliteCampaignStore,
} = {}) {
  if (!['execute', 'status'].includes(action) || !workspaceRoot || !root
    || !runtimeRoot || !controlRoot || !Array.isArray(datasetMounts)) {
    throw new Error('autonomous_research_one_shot_campaign_fixed_composition_invalid');
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
      const inspection = repository.inspectAttempt({ attemptId });
      if (!inspection) throw new Error('autonomous_research_one_shot_attempt_missing');
      return inspection;
    } finally {
      repository.close();
    }
  }

  const fixedEnvironment = fixedAutonomousResearchOneShotProviderEnvironment({
    runtimeRoot,
    environment,
  });
  const providerConfiguration = providerConfigurationResolver({
    environment: fixedEnvironment,
  });
  if (providerConfiguration.autonomousResearchProviderConfigurationHash
    !== AUTONOMOUS_RESEARCH_ONE_SHOT_PROVIDER_CONFIGURATION_HASH) {
    throw new Error('autonomous_research_one_shot_provider_configuration_mismatch');
  }
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
  const executionBinding = buildAutonomousResearchOneShotCampaignExecutionBinding({
    codeProvenance,
    sourceExecutionSnapshot,
    protectedCampaignDefinition,
    datasetMounts,
    providerConfigurationHash:
      providerConfiguration.autonomousResearchProviderConfigurationHash,
    providerRuntimeBinding,
  });
  const idempotencyKey = hashRecord(
    'AutonomousResearchOneShotCampaignAttemptIdempotencyKey',
    {
      campaignId: AUTONOMOUS_RESEARCH_ONE_SHOT_TARGET_CAMPAIGN_ID,
      codeProvenanceHash: executionBinding.codeProvenanceHash,
      sourceExecutionSnapshotHash: executionBinding.sourceExecutionSnapshotHash,
      targetCampaignDefinitionHash: executionBinding.targetCampaignDefinitionHash,
      providerRuntimeBindingHash: executionBinding.providerRuntimeBindingHash,
    },
  );
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
    const reservation = existing?.reservation || candidateReservation;
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
      datasetMounts,
      revisionRounds: 3,
      refereeCount: 3,
      budgets: AUTONOMOUS_RESEARCH_ONE_SHOT_CAMPAIGN_OPTIONS.budgets,
      humanSubjects: false,
      privateData: false,
      environment: fixedEnvironment,
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
        const report = await campaignAction({ ...campaignArguments, action: 'prepare' });
        if (report?.autonomousExecutionLaunchReady !== true) {
          throw new Error('autonomous_research_one_shot_prepare_not_launch_ready');
        }
        return Object.freeze({ evidence: Object.freeze({
          autonomousExecutionLaunchReady: true,
          proposalHash: report.proposal?.machineProposedScientificClaimSetHash || null,
        }) });
      },
      async executeProviderAction() {
        const receipt = await providerCanaryRunner({
          providerConfiguration,
          expectedProviderConfigurationHash:
            AUTONOMOUS_RESEARCH_ONE_SHOT_PROVIDER_CONFIGURATION_HASH,
          environment: fixedEnvironment,
          clock,
        });
        return Object.freeze({ evidence: Object.freeze({
          providerCanaryPairReceiptHash: receipt.providerCanaryPairReceiptHash,
        }) });
      },
      async launchCampaign() {
        const report = await campaignAction({
          ...campaignArguments,
          action: 'launch',
          requireCampaignAbsentAtLaunch: true,
        });
        return projectAutonomousResearchCampaignTerminalResult(report);
      },
      async inspectLaunchOutcome() {
        const report = await campaignAction({
          ...campaignArguments,
          action: 'status',
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
