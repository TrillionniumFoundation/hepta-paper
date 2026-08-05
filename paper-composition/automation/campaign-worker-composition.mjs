import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createCodexAgentExecutor } from '../../paper-adapters/automation/codex-agent-executor.mjs';
import { preflightCodexFormalReviewer } from '../../paper-adapters/automation/codex-formal-reviewer-preflight.mjs';
import { preflightCodexResearchAuthor } from '../../paper-adapters/automation/codex-research-author-preflight.mjs';
import { createOllamaStructuredAgentExecutor } from '../../paper-adapters/automation/ollama-structured-agent-executor.mjs';
import { preflightLocalOllamaResearchAgent } from '../../paper-adapters/automation/ollama-local-agent-preflight.mjs';
import { createOpenClawAgentExecutor } from '../../paper-adapters/automation/openclaw-agent-executor.mjs';
import { createAgentBackendRouter } from '../../paper-adapters/automation/agent-backend-router.mjs';
import { createIsolatedAgentExecutor } from '../../paper-adapters/automation/isolated-agent-executor.mjs';
import {
  authorizeOperatorDatasetMount,
  loadOperatorDatasetAuthorityTrustStoreSync,
} from '../../paper-adapters/automation/operator-dataset-harness-reader.mjs';
import {
  buildRuntimeRetentionPlan,
  executeRuntimeRetentionPlan,
  reconcileRuntimeRetentionIntents,
} from '../../paper-adapters/automation/runtime-retention.mjs';
import { createCampaignNodeExecutor } from './campaign-node-execution-composition.mjs';
import { isCampaignRefereeNode } from '../../paper-application/automation/campaign-node-kind-policy.mjs';
import { resolveCampaignAgentProviderPolicy } from '../../paper-domain/automation/research-agent-provider-policy.mjs';
import {
  requireAutonomousResearchProviderConfiguration,
} from './autonomous-research-provider-configuration.mjs';
import {
  composeReviewerPrincipalExecutorPool,
  composeReviewerSessionExecutorPool,
} from './reviewer-principal-pool-composition.mjs';
import {
  buildAutonomousResearchReviewerSessionPrincipalPool,
  inspectAutonomousResearchAuthorRuntimeIdentity,
} from './autonomous-research-runtime-principal-preflight.mjs';
import {
  inspectCampaignPreparationPrincipalAuthorityBindings,
  requireCurrentCampaignWorkerPrincipalAuthority,
} from './campaign-worker-principal-authority-binding.mjs';
import {
  campaignDatasetContentHash,
  composeCampaignWorkerEmpiricalExecution,
} from './campaign-worker-empirical-composition.mjs';

export {
  authorizeOperatorDatasetMount,
  buildRuntimeRetentionPlan,
  campaignDatasetContentHash,
  executeRuntimeRetentionPlan,
  loadOperatorDatasetAuthorityTrustStoreSync,
  reconcileRuntimeRetentionIntents,
};

function discoverOllamaModel(options, spawnSyncImpl) {
  let model = options['ollama-model'] || (options['agent-provider'] === 'ollama' ? options.model : null) || null;
  if (model) return model;
  const tags = spawnSyncImpl('ollama', ['list'], { encoding: 'utf8', timeout: 5000 });
  model = String(tags.stdout || '').split(/\n/).slice(1)
    .map((line) => line.trim().split(/\s+/)[0])
    .find((name) => name && !/embed/i.test(name)) || null;
  return model;
}

function configuredValue(...candidates) {
  return candidates.map((candidate) => String(candidate || '').trim()).find(Boolean) || undefined;
}

export function resolveCampaignWorkerModelConfiguration({
  options = {},
  environment = {},
} = {}) {
  return Object.freeze({
    researchAuthorModel: configuredValue(options.model, environment.HEPTA_RESEARCH_AUTHOR_MODEL),
    formalReviewModel: configuredValue(options['formal-review-model'], environment.HEPTA_FORMAL_REVIEW_MODEL),
  });
}

