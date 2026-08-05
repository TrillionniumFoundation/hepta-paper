import {
  AUTONOMOUS_RESEARCH_ONE_SHOT_FORBIDDEN_PREPARE_ENVIRONMENT_KEYS,
  AUTONOMOUS_RESEARCH_ONE_SHOT_PROTECTED_CAMPAIGN_ID,
  AUTONOMOUS_RESEARCH_ONE_SHOT_PROVIDER_CONFIGURATION_HASH,
  AUTONOMOUS_RESEARCH_ONE_SHOT_TARGET_CAMPAIGN_ID,
  AUTONOMOUS_RESEARCH_ONE_SHOT_TARGET_DATASET_MOUNTS_HASH,
  AUTONOMOUS_RESEARCH_ONE_SHOT_TARGET_OBJECTIVE,
  AUTONOMOUS_RESEARCH_ONE_SHOT_TARGET_PAPER_ID,
  autonomousResearchOneShotCampaignCodeProvenanceHash,
  autonomousResearchOneShotCampaignEnvironmentProjectionHash,
  autonomousResearchOneShotCampaignSourceExecutionSnapshotHash,
  autonomousResearchOneShotProtectedCampaignFingerprintHash,
  autonomousResearchOneShotProviderRuntimeBindingHash,
  autonomousResearchOneShotTargetCampaignDefinitionHash,
} from '../../../paper-domain/automation/autonomous-research-one-shot-campaign-attempt.mjs';
import { hashRecord } from '../../../workflow-kernel/record-hash.mjs';

const H = (label) => hashRecord(
  'AutonomousResearchOneShotCampaignAttemptTestHash',
  { label },
);

export function providerRuntimeBinding() {
  return {
    version: 2,
    kind: 'AutonomousResearchOneShotProviderRuntimeBinding',
    providerConfigurationHash:
      AUTONOMOUS_RESEARCH_ONE_SHOT_PROVIDER_CONFIGURATION_HASH,
    researchAuthorCapabilityReceiptHash: H('author-capability'),
    formalReviewerCapabilityReceiptHash: H('reviewer-capability'),
    researchAuthorCredentialConfigIdentityHash: H('author-config'),
    formalReviewerCredentialConfigIdentityHash: H('reviewer-config'),
    researchAuthorOpenClawManagedAuthProfileIdentityHash: H('author-profile'),
    formalReviewerOpenClawManagedAuthProfileIdentityHash: H('reviewer-profile'),
    openClawManagedAuthBindingMode: 'user-locked-profile',
    openClawManagedGatewayRouteIdentityHash: null,
    openClawManagedRuntimeProvenanceHash: H('managed-runtime'),
    openClawManagedAuthSourceIdentityHash: H('managed-auth-source'),
  };
}

export function gatewayProviderRuntimeBinding() {
  return {
    ...providerRuntimeBinding(),
    researchAuthorOpenClawManagedAuthProfileIdentityHash: null,
    formalReviewerOpenClawManagedAuthProfileIdentityHash: null,
    openClawManagedAuthBindingMode: 'current-agent-gateway-oauth-route',
    openClawManagedGatewayRouteIdentityHash: H('managed-gateway-route'),
  };
}

export function legacyProviderRuntimeBinding() {
  const binding = Object.fromEntries(
    Object.entries(providerRuntimeBinding()).filter(([key]) => ![
      'openClawManagedAuthBindingMode',
      'openClawManagedGatewayRouteIdentityHash',
    ].includes(key)),
  );
  return { ...binding, version: 1 };
}

