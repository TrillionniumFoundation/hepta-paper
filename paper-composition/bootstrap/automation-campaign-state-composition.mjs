import { createWorkspaceRegistry }
  from '../../paper-adapters/automation/workspace-registry.mjs';
import { createSqliteCampaignStore }
  from '../../paper-adapters/persistence/sqlite-campaign-store.mjs';
import { assertCampaignStorePort }
  from '../../paper-ports/execution-service-ports.mjs';
import { composePackageLifecycleReceiptLedger }
  from './receipt-ledger-composition.mjs';
import {
  composePackageLifecycleAuthority,
  composeRuntimeRetentionReachabilityAuthority,
} from './automation-research-authority-composition.mjs';

export function composeAutomationCampaignState({
  runtimeRoot,
  store,
  clock,
  receiptLedger,
  campaignStoreOverride = null,
  workspaceRegistryOverride = null,
  experimentRegistryAuthorityVerifier,
  externalResearchReplay,
  operatorDatasetHarnessAuthorityVerifier,
  rawEventRecomputationVerifier,
  operatorDatasetAuthorityTrustStoreProvider,
  gpuScientificPromotionAuthorityVerifier,
  packageRecoveryAuthority = null,
  packageRecoveryAuthorityReadinessVerifier = null,
  packageRecoveryDeletionLeasePort = null,
} = {}) {
  const campaignStore = assertCampaignStorePort(campaignStoreOverride
    || createSqliteCampaignStore({
      store,
      clock,
      experimentRegistryAuthorityVerifier,
      gpuScientificPromotionAuthorityVerifier,
      externalResearchReplay,
    }));
  const workspaceRegistry = workspaceRegistryOverride
    || createWorkspaceRegistry({ store, clock, receiptLedger });
  const packageLifecycleAuthority = composePackageLifecycleAuthority({
    runtimeRoot,
    store,
    receiptLedger: composePackageLifecycleReceiptLedger({ store, clock }),
    clock,
    campaignStore,
    operatorDatasetHarnessAuthorityVerifier,
    rawEventRecomputationVerifier,
    operatorDatasetAuthorityTrustStoreProvider,
    gpuScientificPromotionAuthorityVerifier,
    packageRecoveryAuthority,
    packageRecoveryAuthorityReadinessVerifier,
    packageRecoveryDeletionLeasePort,
  });
  const runtimeRetentionReachabilityProvider =
    composeRuntimeRetentionReachabilityAuthority({
      runtimeRoot,
      store,
      receiptLedger,
      clock,
      campaignStore,
      workspaceRegistry,
      operatorDatasetHarnessAuthorityVerifier,
      rawEventRecomputationVerifier,
      operatorDatasetAuthorityTrustStoreProvider,
      gpuScientificPromotionAuthorityVerifier,
      packageRecoveryAuthority,
    });
  return Object.freeze({
    campaignStore,
    workspaceRegistry,
    packageLifecycleAuthority,
    runtimeRetentionReachabilityProvider,
  });
}
