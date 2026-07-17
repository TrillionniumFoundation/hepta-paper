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

export function composeAutomationResearchAuthority({
  runtimeRoot,
  receiptLedger,
  clock,
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
  return Object.freeze({
    experimentRegistryAuthorityVerifier,
    operatorDatasetHarnessAuthorityVerifier,
    operatorDatasetAuthorityTrustStoreProvider,
    rawEventRecomputationVerifier,
  });
}