export function executionBinding() {
  const codeProvenance = {
    version: 2,
    kind: 'CodeProvenance',
    packageVersion: '0.21.0',
    commit: 'a'.repeat(40),
    commitTree: 'b'.repeat(40),
    tags: [],
    treeDirty: false,
    indexStateHash: H('index'),
    repositoryEntryCount: 2_000,
    repositoryContentHash: H('repository'),
    worktreeStateHash: H('worktree'),
    evidenceEnvironment: 'production',
    evidenceClass: 'runtime_unclassified',
  };
  const sourceExecutionSnapshot = {
    version: 1,
    merkleHash: H('merkle'),
    manifestHash: H('manifest'),
  };
  const protectedCampaignDefinition = {
    version: 1,
    campaignId: AUTONOMOUS_RESEARCH_ONE_SHOT_PROTECTED_CAMPAIGN_ID,
    status: 'failed',
    failedTerminalNodeCount: 1,
    skippedNodeCount: 65,
    activeNodeCount: 0,
    nodeLeaseCount: 0,
    resourceLeaseCount: 0,
    waiterCount: 0,
    failureClass: 'agent_usage_unknown_terminal',
    submissionCount: 0,
    outboxCount: 0,
    ledgerCount: 0,
    logicalStateHash: H('protected-logical-state'),
  };
  const targetCampaignDefinition = {
    version: 1,
    campaignId: AUTONOMOUS_RESEARCH_ONE_SHOT_TARGET_CAMPAIGN_ID,
    paperId: AUTONOMOUS_RESEARCH_ONE_SHOT_TARGET_PAPER_ID,
    objective: AUTONOMOUS_RESEARCH_ONE_SHOT_TARGET_OBJECTIVE,
    protocolFamily: 'finance_asset_pricing_benchmark',
    revisionRounds: 3,
    refereeCount: 3,
    requestedLaunchMode: 'local-run',
    effectiveLaunchMode: 'golden-bootstrap',
    localOnly: true,
    humanSubjects: false,
    privateData: false,
    unlimitedAggregateTokens: true,
    unlimitedAggregateCost: true,
    requireLaunchReady: true,
    requireCampaignAbsentAtLaunch: true,
    datasetMountsHash: AUTONOMOUS_RESEARCH_ONE_SHOT_TARGET_DATASET_MOUNTS_HASH,
    worker: {
      concurrency: 8,
      agentSlots: 4,
      cpuSlots: 4,
      gpuSlots: 1,
      memoryMiB: 8192,
    },
    budgets: {
      maxWallTimeMs: 7_200_000,
      maxAgentCalls: 201,
      maxCpuJobs: 14_400,
      maxGpuJobs: 16,
      maxMemoryMiB: 8192,
      maxTokenCount: Number.MAX_SAFE_INTEGER,
      maxCostUsd: Number.MAX_SAFE_INTEGER,
    },
  };
  const environmentProjection = {
    HEPTA_AUTONOMOUS_RESEARCH_CONTENT_MODE: 'deterministic-bounded',
  };
  const runtimeBinding = providerRuntimeBinding();
  return {
    version: 1,
    codeProvenance,
    codeProvenanceHash:
      autonomousResearchOneShotCampaignCodeProvenanceHash(codeProvenance),
    sourceExecutionSnapshot,
    sourceExecutionSnapshotHash:
      autonomousResearchOneShotCampaignSourceExecutionSnapshotHash(
        sourceExecutionSnapshot,
      ),
    autonomousResearchProviderConfigurationHash:
      AUTONOMOUS_RESEARCH_ONE_SHOT_PROVIDER_CONFIGURATION_HASH,
    providerRuntimeBinding: runtimeBinding,
    providerRuntimeBindingHash:
      autonomousResearchOneShotProviderRuntimeBindingHash(runtimeBinding),
    protectedCampaignDefinition,
    protectedCampaignFingerprintHash:
      autonomousResearchOneShotProtectedCampaignFingerprintHash(
        protectedCampaignDefinition,
      ),
    targetCampaignDefinition,
    targetCampaignDefinitionHash:
      autonomousResearchOneShotTargetCampaignDefinitionHash(targetCampaignDefinition),
    environmentProjection,
    preparationPolicy: {
      version: 1,
      mode: 'deterministic-bounded-offline-v1',
      contentMode: 'deterministic-bounded',
      providerFreeRequired: true,
      allowedExternalActionKinds: [],
      forbiddenEnvironmentKeys:
        AUTONOMOUS_RESEARCH_ONE_SHOT_FORBIDDEN_PREPARE_ENVIRONMENT_KEYS,
      environmentProjectionHash:
        autonomousResearchOneShotCampaignEnvironmentProjectionHash(environmentProjection),
    },
    campaignLaunchPolicy: {
      version: 1,
      createOnly: true,
      allowedRecoveryActions: ['status'],
      forbiddenActions: ['converge', 'resume'],
    },
  };
}
