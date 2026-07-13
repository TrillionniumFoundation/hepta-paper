// Composition-only trust boundary. Capabilities never leave this module:
// callers receive concrete, least-privilege ledger instances.
import { createSqliteReceiptLedger } from '../../paper-adapters/persistence/sqlite-receipt-ledger.mjs';
import {
  issueArtifactRepositoryWriter,
  issueExperimentReproducibilityWriter,
  issueExperimentWorkerWriter,
  issueFormalAdapterWriter,
  issueFormalVerifierWriter,
  issueNativeResearchWorkerWriter,
} from '../../paper-adapters/persistence/receipt-writer-broker.mjs';

export function composeTrustedReceiptLedgers({ store, clock, overrides = {} } = {}) {
  if (!store || !clock) throw new Error('trusted receipt ledger composition requires store and clock');
  const ledger = (override, issue) => override || createSqliteReceiptLedger({
    store,
    clock,
    issuerCapability: issue(),
  });
  return Object.freeze({
    artifact: ledger(overrides.artifactReceiptLedger, issueArtifactRepositoryWriter),
    nativeResearchWorker: ledger(overrides.nativeResearchWorkerReceiptLedger, issueNativeResearchWorkerWriter),
    research: Object.freeze({
      experimentWorker: ledger(overrides.experimentWorkerReceiptLedger, issueExperimentWorkerWriter),
      experimentReproducibility: ledger(overrides.experimentReproducibilityReceiptLedger, issueExperimentReproducibilityWriter),
      formalAdapter: ledger(overrides.formalAdapterReceiptLedger, issueFormalAdapterWriter),
      formalExecution: ledger(overrides.formalExecutionReceiptLedger, issueFormalVerifierWriter),
    }),
  });
}
