// Composition-only trust boundary. Capabilities never leave this module:
// callers receive concrete, least-privilege ledger instances.
import { createSqliteReceiptLedger } from '../../paper-adapters/persistence/sqlite-receipt-ledger.mjs';
import { createSqliteReceiptLedgerQualificationStore } from '../../paper-adapters/persistence/sqlite-receipt-ledger-qualification.mjs';
import {
  issueAutomationReconcilerWriter,
  issueArtifactRepositoryWriter,
  issueExperimentReproducibilityWriter,
  issueExperimentWorkerWriter,
  issueFormalAdapterWriter,
  issueFormalVerifierWriter,
  issueNativeResearchWorkerWriter,
  issueRuntimeRetentionWriter,
  issuePackageLifecycleWriter,
  issueLedgerAdministratorWriter,
  issueStoreAdministratorWriter,
  issueWorkspaceSnapshotVerifierWriter,
  issueWorkflowStateProjectorWriter,
  issueAutonomousSubmissionHandoffWriter,
} from '../../paper-adapters/persistence/receipt-writer-broker.mjs';

function composeIssuerLedger({ store, clock, issuerCapability }) {
  if (!store || !clock) throw new Error('trusted receipt ledger composition requires store and clock');
  return createSqliteReceiptLedger({ store, clock, issuerCapability });
}

export function composeStoreAdministratorReceiptLedger({ store, clock } = {}) {
  return composeIssuerLedger({ store, clock, issuerCapability: issueStoreAdministratorWriter() });
}

export function composeRuntimeRetentionReceiptLedger({ store, clock } = {}) {
  return composeIssuerLedger({ store, clock, issuerCapability: issueRuntimeRetentionWriter() });
}

export function composePackageLifecycleReceiptLedger({ store, clock } = {}) {
  return composeIssuerLedger({ store, clock, issuerCapability: issuePackageLifecycleWriter() });
}

export function composeAutomationReconcilerReceiptLedger({ store, clock } = {}) {
  return composeIssuerLedger({ store, clock, issuerCapability: issueAutomationReconcilerWriter() });
}

export function composeLedgerAdministratorServices({ store, clock } = {}) {
  if (!store || !clock) throw new Error('ledger administrator composition requires store and clock');
  const issuerCapability = issueLedgerAdministratorWriter();
  return Object.freeze({
    ledger: createSqliteReceiptLedger({ store, clock, issuerCapability }),
    qualifications: createSqliteReceiptLedgerQualificationStore({ store, clock, issuerCapability }),
    replacementLedger: createSqliteReceiptLedger({ store, clock }),
  });
}

export function composeWorkspaceSnapshotVerifierReceiptLedger({ store, clock } = {}) {
  return composeIssuerLedger({ store, clock, issuerCapability: issueWorkspaceSnapshotVerifierWriter() });
}

export function composeArtifactReceiptLedger({ store, clock } = {}) {
  return composeIssuerLedger({ store, clock, issuerCapability: issueArtifactRepositoryWriter() });
}

export function composeAutonomousSubmissionHandoffReceiptLedger({ store, clock } = {}) {
  return composeIssuerLedger({
    store,
    clock,
    issuerCapability: issueAutonomousSubmissionHandoffWriter(),
  });
}

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
    workflowState: ledger(overrides.workflowStateReceiptLedger, issueWorkflowStateProjectorWriter),
    research: Object.freeze({
      experimentWorker: ledger(overrides.experimentWorkerReceiptLedger, issueExperimentWorkerWriter),
      experimentReproducibility: ledger(overrides.experimentReproducibilityReceiptLedger, issueExperimentReproducibilityWriter),
      formalAdapter: ledger(overrides.formalAdapterReceiptLedger, issueFormalAdapterWriter),
      formalExecution: ledger(overrides.formalExecutionReceiptLedger, issueFormalVerifierWriter),
    }),
  });
}
