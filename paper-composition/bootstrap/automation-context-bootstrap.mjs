import path from 'node:path';
import { buildExecutionContext, composeScopedFoundationServices, exposeScopedFoundationServices } from './context-foundation-composition.mjs';
import { createFilesystemArtifactRepository } from '../../paper-adapters/artifacts/filesystem-artifact-repository.mjs';
import { composeArtifactReceiptLedger, composeRuntimeRetentionReceiptLedger, composeTrustedReceiptLedgers } from './receipt-ledger-composition.mjs';
import { createInventoryRepository } from '../../paper-adapters/inventory/inventory-repository.mjs';
import {
  createCampaignReleasePackager,
  createResearchExecutionReleaseAttestor,
} from '../../paper-adapters/automation/campaign-release-packager.mjs';
import { createTheoremQualityRevisionSink } from '../../paper-adapters/automation/theorem-quality-revision-sink.mjs';
import { createSqliteResourceGovernor } from '../../paper-adapters/automation/sqlite-resource-governor.mjs';
import { createSystemScheduler } from '../../paper-adapters/runtime/system-scheduler.mjs';
import { createRandomIdGenerator } from '../../paper-adapters/runtime/random-id-generator.mjs';
import { createCampaignResearchVerifier } from '../../paper-adapters/automation/campaign-research-verifier.mjs';
import {
  createPinnedFormalSandboxRuntime,
  configuredPinnedFormalSandboxRuntime,
} from '../../paper-adapters/research-verify/pinned-formal-sandbox-runtime-configuration.mjs';
import {
  inspectConfiguredDynamicFormalExecutionAuthority,
} from '../../paper-adapters/research-verify/dynamic-formal-project-closure-readiness.mjs';
import { createSqliteJobReceiptStore } from '../../paper-adapters/persistence/sqlite-job-receipt-store.mjs';
import { createOsSandboxedWorkerRunner } from '../../paper-adapters/runtime/os-sandboxed-worker-runner.mjs';
import { createIndependentPdfRebuildVerifier } from '../../paper-adapters/build-package/independent-pdf-rebuild-verifier.mjs';
import {
  composeAutomationResearchAuthority,
} from './automation-research-authority-composition.mjs';
import { composeAutomationCampaignState } from './automation-campaign-state-composition.mjs';
import {
  bootstrapAutonomousSubmissionHandoffContext,
} from './autonomous-submission-handoff-context-bootstrap.mjs';
import {
  createGpuScientificCampaignQualificationIntakeRepository,
} from '../../paper-adapters/automation/gpu-scientific-campaign-qualification-intake-repository.mjs';
import {
  createGpuScientificCampaignForbiddenIdentityProvider,
  createGpuScientificCampaignPromotionAuthorityVerifier,
} from '../../paper-adapters/automation/gpu-scientific-campaign-promotion-authority-verifier.mjs';

