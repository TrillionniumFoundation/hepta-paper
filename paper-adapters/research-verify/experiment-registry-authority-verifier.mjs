import { createExperimentRegistryAuthorityVerifier } from '../../paper-domain/research/experiment-registry-authority.mjs';
import { verifyArtifactWriteReceiptSource } from '../artifacts/artifact-write-receipt-verifier.mjs';
import {
  createIndependentRawEventArtifactRecomputationVerifier,
  verifyIndependentRawEventArtifactRecomputation,
} from './raw-event-artifact-recomputation-verifier.mjs';

export { verifyArtifactWriteReceiptSource, verifyIndependentRawEventArtifactRecomputation };

export function createTrustedExperimentRegistryAuthorityVerifier({
  receiptLedger = null,
  operatorDatasetHarnessAuthorityVerifier = null,
  runtimeRoot = null,
  operatorDatasetAuthorityTrustStoreProvider = null,
  clock = null,
} = {}) {
  const rawEventRecomputationVerifier = createIndependentRawEventArtifactRecomputationVerifier({
    runtimeRoot,
    trustStoreProvider: operatorDatasetAuthorityTrustStoreProvider,
    clock,
  });
  return createExperimentRegistryAuthorityVerifier({
    receiptLedger,
    artifactVerifier: verifyArtifactWriteReceiptSource,
    rawEventRecomputationVerifier,
    operatorDatasetHarnessAuthorityVerifier,
  });
}
