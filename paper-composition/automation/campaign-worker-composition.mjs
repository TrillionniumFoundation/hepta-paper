import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createCodexAgentExecutor } from '../../paper-adapters/automation/codex-agent-executor.mjs';
import { preflightCodexResearchAuthor } from '../../paper-adapters/automation/codex-research-author-preflight.mjs';
import { createOllamaStructuredAgentExecutor } from '../../paper-adapters/automation/ollama-structured-agent-executor.mjs';
import { createOpenClawAgentExecutor } from '../../paper-adapters/automation/openclaw-agent-executor.mjs';
import { createAgentBackendRouter } from '../../paper-adapters/automation/agent-backend-router.mjs';
import { createIsolatedAgentExecutor } from '../../paper-adapters/automation/isolated-agent-executor.mjs';
import { createMultiLanguageEmpiricalExecutor } from '../../paper-adapters/automation/multi-language-empirical-executor.mjs';
import { createFilesystemEmpiricalCacheRepository } from '../../paper-adapters/automation/empirical-cache-repository.mjs';
import {
  authorizeOperatorDatasetMount,
  loadOperatorDatasetAuthorityTrustStoreSync,
} from '../../paper-adapters/automation/operator-dataset-harness-reader.mjs';
import {
  createOsSandboxedWorkerRunner,
  directoryMerkleHash,
  fileSha256Hash,
} from '../../paper-adapters/runtime/os-sandboxed-worker-runner.mjs';
import {
  buildRuntimeRetentionPlan,
  executeRuntimeRetentionPlan,
  reconcileRuntimeRetentionIntents,
} from '../../paper-adapters/automation/runtime-retention.mjs';
import { runtimeImagesForCampaign } from '../../paper-adapters/automation/runtime-image-registry.mjs';
import { createCampaignNodeExecutor } from './campaign-node-execution-composition.mjs';
import { isCampaignRefereeNode } from '../../paper-application/automation/campaign-node-kind-policy.mjs';
import { resolveCampaignAgentProviderPolicy } from '../../paper-domain/automation/research-agent-provider-policy.mjs';
import {
  requireAutonomousResearchProviderConfiguration,
} from './autonomous-research-provider-configuration.mjs';

export {
  authorizeOperatorDatasetMount,
  buildRuntimeRetentionPlan,
  executeRuntimeRetentionPlan,
  loadOperatorDatasetAuthorityTrustStoreSync,
  reconcileRuntimeRetentionIntents,
};

export function campaignDatasetContentHash(source) {
  const resolved = path.resolve(source);
  return fs.statSync(resolved).isDirectory()
    ? directoryMerkleHash(resolved)
    : fileSha256Hash(resolved);
}

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
  const boundProviderConfiguration = providerConfiguration
    ? requireAutonomousResearchProviderConfiguration(providerConfiguration, { expectedHash })
    : null;
  if (expectedHash && !boundProviderConfiguration) {
    throw new Error('autonomous_research_provider_configuration_required');
  }
  const requiresGpu = Boolean(options.gpu) || plans.some((plan) => plan.requiresGpu);
  const runtimeImages = runtimeImagesForCampaign({
    gpu: requiresGpu,
    requireTrustedDatasetAccess: datasetMounts.length > 0,
  });
  const workerRunner = createOsSandboxedWorkerRunner({
    allowedExecutables: ['python3', process.execPath, 'Rscript', 'julia', 'lake', 'latexmk'],
    allowedRoots: plans.map((plan) => plan.sourceWorkspace),
    allowedOutputRoots: [path.join(runtimeRoot, 'automation-artifacts')],
    allowedDatasetRoots: datasetMounts.map((mount) => mount.source),
    allowedContainerImages: Object.values(runtimeImages).map((item) => item.image),
    trustedDatasetSupervisorImages: Object.values(runtimeImages)
      .filter((item) => item.datasetAccessSupervisor)
      .map((item) => ({
        image: item.image,
        imageDigest: item.imageDigest,
        containerExecutable: item.executable,
        supervisor: item.datasetAccessSupervisor,
      })),
    allowGpu: requiresGpu,
    maximumTimeoutMs: Number(options['max-wall-ms'] || 6 * 60 * 60 * 1000),
    maximumMemoryBytes: Number(options['worker-memory-mib'] || 4096) * 1024 * 1024,
    maximumCpuSeconds: Number(options['worker-cpu-seconds'] || 3600),
  });
  const empiricalExecutor = createMultiLanguageEmpiricalExecutor({
    workerRunner,
    runtimeImages,
    cache: createFilesystemEmpiricalCacheRepository({ root: path.join(runtimeRoot, 'automation-cache', 'empirical') }),
    operatorDatasetAuthorityTrustStore: loadOperatorDatasetAuthorityTrustStoreSync({ runtimeRoot }),
    runtimeRoot,
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
  const primaryOpenClawAgentId = options['openclaw-agent'] || 'hepta-paper-worker';
  const primaryCodexModel = boundProviderConfiguration
    ? boundProviderConfiguration.researchAuthor.model
    : modelConfiguration.researchAuthorModel;
  const openclaw = createOpenClawAgentExecutor({
    agentId: primaryOpenClawAgentId,
    model: primaryCodexModel || undefined,
  });
  const ollamaModel = ['auto', 'ollama'].includes(provider) ? discoverOllamaModel(options, spawnSyncImpl) : null;
  const ollama = ollamaModel ? createOllamaStructuredAgentExecutor({ model: ollamaModel }) : null;
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
  const researchAuthorPreflight = researchAuthorProviderPolicy.researchGradeRequired && provider === 'codex'
    ? preflightCodexResearchAuthor({
      codexBinary: primaryCodexBinary,
      codexHome: primaryCodexHome,
      model: primaryCodexModel,
      spawnSyncImpl,
      environment,
    })
    : null;
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
  });
  const authorAgentId = provider === 'codex' ? primaryCodexPrincipal : primaryOpenClawAgentId;
  const independentReviewRequested = plans.some((plan) => (plan.nodes || []).some((node) => (
    node.kind === 'formal-verify' || isCampaignRefereeNode(node.kind)
  )));
  const formalReviewAgentExecutor = independentReviewRequested
    ? campaignExecutionContext.createFormalReviewAgentExecutor({
      authorAgentId,
      model: boundProviderConfiguration
        ? boundProviderConfiguration.formalReviewer.model
        : modelConfiguration.formalReviewModel,
      provider: boundProviderConfiguration
        ? boundProviderConfiguration.formalReviewer.provider
        : configuredValue(
          options['formal-review-provider'],
          environment.HEPTA_FORMAL_REVIEW_PROVIDER,
          'codex',
        ),
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
      empiricalExecutor,
      runtimeRoot,
      artifactRepositoryFactory: services.artifactRepositoryFactory,
      theoremQualityRevisionSink: services.theoremQualityRevisionSink,
      releasePackager: services.releasePackager,
      researchVerifier: services.researchVerifier,
      experimentRegistryAuthorityVerifier: services.experimentRegistryAuthorityVerifier,
    }),
    agentExecutor,
    formalReviewAgentExecutor,
    empiricalExecutor,
    workerRunner,
    runtimeImages,
    researchAuthorProviderPolicy,
    researchAuthorCapabilityReceipt: researchAuthorPreflight?.capabilityReceipt || null,
    autonomousResearchProviderConfigurationHash:
      boundProviderConfiguration?.autonomousResearchProviderConfigurationHash || null,
  });
}
