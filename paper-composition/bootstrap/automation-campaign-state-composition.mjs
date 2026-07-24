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
} = {}) {
  const campaignStore = assertCampaignStorePort(campaignStoreOverride
    || createSqliteCampaignStore({
      store,
      clock,
      experimentRegistryAuthorityVerifier,
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
    });
  return Object.freeze({
    campaignStore,
    workspaceRegistry,
    packageLifecycleAuthority,
    runtimeRetentionReachabilityProvider,
  });
}