export function composeCampaignWorkerExecution({
  options = {},
  plans = [],
  runtimeRoot,
  datasetMounts = [],
  workspaceRegistry,
  campaignExecutionContext,
  services,
  spawnSyncImpl = spawnSync,
  environment = {},
  providerConfiguration = null,
  expectedProviderConfigurationHash = null,
  reviewerPrincipalExecutorPool = null,
  preflightResearchAuthor = preflightCodexResearchAuthor,
  preflightFormalReviewer = preflightCodexFormalReviewer,
  preflightLocalOllamaAgent = preflightLocalOllamaResearchAgent,
  reviewerPrincipalPoolComposer = composeReviewerPrincipalExecutorPool,
  reviewerSessionPoolComposer = composeReviewerSessionExecutorPool,
  assertExternalSideEffectReady = null,
} = {}) {
  if (!runtimeRoot || !campaignExecutionContext || !services) {
    throw new Error('campaign_worker_composition_inputs_required');
  }
  if (plans.some((plan) => plan?.autonomousResearchPreparation
    && !plan.autonomousResearchPreparation.autonomousResearchProviderConfigurationHash)) {
    throw new Error('autonomous_research_provider_configuration_binding_required');
  }
  const planProviderConfigurationHashes = [...new Set(plans
    .map((plan) => plan?.autonomousResearchPreparation
      ?.autonomousResearchProviderConfigurationHash)
    .filter(Boolean))];
  if (planProviderConfigurationHashes.length > 1
    || (expectedProviderConfigurationHash && planProviderConfigurationHashes[0]
      && expectedProviderConfigurationHash !== planProviderConfigurationHashes[0])) {
    throw new Error('autonomous_research_provider_configuration_hash_mismatch');
  }
  const expectedHash = expectedProviderConfigurationHash
    || planProviderConfigurationHashes[0]
    || null;
  const localOnlyCampaign = plans.length > 0
    && plans.every((plan) => plan?.localOnly === true);
  const boundProviderConfiguration = providerConfiguration
    ? requireAutonomousResearchProviderConfiguration(providerConfiguration, {
      expectedHash,
      allowLocalOnlyOllama: localOnlyCampaign,
    })
    : null;
  if (expectedHash && !boundProviderConfiguration) {
    throw new Error('autonomous_research_provider_configuration_required');
  }
  const { empiricalExecutor, workerRunner, runtimeImages } =
    composeCampaignWorkerEmpiricalExecution({
      options,
      plans,
      runtimeRoot,
      datasetMounts,
      operatorDatasetAuthorityTrustStore:
        loadOperatorDatasetAuthorityTrustStoreSync({ runtimeRoot }),
    });
  const researchAuthorProviderPolicy = resolveCampaignAgentProviderPolicy({
    requestedProvider: boundProviderConfiguration?.researchAuthor.provider
      || configuredValue(
        options['agent-provider'],
        environment.HEPTA_RESEARCH_AUTHOR_PROVIDER,
        'auto',
      ),
    plans,
  });
  const modelConfiguration = resolveCampaignWorkerModelConfiguration({ options, environment });
  const provider = researchAuthorProviderPolicy.selectedProvider;
  if (provider === 'ollama' && !localOnlyCampaign) {
    throw new Error('research_grade_agent_provider_not_approved:ollama');
  }
  const primaryOpenClawAgentId = options['openclaw-agent'] || 'hepta-paper-worker';
  const primaryCodexModel = boundProviderConfiguration
    ? boundProviderConfiguration.researchAuthor.model
    : modelConfiguration.researchAuthorModel;
  const openclaw = createOpenClawAgentExecutor({
    agentId: primaryOpenClawAgentId,
    model: primaryCodexModel || undefined,
  });
  const ollamaModel = ['auto', 'ollama'].includes(provider) ? discoverOllamaModel(options, spawnSyncImpl) : null;
  const primaryCodexHome = boundProviderConfiguration
    ? boundProviderConfiguration.researchAuthor.codexHome
    : configuredValue(
      options['codex-home'],
      environment.HEPTA_RESEARCH_AUTHOR_CODEX_HOME,
      environment.CODEX_HOME,
    )
      || null;
  const primaryCodexBinary = boundProviderConfiguration
    ? boundProviderConfiguration.researchAuthor.codexBinary
    : configuredValue(
      options['codex-binary'],
      environment.HEPTA_RESEARCH_AUTHOR_CODEX_BINARY,
      'codex',
    );
  const researchAuthorPreflight = researchAuthorProviderPolicy.researchGradeRequired
    && provider === 'codex'
    ? preflightResearchAuthor({
      codexBinary: primaryCodexBinary,
      codexHome: primaryCodexHome,
      model: primaryCodexModel,
      spawnSyncImpl,
      environment,
    })
    : provider === 'ollama' ? preflightLocalOllamaAgent({
      role: 'research-author',
      model: ollamaModel,
      spawnSyncImpl,
      environment,
    }) : null;
  const primaryOllamaPrincipal = researchAuthorPreflight?.effectivePrincipalId
    || 'ollama-local-research-author-v1';
  const ollama = ollamaModel ? createOllamaStructuredAgentExecutor({
    model: ollamaModel,
    ollamaHost: researchAuthorPreflight?.ollamaHost || 'http://127.0.0.1:11434',
    principalId: primaryOllamaPrincipal,
    maximumOutputTokens: 8192,
  }) : null;
  const primaryCodexPrincipal = researchAuthorPreflight?.effectivePrincipalId || 'hepta-primary-codex-v1';
  const codex = createCodexAgentExecutor({
    codexBinary: researchAuthorPreflight?.codexBinary || primaryCodexBinary,
    codexHome: researchAuthorPreflight?.codexHome || primaryCodexHome,
    model: provider === 'codex' ? primaryCodexModel : null,
    principalId: primaryCodexPrincipal,
    researchAuthorCapabilityReceipt: researchAuthorPreflight?.capabilityReceipt || null,
  });
  const selected = provider === 'openclaw' ? openclaw
    : provider === 'ollama' ? ollama
      : provider === 'codex' ? codex
        : createAgentBackendRouter({ primary: openclaw, fallbacks: [ollama] });
  if (!selected) throw new Error(`agent provider unavailable: ${provider}`);
  const agentExecutor = createIsolatedAgentExecutor({
    delegate: selected,
    isolationRoot: path.join(runtimeRoot, 'automation-workspaces'),
    keepWorkspaces: false,
    keepFailedWorkspaces: true,
    workspaceRegistry,
    assertExternalSideEffectReady,
  });
  const authorAgentId = provider === 'codex' ? primaryCodexPrincipal
    : provider === 'ollama' ? primaryOllamaPrincipal : primaryOpenClawAgentId;
  const independentReviewRequested = plans.some((plan) => (plan.nodes || []).some((node) => (
    node.kind === 'formal-verify' || isCampaignRefereeNode(node.kind)
  )));
  const autonomousPreparations = plans.map((plan) => (
    plan?.autonomousResearchPreparation || null
  )).filter(Boolean);
  const expectedPrincipalAuthority =
    inspectCampaignPreparationPrincipalAuthorityBindings(autonomousPreparations);
  const expectedRuntimePrincipalBinding =
    expectedPrincipalAuthority.runtimePrincipalBinding;
  const expectedReviewerPoolHashes = [...new Set(plans.map((plan) => (
    plan?.autonomousResearchPreparation?.researchPrincipalPoolHash
  )).filter(Boolean))];
  if (expectedReviewerPoolHashes.length > 1) {
    throw new Error('reviewer_principal_pool_hash_mismatch');
  }
  const reviewerPoolConfigPath = localOnlyCampaign ? '' : String(
    environment.HEPTA_REVIEWER_PRINCIPAL_POOL_CONFIG || '',
  ).trim();
  const reviewerClock = typeof services.clock?.now === 'function'
    ? services.clock : undefined;
  const authorIdentityAttestation = independentReviewRequested
    && (reviewerPoolConfigPath || expectedRuntimePrincipalBinding)
    ? inspectAutonomousResearchAuthorRuntimeIdentity({
      environment,
      author: researchAuthorPreflight,
      ...(reviewerClock ? { clock: reviewerClock } : {}),
    }) : null;
  let effectiveReviewerPrincipalExecutorPool = reviewerPrincipalExecutorPool;
  let reviewerPrincipalPoolComposition = null;
  if (!effectiveReviewerPrincipalExecutorPool && independentReviewRequested
    && reviewerPoolConfigPath) {
    reviewerPrincipalPoolComposition = reviewerPrincipalPoolComposer({
      configPath: reviewerPoolConfigPath,
      authorProvider: provider,
      authorCodexHome: provider === 'codex'
        ? researchAuthorPreflight?.codexHome || primaryCodexHome : null,
      runtimeRoot,
      workspaceRegistry,
      environment,
      spawnSyncImpl,
      authorIdentityAttestation,
      assertExternalSideEffectReady,
      ...(reviewerClock ? { clock: reviewerClock } : {}),
    });
    effectiveReviewerPrincipalExecutorPool = reviewerPrincipalPoolComposition.executorPool;
  }
  const formalReviewerProvider = boundProviderConfiguration
    ? boundProviderConfiguration.formalReviewer.provider
    : configuredValue(
      options['formal-review-provider'],
      environment.HEPTA_FORMAL_REVIEW_PROVIDER,
      'codex',
    );
  if (!effectiveReviewerPrincipalExecutorPool && independentReviewRequested
    && !reviewerPoolConfigPath && formalReviewerProvider === 'codex'
    && provider === 'codex') {
    const reviewerPreflight = preflightFormalReviewer({
      codexBinary: boundProviderConfiguration
        ? boundProviderConfiguration.formalReviewer.codexBinary
        : configuredValue(
          options['formal-review-codex-binary'],
          environment.HEPTA_FORMAL_REVIEW_CODEX_BINARY,
          'codex',
        ),
      codexHome: boundProviderConfiguration
        ? boundProviderConfiguration.formalReviewer.codexHome
        : configuredValue(
          options['formal-review-codex-home'],
          environment.HEPTA_FORMAL_REVIEW_CODEX_HOME,
        ) || null,
      model: boundProviderConfiguration
        ? boundProviderConfiguration.formalReviewer.model
        : modelConfiguration.formalReviewModel,
      authorProvider: provider === 'codex' ? 'codex' : provider,
      authorCodexHome: provider === 'codex'
        ? researchAuthorPreflight?.codexHome || primaryCodexHome : null,
      environment,
      spawnSyncImpl,
    });
    reviewerPrincipalPoolComposition = reviewerSessionPoolComposer({
      inspection: buildAutonomousResearchReviewerSessionPrincipalPool({
        author: researchAuthorPreflight,
        reviewer: reviewerPreflight,
      }),
      runtimeRoot,
      workspaceRegistry,
      assertExternalSideEffectReady,
    });
    effectiveReviewerPrincipalExecutorPool =
      reviewerPrincipalPoolComposition.executorPool;
  }
  const actualReviewerPoolHash = effectiveReviewerPrincipalExecutorPool?.pool
    ?.researchPrincipalPoolHash || null;
  if (expectedReviewerPoolHashes[0]
    && expectedReviewerPoolHashes[0] !== actualReviewerPoolHash) {
    throw new Error('reviewer_principal_pool_execution_binding_invalid');
  }
  requireCurrentCampaignWorkerPrincipalAuthority({
    expectedRuntimePrincipalBinding,
    expectedProductionAuthorityBinding:
      expectedPrincipalAuthority.productionAuthorityBinding,
    providerConfiguration: boundProviderConfiguration,
    researchAuthorPreflight,
    authorIdentityAttestation,
    researchPrincipalPoolHash: actualReviewerPoolHash,
    reviewerTrustSetHash: reviewerPrincipalPoolComposition?.trustSetHash
      || effectiveReviewerPrincipalExecutorPool?.trustSetHash,
    reviewerSignatureVerificationPolicyHash:
      reviewerPrincipalPoolComposition?.signatureVerificationPolicyHash
      || effectiveReviewerPrincipalExecutorPool?.signatureVerificationPolicyHash,
  });
  const formalReviewAgentExecutor = independentReviewRequested
    && !effectiveReviewerPrincipalExecutorPool
    ? campaignExecutionContext.createFormalReviewAgentExecutor({
      authorAgentId,
      model: boundProviderConfiguration
        ? boundProviderConfiguration.formalReviewer.model
        : modelConfiguration.formalReviewModel,
      provider: boundProviderConfiguration
        ? boundProviderConfiguration.formalReviewer.provider
        : formalReviewerProvider,
      codexBinary: boundProviderConfiguration
        ? boundProviderConfiguration.formalReviewer.codexBinary
        : configuredValue(
          options['formal-review-codex-binary'],
          environment.HEPTA_FORMAL_REVIEW_CODEX_BINARY,
          'codex',
        ),
      codexHome: boundProviderConfiguration
        ? boundProviderConfiguration.formalReviewer.codexHome
        : configuredValue(
          options['formal-review-codex-home'],
          environment.HEPTA_FORMAL_REVIEW_CODEX_HOME,
        )
          || null,
      authorProvider: provider === 'codex' ? 'codex' : provider,
      authorCodexHome: provider === 'codex' ? primaryCodexHome : null,
      localOnly: localOnlyCampaign,
      reviewerAgentId: configuredValue(
        options['formal-review-agent'],
        environment.HEPTA_OPENCLAW_FORMAL_REVIEW_AGENT,
      ),
      reviewerCapabilityProfilePath:
        environment.HEPTA_OPENCLAW_FORMAL_REVIEW_AGENT_CAPABILITY_PROFILE || null,
      expectedReviewerCapabilityProfileHash:
        environment.HEPTA_OPENCLAW_FORMAL_REVIEW_AGENT_CAPABILITY_PROFILE_HASH || null,
      environment,
      spawnSyncImpl,
    })
    : null;
  return Object.freeze({
    nodeExecutor: createCampaignNodeExecutor({
      agentExecutor,
      formalReviewAgentExecutor,
      reviewerPrincipalExecutorPool: effectiveReviewerPrincipalExecutorPool,
      empiricalExecutor,
      runtimeRoot,
      artifactRepositoryFactory: services.artifactRepositoryFactory,
      theoremQualityRevisionSink: services.theoremQualityRevisionSink,
      releasePackager: services.releasePackager,
      researchVerifier: services.researchVerifier,
      experimentRegistryAuthorityVerifier: services.experimentRegistryAuthorityVerifier,
      assertExternalSideEffectReady,
      environment,
      spawnSyncImpl,
      dynamicFormalExecutionAuthority: services.dynamicFormalExecutionAuthority,
    }),
    agentExecutor,
    formalReviewAgentExecutor,
    reviewerPrincipalExecutorPool: effectiveReviewerPrincipalExecutorPool,
    researchPrincipalPool: effectiveReviewerPrincipalExecutorPool?.pool || null,
    reviewerPrincipalPoolConfigurationHash:
      reviewerPrincipalPoolComposition?.configuration?.configurationHash || null,
    empiricalExecutor,
    workerRunner,
    runtimeImages,
    researchAuthorProviderPolicy,
    researchAuthorCapabilityReceipt: researchAuthorPreflight?.capabilityReceipt || null,
    autonomousResearchProviderConfigurationHash:
      boundProviderConfiguration?.autonomousResearchProviderConfigurationHash || null,
  });
}
