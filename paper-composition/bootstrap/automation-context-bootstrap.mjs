import path from 'node:path';
import { buildExecutionContext, composeScopedFoundationServices, exposeScopedFoundationServices } from './context-foundation-composition.mjs';
import { createFilesystemArtifactRepository } from '../../paper-adapters/artifacts/filesystem-artifact-repository.mjs';
import { composeArtifactReceiptLedger, composeRuntimeRetentionReceiptLedger, composeTrustedReceiptLedgers } from './receipt-ledger-composition.mjs';
import { createSqliteCampaignStore } from '../../paper-adapters/persistence/sqlite-campaign-store.mjs';
import { createInventoryRepository } from '../../paper-adapters/inventory/inventory-repository.mjs';
import { createWorkspaceRegistry } from '../../paper-adapters/automation/workspace-registry.mjs';
import {
  createCampaignReleasePackager,
  createResearchExecutionReleaseAttestor,
} from '../../paper-adapters/automation/campaign-release-packager.mjs';
import { createTheoremQualityRevisionSink } from '../../paper-adapters/automation/theorem-quality-revision-sink.mjs';
import { createSqliteResourceGovernor } from '../../paper-adapters/automation/sqlite-resource-governor.mjs';
import { createSystemScheduler } from '../../paper-adapters/runtime/system-scheduler.mjs';
import { createRandomIdGenerator } from '../../paper-adapters/runtime/random-id-generator.mjs';
import { createCampaignResearchVerifier } from '../../paper-adapters/automation/campaign-research-verifier.mjs';
import { createSqliteJobReceiptStore } from '../../paper-adapters/persistence/sqlite-job-receipt-store.mjs';
import { createOsSandboxedWorkerRunner } from '../../paper-adapters/runtime/os-sandboxed-worker-runner.mjs';
import { createIndependentPdfRebuildVerifier } from '../../paper-adapters/build-package/independent-pdf-rebuild-verifier.mjs';
import { composeAutomationResearchAuthority } from './automation-research-authority-composition.mjs';

// This module intentionally has no submission, provider-authority, stage-adapter,
// or external-executor imports. Automation processes receive only their native
// persistence and audit capabilities.
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
} = {}) {
  for (const forbiddenOverride of [
    'experimentRegistryAuthorityVerifier',
    'operatorDatasetHarnessAuthorityVerifier',
    'independentPdfRebuildVerifier',
    'independentPdfRebuildWorkerRunner',
    'researchExecutionReleaseAttestor',
    'releasePackager',
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
  } = composeAutomationResearchAuthority({ runtimeRoot, receiptLedger, clock });
  const researchExecutionReleaseAttestor = createResearchExecutionReleaseAttestor({ runtimeRoot, clock });
  const independentPdfRebuildRoot = path.join(runtimeRoot, 'campaign-release-rebuilds');
  const independentPdfRebuildWorkerRunner = createOsSandboxedWorkerRunner({
    allowedExecutables: ['latexmk'],
    allowedRoots: [independentPdfRebuildRoot],
    allowedOutputRoots: [independentPdfRebuildRoot],
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
  const campaignStore = serviceOverrides.campaignStore || createSqliteCampaignStore({
    store,
    clock,
    experimentRegistryAuthorityVerifier,
  });
  const automationServices = Object.freeze({
    ...exposeScopedFoundationServices(foundation, { schemaVersion }),
    artifactRepositoryFactory,
    idGenerator: serviceOverrides.idGenerator || createRandomIdGenerator(),
    campaignStore,
    inventoryRepository: serviceOverrides.inventoryRepository || createInventoryRepository({ store }),
    workspaceRegistry: serviceOverrides.workspaceRegistry || createWorkspaceRegistry({ store, clock, receiptLedger }),
    runtimeRetentionReceiptLedger: serviceOverrides.runtimeRetentionReceiptLedger || composeRuntimeRetentionReceiptLedger({ store, clock }),
    experimentRegistryAuthorityVerifier,
    releasePackager: serviceOverrides.releasePackager || createCampaignReleasePackager({
      artifactRepositoryFactory,
      store,
      receiptLedger,
      operatorDatasetHarnessAuthorityVerifier,
      runtimeRoot,
      operatorDatasetAuthorityTrustStoreProvider,
      clock,
      researchExecutionReleaseAttestor,
      independentPdfRebuildVerifier,
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
    }),
    theoremQualityRevisionSink: serviceOverrides.theoremQualityRevisionSink || createTheoremQualityRevisionSink({ store, clock }),
    resourceGovernorFactory: serviceOverrides.resourceGovernorFactory || ((limits) => createSqliteResourceGovernor({ store, clock, limits })),
    scheduler: serviceOverrides.scheduler || createSystemScheduler(),
  });
  return buildExecutionContext({
    root,
    runtimeRoot,
    mode,
    execute,
    writeReport,
    options,
    serviceProfile: 'automation',
    capabilities: ['artifact-repository', 'automation-coordination', 'receipt-ledger', 'typed-persistence'],
    services: automationServices,
  });
}
