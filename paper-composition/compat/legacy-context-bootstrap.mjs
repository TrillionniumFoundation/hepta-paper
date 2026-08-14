import { createLegacyPaperStageAdapterRegistry } from './legacy-stage-adapter-registry.mjs';
import { buildExecutionContext, composeFoundationServices } from '../bootstrap/context-foundation-composition.mjs';
import { composeBatchServices } from '../bootstrap/capability-scoped-bootstrap.mjs';
import { createSqliteCampaignReleaseAuthorityRepository } from '../../paper-adapters/persistence/sqlite-campaign-release-authority-repository.mjs';
import { composeLegacyStagePorts } from './legacy-stage-port-composition.mjs';
import { createOperatorDatasetHarnessAuthorityReceiptVerifier } from '../../paper-adapters/automation/operator-dataset-harness-authority-receipt-verifier.mjs';
import { loadOperatorDatasetAuthorityTrustStoreSync } from '../../paper-adapters/automation/operator-dataset-harness-reader.mjs';
import {
  createGpuScientificCampaignForbiddenIdentityProvider,
  createGpuScientificCampaignPromotionAuthorityVerifier,
} from '../../paper-adapters/automation/gpu-scientific-campaign-promotion-authority-verifier.mjs';

// Compatibility façade for callers that have not selected a capability scope.
// Production batch, automation and submission roots never import this module.
export function bootstrapLegacyPaperExecutionContext({
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
  const paperStageAdapters = serviceOverrides.paperStageAdapters || createLegacyPaperStageAdapterRegistry({ includeSubmission: true });
  const compatibilityOverrides = { ...serviceOverrides, paperStageAdapters };
  const foundation = composeFoundationServices({
    root,
    runtimeRoot,
    readOnly,
    mutableOutputs: Boolean(execute || writeReport),
    allowMissingReadOnlyStore,
    serviceOverrides: compatibilityOverrides,
    writerId: 'hepta-paper-legacy-bootstrap',
  });
  const operatorDatasetHarnessAuthorityVerifier = serviceOverrides.operatorDatasetHarnessAuthorityVerifier
    || createOperatorDatasetHarnessAuthorityReceiptVerifier({
      trustStoreProvider: () => loadOperatorDatasetAuthorityTrustStoreSync({ runtimeRoot }),
      clock: foundation.clock,
    });
  const operatorDatasetAuthorityTrustStoreProvider = () =>
    loadOperatorDatasetAuthorityTrustStoreSync({ runtimeRoot });
  const gpuScientificPromotionAuthorityVerifier =
    serviceOverrides.gpuScientificPromotionAuthorityVerifier
    || createGpuScientificCampaignPromotionAuthorityVerifier({
      trustStoreProvider: operatorDatasetAuthorityTrustStoreProvider,
      clock: foundation.clock,
      forbiddenIdentityProvider:
        createGpuScientificCampaignForbiddenIdentityProvider({
          environment: serviceOverrides.environment || process.env,
          clock: foundation.clock,
        }),
    });
  const campaignReleaseAuthorityRepository = serviceOverrides.campaignReleaseAuthorityRepository
    || createSqliteCampaignReleaseAuthorityRepository({
      store: foundation.store,
      clock: foundation.clock,
      operatorDatasetHarnessAuthorityVerifier,
      gpuScientificPromotionAuthorityVerifier,
      runtimeRoot,
      operatorDatasetAuthorityTrustStoreProvider,
    });
  const legacyStagePorts = composeLegacyStagePorts({
    registry: paperStageAdapters,
    store: foundation.store,
    campaignReleaseAuthorityRepository,
  });
  const typedCompatibilityOverrides = {
    ...compatibilityOverrides,
    operatorDatasetHarnessAuthorityVerifier,
    gpuScientificPromotionAuthorityVerifier,
    campaignReleaseAuthorityRepository,
    stageExecution: serviceOverrides.stageExecution || legacyStagePorts.stageExecution,
    journalPolicy: serviceOverrides.journalPolicy || legacyStagePorts.journalPolicy,
  };
  const scopedServices = composeBatchServices({
    foundation,
    runtimeRoot,
    serviceOverrides: typedCompatibilityOverrides,
    includeSubmissionPolicy: true,
    includeSubmissionDelivery: true,
    includeLegacyWorkflowProjection: true,
    exposeRawStore: true,
  });
  return buildExecutionContext({
    root,
    runtimeRoot,
    mode,
    execute,
    writeReport,
    options,
    serviceProfile: 'legacy',
    capabilities: ['legacy-full-service-facade'],
    services: Object.freeze({
      ...scopedServices,
      stageExecution: typedCompatibilityOverrides.stageExecution,
      journalPolicy: typedCompatibilityOverrides.journalPolicy,
      paperStageAdapters,
    }),
  });
}
