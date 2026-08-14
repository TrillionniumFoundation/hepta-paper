import { createSqliteCampaignReleaseQueryRepository } from '../../paper-adapters/persistence/sqlite-campaign-release-query-repository.mjs';
import { assertCampaignReleaseQueryPort, createCampaignReleaseQueryCapability } from '../../paper-ports/campaign-release-query-port.mjs';
import { buildExecutionContext, exposeScopedFoundationServices, openScopedPaperStore } from './context-foundation-composition.mjs';
import { createOperatorDatasetHarnessAuthorityReceiptVerifier } from '../../paper-adapters/automation/operator-dataset-harness-authority-receipt-verifier.mjs';
import { loadOperatorDatasetAuthorityTrustStoreSync } from '../../paper-adapters/automation/operator-dataset-harness-reader.mjs';
import {
  createGpuScientificCampaignForbiddenIdentityProvider,
  createGpuScientificCampaignPromotionAuthorityVerifier,
} from '../../paper-adapters/automation/gpu-scientific-campaign-promotion-authority-verifier.mjs';

export function bootstrapSubmissionHandoffContext({
  root,
  runtimeRoot,
  mode = 'campaign-release-submission-handoff',
  serviceOverrides = {},
  environment = process.env,
} = {}) {
  if (serviceOverrides.campaignReleaseAuthorityRepository) {
    throw new Error('submission_handoff_authority_repository_override_forbidden_use_campaign_release_query');
  }
  if (serviceOverrides.store && serviceOverrides.store.readOnly !== true) {
    throw new Error('submission_handoff_read_only_store_required');
  }
  const scopedStore = openScopedPaperStore({
    root,
    runtimeRoot,
    readOnly: true,
    allowMissingReadOnlyStore: false,
    serviceOverrides: serviceOverrides.store ? { store: serviceOverrides.store } : {},
    rootKind: 'submission',
  });
  const { store, schemaVersion } = scopedStore;
  try {
    const clock = serviceOverrides.clock?.now
      ? serviceOverrides.clock
      : Object.freeze({ now: () => new Date() });
    const operatorDatasetAuthorityTrustStoreProvider = () =>
      loadOperatorDatasetAuthorityTrustStoreSync({ runtimeRoot });
    const operatorDatasetHarnessAuthorityVerifier = serviceOverrides.operatorDatasetHarnessAuthorityVerifier
      || createOperatorDatasetHarnessAuthorityReceiptVerifier({
        trustStoreProvider: operatorDatasetAuthorityTrustStoreProvider,
        clock,
      });
    const gpuScientificPromotionAuthorityVerifier =
      serviceOverrides.gpuScientificPromotionAuthorityVerifier
      || createGpuScientificCampaignPromotionAuthorityVerifier({
        trustStoreProvider: operatorDatasetAuthorityTrustStoreProvider,
        clock,
        forbiddenIdentityProvider:
          createGpuScientificCampaignForbiddenIdentityProvider({
            environment,
            clock,
          }),
      });
    const campaignReleaseQuery = createCampaignReleaseQueryCapability(
      serviceOverrides.campaignReleaseQuery
        ? assertCampaignReleaseQueryPort(serviceOverrides.campaignReleaseQuery)
        : createSqliteCampaignReleaseQueryRepository({
          store,
          operatorDatasetHarnessAuthorityVerifier,
          runtimeRoot,
          operatorDatasetAuthorityTrustStoreProvider,
          gpuScientificPromotionAuthorityVerifier,
          clock,
        }),
    );
    const { persistenceSession } = exposeScopedFoundationServices({ store }, { schemaVersion });
    return buildExecutionContext({
      root,
      runtimeRoot,
      mode,
      execute: false,
      writeReport: false,
      options: {},
      serviceProfile: 'handoff',
      capabilities: ['submission-release-read'],
      services: Object.freeze({
        campaignReleaseQuery,
        persistenceSession,
        schemaVersion,
      }),
    });
  } catch (error) {
    if (scopedStore.owned) store.close?.();
    throw error;
  }
}