// Automation processes receive no portal credentials or external executor. The
// only submission capability exposed here is a durable local intent/outcome
// journal; the network portal remains composition-scoped.
export function bootstrapAutomationContext({
  root,
  runtimeRoot,
  mode = 'automation',
  execute = false,
  writeReport = false,
  readOnly = false,
  allowMissingReadOnlyStore = false,
  options = {},
  serviceOverrides = {},
  environment = process.env,
  autonomousSubmissionDispatchAuthority = null,
  autonomousSubmissionHandoffOnly = true,
  submissionHandoffMutationCoordinator = null,
  requireExternallyFencedSubmissionHandoff = null,
  submissionHandoffReadOnly = false,
} = {}) {
  for (const forbiddenOverride of [
    'experimentRegistryAuthorityVerifier',
    'operatorDatasetHarnessAuthorityVerifier',
    'independentPdfRebuildVerifier',
    'independentPdfRebuildWorkerRunner',
    'researchExecutionReleaseAttestor',
    'releasePackager',
    'autonomousSubmissionRequestVerifier',
    'packageLifecycleAuthority',
    'runtimeRetentionReachabilityProvider',
    'gpuScientificQualificationIntakeRepository',
    'gpuScientificPromotionAuthorityVerifier',
  ]) {
    if (Object.hasOwn(serviceOverrides, forbiddenOverride)) {
      throw new Error(`automation_${forbiddenOverride}_override_forbidden`);
    }
  }
  const { foundation, schemaVersion } = composeScopedFoundationServices({
    root,
    runtimeRoot,
    readOnly,
    mutableOutputs: Boolean(execute || writeReport),
    allowMissingReadOnlyStore,
    serviceOverrides,
    writerId: 'hepta-paper-automation-bootstrap',
    rootKind: 'automation',
  });
  const { store, clock, receiptLedger } = foundation;
  const configuredFormalSandboxRuntime = configuredPinnedFormalSandboxRuntime({ environment });
  const trustedFormalSandboxRuntime = serviceOverrides.trustedFormalSandboxRuntime
    ? createPinnedFormalSandboxRuntime(serviceOverrides.trustedFormalSandboxRuntime)
    : configuredFormalSandboxRuntime
      ? createPinnedFormalSandboxRuntime(configuredFormalSandboxRuntime)
      : null;
  const dynamicFormalExecutionAuthority =
    inspectConfiguredDynamicFormalExecutionAuthority({
      environment,
      runtimeRoot,
      activeProbe: false,
    }).authority;
  const submissionHandoffContext = bootstrapAutonomousSubmissionHandoffContext({
    root,
    runtimeRoot,
    clock,
    environment,
    autonomousSubmissionDispatchAuthority,
    handoffOnly: autonomousSubmissionHandoffOnly,
    outboxOverride: serviceOverrides.autonomousSubmissionOutbox || null,
    mutationCoordinator: submissionHandoffMutationCoordinator,
    readOnly: Boolean(submissionHandoffReadOnly || readOnly || !execute),
    allowMissingReadOnlyStore,
    requireExternallyFenced:
      requireExternallyFencedSubmissionHandoff === null
        ? Boolean(execute)
        : requireExternallyFencedSubmissionHandoff === true,
  });
  const {
    autonomousSubmissionRequestVerifier,
    autonomousSubmissionOutbox,
  } = submissionHandoffContext.services;
  const artifactReceiptLedger = serviceOverrides.artifactReceiptLedger || composeArtifactReceiptLedger({
    store,
    clock,
  });
  const trustedResearchLedgers = composeTrustedReceiptLedgers({ store, clock, overrides: serviceOverrides });
  const artifactRepositoryFactory = serviceOverrides.artifactRepositoryFactory || ((scopeRoot) => createFilesystemArtifactRepository({
    scopeRoot,
    casRoot: path.join(runtimeRoot, 'artifact-cas'),
    receiptLedger: artifactReceiptLedger,
    clock,
  }));
  const nativeResearchWorkerJobReceiptStore = serviceOverrides.nativeResearchWorkerJobReceiptStore
    || createSqliteJobReceiptStore({
      store,
      receiptLedger: trustedResearchLedgers.nativeResearchWorker,
      clock,
      allowedReceiptKinds: ['NativeResearchWorkerExecutionReceipt'],
    });
  const {
    experimentRegistryAuthorityVerifier,
    operatorDatasetHarnessAuthorityVerifier,
    operatorDatasetAuthorityTrustStoreProvider,
    rawEventRecomputationVerifier,
    externalResearchReplay,
  } = composeAutomationResearchAuthority({ runtimeRoot, receiptLedger, clock, environment });
  const gpuScientificQualificationIntakeRepository =
    createGpuScientificCampaignQualificationIntakeRepository({ runtimeRoot });
  const gpuScientificPromotionAuthorityVerifier =
    createGpuScientificCampaignPromotionAuthorityVerifier({
      trustStoreProvider: operatorDatasetAuthorityTrustStoreProvider,
      clock,
      forbiddenIdentityProvider:
        createGpuScientificCampaignForbiddenIdentityProvider({
          environment,
          clock,
        }),
    });
  const researchExecutionReleaseAttestor = createResearchExecutionReleaseAttestor({
    runtimeRoot,
    clock,
    environment,
  });
  const independentPdfRebuildRoot = path.join(runtimeRoot, 'campaign-release-rebuilds');
  const independentPdfRebuildWorkerRunner = createOsSandboxedWorkerRunner({
    allowedExecutables: ['latexmk'],
    allowedRoots: [independentPdfRebuildRoot],
    allowedOutputRoots: [independentPdfRebuildRoot],
    ...(trustedFormalSandboxRuntime ? {
      dockerImage: trustedFormalSandboxRuntime.image,
      allowedContainerImages: [trustedFormalSandboxRuntime.image],
    } : {}),
    maximumTimeoutMs: 180_000,
    maximumMemoryBytes: 2 * 1024 * 1024 * 1024,
    maximumCpuSeconds: 180,
    maximumPids: 128,
    maximumOutputBytes: 256 * 1024 * 1024,
    maximumCapturedBytes: 4 * 1024 * 1024,
  });
  const independentPdfRebuildVerifier = createIndependentPdfRebuildVerifier({
    workerRunner: independentPdfRebuildWorkerRunner,
    runtimeRoot,
    clock,
  });
  const {
    campaignStore,
    workspaceRegistry,
    packageLifecycleAuthority,
    runtimeRetentionReachabilityProvider,
  } = composeAutomationCampaignState({
    runtimeRoot,
    store,
    clock,
    receiptLedger,
    campaignStoreOverride: serviceOverrides.campaignStore,
    workspaceRegistryOverride: serviceOverrides.workspaceRegistry,
    experimentRegistryAuthorityVerifier,
    externalResearchReplay: serviceOverrides.externalResearchReplay || externalResearchReplay,
    operatorDatasetHarnessAuthorityVerifier,
    rawEventRecomputationVerifier,
    operatorDatasetAuthorityTrustStoreProvider,
    gpuScientificPromotionAuthorityVerifier,
  });
  const nativeFoundationServices = exposeScopedFoundationServices(foundation, { schemaVersion });
  const automationServices = Object.freeze({
    ...nativeFoundationServices,
    artifactRepositoryFactory,
    idGenerator: serviceOverrides.idGenerator || createRandomIdGenerator(),
    campaignStore,
    inventoryRepository: serviceOverrides.inventoryRepository || createInventoryRepository({ store }),
    workspaceRegistry,
    runtimeRetentionReceiptLedger: serviceOverrides.runtimeRetentionReceiptLedger || composeRuntimeRetentionReceiptLedger({ store, clock }),
    packageLifecycleAuthority,
    runtimeRetentionReachabilityProvider,
    experimentRegistryAuthorityVerifier,
    dynamicFormalExecutionAuthority,
    releasePackager: serviceOverrides.releasePackager || createCampaignReleasePackager({
      artifactRepositoryFactory,
      store,
      receiptLedger,
      operatorDatasetHarnessAuthorityVerifier,
      runtimeRoot,
      operatorDatasetAuthorityTrustStoreProvider,
      clock,
      gpuScientificPromotionAuthorityVerifier,
      researchExecutionReleaseAttestor,
      independentPdfRebuildVerifier,
      externalResearchReplay: serviceOverrides.externalResearchReplay || externalResearchReplay,
    }),
    researchVerifier: serviceOverrides.researchVerifier || createCampaignResearchVerifier({
      runtimeRoot,
      clock,
      store,
      receiptLedger,
      artifactRepositoryFactory,
      nativeResearchWorkerJobReceiptStore,
      trustedResearchReceiptWriters: trustedResearchLedgers.research,
      campaignStore,
      operatorDatasetHarnessAuthorityVerifier,
      rawEventRecomputationVerifier,
      externalResearchReplay: serviceOverrides.externalResearchReplay || externalResearchReplay,
      trustedFormalSandboxRuntime,
      dynamicFormalExecutionAuthority,
      dynamicFormalExecutionEnvironment: environment,
      gpuScientificQualificationIntakeRepository,
      gpuScientificPromotionAuthorityVerifier,
    }),
    theoremQualityRevisionSink: serviceOverrides.theoremQualityRevisionSink || createTheoremQualityRevisionSink({ store, clock }),
    resourceGovernorFactory: serviceOverrides.resourceGovernorFactory || ((limits) => createSqliteResourceGovernor({ store, clock, limits })),
    scheduler: serviceOverrides.scheduler || createSystemScheduler(),
    autonomousSubmissionRequestVerifier,
    autonomousSubmissionOutbox,
    persistenceSession: Object.freeze({
      version: 1,
      kind: 'ScopedPersistenceSessionPort',
      available: () => nativeFoundationServices.persistenceSession.available(),
      close() {
        let failure = null;
        try { submissionHandoffContext.services.persistenceSession.close(); }
        catch (error) { failure = error; }
        try { nativeFoundationServices.persistenceSession.close(); }
        catch (error) { failure ||= error; }
        if (failure) throw failure;
      },
    }),
  });
  return buildExecutionContext({
    root,
    runtimeRoot,
    mode,
    execute,
    writeReport,
    options,
    serviceProfile: 'automation',
    capabilities: [
      'artifact-repository', 'automation-coordination',
      'autonomous-submission-outbox', 'receipt-ledger', 'typed-persistence',
    ],
    services: automationServices,
  });
}
