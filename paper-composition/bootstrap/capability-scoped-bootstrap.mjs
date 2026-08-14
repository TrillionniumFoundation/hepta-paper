import path from 'node:path';
import { PAPER_BATCH_MODES, assertPaperMode } from '../../paper-domain/workflow/mode-registry.mjs';
import { createFilesystemArtifactRepository } from '../../paper-adapters/artifacts/filesystem-artifact-repository.mjs';
import { createAuthorityVerifier } from '../../paper-adapters/authority/authority-verifier.mjs';
import { createSqliteJobReceiptStore } from '../../paper-adapters/persistence/sqlite-job-receipt-store.mjs';
import { createSqliteWorkflowStateStore } from '../../paper-adapters/persistence/sqlite-workflow-state-store.mjs';
import { createSqliteSubmissionDeliveryStore } from '../../paper-adapters/submission/sqlite-delivery-store.mjs';
import { createSqliteCampaignReleaseAuthorityRepository } from '../../paper-adapters/persistence/sqlite-campaign-release-authority-repository.mjs';
import { createInventoryRepository } from '../../paper-adapters/inventory/inventory-repository.mjs';
import { composeTrustedReceiptLedgers } from './receipt-ledger-composition.mjs';
import { buildExecutionContext, composeScopedFoundationServices, exposeScopedFoundationServices } from './context-foundation-composition.mjs';
import { createOperatorDatasetHarnessAuthorityReceiptVerifier } from '../../paper-adapters/automation/operator-dataset-harness-authority-receipt-verifier.mjs';
import { loadOperatorDatasetAuthorityTrustStoreSync } from '../../paper-adapters/automation/operator-dataset-harness-reader.mjs';
import {
  createGpuScientificCampaignForbiddenIdentityProvider,
  createGpuScientificCampaignPromotionAuthorityVerifier,
} from '../../paper-adapters/automation/gpu-scientific-campaign-promotion-authority-verifier.mjs';

const SUBMISSION_POLICY_MODES = new Set([
  PAPER_BATCH_MODES.LOCAL_DRY_RUN,
  PAPER_BATCH_MODES.REVIEWED_SUBMIT,
  PAPER_BATCH_MODES.LOCAL_REVIEW_LOOP,
  PAPER_BATCH_MODES.REFEREE_AUTOPILOT,
]);

const SUBMISSION_DELIVERY_MODES = new Set([
  PAPER_BATCH_MODES.REVIEWED_SUBMIT,
  PAPER_BATCH_MODES.LOCAL_REVIEW_LOOP,
  PAPER_BATCH_MODES.REFEREE_AUTOPILOT,
]);

export function composeBatchServices({
  foundation,
  runtimeRoot,
  serviceOverrides,
  includeSubmissionPolicy,
  includeSubmissionDelivery,
  includeLegacyWorkflowProjection = false,
  schemaVersion = null,
  exposeRawStore = false,
}) {
  const { store, clock, receiptLedger } = foundation;
  const trustedLedgers = composeTrustedReceiptLedgers({ store, clock, overrides: serviceOverrides });
  const artifactReceiptLedger = serviceOverrides.receiptLedger ? receiptLedger : trustedLedgers.artifact;
  const jobReceiptStore = serviceOverrides.jobReceiptStore || createSqliteJobReceiptStore({
    store,
    receiptLedger,
    clock,
    deniedReceiptKinds: ['NativeResearchWorkerExecutionReceipt'],
  });
  const nativeResearchWorkerJobReceiptStore = serviceOverrides.nativeResearchWorkerJobReceiptStore
    || createSqliteJobReceiptStore({
      store,
      receiptLedger: trustedLedgers.nativeResearchWorker,
      clock,
      allowedReceiptKinds: ['NativeResearchWorkerExecutionReceipt'],
    });
  const artifactRepositoryFactory = serviceOverrides.artifactRepositoryFactory || ((scopeRoot) => (
    createFilesystemArtifactRepository({
      scopeRoot,
      casRoot: path.join(runtimeRoot, 'artifact-cas'),
      receiptLedger: artifactReceiptLedger,
      clock,
    })
  ));
  const operatorDatasetHarnessAuthorityVerifier = serviceOverrides.operatorDatasetHarnessAuthorityVerifier
    || createOperatorDatasetHarnessAuthorityReceiptVerifier({
      trustStoreProvider: () => loadOperatorDatasetAuthorityTrustStoreSync({ runtimeRoot }),
      clock,
    });
  const operatorDatasetAuthorityTrustStoreProvider = () =>
    loadOperatorDatasetAuthorityTrustStoreSync({ runtimeRoot });
  const gpuScientificPromotionAuthorityVerifier =
    serviceOverrides.gpuScientificPromotionAuthorityVerifier
    || createGpuScientificCampaignPromotionAuthorityVerifier({
      trustStoreProvider: operatorDatasetAuthorityTrustStoreProvider,
      clock,
      forbiddenIdentityProvider:
        createGpuScientificCampaignForbiddenIdentityProvider({
          environment: serviceOverrides.environment || process.env,
          clock,
        }),
    });
  const campaignReleaseAuthorityRepository = includeSubmissionPolicy
    ? (serviceOverrides.campaignReleaseAuthorityRepository
      || createSqliteCampaignReleaseAuthorityRepository({
        store,
        clock,
        operatorDatasetHarnessAuthorityVerifier,
        runtimeRoot,
        operatorDatasetAuthorityTrustStoreProvider,
        gpuScientificPromotionAuthorityVerifier,
      }))
    : null;
  const services = {
    ...exposeScopedFoundationServices(foundation, { schemaVersion }),
    ...(exposeRawStore ? { store } : {}),
    artifactRepositoryFactory,
    authorityVerifier: serviceOverrides.authorityVerifier || createAuthorityVerifier(),
    trustedResearchReceiptWriters: trustedLedgers.research,
    jobReceiptStore,
    nativeResearchWorkerJobReceiptStore,
    inventoryRepository: serviceOverrides.inventoryRepository || createInventoryRepository({ store }),
  };
  if (includeLegacyWorkflowProjection) {
    services.workflowStateStore = serviceOverrides.workflowStateStore || createSqliteWorkflowStateStore({ store, clock, receiptLedger: trustedLedgers.workflowState });
  }
  if (includeSubmissionPolicy) {
    services.campaignReleaseAuthorityRepository = campaignReleaseAuthorityRepository;
    services.submissionExecutorDescriptor = serviceOverrides.submissionExecutorDescriptor || null;
  }
  if (includeSubmissionDelivery) {
    services.executorResponseVerifier = serviceOverrides.executorResponseVerifier || null;
    services.submissionDeliveryStore = serviceOverrides.submissionDeliveryStore || createSqliteSubmissionDeliveryStore({
      store,
      receiptLedger,
      clock,
      executorResponseVerifier: services.executorResponseVerifier,
      providerCapabilityVerifier: serviceOverrides.providerCapabilityVerifier || null,
    });
  }
  return Object.freeze(services);
}

