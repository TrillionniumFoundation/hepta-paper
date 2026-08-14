import { createExperimentRegistryAuthorityVerifierCapability }
  from '../../paper-ports/experiment-registry-authority-verifier-port.mjs';
import { createTrustedExperimentRegistryAuthorityVerifier }
  from '../../paper-adapters/research-verify/experiment-registry-authority-verifier.mjs';
import { createIndependentRawEventArtifactRecomputationVerifier }
  from '../../paper-adapters/research-verify/raw-event-artifact-recomputation-verifier.mjs';
import { createOperatorDatasetHarnessAuthorityReceiptVerifier }
  from '../../paper-adapters/automation/operator-dataset-harness-authority-receipt-verifier.mjs';
import { loadOperatorDatasetAuthorityTrustStoreSync }
  from '../../paper-adapters/automation/operator-dataset-harness-reader.mjs';
import {
  createHttpExternalResearchReplayAdapter,
  readExternalResearchReplayServiceConfiguration,
} from '../../paper-adapters/automation/http-external-research-replay-adapter.mjs';
import { createLedgerBackedRuntimeRetentionReachabilityProvider }
  from '../../paper-adapters/automation/runtime-retention-reachability-provider-repository.mjs';
import { createSqliteCampaignReleaseQueryRepository }
  from '../../paper-adapters/persistence/sqlite-campaign-release-query-repository.mjs';
import { createPackageLifecycleAuthorityService }
  from '../../paper-application/automation/package-lifecycle-authority-service.mjs';
import { createPackageLifecycleMaterializationInspector }
  from '../../paper-adapters/automation/package-lifecycle-materialization-inspector.mjs';
import { receiptIssuerPolicies }
  from '../../paper-adapters/persistence/receipt-issuer-policy.mjs';

export function composePackageLifecycleAuthority({
  runtimeRoot,
  store,
  receiptLedger,
  clock,
  campaignStore,
  operatorDatasetHarnessAuthorityVerifier,
  rawEventRecomputationVerifier,
  operatorDatasetAuthorityTrustStoreProvider,
  gpuScientificPromotionAuthorityVerifier,
} = {}) {
  const campaignReleaseQuery = createSqliteCampaignReleaseQueryRepository({
    store,
    receiptLedger,
    operatorDatasetHarnessAuthorityVerifier,
    rawEventRecomputationVerifier,
    runtimeRoot,
    operatorDatasetAuthorityTrustStoreProvider,
    gpuScientificPromotionAuthorityVerifier,
    clock,
  });
  const policy = receiptIssuerPolicies()['package-lifecycle-authority'];
  return createPackageLifecycleAuthorityService({
    runtimeRoot,
    campaignStore,
    campaignReleaseQuery,
    materializationInspector:
      createPackageLifecycleMaterializationInspector({ runtimeRoot }),
    receiptLedger,
    receiptWriterAuthority: Object.freeze({
      ...policy,
      policyId: 'package-lifecycle-authority',
    }),
    clock,
  });
}

export function composeRuntimeRetentionReachabilityAuthority({
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
} = {}) {
  const campaignReleaseQuery = createSqliteCampaignReleaseQueryRepository({
    store,
    receiptLedger,
    operatorDatasetHarnessAuthorityVerifier,
    rawEventRecomputationVerifier,
    runtimeRoot,
    operatorDatasetAuthorityTrustStoreProvider,
    gpuScientificPromotionAuthorityVerifier,
    clock,
  });
  return createLedgerBackedRuntimeRetentionReachabilityProvider({
    runtimeRoot,
    campaignStore,
    campaignReleaseQuery,
    workspaceRegistry,
    receiptLedger,
    clock,
  });
}

export function composeAutomationResearchAuthority({
  runtimeRoot,
  receiptLedger,
  clock,
  environment = process.env,
} = {}) {
  const operatorDatasetAuthorityTrustStoreProvider = () =>
    loadOperatorDatasetAuthorityTrustStoreSync({ runtimeRoot });
  const operatorDatasetHarnessAuthorityVerifier =
    createOperatorDatasetHarnessAuthorityReceiptVerifier({
      trustStoreProvider: operatorDatasetAuthorityTrustStoreProvider,
      clock,
    });
  const rawEventRecomputationVerifier =
    createIndependentRawEventArtifactRecomputationVerifier({
      runtimeRoot,
      trustStoreProvider: operatorDatasetAuthorityTrustStoreProvider,
      clock,
    });
  const experimentRegistryAuthorityVerifier =
    createExperimentRegistryAuthorityVerifierCapability(
      createTrustedExperimentRegistryAuthorityVerifier({
        receiptLedger,
        operatorDatasetHarnessAuthorityVerifier,
        runtimeRoot,
        operatorDatasetAuthorityTrustStoreProvider,
        clock,
      }),
    );
  const externalReplayConfigPath = String(
    environment.HEPTA_EXTERNAL_REPLAY_CONFIG || '',
  ).trim();
  const externalReplayExpectedConfigurationHash = String(
    environment.HEPTA_EXTERNAL_REPLAY_CONFIG_HASH || '',
  ).trim().toLowerCase() || null;
  const externalResearchReplay = externalReplayConfigPath
    ? createHttpExternalResearchReplayAdapter({
      configuration: readExternalResearchReplayServiceConfiguration({
        configPath: externalReplayConfigPath,
        expectedConfigurationHash: externalReplayExpectedConfigurationHash,
      }),
      expectedConfigurationHash: externalReplayExpectedConfigurationHash,
      environment,
    })
    : null;
  return Object.freeze({
    experimentRegistryAuthorityVerifier,
    operatorDatasetHarnessAuthorityVerifier,
    operatorDatasetAuthorityTrustStoreProvider,
    rawEventRecomputationVerifier,
    externalResearchReplay,
  });
}