export function bootstrapBatchContext({
  root,
  runtimeRoot,
  mode,
  execute = false,
  writeReport = false,
  readOnly = false,
  allowMissingReadOnlyStore = false,
  options = {},
  serviceOverrides = {},
} = {}) {
  assertPaperMode(mode);
  const includeSubmissionPolicy = SUBMISSION_POLICY_MODES.has(mode);
  const includeSubmissionDelivery = Boolean(execute && SUBMISSION_DELIVERY_MODES.has(mode));
  const { foundation, schemaVersion } = composeScopedFoundationServices({
    root,
    runtimeRoot,
    readOnly,
    mutableOutputs: Boolean(execute || writeReport),
    allowMissingReadOnlyStore,
    serviceOverrides,
    writerId: 'hepta-paper-batch-bootstrap',
    rootKind: includeSubmissionDelivery ? 'submission' : 'batch',
  });
  const services = composeBatchServices({
    foundation,
    runtimeRoot,
    serviceOverrides,
    includeSubmissionPolicy,
    includeSubmissionDelivery,
    includeLegacyWorkflowProjection: Boolean(options.legacyWorkflowProjection),
    schemaVersion,
  });
  return buildExecutionContext({
    root,
    runtimeRoot,
    mode,
    execute,
    writeReport,
    options,
    serviceProfile: includeSubmissionDelivery ? 'submission' : 'batch',
    capabilities: [
      'artifact-repository',
      'batch-workflow',
      'receipt-ledger',
      'research-jobs',
      'typed-persistence',
      ...(includeSubmissionPolicy ? ['submission-policy'] : []),
      ...(includeSubmissionDelivery ? ['submission-delivery'] : []),
    ],
    services,
  });
}

export function bootstrapSubmissionContext({
  root,
  runtimeRoot,
  mode = PAPER_BATCH_MODES.REVIEWED_SUBMIT,
  execute = false,
  writeReport = false,
  readOnly = false,
  allowMissingReadOnlyStore = false,
  options = {},
  serviceOverrides = {},
} = {}) {
  const { foundation, schemaVersion } = composeScopedFoundationServices({
    root,
    runtimeRoot,
    readOnly,
    mutableOutputs: Boolean(execute || writeReport),
    allowMissingReadOnlyStore,
    serviceOverrides,
    writerId: 'hepta-paper-submission-bootstrap',
    rootKind: 'submission',
  });
  const services = composeBatchServices({
    foundation,
    runtimeRoot,
    serviceOverrides,
    includeSubmissionPolicy: true,
    includeSubmissionDelivery: true,
    includeLegacyWorkflowProjection: Boolean(options.legacyWorkflowProjection),
    schemaVersion,
  });
  return buildExecutionContext({
    root,
    runtimeRoot,
    mode,
    execute,
    writeReport,
    options,
    serviceProfile: 'submission',
    capabilities: ['artifact-repository', 'batch-workflow', 'receipt-ledger', 'research-jobs', 'submission-delivery', 'submission-policy', 'typed-persistence'],
    services,
  });
}
